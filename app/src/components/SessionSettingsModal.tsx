import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/api/client";
import { IconBack } from "@/components/Icons";

type SessionSettings = {
  mood?: string;
  topic_summary?: string | null;
  dnd_start?: string | null;
  dnd_end?: string | null;
  proactive_idle_minutes?: number | null;
};

export default function SessionSettingsModal({
  visible, sessionId, onClose,
}: {
  visible: boolean; sessionId: number | null; onClose: () => void;
}) {
  const [data, setData] = useState<SessionSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [dndStart, setDndStart] = useState("");
  const [dndEnd, setDndEnd] = useState("");
  const [idleMins, setIdleMins] = useState("");
  const saveTimer = useRef<any>(null);

  useEffect(() => {
    if (!visible || !sessionId) return;
    setLoading(true);
    api<SessionSettings>("GET", `/sessions/${sessionId}/mood`)
      .then((r) => {
        setData(r);
        setDndStart(r.dnd_start || "");
        setDndEnd(r.dnd_end || "");
        setIdleMins(r.proactive_idle_minutes ? String(r.proactive_idle_minutes) : "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [visible, sessionId]);

  const persist = (patch: Record<string, any>) => {
    if (!sessionId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api("PATCH", `/sessions/${sessionId}/settings`, patch).catch(() => {});
    }, 400);
  };

  const onChangeDndStart = (v: string) => { setDndStart(v); persist({ dnd_start: v.trim() || null }); };
  const onChangeDndEnd = (v: string) => { setDndEnd(v); persist({ dnd_end: v.trim() || null }); };
  const onChangeIdle = (v: string) => {
    const cleaned = v.replace(/[^\d]/g, "");
    setIdleMins(cleaned);
    persist({ proactive_idle_minutes: cleaned ? Number(cleaned) : null });
  };

  const clearDnd = () => {
    setDndStart(""); setDndEnd("");
    persist({ dnd_start: null, dnd_end: null });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView edges={["top", "bottom"]} style={s.container}>
        <View style={s.header}>
          <Pressable onPress={onClose} style={s.iconBtn} hitSlop={8}>
            <IconBack size={24} color="#fff" />
          </Pressable>
          <Text style={s.title}>会话设置</Text>
          <View style={{ width: 40 }} />
        </View>

        {loading || !data ? (
          <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            <Text style={s.section}>勿扰时段</Text>
            <Hint>这段时间内不发起来电、不主动消息（HH:MM 格式，例如 23:00 - 07:00）。</Hint>
            <View style={s.timeRow}>
              <TextInput
                value={dndStart}
                onChangeText={onChangeDndStart}
                placeholder="开始 23:00"
                placeholderTextColor="#555"
                style={s.timeInput}
                maxLength={5}
                keyboardType="numbers-and-punctuation"
              />
              <Text style={s.timeSep}>到</Text>
              <TextInput
                value={dndEnd}
                onChangeText={onChangeDndEnd}
                placeholder="结束 07:00"
                placeholderTextColor="#555"
                style={s.timeInput}
                maxLength={5}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            {(dndStart || dndEnd) ? (
              <Pressable onPress={clearDnd} style={s.clearBtn}>
                <Text style={s.clearText}>清除勿扰</Text>
              </Pressable>
            ) : null}

            <Text style={s.section}>主动消息间隔</Text>
            <Hint>用户超过这段时间没说话，角色会主动发消息。留空则使用默认。</Hint>
            <View style={s.row}>
              <TextInput
                value={idleMins}
                onChangeText={onChangeIdle}
                placeholder="默认（10）"
                placeholderTextColor="#555"
                style={s.numInput}
                maxLength={4}
                keyboardType="number-pad"
              />
              <Text style={s.unit}>分钟</Text>
            </View>

            <Text style={[s.section, { marginTop: 24 }]}>会话情绪</Text>
            <Text style={s.muted}>当前：{data.mood || "neutral"}</Text>
            {data.topic_summary ? (
              <>
                <Text style={[s.section, { marginTop: 24 }]}>当前话题摘要</Text>
                <Text style={s.summary}>{data.topic_summary}</Text>
              </>
            ) : null}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function Hint({ children }: { children: any }) {
  return <Text style={s.hint}>{children}</Text>;
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

  section: { color: "#888", fontSize: 13, marginTop: 12, marginBottom: 6 },
  hint: { color: "#666", fontSize: 12, marginBottom: 10, lineHeight: 18 },
  muted: { color: "#bbb", fontSize: 14 },
  summary: { color: "#ddd", fontSize: 14, lineHeight: 22, backgroundColor: "#1c1c2a", padding: 12, borderRadius: 8 },

  timeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  timeInput: {
    flex: 1, backgroundColor: "#1c1c2a", color: "#fff",
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    borderWidth: 1, borderColor: "#2a2a3a",
  },
  timeSep: { color: "#888" },
  clearBtn: { alignSelf: "flex-start", marginTop: 10 },
  clearText: { color: "#7e6fd0", fontSize: 13 },

  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  numInput: {
    width: 100, backgroundColor: "#1c1c2a", color: "#fff",
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    borderWidth: 1, borderColor: "#2a2a3a",
  },
  unit: { color: "#bbb" },
});
