import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View,
} from "react-native";
import { api, baseUrl } from "@/api/client";
import PageHeader from "@/components/PageHeader";
import { confirm, toast, hapticLight } from "@/components/Ui";
import { playTts, stopTts, TtsPlayerHost, useTtsPlayingId } from "@/audio/tts";
import { moodInfo } from "@/constants/mood";
import { IconPlay, IconStop } from "@/components/Icons";

type FavItem = {
  id: number;
  session_id: number;
  content: string;
  image_url: string | null;
  character_name: string | null;
  created_at: string;
  favorited_at: string | null;
  tts_audio_url: string | null;
  mood: string | null;
  title: string;
};

export default function Favorites() {
  const router = useRouter();
  const [items, setItems] = useState<FavItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [character, setCharacter] = useState<{ name: string } | null>(null);
  const playingId = useTtsPlayingId();

  const load = useCallback(async () => {
    try {
      const char = character ?? await api<{ name: string }>("GET", "/character").catch(() => null);
      if (char && !character) setCharacter(char);
      const q = char?.name ? `?character=${encodeURIComponent(char.name)}` : "";
      const rows = await api<FavItem[]>("GET", `/favorites${q}`);
      setItems((rows || []).map((r) => {
        if (r.image_url && !r.image_url.startsWith("http")) r.image_url = `${baseUrl}${r.image_url}`;
        return r;
      }));
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [character]);

  useFocusEffect(useCallback(() => { load(); return () => { stopTts(); }; }, [load]));

  const unfav = async (item: FavItem) => {
    const ok = await confirm({ title: "取消收藏", message: "从收藏中移除这条？", confirmText: "移除", destructive: true });
    if (!ok) return;
    try {
      await api("DELETE", `/messages/${item.id}/favorite`);
      hapticLight();
      setItems((cur) => cur.filter((x) => x.id !== item.id));
      toast("已移除");
    } catch (e: any) { toast(e.message || "操作失败", "err"); }
  };

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <View style={s.container}>
      <TtsPlayerHost />
      <PageHeader title="收藏" />
      <FlatList
        data={items}
        keyExtractor={(it) => String(it.id)}
        contentContainerStyle={{ padding: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#7e6fd0" />}
        ListEmptyComponent={<Text style={s.empty}>还没有收藏，长按聊天气泡可收藏</Text>}
        renderItem={({ item }) => {
          const m = item.mood ? moodInfo(item.mood) : null;
          const playing = playingId === item.id;
          return (
            <Pressable
              style={s.card}
              onPress={() => router.push(`/chat/${item.session_id}`)}
              onLongPress={() => unfav(item)}
              delayLongPress={300}
            >
              <View style={s.topRow}>
                {m ? (
                  <View style={[s.moodChip, { borderColor: m.color }]}>
                    <Text style={[s.moodText, { color: m.color }]}>{m.emoji} {m.label}</Text>
                  </View>
                ) : <View />}
                {item.tts_audio_url ? (
                  <Pressable
                    style={[s.playBtn, playing && s.playBtnOn]}
                    onPress={() => playing ? stopTts() : playTts(item.tts_audio_url!, item.id)}
                    hitSlop={8}
                  >
                    {playing
                      ? <IconStop size={16} color="#7e6fd0" />
                      : <IconPlay size={16} color="#7e6fd0" />}
                  </Pressable>
                ) : null}
              </View>
              {item.image_url ? <Image source={{ uri: item.image_url }} style={s.thumb} /> : null}
              {item.content ? <Text style={s.text}>{item.content}</Text> : null}
              <View style={s.metaRow}>
                <Text style={s.meta}>{item.title}</Text>
                <Text style={s.meta}>{new Date(item.favorited_at || item.created_at).toLocaleDateString("zh-CN")}</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" },
  empty: { color: "#666", textAlign: "center", marginTop: 60 },
  card: { backgroundColor: "#1c1c2a", borderRadius: 10, padding: 14, marginBottom: 10 },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  moodChip: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2 },
  moodText: { fontSize: 12, fontWeight: "600" },
  playBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(126,111,208,0.15)" },
  playBtnOn: { backgroundColor: "rgba(126,111,208,0.3)" },
  thumb: { width: "100%", aspectRatio: 1, borderRadius: 8, marginBottom: 10, backgroundColor: "#000" },
  text: { color: "#e8e8f0", fontSize: 15, lineHeight: 22 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  meta: { color: "#666", fontSize: 12 },
});
