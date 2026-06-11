import { useEffect, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, Modal, Pressable, StyleSheet, Text, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/api/client";
import { IconBack } from "@/components/Icons";
import { moodInfo } from "@/constants/mood";
import { confirm, toast } from "@/components/Ui";

type AvatarMap = Record<string, string>;
type Quota = { dailyLimit: number; usedToday: number; remaining: number };
type PointsInfo = { enabled: boolean; balance: number; cost_avatar: number };

type AvatarsResp = {
  character: string;
  avatars: AvatarMap;
  moods: string[];
  stale: boolean;
  quota: Quota;
  points?: PointsInfo;
};

export default function AvatarsModal({
  visible, onClose, onUpdated, currentMood,
}: {
  visible: boolean;
  onClose: () => void;
  onUpdated?: (mood: string, url: string) => void;
  currentMood?: string;
}) {
  const [data, setData] = useState<AvatarsResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyMood, setBusyMood] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setData(await api<AvatarsResp>("GET", "/avatars")); }
    catch {} finally { setLoading(false); }
  };

  useEffect(() => { if (visible) load(); }, [visible]);

  const regenOne = async (mood: string) => {
    if (busyMood || !data) return;
    const pts = data.points;
    const ok = await confirm({
      title: "重生成头像",
      message: pts?.enabled
        ? `将消耗 ${pts.cost_avatar} 小鱼干（当前余额 ${pts.balance}）。`
        : `将消耗 1 次配额（今日剩 ${data.quota.remaining}）。`,
    });
    if (!ok) return;
    setBusyMood(mood);
    try {
      await api("POST", `/avatars/${mood}/regenerate`);
      const oldUrl = data.avatars[mood];
      const start = Date.now();
      const tick = setInterval(async () => {
        try {
          const r = await api<AvatarsResp>("GET", "/avatars");
          if (r.avatars[mood] && r.avatars[mood] !== oldUrl) {
            setData(r);
            onUpdated?.(mood, r.avatars[mood]);
            clearInterval(tick);
            setBusyMood(null);
          } else if (Date.now() - start > 30000) {
            clearInterval(tick);
            setBusyMood(null);
          }
        } catch {}
      }, 2500);
    } catch (e: any) {
      setBusyMood(null);
      if (e?.status === 402) toast("小鱼干不足，去【我的】签到获取", "err");
      else toast(e.message || "重生成失败", "err");
    }
  };

  const resetAll = async () => {
    if (!data) return;
    const cost = data.moods.length;
    const pts = data.points;
    if (!pts?.enabled && data.quota.remaining < cost) {
      toast(`配额不足，今日剩 ${data.quota.remaining}`, "err");
      return;
    }
    const ok = await confirm({
      title: "一键重置",
      message: pts?.enabled
        ? `将删除全部 ${cost} 张并重新生成（消耗 ${cost * pts.cost_avatar} 小鱼干，当前余额 ${pts.balance}）。`
        : `将删除全部 ${cost} 张并重新生成（消耗 ${cost} 次配额）。`,
      confirmText: "重置",
      destructive: true,
    });
    if (!ok) return;
    setResetting(true);
    try {
      await api("POST", "/avatars/regenerate");
      await load();
      toast("已开始重新生成");
    } catch (e: any) {
      if (e?.status === 402) toast("小鱼干不足，去【我的】签到获取", "err");
      else toast(e.message || "失败", "err");
    } finally { setResetting(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView edges={["top", "bottom"]} style={s.container}>
        <View style={s.header}>
          <Pressable onPress={onClose} style={s.iconBtn} hitSlop={8}>
            <IconBack size={24} color="#fff" />
          </Pressable>
          <Text style={s.title}>情绪头像</Text>
          <View style={{ width: 40 }} />
        </View>

        {loading || !data ? (
          <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>
        ) : (
          <>
            <View style={s.quotaBar}>
              <Text style={s.quotaText}>
                {data.points?.enabled
                  ? `${data.character} · 🐟 ${data.points.balance}（每张 ${data.points.cost_avatar}）`
                  : `${data.character} · 今日剩 ${data.quota.remaining}/${data.quota.dailyLimit}`}
              </Text>
              <Pressable
                onPress={resetAll}
                disabled={resetting}
                style={[s.resetBtn, resetting && { opacity: 0.4 }]}
                hitSlop={8}
              >
                {resetting ? <ActivityIndicator color="#7e6fd0" /> : <Text style={s.resetText}>一键重置</Text>}
              </Pressable>
            </View>

            <FlatList
              data={data.moods}
              keyExtractor={(m) => m}
              numColumns={3}
              contentContainerStyle={{ padding: 8 }}
              columnWrapperStyle={{ gap: 8 }}
              renderItem={({ item: mood }) => {
                const info = moodInfo(mood);
                const url = data.avatars[mood];
                const busy = busyMood === mood;
                const isCurrent = mood === currentMood;
                return (
                  <Pressable
                    style={[
                      s.cell,
                      { borderColor: isCurrent ? info.color : "transparent" },
                      isCurrent && {
                        borderWidth: 2.5,
                        shadowColor: info.color,
                        shadowOpacity: 0.45,
                        shadowOffset: { width: 0, height: 0 },
                        shadowRadius: 8,
                        elevation: 6,
                      },
                    ]}
                    onPress={() => regenOne(mood)}
                    disabled={busy}
                  >
                    <View style={s.cellImgWrap}>
                      {url
                        ? <Image source={{ uri: url }} style={s.cellImg} />
                        : <Text style={s.cellEmpty}>未生成</Text>}
                      {busy ? (
                        <View style={s.cellMask}><ActivityIndicator color="#fff" /></View>
                      ) : null}
                      {isCurrent ? (
                        <View style={[s.currentBadge, { backgroundColor: info.color }]}>
                          <Text style={s.currentBadgeText}>当前</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={[s.cellLabel, { color: info.color }]}>{info.emoji} {info.label}</Text>
                  </Pressable>
                );
              }}
            />

            <Text style={s.hint}>点击单张可重新生成 · 长按或一键重置</Text>
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 6, minHeight: 48,
    borderBottomWidth: 1, borderBottomColor: "#1c1c2a",
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: "#fff", fontSize: 17, fontWeight: "600", textAlign: "center" },

  quotaBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: "rgba(126,111,208,0.08)",
  },
  quotaText: { color: "#bbb", fontSize: 13 },
  resetBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14,
    borderWidth: 1, borderColor: "#7e6fd0",
  },
  resetText: { color: "#7e6fd0", fontSize: 12, fontWeight: "600" },

  cell: {
    flex: 1, aspectRatio: 0.85, marginBottom: 8,
    borderRadius: 10, borderWidth: 1.5, overflow: "hidden",
    backgroundColor: "#1c1c2a",
    borderColor: "#2a2a3a",
  },
  currentBadge: {
    position: "absolute", left: 6, top: 6,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  currentBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  cellImgWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  cellImg: { width: "100%", height: "100%" },
  cellEmpty: { color: "#666", fontSize: 12 },
  cellMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center", justifyContent: "center",
  },
  cellLabel: { fontSize: 12, fontWeight: "600", textAlign: "center", paddingVertical: 6 },

  hint: { color: "#666", fontSize: 12, textAlign: "center", paddingVertical: 10 },
});
