import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

// 本地开发时清理占用端口，容器内跳过
if (process.env.NODE_ENV !== "production") {
  for (const port of [8880, 3011, 3011]) {
    try {
      const pid = execSync(`lsof -ti :${port}`, { encoding: "utf8" }).trim();
      if (pid) {
        execSync(`kill -9 ${pid}`);
        console.log(`[start] killed old process on :${port} (pid ${pid})`);
      }
    } catch {}
  }
}

// 本地开发用 --env-file 加载 .env，生产环境由容器注入
const useEnvFile = process.env.NODE_ENV !== "production";

const services = [
  {
    label: "memory",
    args: useEnvFile ? ["--env-file=.env", "src/server.js"] : ["src/server.js"],
    cwd: root,
  },
  {
    label: "tornado",
    args: useEnvFile ? ["--env-file=../.env", "server.js"] : ["server.js"],
    cwd: path.join(root, "tornado"),
  },
];

const MYSQL_KEYS = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"];

for (const { label, args, cwd } of services) {
  const env = { ...process.env };
  for (const key of MYSQL_KEYS) delete env[key];

  const p = spawn("node", args, { cwd, stdio: "pipe", env });

  p.stdout.on("data", (d) => {
    if (label === "tornado") process.stdout.write(d);
  });
  p.stderr.on("data", (d) => {
    if (label === "tornado") process.stderr.write(d);
    else process.stderr.write(`[memory] ${d}`);
  });

  p.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
      process.exit(code ?? 1);
    }
  });
}
