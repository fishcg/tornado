import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Animated, Easing, FlatList, Image, Keyboard,
  Modal, Pressable, StyleSheet, Text, TextInput, View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import * as MediaLibrary from "expo-media-library";
import * as FileSystem from "expo-file-system/legacy";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import { api, baseUrl, clientHeaders, loadToken } from "@/api/client";
import { streamChat } from "@/hooks/useSSE";
import { useWS } from "@/hooks/useWS";
import { playTts, stopTts, TtsPlayerHost, useTtsPlayingId } from "@/audio/tts";
import IncomingCall, { type IncomingCallData } from "@/components/IncomingCall";
import AvatarsModal from "@/components/AvatarsModal";
import { confirm, toast, actionSheet, hapticLight } from "@/components/Ui";
import { moodInfo } from "@/constants/mood";
import {
  IconAuto, IconBack, IconBookmark, IconHeart, IconImage, IconMore, IconPlay,
  IconScene, IconSemi, IconSend, IconSettings,
} from "@/components/Icons";
import { useUi } from "@/store/ui";
import { useAvatars } from "@/store/avatars";
import { useAuth } from "@/store/auth";

type Msg = {
  id: number | string;
  role: "user" | "assistant" | "system";
  content: string;
  pending?: boolean;
  tts_audio_url?: string | null;
  image_url?: string | null;
  favorited?: number;
};

type CharacterInfo = { id: number; name: string; affection: number };
type SessionMood = { mood: string; auto_mode?: number };

const ASSIST_BG = "#1c1c2a";
const USER_BG = "#3a2438";
const ACTION_COLOR = "#a89fd8";
const BUBBLE_IMG_W = 240;

function withOpacity(hex: string, alpha: number) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

function renderBubbleParts(text: string, collapseAction = false) {
  const parts = text.split(/(（[^）]*）|\([^)]*\))/g).filter(Boolean);
  return parts.map((p, i) => {
    const isAction = /^（[^）]*）$/.test(p) || /^\([^)]*\)$/.test(p);
    return { key: i, isAction, text: p };
  }).filter((part) => !(collapseAction && part.isAction));
}

