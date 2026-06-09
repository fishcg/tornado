// 图片生成底层：主 API + DashScope 兜底、prompt 改写、图片识别
import { OPENAI_API_KEY, OPENAI_MODEL, IMAGE_API_URL, IMAGE_API_KEY, openai } from "./config.js";

export const IMG_TAG_RE = /\[IMG:\s*(.+?)\]\s*$/;

export function extractImageTag(text) {
  const match = text.match(IMG_TAG_RE);
  if (!match) return { cleanText: text, prompt: null };
  return { cleanText: text.replace(IMG_TAG_RE, "").trimEnd(), prompt: match[1].trim() };
}

export async function callImageApiFallback(prompt, { aspectRatio = "16:9" } = {}) {
  // DashScope wanx 文生图，作为主 API 失败时的备用
  const sizeMap = { "1:1": "1024*1024", "2:3": "768*1024", "16:9": "1280*720", "9:16": "720*1280" };
  const size = sizeMap[aspectRatio] || "1024*1024";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 360_000);
  try {
    const submitRes = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({
        model: "wanx-v1",
        input: { prompt },
        parameters: { size, n: 1, style: "<anime>" }
      }),
      signal: controller.signal
    });
    if (!submitRes.ok) {
      const body = await submitRes.text().catch(() => "");
      throw new Error(`DashScope submit ${submitRes.status}: ${body.slice(0, 200)}`);
    }
    const submitData = await submitRes.json();
    const taskId = submitData.output?.task_id;
    if (!taskId) throw new Error(`DashScope: no task_id in response`);

    // 轮询任务结果
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
      });
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json();
      const status = pollData.output?.task_status;
      if (status === "SUCCEEDED") {
        const url = pollData.output?.results?.[0]?.url;
        if (!url) throw new Error("DashScope: no url in result");
        return url;
      }
      if (status === "FAILED") throw new Error(`DashScope task failed: ${JSON.stringify(pollData.output).slice(0, 200)}`);
    }
    throw new Error("DashScope: task timed out");
  } finally {
    clearTimeout(timeout);
  }
}
// __APPEND_MARKER__

export async function callImageApi(prompt, { hd = true, aspectRatio = "16:9" } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 360_000);
  try {
    const res = await fetch(IMAGE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${IMAGE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        mode: "txt2img",
        modelId: "gpt-image",
        n: 1,
        hd,
        aspectRatio
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Image API ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const url = data.url || data.data?.[0]?.url || data.images?.[0] || data.output?.url || null;
    if (!url) {
      throw new Error(`Image API returned no URL: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return url;
  } finally {
    clearTimeout(timeout);
  }
}

export async function rewriteSafePrompt(originalPrompt) {
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    messages: [
      {
        role: "system",
        content: "用户提供的图片描述被生图API拒绝了（可能包含敏感内容）。请改写为一个安全、合规的中文图片描述，保留原始场景的核心意图但去掉所有可能违规的元素。只输出改写后的描述，不要其他内容。"
      },
      { role: "user", content: originalPrompt }
    ]
  });
  return (res.choices?.[0]?.message?.content || "").trim();
}

export async function generateImage(prompt, sceneAnchor = "", { imageFallbackEnabled = true, aspectRatio = null } = {}) {
  const ratio = aspectRatio || "16:9";
  try {
    return await callImageApi(prompt, { aspectRatio: ratio });
  } catch (err) {
    if (err.status === 400) {
      console.log("生图被拒，尝试改写 prompt 重试...");
      const safePrompt = await rewriteSafePrompt(prompt);
      if (safePrompt) {
        const retryPrompt = sceneAnchor ? `${safePrompt}${sceneAnchor}` : safePrompt;
        console.log(`改写后: ${retryPrompt}`);
        try {
          return await callImageApi(retryPrompt, { aspectRatio: ratio });
        } catch (err2) {
          if (!imageFallbackEnabled) throw err2;
          console.log(`改写后仍失败，切换 DashScope 重试: ${err2.message}`);
          return await callImageApiFallback(retryPrompt, { aspectRatio: ratio });
        }
      }
    }
    if (!imageFallbackEnabled) throw err;
    console.log(`主 API 失败，切换 DashScope 重试: ${err.message}`);
    return await callImageApiFallback(prompt, { aspectRatio: ratio });
  }
}

export async function recognizeImage(imageUrl) {
  try {
    const res = await fetch(IMAGE_API_URL.replace("/generate", "/understand"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${IMAGE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ action: "recognize-scene", imageUrl })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;
    return data.description || null;
  } catch {
    return null;
  }
}

export function sanitizeImagePrompt(prompt) {
  return prompt
    .replace(/NSFW|nude|naked|sexy|erotic/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

