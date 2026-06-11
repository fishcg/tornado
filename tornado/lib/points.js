// 小鱼干（积分）系统：余额原子读写、流水、签到 streak、配置读取、总开关
import { getDb } from "../db.js";
import { dbGet, dbAll, dbRun } from "./dbutil.js";
import { getGlobalSetting } from "./settings.js";

const nowIso = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);
const ydayStr = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

// 后台可配置项的默认值（占位，上线前可在 admin 调整）
export const POINT_DEFAULTS = {
  points_enabled: "1",
  cost_chat: "1",
  cost_chat_voice: "3",
  cost_image: "5",
  cost_avatar: "3",
  cost_create_character: "20",
  signup_bonus: "100",
  checkin_base: "10",
  checkin_streak_bonus: "2",
  checkin_streak_cap: "7",
};

export async function getConfig(key) {
  const v = await getGlobalSetting(key, POINT_DEFAULTS[key] ?? "0");
  return Number(v) || 0;
}

// 总开关：关 → 全系统旁路（不扣不限）
export async function isEnabled() {
  return (await getGlobalSetting("points_enabled", POINT_DEFAULTS.points_enabled)) !== "0";
}

// 读取全部配置（admin 用）
export async function getAllConfig() {
  const out = {};
  for (const key of Object.keys(POINT_DEFAULTS)) {
    out[key] = await getGlobalSetting(key, POINT_DEFAULTS[key]);
  }
  return out;
}

// 确保用户有积分账户；首次创建时发放 signup_bonus 并写一条流水（幂等）
export async function ensureAccount(userId) {
  if (!userId) return;
  const bonus = await getConfig("signup_bonus");
  const result = await dbRun(
    "INSERT IGNORE INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?)",
    [userId, bonus, nowIso()]
  );
  if (result.affectedRows === 1 && bonus > 0) {
    await dbRun(
      "INSERT INTO point_transactions (user_id, delta, balance_after, reason, ref, created_at) VALUES (?, ?, ?, 'signup', NULL, ?)",
      [userId, bonus, bonus, nowIso()]
    );
  }
}

export async function getBalance(userId) {
  await ensureAccount(userId);
  const row = await dbGet("SELECT balance FROM user_points WHERE user_id = ?", [userId]);
  return row?.balance ?? 0;
}

