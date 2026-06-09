// 鉴权：会话 token、密码哈希、requireAuth/requireAdmin
import crypto from "node:crypto";
import { PASSWORD_SALT } from "./config.js";
import { dbGet, dbRun } from "./dbutil.js";
import { send } from "./http.js";

const authSessions = new Map(); // sid -> { userId, username }  内存缓存

export function hashPassword(password) {
  return crypto.createHash("sha256").update(password + PASSWORD_SALT).digest("hex");
}

export async function loadAuthSession(sid) {
  if (!sid) return null;
  const cached = authSessions.get(sid);
  if (cached) return cached;
  const row = await dbGet("SELECT user_id, username FROM auth_sessions WHERE sid = ?", [sid]);
  if (!row) return null;
  const sess = { userId: row.user_id, username: row.username };
  authSessions.set(sid, sess);
  return sess;
}

export async function createAuthSession(userId, username) {
  const sid = crypto.randomBytes(32).toString("hex");
  const sess = { userId, username };
  authSessions.set(sid, sess);
  await dbRun("INSERT INTO auth_sessions (sid, user_id, username, created_at) VALUES (?, ?, ?, ?)",
    [sid, userId, username, new Date().toISOString()]);
  return sid;
}

export async function deleteAuthSession(sid) {
  if (!sid) return;
  authSessions.delete(sid);
  await dbRun("DELETE FROM auth_sessions WHERE sid = ?", [sid]);
}

export async function getAuthSession(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth) {
    const m = auth.match(/^Bearer\s+([A-Za-z0-9]+)$/i);
    if (m) {
      const sess = await loadAuthSession(m[1]);
      if (sess) return sess;
    }
  }
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!match) return null;
  return await loadAuthSession(match[1]);
}

export async function requireAuth(req, res) {
  const session = await getAuthSession(req);
  if (!session) { send(res, 401, { error: "unauthorized" }); return null; }
  return session;
}

export async function requireAdmin(req, res) {
  const session = await getAuthSession(req);
  if (!session) { send(res, 401, { error: "unauthorized" }); return null; }
  const user = await dbGet("SELECT is_admin FROM users WHERE id = ?", [session.userId]);
  if (!user?.is_admin) { send(res, 403, { error: "forbidden" }); return null; }
  return session;
}
