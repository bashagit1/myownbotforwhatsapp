import { createClient } from '@supabase/supabase-js';
import { Resident, ActivityLog, WhatsAppGroup } from '../types';
import { BotStatusResponse } from './database';

// CONFIGURATION FROM ENV VARIABLES
const env = (import.meta as any).env;
const SUPABASE_URL = env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || '';
const BOT_SERVER_URL = env.VITE_BOT_SERVER_URL || 'http://localhost:3001';

// Initialize Client
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const LiveDB = {
  
  // --- RESIDENTS ---
  
  getResidents: async (): Promise<Resident[]> => {
    const { data, error } = await supabase
      .from('residents')
      .select('*')
      .order('name');
    
    if (error) {
      console.error('Supabase Error fetching residents:', JSON.stringify(error, null, 2));
      throw new Error(error.message || "Failed to fetch residents. Check database connection.");
    }
    
    // Map DB fields to frontend types
    return data.map((r: any) => ({
      id: r.id,
      name: r.name,
      roomNumber: r.room_number,
      whatsappGroupId: r.whatsapp_group_id,
      photoUrl: r.photo_url,
      notes: r.notes
    }));
  },

  addResident: async (resident: Omit<Resident, 'id'>): Promise<Resident> => {
    const { data, error } = await supabase
      .from('residents')
      .insert([{
        name: resident.name,
        room_number: resident.roomNumber,
        whatsapp_group_id: resident.whatsappGroupId,
        photo_url: resident.photoUrl,
        notes: resident.notes
      }])
      .select()
      .single();

    if (error) {
      console.error('Supabase Error adding resident:', error);
      throw new Error(error.message);
    }
    
    return {
      id: data.id,
      name: data.name,
      roomNumber: data.room_number,
      whatsappGroupId: data.whatsapp_group_id,
      photoUrl: data.photo_url
    };
  },

  deleteResident: async (id: string): Promise<void> => {
    // 1. Delete logs first to handle foreign key constraints manually
    const { error: logsError } = await supabase
        .from('activity_logs')
        .delete()
        .eq('resident_id', id);

    if (logsError) {
        console.error('Error deleting resident logs:', logsError);
        throw new Error("Failed to clean up resident logs.");
    }

    // 2. Delete the resident
    const { error } = await supabase
      .from('residents')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Supabase Error deleting resident:', error);
      throw new Error(error.message);
    }
  },

  // --- LOGS & WHATSAPP ---

  createLog: async (logData: Omit<ActivityLog, 'id' | 'timestamp' | 'status'>): Promise<ActivityLog> => {
    // 1. Save to Database
    const { data, error } = await supabase
      .from('activity_logs')
      .insert([{
        resident_id: logData.residentId,
        resident_name: logData.residentName,
        staff_name: logData.staffName,
        category: logData.category,
        notes: logData.notes,
        image_urls: logData.imageUrls,
        status: 'PENDING', // Initially pending
        ai_generated_message: logData.aiGeneratedMessage
      }])
      .select()
      .single();

    if (error) {
      console.error('Supabase Error creating log:', error);
      throw new Error(error.message);
    }

    const newLog = data;
    
    // Fetch resident group ID
    const { data: residentData } = await supabase
        .from('residents')
        .select('whatsapp_group_id')
        .eq('id', logData.residentId)
        .single();
        
    const residentGroupId = residentData?.whatsapp_group_id;

    // 2. Trigger WhatsApp Bot
    let finalStatus = 'PENDING';
    
    if (residentGroupId && logData.aiGeneratedMessage) {
      try {
        const response = await fetch(`${BOT_SERVER_URL}/send-update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            groupId: residentGroupId,
            message: logData.aiGeneratedMessage,
            imageUrls: logData.imageUrls
          })
        });

        if (response.ok) {
            finalStatus = 'SENT';
        } else {
            finalStatus = 'FAILED';
        }
      } catch (err) {
        console.warn("Bot server unreachable.", err);
        finalStatus = 'FAILED';
      }
    }

    // Update status in DB
    if (finalStatus !== 'PENDING') {
        await supabase
            .from('activity_logs')
            .update({ status: finalStatus })
            .eq('id', newLog.id);
    }

    return {
        ...logData,
        id: newLog.id,
        timestamp: newLog.created_at,
        status: finalStatus as any
    };
  },

  getLogs: async (): Promise<ActivityLog[]> => {
    const { data, error } = await supabase
      .from('activity_logs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase Error fetching logs:', error);
      throw new Error(error.message);
    }

    return data.map((l: any) => ({
        id: l.id,
        residentId: l.resident_id,
        residentName: l.resident_name,
        staffName: l.staff_name,
        category: l.category,
        timestamp: l.created_at,
        notes: l.notes,
        imageUrls: l.image_urls || [],
        status: l.status,
        aiGeneratedMessage: l.ai_generated_message
    }));
  },

  // --- GROUP DISCOVERY & BOT STATUS ---

  getWhatsAppGroups: async (): Promise<WhatsAppGroup[]> => {
    try {
        const response = await fetch(`${BOT_SERVER_URL}/groups`);
        if (!response.ok) throw new Error("Bot server error");
        return await response.json();
    } catch (e) {
        console.warn("Bot server offline or unreachable");
        throw new Error("Bot server is offline. Please run 'node server/bot.js'");
    }
  },

  checkBotStatus: async (): Promise<BotStatusResponse> => {
    try {
        const response = await fetch(`${BOT_SERVER_URL}/status`);
        if (!response.ok) throw new Error("Status check failed");
        return await response.json();
    } catch (e) {
        return { status: 'offline' };
    }
  },

  getBotQR: async (): Promise<string | null> => {
    try {
        const response = await fetch(`${BOT_SERVER_URL}/qr`);
        if (!response.ok) return null;
        const data = await response.json();
        return data.qr;
    } catch (e) {
        return null;
    }
  }
};