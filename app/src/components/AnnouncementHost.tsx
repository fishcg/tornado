import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "@/api/client";
import { useAuth } from "@/store/auth";
import { useAnnouncements, type Announcement } from "@/store/announcements";

// 启动时拉取「需弹窗且未读」的公告，逐条弹出；关闭即标记已读
export function AnnouncementHost() {
  const signedIn = useAuth((s) => s.signedIn);
  const ready = useAuth((s) => s.ready);
  const loadUnreadCount = useAnnouncements((s) => s.loadUnreadCount);
  const [queue, setQueue] = useState<Announcement[]>([]);
  const [current, setCurrent] = useState<Announcement | null>(null);

  useEffect(() => {
    if (!ready || !signedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await api<Announcement[]>("GET", "/announcements/unread");
        if (!cancelled && rows?.length) setQueue(rows);
      } catch {}
      loadUnreadCount();
    })();
    return () => { cancelled = true; };
  }, [ready, signedIn, loadUnreadCount]);

  useEffect(() => {
    if (!current && queue.length > 0) {
      setCurrent(queue[0]);
      setQueue((q) => q.slice(1));
    }
  }, [queue, current]);

  const close = () => {
    if (current) {
      api("POST", `/announcements/${current.id}/read`).catch(() => {});
      loadUnreadCount();
    }
    setCurrent(null);
  };

  if (!current) return null;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={close}>
      <View style={s.bg}>
        <View style={s.card}>
          <Text style={s.tag}>系统公告</Text>
          <Text style={s.title}>{current.title}</Text>
          <ScrollView style={s.bodyWrap} contentContainerStyle={{ paddingVertical: 4 }}>
            <Text style={s.body}>{current.content}</Text>
          </ScrollView>
          <Pressable style={s.btn} onPress={close}>
            <Text style={s.btnText}>我知道了</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 32 },
  card: { width: "100%", maxWidth: 360, backgroundColor: "#1c1c2a", borderRadius: 16, padding: 22, borderWidth: 1, borderColor: "#2a2a3a" },
  tag: { color: "#7e6fd0", fontSize: 12, fontWeight: "700", marginBottom: 8 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 10 },
  bodyWrap: { maxHeight: 280, marginBottom: 16 },
  body: { color: "#cfcfe0", fontSize: 14, lineHeight: 22 },
  btn: { backgroundColor: "#7e6fd0", paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
