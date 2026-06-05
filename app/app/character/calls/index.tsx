import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View,
} from "react-native";
import { api } from "@/api/client";
import { stopTts, TtsPlayerHost } from "@/audio/tts";
import IncomingCall, { type IncomingCallData } from "@/components/IncomingCall";
import PageHeader from "@/components/PageHeader";
import { useAvatars } from "@/store/avatars";

type CallLog = {
  id: number;
  session_id: number;
  char_name: string;
  script: string;
  audio_url: string | null;
  answered: number;
  created_at: string;
};

function fmt(iso: string) {
  const d = new Date(iso);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  return `${m}-${day} ${hh}:${mm}`;
}

export default function CallsList() {
  const router = useRouter();
  const [items, setItems] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [replay, setReplay] = useState<IncomingCallData | null>(null);
  const loadAvatars = useAvatars((s) => s.load);
  const pickAvatar = useAvatars((s) => s.pick);

  const load = useCallback(async () => {
    try {
      const list = await api<CallLog[]>("GET", "/call-logs");
      setItems(list);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => () => { stopTts(); }, []);

  // 进页面拉一次当前角色头像
  useEffect(() => {
    if (items.length > 0 && items[0].char_name) loadAvatars(items[0].char_name);
  }, [items, loadAvatars]);

  const openReplay = (item: CallLog) => {
    if (!item.audio_url) return;
    setReplay({
      msg_id: item.id,
      session_id: item.session_id,
      char_name: item.char_name,
      char_avatar: pickAvatar(item.char_name, "neutral"),
      script: item.script,
      audio_url: item.audio_url,
      show_subtitle: true,
    });
  };

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <View style={s.container}>
      <TtsPlayerHost />
      <IncomingCall
        visible={!!replay}
        data={replay}
        onClose={() => setReplay(null)}
      />
      <PageHeader title="来电记录" />
      <FlatList
        data={items}
        keyExtractor={(it) => String(it.id)}
        contentContainerStyle={{ padding: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#7e6fd0" />}
        ListEmptyComponent={<Text style={s.empty}>还没有来电记录</Text>}
        renderItem={({ item }) => {
          const av = pickAvatar(item.char_name, "neutral");
          return (
            <View style={s.row}>
              <View style={s.icon}>
                {av
                  ? <Image source={{ uri: av }} style={s.iconImg} />
                  : <Text style={{ fontSize: 22 }}>📞</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <View style={s.topRow}>
                  <Text style={s.name}>{item.char_name}</Text>
                  {item.answered ? null : <Text style={s.unread}>未接</Text>}
                </View>
                <Text style={s.script} numberOfLines={2}>{item.script || "—"}</Text>
                <Text style={s.meta}>{fmt(item.created_at)}</Text>
                <View style={s.btnRow}>
                  {item.audio_url && (
                    <Pressable style={s.btn} onPress={() => openReplay(item)}>
                      <Text style={s.btnText}>▶ 重播来电</Text>
                    </Pressable>
                  )}
                  <Pressable style={s.btnOutline} onPress={() => router.push(`/chat/${item.session_id}`)}>
                    <Text style={s.btnOutlineText}>去对话</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  back: { color: "#7e6fd0", fontSize: 15 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  empty: { color: "#666", textAlign: "center", marginTop: 60 },
  row: { flexDirection: "row", gap: 12, padding: 12, backgroundColor: "#1c1c2a", borderRadius: 10, marginBottom: 8 },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#0f0f17", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  iconImg: { width: "100%", height: "100%" },
  topRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: "#fff", fontSize: 15, fontWeight: "600" },
  unread: { color: "#ef4444", fontSize: 11, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: "rgba(239,68,68,0.15)" },
  script: { color: "#ddd", fontSize: 13, marginTop: 4 },
  meta: { color: "#777", fontSize: 11, marginTop: 4 },
  btnRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  btn: { backgroundColor: "rgba(126,111,208,0.2)", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  btnText: { color: "#7e6fd0", fontSize: 12, fontWeight: "600" },
  btnOutline: { borderWidth: 1, borderColor: "#333", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  btnOutlineText: { color: "#aaa", fontSize: 12 },
});
