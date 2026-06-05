import { create } from "zustand";
import { api, clearToken, loadToken, saveToken } from "@/api/client";

type AuthState = {
  ready: boolean;
  username: string | null;
  signedIn: boolean;
  hydrate: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, inviteCode?: string) => Promise<void>;
  logout: () => Promise<void>;
};

export const useAuth = create<AuthState>((set) => ({
  ready: false,
  username: null,
  signedIn: false,

  hydrate: async () => {
    const token = await loadToken();
    if (!token) { set({ ready: true, signedIn: false }); return; }
    try {
      const me = await api<{ username: string }>("GET", "/auth/me");
      set({ ready: true, signedIn: true, username: me.username });
    } catch {
      await clearToken();
      set({ ready: true, signedIn: false });
    }
  },

  login: async (username, password) => {
    const r = await api<{ ok: boolean; username: string; token: string }>(
      "POST", "/auth/login", { username, password }
    );
    await saveToken(r.token);
    set({ signedIn: true, username: r.username });
  },

  register: async (username, password, inviteCode) => {
    const r = await api<{ ok: boolean; username: string; token: string }>(
      "POST", "/auth/register", { username, password, invite_code: inviteCode }
    );
    await saveToken(r.token);
    set({ signedIn: true, username: r.username });
  },

  logout: async () => {
    try { await api("POST", "/auth/logout"); } catch {}
    await clearToken();
    set({ signedIn: false, username: null });
  },
}));
