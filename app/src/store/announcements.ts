import { create } from "zustand";
import { api } from "@/api/client";

export type Announcement = {
  id: number;
  title: string;
  content: string;
  created_at: string;
  popup?: number;
  is_read?: boolean;
};

type State = {
  list: Announcement[];
  unreadCount: number;
  loadList: () => Promise<void>;
  loadUnreadCount: () => Promise<void>;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
};

export const useAnnouncements = create<State>((set, get) => ({
  list: [],
  unreadCount: 0,

  loadList: async () => {
    try {
      const rows = await api<Announcement[]>("GET", "/announcements");
      set({ list: rows, unreadCount: rows.filter((r) => !r.is_read).length });
    } catch {}
  },

  loadUnreadCount: async () => {
    try {
      const r = await api<{ count: number }>("GET", "/announcements/unread-count");
      set({ unreadCount: r.count || 0 });
    } catch {}
  },

  markRead: async (id) => {
    try { await api("POST", `/announcements/${id}/read`); } catch {}
    set((cur) => {
      const list = cur.list.map((a) => a.id === id ? { ...a, is_read: true } : a);
      return { list, unreadCount: list.filter((a) => !a.is_read).length };
    });
  },

  markAllRead: async () => {
    try { await api("POST", "/announcements/read-all"); } catch {}
    set((cur) => ({ list: cur.list.map((a) => ({ ...a, is_read: true })), unreadCount: 0 }));
  },
}));
