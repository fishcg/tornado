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

export async function initDb() {
  const pool = getDb();
  await pool.execute(`
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
    ) CHARACTER SET utf8mb4
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS consolidations (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      source_ids TEXT NOT NULL,
      summary TEXT NOT NULL,
      insight TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL
    ) CHARACTER SET utf8mb4
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS entity_relations (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      source_entity VARCHAR(512) NOT NULL,
      target_entity VARCHAR(512) NOT NULL,
      relationship VARCHAR(255) NOT NULL,
      evidence_memory_ids TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_entity_relations_source (source_entity(191)),
      KEY idx_entity_relations_target (target_entity(191))
    ) CHARACTER SET utf8mb4
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS processed_files (
      path VARCHAR(768) NOT NULL PRIMARY KEY,
      processed_at VARCHAR(64) NOT NULL
    ) CHARACTER SET utf8mb4
  `);
}