export default function ChatScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const sid = Number(sessionId);
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const typingTimerRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [character, setCharacter] = useState<CharacterInfo | null>(null);
  const [mood, setMood] = useState<string>("neutral");
  const [moodFloat, setMoodFloat] = useState<{ key: number; label: string; color: string; negative: boolean } | null>(null);
  const moodFloatAnim = useRef(new Animated.Value(0)).current;
  const moodFloatShake = useRef(new Animated.Value(0)).current;
  const moodFloatTimer = useRef<any>(null);

  const triggerMoodFloat = (newMood: string) => {
    const info = moodInfo(newMood);
    const negative = !!(info as any).negative;
    setMoodFloat({ key: Date.now(), label: info.label, color: info.color, negative });
    moodFloatAnim.setValue(0);
    moodFloatShake.setValue(0);
    Animated.timing(moodFloatAnim, {
      toValue: 1,
      duration: 2000,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    if (negative) {
      // 负面情绪：横向抖动 3 次
      Animated.sequence([
        Animated.timing(moodFloatShake, { toValue: 1, duration: 60, useNativeDriver: true }),
        Animated.timing(moodFloatShake, { toValue: -1, duration: 60, useNativeDriver: true }),
        Animated.timing(moodFloatShake, { toValue: 1, duration: 60, useNativeDriver: true }),
        Animated.timing(moodFloatShake, { toValue: -1, duration: 60, useNativeDriver: true }),
        Animated.timing(moodFloatShake, { toValue: 0, duration: 60, useNativeDriver: true }),
      ]).start();
    }
    if (moodFloatTimer.current) clearTimeout(moodFloatTimer.current);
    moodFloatTimer.current = setTimeout(() => setMoodFloat(null), 2050);
  };

  // 心动值变化飘字
  const [affFloat, setAffFloat] = useState<{ key: number; delta: number } | null>(null);
  const affFloatAnim = useRef(new Animated.Value(0)).current;
  const affShake = useRef(new Animated.Value(0)).current;
  const affChipFlash = useRef(new Animated.Value(0)).current;
  const affFloatTimer = useRef<any>(null);

  const triggerAffectionFloat = (delta: number) => {
    setAffFloat({ key: Date.now(), delta });
    affFloatAnim.setValue(0);
    affShake.setValue(0);
    affChipFlash.setValue(0);
    Animated.timing(affFloatAnim, {
      toValue: 1, duration: 1500, easing: Easing.out(Easing.cubic), useNativeDriver: false,
    }).start();
    Animated.sequence([
      Animated.timing(affChipFlash, { toValue: 1, duration: 180, useNativeDriver: false }),
      Animated.timing(affChipFlash, { toValue: 0, duration: 600, useNativeDriver: false }),
    ]).start();
    if (delta < 0) {
      Animated.sequence([
        Animated.timing(affShake, { toValue: 1, duration: 50, useNativeDriver: false }),
        Animated.timing(affShake, { toValue: -1, duration: 50, useNativeDriver: false }),
        Animated.timing(affShake, { toValue: 1, duration: 50, useNativeDriver: false }),
        Animated.timing(affShake, { toValue: 0, duration: 50, useNativeDriver: false }),
      ]).start();
    }
    if (affFloatTimer.current) clearTimeout(affFloatTimer.current);
    affFloatTimer.current = setTimeout(() => setAffFloat(null), 1550);
  };
  const [autoMode, setAutoMode] = useState(false);
  const [semiAutoMode, setSemiAutoMode] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const semiAutoRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [avatarsOpen, setAvatarsOpen] = useState(false);
  const [proactiveBanner, setProactiveBanner] = useState<string | null>(null);
  const [imgPosting, setImgPosting] = useState(false);
  const [scenePending, setScenePending] = useState<number | null>(null);
  const [chatBg, setChatBg] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [collapseAction, setCollapseAction] = useState(false);
  const chatBgOpacity = useUi((u) => u.chatBgOpacity);
  const bubbleOpacity = useUi((u) => u.bubbleOpacity);
  const playingId = useTtsPlayingId();
  const userAvatar = useAuth((s) => s.avatarUrl);
  const insets = useSafeAreaInsets();
  const loadAvatars = useAvatars((s) => s.load);
  const setOneAvatar = useAvatars((s) => s.setOne);
  const pickAvatar = useAvatars((s) => s.pick);
  // 用 byChar 整个对象做依赖，确保 store 任何写入都触发重新挑选
  const byChar = useAvatars((s) => s.byChar);
  const charAvatars = character?.name ? byChar[character.name] : null;
  const lastAvatarRef = useRef<string | null>(null);
  const currentAvatar = useMemo(() => {
    if (!charAvatars) return lastAvatarRef.current;
    // 优先当前情绪 → neutral → 任意一张
    const next =
      (mood && mood !== "neutral" && charAvatars[mood]) ||
      charAvatars["neutral"] ||
      charAvatars[mood] ||
      Object.values(charAvatars)[0] ||
      null;
    if (next) lastAvatarRef.current = next;
    return next || lastAvatarRef.current;
  }, [charAvatars, mood]);
  const [incomingCall, setIncomingCall] = useState<IncomingCallData | null>(null);
  const listRef = useRef<FlatList<Msg>>(null);
  const autoLoopRef = useRef<any>(null);
  // 分页：是否还有更早消息、是否正在加载更早
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE = 30;

  const moodM = moodInfo(mood);

  // inverted 列表需要新→旧的数据顺序（messages 内部保持旧→新）
  const invertedData = useMemo(() => [...messages].reverse(), [messages]);

  // 规整后端消息：过滤系统/旁白、补全图片 URL、去掉用户图片占位标记
  const normalize = useCallback((raw: any[]): Msg[] =>
    (raw || [])
      .filter((m) => m.role !== "system" && !(m.content?.startsWith("（") && m.content?.endsWith("）")))
      .map((m: any) => {
        if (m.image_url && !m.image_url.startsWith("http")) m.image_url = `${baseUrl}${m.image_url}`;
        if (m.role === "user" && m.content === "[图片]") m.content = "";
        return m;
      }), []);

  const load = useCallback(async () => {
    try {
      const [page, char, sess, settings] = await Promise.all([
        api<any>("GET", `/sessions/${sid}/messages?limit=${PAGE}`).catch(() => null),
        api<CharacterInfo>("GET", "/character").catch(() => null),
        api<SessionMood>("GET", `/sessions/${sid}/mood`).catch(() => null),
        api<{ collapseAction: boolean }>("GET", "/settings").catch(() => null),
      ]);
      // 兼容两种返回：分页 { items, hasMore } 或旧版全量数组
      const rawItems = Array.isArray(page) ? page : (page?.items || []);
      const items = normalize(rawItems);
      setMessages(items);
      setHasMore(Array.isArray(page) ? false : !!page?.hasMore);
      // 取最近一条带图的消息作为背景
      const lastImg = [...items].reverse().find((m) => m.image_url);
      if (lastImg?.image_url) setChatBg(lastImg.image_url);
      if (char) setCharacter({ id: char.id, name: char.name, affection: (char as any).affection ?? 10 });
      if (sess) {
        setMood(sess.mood || "neutral");
        setAutoMode(!!sess.auto_mode);
      }
      if (settings) setCollapseAction(!!settings.collapseAction);
    } catch {} finally { setLoading(false); }
  }, [sid, normalize]);

  // 上滑加载更早消息（inverted 列表的 onEndReached）
  const loadOlder = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const oldest = messages[0];
    const beforeId = typeof oldest?.id === "number" ? oldest.id : 0;
    if (!beforeId) return;
    setLoadingMore(true);
    try {
      const page = await api<{ items: any[]; hasMore: boolean }>(
        "GET", `/sessions/${sid}/messages?limit=${PAGE}&before_id=${beforeId}`
      );
      const older = normalize(page?.items || []);
      if (older.length) setMessages((m) => [...older, ...m]);
      setHasMore(!!page?.hasMore);
    } catch {} finally { setLoadingMore(false); }
  }, [sid, messages, hasMore, loadingMore, normalize]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // 切角色时清除上一次缓存的头像引用，避免显示错位
    lastAvatarRef.current = null;
    if (character?.name) loadAvatars(character.name);
  }, [character?.name, loadAvatars]);
  useEffect(() => () => { stopTts(); if (autoLoopRef.current) clearTimeout(autoLoopRef.current); }, []);

  useWS(sid || null, {
    onMessage: (p) => {
      if (p.session_id && p.session_id !== sid) return;
      if (p.affection_update) {
        setCharacter((c) => {
          if (c) {
            const delta = (p.affection ?? 0) - (c.affection ?? 0);
            if (delta !== 0) triggerAffectionFloat(delta);
          }
          return c ? { ...c, affection: p.affection } : c;
        });
      }
      if (p.mood_update && p.mood) {
        setMood((cur) => {
          if (cur !== p.mood) triggerMoodFloat(p.mood);
          return p.mood;
        });
        if (p.avatar_url && character?.name) setOneAvatar(character.name, p.mood, p.avatar_url);
      }
      if (p.mood_avatar_update && p.mood && p.avatar_url && character?.name) {
        setOneAvatar(character.name, p.mood, p.avatar_url);
      }
      if (p.proactive && p.text) setProactiveBanner(p.text);
      if ((p.tts || p.tts_stream_end) && p.audio_url) {
        playTts(p.audio_url, p.msg_id);
        setMessages((m) => m.map((it) => it.id === p.msg_id ? { ...it, tts_audio_url: p.audio_url } : it));
      }
      if (p.image_ready && p.msg_id && p.url) {
        const fullUrl = p.url.startsWith("http") ? p.url : `${baseUrl}${p.url}`;
        setMessages((m) =>
          m.some((it) => it.id === p.msg_id)
            ? m.map((it) => it.id === p.msg_id ? { ...it, image_url: fullUrl } : it)
            : [...m, { id: p.msg_id, role: "assistant", content: "", image_url: fullUrl }]
        );
        setChatBg(fullUrl);
        setScenePending((cur) => (cur === p.msg_id ? null : cur));
        setTimeout(scrollEnd, 50);
      }
      if (p.image_failed && p.msg_id) {
        setScenePending((cur) => (cur === p.msg_id ? null : cur));
      }
      if (p.incoming_call) {
        const cname = p.char_name || character?.name;
        setIncomingCall({
          call_log_id: p.call_log_id,
          msg_id: p.msg_id,
          session_id: p.session_id,
          char_name: cname,
          char_avatar: cname ? pickAvatar(cname, "neutral") : null,
          script: p.script,
          audio_url: p.audio_url,
          tts_lang: p.tts_lang,
        });
      }
    },
  });

  // inverted 列表：底部 = 偏移 0，滚到最新消息
  const scrollEnd = () => listRef.current?.scrollToOffset({ offset: 0, animated: false });

  const sendText = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || sending) return;
    if (!textOverride) { setInput(""); Keyboard.dismiss(); }
    setSuggestions([]);
    const tempUser: Msg = { id: `tmp-u-${Date.now()}`, role: "user", content: text };
    const tempBot: Msg = { id: `tmp-a-${Date.now()}`, role: "assistant", content: "", pending: true };
    setMessages((m) => [...m, tempUser, tempBot]);
    setSending(true);
    setTyping(false);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => setTyping(true), 1500);
    // 用户发出后定位到底部看到自己的消息
    setTimeout(scrollEnd, 50);

    try {
      let acc = "";
      const handle = await streamChat(sid, text, (e) => {
        if (e.type === "text") {
          if (typingTimerRef.current) { clearTimeout(typingTimerRef.current); typingTimerRef.current = null; }
          if (typing) setTyping(false);
          acc += e.text;
          setMessages((m) => m.map((it) => it.id === tempBot.id ? { ...it, content: acc } : it));
          // inverted 列表流式增高时保持最新气泡贴底，避免被输入框遮住
          scrollEnd();
        } else if (e.type === "done") {
          setMessages((m) => m.map((it) =>
            it.id === tempUser.id ? { ...it, id: e.userMsgId } :
            it.id === tempBot.id ? { ...it, id: e.msgId ?? it.id, pending: false } :
            it
          ));
          handle.close();
          setSending(false);
          setTyping(false);
          if (typingTimerRef.current) { clearTimeout(typingTimerRef.current); typingTimerRef.current = null; }
          // 半自动：回复完成后拉取回复建议
          if (semiAutoRef.current) fetchSuggestions();
        } else if (e.type === "error") {
          handle.close();
          setSending(false);
          setTyping(false);
          if (typingTimerRef.current) { clearTimeout(typingTimerRef.current); typingTimerRef.current = null; }
          if (e.status === 402) {
            // 小鱼干不足：服务端未存任何消息，移除乐观插入的气泡并引导签到
            setMessages((m) => m.filter((it) => it.id !== tempUser.id && it.id !== tempBot.id));
            if (!textOverride) setInput(text);
            toast("小鱼干不足，去【我的】签到获取", "err");
          } else {
            setMessages((m) => m.map((it) => it.id === tempBot.id ? { ...it, content: `（出错：${e.message}）`, pending: false } : it));
          }
        }
      });
    } catch (err: any) {
      setMessages((m) => m.map((it) => it.id === tempBot.id ? { ...it, content: `（出错：${err.message}）`, pending: false } : it));
      setSending(false);
      setTyping(false);
      if (typingTimerRef.current) { clearTimeout(typingTimerRef.current); typingTimerRef.current = null; }
    }
  };

  const imgPostingRef = useRef(false);
  const pickImage = async () => {
    if (imgPostingRef.current) return;
    imgPostingRef.current = true;
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.85 });
    if (r.canceled || !r.assets?.[0]) {
      imgPostingRef.current = false;
      return;
    }
    const asset = r.assets[0];
    setImgPosting(true);
    // 先插占位气泡（参考网页：传输中…）
    const tempId = `tmp-img-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: "user", content: "图片传输中…", pending: true }]);
    setTimeout(scrollEnd, 50);
    try {
      // RN 下 fetch(localFileUri).blob() 不稳定，改用 FileSystem 读 base64 再转 blob
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: "base64" } as any);
      const ct = asset.mimeType || (asset.uri.endsWith(".png") ? "image/png" : "image/jpeg");
      // base64 → Uint8Array
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const token = await loadToken();
      const res = await fetch(`${baseUrl}/sessions/${sid}/image`, {
        method: "POST",
        headers: {
          "Content-Type": ct,
          ...clientHeaders(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: bytes,
      });
      const data = await res.json();
      console.log("[upload-image] resp=", JSON.stringify(data));
      if (!data.ok) throw new Error(data.error || "上传失败");
      if (!data.image_url) throw new Error("服务端未返回图片地址");
      const fullUrl = data.image_url.startsWith("http")
        ? data.image_url
        : `${baseUrl}${data.image_url}`;
      console.log("[upload-image] msg_id=", data.msg_id, "url=", fullUrl);
      // 占位气泡 in-place 替换为真实图片，避免重复
      setMessages((m) => {
        // 如果已经存在 data.msg_id（极端情况下可能重复），删掉旧的
        const filtered = m.filter((it) => it.id !== data.msg_id);
        return filtered.map((it) => it.id === tempId
          ? { id: data.msg_id, role: "user" as const, content: "", image_url: fullUrl, pending: false }
          : it);
      });
      setTimeout(scrollEnd, 50);
    } catch (err: any) {
      setMessages((m) => m.filter((it) => it.id !== tempId));
      toast(err.message || "发送失败", "err");
    } finally {
      setImgPosting(false);
      imgPostingRef.current = false;
    }
  };

  const triggerSceneImage = async () => {
    setMenuOpen(false);
    if (scenePending !== null) return;
    try {
      const r = await fetch(`${baseUrl}/sessions/${sid}/scene-image?aspect=9:16`, {
        method: "POST",
        headers: { ...(await authHeader()) },
      });
      const t = await r.text();
      let data: any = null;
      try { data = JSON.parse(t); } catch {}
      if (r.status === 402) { toast("小鱼干不足，去【我的】签到获取", "err"); return; }
      if (!r.ok) throw new Error(data?.error || t || `HTTP ${r.status}`);
      if (data?.msg_id) setScenePending(data.msg_id);
    } catch (e: any) {
      toast(e.message || "生成失败", "err");
    }
  };

  const ingestToMemory = async () => {
    setMenuOpen(false);
    if (ingesting || !sid) return;
    setIngesting(true);
    try {
      await api("POST", `/sessions/${sid}/ingest`);
      toast("已存入记忆库");
    } catch (e: any) {
      toast(e.message || "存入失败", "err");
    } finally { setIngesting(false); }
  };

  const toggleAuto = async () => {
    setMenuOpen(false);
    const next = !autoMode;
    setAutoMode(next);
    if (next) setSemiAutoMode(false);
    try {
      await api("PATCH", `/sessions/${sid}/settings`, { auto_mode: next ? 1 : 0 });
    } catch {}
    if (next) startAutoLoop();
    else if (autoLoopRef.current) { clearTimeout(autoLoopRef.current); autoLoopRef.current = null; }
  };

  const startAutoLoop = () => {
    const tick = async () => {
      try {
        const r = await api<{ ok: boolean; text?: string }>("POST", `/sessions/${sid}/auto-user-message`);
        if (r?.ok && r.text) await sendText(r.text);
      } catch {}
      autoLoopRef.current = setTimeout(tick, 8000);
    };
    autoLoopRef.current = setTimeout(tick, 1500);
  };

  const toggleSemiAuto = async () => {
    setMenuOpen(false);
    setSemiAutoMode((v) => {
      const next = !v;
      semiAutoRef.current = next;
      if (!next) setSuggestions([]);
      else fetchSuggestions();
      return next;
    });
  };

  const fetchSuggestions = async () => {
    try {
      const r = await api<{ suggestions: string[] }>("GET", `/sessions/${sid}/reply-suggestions`);
      if (semiAutoRef.current && r?.suggestions?.length) setSuggestions(r.suggestions);
    } catch {}
  };

  const onBubbleLongPress = (item: Msg) => {
    if (typeof item.id !== "number") return; // 临时气泡不处理
    const isAssistant = item.role === "assistant";
    const items: any[] = [];
    if (isAssistant) {
      items.push({ label: "重新生成", onPress: () => regenerate(item) });
      if (item.tts_audio_url) {
        items.push({
          label: "反馈", onPress: () => {
            actionSheet("您觉得该条语音体验是好还是坏？", [
              { label: "好", onPress: () => submitTtsFeedback(item, "good") },
              { label: "坏", onPress: () => submitTtsFeedback(item, "bad") },
            ]);
          },
        });
      }
      const faved = !!item.favorited;
      items.push({
        label: faved ? "取消收藏" : "收藏", onPress: async () => {
          try {
            await api(faved ? "DELETE" : "POST", `/messages/${item.id}/favorite`);
            hapticLight();
            setMessages((m) => m.map((it) => it.id === item.id ? { ...it, favorited: faved ? 0 : 1 } : it));
            toast(faved ? "已取消收藏" : "已收藏");
          } catch (e: any) { toast(e.message || "操作失败", "err"); }
        },
      });
    }
    items.push({
      label: "删除", destructive: true, onPress: async () => {
        try {
          await api("DELETE", `/messages/${item.id}/single`);
          hapticLight();
          setMessages((m) => m.filter((it) => it.id !== item.id));
        } catch (e: any) { toast(e.message || "删除失败", "err"); }
      },
    });
    actionSheet("操作", items);
  };

  const submitTtsFeedback = async (item: Msg, rating: "good" | "bad") => {
    if (typeof item.id !== "number") return;
    try {
      await api("POST", `/messages/${item.id}/tts-feedback`, { rating });
      hapticLight();
      toast("感谢您的反馈");
    } catch (e: any) {
      toast(e.message || "反馈失败", "err");
    }
  };

  const regenerate = async (item: Msg) => {
    if (typeof item.id !== "number") return;
    // 找到该 assistant 之前最近一条用户消息
    const idx = messages.findIndex((it) => it.id === item.id);
    let userText = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") { userText = messages[i].content; break; }
    }
    if (!userText) { toast("找不到对应的用户消息", "err"); return; }
    try {
      await api("DELETE", `/messages/${item.id}`); // 删除该条及之后所有
    } catch (e: any) { toast(e.message || "操作失败", "err"); return; }
    setMessages((m) => m.slice(0, idx)); // 同步前端列表去掉该条及之后
    sendText(userText);
  };

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <TtsPlayerHost />
      <IncomingCall
        visible={!!incomingCall}
        data={incomingCall}
        onClose={(answered) => {
          const c = incomingCall;
          setIncomingCall(null);
          // 通话结束后把电话内容插入当前会话末尾（参考网页：📞 [已接听/未接听] 文案）
          if (c && c.session_id === sid && c.script && c.msg_id != null) {
            const tag = answered ? "已接听" : "未接听";
            const content = `📞 [${tag}] ${c.script}`;
            setMessages((m) =>
              m.some((it) => it.id === c.msg_id)
                ? m.map((it) => it.id === c.msg_id ? { ...it, content } : it)
                : [...m, { id: c.msg_id!, role: "assistant", content, tts_audio_url: c.audio_url || null }]
            );
            setTimeout(scrollEnd, 50);
          }
        }}
      />
      <AvatarsModal
        visible={avatarsOpen}
        onClose={() => setAvatarsOpen(false)}
        onUpdated={(m, url) => character?.name && setOneAvatar(character.name, m, url)}
        currentMood={mood}
      />
      <SafeAreaView edges={["top"]} style={s.headerSafe}>
        <View style={s.header}>
          <Pressable onPress={() => router.back()} style={s.iconBtn}>
            <IconBack size={24} color="#fff" />
          </Pressable>
          <View style={s.headerCenter}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={s.charName} numberOfLines={1}>
                {character?.name || ""}
              </Text>
              <View style={s.moodDotWrap}>
                <Text style={[s.moodDot, { color: moodM.color }]}>  ●</Text>
                {moodFloat ? (
                  <Animated.Text
                    key={moodFloat.key}
                    numberOfLines={1}
                    pointerEvents="none"
                    style={[s.moodFloat, {
                      color: moodFloat.color,
                      fontSize: moodFloat.negative ? 14 : 12,
                      opacity: moodFloatAnim.interpolate({ inputRange: [0, 0.1, 0.85, 1], outputRange: [0, 1, 1, 0] }),
                      transform: [
                        { translateY: moodFloatAnim.interpolate({ inputRange: [0, 1], outputRange: [4, moodFloat.negative ? -42 : -28] }) },
                        { translateX: moodFloatShake.interpolate({ inputRange: [-1, 1], outputRange: [-4, 4] }) },
                        { scale: moodFloat.negative ? 1.1 : 1 },
                      ],
                    }]}
                  >
                    {moodFloat.label}
                  </Animated.Text>
                ) : null}
              </View>
            </View>
            <View style={s.heartWrap}>
              <Animated.View
                style={{
                  transform: [{ translateX: affShake.interpolate({ inputRange: [-1, 1], outputRange: [-3, 3] }) }],
                }}
              >
                <Animated.View
                  style={{
                    backgroundColor: affChipFlash.interpolate({
                      inputRange: [0, 1],
                      outputRange: ["#1c1c2a", affFloat && affFloat.delta < 0 ? "rgba(239,68,68,0.35)" : "rgba(244,114,182,0.35)"],
                    }),
                    borderRadius: 12,
                  }}
                >
                  <Pressable onPress={() => router.push("/character/affection")} style={s.heartChip}>
                    <IconHeart size={12} color="#f472b6" />
                    <Text style={s.affText}>{character?.affection ?? "—"}</Text>
                  </Pressable>
                </Animated.View>
              </Animated.View>
              {affFloat ? (
                <Animated.Text
                  key={affFloat.key}
                  pointerEvents="none"
                  numberOfLines={1}
                  style={[s.affFloat, {
                    color: affFloat.delta > 0 ? "#f472b6" : "#9ca3af",
                    opacity: affFloatAnim.interpolate({ inputRange: [0, 0.1, 0.85, 1], outputRange: [0, 1, 1, 0] }),
                    transform: [{
                      translateY: affFloatAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, affFloat.delta > 0 ? -22 : 18],
                      }),
                    }],
                  }]}
                >
                  {affFloat.delta > 0 ? `+${affFloat.delta}` : `${affFloat.delta}`}
                </Animated.Text>
              ) : null}
            </View>
            {typing ? <Text style={s.typingText}>正在输入中…</Text> : null}
          </View>
          <Pressable onPress={() => setMenuOpen(true)} style={s.iconBtn}>
            <IconMore size={20} color="#fff" />
          </Pressable>
        </View>
      </SafeAreaView>

      {(autoMode || semiAutoMode || scenePending !== null) && (
        <View style={s.modeBar}>
          {autoMode && <Text style={s.modeTag}>● 自动模式</Text>}
          {semiAutoMode && <Text style={s.modeTag}>◐ 半自动</Text>}
          {scenePending !== null && (
            <View style={s.sceneTag}>
              <ActivityIndicator size="small" color="#7e6fd0" />
              <Text style={s.modeTag}>正在生成场景插图…</Text>
            </View>
          )}
        </View>
      )}

      {proactiveBanner && (
        <Pressable style={s.proactive} onPress={() => setProactiveBanner(null)}>
          <Text style={s.proactiveText} numberOfLines={2}>{character?.name} 主动消息：{proactiveBanner}</Text>
        </Pressable>
      )}

      <View style={s.listWrap}>
        {chatBg ? (
          <Image source={{ uri: chatBg }} style={[s.bgImage, { opacity: chatBgOpacity }]} blurRadius={Math.max(0, 3 * (1 - chatBgOpacity))} resizeMode="cover" />
        ) : null}
        {chatBg ? <View style={[s.bgDim, { opacity: 1 - chatBgOpacity * 0.6 }]} pointerEvents="none" /> : null}
        <FlatList
          ref={listRef}
          data={invertedData}
          inverted
          keyExtractor={(it) => String(it.id)}
          contentContainerStyle={{ padding: 12 }}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.4}
          ListFooterComponent={loadingMore ? <ActivityIndicator color="#7e6fd0" style={{ marginVertical: 12 }} /> : null}
          renderItem={({ item }) => (
            <Bubble
              item={item}
              characterName={character?.name || ""}
              characterAvatar={item.role === "assistant" ? currentAvatar : null}
              userAvatar={item.role === "user" ? userAvatar : null}
              onPlay={(url) => playTts(url, item.id)}
              onLongPress={onBubbleLongPress}
              onTapImage={(url) => setLightboxUrl(url)}
              onAvatarPress={() => setAvatarsOpen(true)}
              onUserAvatarPress={() => router.push("/(tabs)/me")}
              collapseAction={collapseAction}
              bubbleOpacity={bubbleOpacity}
              isPlaying={playingId === item.id}
              moodColor={moodM.color}
            />
          )}
          style={{ flex: 1 }}
        />
      </View>

      {semiAutoMode && suggestions.length > 0 ? (
        <View style={s.suggestionBar}>
          {suggestions.map((sug, i) => (
            <Pressable key={i} style={s.suggestionChip} onPress={() => { setSuggestions([]); sendText(sug); }}>
              <Text style={s.suggestionText} numberOfLines={2}>{sug}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={[s.inputBar, { paddingBottom: 8 + insets.bottom }]}>
        <Pressable style={s.imgBtn} disabled={imgPosting} onPress={pickImage}>
          <IconImage size={20} color="#bbb" />
        </Pressable>
        <TextInput
          style={s.input}
          placeholder="说点什么"
          placeholderTextColor="#666"
          value={input}
          onChangeText={setInput}
          multiline
        />
        <Pressable style={[s.sendBtn, (!input.trim() || sending) && { opacity: 0.4 }]}
          onPress={() => sendText()} disabled={!input.trim() || sending}>
          {sending ? <ActivityIndicator color="#fff" /> : <IconSend size={18} color="#fff" />}
        </Pressable>
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={s.menuBg} onPress={() => setMenuOpen(false)}>
          <View style={[s.menu, { marginTop: insets.top + 18, marginRight: -2 }]}>
            <MenuItem
              icon={<IconScene size={16} color={scenePending !== null ? "#666" : "#fff"} />}
              label={scenePending !== null ? "生成中…" : "生成场景插图"}
              onPress={triggerSceneImage}
              disabled={scenePending !== null}
              activeColor={scenePending !== null ? "#666" : "#fff"}
            />
            <MenuItem
              icon={<IconAuto size={16} color={autoMode ? "#7e6fd0" : "#888"} />}
              label={autoMode ? "停止自动" : "自动模式"}
              onPress={toggleAuto}
              activeColor={autoMode ? "#7e6fd0" : "#fff"}
            />
            <MenuItem
              icon={<IconSemi size={16} color={semiAutoMode ? "#7e6fd0" : "#888"} />}
              label={semiAutoMode ? "关闭半自动" : "半自动模式"}
              onPress={toggleSemiAuto}
              activeColor={semiAutoMode ? "#7e6fd0" : "#fff"}
            />
            <MenuItem
              icon={<IconBookmark size={16} color={ingesting ? "#666" : "#fff"} />}
              label={ingesting ? "存入中…" : "存入记忆库"}
              onPress={ingestToMemory}
              disabled={ingesting}
              activeColor={ingesting ? "#666" : "#fff"}
            />
          </View>
        </Pressable>
      </Modal>

      <Modal visible={!!lightboxUrl} transparent animationType="fade" onRequestClose={() => setLightboxUrl(null)}>
        {lightboxUrl ? <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} /> : null}
      </Modal>
    </KeyboardAvoidingView>
  );
}

async function authHeader(): Promise<Record<string, string>> {
  const t = await loadToken();
  return { ...clientHeaders(), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const save = async () => {
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) { toast("需要相册权限", "err"); return; }
      const filename = `tornado-${Date.now()}.jpg`;
      const tmp = `${FileSystem.cacheDirectory}${filename}`;
      const res = await FileSystem.downloadAsync(url, tmp);
      await MediaLibrary.saveToLibraryAsync(res.uri);
      toast("已保存到相册");
    } catch (e: any) {
      toast(e.message || "保存失败", "err");
    }
  };
  return (
    <Pressable style={s.lightboxBg} onPress={onClose} onLongPress={() => {
      actionSheet("操作", [{ label: "保存到相册", onPress: save }]);
    }} delayLongPress={500}>
      <Image source={{ uri: url }} style={s.lightboxImg} resizeMode="contain" />
    </Pressable>
  );
}

function MenuItem({ icon, label, onPress, disabled, activeColor }: { icon: React.ReactNode; label: string; onPress: () => void; disabled?: boolean; activeColor?: string }) {
  return (
    <Pressable style={[s.menuItem, disabled && { opacity: 0.5 }]} disabled={disabled} onPress={onPress}>
      <View style={s.menuIcon}>{icon}</View>
      <Text style={[s.menuLabel, activeColor ? { color: activeColor } : null]}>{label}</Text>
    </Pressable>
  );
}

function BubbleImage({ url }: { url: string }) {
  const [ratio, setRatio] = useState<number>(1);
  useEffect(() => {
    let cancelled = false;
    Image.getSize(url, (w, h) => {
      if (!cancelled && w > 0 && h > 0) setRatio(w / h);
    }, () => {});
    return () => { cancelled = true; };
  }, [url]);
  return (
    <Image
      source={{ uri: url }}
      style={{ width: BUBBLE_IMG_W, height: BUBBLE_IMG_W / ratio, borderRadius: 8, marginBottom: 4 }}
      resizeMode="contain"
    />
  );
}

function Bubble({
  item, characterName, characterAvatar, userAvatar, onPlay, onLongPress, onTapImage, onAvatarPress, onUserAvatarPress, collapseAction, bubbleOpacity, isPlaying, moodColor,
}: {
  item: Msg; characterName: string; characterAvatar?: string | null; userAvatar?: string | null;
  onPlay: (url: string) => void;
  onLongPress: (item: Msg) => void;
  onTapImage: (url: string) => void;
  onAvatarPress?: () => void;
  onUserAvatarPress?: () => void;
  collapseAction: boolean;
  bubbleOpacity: number;
  isPlaying: boolean;
  moodColor?: string;
}) {
  const isUser = item.role === "user";
  const initial = isUser ? "我" : (characterName?.[0] || "?");
  const showAvatar = isUser ? !!userAvatar : !!characterAvatar;
  const avatarUri = isUser ? userAvatar : characterAvatar;
  const parts = useMemo(
    () => item.content ? renderBubbleParts(item.content, collapseAction) : [],
    [item.content, collapseAction]
  );
  const bubbleStyle = isUser ? s.bubbleUser : s.bubbleAssistant;
  const baseColor = isUser ? USER_BG : ASSIST_BG;
  // 把基础颜色叠上 bubbleOpacity（hex → rgba）
  const overrideBg = withOpacity(baseColor, bubbleOpacity);

  // 播放时：头像柔光 + 双层脉冲圈 + 气泡呼吸缩放
  const glow = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isPlaying) {
      glow.stopAnimation(); glow.setValue(0);
      ring.stopAnimation(); ring.setValue(0);
      return;
    }
    const breathe = Animated.loop(Animated.sequence([
      Animated.timing(glow, { toValue: 1, duration: 950, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      Animated.timing(glow, { toValue: 0, duration: 950, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
    ]));
    const pulse = Animated.loop(Animated.timing(ring, {
      toValue: 1, duration: 1600, easing: Easing.out(Easing.ease), useNativeDriver: false,
    }));
    breathe.start(); pulse.start();
    return () => { breathe.stop(); pulse.stop(); };
  }, [isPlaying, glow, ring]);

  // 头像光晕（呼吸）
  const haloRadius = glow.interpolate({ inputRange: [0, 1], outputRange: [6, 22] });
  const haloOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  // 头像外脉冲圈（向外扩散 + 淡出）
  const ringScale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
  const ringOpacity = ring.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.55, 0] });
  // 气泡呼吸缩放（更明显的呼吸感）
  const bubbleScale = glow.interpolate({ inputRange: [0, 1], outputRange: [1, 1.025] });
  const bubbleLift = glow.interpolate({ inputRange: [0, 1], outputRange: [0, -3] });

  const haloColor = isUser ? "#60a5fa" : (moodColor || "#f472b6");

  return (
    <View style={[s.row, isUser ? s.rowUser : s.rowAssistant]}>
      <Pressable
        style={s.avatarWrap}
        onPress={isUser ? onUserAvatarPress : onAvatarPress}
        disabled={isUser ? !onUserAvatarPress : !onAvatarPress}
      >
        {/* 头像图片：静态容器，永不随播放状态改变结构/层级，避免远程图被重载闪烁 */}
        <View style={[s.avatar, isUser && s.avatarUser]}>
          {showAvatar
            ? <Image source={{ uri: avatarUri! }} style={s.avatarImg} />
            : <Text style={s.avatarText}>{initial}</Text>}
        </View>
        {/* 播放高亮：绝对定位覆盖层，作为后置兄弟节点，不影响上面图片节点的索引 */}
        {isPlaying ? (
          <Animated.View
            pointerEvents="none"
            style={[
              s.avatarGlow,
              {
                borderColor: haloColor,
                shadowColor: haloColor,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: haloOpacity,
                shadowRadius: haloRadius,
                elevation: 10,
              },
            ]}
          />
        ) : null}
        {isPlaying ? (
          <Animated.View
            pointerEvents="none"
            style={[
              s.avatarRing,
              {
                borderColor: haloColor,
                opacity: ringOpacity,
                transform: [{ scale: ringScale }],
              },
            ]}
          />
        ) : null}
      </Pressable>
      <Animated.View style={[
        { maxWidth: "75%" },
        isPlaying ? { transform: [{ translateY: bubbleLift }, { scale: bubbleScale }] } : null,
      ]}>
        <Pressable
          onLongPress={() => onLongPress(item)}
          delayLongPress={350}
          style={[s.bubble, bubbleStyle, { backgroundColor: overrideBg }]}
        >
          {item.image_url ? (
            <Pressable
              onPress={() => onTapImage(item.image_url!)}
              onLongPress={() => onLongPress(item)}
              delayLongPress={350}
            >
              <BubbleImage url={item.image_url} />
            </Pressable>
          ) : null}
          {item.content || item.pending ? (
            <View style={!isUser && item.tts_audio_url ? { paddingRight: 26 } : null}>
              {parts.map((p) =>
                p.isAction ? (
                  <Text key={p.key} style={s.actionLine}>{p.text}</Text>
                ) : (
                  <Text key={p.key} style={s.speechLine}>{p.text.trim()}</Text>
                )
              )}
              {!parts.length && item.pending ? <Text style={s.speechLine}>…</Text> : null}
            </View>
          ) : null}
          {!isUser && item.tts_audio_url ? (
            <Pressable
              onPress={() => onPlay(item.tts_audio_url!)}
              onLongPress={() => onLongPress(item)}
              delayLongPress={350}
              style={s.ttsBtn}
            >
              {isPlaying ? <View style={s.ttsStopDot} /> : <IconPlay size={10} color="#fff" />}
            </Pressable>
          ) : null}
        </Pressable>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" },

  headerSafe: { backgroundColor: "#0f0f17" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 6, paddingHorizontal: 8,
    borderBottomWidth: 1, borderBottomColor: "#1c1c2a",
    backgroundColor: "#0f0f17",
    minHeight: 48,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerCenter: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  headerAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(126,111,208,0.18)", alignItems: "center", justifyContent: "center", overflow: "hidden", marginRight: 4 },
  headerAvatarImg: { width: "100%", height: "100%" },
  headerAvatarText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  charName: { color: "#fff", fontSize: 16, fontWeight: "600", maxWidth: 160, includeFontPadding: false as any, textAlignVertical: "center" },
  moodDot: { fontSize: 14 },
  moodDotWrap: { position: "relative", justifyContent: "center" },
  moodFloat: {
    position: "absolute", left: -20, top: 0, width: 80,
    fontSize: 12, fontWeight: "600", textAlign: "center",
  },
  typingText: { color: "#7e6fd0", fontSize: 12, fontStyle: "italic" },
  heartChip: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "transparent", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, alignSelf: "center" },
  heartWrap: { position: "relative" },
  affFloat: {
    position: "absolute", left: -8, right: -8, top: 4,
    fontSize: 13, fontWeight: "700", textAlign: "center",
  },
  affText: { color: "#fff", fontSize: 12, fontWeight: "600", lineHeight: 14 },

  modeBar: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 6, gap: 12, backgroundColor: "rgba(126,111,208,0.06)", alignItems: "center" },
  modeTag: { color: "#7e6fd0", fontSize: 12 },
  sceneTag: { flexDirection: "row", alignItems: "center", gap: 6 },

  listWrap: { flex: 1, position: "relative" },
  bgImage: { ...StyleSheet.absoluteFillObject },
  bgDim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(15,15,23,1)" },

  lightboxBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", alignItems: "center", justifyContent: "center" },
  lightboxImg: { width: "100%", height: "100%" },

  proactive: { backgroundColor: "#1c1c2a", margin: 8, padding: 10, borderRadius: 10, borderLeftWidth: 3, borderLeftColor: "#7e6fd0" },
  proactiveText: { color: "#ddd", fontSize: 13 },

  row: { flexDirection: "row", marginVertical: 8, gap: 8, alignItems: "flex-start" },
  rowUser: { flexDirection: "row-reverse" },
  rowAssistant: {},
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(126,111,208,0.18)", overflow: "hidden" },
  avatarImg: { width: "100%", height: "100%" },
  avatarUser: { backgroundColor: "#1e2a3a" },
  avatarText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  avatarWrap: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  avatarRing: { position: "absolute", width: 48, height: 48, borderRadius: 24, borderWidth: 2 },
  avatarGlow: { position: "absolute", width: 48, height: 48, borderRadius: 24, borderWidth: 1.5 },

  bubble: {
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 14, position: "relative",
  },
  bubbleAssistant: {
    backgroundColor: ASSIST_BG, borderColor: "#2a2a3a", borderWidth: 1,
    borderTopLeftRadius: 4,
  },
  bubbleUser: { backgroundColor: USER_BG, borderTopRightRadius: 4 },

  actionLine: {
    color: ACTION_COLOR, fontSize: 13, fontStyle: "italic",
    paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: "#5a5090",
    marginVertical: 3, lineHeight: 18,
  },
  speechLine: { color: "#fff", fontSize: 15, lineHeight: 22, marginVertical: 2 },

  ttsBtn: { position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" },
  ttsStopDot: { width: 7, height: 7, backgroundColor: "#fff", borderRadius: 1 },

  inputBar: {
    flexDirection: "row", alignItems: "flex-end",
    paddingHorizontal: 8, paddingTop: 8, gap: 8,
    borderTopWidth: 1, borderTopColor: "#1c1c2a", backgroundColor: "#0f0f17",
  },
  suggestionBar: {
    paddingHorizontal: 8, paddingTop: 8, gap: 6,
    backgroundColor: "#0f0f17",
  },
  suggestionChip: {
    backgroundColor: "#1c1c2a", borderWidth: 1, borderColor: "#3a3450",
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9,
  },
  suggestionText: { color: "#cfcfe0", fontSize: 14, lineHeight: 19 },
  imgBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: "#1c1c2a" },
  input: { flex: 1, backgroundColor: "#1c1c2a", color: "#fff", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, maxHeight: 120, minHeight: 40 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#7e6fd0", alignItems: "center", justifyContent: "center" },

  menuBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-start", alignItems: "flex-end" },
  menu: { backgroundColor: "#1c1c2a", borderRadius: 12, paddingVertical: 6, minWidth: 180, borderWidth: 1, borderColor: "#2a2a3a" },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  menuIcon: { width: 20, alignItems: "center" },
  menuLabel: { color: "#fff", fontSize: 14 },
});
