import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
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

export default function MilestoneDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<Milestone | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Milestone[]>("GET", "/relationship/milestones")
      .then((all) => setItem(all.find((m) => m.id === Number(id)) || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  // 视频沉浸式自动循环播放（参考网页：autoplay + loop + muted + 无控件）
  const player = useVideoPlayer(item?.video_url || null, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;
  if (!item) return (
    <View style={s.center}>
      <Text style={{ color: "#888" }}>未找到</Text>
      <Pressable onPress={() => router.back()}><Text style={s.back}>返回</Text></Pressable>
    </View>
  );

  return (
    <View style={s.container}>
      <PageHeader title={item.stage_name} />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={s.stage}>第 {item.stage} 阶</Text>
        <Text style={s.meta}>心动值 {item.affection} · {new Date(item.created_at).toLocaleString("zh-CN")}</Text>

      {item.video_url ? (
        <VideoView
          style={s.video}
          player={player}
          contentFit="contain"
          nativeControls={false}
          pointerEvents="none"
        />
      ) : (
        <View style={s.comicWrap}>
          <View style={s.comicCol}>
            <Text style={s.chapter}>第一章</Text>
            {item.comic_url_1 ? (
              <Image source={{ uri: item.comic_url_1 }} style={s.comic} resizeMode="cover" />
            ) : (
              <View style={[s.comic, s.comicStub]}><Text style={{ fontSize: 28 }}>💫</Text></View>
            )}
          </View>
          <View style={s.comicCol}>
            <Text style={s.chapter}>第二章</Text>
            {item.comic_url_2 ? (
              <Image source={{ uri: item.comic_url_2 }} style={s.comic} resizeMode="cover" />
            ) : (
              <View style={[s.comic, s.comicStub]}><Text style={{ fontSize: 28 }}>💫</Text></View>
            )}
          </View>
        </View>
      )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17", gap: 12 },
  back: { color: "#7e6fd0", fontSize: 15, marginBottom: 12 },
  stage: { color: "#7e6fd0", fontSize: 12, fontWeight: "700" },
  title: { color: "#fff", fontSize: 24, fontWeight: "700", marginTop: 4 },
  meta: { color: "#888", fontSize: 13, marginTop: 6, marginBottom: 18 },
  video: { width: "100%", aspectRatio: 9/16, borderRadius: 12, backgroundColor: "#1c1c2a" },
  comicWrap: { gap: 12 },
  comicCol: {},
  chapter: { color: "#888", fontSize: 12, marginBottom: 6 },
  comic: { width: "100%", aspectRatio: 1, borderRadius: 12, backgroundColor: "#1c1c2a" },
  comicStub: { alignItems: "center", justifyContent: "center" },
});
