import { create } from "zustand";
import { api, clearToken, loadToken, saveToken } from "@/api/client";

type AuthState = {
  ready: boolean;
  username: string | null;
  avatarUrl: string | null;
  signedIn: boolean;
  hydrate: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, inviteCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  setAvatarUrl: (url: string | null) => void;
};

export const useAuth = create<AuthState>((set) => ({
  ready: false,
  username: null,
  avatarUrl: null,
  signedIn: false,

  hydrate: async () => {
    const token = await loadToken();
    if (!token) { set({ ready: true, signedIn: false }); return; }
    try {
      const me = await api<{ username: string; avatar_url?: string | null }>("GET", "/auth/me");
      set({ ready: true, signedIn: true, username: me.username, avatarUrl: me.avatar_url || null });
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
    // 登录后补拉头像
    try {
      const me = await api<{ avatar_url?: string | null }>("GET", "/auth/me");
      set({ avatarUrl: me.avatar_url || null });
    } catch {}
  },

  register: async (username, password, inviteCode) => {
    const r = await api<{ ok: boolean; username: string; token: string }>(
      "POST", "/auth/register", { username, password, invite_code: inviteCode }
    );
    await saveToken(r.token);
    set({ signedIn: true, username: r.username, avatarUrl: null });
  },

  logout: async () => {
    try { await api("POST", "/auth/logout"); } catch {}
    await clearToken();
    set({ signedIn: false, username: null, avatarUrl: null });
  },

  setAvatarUrl: (url) => set({ avatarUrl: url }),
}));
