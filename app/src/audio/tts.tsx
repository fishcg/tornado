import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { AudioPlayer } from "expo-audio";
import { useEffect, useState } from "react";

type Subscriber = (msgId: number | string | null) => void;

const subscribers = new Set<Subscriber>();
let currentPlayer: AudioPlayer | null = null;
let lastMsgId: number | string | null = null;
let modeConfigured = false;

async function ensureMode() {
  if (modeConfigured) return;
  modeConfigured = true;
  try {
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch (e) {
    console.warn("[tts] setAudioMode 失败", e);
  }
}

function destroyCurrent() {
  if (currentPlayer) {
    try { currentPlayer.pause(); } catch {}
    try { currentPlayer.remove(); } catch {}
    currentPlayer = null;
  }
}

export async function playTts(audioUrl: string, msgId: number | string) {
  if (!audioUrl) return;
  // 同一条消息再次点击 → 视为停止
  if (currentPlayer && lastMsgId === msgId) {
    await stopTts();
    return;
  }
  destroyCurrent();
  await ensureMode();
  console.log("[tts] play", msgId, audioUrl);
  lastMsgId = msgId;
  subscribers.forEach((fn) => fn(msgId));
  try {
    const p = createAudioPlayer({ uri: audioUrl });
    currentPlayer = p;
    p.play();
    console.log("[tts] play() called");
    p.addListener("playbackStatusUpdate", (status: any) => {
      if (status.didJustFinish || status.isPlaybackFinished) {
        if (currentPlayer === p) {
          destroyCurrent();
          lastMsgId = null;
          subscribers.forEach((fn) => fn(null));
        }
      }
    });
  } catch (e) {
    console.warn("[tts] 播放失败", e);
    lastMsgId = null;
    subscribers.forEach((fn) => fn(null));
  }
}

export async function stopTts() {
  destroyCurrent();
  lastMsgId = null;
  subscribers.forEach((fn) => fn(null));
}

export function getPlayingMsgId() { return lastMsgId; }

/** 挂在使用 playTts 的页面，订阅播放状态（用于更新 UI）。 */
export function TtsPlayerHost() {
  useTtsPlayingId(); // 仅为了让 host 存在；订阅入口在外部
  return null;
}

/** 订阅当前正在播放的 msgId（null = 没在播）。 */
export function useTtsPlayingId() {
  const [id, setId] = useState<number | string | null>(lastMsgId);
  useEffect(() => {
    const handler: Subscriber = (mid) => setId(mid);
    subscribers.add(handler);
    return () => { subscribers.delete(handler); };
  }, []);
  return id;
}
