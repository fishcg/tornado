import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View,
} from "react-native";
import { api } from "@/api/client";
import PageHeader from "@/components/PageHeader";

type Milestone = {
  id: number;
  stage: number;
  stage_name: string;
  affection: number;
  comic_url_1: string | null;
  comic_url_2: string | null;
  video_url: string | null;
  created_at: string;
};

export default function CharacterMilestones() {
  const router = useRouter();
  const [items, setItems] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api<Milestone[]>("GET", "/relationship/milestones");
      setItems(list);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <View style={s.container}>
      <PageHeader title="关系里程碑" />
      <FlatList
        data={items}
        keyExtractor={(it) => String(it.id)}
        contentContainerStyle={{ padding: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#7e6fd0" />}
        ListEmptyComponent={<Text style={s.empty}>还没有关系里程碑，多聊聊会触发</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.row} onPress={() => router.push(`/character/milestones/${item.id}`)}>
            {item.comic_url_1 ? (
              <Image source={{ uri: item.comic_url_1 }} style={s.thumb} />
            ) : (
              <View style={[s.thumb, s.thumbStub]}><Text style={{ fontSize: 22 }}>💫</Text></View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={s.stageName}>{item.stage_name}</Text>
              <Text style={s.meta}>心动值 {item.affection} · 第 {item.stage} 阶</Text>
              {item.video_url ? <Text style={s.tag}>📹 视频</Text> : null}
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
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12 },
  back: { color: "#7e6fd0", fontSize: 15 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  empty: { color: "#666", textAlign: "center", marginTop: 60 },
  row: { flexDirection: "row", gap: 12, padding: 12, backgroundColor: "#1c1c2a", borderRadius: 10, marginBottom: 8 },
  thumb: { width: 80, height: 80, borderRadius: 8, backgroundColor: "#0f0f17" },
  thumbStub: { alignItems: "center", justifyContent: "center" },
  stageName: { color: "#fff", fontSize: 16, fontWeight: "600" },
  meta: { color: "#888", fontSize: 12, marginTop: 4 },
  tag: { color: "#7e6fd0", fontSize: 11, marginTop: 6 },
});
