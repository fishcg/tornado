import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View,
} from "react-native";
import {
  RecordingPresets, requestRecordingPermissionsAsync,
  useAudioRecorder, useAudioRecorderState,
} from "expo-audio";
import * as DocumentPicker from "expo-document-picker";
import { baseUrl, clientHeaders, loadToken } from "@/api/client";
import { api } from "@/api/client";
import { confirm, toast } from "@/components/Ui";
import { playTts, stopTts, TtsPlayerHost } from "@/audio/tts";
import PageHeader from "@/components/PageHeader";

type VoiceInfo = { voice_id: string | null; tts_enabled: number; voice_channel: string };
type ActiveChar = { id: number; name: string };

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_RECORD_MS = 30_000;
const CT_BY_EXT: Record<string, string> = {
  m4a: "audio/m4a", mp4: "audio/mp4", wav: "audio/wav",
  mp3: "audio/mpeg", caf: "audio/x-caf", aac: "audio/aac",
  ogg: "audio/ogg", webm: "audio/webm",
};

export default function VoiceClone() {
  const router = useRouter();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const [voice, setVoice] = useState<VoiceInfo | null>(null);
  const [active, setActive] = useState<ActiveChar | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [v, c] = await Promise.all([
        api<VoiceInfo>("GET", "/character/voice"),
        api<ActiveChar>("GET", "/character").catch(() => null),
      ]);
      setVoice(v); setActive(c);
    } catch {} finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => () => { stopTts(); if (state.isRecording) recorder.stop().catch(() => {}); }, []);

  // 录满 30s 自动停止 & 上传
  useEffect(() => {
    if (state.isRecording && (state.durationMillis ?? 0) >= MAX_RECORD_MS && !stopRef.current) {
      stopAndUpload();
    }
  }, [state.isRecording, state.durationMillis]);

  const uploadAudio = async (uri: string, mimeFromPicker?: string) => {
    setUploading(true);
    try {
      const fileResp = await fetch(uri);
      const blob = await fileResp.blob();
      if (blob.size > MAX_BYTES) {
        toast(`文件过大：最大 20MB，当前约 ${(blob.size / 1024 / 1024).toFixed(1)}MB`, "err");
        return;
      }
      const ext = uri.split("?")[0].split(".").pop()?.toLowerCase() || "m4a";
      const contentType = mimeFromPicker || CT_BY_EXT[ext] || "audio/m4a";
      const token = await loadToken();
      const res = await fetch(`${baseUrl}/character/voice`, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          ...clientHeaders(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: blob,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }
      toast("音色已复刻");
      await load();
    } catch (e: any) {
      toast(e.message || "上传失败", "err");
    } finally { setUploading(false); }
  };

  const pickFile = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({
        type: "audio/*",
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (r.canceled || !r.assets?.[0]) return;
      const a = r.assets[0];
      if (a.size && a.size > MAX_BYTES) {
        toast(`文件过大：最大 20MB，当前约 ${(a.size / 1024 / 1024).toFixed(1)}MB`, "err");
        return;
      }
      await uploadAudio(a.uri, a.mimeType || undefined);
    } catch (e: any) {
      toast(e.message || "选择失败", "err");
    }
  };

  const startRec = async () => {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) { toast("需要麦克风权限", "err"); return; }
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (e: any) { toast(e.message || "录音失败", "err"); }
  };

  const stopAndUpload = async () => {
    if (stopRef.current) return;
    stopRef.current = true;
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) { toast("没有录音文件", "err"); return; }
      await uploadAudio(uri);
    } catch (e: any) {
      toast(e.message || "处理失败", "err");
    } finally { stopRef.current = false; }
  };

  const preview = async () => {
    if (!voice?.voice_id || previewing) return;
    setPreviewing(true);
    try {
      const r = await api<{ audio_url: string }>("POST", "/character/voice/preview", {});
      if (r.audio_url) await playTts(r.audio_url, "preview");
    } catch (e: any) {
      toast(e.message || "试听失败", "err");
    } finally { setPreviewing(false); }
  };

  const remove = async () => {
    const ok = await confirm({
      title: "删除音色",
      message: "删除后该角色将失去配音能力。",
      confirmText: "删除",
      destructive: true,
    });
    if (!ok) return;
    try { await api("DELETE", "/character/voice"); await load(); }
    catch (e: any) { toast(e.message || "删除失败", "err"); }
  };

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;
  if (!active) return (
    <View style={s.center}>
      <Text style={{ color: "#888" }}>没有激活的角色</Text>
      <Pressable onPress={() => router.back()}><Text style={s.back}>返回</Text></Pressable>
    </View>
  );

  const recordingMs = state.durationMillis ?? 0;
  const busy = uploading || state.isRecording;

  return (
    <View style={s.container}>
      <TtsPlayerHost />
      <PageHeader title="声音复刻" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={s.charName}>当前角色：{active.name}</Text>

      <View style={s.card}>
        <Text style={s.label}>当前音色</Text>
        <Text style={s.value}>{voice?.voice_id ? `${voice.voice_id.slice(0, 16)}…  · ${voice.voice_channel}` : "未复刻"}</Text>
        {voice?.voice_id && (
          <View style={s.btnRow}>
            <Pressable style={s.outlineBtn} disabled={previewing} onPress={preview}>
              <Text style={s.outlineText}>{previewing ? "生成中…" : "▶ 试听"}</Text>
            </Pressable>
            <Pressable style={s.dangerBtn} onPress={remove}>
              <Text style={s.dangerText}>删除音色</Text>
            </Pressable>
          </View>
        )}
      </View>

      <Text style={s.section}>上传音频文件（推荐）</Text>
      <Text style={s.hint}>支持 mp3 / wav / m4a / aac 等常见格式，文件不超过 20MB。建议时长 10s ~ 60s，安静、清晰、单人。</Text>
      <Pressable style={[s.primaryBtn, busy && { opacity: 0.4 }]} disabled={busy} onPress={pickFile}>
        {uploading
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.primaryText}>从文件选择音频</Text>}
      </Pressable>

      <Text style={[s.section, { marginTop: 28 }]}>或现场录制（最长 30 秒）</Text>
      <View style={s.recordCard}>
        <Text style={[s.timer, recordingMs >= MAX_RECORD_MS - 5000 && { color: "#f87171" }]}>
          {formatMs(recordingMs)} / 0:30
        </Text>
        {state.isRecording ? (
          <Pressable style={s.recordBtnStop} onPress={stopAndUpload}>
            <Text style={s.recordBtnText}>停止并上传</Text>
          </Pressable>
        ) : (
          <Pressable style={[s.recordBtn, uploading && { opacity: 0.4 }]}
            disabled={uploading} onPress={startRec}>
            <Text style={s.recordBtnText}>● 开始录制</Text>
          </Pressable>
        )}
      </View>
      </ScrollView>
    </View>
  );
}

