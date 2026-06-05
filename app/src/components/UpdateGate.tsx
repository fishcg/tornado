import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import { Linking as RNLinking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, appVersion, compareVersions, setVersionBlockHandler } from "@/api/client";

type LatestVersion = {
  latest_version?: string | null;
  release_notes?: string;
  download_url?: string;
  force_update?: number;
  min_version?: string | null;
};

/**
 * 启动时检查 Android 最新版本（全部走语义化版本号）。
 * - latest_version > 本机 version → 提示更新
 * - force_update 或 本机 < min_version → 强制（不可关闭，拦截使用）
 * min_version 与服务端中间件用同一个阈值（global_settings.app_min_version）。
 * 网络失败静默跳过，不阻断启动。
 */
export function UpdateGate() {
  const [info, setInfo] = useState<LatestVersion | null>(null);
  const [force, setForce] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<LatestVersion>("GET", "/app/latest-version?platform=android");
        if (cancelled || !data || !data.latest_version || !data.download_url) return;
        const hasUpdate = compareVersions(appVersion, data.latest_version) < 0;
        if (!hasUpdate) return;
        const belowMin = !!data.min_version && compareVersions(appVersion, data.min_version) < 0;
        const mustUpdate = !!data.force_update || belowMin;
        setInfo(data);
        setForce(mustUpdate);
      } catch {
        // 静默跳过
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 任意请求被服务端以 426 拦截（版本过低）→ 强制弹更新
  useEffect(() => {
    setVersionBlockHandler((blocked: any) => {
      setInfo({
        latest_version: blocked?.latest_version || "",
        download_url: blocked?.download_url || "",
        release_notes: blocked?.message || "当前版本过低，请更新后继续使用",
      });
      setForce(true);
    });
    return () => setVersionBlockHandler(() => {});
  }, []);

  const openDownload = () => {
    if (!info?.download_url) return;
    Linking.openURL(info.download_url).catch(() => {
      RNLinking.openURL(info.download_url!).catch(() => {});
    });
  };

  const visible = !!info && (force || !dismissed);
  if (!visible) return null;

  const notes = (info?.release_notes || "").trim();

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => { if (!force) setDismissed(true); }}>
      <View style={s.bg}>
        <View style={s.card}>
          <Text style={s.title}>发现新版本 {info?.latest_version || ""}</Text>
          {force ? <Text style={s.forceTag}>此版本需要更新后才能继续使用</Text> : null}
          {notes ? (
            <ScrollView style={s.notesWrap} contentContainerStyle={{ paddingVertical: 4 }}>
              <Text style={s.notes}>{notes}</Text>
            </ScrollView>
          ) : null}
          <View style={s.btnRow}>
            {!force ? (
              <Pressable style={[s.btn, s.btnGhost]} onPress={() => setDismissed(true)}>
                <Text style={s.btnGhostText}>稍后</Text>
              </Pressable>
            ) : null}
            <Pressable style={[s.btn, s.btnPrimary]} onPress={openDownload}>
              <Text style={s.btnPrimaryText}>立即更新</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 32 },
  card: { width: "100%", maxWidth: 360, backgroundColor: "#1c1c2a", borderRadius: 16, padding: 22, borderWidth: 1, borderColor: "#2a2a3a" },
  title: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 8 },
  forceTag: { color: "#f472b6", fontSize: 13, marginBottom: 10 },
  notesWrap: { maxHeight: 200, marginBottom: 16 },
  notes: { color: "#cfcfe0", fontSize: 14, lineHeight: 21 },
  btnRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  btn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  btnGhost: { backgroundColor: "#2a2a3a" },
  btnGhostText: { color: "#bbb", fontSize: 14, fontWeight: "500" },
  btnPrimary: { backgroundColor: "#7e6fd0" },
  btnPrimaryText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});

