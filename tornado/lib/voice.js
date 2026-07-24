// 语音克隆 / TTS 合成（CosyVoice / Qwen-TTS / Qwen-Omni）+ 相关 LLM 辅助
import crypto from "node:crypto";
import { WebSocket } from "ws";
import { OPENAI_API_KEY, OPENAI_MODEL, openai } from "./config.js";
import { uploadToOss } from "./oss.js";

export function pcm16ToWav(pcmBuf, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const dataSize = pcmBuf.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuf]);
}

export async function cloneVoiceCosyVoice(audioUrl, charId) {
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: "cosyvoice-v3.5-plus",
        prefix: `char${charId}`,
        url: audioUrl,
        language_hints: ["zh"],
        max_prompt_audio_length: 20.0,
        enable_preprocess: true
      }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CosyVoice clone ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const voiceId = data.output?.voice_id;
  if (!voiceId) throw new Error(`CosyVoice clone: no voice_id in response`);
  return voiceId;
}

export async function deleteVoiceCosyVoice(voiceId) {
  await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "voice-enrollment", input: { action: "delete_voice", voice_id: voiceId } })
  });
}
// __APPEND__

export async function synthesizeSpeechCosyVoice(text, voiceId, lang = "zh", instruction = "", onChunk = null) {
  const taskId = crypto.randomUUID();
  const allChunks = [];

  await new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://dashscope.aliyuncs.com/api-ws/v1/inference", {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    });
    let settled = false;
    const finish = (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => { ws.terminate(); finish(new Error("CosyVoice TTS timeout")); }, 60000);

    ws.on("open", () => {
      const parameters = { text_type: "PlainText", voice: voiceId, format: "pcm", sample_rate: 24000, volume: 50, rate: 1.0, pitch: 1.0 };
      if (instruction) parameters.instruction = instruction;
      if (lang !== "zh") parameters.language_hints = [lang];
      ws.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: "cosyvoice-v3.5-plus", parameters, input: {} }
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const chunk = Buffer.from(data);
        allChunks.push(chunk);
        if (onChunk) onChunk(chunk);
        return;
      }
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      const event = msg.header?.event;
      if (event === "task-started") {
        ws.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text } } }));
        ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
      } else if (event === "task-finished") {
        ws.close(); finish(null);
      } else if (event === "task-failed") {
        finish(new Error(`CosyVoice TTS failed: ${msg.header?.error_message || JSON.stringify(msg)}`));
      }
    });
    ws.on("error", (err) => finish(err));
    ws.on("close", () => finish(null));
  });

  const pcm = Buffer.concat(allChunks);
  const wav = pcm16ToWav(pcm, 24000, 1, 16);
  const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${lang}.wav`;
  const url = await uploadToOss(wav, filename);
  return { url, durationMs: 0 };
}

export async function summarizePlot(msgs) {
  if (!msgs || msgs.length === 0) return "";
  const context = msgs.map((m) => `${m.role === "user" ? "用户" : "角色"}：${m.content.slice(0, 120)}`).join("\n");
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    max_tokens: 150,
    messages: [
      {
        role: "system",
        content: "你是剧情总结助手。根据对话记录，用100字以内总结当前两人之间发生的主要剧情、情感走向和关键事件，直接输出总结，不加任何前缀。"
      },
      { role: "user", content: context }
    ]
  });
  return (res.choices?.[0]?.message?.content || "").trim().slice(0, 150);
}

export async function generateTtsInstruction(charName, personality, mood, recentMsgs) {
  const context = recentMsgs.slice(-4).map((m) => `${m.role === "user" ? "用户" : charName}: ${m.content.slice(0, 60)}`).join("\n");
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    messages: [
      {
        role: "system",
        content: [
          "你是语音合成指令生成助手。根据角色信息和当前对话情绪，生成一段简短的语音合成风格指令（不超过40字），只描述语速、语调、情感状态等朗读风格，不得包含任何台词、对话内容或引号内的文字。直接输出指令，不要解释。",
          "重要：语速要贴合当前情绪真实变化，默认用正常偏自然的语速，不要动不动就“语速缓慢/放缓”。只有明显低落、疲惫、深情倾诉等情绪才用慢速；开心、俏皮、生气、着急、兴奋等情绪应偏快或正常。",
          "不同情绪的示例（供参考，不要照抄）：",
          "- 开心俏皮：语速偏快，语调轻快跳跃，带笑意",
          "- 生气：语速较快，语气冲，音量偏大",
          "- 害羞：语速正常略顿，声音偏小，尾音轻",
          "- 温柔安慰：语速平缓，语调柔和",
          "- 难过：语速偏慢，声音低沉，气息下沉",
          "- 平静日常：语速自然，语调平实"
        ].join("\n")
      },
      {
        role: "user",
        content: `角色名：${charName}\n性格：${(personality || "").slice(0, 100)}\n当前情绪：${mood || "平静"}\n近期对话：\n${context}`
      }
    ]
  });
  return (res.choices?.[0]?.message?.content || "").trim().slice(0, 50);
}

// Qwen-Audio-TTS 支持的标签白名单（仅这些会被模型识别，其余会被读成文字）
// 已剔除会明显拖慢语速/不适合聊天陪伴场景的标签：very slowly、tired、bored、very fast、deep and loud shouting、shouting、like dracula
const AUDIO_CONTROL_TAGS = ["sad", "amazed", "trembling", "angry", "excited", "sarcastic", "curious", "panicked", "mischievously", "empathetic", "whispers", "reluctantly", "crying", "serious"];
const AUDIO_RICH_TAGS = ["gasp", "sighing", "clears throat", "giggles", "laughing", "cough", "snorts"];
const ALL_AUDIO_TAGS = new Set([...AUDIO_CONTROL_TAGS, ...AUDIO_RICH_TAGS]);
const CONTROL_TAG_SET = new Set(AUDIO_CONTROL_TAGS);

// 合成前文本归一化：省略号/多个句末标点会让 TTS 拉长停顿，导致整体语速拖沓
// 把连续的 …/。。。/... 及重复标点收敛为单个，减少不必要的停顿
export function normalizeTtsText(text) {
  if (!text) return text;
  return text
    .replace(/[.．。]{2,}/g, "。")      // 中英文省略式句号 → 单个句号
    .replace(/[…⋯]+/g, "，")           // 省略号 → 短停顿逗号
    .replace(/[!！]{2,}/g, "！")
    .replace(/[?？]{2,}/g, "？")
    .replace(/[~～]{2,}/g, "～")
    .replace(/[,，]{2,}/g, "，")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// 给 Qwen-Audio-TTS 的待合成文本智能插入情感/富语言标签
// 结合角色回复内容、当前情绪、性格，由 LLM 在合适位置插标签，返回带标签文本
// 仅用于 qwen-audio 渠道；失败或无合适标签时返回原文
export async function injectAudioTags(text, { mood = "", personality = "" } = {}) {
  if (!text || !text.trim()) return text;
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      enable_thinking: false,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: [
            "你是语音合成标签编辑器。给定一段角色台词，在合适的位置插入情感/拟声标签，让语音更有表现力。",
            "",
            "两类标签：",
            `控制类（放在文本前，作用于其后所有文字直到下一个控制类标签，用于定情绪基调）：${AUDIO_CONTROL_TAGS.map((t) => `[${t}]`).join(" ")}`,
            `富语言类（在当前位置插入一段拟声，不影响前后情感）：${AUDIO_RICH_TAGS.map((t) => `[${t}]`).join(" ")}`,
            "",
            "规则：",
            "1. 只能使用上面列出的标签，一个字都不能改动标签内的英文，禁止发明新标签。",
            "2. 真实的人说一段话，情绪基调是稳定的，不会来回大起大落。所以控制类标签原则上只在开头放一个，定住整段的情绪基调，之后不再切换。参考：生气→[angry]、俏皮调侃→[mischievously]、兴奋→[excited]、温柔/亲昵/关切→[empathetic]、难过→[sad]、好奇→[curious]、惊讶→[amazed]、讽刺→[sarcastic]、委屈不情愿→[reluctantly]、认真→[serious]、害羞→[whispers]。注意：[whispers]（耳语）只用于真正压低嗓音、悄悄话的场景，普通的温柔或亲密请用 [empathetic]，不要滥用 [whispers]。语气平淡的日常对话可以不加，选不准就不加。",
            "3. 只有极少数情况——台词中途情绪发生明显反转（如先难过后突然开心）——才允许在中间再插一个控制类标签。整段控制类标签最多 2 个，绝大多数情况就 1 个或 0 个。",
            "4. 富语言标签（笑声/叹息/倒吸气等）是主要的点缀手段，在台词语义真的发生该动作的位置插入，让语音生动自然：确实在笑处加 [giggles]，感慨叹气处加 [sighing]，惊讶倒吸气处加 [gasp]，清嗓处加 [clears throat]。按语义需要插入，可比控制类标签更灵活，但不要凭空插与语义无关的拟声，同一种拟声不要连续重复。",
            "5. 不要改写、删减、增补台词原文的任何文字和标点，只插入标签。",
            "6. 直接输出插好标签的台词，不要解释、不要引号、不要代码块。"
          ].join("\n")
        },
        {
          role: "user",
          content: `当前情绪：${mood || "平静"}\n角色性格：${(personality || "").slice(0, 80)}\n台词：${text}`
        }
      ]
    });
    let tagged = (res.choices?.[0]?.message?.content || "").trim();
    if (!tagged) return text;
    // 安全校验：剔除任何不在白名单里的方括号标签，避免被读成文字
    tagged = tagged.replace(/\[([^\]]+)\]/g, (m, inner) => (ALL_AUDIO_TAGS.has(inner.trim()) ? `[${inner.trim()}]` : ""));
    // 去标签后应与原文一致（只允许插入标签，不允许改字）；不一致则放弃，返回原文
    const stripped = tagged.replace(/\[[^\]]+\]/g, "").replace(/\s+/g, "");
    if (stripped !== text.replace(/\s+/g, "")) return text;
    // 硬性上限：控制类标签最多保留 1 个（真人一段话基调稳定），富语言标签最多 2 个
    let controlKept = 0;
    let richKept = 0;
    tagged = tagged.replace(/\[([^\]]+)\]/g, (m, inner) => {
      const tag = inner.trim();
      if (CONTROL_TAG_SET.has(tag)) {
        return ++controlKept <= 1 ? `[${tag}]` : "";
      }
      return ++richKept <= 2 ? `[${tag}]` : "";
    });
    return tagged.replace(/\s{2,}/g, " ").trim() || text;
  } catch {
    return text;
  }
}

export async function translateToJapanese(text) {
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    enable_thinking: false,
    messages: [
      { role: "system", content: "你是翻译助手。将用户输入的中文翻译成自然流畅的日语，只输出日语译文，不要任何解释。" },
      { role: "user", content: text }
    ]
  });
  return (res.choices?.[0]?.message?.content || text).trim();
}

// ── Qwen-Audio-TTS（qwen-audio-3.0-tts）：声音复刻 + 非实时 HTTP 合成 ──────────
// 支持指令控制、情感/富语言标签，仅北京地域可用。flash 与 plus 仅模型名不同，逻辑一致
export const QWEN_AUDIO_TTS_FLASH = "qwen-audio-3.0-tts-flash";
export const QWEN_AUDIO_TTS_PLUS = "qwen-audio-3.0-tts-plus";

export async function cloneVoiceQwenAudio(audioUrl, charId, model = QWEN_AUDIO_TTS_FLASH) {
  // Qwen-Audio-TTS 复刻与 CosyVoice 同格式：model=voice-enrollment、action=create_voice、url、prefix，返回 output.voice_id
  // 音色通过 target_model 绑定具体模型，不能跨模型使用，故 flash/plus 各自复刻
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: model,
        prefix: `char${charId}`,
        url: audioUrl,
        language_hints: ["zh"],
        max_prompt_audio_length: 20.0,
        enable_preprocess: true
      }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`QwenAudio clone ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const voiceId = data.output?.voice_id;
  if (!voiceId) throw new Error(`QwenAudio clone: no voice_id in response. ${JSON.stringify(data).slice(0, 200)}`);
  return voiceId;
}

