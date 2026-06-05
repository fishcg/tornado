import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const TOKEN_KEY = "tornado.token";
let cachedToken: string | null = null;

export const baseUrl = (Constants.expoConfig?.extra?.apiBaseUrl as string) || "http://localhost:3011";

// 客户端版本号（语义化，来自 app.json 的 expo.version）
export const appVersion = (Constants.expoConfig?.version as string) || "0.0.0";

// 语义化版本比较：a<b 返回 -1，a==b 返回 0，a>b 返回 1
export function compareVersions(a: string, b: string): number {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// 形如 "tornadoApp/0.1.0 (android 14)"，供服务端版本中间件解析
export const clientUserAgent = `tornadoApp/${appVersion} (${Platform.OS} ${String(Platform.Version ?? "")})`.trim();

// 统一的客户端识别头：UA + 兜底头（部分平台 fetch 会覆盖 UA）
export function clientHeaders(): Record<string, string> {
  return {
    "User-Agent": clientUserAgent,
    "X-Client-Version": appVersion,
    "X-Client-OS": `${Platform.OS} ${String(Platform.Version ?? "")}`.trim(),
  };
}

// 版本过低（426）时由各请求层调用，弹出强制更新
let versionBlockHandler: ((info: any) => void) | null = null;
export function setVersionBlockHandler(fn: (info: any) => void) { versionBlockHandler = fn; }
export function notifyVersionBlocked(info: any) { versionBlockHandler?.(info); }


export async function loadToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await SecureStore.getItemAsync(TOKEN_KEY);
  return cachedToken;
}

export async function saveToken(token: string) {
  cachedToken = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken() {
  cachedToken = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, data: any) {
    super(typeof data?.error === "string" ? data.error : `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const token = await loadToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...clientHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status === 426) { notifyVersionBlocked(data); throw new ApiError(426, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export async function wsUrl(sessionId: number): Promise<string> {
  const token = (await loadToken()) || "";
  const u = new URL(baseUrl);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/ws?sessionId=${sessionId}&token=${encodeURIComponent(token)}`;
}
