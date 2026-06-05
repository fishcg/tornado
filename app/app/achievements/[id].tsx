import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Animated, Dimensions, Easing, Image, Pressable, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { api } from "@/api/client";
import PageHeader from "@/components/PageHeader";

type Achievement = {
  id: number;
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

const TYPE_THEME: Record<string, { color: string; glow: string }> = {
  message_count: { color: "#60a5fa", glow: "rgba(96,165,250,0.55)" },
  affection:     { color: "#f472b6", glow: "rgba(244,114,182,0.55)" },
  streak_days:   { color: "#34d399", glow: "rgba(52,211,153,0.55)" },
};
const DEFAULT_THEME = { color: "#a78bfa", glow: "rgba(167,139,250,0.55)" };

const W = Dimensions.get("window").width - 32; // 减去 ScrollView padding 16*2

export default function AchievementDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<Achievement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Achievement[]>("GET", "/achievements")
      .then((all) => setItem(all.find((a) => a.id === Number(id)) || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;
  if (!item) return (
    <View style={s.center}>
      <Text style={{ color: "#888" }}>未找到</Text>
      <Pressable onPress={() => router.back()}><Text style={s.back}>返回</Text></Pressable>
    </View>
  );

  const theme = TYPE_THEME[item.type] || DEFAULT_THEME;

  return (
    <View style={s.container}>
      <PageHeader title={item.name} />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={s.meta}>
          <Text style={{ color: theme.color }}>{TYPE_LABEL[item.type] || item.type}</Text>
          {"  ·  阈值 "}{item.threshold}{"  ·  "}{new Date(item.unlocked_at).toLocaleString("zh-CN")}
        </Text>
        {item.selfie_url ? (
          <FramedImage url={item.selfie_url} themeColor={theme.color} themeGlow={theme.glow} />
        ) : null}
        {item.inner_voice ? (
          <View style={[s.voiceBox, { borderLeftColor: theme.color }]}>
            <Text style={s.voiceLabel}>内心独白</Text>
            <Text style={s.voiceText}>{item.inner_voice}</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function FramedImage({ url, themeColor, themeGlow }: { url: string; themeColor: string; themeGlow: string }) {
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1500,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.delay(2200), // 扫完歇一会儿再扫
    ]));
    loop.start();
    return () => loop.stop();
  }, [sweep]);

  const translate = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-W * 0.6, W * 1.0],
  });

  return (
    <View style={[s.frame, {
      borderColor: themeColor,
      shadowColor: themeColor,
      shadowOpacity: 0.45,
      shadowOffset: { width: 0, height: 0 },
      shadowRadius: 18,
      elevation: 10,
    }]}>
      <Image source={{ uri: url }} style={s.image} resizeMode="cover" />
      <Animated.View
        pointerEvents="none"
        style={[s.sweepWrap, { transform: [{ translateX: translate }, { skewX: "-20deg" }] }]}
      >
        <LinearGradient
          colors={["transparent", "rgba(255,255,255,0.0)", "rgba(255,255,255,0.55)", "rgba(255,255,255,0.0)", "transparent"]}
          locations={[0, 0.4, 0.5, 0.6, 1]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={s.sweep}
        />
      </Animated.View>
      {/* 顶部一行小光带，强化金属边框感 */}
      <View style={[s.frameInner, { borderColor: themeGlow }]} pointerEvents="none" />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17", gap: 12 },
  back: { color: "#7e6fd0", fontSize: 15, marginBottom: 12 },
  meta: { color: "#888", fontSize: 13, marginBottom: 18 },

  frame: {
    width: "100%", aspectRatio: 1,
    borderRadius: 16, borderWidth: 2,
    overflow: "hidden",
    backgroundColor: "#1c1c2a",
    marginBottom: 18,
  },
  image: { width: "100%", height: "100%" },
  sweepWrap: {
    position: "absolute", top: -10, bottom: -10,
    width: W * 0.55,
  },
  sweep: { width: "100%", height: "100%" },
  frameInner: {
    position: "absolute", top: 4, left: 4, right: 4, bottom: 4,
    borderRadius: 12, borderWidth: 1,
  },

  voiceBox: { backgroundColor: "#1c1c2a", padding: 14, borderRadius: 10, borderLeftWidth: 3 },
  voiceLabel: { color: "#888", fontSize: 11, marginBottom: 6 },
  voiceText: { color: "#eee", fontSize: 15, lineHeight: 22, fontStyle: "italic" },
});
