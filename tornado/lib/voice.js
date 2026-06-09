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

export async function cloneVoice(audioUrl, charId) {
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-voice-enrollment",
      input: {
        action: "create",
        target_model: "qwen3-tts-vc-realtime-2026-01-15",
        preferred_name: `char${charId}`,
        audio: { data: audioUrl }
      }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`QwenTTS clone ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const voice = data.output?.voice;
  if (!voice) throw new Error(`QwenTTS clone: no voice in response. ${JSON.stringify(data).slice(0, 200)}`);
  return voice;
}

export async function deleteVoice(voiceId) {
  await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen-voice-enrollment", input: { action: "delete", voice: voiceId } })
  });
}
// __APPEND2__

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
        content: "你是语音合成指令生成助手。根据角色信息和当前对话情绪，生成一段简短的语音合成风格指令（不超过50字），只描述语速、语调、情感状态等朗读风格，不得包含任何台词、对话内容或引号内的文字，直接输出指令，不要任何解释。示例：语速稍快，语气不耐烦，带轻微鼻音。"
      },
      {
        role: "user",
        content: `角色名：${charName}\n性格：${(personality || "").slice(0, 100)}\n当前情绪：${mood || "平静"}\n近期对话：\n${context}`
      }
    ]
  });
  return (res.choices?.[0]?.message?.content || "").trim().slice(0, 50);
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

export async function synthesizeSpeech(text, voiceId, lang = "zh", instruction = "") {
  const langType = lang === "ja" ? "Japanese" : "Chinese";
  const input = { text, voice: voiceId, language_type: langType };
  const parameters = {};
  if (instruction) { parameters.instructions = instruction; parameters.optimize_instructions = false; }
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-tts-vc-realtime-2026-01-15", input, parameters })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`QwenTTS ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const tempUrl = data.output?.audio?.url || data.output?.choices?.[0]?.message?.content?.[0]?.audio?.url;
  if (!tempUrl) throw new Error(`QwenTTS: no audio url. ${JSON.stringify(data).slice(0, 200)}`);
  const dlRes = await fetch(tempUrl);
  if (!dlRes.ok) throw new Error(`QwenTTS 音频下载失败: ${dlRes.status}`);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${lang}.wav`;
  const url = await uploadToOss(buf, filename);
  return { url, durationMs: 0 };
}

export async function cloneVoiceQwenOmni(audioUrl, charId) {
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-voice-enrollment",
      input: {
        action: "create",
        target_model: "qwen3.5-omni-plus-realtime",
        preferred_name: `char${charId}`,
        audio: { data: audioUrl }
      }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`QwenOmni clone ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const voice = data.output?.voice;
  if (!voice) throw new Error(`QwenOmni clone: no voice in response. ${JSON.stringify(data).slice(0, 200)}`);
  return voice;
}

export async function deleteVoiceQwenOmni(voiceId) {
  await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen-voice-enrollment", input: { action: "delete", voice: voiceId } })
  });
}

export async function synthesizeSpeechQwenOmni(text, voiceId, lang = "zh", instruction = "") {
  const audioChunks = await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime",
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const chunks = [];
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => { ws.terminate(); finish(new Error("QwenOmni TTS timeout")); }, 60000);
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "session.created") {
        ws.send(JSON.stringify({ type: "session.update", session: { voice: voiceId, output_audio_format: "pcm16" } }));
      } else if (msg.type === "session.updated") {
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
      } else if (msg.type === "response.audio.delta") {
        chunks.push(Buffer.from(msg.delta, "base64"));
      } else if (msg.type === "response.done") {
        ws.close();
        finish(null, chunks);
      } else if (msg.type === "error") {
        finish(new Error(`QwenOmni TTS error: ${msg.error?.message || JSON.stringify(msg)}`));
      }
    });
    ws.on("error", (err) => finish(err));
    ws.on("close", () => finish(chunks.length ? null : new Error("QwenOmni TTS: no audio received"), chunks));
  });
  const pcm = Buffer.concat(audioChunks);
  const wav = pcm16ToWav(pcm, 24000, 1, 16);
  const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${lang}.wav`;
  const url = await uploadToOss(wav, filename, "audio/wav");
  return { url, durationMs: 0 };
}


