import { useEffect, useRef, useState } from "react";
import {
  Animated, Easing, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { AudioPlayer } from "expo-audio";
import { api } from "@/api/client";

const RING_URL = "https://acgay.oss-cn-hangzhou.aliyuncs.com/tornado/audio/ring2.mp3";

export type IncomingCallData = {
  call_log_id?: number;
  msg_id?: number;
  session_id?: number;
  char_name?: string;
  char_avatar?: string | null;
  script?: string;
  audio_url?: string | null;
  tts_lang?: string;
  show_subtitle?: boolean;
};

type Props = {
  visible: boolean;
  data: IncomingCallData | null;
  onClose: (answered: boolean) => void;
};

const stripActions = (s: string) =>
  s.replace(/[（(][^）)]{0,80}[）)]/g, "")
   .replace(/[【\[][^\]】]{0,80}[\]】]/g, "")
   .replace(/\s{2,}/g, " ").trim();

export default function IncomingCall({ visible, data, onClose }: Props) {
  const [phase, setPhase] = useState<"ringing" | "in-call" | "ended">("ringing");
  const [seconds, setSeconds] = useState(0);
  const [showSubtitle, setShowSubtitle] = useState(false);
  const ringRef = useRef<AudioPlayer | null>(null);
  const callRef = useRef<AudioPlayer | null>(null);
  const ringCountRef = useRef(0);
  const timerRef = useRef<any>(null);
  const closedRef = useRef(false);

  // 头像呼吸光晕
  const pulse = useRef(new Animated.Value(0)).current;

  const stopAll = () => {
    if (ringRef.current) { try { ringRef.current.pause(); } catch {} try { ringRef.current.remove(); } catch {} ringRef.current = null; }
    if (callRef.current) { try { callRef.current.pause(); } catch {} try { callRef.current.remove(); } catch {} callRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const finish = (answered: boolean) => {
    if (closedRef.current) return;
    closedRef.current = true;
    stopAll();
    onClose(answered);
  };

  useEffect(() => {
    if (!visible || !data) return;
    closedRef.current = false;
    setPhase("ringing");
    setSeconds(0);
    setShowSubtitle(false);
    ringCountRef.current = 0;

    // 静音模式下也要响
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    }).catch(() => {});

    // 铃声循环（最多 10 次未接 → missed）
    const playRing = () => {
      try {
        console.log("[call] ring play", RING_URL);
        const p = createAudioPlayer({ uri: RING_URL });
        ringRef.current = p;
        p.play();
        p.addListener("playbackStatusUpdate", (st: any) => {
          if (st.didJustFinish || st.isPlaybackFinished) {
            ringCountRef.current += 1;
            try { p.remove(); } catch {}
            if (ringRef.current === p) ringRef.current = null;
            if (closedRef.current) return;
            if (ringCountRef.current >= 10) {
              if (data.call_log_id) api("POST", `/call-logs/${data.call_log_id}/missed`).catch(() => {});
              finish(false);
            } else {
              playRing();
            }
          }
        });
      } catch (e) { console.warn("[call] ring 失败", e); }
    };
    playRing();

    // 头像脉冲
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
    ]));
    loop.start();

    return () => {
      loop.stop();
      stopAll();
    };
  }, [visible, data?.call_log_id]);

  const onAccept = () => {
    if (!data) return;
    if (ringRef.current) { try { ringRef.current.pause(); } catch {} try { ringRef.current.remove(); } catch {} ringRef.current = null; }
    setPhase("in-call");
    if (data.call_log_id) api("POST", `/call-logs/${data.call_log_id}/answer`).catch(() => {});

    // 通话计时
    timerRef.current = setInterval(() => setSeconds((n) => n + 1), 1000);

    // 字幕（日语模式或显式要求）
    if (data.tts_lang === "ja" || data.show_subtitle) {
      const t = stripActions(data.script || "");
      if (t) setShowSubtitle(true);
    }

    // 0.7s 后播放对方语音
    if (data.audio_url) {
      setTimeout(() => {
        if (closedRef.current) return;
        try {
          const p = createAudioPlayer({ uri: data.audio_url! });
          callRef.current = p;
          p.play();
          p.addListener("playbackStatusUpdate", (st: any) => {
            if (st.didJustFinish || st.isPlaybackFinished) {
              setPhase("ended");
              if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
              setTimeout(() => finish(true), 2400);
            }
          });
        } catch { setTimeout(() => finish(true), 6000); }
      }, 700);
    } else {
      const t = stripActions(data.script || "");
      if (t) setShowSubtitle(true);
      setTimeout(() => finish(true), 6000);
    }
  };

  if (!visible || !data) return null;

  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.55] });
  const haloRadius = pulse.interpolate({ inputRange: [0, 1], outputRange: [12, 36] });
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });

  const status = phase === "ringing" ? "来电中…"
    : phase === "ended" ? "通话结束"
    : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  const subtitle = showSubtitle ? stripActions(data.script || "") : "";
  const initial = (data.char_name || "?")[0];

  return (
    <Modal visible animationType="fade" transparent statusBarTranslucent>
      <View style={s.bg}>
        <View style={s.phone}>
          <View style={s.body}>
            <View style={s.avatarWrap}>
              <Animated.View style={[s.avatarRing, { transform: [{ scale: ringScale }], opacity: haloOpacity }]} />
              <Animated.View style={[s.avatar, {
                shadowColor: "#fff",
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: haloOpacity,
                shadowRadius: haloRadius,
                elevation: 10,
              }]}>
                {data.char_avatar
                  ? <Image source={{ uri: data.char_avatar }} style={s.avatarImg} />
                  : <Text style={s.avatarText}>{initial}</Text>}
              </Animated.View>
            </View>

            <Text style={s.charName}>{data.char_name || ""}</Text>
            <Text style={s.status}>{status}</Text>

            {subtitle ? (
              <ScrollView style={s.subtitleBox} contentContainerStyle={{ paddingHorizontal: 24 }}>
                <Text style={s.subtitle}>{subtitle}</Text>
              </ScrollView>
            ) : null}
          </View>

          <View style={[s.actions, phase !== "ringing" && s.actionsCenter]}>
            {phase === "ringing" ? (
              <View style={s.btnWrap}>
                <Pressable style={[s.btn, s.btnDecline]} onPress={() => finish(false)}>
                  <PhoneIcon rotated />
                </Pressable>
                <Text style={s.btnLabel}>挂断</Text>
              </View>
            ) : null}
            <View style={s.btnWrap}>
              <Pressable
                style={[s.btn, phase === "ringing" ? s.btnAccept : s.btnDecline]}
                onPress={phase === "ringing" ? onAccept : () => finish(true)}
              >
                <PhoneIcon rotated={phase !== "ringing"} />
              </Pressable>
              <Text style={s.btnLabel}>{phase === "ringing" ? "接听" : "挂断"}</Text>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function PhoneIcon({ rotated }: { rotated?: boolean }) {
  return (
    <View style={rotated ? { transform: [{ rotate: "135deg" }] } : null}>
      <Svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.13 19.13 0 0 1 4.26 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.17 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.15 8.91a16 16 0 0 0 6.61 6.61l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
  phone: {
    width: "100%", height: "100%",
    backgroundColor: "#0a1520",
    alignItems: "center",
  },

  body: { flex: 1, alignItems: "center", paddingTop: 140 },
  avatarWrap: { width: 120, height: 120, alignItems: "center", justifyContent: "center" },
  avatarRing: { position: "absolute", width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: "rgba(255,255,255,0.35)" },
  avatar: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center", justifyContent: "center", overflow: "hidden",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarText: { color: "#fff", fontSize: 36, fontWeight: "700" },

  charName: { color: "#fff", fontSize: 24, fontWeight: "500", marginTop: 22 },
  status: { color: "rgba(255,255,255,0.55)", fontSize: 13, marginTop: 8, letterSpacing: 1 },

  subtitleBox: { maxHeight: 160, marginTop: 22, width: "100%" },
  subtitle: { color: "rgba(255,255,255,0.7)", fontSize: 14, lineHeight: 22, textAlign: "center" },

  actions: {
    width: "100%", flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 60, paddingBottom: 60,
  },
  actionsCenter: { justifyContent: "center" },
  btnWrap: { alignItems: "center", gap: 11 },
  btn: {
    width: 74, height: 74, borderRadius: 37, alignItems: "center", justifyContent: "center",
  },
  btnDecline: { backgroundColor: "#e05252" },
  btnAccept: { backgroundColor: "#3dba6e" },
  btnLabel: { color: "rgba(255,255,255,0.7)", fontSize: 14 },
});