function formatMs(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = `${s % 60}`.padStart(2, "0");
  return `${m}:${ss}`;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17", gap: 12 },
  back: { color: "#7e6fd0", marginBottom: 12 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700" },
  charName: { color: "#bbb", fontSize: 14, marginTop: 4, marginBottom: 18 },

  card: { backgroundColor: "#1c1c2a", borderRadius: 12, padding: 14, marginBottom: 18 },
  label: { color: "#888", fontSize: 11, marginBottom: 4 },
  value: { color: "#fff", fontSize: 14 },
  btnRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  outlineBtn: { borderWidth: 1, borderColor: "#7e6fd0", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  outlineText: { color: "#7e6fd0", fontSize: 13 },
  dangerBtn: { paddingHorizontal: 14, paddingVertical: 8 },
  dangerText: { color: "#ef4444", fontSize: 13 },

  section: { color: "#bbb", fontSize: 14, fontWeight: "600", marginBottom: 4 },
  hint: { color: "#666", fontSize: 12, marginBottom: 12, lineHeight: 18 },

  primaryBtn: { backgroundColor: "#7e6fd0", paddingVertical: 14, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "600", fontSize: 15 },

  recordCard: { backgroundColor: "#1c1c2a", borderRadius: 12, padding: 22, alignItems: "center", gap: 16 },
  timer: { color: "#fff", fontSize: 32, fontVariant: ["tabular-nums"], fontWeight: "300" },
  recordBtn: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#7e6fd0", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 },
  recordBtnStop: { backgroundColor: "#ef4444", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24, minWidth: 140, alignItems: "center" },
  recordBtnText: { color: "#fff", fontWeight: "600" },
});
