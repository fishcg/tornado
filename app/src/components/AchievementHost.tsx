import { useEffect, useRef, useState } from "react";
import {
  Animated, Easing, Image, Modal, Pressable, StyleSheet, Text, View,
} from "react-native";
import { api } from "@/api/client";

type AchievementData = {
  achievement?: { id: number; name: string; type: string; threshold: number };
  selfie_url?: string | null;
  inner_voice?: string | null;
  ua_id?: number;
};

const TYPE_THEME: Record<string, { color: string; glow: string; icon: string; label: string }> = {
  message_count: { color: "#60a5fa", glow: "rgba(96,165,250,0.55)", icon: "💬", label: "对话里程碑" },
  affection:     { color: "#f472b6", glow: "rgba(244,114,182,0.55)", icon: "💖", label: "心动时刻" },
  streak_days:   { color: "#34d399", glow: "rgba(52,211,153,0.55)", icon: "🔥", label: "连续相伴" },
};
const DEFAULT_THEME = { color: "#a78bfa", glow: "rgba(167,139,250,0.55)", icon: "✨", label: "成就" };

// ────────────────────────────────────────────────────────────
// 全局触发：在任何地方调 showAchievement(data)
// ────────────────────────────────────────────────────────────

let pushQueue: ((d: AchievementData) => void) | null = null;
const _shownIds = new Set<number>();

export function showAchievement(d: AchievementData) {
  const id = d.achievement?.id;
  if (id && _shownIds.has(id)) return;
  if (id) _shownIds.add(id);
  pushQueue?.(d);
}

// ────────────────────────────────────────────────────────────
// 挂在 _layout 下的 host
// ────────────────────────────────────────────────────────────

export function AchievementHost() {
  const [queue, setQueue] = useState<AchievementData[]>([]);
  const [current, setCurrent] = useState<AchievementData | null>(null);

  useEffect(() => {
    pushQueue = (d) => setQueue((q) => [...q, d]);
    return () => { pushQueue = null; };
  }, []);

  useEffect(() => {
    if (!current && queue.length > 0) {
      setCurrent(queue[0]);
      setQueue((q) => q.slice(1));
    }
  }, [queue, current]);

  if (!current) return null;
  return (
    <AchievementModal
      data={current}
      onClose={() => setCurrent(null)}
    />
  );
}

function AchievementModal({ data, onClose }: { data: AchievementData; onClose: () => void }) {
  const theme = TYPE_THEME[data.achievement?.type || ""] || DEFAULT_THEME;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const popAnim = useRef(new Animated.Value(0)).current;
  const selfieAnim = useRef(new Animated.Value(0)).current;
  const fadeHeader = useRef(new Animated.Value(0)).current;
  const fadeName = useRef(new Animated.Value(0)).current;
  const fadeVoice = useRef(new Animated.Value(0)).current;
  const fadeBtn = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(overlayAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    Animated.timing(popAnim, {
      toValue: 1, duration: 350, easing: Easing.bezier(0.34, 1.56, 0.64, 1), useNativeDriver: true,
    }).start();
    Animated.timing(selfieAnim, {
      toValue: 1, duration: 500, delay: 200, easing: Easing.bezier(0.34, 1.56, 0.64, 1), useNativeDriver: false,
    }).start();
    Animated.timing(fadeHeader, { toValue: 1, duration: 400, delay: 150, useNativeDriver: true }).start();
    Animated.timing(fadeName, { toValue: 1, duration: 400, delay: 350, useNativeDriver: true }).start();
    Animated.timing(fadeVoice, { toValue: 1, duration: 400, delay: 500, useNativeDriver: true }).start();
    Animated.timing(fadeBtn, { toValue: 1, duration: 400, delay: 650, useNativeDriver: true }).start();

    // 自拍框光晕脉冲
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(glowAnim, { toValue: 1, duration: 1250, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      Animated.timing(glowAnim, { toValue: 0, duration: 1250, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  const close = () => {
    if (data.ua_id) api("POST", "/achievements/notify", { ids: [data.ua_id] }).catch(() => {});
    Animated.timing(overlayAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => onClose());
  };

  const popScale = popAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] });
  const selfieScale = selfieAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const selfieRotate = selfieAnim.interpolate({ inputRange: [0, 1], outputRange: ["-8deg", "0deg"] });
  const glowRadius = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [18, 32] });
  const glowOpacity = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0.95] });
  const fadeTransform = (a: Animated.Value) => ({
    opacity: a,
    transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
  });

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={close}>
      <Animated.View style={[s.overlay, { opacity: overlayAnim }]}>
        <Animated.View style={[
          s.box,
          {
            opacity: popAnim,
            transform: [{ scale: popScale }],
            borderColor: theme.color + "55",
          },
        ]}>
          <Animated.Text style={[s.header, fadeTransform(fadeHeader)]}>
            {theme.icon}  {theme.label}
          </Animated.Text>

          <Animated.View
            style={[
              s.selfieWrap,
              {
                borderColor: theme.color,
                opacity: selfieAnim,
                transform: [{ scale: selfieScale }, { rotate: selfieRotate }],
                shadowColor: theme.color,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: glowOpacity,
                shadowRadius: glowRadius,
                elevation: 12,
              },
            ]}
          >
            {data.selfie_url ? (
              <Image source={{ uri: data.selfie_url }} style={s.selfie} resizeMode="cover" />
            ) : (
              <View style={[s.selfiePlaceholder, { backgroundColor: theme.color + "22" }]}>
                <Text style={{ fontSize: 48 }}>{theme.icon}</Text>
              </View>
            )}
          </Animated.View>

          <Animated.Text style={[s.name, { color: theme.color }, fadeTransform(fadeName)]}>
            「{data.achievement?.name || ""}」
          </Animated.Text>

          {data.inner_voice ? (
            <Animated.Text style={[s.voice, fadeTransform(fadeVoice)]}>
              {data.inner_voice}
            </Animated.Text>
          ) : null}

          <Animated.View style={fadeTransform(fadeBtn)}>
            <Pressable
              style={[s.btn, { backgroundColor: theme.color }]}
              onPress={close}
            >
              <Text style={s.btnText}>好耶！</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  box: {
    width: 300, maxWidth: "100%",
    backgroundColor: "#1e1a2e",
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 24, paddingTop: 28, paddingBottom: 22,
    alignItems: "center", gap: 14,
  },
  header: {
    fontSize: 12, color: "#888", letterSpacing: 3, fontWeight: "600",
  },
  selfieWrap: {
    width: 200, height: 200, borderRadius: 16, overflow: "hidden",
    borderWidth: 3,
  },
  selfie: { width: "100%", height: "100%" },
  selfiePlaceholder: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  name: {
    fontSize: 20, fontWeight: "700", textAlign: "center",
  },
  voice: {
    fontSize: 13, fontStyle: "italic", color: "#aaa",
    textAlign: "center", lineHeight: 22, paddingHorizontal: 8, maxWidth: 240,
  },
  btn: {
    marginTop: 6,
    paddingHorizontal: 32, paddingVertical: 10, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
  },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
