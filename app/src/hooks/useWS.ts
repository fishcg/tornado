import { useEffect, useRef } from "react";
import { wsUrl } from "@/api/client";

export type WSPayload = Record<string, any>;

type Options = {
  onMessage: (payload: WSPayload) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export function useWS(sessionId: number | null, opts: Options) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(opts);
  handlersRef.current = opts;

  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    let retry = 0;
    let timer: any = null;

    const connect = async () => {
      if (stopped) return;
      try {
        const url = await wsUrl(sessionId);
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => { retry = 0; handlersRef.current.onOpen?.(); };
        ws.onmessage = (e) => {
          try { handlersRef.current.onMessage(JSON.parse(e.data)); } catch {}
        };
        ws.onclose = () => {
          handlersRef.current.onClose?.();
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
  }, [sessionId]);
}
