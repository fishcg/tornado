import { create } from "zustand";
import { api } from "@/api/client";

export type PointTransaction = {
  delta: number;
  balance_after: number;
  reason: string;
  ref: string | null;
  created_at: string;
};

export type CheckinRecord = {
  checkin_date: string;
  points: number;
  streak: number;
  created_at: string;
};

type CheckinStatus = {
  checked_today: boolean;
  streak: number;
  today_reward_preview: number;
  balance: number;
  history: CheckinRecord[];
};

type State = {
  balance: number;
  enabled: boolean;
  checkedToday: boolean;
  streak: number;
  todayReward: number;
  history: CheckinRecord[];
  loadBalance: () => Promise<void>;
  loadCheckinStatus: () => Promise<void>;
  checkin: () => Promise<{ ok: boolean; points?: number; streak?: number; error?: string }>;
};

export const usePoints = create<State>((set) => ({
  balance: 0,
  enabled: true,
  checkedToday: false,
  streak: 0,
  todayReward: 0,
  history: [],

  loadBalance: async () => {
    try {
      const r = await api<{ balance: number; enabled: boolean }>("GET", "/points");
      set({ balance: r.balance ?? 0, enabled: r.enabled !== false });
    } catch {}
  },

  loadCheckinStatus: async () => {
    try {
      const r = await api<CheckinStatus>("GET", "/checkin/status");
      set({
        checkedToday: r.checked_today,
        streak: r.streak ?? 0,
        todayReward: r.today_reward_preview ?? 0,
        balance: r.balance ?? 0,
        history: r.history ?? [],
      });
    } catch {}
  },

  checkin: async () => {
    try {
      const r = await api<{ ok: boolean; points: number; streak: number; balance: number }>("POST", "/checkin");
      set({ checkedToday: true, streak: r.streak, balance: r.balance });
      // 刷新记录列表
      try {
        const st = await api<CheckinStatus>("GET", "/checkin/status");
        set({ history: st.history ?? [], todayReward: st.today_reward_preview ?? 0 });
      } catch {}
      return { ok: true, points: r.points, streak: r.streak };
    } catch (e: any) {
      return { ok: false, error: e?.data?.error || e?.message || "签到失败" };
    }
  },
}));
