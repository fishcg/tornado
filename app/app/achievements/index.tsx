import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View,
} from "react-native";
import { api } from "@/api/client";
import PageHeader from "@/components/PageHeader";

type Achievement = {
  id: number;
  achievement_id: number;
  selfie_url: string | null;
  inner_voice: string | null;
  unlocked_at: string;
  name: string;
  type: string;
  threshold: number;
};

const TYPE_LABEL: Record<string, string> = {
  message_count: "消息数",
  affection: "心动值",
  streak_days: "连续天数",
};

export default function Achievements() {
  const router = useRouter();
  const [items, setItems] = useState<Achievement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api<Achievement[]>("GET", "/achievements");
      setItems(list);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <View style={s.container}>
      <PageHeader title="我的成就" />
      <FlatList
        data={items}
        keyExtractor={(it) => String(it.id)}
        contentContainerStyle={{ padding: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#7e6fd0" />}
        ListEmptyComponent={<Text style={s.empty}>还没有解锁成就</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.row} onPress={() => router.push(`/achievements/${item.id}`)}>
            {item.selfie_url
              ? <Image source={{ uri: item.selfie_url }} style={s.thumb} />
              : <View style={[s.thumb, s.thumbStub]}><Text style={{ color: "#666", fontSize: 18 }}>🏅</Text></View>}
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{item.name}</Text>
              <Text style={s.meta}>{TYPE_LABEL[item.type] || item.type} · {item.threshold}</Text>
              {item.inner_voice ? <Text numberOfLines={2} style={s.voice}>{item.inner_voice}</Text> : null}
            </View>
          </Pressable>
        )}
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
  thumb: { width: 64, height: 64, borderRadius: 8, backgroundColor: "#0f0f17" },
  thumbStub: { alignItems: "center", justifyContent: "center" },
  name: { color: "#fff", fontSize: 15, fontWeight: "600" },
  meta: { color: "#888", fontSize: 12, marginTop: 3 },
  voice: { color: "#bbb", fontSize: 12, marginTop: 6, fontStyle: "italic" },
});
