import { useEffect, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import { useRouter, useSegments } from "expo-router";
import { useAuth } from "@/store/auth";
import { wsUrl } from "@/api/client";
import { showIncomingCallNotification, showChatNotification } from "@/notify";
import { showAchievement } from "@/components/AchievementHost";
import { showMilestone } from "@/components/MilestoneHost";

// 全局 WS：用 sessionId=0 表示「全用户级监听」，在 App 任何位置都能收到来电 / 新消息
// 用于本地通知（前台不弹、后台/锁屏弹）
export function useGlobalNotifier() {
  const signedIn = useAuth((s) => s.signedIn);
  const segments = useSegments();
  const router = useRouter();

  const wsRef = useRef<WebSocket | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  // 是否在某个会话的聊天页
  const inChatRef = useRef<{ active: boolean; sid: number | null }>({ active: false, sid: null });

  // 跟踪当前是否在聊天页 + 在哪个会话
  useEffect(() => {
    const inChat = segments[0] === "chat";
    const sidFromRoute = inChat
      ? Number((segments[1] as any) || 0) || null
      : null;
    inChatRef.current = { active: inChat, sid: sidFromRoute };
  }, [segments]);

  // 跟踪前后台
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      appStateRef.current = st;
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let stopped = false;
    let retry = 0;
    let timer: any = null;

    const connect = async () => {
      if (stopped) return;
      try {
        const url = await wsUrl(0);
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => { retry = 0; };
        ws.onmessage = (e) => {
          let p: any;
          try { p = JSON.parse(e.data); } catch { return; }

          // 当前 App 在前台 + 在对应会话的聊天页 → 不发系统通知（聊天页内部已处理）
          const inForeground = appStateRef.current === "active";
          const onSameChat = inChatRef.current.active && inChatRef.current.sid === p.session_id;

          if (p.incoming_call) {
            if (!inForeground || !onSameChat) {
              showIncomingCallNotification({
                charName: p.char_name,
                script: p.script,
                sessionId: p.session_id,
              });
            }
          }
          // 主动消息（角色主动发的新回复）
          if (p.proactive && p.text) {
            if (!inForeground || !onSameChat) {
              showChatNotification({
                charName: p.char_name,
                text: p.text,
                sessionId: p.session_id,
              });
            }
          }
          // 成就解锁：无论在哪都弹（前台直接全屏 modal）
          if (p.achievement_unlock) {
            showAchievement({
              achievement: p.achievement,
              selfie_url: p.selfie_url,
              inner_voice: p.inner_voice,
              ua_id: p.ua_id,
            });
          }
          // 关系里程碑解锁：弹漫画 / 视频 modal
          if (p.relation_milestone) {
            showMilestone({
              milestone_id: p.milestone_id,
              stage: p.stage,
              stage_name: p.stage_name,
              affection: p.affection,
              comic_url_1: p.comic_url_1,
              comic_url_2: p.comic_url_2,
              video_url: p.video_url,
            });
          }
        };
        ws.onclose = () => {
          if (stopped) return;
          retry = Math.min(retry + 1, 6);
          timer = setTimeout(connect, 500 * 2 ** retry);
        };
        ws.onerror = () => { try { ws.close(); } catch {} };
      } catch {
        if (!stopped) timer = setTimeout(connect, 2000);
      }
    };

    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
  }, [signedIn]);
}
