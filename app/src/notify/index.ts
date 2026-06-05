import { Platform } from "react-native";
import Constants from "expo-constants";

// Expo Go (SDK 53+) 不再支持 expo-notifications，要走 dev client / 真机 build。
// 这里做成 lazy load + 静默降级：如果不可用，所有 API 都变 no-op。
const isExpoGo = Constants.executionEnvironment === "storeClient";
const notificationsSupported = !isExpoGo;

let Notifications: any = null;
let configured = false;
let permissionRequested = false;

async function lazyLoad() {
  if (!notificationsSupported) return null;
  if (Notifications) return Notifications;
  try {
    Notifications = await import("expo-notifications");
    return Notifications;
  } catch {
    return null;
  }
}

export async function setupNotifications() {
  if (configured) return;
  configured = true;
  const N = await lazyLoad();
  if (!N) return;

  N.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowAlert: false,
    }),
  });

  if (Platform.OS === "android") {
    try {
      await N.setNotificationChannelAsync("incoming-call", {
        name: "来电",
        importance: N.AndroidImportance.MAX,
        sound: "default",
        vibrationPattern: [0, 500, 200, 500],
        lightColor: "#7e6fd0",
      });
      await N.setNotificationChannelAsync("chat", {
        name: "聊天消息",
        importance: N.AndroidImportance.HIGH,
        sound: "default",
      });
    } catch {}
  }
}

export async function ensureNotificationPermission() {
  if (permissionRequested) return;
  permissionRequested = true;
  const N = await lazyLoad();
  if (!N) return;
  try {
    const cur = await N.getPermissionsAsync();
    if (cur.status !== "granted") {
      await N.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
    }
  } catch {}
}

export async function addNotificationResponseListener(
  cb: (sessionId: number | null) => void
): Promise<{ remove: () => void } | null> {
  const N = await lazyLoad();
  if (!N) return null;
  try {
    return N.addNotificationResponseReceivedListener((resp: any) => {
      const data = resp.notification.request.content.data || {};
      cb(data.session_id ?? null);
    });
  } catch {
    return null;
  }
}

type CallNotifData = {
  charName?: string;
  script?: string;
  sessionId?: number | null;
};

export async function showIncomingCallNotification(d: CallNotifData) {
  const N = await lazyLoad();
  if (!N) return;
  try {
    await N.scheduleNotificationAsync({
      content: {
        title: `${d.charName || "对方"} 来电`,
        body: d.script ? d.script.slice(0, 80) : "点开接听",
        sound: "default",
        priority: N.AndroidNotificationPriority?.MAX,
        data: { type: "incoming_call", session_id: d.sessionId ?? null },
      },
      trigger: Platform.OS === "android" ? { channelId: "incoming-call" } : null,
    });
  } catch {}
}

type ChatNotifData = {
  charName?: string;
  text?: string;
  sessionId?: number | null;
};

export async function showChatNotification(d: ChatNotifData) {
  const N = await lazyLoad();
  if (!N) return;
  try {
    await N.scheduleNotificationAsync({
      content: {
        title: d.charName || "新消息",
        body: d.text ? d.text.slice(0, 100) : "",
        sound: "default",
        data: { type: "chat", session_id: d.sessionId ?? null },
      },
      trigger: Platform.OS === "android" ? { channelId: "chat" } : null,
    });
  } catch {}
}