// 原子扣费 + 写流水。余额不足返回 { ok:false }。总开关关时旁路（ok:true, bypassed:true）。
export async function spend(userId, cost, reason, ref = null) {
  if (!(await isEnabled())) return { ok: true, bypassed: true };
  cost = Math.max(0, Math.floor(Number(cost) || 0));
  await ensureAccount(userId);
  if (cost === 0) return { ok: true, balance: await getBalance(userId) };
  const conn = await getDb().getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute(
      "UPDATE user_points SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND balance >= ?",
      [cost, nowIso(), userId, cost]
    );
    if (r.affectedRows === 0) {
      await conn.rollback();
      const row = await dbGet("SELECT balance FROM user_points WHERE user_id = ?", [userId]);
      return { ok: false, balance: row?.balance ?? 0, need: cost };
    }
    const [rows] = await conn.execute("SELECT balance FROM user_points WHERE user_id = ?", [userId]);
    const balanceAfter = rows[0].balance;
    await conn.execute(
      "INSERT INTO point_transactions (user_id, delta, balance_after, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, -cost, balanceAfter, reason, ref, nowIso()]
    );
    await conn.commit();
    return { ok: true, balance: balanceAfter };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

// 原子加积分 + 写流水。返回变动后余额。
export async function grant(userId, amount, reason, ref = null) {
  amount = Math.floor(Number(amount) || 0);
  await ensureAccount(userId);
  if (amount === 0) return await getBalance(userId);
  const conn = await getDb().getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      "UPDATE user_points SET balance = balance + ?, updated_at = ? WHERE user_id = ?",
      [amount, nowIso(), userId]
    );
    const [rows] = await conn.execute("SELECT balance FROM user_points WHERE user_id = ?", [userId]);
    const balanceAfter = rows[0].balance;
    await conn.execute(
      "INSERT INTO point_transactions (user_id, delta, balance_after, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, amount, balanceAfter, reason, ref, nowIso()]
    );
    await conn.commit();
    return balanceAfter;
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

// 退款（异步生成失败用）。按 (reason, ref) 幂等，避免重复退。
export async function refund(userId, amount, reason, ref = null) {
  if (!(await isEnabled())) return;
  if (ref) {
    const existing = await dbGet(
      "SELECT id FROM point_transactions WHERE user_id = ? AND reason = ? AND ref = ?",
      [userId, reason, ref]
    );
    if (existing) return; // 已退过
  }
  await grant(userId, amount, reason, ref);
}

// __APPEND_MARKER__

// 计算签到当次奖励：基础分 + min(streak-1, cap) × streak_bonus
async function computeCheckinReward(streak) {
  const base = await getConfig("checkin_base");
  const bonusPer = await getConfig("checkin_streak_bonus");
  const cap = await getConfig("checkin_streak_cap");
  const extraDays = Math.min(Math.max(0, streak - 1), Math.max(0, cap));
  return base + extraDays * bonusPer;
}

// 读取签到状态：今天是否已签、连续天数、今日预计奖励
export async function getCheckinStatus(userId) {
  await dbRun("INSERT IGNORE INTO user_settings (user_id) VALUES (?)", [userId]);
  const row = await dbGet(
    "SELECT last_checkin_date, checkin_streak FROM user_settings WHERE user_id = ?",
    [userId]
  );
  const today = todayStr();
  const lastDate = row?.last_checkin_date || null;
  const curStreak = row?.checkin_streak || 0;
  const checkedToday = lastDate === today;
  // 若今天已签，则当前连续天数即 curStreak；否则下一次签到会形成的 streak
  let nextStreak;
  if (checkedToday) {
    nextStreak = curStreak;
  } else if (lastDate === ydayStr()) {
    nextStreak = curStreak + 1;
  } else {
    nextStreak = 1;
  }
  const streak = checkedToday ? curStreak : (curStreak && lastDate === ydayStr() ? curStreak : 0);
  const reward = await computeCheckinReward(nextStreak);
  return {
    checked_today: checkedToday,
    streak,
    today_reward_preview: reward,
  };
}

// 执行签到。已签到当天返回 { ok:false, reason:"already" }。
export async function checkin(userId) {
  await dbRun("INSERT IGNORE INTO user_settings (user_id) VALUES (?)", [userId]);
  const row = await dbGet(
    "SELECT last_checkin_date, checkin_streak FROM user_settings WHERE user_id = ?",
    [userId]
  );
  const today = todayStr();
  if (row?.last_checkin_date === today) {
    return { ok: false, reason: "already" };
  }
  const newStreak = row?.last_checkin_date === ydayStr() ? (row.checkin_streak || 0) + 1 : 1;
  const reward = await computeCheckinReward(newStreak);
  // 幂等保护：唯一键 (user_id, checkin_date) 防止并发重复签到
  try {
    await dbRun(
      "INSERT INTO daily_checkins (user_id, checkin_date, points, streak, created_at) VALUES (?, ?, ?, ?, ?)",
      [userId, today, reward, newStreak, nowIso()]
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return { ok: false, reason: "already" };
    throw e;
  }
  await dbRun(
    "UPDATE user_settings SET last_checkin_date = ?, checkin_streak = ? WHERE user_id = ?",
    [today, newStreak, userId]
  );
  const balance = await grant(userId, reward, "checkin", today);
  return { ok: true, points: reward, streak: newStreak, balance };
}

export async function listCheckins(userId, limit = 30) {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 30)));
  return await dbAll(
    `SELECT checkin_date, points, streak, created_at FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT ${n}`,
    [userId]
  );
}

// 按自然月查询签到记录。month 形如 "YYYY-MM"，非法则返回 null（调用方回退默认行为）。
export async function listCheckinsByMonth(userId, month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) return null;
  return await dbAll(
    "SELECT checkin_date, points, streak, created_at FROM daily_checkins WHERE user_id = ? AND checkin_date LIKE ? ORDER BY checkin_date ASC",
    [userId, `${month}-%`]
  );
}

export async function listTransactions(userId, limit = 50) {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  return await dbAll(
    `SELECT delta, balance_after, reason, ref, created_at FROM point_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ${n}`,
    [userId]
  );
}

