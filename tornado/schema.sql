-- Tornado 数据库初始化脚本
-- 使用前先创建数据库：CREATE DATABASE tornado CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL DEFAULT '新对话',
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  mood VARCHAR(32) NOT NULL DEFAULT 'neutral',
  mood_intensity INT NOT NULL DEFAULT 0,
  mood_cause TEXT,
  mood_updated_at VARCHAR(64),
  topic_summary TEXT,
  last_user_at VARCHAR(64),
  dnd_start VARCHAR(8),
  dnd_end VARCHAR(8),
  proactive_idle_minutes INT,
  last_diary_message_id INT,
  archived INT NOT NULL DEFAULT 0,
  auto_mode INT NOT NULL DEFAULT 0,
  user_id INT,
  KEY idx_sessions_user_archived_updated (user_id, archived, updated_at),
  KEY idx_sessions_last_user_at (last_user_at)
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
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
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS mood_avatars (
  `character` VARCHAR(255) NOT NULL DEFAULT '',
  mood VARCHAR(32) NOT NULL,
  image_url TEXT NOT NULL,
  appearance_hash VARCHAR(64) NOT NULL DEFAULT '',
  created_at VARCHAR(64) NOT NULL,
  user_id INT,
  PRIMARY KEY (`character`, mood),
  KEY idx_mood_avatars_character_user (`character`(191), user_id),
  KEY idx_mood_avatars_character_hash (`character`(191), appearance_hash)
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS character_cards (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `character` VARCHAR(255) NOT NULL,
  image_url TEXT NOT NULL,
  is_active INT NOT NULL DEFAULT 0,
  created_at VARCHAR(64) NOT NULL,
  user_id INT,
  KEY idx_character_cards_char_user_active (`character`, user_id, is_active)
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS characters (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  appearance TEXT,
  personality TEXT,
  description TEXT,
  values_content TEXT,
  boundaries_content TEXT,
  habits_content TEXT,
  speech_examples MEDIUMTEXT,
  soul_content MEDIUMTEXT,
  slideshow_enabled INT NOT NULL DEFAULT 0,
  slideshow_interval INT NOT NULL DEFAULT 30,
  is_active INT NOT NULL DEFAULT 0,
  affection INT NOT NULL DEFAULT 10,
  trust_score INT,
  warmth_score INT,
  intimacy_score INT,
  tension_score INT,
  inner_state_json TEXT,
  streak_days INT NOT NULL DEFAULT 0,
  last_chat_date VARCHAR(16),
  created_at VARCHAR(64) NOT NULL,
  user_id INT,
  UNIQUE KEY uq_name_user (name, user_id),
  KEY idx_characters_user_active (user_id, is_active)
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS affection_log (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  character_id INT NOT NULL,
  delta INT NOT NULL,
  value INT NOT NULL,
  mood VARCHAR(32),
  reason TEXT,
  created_at VARCHAR(64) NOT NULL,
  KEY idx_affection_log_character_id (character_id)
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(128) NOT NULL,
  is_admin INT NOT NULL DEFAULT 0,
  created_at VARCHAR(64) NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS invite_codes (
  code VARCHAR(128) NOT NULL PRIMARY KEY,
  created_at VARCHAR(64) NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INT NOT NULL PRIMARY KEY,
  affection_interval INT NOT NULL DEFAULT 3,
  flags INT NOT NULL DEFAULT 6
  -- flags bit layout:
  -- bit 0 (1): image_fallback_enabled
  -- bit 1 (2): chat_image_enabled
  -- bit 2 (4): image_auto_expand
  -- bit 3 (8): collapse_action
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS announcements (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  created_at VARCHAR(64) NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS announcement_reads (
  user_id INT NOT NULL,
  announcement_id INT NOT NULL,
  PRIMARY KEY (user_id, announcement_id),
  KEY idx_announcement_reads_ann_id (announcement_id)
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS global_settings (
  `key` VARCHAR(128) NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS achievements (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(32) NOT NULL,
  threshold INT NOT NULL,
  name VARCHAR(128) NOT NULL,
  enabled INT NOT NULL DEFAULT 1,
  created_at VARCHAR(64) NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS user_achievements (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  achievement_id INT NOT NULL,
  character_id INT NOT NULL,
  selfie_url TEXT,
  inner_voice TEXT,
  unlocked_at VARCHAR(64) NOT NULL,
  UNIQUE KEY uq_user_achievement (user_id, achievement_id),
  KEY idx_user_achievements_user (user_id)
) CHARACTER SET utf8mb4;


CREATE TABLE IF NOT EXISTS memories (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(512) NOT NULL DEFAULT '',
  raw_text MEDIUMTEXT NOT NULL,
  summary TEXT NOT NULL,
  entities TEXT NOT NULL,
  topics TEXT NOT NULL,
  connections TEXT NOT NULL,
  importance DOUBLE NOT NULL DEFAULT 0.5,
  created_at VARCHAR(64) NOT NULL,
  consolidated INT NOT NULL DEFAULT 0,
  KEY idx_memories_source (source(191)),
  KEY idx_memories_consolidated (consolidated),
  KEY idx_memories_source_consolidated (source(191), consolidated)
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS consolidations (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_ids TEXT NOT NULL,
  summary TEXT NOT NULL,
  insight TEXT NOT NULL,
  created_at VARCHAR(64) NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS entity_relations (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_entity VARCHAR(512) NOT NULL,
  target_entity VARCHAR(512) NOT NULL,
  relationship VARCHAR(255) NOT NULL,
  evidence_memory_ids TEXT NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  KEY idx_entity_relations_source (source_entity(191)),
  KEY idx_entity_relations_target (target_entity(191))
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS processed_files (
  path VARCHAR(768) NOT NULL PRIMARY KEY,
  processed_at VARCHAR(64) NOT NULL
) CHARACTER SET utf8mb4;
