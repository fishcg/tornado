import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from "react-native";
import Slider from "@react-native-community/slider";
import { api } from "@/api/client";
import { useUi } from "@/store/ui";

type UserSettings = {
  imageFallbackEnabled: boolean;
  chatImageEnabled: boolean;
  imageAutoExpand: boolean;
  collapseAction: boolean;
  ttsEnabled: boolean;
  ttsLang: "zh" | "ja";
  llmProvider: string;
  manualAffectionEnabled: boolean;
};

type Me = { is_admin: number };
type SessionRow = { id: number };

export default function Settings() {
  const [s_, setS_] = useState<UserSettings | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionIds, setSessionIds] = useState<number[]>([]);
  const [dndStart, setDndStart] = useState("");
  const [dndEnd, setDndEnd] = useState("");
  const [idleMins, setIdleMins] = useState("");

  const chatBgOpacity = useUi((u) => u.chatBgOpacity);
  const bubbleOpacity = useUi((u) => u.bubbleOpacity);
  const setChatBgOpacity = useUi((u) => u.setChatBgOpacity);
  const setBubbleOpacity = useUi((u) => u.setBubbleOpacity);

  const saveTimer = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      const [u, meRes, sessionList] = await Promise.all([
        api<UserSettings>("GET", "/settings"),
        api<Me>("GET", "/auth/me").catch(() => null),
        api<SessionRow[]>("GET", "/sessions").catch(() => []),
      ]);
      setS_(u);
      setMe(meRes);
      const ids = (sessionList || []).map((x: any) => x.id).filter(Boolean);
      setSessionIds(ids);
      // 用最近一个 session 的当前值作为表单初值
      if (ids.length > 0) {
        try {
          const top = await api<any>("GET", `/sessions/${ids[0]}/mood`);
          setDndStart(top.dnd_start || "");
          setDndEnd(top.dnd_end || "");
          setIdleMins(top.proactive_idle_minutes ? String(top.proactive_idle_minutes) : "");
        } catch {}
      }
    } catch {} finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // 改任何一项立即落库（带 200ms 防抖，避免连点）
  const persist = (next: UserSettings) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await api<UserSettings>("PATCH", "/settings", {
          chatImageEnabled: next.chatImageEnabled,
          imageFallbackEnabled: next.imageFallbackEnabled,
          imageAutoExpand: next.imageAutoExpand,
          collapseAction: next.collapseAction,
          ttsEnabled: next.ttsEnabled,
          ttsLang: next.ttsLang,
          ...(me?.is_admin ? { llmProvider: next.llmProvider } : {}),
        });
      } catch {}
    }, 200);
  };

  const patch = (k: keyof UserSettings, v: any) => {
    setS_((cur) => {
      if (!cur) return cur;
      const next = { ...cur, [k]: v };
      persist(next);
      return next;
    });
  };

  // 把"会话级设置"批量推到所有 session（防抖 400ms）
  const sessionSaveTimer = useRef<any>(null);
  const persistSessionSettings = (patchBody: Record<string, any>) => {
    if (sessionSaveTimer.current) clearTimeout(sessionSaveTimer.current);
    sessionSaveTimer.current = setTimeout(() => {
      sessionIds.forEach((id) => {
        api("PATCH", `/sessions/${id}/settings`, patchBody).catch(() => {});
      });
    }, 400);
  };

  const onChangeDndStart = (v: string) => { setDndStart(v); persistSessionSettings({ dnd_start: v.trim() || null }); };
  const onChangeDndEnd = (v: string) => { setDndEnd(v); persistSessionSettings({ dnd_end: v.trim() || null }); };
  const onChangeIdle = (v: string) => {
    const cleaned = v.replace(/[^\d]/g, "");
    setIdleMins(cleaned);
    persistSessionSettings({ proactive_idle_minutes: cleaned ? Number(cleaned) : null });
  };
  const clearDnd = () => {
    setDndStart(""); setDndEnd("");
    persistSessionSettings({ dnd_start: null, dnd_end: null });
  };

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <ScrollView style={s.container} contentContainerStyle={{ padding: 16, paddingTop: 56, paddingBottom: 40 }}>
      <Text style={s.title}>设置</Text>

      <Text style={s.section}>外观</Text>
      <SliderRow
        label="聊天背景强度"
        value={chatBgOpacity}
        onChange={setChatBgOpacity}
        valueText={`${Math.round(chatBgOpacity * 100)}%`}
      />
      <SliderRow
        label="气泡不透明度"
        value={bubbleOpacity}
        onChange={setBubbleOpacity}
        valueText={`${Math.round(bubbleOpacity * 100)}%`}
      />
      <Hint>调整聊天页背景图的可见度，以及消息气泡的不透明度。</Hint>

      <Text style={s.section}>对话展示</Text>
      <Row label="隐藏动作描述" value={!!s_?.collapseAction} onChange={(v) => patch("collapseAction", v)} />
      <Hint>开启后，括号内的动作 / 心理描写将被隐藏，只显示台词。</Hint>

      <Text style={s.section}>聊天插图</Text>
      <Row label="自动生成插图" value={!!s_?.chatImageEnabled} onChange={(v) => patch("chatImageEnabled", v)} />
      <Row label="图片默认展开" value={!!s_?.imageAutoExpand} onChange={(v) => patch("imageAutoExpand", v)} />
      <Row label="生图失败启用备用 API" value={!!s_?.imageFallbackEnabled} onChange={(v) => patch("imageFallbackEnabled", v)} />
      <Hint>关闭自动插图后，[IMG:] 标记仍生效；备用 API 在主 API 失败时切到 DashScope 重试。</Hint>

      <Text style={s.section}>语音配音</Text>
      <Row label="配音" value={!!s_?.ttsEnabled} onChange={(v) => patch("ttsEnabled", v)} />
      <View style={s.row}>
        <Text style={s.rowLabel}>配音语言</Text>
        <View style={s.langRow}>
          {(["zh", "ja"] as const).map((l) => (
            <Pressable key={l} onPress={() => patch("ttsLang", l)}
              style={[s.langChip, s_?.ttsLang === l && s.langChipActive]}>
              <Text style={[s.langText, s_?.ttsLang === l && s.langTextActive]}>{l === "zh" ? "中文" : "日语"}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Hint>开启后角色每条回复会自动配音。需要先在角色页完成声音复刻。</Hint>

      {me?.is_admin ? (
        <>
          <Text style={s.section}>聊天模型（仅管理员）</Text>
          <View style={s.row}>
            <Text style={s.rowLabel}>提供方</Text>
            <View style={s.langRow}>
              {(["deepseek", "newapi"] as const).map((p) => (
                <Pressable key={p} onPress={() => patch("llmProvider", p)}
                  style={[s.langChip, s_?.llmProvider === p && s.langChipActive]}>
                  <Text style={[s.langText, s_?.llmProvider === p && s.langTextActive]}>{p === "deepseek" ? "DeepSeek" : "NewAPI"}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </>
      ) : null}

      <Text style={[s.section, { marginTop: 28 }]}>会话级设置（对所有会话生效）</Text>
      <Hint>勿扰时段（HH:MM）：这段时间内不发起来电、不主动消息。留空表示不启用。</Hint>
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

      <Text style={[s.subSection]}>主动消息间隔</Text>
      <Hint>用户超过这段时间没说话，角色会主动发消息。留空使用默认（10）。</Hint>
      <View style={s.idleRow}>
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
    </ScrollView>
  );
}

function Row({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: "#333", true: "#7e6fd0" }}
        thumbColor={value ? "#f3f0ff" : "#bbb"}
        ios_backgroundColor="#333"
      />
    </View>
  );
}

function SliderRow({ label, value, onChange, valueText }: {
  label: string; value: number;
  onChange: (v: number) => void;
  valueText: string;
}) {
  return (
    <View style={s.sliderRow}>
      <View style={s.sliderHeader}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.sliderVal}>{valueText}</Text>
      </View>
      <Slider
        minimumValue={0}
        maximumValue={1}
        step={0.01}
        value={value}
        onSlidingComplete={onChange}
        minimumTrackTintColor="#7e6fd0"
        maximumTrackTintColor="#333"
        thumbTintColor="#7e6fd0"
      />
    </View>
  );
}

function Hint({ children }: { children: any }) {
  return <Text style={s.hint}>{children}</Text>;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" },
  title: { color: "#fff", fontSize: 22, fontWeight: "700", marginBottom: 18 },
  section: { color: "#888", fontSize: 13, marginTop: 22, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#1c1c2a" },
  rowLabel: { color: "#fff", fontSize: 15 },
  hint: { color: "#666", fontSize: 12, marginTop: 6, lineHeight: 18 },
  sliderRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#1c1c2a" },
  sliderHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  sliderVal: { color: "#888", fontSize: 12 },
  langRow: { flexDirection: "row", gap: 6 },
  langChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: "#333" },
  langChipActive: { backgroundColor: "#7e6fd0", borderColor: "#7e6fd0" },
  langText: { color: "#888", fontSize: 12 },
  langTextActive: { color: "#fff" },

  subSection: { color: "#888", fontSize: 13, marginTop: 16, marginBottom: 6 },
  timeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  timeInput: {
    flex: 1, backgroundColor: "#1c1c2a", color: "#fff",
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    borderWidth: 1, borderColor: "#2a2a3a",
  },
  timeSep: { color: "#888" },
  clearBtn: { alignSelf: "flex-start", marginTop: 10 },
  clearText: { color: "#7e6fd0", fontSize: 13 },
  idleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  numInput: {
    width: 100, backgroundColor: "#1c1c2a", color: "#fff",
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    borderWidth: 1, borderColor: "#2a2a3a",
  },
  unit: { color: "#bbb" },
});
