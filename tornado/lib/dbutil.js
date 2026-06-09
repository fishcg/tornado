// MySQL 查询辅助：基于 db.js 的连接池
import { getDb } from "../db.js";

export async function dbGet(sql, params = []) {
  const [rows] = await getDb().execute(sql, params);
  return rows[0] ?? null;
}

export async function dbAll(sql, params = []) {
  const [rows] = await getDb().execute(sql, params);
  return rows;
}

export async function dbRun(sql, params = []) {
  const [result] = await getDb().execute(sql, params);
  return result;
}
