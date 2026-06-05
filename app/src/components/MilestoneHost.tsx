import { useEffect, useRef, useState } from "react";
import {
  Animated, Dimensions, Easing, Image, Modal, Pressable, StyleSheet, Text, View,
} from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { api } from "@/api/client";

type MilestoneData = {
  milestone_id?: number;
  stage?: number;
  stage_name?: string;
  affection?: number;
  comic_url_1?: string | null;
  comic_url_2?: string | null;
  video_url?: string | null;
};

let pushQueue: ((d: MilestoneData) => void) | null = null;
const _shownIds = new Set<number>();

export function showMilestone(d: MilestoneData) {
  if (d.milestone_id && _shownIds.has(d.milestone_id)) return;
  if (d.milestone_id) _shownIds.add(d.milestone_id);
  pushQueue?.(d);
}

const W = Dimensions.get("window").width;

export function MilestoneHost() {
  const [queue, setQueue] = useState<MilestoneData[]>([]);
  const [current, setCurrent] = useState<MilestoneData | null>(null);

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
    <MilestoneModal data={current} onClose={() => setCurrent(null)} />
  );
}

function MilestoneModal({ data, onClose }: { data: MilestoneData; onClose: () => void }) {
  const overlay = useRef(new Animated.Value(0)).current;
  const stagePop = useRef(new Animated.Value(0)).current;
  const bookFlip = useRef(new Animated.Value(0)).current;
  const [page, setPage] = useState(1); // 1 or 2

  const player = useVideoPlayer(data.video_url || null, (p) => {
    p.loop = true;
    p.muted = false;
    p.play();
  });

  useEffect(() => {
    Animated.timing(overlay, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    Animated.timing(stagePop, {
      toValue: 1, duration: 600, easing: Easing.bezier(0.34, 1.56, 0.64, 1), useNativeDriver: true,
    }).start();
    Animated.timing(bookFlip, {
      toValue: 1, duration: 700, delay: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, []);

  const close = () => {
    if (data.milestone_id) {
      api("POST", `/relationship/milestones/${data.milestone_id}/notify`).catch(() => {});
    }
    Animated.timing(overlay, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => onClose());
  };

  const turnPage = () => setPage((p) => (p === 1 ? 2 : 1));

  const isVideo = !!data.video_url;
  const stageScale = stagePop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  const bookScale = bookFlip.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] });
  const bookOpacity = bookFlip;

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={close}>
      <Animated.View style={[s.overlay, { opacity: overlay }]}>
        {/* 顶部 badge + 阶段名 */}
        <Animated.View style={[s.header, { opacity: stagePop, transform: [{ scale: stageScale }] }]}>
          <View style={s.badge}>
            <Text style={s.badgeText}>关系升级</Text>
          </View>
          <Text style={s.stageName}>{data.stage_name || ""}</Text>
          {data.affection != null ? (
            <Text style={s.affText}>♥ {data.affection}</Text>
          ) : null}
        </Animated.View>

        {/* 中间漫画 / 视频 */}
        <Animated.View style={[
          s.bookWrap,
          { opacity: bookOpacity, transform: [{ scale: bookScale }] },
        ]}>
          {isVideo ? (
            <View style={s.videoWrap}>
              <VideoView
                style={s.video}
                player={player}
                contentFit="cover"
                nativeControls={false}
              />
              <Pressable style={StyleSheet.absoluteFill} onPress={close} />
            </View>
          ) : (
            <View style={s.book}>
              {page === 1 ? (
                data.comic_url_1
                  ? <Image source={{ uri: data.comic_url_1 }} style={s.page} resizeMode="cover" />
                  : <View style={[s.page, s.placeholder]}><Text style={{ fontSize: 48 }}>💫</Text></View>
              ) : (
                data.comic_url_2
                  ? <Image source={{ uri: data.comic_url_2 }} style={s.page} resizeMode="cover" />
                  : <View style={[s.page, s.placeholder]}><Text style={{ fontSize: 48 }}>✨</Text></View>
              )}
              <View style={s.pageLabelBox}>
                <Text style={s.pageLabel}>{page === 1 ? "第一章" : "第二章"}</Text>
              </View>

              {/* 翻页 */}
              <Pressable style={[s.navBtn, s.navLeft]} onPress={turnPage}>
                <Text style={s.navText}>‹</Text>
              </Pressable>
              <Pressable style={[s.navBtn, s.navRight]} onPress={turnPage}>
                <Text style={s.navText}>›</Text>
              </Pressable>
            </View>
          )}
        </Animated.View>

        {/* 底部按钮 */}
        <View style={s.footer}>
          {!isVideo ? (
            <View style={s.dots}>
              <View style={[s.dot, page === 1 && s.dotActive]} />
              <View style={[s.dot, page === 2 && s.dotActive]} />
            </View>
          ) : null}
          <Pressable style={s.closeBtn} onPress={close}>
            <Text style={s.closeText}>收下了</Text>
          </Pressable>
        </View>

        {/* 顶部 / 底部光晕装饰 */}
        <View style={s.glowTop} pointerEvents="none" />
        <View style={s.glowBottom} pointerEvents="none" />
      </Animated.View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.85)",
    alignItems: "center", justifyContent: "center",
    paddingVertical: 50,
  },
  glowTop: {
    position: "absolute", top: -100, left: -50, right: -50, height: 250,
    backgroundColor: "rgba(126,111,208,0.18)",
    borderRadius: 200,
  },
  glowBottom: {
    position: "absolute", bottom: -100, left: -50, right: -50, height: 250,
    backgroundColor: "rgba(244,114,182,0.18)",
    borderRadius: 200,
  },

  header: { alignItems: "center", gap: 8, marginBottom: 18 },
  badge: {
    paddingHorizontal: 12, paddingVertical: 4,
    backgroundColor: "rgba(126,111,208,0.18)",
    borderRadius: 12,
    borderWidth: 1, borderColor: "#7e6fd0",
  },
  badgeText: { color: "#a78bfa", fontSize: 11, fontWeight: "700", letterSpacing: 3 },
  stageName: { color: "#fff", fontSize: 26, fontWeight: "800", letterSpacing: 2 },
  affText: { color: "#f472b6", fontSize: 13 },

  bookWrap: {
    width: W - 48,
    aspectRatio: 9 / 16,
    maxHeight: "65%",
    borderRadius: 16,
    overflow: "hidden",
    shadowColor: "#7e6fd0",
    shadowOpacity: 0.5,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  videoWrap: { flex: 1, backgroundColor: "#000" },
  video: { width: "100%", height: "100%" },
  book: { flex: 1, backgroundColor: "#1c1c2a" },
  page: { width: "100%", height: "100%" },
  placeholder: { alignItems: "center", justifyContent: "center" },
  pageLabelBox: {
    position: "absolute", bottom: 12, alignSelf: "center",
    paddingHorizontal: 12, paddingVertical: 4,
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 10,
  },
  pageLabel: { color: "#fff", fontSize: 12 },

  navBtn: {
    position: "absolute", top: "45%",
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center", justifyContent: "center",
  },
  navLeft: { left: 10 },
  navRight: { right: 10 },
  navText: { color: "#fff", fontSize: 22, fontWeight: "700" },

  footer: { alignItems: "center", marginTop: 20, gap: 12 },
  dots: { flexDirection: "row", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.25)" },
  dotActive: { backgroundColor: "#7e6fd0", width: 18 },

  closeBtn: {
    paddingHorizontal: 32, paddingVertical: 10,
    backgroundColor: "#7e6fd0", borderRadius: 22,
  },
  closeText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
