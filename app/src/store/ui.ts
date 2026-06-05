import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY_BG = "ui.chatBgOpacity";
const KEY_BUBBLE = "ui.bubbleOpacity";

type UiState = {
  ready: boolean;
  chatBgOpacity: number;     // 0~1，背景图保留多少强度（数值越大越显眼）
  bubbleOpacity: number;     // 0~1，气泡的不透明度
  hydrate: () => Promise<void>;
  setChatBgOpacity: (v: number) => Promise<void>;
  setBubbleOpacity: (v: number) => Promise<void>;
};

export const useUi = create<UiState>((set) => ({
  ready: false,
  chatBgOpacity: 0.35,
  bubbleOpacity: 0.92,

  hydrate: async () => {
    try {
      const [bg, bubble] = await Promise.all([
        AsyncStorage.getItem(KEY_BG),
        AsyncStorage.getItem(KEY_BUBBLE),
      ]);
      set({
        ready: true,
        chatBgOpacity: bg !== null ? parseFloat(bg) : 0.35,
        bubbleOpacity: bubble !== null ? parseFloat(bubble) : 0.92,
      });
    } catch {
      set({ ready: true });
    }
  },

  setChatBgOpacity: async (v) => {
    set({ chatBgOpacity: v });
    await AsyncStorage.setItem(KEY_BG, String(v));
  },

  setBubbleOpacity: async (v) => {
    set({ bubbleOpacity: v });
    await AsyncStorage.setItem(KEY_BUBBLE, String(v));
  },
}));
