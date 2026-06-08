import mysql from "mysql2/promise";

const MYSQL_HOST = process.env.MYSQL_HOST || "localhost";
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_USER || "root";
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || "";
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || "tornado";

let _pool = null;

export function getDb() {
  if (!_pool) {
    _pool = mysql.createPool({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      charset: "utf8mb4"
    });
  }
  return _pool;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

async function ensureColumn(pool, table, column, definition) {
  const [rows] = await pool.execute(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
    [table, column]
  );
  if (!rows.length) {
    await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

// 删除已废弃的列（若存在）
async function dropColumn(pool, table, column) {
  const [rows] = await pool.execute(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
    [table, column]
  );
  if (rows.length) {
    await pool.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
  }
}

// 修复 mood_avatars 老表的主键：原 PK (character, mood) 不含 user_id，会被多用户互覆盖
async function fixMoodAvatarsKey(pool) {
  try {
    const [pkRows] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mood_avatars' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX"
    );
    const pkCols = pkRows.map((r) => r.COLUMN_NAME);
    // 老主键：character + mood（无 id、无 user_id）
    const isLegacy = pkCols.length === 2 && pkCols.includes("character") && pkCols.includes("mood");
    if (!isLegacy) return;
    console.log("[db] 升级 mood_avatars 主键以支持多用户隔离…");
    // 1. 加 id 列（先不设主键）
    const [idCol] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mood_avatars' AND COLUMN_NAME='id'"
    );
    if (!idCol.length) {
      await pool.execute("ALTER TABLE `mood_avatars` ADD COLUMN id INT");
    }
    // 2. 删除老主键
    await pool.execute("ALTER TABLE `mood_avatars` DROP PRIMARY KEY");
    // 3. id 设为自增 + 主键
    await pool.execute("ALTER TABLE `mood_avatars` MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT PRIMARY KEY");
    // 4. 加唯一索引（character + mood + user_id）
    const [uniqRows] = await pool.execute(
      "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mood_avatars' AND INDEX_NAME='uniq_char_mood_user'"
    );
    if (!uniqRows.length) {
      await pool.execute(
        "ALTER TABLE `mood_avatars` ADD UNIQUE KEY uniq_char_mood_user (`character`(191), mood, user_id)"
      );
    }
    console.log("[db] mood_avatars 主键升级完成");
  } catch (e) {
    console.warn("[db] mood_avatars 主键升级失败（可忽略，下次启动重试）:", e.message);
  }
}

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL DEFAULT '新对话',
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    mood VARCHAR(32) NOT NULL DEFAULT 'neutral',
    topic_summary TEXT,
    last_user_at VARCHAR(64),
    dnd_start VARCHAR(8),
    dnd_end VARCHAR(8),
    proactive_idle_minutes INT,
    archived INT NOT NULL DEFAULT 0,
    auto_mode INT NOT NULL DEFAULT 0,
    user_id INT,
    KEY idx_sessions_user_archived_updated (user_id, archived, updated_at),
    KEY idx_sessions_last_user_at (last_user_at)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS messages (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    role VARCHAR(16) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    image_url TEXT,
    image_prompt TEXT,
    character_name VARCHAR(255),
    created_at VARCHAR(64) NOT NULL,
    user_id INT,
    KEY idx_messages_session_role (session_id, role),
    KEY idx_messages_session_image_prompt (session_id, image_prompt(64)),
    KEY idx_messages_character_name (character_name),
    KEY idx_messages_image_url (image_url(64)),
    KEY idx_messages_user_id (user_id)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mood_avatars (
    id INT AUTO_INCREMENT PRIMARY KEY,
    \`character\` VARCHAR(255) NOT NULL DEFAULT '',
    mood VARCHAR(32) NOT NULL,
    image_url TEXT NOT NULL,
    appearance_hash VARCHAR(64) NOT NULL DEFAULT '',
    created_at VARCHAR(64) NOT NULL,
    user_id INT,
    UNIQUE KEY uniq_char_mood_user (\`character\`(191), mood, user_id),
    KEY idx_mood_avatars_character_user (\`character\`(191), user_id),
    KEY idx_mood_avatars_character_hash (\`character\`(191), appearance_hash)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS character_cards (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`character\` VARCHAR(255) NOT NULL,
    image_url TEXT NOT NULL,
    is_active INT NOT NULL DEFAULT 0,
    created_at VARCHAR(64) NOT NULL,
    user_id INT,
    KEY idx_character_cards_char_user_active (\`character\`, user_id, is_active)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS characters (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    appearance TEXT,
    personality TEXT,
    description TEXT,
    soul_content MEDIUMTEXT,
    slideshow_enabled INT NOT NULL DEFAULT 0,
    slideshow_interval INT NOT NULL DEFAULT 30,
    is_active INT NOT NULL DEFAULT 0,
    affection INT NOT NULL DEFAULT 10,
    created_at VARCHAR(64) NOT NULL,
    user_id INT,
    UNIQUE KEY uq_name_user (name, user_id),
    KEY idx_characters_user_active (user_id, is_active)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS affection_log (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    character_id INT NOT NULL,
    delta INT NOT NULL,
    value INT NOT NULL,
    mood VARCHAR(32),
    reason TEXT,
    created_at VARCHAR(64) NOT NULL,
    KEY idx_affection_log_character_id (character_id)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS users (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(128) NOT NULL,
    is_admin INT NOT NULL DEFAULT 0,
    created_at VARCHAR(64) NOT NULL
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS invite_codes (
    code VARCHAR(128) NOT NULL PRIMARY KEY,
    created_at VARCHAR(64) NOT NULL
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS user_settings (
    user_id INT NOT NULL PRIMARY KEY,
    image_fallback_enabled INT NOT NULL DEFAULT 1,
    chat_image_enabled INT NOT NULL DEFAULT 1,
    affection_interval INT NOT NULL DEFAULT 3,
    image_auto_expand INT NOT NULL DEFAULT 0
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS announcements (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS announcement_reads (
    user_id INT NOT NULL,
    announcement_id INT NOT NULL,
    PRIMARY KEY (user_id, announcement_id),
    KEY idx_announcement_reads_ann_id (announcement_id)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS app_versions (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    platform VARCHAR(16) NOT NULL DEFAULT 'android',
    version_name VARCHAR(32) NOT NULL,
    release_notes TEXT,
    download_url TEXT NOT NULL,
    file_size BIGINT,
    force_update INT NOT NULL DEFAULT 0,
    enabled INT NOT NULL DEFAULT 1,
    created_at VARCHAR(64) NOT NULL,
    KEY idx_app_versions_platform_enabled (platform, enabled)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS global_settings (
    \`key\` VARCHAR(128) NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS achievements (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(32) NOT NULL,
    threshold INT NOT NULL,
    name VARCHAR(128) NOT NULL,
    enabled INT NOT NULL DEFAULT 1,
    created_at VARCHAR(64) NOT NULL
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS user_achievements (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    achievement_id INT NOT NULL,
    character_id INT NOT NULL,
    selfie_url TEXT,
    inner_voice TEXT,
    unlocked_at VARCHAR(64) NOT NULL,
    notified INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_user_achievement (user_id, achievement_id, character_id),
    KEY idx_user_achievements_user (user_id)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS relationship_milestones (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    character_id INT NOT NULL,
    stage INT NOT NULL,
    stage_name VARCHAR(32) NOT NULL,
    affection INT NOT NULL,
    comic_url_1 TEXT,
    comic_url_2 TEXT,
    notified INT NOT NULL DEFAULT 0,
    created_at VARCHAR(64) NOT NULL,
    UNIQUE KEY uq_user_char_stage (user_id, character_id, stage),
    KEY idx_rm_user (user_id)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS call_logs (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    session_id INT NOT NULL,
    char_name VARCHAR(255) NOT NULL,
    script TEXT,
    audio_url TEXT,
    answered INT NOT NULL DEFAULT 0,
    created_at VARCHAR(64) NOT NULL,
    KEY idx_call_logs_user (user_id)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS character_diaries (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    character_id INT NOT NULL,
    session_id INT NOT NULL,
    content TEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    KEY idx_diaries_user_char (user_id, character_id)
  ) CHARACTER SET utf8mb4`,

  `CREATE TABLE IF NOT EXISTS auth_sessions (
    sid VARCHAR(128) NOT NULL PRIMARY KEY,
    user_id INT NOT NULL,
    username VARCHAR(64) NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    KEY idx_auth_user (user_id)
  ) CHARACTER SET utf8mb4`
];

export async function initDb() {
  const pool = getDb();
  for (const sql of CREATE_TABLES) {
    await pool.execute(sql);
  }
  // 迁移守卫：补充可能缺失的列
  await ensureColumn(pool, "sessions", "archived", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "sessions", "auto_mode", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "sessions", "user_id", "INT");
  await ensureColumn(pool, "sessions", "topic_summary", "TEXT");
  await ensureColumn(pool, "sessions", "last_user_at", "VARCHAR(64)");
  await ensureColumn(pool, "sessions", "dnd_start", "VARCHAR(8)");
  await ensureColumn(pool, "sessions", "dnd_end", "VARCHAR(8)");
  await ensureColumn(pool, "sessions", "proactive_idle_minutes", "INT");
  await ensureColumn(pool, "sessions", "last_proactive_at", "VARCHAR(64)");
  await ensureColumn(pool, "sessions", "last_call_at", "VARCHAR(64)");
  await ensureColumn(pool, "sessions", "last_emotion_call_at", "VARCHAR(64)");
  await ensureColumn(pool, "sessions", "diary_generated", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "messages", "image_url", "TEXT");
  await ensureColumn(pool, "messages", "image_prompt", "TEXT");
  await ensureColumn(pool, "messages", "character_name", "VARCHAR(255)");
  await ensureColumn(pool, "messages", "user_id", "INT");
  await ensureColumn(pool, "mood_avatars", "appearance_hash", "VARCHAR(64) NOT NULL DEFAULT ''");
  await ensureColumn(pool, "mood_avatars", "user_id", "INT");
  await fixMoodAvatarsKey(pool);
  await ensureColumn(pool, "character_cards", "user_id", "INT");
  await ensureColumn(pool, "characters", "appearance", "TEXT");
  await ensureColumn(pool, "characters", "personality", "TEXT");
  await ensureColumn(pool, "characters", "description", "TEXT");
  await ensureColumn(pool, "characters", "affection", "INT NOT NULL DEFAULT 10");
  await ensureColumn(pool, "characters", "user_id", "INT");
  await ensureColumn(pool, "affection_log", "mood", "VARCHAR(32)");
  await ensureColumn(pool, "users", "is_admin", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "user_settings", "flags", "INT NOT NULL DEFAULT 6");
  await ensureColumn(pool, "characters", "streak_days", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "characters", "last_chat_date", "VARCHAR(16)");
  await ensureColumn(pool, "user_settings", "scene_image_date", "VARCHAR(16)");
  await ensureColumn(pool, "user_settings", "scene_image_count", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "user_settings", "avatar_image_date", "VARCHAR(16)");
  await ensureColumn(pool, "user_settings", "avatar_image_count", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "user_settings", "llm_provider", "VARCHAR(32) NOT NULL DEFAULT 'deepseek'");
  await ensureColumn(pool, "user_settings", "tts_lang", "VARCHAR(4) NOT NULL DEFAULT 'zh'");
  await ensureColumn(pool, "user_achievements", "notified", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "relationship_milestones", "video_url", "TEXT");
  await ensureColumn(pool, "characters", "voice_id", "VARCHAR(128)");
  await ensureColumn(pool, "characters", "tts_enabled", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "characters", "voice_preview_url", "TEXT");
  await ensureColumn(pool, "characters", "voice_channel", "VARCHAR(32) NOT NULL DEFAULT 'qwen'");
  await ensureColumn(pool, "messages", "tts_audio_url", "TEXT");
  await ensureColumn(pool, "call_logs", "voicemail", "TEXT");
  await ensureColumn(pool, "call_logs", "missed", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "call_logs", "voicemail_read", "INT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "call_logs", "msg_id", "INT");
  // 清除旧的 PCM-as-mp3 缓存预览 URL，重新生成为 WAV
  await pool.execute("UPDATE characters SET voice_preview_url = NULL WHERE voice_preview_url LIKE '%.mp3'");
  // 迁移：将 user_achievements 的唯一键从 (user_id, achievement_id) 改为包含 character_id
  try {
    const [cols] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_achievements' AND INDEX_NAME='uq_user_achievement'"
    );
    const hasCharacterId = cols.some(r => r.COLUMN_NAME === 'character_id');
    if (!hasCharacterId) {
      await pool.execute("ALTER TABLE user_achievements DROP INDEX uq_user_achievement");
      await pool.execute("ALTER TABLE user_achievements ADD UNIQUE KEY uq_user_achievement (user_id, achievement_id, character_id)");
    }
  } catch {}

  // 迁移：app_versions 改走语义化版本，删除废弃的整数列
  await dropColumn(pool, "app_versions", "version_code");
  await dropColumn(pool, "app_versions", "min_version_code");

  // 用户头像
  await ensureColumn(pool, "users", "avatar_url", "TEXT");

  // 公告：是否在用户打开软件时弹窗
  await ensureColumn(pool, "announcements", "popup", "INT NOT NULL DEFAULT 1");
}
