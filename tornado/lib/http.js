// HTTP 响应/请求工具
import fs from "node:fs";
import path from "node:path";

export async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function send(res, status, body) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const ct = typeof body === "string" ? "text/plain; charset=utf-8" : "application/json";
  res.writeHead(status, { "Content-Type": ct, "Access-Control-Allow-Origin": "*" });
  res.end(payload);
}

export function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
  if (!fs.existsSync(filePath)) {
    send(res, 404, "Not found");
    return;
  }
  // HTML 完全不缓存（含静态资源版本号），JS/CSS 用强校验避免 iOS Safari 激进缓存
  const cacheControl = ext === ".html"
    ? "no-store, no-cache, must-revalidate"
    : "no-cache, must-revalidate";
  res.writeHead(200, { "Content-Type": mime[ext] || "text/plain", "Cache-Control": cacheControl });
  fs.createReadStream(filePath).pipe(res);
}

export function sendHtmlWithAssetVersion(res, htmlPath, publicDir) {
  if (!fs.existsSync(htmlPath)) {
    send(res, 404, "Not found");
    return;
  }
  let html = fs.readFileSync(htmlPath, "utf8");
  // 给 app.js / styles.css / auth.js 等本地静态资源注入 mtime 作为版本号，绕过浏览器缓存
  const assets = ["app.js", "styles.css", "auth.js"];
  for (const asset of assets) {
    const assetPath = path.join(publicDir, asset);
    if (!fs.existsSync(assetPath)) continue;
    const v = Math.floor(fs.statSync(assetPath).mtimeMs);
    const re = new RegExp(`(["'/])${asset.replace(".", "\\.")}(["'?])`, "g");
    html = html.replace(re, (m, p1, p2) => p2 === "?" ? m : `${p1}${asset}?v=${v}${p2}`);
  }
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store, no-cache, must-revalidate"
  });
  res.end(html);
}
