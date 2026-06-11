import EventSource from "react-native-sse";
import { baseUrl, clientHeaders, loadToken } from "@/api/client";

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; msgId: number | null; userMsgId: number }
  | { type: "error"; message: string; status?: number };

export type ChatStreamHandle = { close: () => void };

export async function streamChat(
  sessionId: number,
  message: string,
  onEvent: (e: ChatStreamEvent) => void
): Promise<ChatStreamHandle> {
  const token = await loadToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...clientHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const es = new EventSource(`${baseUrl}/sessions/${sessionId}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message }),
    pollingInterval: 0,
  });

  es.addEventListener("message", (e: any) => {
    if (!e.data) return;
    try {
      const payload = JSON.parse(e.data);
      if (payload.error) onEvent({ type: "error", message: String(payload.error) });
      else if (payload.done) onEvent({ type: "done", msgId: payload.msg_id ?? null, userMsgId: payload.user_msg_id });
      else if (payload.text) onEvent({ type: "text", text: String(payload.text) });
    } catch {}
  });

  es.addEventListener("error", (e: any) => {
    const status = e?.xhrStatus ?? e?.status;
    let message = e?.message || "stream error";
    // 非 200（如 402 小鱼干不足）时尝试解析响应体里的 error
    if (e?.xhrBody) {
      try {
        const body = JSON.parse(e.xhrBody);
        if (body?.error) message = String(body.error);
      } catch {}
    }
    onEvent({ type: "error", message, status });
    es.close();
  });

  return { close: () => es.close() };
}
