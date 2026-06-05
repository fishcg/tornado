import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "tornado.token";
let cachedToken: string | null = null;

export const baseUrl = (Constants.expoConfig?.extra?.apiBaseUrl as string) || "http://localhost:3011";

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
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export async function wsUrl(sessionId: number): Promise<string> {
  const token = (await loadToken()) || "";
  const u = new URL(baseUrl);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/ws?sessionId=${sessionId}&token=${encodeURIComponent(token)}`;
}
