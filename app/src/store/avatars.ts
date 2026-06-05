import { create } from "zustand";
import { api } from "@/api/client";

type Avatars = Record<string, string>; // mood -> url

type State = {
  byChar: Record<string, Avatars>; // characterName -> Avatars
  loadingChar: string | null;
  load: (charName: string) => Promise<Avatars | null>;
  setOne: (charName: string, mood: string, url: string) => void;
  pick: (charName: string, mood: string) => string | null;
};

export const useAvatars = create<State>((set, get) => ({
  byChar: {},
  loadingChar: null,

  load: async (charName) => {
    if (!charName) return null;
    if (get().loadingChar === charName) return get().byChar[charName] || null;
    set({ loadingChar: charName });
    try {
      const r = await api<{ character: string; avatars: Avatars; stale: boolean }>("GET", "/avatars");
      if (r.character !== charName) {
        set({ loadingChar: null });
        return null;
      }
      set((cur) => ({ byChar: { ...cur.byChar, [charName]: r.avatars }, loadingChar: null }));
      return r.avatars;
    } catch {
      set({ loadingChar: null });
      return null;
    }
  },

  setOne: (charName, mood, url) => set((cur) => {
    const next = { ...(cur.byChar[charName] || {}) };
    next[mood] = url;
    return { byChar: { ...cur.byChar, [charName]: next } };
  }),

  pick: (charName, mood) => {
    const m = get().byChar[charName] || {};
    if (mood && mood !== "neutral" && m[mood]) return m[mood];
    return m["neutral"] || m[mood] || Object.values(m)[0] || null;
  },
}));
