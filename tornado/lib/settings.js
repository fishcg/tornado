// 全局设置（global_settings 键值表）
import { dbGet, dbRun } from "./dbutil.js";

export async function getGlobalSetting(key, defaultValue = null) {
  const row = await dbGet("SELECT value FROM global_settings WHERE `key` = ?", [key]);
  return row ? row.value : defaultValue;
}

export async function setGlobalSetting(key, value) {
  await dbRun("INSERT INTO global_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=?", [key, String(value), String(value)]);
}