export async function deleteVoiceQwenAudio(voiceId) {
  await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "voice-enrollment", input: { action: "delete_voice", voice_id: voiceId } })
  });
}

export async function synthesizeSpeechQwenAudio(text, voiceId, lang = "zh", instruction = "", model = QWEN_AUDIO_TTS_FLASH) {
  const input = { text, voice: voiceId, format: "wav", sample_rate: 24000 };
  if (instruction) input.instruction = instruction;
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`QwenAudio TTS ${res.status}: ${body.slice(0, 300)}`);
  }
  const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${lang}.wav`;
  const contentType = res.headers.get("content-type") || "";
  // 情形一：接口直接返回二进制音频
  if (contentType.startsWith("audio/") || contentType.includes("octet-stream")) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { url: await uploadToOss(buf, filename, "audio/wav"), durationMs: 0 };
  }
  // 情形二：返回 JSON —— 可能是音频 URL，也可能是 base64
  const data = await res.json();
  const tempUrl = data.output?.audio?.url || data.output?.url || data.output?.choices?.[0]?.message?.content?.[0]?.audio?.url;
  const b64 = data.output?.audio?.data || data.output?.audio?.audio;
  if (tempUrl) {
    const dlRes = await fetch(tempUrl);
    if (!dlRes.ok) throw new Error(`QwenAudio TTS 音频下载失败: ${dlRes.status}`);
    const buf = Buffer.from(await dlRes.arrayBuffer());
    return { url: await uploadToOss(buf, filename, "audio/wav"), durationMs: 0 };
  }
  if (b64) {
    const buf = Buffer.from(b64, "base64");
    return { url: await uploadToOss(buf, filename, "audio/wav"), durationMs: 0 };
  }
  throw new Error(`QwenAudio TTS: no audio in response. ${JSON.stringify(data).slice(0, 200)}`);
}


