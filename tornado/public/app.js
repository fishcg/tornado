const API = "";

function renderBubbleText(text) {
  const collapse = isCollapseActionEnabled();
  const parts = text.split(/(（[^）]*）|\([^)]*\))/g);
  return parts.map(part => {
    if (/^（[^）]*）$/.test(part) || /^\([^)]*\)$/.test(part)) {
      const inner = part.slice(1, -1);
      const bracket = part[0] === '（' ? ['（', '）'] : ['(', ')'];
      if (collapse) {
        return `<div class="action-line action-hidden"></div>`;
      }
      return `<div class="action-line">${bracket[0]}${inner}${bracket[1]}</div>`;
    }
    const escaped = part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const trimmed = escaped.trim();
    if (!trimmed) return '';
    return `<div class="speech-line">${trimmed}</div>`;
  }).join('');
}

let currentSessionId = (() => { try { return Number(localStorage.getItem("lastSessionId")) || null; } catch { return null; } })();
let sending = false;
let allMessages = [];
let _currentTtsAudio = null; // 全局追踪当前播放的 TTS，切换时自动停止
let _pendingCallBubble = null; // 情绪来电等待期间的占位气泡
let autoModeEnabled = false;
let autoModeTimer = null;
const _sessionsMap = new Map(); // id -> session object
let semiAutoEnabled = false;
let suggestionsGen = 0;
const PAGE_SIZE = 40;

const BG_OPACITY_KEY = "chat-bg-opacity";
const BUBBLE_OPACITY_KEY = "chat-bubble-opacity";

function isCollapseActionEnabled() {
  return window._collapseAction === true;
}

function getChatBgOpacity() {
  return parseFloat(localStorage.getItem(BG_OPACITY_KEY) ?? "0.12");
}

function getBubbleOpacity() {
  return parseFloat(localStorage.getItem(BUBBLE_OPACITY_KEY) ?? "0.92");
}

function applyBubbleOpacity(v) {
  localStorage.setItem(BUBBLE_OPACITY_KEY, v);
  document.documentElement.style.setProperty("--user-bg", `rgba(61, 47, 110, ${v})`);
  document.documentElement.style.setProperty("--assistant-bg", `rgba(26, 26, 30, ${v})`);
  document.documentElement.style.setProperty("--call-bg", `rgba(244, 110, 164, ${v})`);
}

function setChatBackground(url) {
  const el = document.getElementById("messages");
  if (!url) {
    el.style.removeProperty("--chat-bg-url");
    el.style.setProperty("--chat-bg-dim", "1");
    return;
  }
  // 预加载图片，加载完成后再切换，避免黑屏
  const img = new Image();
  img.onload = () => {
    el.style.setProperty("--chat-bg-url", `url("${url}")`);
    el.style.setProperty("--chat-bg-dim", String(1 - getChatBgOpacity()));
  };
  img.src = url;
}

function applyChatBgOpacity(opacity) {
  localStorage.setItem(BG_OPACITY_KEY, opacity);
  document.getElementById("messages").style.setProperty("--chat-bg-dim", String(1 - opacity));
}

// ── 移动端侧栏 ──────────────────────────────────────────────────────────────────
function isMobile() { return window.innerWidth <= 768; }

function openSidebar() {
  closeRightPanel();
  document.querySelector(".sidebar").classList.add("open");
  document.getElementById("sidebar-overlay").classList.remove("hidden");
}

function closeSidebar() {
  document.querySelector(".sidebar").classList.remove("open");
  if (!document.querySelector(".right-panel.open")) {
    document.getElementById("sidebar-overlay").classList.add("hidden");
  }
}

function openRightPanel() {
  closeSidebar();
  document.querySelector(".right-panel").classList.add("open");
  document.getElementById("sidebar-overlay").classList.remove("hidden");
  document.querySelectorAll(".nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "status"));
}

function closeRightPanel() {
  document.querySelector(".right-panel").classList.remove("open");
  if (!document.querySelector(".sidebar.open")) {
    document.getElementById("sidebar-overlay").classList.add("hidden");
  }
  // 关闭面板时把底部导航切回"对话"
  const chatTab = document.querySelector(".nav-tab[data-tab='chat']");
  if (chatTab && !document.querySelector(".sidebar.open")) {
    document.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
    chatTab.classList.add("active");
  }
}

document.getElementById("sidebar-overlay").addEventListener("click", () => {
  closeSidebar();
  closeRightPanel();
});

document.getElementById("btn-hamburger").addEventListener("click", openSidebar);
document.getElementById("rp-close-btn").addEventListener("click", closeRightPanel);

// ── DOM refs ──────────────────────────────────────────────────────────────────
const sessionList = document.getElementById("session-list");
const messages = document.getElementById("messages");
const input = document.getElementById("input");
const btnSend = document.getElementById("btn-send");
const btnNew = document.getElementById("btn-new");
const modalOverlay = document.getElementById("modal-overlay");
const modalMsg = document.getElementById("modal-msg");
const modalYes = document.getElementById("modal-yes");
const modalNo = document.getElementById("modal-no");

const avatarModal = document.getElementById("avatar-modal");
const avatarModalTitle = document.getElementById("avatar-modal-title");
const avatarPreview = document.getElementById("avatar-preview");
const avatarFileInput = document.getElementById("avatar-file-input");
const avatarRemove = document.getElementById("avatar-remove");
const avatarSave = document.getElementById("avatar-save");
const avatarCancel = document.getElementById("avatar-cancel");
const avatarStep1 = document.getElementById("avatar-step1");
const avatarStep2 = document.getElementById("avatar-step2");
const cropCanvas = document.getElementById("crop-canvas");
const cropConfirm = document.getElementById("crop-confirm");
const cropCancelBtn = document.getElementById("crop-cancel");

// ── 头像管理 ──────────────────────────────────────────────────────────────────
const AVATAR_KEYS = { user: "avatar:user", assistant: "avatar:assistant" };
const AVATAR_DEFAULTS = { user: "你", assistant: "?" };
const MOOD_LABELS_SHORT = { neutral: "默认", shy: "害羞", annoyed: "不耐烦", soft: "温柔", flustered: "慌乱", playful: "俏皮", cold: "冷淡", happy: "开心", angry: "生气" };

let currentMood = "neutral"; // 当前情绪，由 refreshMood 维护
let characterName = ""; // 当前角色名，由 loadCharacter 维护

function assistantBaseKey() {
  return characterName ? `avatar:assistant:${characterName}` : "avatar:assistant";
}

function avatarKey(role, mood) {
  if (role === "assistant") {
    const base = assistantBaseKey();
    return mood && mood !== "neutral" ? `${base}:${mood}` : base;
  }
  return AVATAR_KEYS[role] || `avatar:${role}`;
}

function getAvatar(role, mood) {
  if (role === "assistant" && mood && mood !== "neutral") {
    const moodSrc = localStorage.getItem(avatarKey(role, mood));
    if (moodSrc) return moodSrc;
  }
  return localStorage.getItem(role === "assistant" ? assistantBaseKey() : AVATAR_KEYS[role]) || null;
}

function setAvatarEl(el, role, mood) {
  const src = getAvatar(role, mood || (role === "assistant" ? currentMood : null));
  el.innerHTML = "";
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    el.appendChild(img);
  } else {
    el.textContent = AVATAR_DEFAULTS[role];
  }
}

function refreshAllAssistantAvatars() {
  document.querySelectorAll(".bubble-wrap.assistant .avatar").forEach((el) => {
    setAvatarEl(el, "assistant", currentMood);
  });
}

let _avatarEditRole = null;
let _avatarEditMood = null; // null 表示编辑通用头像
let _avatarPending = null;

async function openAvatarModal(role) {
  _avatarEditRole = role;
  _avatarEditMood = null;
  _avatarPending = getAvatar(role);
  avatarModalTitle.textContent = role === "user" ? "更换用户头像" : "更换角色头像";
  renderMoodTabs(role);
  renderAvatarPreview(_avatarPending);
  showStep(1);
  avatarModal.classList.remove("hidden");

  // 如果是角色头像，后台刷新一次情绪头像缓存
  if (role === "assistant") {
    try {
      const av = await api("GET", "/avatars");
      const manualKey = `avatar:manual:${characterName}`;
      const manualSet = new Set(JSON.parse(localStorage.getItem(manualKey) || "[]"));
      for (const [mood, url] of Object.entries(av.avatars || {})) {
        const key = avatarKey("assistant", mood === "neutral" ? null : mood);
        if (!manualSet.has(key)) localStorage.setItem(key, url);
      }
      // 刷新当前选中 tab 的预览
      _avatarPending = getAvatar(role, _avatarEditMood);
      renderAvatarPreview(_avatarPending);
      // 更新 tab 上的可用状态
      document.querySelectorAll(".mood-tab").forEach((btn) => {
        const m = btn.dataset.mood;
        const has = !!getAvatar("assistant", m === "neutral" ? null : m);
        btn.classList.toggle("has-avatar", has);
      });
    } catch {}
  }
}

function renderMoodTabs(role) {
  const existing = document.getElementById("mood-tabs");
  if (existing) existing.remove();
  if (role !== "assistant") return;

  const tabs = document.createElement("div");
  tabs.id = "mood-tabs";
  tabs.className = "mood-tabs";

  const moods = ["neutral", "shy", "annoyed", "soft", "flustered", "playful", "cold", "happy", "angry"];
  for (const mood of moods) {
    const btn = document.createElement("button");
    btn.className = "mood-tab" + (mood === (_avatarEditMood || "neutral") ? " active" : "");
    btn.textContent = MOOD_LABELS_SHORT[mood];
    btn.dataset.mood = mood;
    btn.addEventListener("click", () => {
      _avatarEditMood = mood === "neutral" ? null : mood;
      tabs.querySelectorAll(".mood-tab").forEach((b) => b.classList.toggle("active", b.dataset.mood === mood));
      _avatarPending = getAvatar(role, _avatarEditMood);
      renderAvatarPreview(_avatarPending);
    });
    tabs.appendChild(btn);
  }

  const step1 = document.getElementById("avatar-step1");
  step1.insertBefore(tabs, step1.firstChild);
}

function showStep(n) {
  avatarStep1.classList.toggle("hidden", n !== 1);
  avatarStep2.classList.toggle("hidden", n !== 2);
}

function renderAvatarPreview(src) {
  avatarPreview.innerHTML = "";
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    avatarPreview.appendChild(img);
  } else {
    avatarPreview.textContent = AVATAR_DEFAULTS[_avatarEditRole];
  }
}

// ── 裁剪器 ────────────────────────────────────────────────────────────────────
const CROP_SIZE = 280; // canvas 显示尺寸（与 CSS 一致）
const OUTPUT_SIZE = 256; // 最终输出像素

let _cropImg = null;
let _cropScale = 1;
let _cropX = 0; // 图片左上角在 canvas 中的 x
let _cropY = 0;
let _cropDragging = false;
let _cropDragStartX = 0;
let _cropDragStartY = 0;
let _cropImgX0 = 0;
let _cropImgY0 = 0;

function initCrop(src) {
  const img = new Image();
  img.onload = () => {
    _cropImg = img;
    // 初始缩放：让图片短边充满圆形区域
    const minDim = Math.min(img.naturalWidth, img.naturalHeight);
    _cropScale = CROP_SIZE / minDim;
    // 居中
    _cropX = (CROP_SIZE - img.naturalWidth * _cropScale) / 2;
    _cropY = (CROP_SIZE - img.naturalHeight * _cropScale) / 2;
    cropCanvas.width = CROP_SIZE;
    cropCanvas.height = CROP_SIZE;
    drawCrop();
  };
  img.src = src;
}

function drawCrop() {
  if (!_cropImg) return;
  const ctx = cropCanvas.getContext("2d");
  ctx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
  ctx.drawImage(_cropImg, _cropX, _cropY, _cropImg.naturalWidth * _cropScale, _cropImg.naturalHeight * _cropScale);
}

function cropToDataURL() {
  // 把圆形区域内容输出到 OUTPUT_SIZE 的 canvas
  const out = document.createElement("canvas");
  out.width = OUTPUT_SIZE;
  out.height = OUTPUT_SIZE;
  const ctx = out.getContext("2d");
  // 剪圆
  ctx.beginPath();
  ctx.arc(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, 0, Math.PI * 2);
  ctx.clip();
  // 把 cropCanvas 的内容等比缩放输出
  const ratio = OUTPUT_SIZE / CROP_SIZE;
  ctx.drawImage(cropCanvas, 0, 0, CROP_SIZE, CROP_SIZE, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  return out.toDataURL("image/jpeg", 0.88);
}

// 拖拽
cropCanvas.addEventListener("mousedown", (e) => {
  _cropDragging = true;
  _cropDragStartX = e.clientX;
  _cropDragStartY = e.clientY;
  _cropImgX0 = _cropX;
  _cropImgY0 = _cropY;
});
window.addEventListener("mousemove", (e) => {
  if (!_cropDragging) return;
  _cropX = _cropImgX0 + (e.clientX - _cropDragStartX);
  _cropY = _cropImgY0 + (e.clientY - _cropDragStartY);
  drawCrop();
});
window.addEventListener("mouseup", () => { _cropDragging = false; });

// 触摸拖拽
cropCanvas.addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  _cropDragging = true;
  _cropDragStartX = t.clientX;
  _cropDragStartY = t.clientY;
  _cropImgX0 = _cropX;
  _cropImgY0 = _cropY;
}, { passive: true });
window.addEventListener("touchmove", (e) => {
  if (!_cropDragging) return;
  const t = e.touches[0];
  _cropX = _cropImgX0 + (t.clientX - _cropDragStartX);
  _cropY = _cropImgY0 + (t.clientY - _cropDragStartY);
  drawCrop();
}, { passive: true });
window.addEventListener("touchend", () => { _cropDragging = false; });

// 滚轮缩放（以 canvas 中心为锚点）
cropCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.08 : 0.93;
  const cx = CROP_SIZE / 2;
  const cy = CROP_SIZE / 2;
  _cropX = cx + (_cropX - cx) * factor;
  _cropY = cy + (_cropY - cy) * factor;
  _cropScale *= factor;
  drawCrop();
}, { passive: false });

// ── 头像弹窗事件 ──────────────────────────────────────────────────────────────
avatarFileInput.addEventListener("change", () => {
  const file = avatarFileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    initCrop(e.target.result);
    showStep(2);
  };
  reader.readAsDataURL(file);
  avatarFileInput.value = "";
});

cropConfirm.addEventListener("click", () => {
  _avatarPending = cropToDataURL();
  renderAvatarPreview(_avatarPending);
  showStep(1);
});

cropCancelBtn.addEventListener("click", () => showStep(1));

avatarRemove.addEventListener("click", () => {
  _avatarPending = null;
  renderAvatarPreview(null);
});

avatarSave.addEventListener("click", () => {
  const key = avatarKey(_avatarEditRole, _avatarEditMood);
  if (_avatarPending) {
    localStorage.setItem(key, _avatarPending);
    // 记录为手动设置，防止 loadCharacter 覆盖
    if (_avatarEditRole === "assistant") {
      const manualKey = `avatar:manual:${characterName}`;
      const manualSet = new Set(JSON.parse(localStorage.getItem(manualKey) || "[]"));
      manualSet.add(key);
      localStorage.setItem(manualKey, JSON.stringify([...manualSet]));
    }
  } else {
    localStorage.removeItem(key);
    // 移除手动标记，允许服务端头像重新填充
    if (_avatarEditRole === "assistant") {
      const manualKey = `avatar:manual:${characterName}`;
      const manualSet = new Set(JSON.parse(localStorage.getItem(manualKey) || "[]"));
      manualSet.delete(key);
      localStorage.setItem(manualKey, JSON.stringify([...manualSet]));
    }
  }
  avatarModal.classList.add("hidden");
  if (_avatarEditRole === "assistant") {
    refreshAllAssistantAvatars();
    renderMoodIndicator(currentMood);
    renderRightPanelMood(currentMood);
  } else {
    document.querySelectorAll(`.bubble-wrap.${_avatarEditRole} .avatar`).forEach((el) => {
      setAvatarEl(el, _avatarEditRole);
    });
  }
});

avatarCancel.addEventListener("click", () => {
  avatarModal.classList.add("hidden");
});

// ── 图片灯箱 ─────────────────────────────────────────────────────────────────
const lightbox = document.createElement("div");
lightbox.className = "lightbox hidden";
document.body.appendChild(lightbox);
lightbox.addEventListener("click", () => lightbox.classList.add("hidden"));

function openLightbox(src) {
  lightbox.innerHTML = "";
  const img = document.createElement("img");
  img.src = src;
  lightbox.appendChild(img);
  lightbox.classList.remove("hidden");
}

// ── 自定义弹窗 ────────────────────────────────────────────────────────────────
function showConfirm(msg) {
  return new Promise((resolve) => {
    modalMsg.textContent = msg;
    modalOverlay.classList.remove("hidden");
    const cleanup = (result) => {
      modalOverlay.classList.add("hidden");
      modalYes.removeEventListener("click", onYes);
      modalNo.removeEventListener("click", onNo);
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    modalYes.addEventListener("click", onYes);
    modalNo.addEventListener("click", onNo);
  });
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { location.href = "/auth"; return {}; }
  return res.json();
}

// ── Sessions ──────────────────────────────────────────────────────────────────
// ── 右键菜单 ──────────────────────────────────────────────────────────────────
const ctxMenu = document.createElement("div");
ctxMenu.id = "ctx-menu";
ctxMenu.className = "ctx-menu hidden";
document.body.appendChild(ctxMenu);

async function saveSessionToMemory(sessionId) {
  const res = await api("POST", `/sessions/${sessionId}/ingest`);
  if (res.skipped) {
    showToast("该对话没有内容");
  } else if (res.ok) {
    showToast("已保存到记忆库");
  } else {
    showToast("保存失败");
  }
}

function showContextMenu(x, y, sessionId) {
  ctxMenu.innerHTML = "";
  const item = document.createElement("button");
  item.textContent = "保存到记忆库";
  item.addEventListener("click", async () => {
    hideContextMenu();
    await saveSessionToMemory(sessionId);
  });
  ctxMenu.appendChild(item);

  // 避免超出视口
  ctxMenu.classList.remove("hidden");
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
  ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
}

function hideContextMenu() {
  ctxMenu.classList.add("hidden");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest("#ctx-menu") && !e.target.closest("#session-list li")) {
    hideContextMenu();
  }
});
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("#session-list li")) hideContextMenu();
});

// ── Toast 提示 ────────────────────────────────────────────────────────────────
let _toastTimer = null;
const toast = document.createElement("div");
toast.id = "toast";
toast.className = "toast hidden";
document.body.appendChild(toast);

function showToast(msg, isHtml = false, duration = 3000) {
  if (isHtml) {
    toast.innerHTML = msg;
  } else {
    toast.textContent = msg;
  }
  toast.classList.remove("hidden");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.add("hidden"), duration);
}

async function loadSessions() {
  const [sessions, charInfo] = await Promise.all([
    api("GET", "/sessions"),
    api("GET", "/character").catch(() => ({}))
  ]);
  renderSessionList(sessions, charInfo?.name || "");
  if (sessions.length > 0) {
    const restoredExists = currentSessionId && sessions.some((s) => s.id === currentSessionId);
    const needsLoad = !document.querySelector("#messages .message, #messages .empty-hint");
    if (restoredExists && needsLoad) {
      await selectSession(currentSessionId);
    } else if (!restoredExists) {
      await selectSession(sessions[0].id);
    }
  }
}

function renderSessionList(sessions, activeCharName = "") {
  sessionList.innerHTML = "";
  _sessionsMap.clear();
  for (const s of sessions) _sessionsMap.set(s.id, s);

  // 读取折叠状态
  let expandedChars;
  try { expandedChars = new Set(JSON.parse(localStorage.getItem("charGroupExpanded") || "[]")); }
  catch { expandedChars = new Set(); }

  // 确定当前会话所在角色
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const currentChar = currentSession?.character_name || activeCharName || "";

  // 按角色分组
  const groups = new Map(); // charName -> sessions[]
  for (const s of sessions) {
    const key = s.character_name || activeCharName || "未知角色";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  // 分组排序：当前角色排第一，其余按最新会话时间
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === currentChar) return -1;
    if (b === currentChar) return 1;
    return 0;
  });

  for (const [charName, charSessions] of sortedGroups) {
    const isCurrentGroup = charName === currentChar;
    const isExpanded = isCurrentGroup || expandedChars.has(charName);

    // 分组标题
    const header = document.createElement("li");
    header.className = "char-group-header" + (isExpanded ? "" : " collapsed");
    header.dataset.char = charName;
    header.innerHTML = `
      <span class="char-group-name">${charName}</span>
      <span class="char-group-count">${charSessions.length}</span>
      <svg class="char-group-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    `;
    header.addEventListener("click", () => {
      const collapsed = header.classList.toggle("collapsed");
      subList.classList.toggle("collapsed", collapsed);
      // 更新 localStorage
      try {
        const set = new Set(JSON.parse(localStorage.getItem("charGroupExpanded") || "[]"));
        if (collapsed) set.delete(charName); else set.add(charName);
        localStorage.setItem("charGroupExpanded", JSON.stringify([...set]));
      } catch {}
    });

    // 子会话列表
    const subList = document.createElement("ul");
    subList.className = "char-group-sessions" + (isExpanded ? "" : " collapsed");

    for (const s of charSessions) {
      const li = document.createElement("li");
      li.dataset.id = s.id;
      if (s.id === currentSessionId) li.classList.add("active");

      const title = document.createElement("div");
      title.className = "sl-title";
      title.textContent = s.title || "新对话";

      const preview = document.createElement("div");
      preview.className = "sl-preview";
      preview.textContent = s.last_message || "";

      const del = document.createElement("button");
      del.className = "del-btn";
      del.textContent = "×";
      del.title = "删除";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        const save = await showConfirm("归档前，要把这段对话存入记忆库吗？");
        if (save) await api("POST", `/sessions/${s.id}/ingest`);
        await api("DELETE", `/sessions/${s.id}`);
        if (currentSessionId === s.id) {
          currentSessionId = null;
          try { localStorage.removeItem("lastSessionId"); } catch {}
          messages.innerHTML = "";
        }
        await loadSessions();
      });

      li.appendChild(title);
      li.appendChild(preview);
      li.appendChild(del);
      li.addEventListener("click", (e) => {
        if (e.target.closest(".del-btn")) return;
        selectSession(s.id);
      });
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, s.id);
      });
      subList.appendChild(li);
    }

    sessionList.appendChild(header);
    sessionList.appendChild(subList);
  }
}

async function selectSession(id) {
  currentSessionId = id;
  try { localStorage.setItem("lastSessionId", String(id)); } catch {}
  document.querySelectorAll("#session-list li").forEach((li) => {
    if (!li.dataset.id) return;
    li.classList.toggle("active", Number(li.dataset.id) === id);
  });
  // 确保目标会话所在分组展开
  const targetLi = document.querySelector(`#session-list li[data-id="${id}"]`);
  if (targetLi) {
    const subList = targetLi.closest(".char-group-sessions");
    if (subList && subList.classList.contains("collapsed")) {
      subList.classList.remove("collapsed");
      const header = subList.previousElementSibling;
      if (header) {
        header.classList.remove("collapsed");
        const charName = header.dataset.char;
        try {
          const set = new Set(JSON.parse(localStorage.getItem("charGroupExpanded") || "[]"));
          set.add(charName);
          localStorage.setItem("charGroupExpanded", JSON.stringify([...set]));
        } catch {}
      }
    }
  }
  if (isMobile()) {
    closeSidebar();
    closeRightPanel();
  }
  // 切换会话时关闭自动模式
  if (autoModeEnabled) setAutoMode(false);
  if (semiAutoEnabled) setSemiAutoMode(false);
  suggestionsGen++;
  // 自动切换到该会话对应的角色
  const targetSession = _sessionsMap.get(id);
  const targetCharName = targetSession?.character_name;
  if (targetCharName && targetCharName !== characterName) {
    try {
      const chars = await api("GET", "/characters");
      const match = chars?.find((c) => c.name === targetCharName);
      if (match && !match.is_active) {
        await api("PATCH", `/characters/${match.id}`, { is_active: true });
        await loadCharacter();
      }
    } catch {}
  }
  await loadMessages(id);
  connectEvents(id);
  refreshMood(id);
}

async function newSession() {
  const s = await api("POST", "/sessions", { title: "新对话" });
  currentSessionId = s.id;
  try { localStorage.setItem("lastSessionId", String(s.id)); } catch {}
  await loadSessions();
  messages.innerHTML = `<div class="empty-hint">开始聊天吧</div>`;
  input.focus();
}

// ── Messages ──────────────────────────────────────────────────────────────────
async function loadMessages(sessionId) {
  const msgs = await api("GET", `/sessions/${sessionId}/messages`);
  allMessages = msgs.filter((m) => {
    if (m.role === "system") return false;
    if (m.content.startsWith("（") && m.content.endsWith("）")) return false;
    return true;
  });
  messages.innerHTML = "";
  if (allMessages.length === 0) {
    messages.innerHTML = `<div class="empty-hint">开始聊天吧</div>`;
    return;
  }
  const start = Math.max(0, allMessages.length - PAGE_SIZE);
  if (start > 0) {
    const loadMore = document.createElement("div");
    loadMore.className = "load-more";
    loadMore.dataset.offset = start;
    loadMore.innerHTML = `<button>查看更早的消息（${start} 条）</button>`;
    loadMore.querySelector("button").addEventListener("click", () => loadOlderMessages(loadMore));
    messages.appendChild(loadMore);
  }
  for (const m of allMessages.slice(start)) {
    const text = m.content === "[图片]" ? "" : m.content;
    appendBubble(m.role, text, "", m.image_url || null, m.id, m.created_at, m.tts_audio_url || null);
  }
  // 用最近一张图片作为背景
  const lastImg = [...allMessages].reverse().find((m) => m.image_url);
  setChatBackground(lastImg?.image_url || null);
  scrollToBottom();
}

function loadOlderMessages(loadMoreEl) {
  const currentOffset = Number(loadMoreEl.dataset.offset);
  const newStart = Math.max(0, currentOffset - PAGE_SIZE);
  const slice = allMessages.slice(newStart, currentOffset);
  const firstExisting = loadMoreEl.nextSibling;
  for (let i = slice.length - 1; i >= 0; i--) {
    const m = slice[i];
    const text = m.content === "[图片]" ? "" : m.content;
    const bubble = appendBubble(m.role, text, "", m.image_url || null, m.id, m.created_at, m.tts_audio_url || null);
    const wrap = bubble.closest(".bubble-wrap");
    messages.insertBefore(wrap, firstExisting);
  }
  if (newStart === 0) {
    loadMoreEl.remove();
  } else {
    loadMoreEl.dataset.offset = newStart;
    loadMoreEl.querySelector("button").textContent = `查看更早的消息（${newStart} 条）`;
  }
}

function appendBubble(role, content, extraClass = "", imageUrl = null, msgId = null, createdAt = null, audioUrl = null) {
  const empty = messages.querySelector(".empty-hint");
  if (empty) empty.remove();

  const isCallMsg = role === "assistant" && (content.startsWith("📞 ") || content.startsWith("📱 "));
  const callType = content.startsWith("📞 ") ? "call" : content.startsWith("📱 ") ? "voicemail" : null;

  const wrap = document.createElement("div");
  wrap.className = `bubble-wrap ${role}`;
  if (msgId) wrap.dataset.msgId = msgId;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  setAvatarEl(avatar, role, role === "assistant" ? currentMood : null);
  avatar.title = "点击更换头像";
  avatar.addEventListener("click", () => openAvatarModal(role));

  const bubble = document.createElement("div");
  if (isCallMsg) {
    bubble.className = `bubble bubble-call bubble-call-${callType} ${extraClass}`;
    const icon = callType === "call" ? "📞" : "📱";
    const label = callType === "call" ? "来电" : "语音留言";
    // 解析接听状态前缀：[已接听] / [未接听]
    let statusTag = "";
    let bodyText = content.slice(3);
    const statusMatch = bodyText.match(/^\[(已接听|未接听)\] /);
    if (statusMatch) {
      const answered = statusMatch[1] === "已接听";
      statusTag = `<span class="call-msg-status ${answered ? "answered" : "missed"}">${statusMatch[1]}</span>`;
      bodyText = bodyText.slice(statusMatch[0].length);
    }
    const replayBtn = audioUrl ? `<button class="call-msg-replay" title="重播">▶</button>` : "";
    bubble.innerHTML = `<div class="call-msg-header"><span class="call-msg-icon">${icon}</span><span class="call-msg-label">${label}</span>${statusTag}${replayBtn}</div><div class="call-msg-body">${renderBubbleText(bodyText)}</div>`;
    if (audioUrl) {
      bubble.querySelector(".call-msg-replay").addEventListener("click", () => {
        if (_currentTtsAudio) { _currentTtsAudio.pause(); _currentTtsAudio = null; }
        const a = new Audio(audioUrl);
        _currentTtsAudio = a;
        a.play();
      });
    }
  } else {
    bubble.className = `bubble ${extraClass}`;
    bubble.innerHTML = renderBubbleText(content);
  }

  if (imageUrl) {
    appendImageToBubble(bubble, imageUrl);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);

  // 助手消息加重新生成按钮（电话气泡不加）
  if (role === "assistant" && msgId && !isCallMsg) {
    const regenBtn = document.createElement("button");
    regenBtn.className = "btn-regen";
    regenBtn.title = "重新生成";
    regenBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
    regenBtn.addEventListener("click", () => regenMessage(msgId, wrap));
    wrap.appendChild(regenBtn);
  }

  // 所有消息加删除按钮
  if (msgId) addDelBtn(wrap, msgId);

  messages.appendChild(wrap);

  if (audioUrl && role === "assistant") {
    attachTtsPlayer(msgId, audioUrl, false, wrap);
  }

  return bubble;
}

function addDelBtn(wrap, msgId) {
  if (wrap.querySelector(".btn-del-msg")) return;
  const delBtn = document.createElement("button");
  delBtn.className = "btn-del-msg";
  delBtn.title = "删除这条消息";
  delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
  delBtn.addEventListener("click", async () => {
    await api("DELETE", `/messages/${msgId}/single`);
    allMessages = allMessages.filter((m) => m.id !== msgId);
    wrap.remove();
  });
  wrap.appendChild(delBtn);
}

function appendImageToBubble(bubble, src) {
  if (bubble.querySelector("img.bubble-img, .img-toggle-btn")) return;
  if (isMobile() || window._imageAutoExpand) {
    const img = document.createElement("img");
    img.className = "bubble-img";
    img.src = src;
    img.addEventListener("click", () => openLightbox(src));
    bubble.appendChild(img);
    return;
  }
  // 桌面端折叠，点击展开图片并设为背景
  const toggle = document.createElement("button");
  toggle.className = "img-toggle-btn";
  toggle.textContent = "查看照片";
  toggle.addEventListener("click", () => {
    toggle.remove();
    const img = document.createElement("img");
    img.className = "bubble-img";
    img.src = src;
    img.addEventListener("click", () => openLightbox(src));
    bubble.appendChild(img);
    setChatBackground(src);
    scrollToBottom();
  });
  bubble.appendChild(toggle);
}

function appendImageLoading(bubble) {
  const el = document.createElement("div");
  el.className = "img-loading";
  el.innerHTML = '<div class="spinner"></div><span>拍照中…</span>';
  bubble.appendChild(el);
  return el;
}

function pollForImage(msgId, bubble, { silent = false } = {}) {
  const loading = silent ? null : appendImageLoading(bubble);
  if (!silent) scrollToBottom();
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`/messages/${msgId}/image`);
      const data = await res.json();
      if (data.status === "ready") {
        clearInterval(timer);
        if (loading) loading.remove();
        appendImageToBubble(bubble, data.url);
        setChatBackground(data.url);
        scrollToBottom();
      } else if (data.status === "none") {
        clearInterval(timer);
        if (loading) loading.remove();
      }
    } catch {
      // 网络错误时继续轮询
    }
  }, 3000);
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function doStream(sessionId, text, replyBubble) {
  const res = await fetch(`/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text })
  });
  if (!res.ok) {
    if (res.status === 401) { location.href = "/auth"; return; }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let fullText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = JSON.parse(line.slice(6));
      if (payload.error) throw new Error(payload.error);
      if (payload.text && !payload.done) {
        // 普通流式文字块
        replyBubble.classList.remove("thinking");
        const dots = replyBubble.querySelector(".typing-dots");
        if (dots) dots.remove();
        fullText += payload.text;
        replyBubble.innerHTML = renderBubbleText(fullText);
        scrollToBottom();
      }
      if (payload.done) {
        if (payload.skip_reply) {
          // 情绪来电：保留气泡显示"来电中…"，等 incoming_call 到达后移除
          replyBubble.classList.remove("thinking");
          replyBubble.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
          _pendingCallBubble = replyBubble.closest(".bubble-wrap");
          return;
        }
        if (payload.msg_id) {
          const wrap = replyBubble.closest(".bubble-wrap");
          if (wrap && !wrap.dataset.msgId) {
            wrap.dataset.msgId = payload.msg_id;
            const regenBtn = document.createElement("button");
            regenBtn.className = "btn-regen";
            regenBtn.title = "重新生成";
            regenBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
            regenBtn.addEventListener("click", () => regenMessage(payload.msg_id, wrap));
            wrap.appendChild(regenBtn);
            addDelBtn(wrap, payload.msg_id);
          }
        }
        if (payload.user_msg_id) {
          const userWraps = [...messages.querySelectorAll(".bubble-wrap.user:not([data-msg-id])")];
          const userWrap = userWraps[userWraps.length - 1];
          if (userWrap) {
            userWrap.dataset.msgId = payload.user_msg_id;
            addDelBtn(userWrap, payload.user_msg_id);
          }
        }
        if (payload.image_pending && payload.msg_id) {
          fullText = fullText.replace(/\[IMG:\s*.+?\]\s*$/, "").trimEnd();
          replyBubble.innerHTML = renderBubbleText(fullText);
          pollForImage(payload.msg_id, replyBubble, { silent: !!payload.image_silent });
        }
      }
    }
  }
}

async function sendMessage() {
  if (sending) return;
  const text = input.value.trim();
  if (!text) return;
  if (!currentSessionId) await newSession();

  sending = true;
  suggestionsGen++;
  btnSend.disabled = true;
  input.value = "";
  autoResize();
  removeSuggestions();

  appendBubble("user", text, "", null, null, new Date().toISOString());
  const replyBubble = appendBubble("assistant", "", "thinking");
  // 打字动画
  replyBubble.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
  scrollToBottom();

  try {
    await doStream(currentSessionId, text, replyBubble);
    await loadSessions();
    // 情绪更新是异步的，稍等后再取
    setTimeout(() => refreshMood(currentSessionId), 1500);
    // 自动模式：角色回复完毕后延迟触发下一轮用户消息
    if (autoModeEnabled && currentSessionId) {
      scheduleAutoReply();
    }
    // 半自动模式：角色回复完毕后展示回复选项
    if (semiAutoEnabled && currentSessionId) {
      showReplySuggestions();
    }
  } catch (err) {
    // 网络错误时重试一次
    if (err.message.includes("fetch") || err.message.includes("network") || err.message.includes("Failed")) {
      try {
        replyBubble.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
        replyBubble.textContent = "";
        await doStream(currentSessionId, text, replyBubble);
        await loadSessions();
        return;
      } catch {}
    }
    replyBubble.innerHTML = "";
    replyBubble.textContent = `发送失败：${err.message}`;
    replyBubble.classList.remove("thinking");
  } finally {
    sending = false;
    btnSend.disabled = false;
    scrollToBottom();
    input.focus({ preventScroll: true });
  }
}

// ── 自动模式 ──────────────────────────────────────────────────────────────────
function scheduleAutoReply() {
  clearTimeout(autoModeTimer);
  // 随机 2~5 秒延迟，模拟真实打字节奏
  const delay = 2000 + Math.random() * 3000;
  autoModeTimer = setTimeout(async () => {
    if (!autoModeEnabled || !currentSessionId || sending) return;
    try {
      const data = await api("POST", `/sessions/${currentSessionId}/auto-user-message`);
      if (!data.ok || !data.text) return;
      input.value = data.text;
      await sendMessage();
    } catch {}
  }, delay);
}

function setAutoMode(enabled) {
  autoModeEnabled = enabled;
  if (!enabled) {
    clearTimeout(autoModeTimer);
    autoModeTimer = null;
  }
  const btn = document.getElementById("btn-auto-mode");
  btn.classList.toggle("active", enabled);
  btn.title = enabled ? "关闭自动模式" : "自动模式";
  if (currentSessionId) {
    api("PATCH", `/sessions/${currentSessionId}/settings`, { auto_mode: enabled ? 1 : 0 }).catch(() => {});
  }
}

document.getElementById("btn-auto-mode").addEventListener("click", () => {
  setAutoMode(!autoModeEnabled);
  if (autoModeEnabled && currentSessionId && !sending) {
    scheduleAutoReply();
  }
});

// ── 半自动模式 ────────────────────────────────────────────────────────────────
function setSemiAutoMode(enabled) {
  semiAutoEnabled = enabled;
  if (!enabled) removeSuggestions();
  const btn = document.getElementById("btn-semi-auto");
  btn.classList.toggle("active", enabled);
  btn.title = enabled ? "关闭半自动模式" : "半自动模式";
}

function removeSuggestions() {
  document.getElementById("reply-suggestions")?.remove();
}

async function showReplySuggestions() {
  removeSuggestions();
  const sessionId = currentSessionId;
  const gen = suggestionsGen;
  let data;
  try {
    data = await api("GET", `/sessions/${sessionId}/reply-suggestions`);
  } catch (e) {
    console.error("reply-suggestions error:", e);
    return;
  }
  if (gen !== suggestionsGen || sending || !data?.suggestions?.length || !semiAutoEnabled || currentSessionId !== sessionId) return;

  const bar = document.createElement("div");
  bar.id = "reply-suggestions";
  bar.className = "reply-suggestions";
  for (const text of data.suggestions) {
    const btn = document.createElement("button");
    btn.className = "suggestion-btn";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      removeSuggestions();
      input.value = text;
      sendMessage();
    });
    bar.appendChild(btn);
  }
  const messagesEl = document.getElementById("messages");
  messagesEl.appendChild(bar);
  scrollToBottom();
}

document.getElementById("btn-semi-auto").addEventListener("click", () => {
  // 半自动和全自动互斥
  if (autoModeEnabled) setAutoMode(false);
  setSemiAutoMode(!semiAutoEnabled);
});

// ── 关闭窗口时询问 ─────────────────────────────────────────────────────────────
window.addEventListener("beforeunload", (e) => {
  if (!currentSessionId) return;
  // 触发浏览器原生"离开页面"提示，同时异步弹出自定义弹窗
  // 注意：beforeunload 里无法 await，所以用 beacon 发请求
  e.preventDefault();
  e.returnValue = "";
});

// pagehide / visibilitychange 做实际的存入询问
// 用 visibilitychange hidden 来捕捉"关闭/切走"，此时还能展示弹窗
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "hidden") return;
  if (document.fullscreenElement) return;
  if (!currentSessionId) return;
  // 存一个标记，避免重复触发
  if (sessionStorage.getItem("saving")) return;
  sessionStorage.setItem("saving", "1");

  // visibilitychange hidden 时 UI 仍然可以渲染弹窗
  const save = await showConfirm("要把这段对话存入记忆库吗？");
  if (save) {
    // 用 sendBeacon 保证页面关闭时请求也能发出
    navigator.sendBeacon(`/sessions/${currentSessionId}/ingest`);
  }
  sessionStorage.removeItem("saving");
});

// ── 输入框自动撑高 ─────────────────────────────────────────────────────────────
function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}

input.addEventListener("input", autoResize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

btnSend.addEventListener("click", sendMessage);
btnNew.addEventListener("click", newSession);

// ── 生成场景插图 ──────────────────────────────────────────────────────────────
const btnSceneImage = document.getElementById("btn-scene-image");
let _sceneImagePendingMsgId = null;

btnSceneImage.addEventListener("click", async () => {
  if (!currentSessionId || sending || _sceneImagePendingMsgId !== null) return;
  btnSceneImage.disabled = true;
  try {
    const res = await fetch(API + `/sessions/${currentSessionId}/scene-image`, { method: "POST" });
    if (res.status === 429) {
      const err = await res.json().catch(() => ({}));
      const limit = err.limit ?? "N";
      showToast(`今日插图已达上限（${limit} 张）`);
      btnSceneImage.disabled = false;
      return;
    }
    const data = await res.json();
    if (data?.msg_id) {
      _sceneImagePendingMsgId = data.msg_id;
      let wrap = messages.querySelector(`[data-msg-id="${data.msg_id}"]`);
      if (!wrap) {
        const bubble = appendBubble("assistant", "", null, null, data.msg_id, new Date().toISOString());
        wrap = bubble.closest(".bubble-wrap");
      }
      const bubble = wrap?.querySelector(".bubble");
      if (bubble && !bubble.querySelector(".img-loading")) {
        appendImageLoading(bubble);
        scrollToBottom();
      }
    } else {
      btnSceneImage.disabled = false;
    }
  } catch {
    btnSceneImage.disabled = false;
  }
});

// ── 用户发图 ─────────────────────────────────────────────────────────────────
const imgInput = document.getElementById("img-input");
imgInput.addEventListener("change", async () => {
  const file = imgInput.files[0];
  imgInput.value = "";
  if (!file) return;
  if (!currentSessionId) await newSession();

  // 先显示"传输中"占位气泡
  const bubble = appendBubble("user", "传输中…", "thinking");
  scrollToBottom();

  try {
    const res = await fetch(`/sessions/${currentSessionId}/image`, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "上传失败");
    // 识别完成后替换为实际图片
    bubble.textContent = "";
    bubble.classList.remove("thinking");
    appendImageToBubble(bubble, data.image_url);
    setChatBackground(data.image_url);
    const wrap = bubble.closest(".bubble-wrap");
    if (wrap) wrap.dataset.msgId = data.msg_id;
    scrollToBottom();
    await loadSessions();
  } catch (err) {
    bubble.textContent = `发送失败：${err.message}`;
    bubble.classList.remove("thinking");
    showToast(`图片发送失败：${err.message}`);
  }
});

// ── 重新生成 ──────────────────────────────────────────────────────────────────
async function regenImage(msgId, bubble, triggerEl) {
  if (triggerEl) { triggerEl.disabled = true; triggerEl.textContent = "重试中…"; }
  try {
    await fetch(`/messages/${msgId}/image`, { method: "POST" });
    if (triggerEl) triggerEl.remove();
    appendImageLoading(bubble);
    scrollToBottom();
  } catch {
    if (triggerEl) { triggerEl.disabled = false; triggerEl.textContent = "图片生成失败，点击重试"; }
  }
}

async function regenMessage(msgId, wrapEl) {
  // 找到这条消息前面的最后一条用户消息内容
  const allWraps = [...messages.querySelectorAll(".bubble-wrap")];
  const idx = allWraps.indexOf(wrapEl);
  let userText = "";
  for (let i = idx - 1; i >= 0; i--) {
    if (allWraps[i].classList.contains("user")) {
      userText = allWraps[i].querySelector(".bubble")?.textContent || "";
      break;
    }
  }
  if (!userText) return;

  // 删除服务端这条消息及之后的所有消息
  await fetch(`/messages/${msgId}`, { method: "DELETE" });

  // 删除 DOM 里这条及之后的所有 assistant/user 气泡（保留用户那条，重新发送）
  for (let i = allWraps.length - 1; i >= idx; i--) {
    allWraps[i].remove();
  }

  // 重新发送用户消息
  input.value = userText;
  sendMessage();
}

// ── WebSocket 推送 ────────────────────────────────────────────────────────────
let _ws = null;
let _wsSessionId = null;
let _wsReconnectTimer = null;
let _wsReconnectDelay = 1000;

function handleWsPayload(payload) {
  if (payload.proactive) {
    const bubble = appendBubble("assistant", payload.text, "", null, payload.msg_id, new Date().toISOString());
    if (payload.image_pending && payload.msg_id) {
      pollForImage(payload.msg_id, bubble, { silent: true });
    }
    scrollToBottom();
  }
  if (payload.image_ready && payload.msg_id && payload.url) {
    if (payload.msg_id === _sceneImagePendingMsgId) {
      _sceneImagePendingMsgId = null;
      btnSceneImage.disabled = false;
    }
    const wrap = messages.querySelector(`[data-msg-id="${payload.msg_id}"]`);
    if (wrap) {
      const bubble = wrap.querySelector(".bubble");
      const loading = bubble?.querySelector(".img-loading");
      if (loading) loading.remove();
      if (!bubble?.querySelector("img.bubble-img, .img-toggle-btn")) {
        appendImageToBubble(bubble, payload.url);
        setChatBackground(payload.url);
        scrollToBottom();
      }
    }
  }
  if (payload.image_failed && payload.msg_id) {
    if (payload.msg_id === _sceneImagePendingMsgId) {
      _sceneImagePendingMsgId = null;
      btnSceneImage.disabled = false;
    }
    const wrap = messages.querySelector(`[data-msg-id="${payload.msg_id}"]`);
    if (wrap) {
      const bubble = wrap.querySelector(".bubble");
      const loading = bubble?.querySelector(".img-loading");
      if (loading) loading.remove();
      if (!bubble?.querySelector(".img-retry-btn")) {
        const retryBtn = document.createElement("button");
        retryBtn.className = "img-retry-btn";
        retryBtn.textContent = "图片生成失败，点击重试";
        retryBtn.addEventListener("click", () => regenImage(payload.msg_id, bubble, retryBtn));
        bubble?.appendChild(retryBtn);
      }
    }
  }
  if (payload.card_update && payload.card_url) {
    renderCharacterCard(payload.card_url);
    const btn = document.getElementById("rp-card-regen");
    if (btn) btn.disabled = false;
  }
  if (payload.mood_update && payload.mood) {
    if (payload.avatar_url) {
      const key = avatarKey("assistant", payload.mood);
      localStorage.setItem(key, payload.avatar_url);
    }
    currentMood = payload.mood;
    refreshAllAssistantAvatars();
    renderMoodIndicator(payload.mood);
    renderRightPanelMood(payload.mood);
    renderRightPanelAvatar();
  }
  if (payload.affection_update) {
    renderAffection(payload.affection, payload.delta);
  }
  if (payload.achievement_unlock) {
    showAchievementModal(payload);
  }
  if (payload.relation_milestone) {
    showRelationMilestoneModal(payload);
  }
  if (payload.tts) {
    attachTtsPlayer(payload.msg_id, payload.audio_url);
  }
  if (payload.tts_stream_start) {
    ttsStreamStart(payload.msg_id);
  }
  if (payload.tts_chunk) {
    ttsStreamChunk(payload.msg_id, payload.data);
  }
  if (payload.tts_stream_end) {
    ttsStreamEnd(payload.msg_id, payload.audio_url);
  }
  if (payload.incoming_call) {
    if (payload.session_id && payload.session_id !== currentSessionId) return;
    if (_pendingCallBubble) { _pendingCallBubble.remove(); _pendingCallBubble = null; }
    showIncomingCall(payload);
  }
}

function showIncomingCall(data) {
  if (document.getElementById("call-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "call-overlay";
  overlay.className = "call-overlay";

  const phone = document.createElement("div");
  phone.className = "call-phone";

  // 状态栏
  const statusbar = document.createElement("div");
  statusbar.className = "call-statusbar";

  const carrier = document.createElement("div");
  carrier.className = "call-statusbar-carrier";
  carrier.textContent = "中国移动";

  const sbRight = document.createElement("div");
  sbRight.className = "call-statusbar-right";

  const timeEl = document.createElement("div");
  timeEl.className = "call-statusbar-time";
  function updateTime() {
    const now = new Date();
    timeEl.textContent = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  }
  updateTime();
  const timeTick = setInterval(updateTime, 10000);

  const signal = document.createElement("div");
  signal.className = "call-signal";
  for (let i = 0; i < 4; i++) signal.appendChild(document.createElement("span"));

  const battKey = `call_batt_${currentSessionId}`;
  const lastCallTs = parseInt(localStorage.getItem(battKey) || "0", 10);
  const minutesElapsed = lastCallTs ? Math.floor((Date.now() - lastCallTs) / 60000) : 0;
  // 每分钟随机下降 1~2%，最低 20%
  const seed = (currentSessionId || 0) % 7;
  const drain = minutesElapsed * (1 + (seed % 2));
  const battPctVal = Math.max(20, 96 - drain);
  localStorage.setItem(battKey, String(Date.now()));

  const battery = document.createElement("div");
  battery.className = "call-battery";
  const battIcon = document.createElement("div");
  battIcon.className = "call-battery-icon";
  const battFill = document.createElement("div");
  battFill.className = "call-battery-fill";
  battFill.style.width = `${battPctVal}%`;
  battIcon.appendChild(battFill);
  const battPct = document.createElement("span");
  battPct.textContent = `${battPctVal}%`;
  battery.appendChild(battIcon);
  battery.appendChild(battPct);

  sbRight.appendChild(timeEl);
  sbRight.appendChild(signal);
  sbRight.appendChild(battery);
  statusbar.appendChild(carrier);
  statusbar.appendChild(sbRight);

  const avatar = document.createElement("div");
  avatar.className = "call-avatar";
  const avatarSrc = getAvatar("assistant", currentMood);
  if (avatarSrc) {
    const img = document.createElement("img");
    img.src = avatarSrc;
    avatar.appendChild(img);
  } else {
    avatar.textContent = (data.char_name || "?")[0];
  }

  const charName = document.createElement("div");
  charName.className = "call-char-name";
  charName.textContent = data.char_name || "";

  const status = document.createElement("div");
  status.className = "call-status";
  status.textContent = "来电中…";

  const subtitle = document.createElement("div");
  subtitle.className = "call-subtitle";
  subtitle.style.display = "none";

  const actions = document.createElement("div");
  actions.className = "call-actions";

  const declineWrap = document.createElement("div");
  declineWrap.className = "call-btn-wrap";
  const declineBtn = document.createElement("button");
  declineBtn.className = "call-btn call-btn-decline";
  declineBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform:rotate(135deg)"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.13 19.13 0 0 1 4.26 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.17 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.15 8.91a16 16 0 0 0 6.61 6.61l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
  const declineLabel = document.createElement("span");
  declineLabel.className = "call-btn-label";
  declineLabel.textContent = "挂断";
  declineWrap.appendChild(declineBtn);
  declineWrap.appendChild(declineLabel);

  const acceptWrap = document.createElement("div");
  acceptWrap.className = "call-btn-wrap";
  const acceptBtn = document.createElement("button");
  acceptBtn.className = "call-btn call-btn-accept";
  acceptBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.13 19.13 0 0 1 4.26 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.17 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.15 8.91a16 16 0 0 0 6.61 6.61l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
  const acceptLabel = document.createElement("span");
  acceptLabel.className = "call-btn-label";
  acceptLabel.textContent = "接听";
  acceptWrap.appendChild(acceptBtn);
  acceptWrap.appendChild(acceptLabel);

  actions.appendChild(declineWrap);
  actions.appendChild(acceptWrap);
  phone.appendChild(statusbar);
  phone.appendChild(avatar);
  phone.appendChild(charName);
  phone.appendChild(status);
  phone.appendChild(subtitle);
  phone.appendChild(actions);
  overlay.appendChild(phone);
  document.body.appendChild(overlay);

  // 铃声，最多响 10 次
  const ring = new Audio("https://acgay.oss-cn-hangzhou.aliyuncs.com/tornado/audio/ring2.mp3");
  let ringCount = 0;
  ring.play().catch(() => {});
  ring.onended = () => {
    ringCount++;
    if (ringCount >= 10) {
      // 未接听 → 通知后端留语音留言
      if (data.call_log_id) api("POST", `/call-logs/${data.call_log_id}/missed`).catch(() => {});
      close();
    } else {
      ring.play().catch(() => {});
    }
  };

  let callAudio = null;

  function updateBubbleStatus(answered) {
    if (!data.msg_id) return;
    const wrap = document.querySelector(`.bubble-wrap[data-msg-id="${data.msg_id}"]`);
    if (!wrap) return;
    const header = wrap.querySelector(".call-msg-header");
    if (!header) return;
    let tag = header.querySelector(".call-msg-status");
    if (!tag) {
      tag = document.createElement("span");
      const replay = header.querySelector(".call-msg-replay");
      header.insertBefore(tag, replay || null);
    }
    tag.className = `call-msg-status ${answered ? "answered" : "missed"}`;
    tag.textContent = answered ? "已接听" : "未接听";
  }

  function close() {
    clearInterval(timeTick);
    ring.pause();
    ring.onended = null;
    if (callAudio) { callAudio.pause(); callAudio = null; }
    overlay.remove();
    // 通话结束后追加气泡（若当前会话匹配）
    if (data.session_id === currentSessionId && data.script && data.msg_id) {
      const existing = document.querySelector(`.bubble-wrap[data-msg-id="${data.msg_id}"]`);
      if (!existing) {
        appendBubble("assistant", `📞 [未接听] ${data.script}`, "", null, data.msg_id, new Date().toISOString(), data.audio_url || null);
        scrollToBottom();
      } else {
        updateBubbleStatus(false);
      }
    }
  }

  declineBtn.addEventListener("click", close);

  acceptBtn.addEventListener("click", () => {
    ring.pause();
    ring.onended = null;
    status.textContent = "通话中…";
    acceptWrap.style.display = "none";
    actions.classList.add("in-call");
    if (data.call_log_id) api("POST", `/call-logs/${data.call_log_id}/answer`).catch(() => {});
    updateBubbleStatus(true);

    // 通话计时
    let callSeconds = 0;
    const callTimer = setInterval(() => {
      callSeconds++;
      const m = String(Math.floor(callSeconds / 60)).padStart(2, "0");
      const s = String(callSeconds % 60).padStart(2, "0");
      status.textContent = `${m}:${s}`;
    }, 1000);

    // 显示字幕（日语模式或重播时显示中文原文，去除括号内容）
    const cleanScript = (data.script || "")
      .replace(/[（(][^）)]{0,80}[）)]/g, "")
      .replace(/[【\[][^\]】]{0,80}[\]】]/g, "")
      .replace(/\s{2,}/g, " ").trim();
    if ((data.tts_lang === "ja" || data.show_subtitle) && cleanScript) {
      subtitle.textContent = cleanScript;
      subtitle.style.display = "block";
    }

    const origClose = close;
    // 覆盖 close，确保计时器也被清除
    close = () => { clearInterval(callTimer); origClose(); };
    declineBtn.removeEventListener("click", origClose);
    declineBtn.addEventListener("click", close);

    if (data.audio_url) {
      callAudio = new Audio(data.audio_url);
      // 接通后等 0.7s 再播放，模拟真实通话接通延迟
      setTimeout(() => { callAudio?.play().catch(() => {}); }, 700);
      callAudio.onended = () => {
        clearInterval(callTimer);
        status.textContent = "通话结束";
        subtitle.style.display = "none";
        setTimeout(close, 3000);
      };
    } else {
      if (cleanScript) {
        subtitle.textContent = cleanScript;
        subtitle.style.display = "block";
      }
      setTimeout(close, 6000);
    }
  });
}

async function checkVoicemail() {
  try {
    const res = await api("GET", "/call-logs/unread-voicemail");
    if (!res || res.count === 0) return;
    const log = res.logs[0];
    const msg = `📱 ${log.char_name} 给你留了语音留言`;
    showToast(msg, false, 7000);
    // 标记已读
    for (const l of res.logs) {
      api("POST", `/call-logs/${l.id}/voicemail-read`).catch(() => {});
    }
  } catch {}
}

function connectEvents(sessionId) {
  clearTimeout(_wsReconnectTimer);
  if (_ws) {
    _ws.onclose = null;
    _ws.close();
    _ws = null;
  }
  _wsSessionId = sessionId;
  _wsReconnectDelay = 1000;
  _wsConnect();
}

function _wsConnect() {
  const sessionId = _wsSessionId;
  if (!sessionId) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws?sessionId=${sessionId}`);
  _ws = ws;

  ws.onopen = () => {
    _wsReconnectDelay = 1000;
    console.log("[ws] 已连接 session=" + sessionId);
  };

  ws.onmessage = (e) => {
    try { handleWsPayload(JSON.parse(e.data)); } catch {}
  };

  ws.onclose = (ev) => {
    if (_wsSessionId !== sessionId) return; // 已切换 session，不重连
    console.log(`[ws] 断开 (${ev.code})，${_wsReconnectDelay}ms 后重连`);
    _wsReconnectTimer = setTimeout(() => {
      _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, 30000);
      _wsConnect();
    }, _wsReconnectDelay);
  };

  ws.onerror = () => ws.close();
}

// ── 心动值 ────────────────────────────────────────────────────────────────────
function renderAffection(value, delta = null) {
  const els = document.querySelectorAll("#rp-heart-count, #cm-heart-count, #immersive-heart-count");
  els.forEach((el) => { el.textContent = value; });
  if (delta !== null && delta !== 0) {
    const sign = delta > 0 ? "+" : "";
    els.forEach((el) => {
      const tip = document.createElement("span");
      tip.className = "affection-delta" + (delta > 0 ? " up" : " down");
      tip.textContent = `${sign}${delta}`;
      el.parentElement.appendChild(tip);
      setTimeout(() => tip.remove(), 2000);
    });
  }
}

const ACH_TYPE_THEME = {
  message_count: { color: "#60a5fa", glow: "rgba(96,165,250,0.5)",  icon: "💬", label: "对话里程碑" },
  affection:     { color: "#f472b6", glow: "rgba(244,114,182,0.5)", icon: "💖", label: "心动时刻"   },
  streak_days:   { color: "#34d399", glow: "rgba(52,211,153,0.5)",  icon: "🔥", label: "连续相伴"   },
};

const _shownAchievements = new Set();
const _achQueue = [];
let _achShowing = false;

function getAchTheme(type) {
  return ACH_TYPE_THEME[type] || { color: "#a78bfa", glow: "rgba(167,139,250,0.5)", icon: "✨", label: "成就" };
}

function showAchievementModal(data) {
  const achId = data.achievement?.id;
  if (achId && _shownAchievements.has(achId)) return;
  if (achId) _shownAchievements.add(achId);
  _achQueue.push(data);
  if (!_achShowing) _showNextAchievement();
}

function _showNextAchievement() {
  if (_achQueue.length === 0) { _achShowing = false; return; }
  _achShowing = true;
  const data = _achQueue.shift();

  const type = data.achievement?.type || "";
  const theme = getAchTheme(type);

  const overlay = document.createElement("div");
  overlay.id = "achievement-modal-overlay";
  overlay.className = "achievement-overlay";

  const box = document.createElement("div");
  box.className = "achievement-box";
  box.style.setProperty("--ach-color", theme.color);
  box.style.setProperty("--ach-glow", theme.glow);

  const header = document.createElement("div");
  header.className = "achievement-header";
  header.innerHTML = `${theme.icon} ${theme.label}`;

  const selfieWrap = document.createElement("div");
  selfieWrap.className = "achievement-selfie-wrap";
  selfieWrap.style.borderColor = theme.color;
  selfieWrap.style.setProperty("--ach-glow", theme.glow);
  if (data.selfie_url) {
    const img = document.createElement("img");
    img.src = data.selfie_url;
    img.className = "achievement-selfie";
    img.alt = "角色自拍";
    selfieWrap.appendChild(img);
  } else {
    selfieWrap.innerHTML = `<div class="achievement-selfie-placeholder">${theme.icon}</div>`;
  }

  const name = document.createElement("div");
  name.className = "achievement-name";
  name.style.color = theme.color;
  name.textContent = `「${data.achievement?.name || ""}」`;

  const voice = document.createElement("div");
  voice.className = "achievement-voice";
  voice.textContent = data.inner_voice || "";

  const btn = document.createElement("button");
  btn.className = "achievement-btn";
  btn.style.background = theme.color;
  btn.textContent = "好耶！";
  btn.onclick = () => {
    overlay.remove();
    if (data.ua_id) api("POST", "/achievements/notify", { ids: [data.ua_id] }).catch(() => {});
    _showNextAchievement();
  };

  box.appendChild(header);
  box.appendChild(selfieWrap);
  box.appendChild(name);
  if (data.inner_voice) box.appendChild(voice);
  box.appendChild(btn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => box.classList.add("achievement-box-in"));
}

// ── TTS 语音播放器 ────────────────────────────────────────────────────────────
function typeOutText(bubble, text, durationMs) {
  return new Promise(resolve => {
    const totalChars = text.length;
    if (totalChars === 0 || durationMs <= 0) {
      bubble.innerHTML = renderBubbleText(text);
      scrollToBottom();
      resolve();
      return;
    }
    const startTime = performance.now();
    function frame() {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const charsToShow = Math.max(1, Math.floor(progress * totalChars));
      bubble.textContent = text.slice(0, charsToShow);
      scrollToBottom();
      if (progress < 1) {
        requestAnimationFrame(frame);
      } else {
        bubble.innerHTML = renderBubbleText(text);
        scrollToBottom();
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

// ── TTS 流式播放 ──────────────────────────────────────────────────────────────
const _ttsStreams = new Map(); // msg_id -> { ctx, nextTime, chunks }
const TTS_SAMPLE_RATE = 24000;

function ttsStreamStart(msgId) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TTS_SAMPLE_RATE });
  _ttsStreams.set(msgId, { ctx, nextTime: ctx.currentTime + 0.1, chunks: [] });
}

function ttsStreamChunk(msgId, base64) {
  const state = _ttsStreams.get(msgId);
  if (!state) return;
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  state.chunks.push(bytes);
  const samples = new Int16Array(bytes.buffer);
  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
  const buf = state.ctx.createBuffer(1, floats.length, TTS_SAMPLE_RATE);
  buf.copyToChannel(floats, 0);
  const src = state.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(state.ctx.destination);
  const startAt = Math.max(state.nextTime, state.ctx.currentTime + 0.02);
  src.start(startAt);
  state.nextTime = startAt + buf.duration;
}

function ttsStreamEnd(msgId, audioUrl) {
  const state = _ttsStreams.get(msgId);
  if (state) {
    // ctx 保持运行直到音频播完，之后 GC 自动回收
    _ttsStreams.delete(msgId);
  }
  if (audioUrl) attachTtsPlayer(msgId, audioUrl, false);
}

function attachTtsPlayer(msgId, audioUrl, autoPlay = true, targetWrap = null) {
  const wrap = targetWrap || (msgId ? document.querySelector(`[data-msg-id="${msgId}"]`) : null) || document.querySelector(".bubble-wrap.assistant:last-child");
  if (!wrap) return;
  const target = wrap.querySelector(".bubble") || wrap;
  if (target.querySelector(".tts-player")) return;

  const player = document.createElement("div");
  player.className = "tts-player";

  const btn = document.createElement("button");
  btn.className = "tts-btn";
  btn.title = "播放语音";
  btn.innerHTML = `<svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>`;

  let audio = null;
  const play = () => {
    // 停止当前正在播放的其他 TTS
    if (_currentTtsAudio && _currentTtsAudio !== audio) {
      _currentTtsAudio.pause();
      _currentTtsAudio = null;
      document.querySelectorAll(".tts-btn-active").forEach(b => b.classList.remove("tts-btn-active"));
    }
    if (audio) { audio.pause(); audio = null; }
    audio = new Audio(audioUrl);
    _currentTtsAudio = audio;
    audio.play().catch(() => {});
    btn.classList.add("tts-btn-active");
    audio.onended = () => { btn.classList.remove("tts-btn-active"); if (_currentTtsAudio === audio) _currentTtsAudio = null; };
  };

  btn.addEventListener("click", play);
  player.appendChild(btn);
  target.appendChild(player);

  if (autoPlay) play();
}

// ── 关系阶段升级演出 ──────────────────────────────────────────────────────────
function showRelationMilestoneModal(data) {
  const existing = document.getElementById("rm-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "rm-overlay";
  overlay.className = "rm-overlay";

  const badge = document.createElement("div");
  badge.className = "rm-stage-badge";
  badge.textContent = "关系升级";

  const stageName = document.createElement("div");
  stageName.className = "rm-stage-name";
  stageName.textContent = data.stage_name || "";

  const closeBtn = document.createElement("button");
  closeBtn.className = "rm-close-btn";
  closeBtn.textContent = "收下了";
  closeBtn.onclick = () => {
    overlay.style.animation = "rm-fade-in 0.3s ease reverse both";
    setTimeout(() => overlay.remove(), 280);
    if (data.milestone_id) {
      api("POST", `/relationship/milestones/${data.milestone_id}/notify`).catch(() => {});
    }
  };

  const header = document.createElement("div");
  header.className = "rm-header";
  header.appendChild(badge);
  header.appendChild(stageName);

  const footer = document.createElement("div");
  footer.className = "rm-footer";

  if (data.video_url) {
    overlay.classList.add("rm-video-mode");
    const videoWrap = document.createElement("div");
    videoWrap.className = "rm-video-wrap";
    const video = document.createElement("video");
    video.src = data.video_url;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.style.pointerEvents = "none";
    videoWrap.appendChild(video);
    // 透明遮罩拦截所有点击，阻止浏览器弹出原生控件
    const videoMask = document.createElement("div");
    videoMask.style.cssText = "position:absolute;inset:0;z-index:1;cursor:pointer";
    videoMask.addEventListener("click", () => closeBtn.click());
    videoWrap.appendChild(videoMask);
    // 静音自动播放后尝试取消静音
    video.addEventListener("canplay", () => {
      video.muted = false;
      video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    }, { once: true });
    footer.appendChild(closeBtn);
    overlay.appendChild(videoWrap);
    overlay.appendChild(header);
    overlay.appendChild(footer);
  } else {
    const book = document.createElement("div");
    book.className = "rm-book";

    const page1 = document.createElement("div");
    page1.className = "rm-page rm-page-1";
    if (data.comic_url_1) {
      const img = document.createElement("img");
      img.src = data.comic_url_1;
      img.alt = "第一章";
      page1.appendChild(img);
    } else {
      page1.innerHTML = `<div class="rm-page-placeholder">💫</div>`;
    }
    const label1 = document.createElement("div");
    label1.className = "rm-page-label";
    label1.textContent = "第一章";
    page1.appendChild(label1);

    const page2 = document.createElement("div");
    page2.className = "rm-page rm-page-2";
    if (data.comic_url_2) {
      const img = document.createElement("img");
      img.src = data.comic_url_2;
      img.alt = "第二章";
      page2.appendChild(img);
    } else {
      page2.innerHTML = `<div class="rm-page-placeholder">✨</div>`;
    }
    const label2 = document.createElement("div");
    label2.className = "rm-page-label";
    label2.textContent = "第二章";
    page2.appendChild(label2);

    book.appendChild(page1);
    book.appendChild(page2);

    let currentPage = 1;

    const nav = document.createElement("div");
    nav.className = "rm-nav";

    const prevBtn = document.createElement("button");
    prevBtn.className = "rm-nav-btn";
    prevBtn.innerHTML = "‹";
    prevBtn.disabled = true;

    const dots = document.createElement("div");
    dots.className = "rm-page-dots";
    const dot1 = document.createElement("div");
    dot1.className = "rm-dot active";
    const dot2 = document.createElement("div");
    dot2.className = "rm-dot";
    dots.appendChild(dot1);
    dots.appendChild(dot2);

    const nextBtn = document.createElement("button");
    nextBtn.className = "rm-nav-btn";
    nextBtn.innerHTML = "›";

    function goToPage(n) {
      currentPage = n;
      if (n === 2) {
        page1.classList.add("flipped");
        prevBtn.disabled = false;
        nextBtn.disabled = true;
        dot1.classList.remove("active");
        dot2.classList.add("active");
      } else {
        page1.classList.remove("flipped");
        prevBtn.disabled = true;
        nextBtn.disabled = false;
        dot1.classList.add("active");
        dot2.classList.remove("active");
      }
    }

    prevBtn.onclick = () => goToPage(1);
    nextBtn.onclick = () => goToPage(2);

    nav.appendChild(prevBtn);
    nav.appendChild(dots);
    nav.appendChild(nextBtn);

    footer.appendChild(nav);
    footer.appendChild(closeBtn);

    overlay.appendChild(header);
    overlay.appendChild(book);
    overlay.appendChild(footer);
  }

  document.body.appendChild(overlay);
}

async function openAffectionLog() {
  const modal = document.getElementById("affection-modal");
  const list = document.getElementById("affection-log-list");
  modal.classList.remove("hidden");
  list.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:16px">加载中…</p>';
  try {
    const rows = await api("GET", "/character/affection-log");
    if (!rows.length) {
      list.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:16px">还没有心动值变化记录</p>';
      return;
    }
    list.innerHTML = rows.map((r) => {
      const sign = r.delta > 0 ? "+" : "";
      const deltaClass = r.delta > 0 ? "up" : r.delta < 0 ? "down" : "zero";
      const date = new Date(r.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const moodInfo = MOOD_MAP[r.mood] || MOOD_MAP.neutral;
      const avatarSrc = getAvatar("assistant", r.mood === "neutral" || !r.mood ? null : r.mood);
      const avatarHtml = avatarSrc
        ? `<img class="affection-log-avatar" src="${avatarSrc}" alt="${moodInfo.label}">`
        : `<div class="affection-log-avatar-placeholder">${moodInfo.emoji}</div>`;
      return `<div class="affection-log-item">
        ${avatarHtml}
        <span class="affection-log-delta ${deltaClass}">${sign}${r.delta}</span>
        <div class="affection-log-content">
          <div class="affection-log-reason">${r.reason || "—"}</div>
          <div class="affection-log-meta">心动值 ${r.value} · ${moodInfo.label} · ${date}</div>
        </div>
      </div>`;
    }).join("");
  } catch {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:16px">加载失败</p>';
  }
}

document.getElementById("affection-modal-close").addEventListener("click", () => {
  document.getElementById("affection-modal").classList.add("hidden");
});

// ── 成就回顾 ──────────────────────────────────────────────────────────────────
async function openAchievementsModal() {
  const modal = document.getElementById("achievements-modal");
  const list = document.getElementById("achievements-list");
  modal.classList.remove("hidden");
  list.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:16px;grid-column:1/-1">加载中…</p>';
  try {
    const [rows, milestones] = await Promise.all([
      api("GET", "/achievements").catch(() => []),
      api("GET", "/relationship/milestones").catch(() => []),
    ]);
    const achRows = Array.isArray(rows) ? rows : [];
    const rmRows = Array.isArray(milestones) ? milestones : [];
    if (!achRows.length && !rmRows.length) {
      list.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:16px;grid-column:1/-1">还没有解锁任何成就</p>';
      return;
    }

    list.innerHTML = "";

    if (achRows.length) {
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;";
      grid.innerHTML = achRows.map((r, i) => {
        const theme = getAchTheme(r.type);
        return `
          <div class="ach-review-item ach-type-${r.type}" data-idx="${i}" style="--ach-color:${theme.color};--ach-glow:${theme.glow}">
            <div class="ach-review-selfie-wrap" style="border-color:${theme.color}">
              ${r.selfie_url
                ? `<img src="${r.selfie_url}" class="ach-review-selfie" alt="">`
                : `<div class="ach-review-selfie-placeholder">${theme.icon}</div>`}
              <div class="ach-review-type-badge">${theme.icon}</div>
            </div>
            <div class="ach-review-info">
              <div class="ach-review-name" style="color:${theme.color}">「${r.name}」</div>
              ${r.inner_voice ? `<div class="ach-review-voice">${r.inner_voice}</div>` : ""}
              <div class="ach-review-date">${new Date(r.unlocked_at).toLocaleDateString("zh-CN")}</div>
            </div>
          </div>
        `;
      }).join("");
      grid.querySelectorAll(".ach-review-item").forEach((el, i) => {
        el.style.animationDelay = `${i * 0.07}s`;
        el.addEventListener("click", () => openAchievementLightbox(achRows[i]));
      });
      list.appendChild(grid);
    }

    if (rmRows.length) {
      const section = document.createElement("div");
      section.className = "rm-review-section";
      section.innerHTML = `<div class="rm-review-title">关系回顾</div>`;
      const rmList = document.createElement("div");
      rmList.className = "rm-review-list";
      rmRows.forEach((m) => {
        const item = document.createElement("div");
        item.className = "rm-review-item";
        const thumbHtml = m.video_url
          ? `<video src="${m.video_url}" muted playsinline style="width:100%;height:100%;object-fit:cover;border-radius:6px"></video>`
          : m.comic_url_1
          ? `<img src="${m.comic_url_1}" alt="">`
          : `<div class="rm-review-thumb-ph">💫</div>`;
        item.innerHTML = `
          <div class="rm-review-thumb">${thumbHtml}</div>
          <div class="rm-review-info">
            <div class="rm-review-stage-name">${m.stage_name}</div>
            <div class="rm-review-date">${new Date(m.created_at).toLocaleDateString("zh-CN")}</div>
          </div>
          <div class="rm-review-arrow">›</div>
        `;
        item.addEventListener("click", () => showRelationMilestoneModal(Object.assign({}, m, { milestone_id: null })));
        rmList.appendChild(item);
      });
      section.appendChild(rmList);
      list.appendChild(section);
    }
  } catch {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:16px;grid-column:1/-1">加载失败</p>';
  }
}

function openAchievementLightbox(r) {
  const existing = document.getElementById("ach-lightbox");
  if (existing) existing.remove();

  const theme = getAchTheme(r.type);

  const lb = document.createElement("div");
  lb.id = "ach-lightbox";
  lb.className = "ach-lightbox";

  if (r.selfie_url) {
    const img = document.createElement("img");
    img.src = r.selfie_url;
    img.className = "ach-lightbox-img";
    img.style.borderColor = theme.color;
    img.style.boxShadow = `0 0 40px ${theme.glow}`;
    img.alt = r.name;
    lb.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.style.cssText = "font-size:80px;line-height:1";
    ph.textContent = theme.icon;
    lb.appendChild(ph);
  }

  const typeBadge = document.createElement("div");
  typeBadge.className = "ach-lightbox-badge";
  typeBadge.style.color = theme.color;
  typeBadge.style.borderColor = theme.color;
  typeBadge.textContent = theme.label;
  lb.appendChild(typeBadge);

  const name = document.createElement("div");
  name.className = "ach-lightbox-name";
  name.style.color = theme.color;
  name.textContent = `「${r.name}」`;
  lb.appendChild(name);

  if (r.inner_voice) {
    const voice = document.createElement("div");
    voice.className = "ach-lightbox-voice";
    voice.textContent = r.inner_voice;
    lb.appendChild(voice);
  }

  const date = document.createElement("div");
  date.className = "ach-lightbox-date";
  date.textContent = new Date(r.unlocked_at).toLocaleDateString("zh-CN");
  lb.appendChild(date);

  lb.addEventListener("click", () => {
    lb.style.animation = "ach-lb-bg-in 0.2s ease reverse both";
    setTimeout(() => lb.remove(), 180);
  });
  document.body.appendChild(lb);
}

document.getElementById("achievements-modal-close").addEventListener("click", () => {
  document.getElementById("achievements-modal").classList.add("hidden");
  document.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
  document.querySelector(".nav-tab[data-tab='chat']")?.classList.add("active");
});

document.getElementById("affection-set-confirm").addEventListener("click", async () => {
  const input = document.getElementById("affection-set-input");
  const val = parseInt(input.value, 10);
  if (isNaN(val) || val < 0 || val > 100) return;
  const btn = document.getElementById("affection-set-confirm");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await api("PATCH", "/character/affection", { value: val });
    input.value = "";
    await openAffectionLog();
  } finally {
    btn.disabled = false;
    btn.textContent = "设置";
  }
});

document.querySelectorAll(".rp-heart-btn").forEach((btn) => {
  btn.addEventListener("click", openAffectionLog);
});

// ── 情绪可视化 ────────────────────────────────────────────────────────────────
const MOOD_MAP = {
  neutral:   { label: "平静",   color: "#888", emoji: "😐" },
  shy:       { label: "害羞",   color: "#e88", emoji: "😳" },
  annoyed:   { label: "不耐烦", color: "#e64", emoji: "😤" },
  soft:      { label: "温柔",   color: "#8be", emoji: "🥰" },
  flustered: { label: "慌乱",   color: "#eb8", emoji: "😰" },
  playful:   { label: "俏皮",   color: "#8e8", emoji: "😏" },
  cold:      { label: "冷淡",   color: "#68a", emoji: "🥶" },
  happy:     { label: "开心",   color: "#fc5", emoji: "😄" },
  angry:     { label: "生气",   color: "#c33", emoji: "😠" },
};

async function refreshMood(sessionId) {
  try {
    const data = await api("GET", `/sessions/${sessionId}/mood`);
    currentMood = data.mood || "neutral";
    renderMoodIndicator(currentMood);
    refreshAllAssistantAvatars();
    renderRightPanel(data);
    document.getElementById("dnd-start").value = data.dnd_start || "";
    document.getElementById("dnd-end").value = data.dnd_end || "";
    document.getElementById("proactive-idle").value = data.proactive_idle_minutes || "";
  } catch {}
}

// ── 情绪显示切换（sidebar mood bar 中的 indicator）────────────────────────────
function renderMoodIndicator(mood) {
  const info = MOOD_MAP[mood] || MOOD_MAP.neutral;
  // sidebar mood bar
  const sidebarInd = document.getElementById("sidebar-mood-indicator");
  if (sidebarInd) {
    sidebarInd.style.setProperty("--mood-color", info.color);
    const avatarSrc = getAvatar("assistant", mood);
    const iconHtml = avatarSrc
      ? `<img src="${avatarSrc}" class="mood-avatar-icon">`
      : `<span class="mood-emoji">${info.emoji}</span>`;
    sidebarInd.innerHTML = `${iconHtml}${info.label}`;
  }
}

// ── 右侧面板 ──────────────────────────────────────────────────────────────────
function renderRightPanel(data) {
  renderRightPanelAvatar();
  renderRightPanelMood(data.mood || "neutral");
  renderRightPanelTopic(data.topic_summary || null);
  renderRightPanelDnd(data.dnd_start || null, data.dnd_end || null);
  renderRightPanelMemoryStatus();
  renderRightPanelRecentImages();
}

function renderCharacterCard(cardUrl) {
  const img = document.getElementById("rp-card-img");
  const skeleton = document.getElementById("rp-card-skeleton");
  const nameEl = document.getElementById("rp-card-name");
  if (nameEl) nameEl.textContent = characterName || "龙卷";
  if (!img || !skeleton) return;
  if (cardUrl) {
    img.src = cardUrl;
    img.onload = () => {
      img.classList.remove("hidden");
      skeleton.classList.add("hidden");
    };
    img.onerror = () => { skeleton.classList.remove("hidden"); };
  } else {
    img.classList.add("hidden");
    skeleton.classList.remove("hidden");
  }
}

function renderRightPanelAvatar() {
  renderMoodIndicator(currentMood);
  // 更新顶部 header 头像
  const headerAvatar = document.getElementById("chat-header-avatar");
  if (headerAvatar) {
    const avatarSrc = getAvatar("assistant", currentMood);
    if (avatarSrc) {
      headerAvatar.innerHTML = `<img src="${avatarSrc}" alt="">`;
    } else {
      headerAvatar.innerHTML = characterName ? characterName[0] : "?";
    }
  }
}

function renderRightPanelMood(mood) {
  const info = MOOD_MAP[mood] || MOOD_MAP.neutral;
  const label = document.getElementById("rp-mood-label");
  if (label) {
    label.style.color = info.color;
    const avatarSrc = getAvatar("assistant", mood);
    const iconHtml = avatarSrc
      ? `<img src="${avatarSrc}" class="rp-mood-label-avatar">`
      : `<span class="rp-mood-label-emoji">${info.emoji}</span>`;
    label.innerHTML = `${iconHtml}<span>${info.label}</span>`;
  }
  const grid = document.getElementById("rp-mood-grid");
  if (grid) {
    grid.querySelectorAll(".rp-mood-dot").forEach((dot) => {
      dot.classList.toggle("active", dot.dataset.mood === mood);
    });
  }
  // 同步沉浸模式状态栏
  const dot = document.getElementById("immersive-mood-dot");
  const moodLabel = document.getElementById("immersive-mood-label");
  if (dot) dot.style.background = info.color;
  if (moodLabel) moodLabel.textContent = info.label;
}

function renderRightPanelTopic(summary) {
  const el = document.getElementById("rp-topic-text");
  if (el) el.textContent = summary || "暂无话题";
}

function renderRightPanelDnd(start, end) {
  const timeEl = document.getElementById("rp-dnd-time");
  const toggle = document.getElementById("rp-dnd-toggle");
  const active = !!(start && end);
  if (toggle) toggle.classList.toggle("on", active);
  if (timeEl) timeEl.textContent = active ? `${start} – ${end}` : "未设置";
}

function renderRightPanelMemoryStatus() {
  const el = document.getElementById("rp-memory-status");
  if (el) el.textContent = "记忆库：已连接";
}

async function renderRightPanelRecentImages() {
  const grid = document.getElementById("rp-recent-grid");
  if (!grid || !currentSessionId) return;
  try {
    const data = await api("GET", `/gallery?limit=20&offset=0`);
    const sessionItems = data.items.filter((i) => i.session_id === currentSessionId).slice(0, 2);
    grid.innerHTML = "";
    for (const item of sessionItems) {
      const el = document.createElement("div");
      el.className = "rp-recent-img";
      const img = document.createElement("img");
      img.src = item.image_url;
      img.loading = "lazy";
      el.appendChild(img);
      el.addEventListener("click", () => openLightbox(item.image_url));
      grid.appendChild(el);
    }
  } catch {}
}

function initMoodGrid() {
  const grid = document.getElementById("rp-mood-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const [mood, info] of Object.entries(MOOD_MAP)) {
    const dot = document.createElement("div");
    dot.className = "rp-mood-dot";
    dot.dataset.mood = mood;
    dot.title = info.label;
    dot.style.background = info.color;
    grid.appendChild(dot);
  }
}

// ── 底部导航 ──────────────────────────────────────────────────────────────────
function initBottomNav() {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const t = tab.dataset.tab;
      if (t === "chat") {
        closeSidebar();
        closeRightPanel();
      } else if (t === "status") {
        openCompanionModal();
      } else if (t === "gallery") {
        openGallery();
      } else if (t === "memory") {
        openCompanionModal();
      } else if (t === "search") {
        if (isMobile()) openSidebar();
        setTimeout(() => focusSearch(), 300);
      } else if (t === "achievements") {
        openAchievementsModal();
      } else if (t === "settings") {
        openSettings();
      }
    });
  });
}

const GALLERY_PAGE_SIZE = 20;
let _galleryOffset = 0;
let _galleryLoading = false;
let _galleryHasMore = true;
let _galleryObserver = null;

function openGallery() {
  const modal = document.getElementById("gallery-modal");
  const grid = document.getElementById("gallery-grid");
  modal.classList.remove("hidden");

  // 重置状态
  _galleryOffset = 0;
  _galleryHasMore = true;
  _galleryLoading = false;
  grid.innerHTML = "";

  // 哨兵元素，用于触发加载
  const sentinel = document.createElement("div");
  sentinel.id = "gallery-sentinel";
  sentinel.style.cssText = "height:1px;width:100%;grid-column:1/-1;";
  grid.appendChild(sentinel);

  // 断开旧 observer
  if (_galleryObserver) _galleryObserver.disconnect();

  _galleryObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && _galleryHasMore && !_galleryLoading) {
      loadGalleryPage(grid, sentinel);
    }
  }, { root: grid.parentElement, rootMargin: "300px" });

  _galleryObserver.observe(sentinel);

  // 立即加载第一页
  loadGalleryPage(grid, sentinel);
}

async function loadGalleryPage(grid, sentinel) {
  if (_galleryLoading || !_galleryHasMore) return;
  _galleryLoading = true;

  // 加载指示
  let loader = document.getElementById("gallery-loader");
  if (!loader) {
    loader = document.createElement("div");
    loader.id = "gallery-loader";
    loader.className = "gallery-loader";
    loader.innerHTML = '<div class="spinner"></div>';
    grid.insertBefore(loader, sentinel);
  }

  try {
    const charParam = characterName ? `&character=${encodeURIComponent(characterName)}` : "";
    const data = await api("GET", `/gallery?offset=${_galleryOffset}&limit=${GALLERY_PAGE_SIZE}${charParam}`);
    loader.remove();

    if (_galleryOffset === 0 && data.items.length === 0) {
      grid.insertBefore(
        Object.assign(document.createElement("div"), {
          className: "gallery-empty",
          textContent: "还没有生成过图片"
        }),
        sentinel
      );
      _galleryHasMore = false;
      return;
    }

    for (const item of data.items) {
      const el = document.createElement("div");
      el.className = "gallery-item";
      const img = document.createElement("img");
      img.src = item.image_url;
      img.loading = "lazy";
      img.alt = item.image_prompt || "";
      const label = document.createElement("div");
      label.className = "gi-session";
      label.textContent = item.title || "";
      el.appendChild(img);
      el.appendChild(label);
      el.addEventListener("click", () => openLightbox(item.image_url));
      grid.insertBefore(el, sentinel);
    }

    _galleryOffset += data.items.length;
    _galleryHasMore = data.hasMore;

    if (!_galleryHasMore) {
      _galleryObserver.disconnect();
      sentinel.remove();
    }
  } catch {
    if (loader) loader.remove();
    const err = document.createElement("div");
    err.style.cssText = "color:#e05;font-size:13px;padding:20px;grid-column:1/-1";
    err.textContent = "加载失败，请重试";
    grid.insertBefore(err, sentinel);
  } finally {
    _galleryLoading = false;
  }
}

function focusSearch() {
  const input = document.getElementById("search-input");
  if (input) input.focus();
}

// ── 标题编辑 ──────────────────────────────────────────────────────────────────
function initChatTitleEdit() {
  const btn = document.getElementById("btn-edit-title");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const titleEl = document.getElementById("chat-title-text");
    if (!titleEl) return;
    const current = titleEl.textContent;
    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    input.style.cssText = "background:var(--bg);border:1px solid var(--accent);border-radius:4px;color:var(--text);padding:2px 6px;font-size:15px;font-weight:600;width:160px;";
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = async () => {
      const newTitle = input.value.trim() || current;
      const span = document.createElement("span");
      span.className = "chat-title";
      span.id = "chat-title-text";
      span.textContent = newTitle;
      input.replaceWith(span);
      if (newTitle !== current && currentSessionId) {
        await api("PATCH", `/sessions/${currentSessionId}`, { title: newTitle });
        await loadSessions();
      }
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = current; input.blur(); }
    });
  });
}

// ── 设置面板 ──────────────────────────────────────────────────────────────────
// 背景透明度滑块
const bgOpacitySlider = document.getElementById("bg-opacity");
const bgOpacityVal = document.getElementById("bg-opacity-val");
bgOpacitySlider.value = getChatBgOpacity();
bgOpacityVal.textContent = Math.round(getChatBgOpacity() * 100) + "%";
bgOpacitySlider.addEventListener("input", () => {
  const v = parseFloat(bgOpacitySlider.value);
  bgOpacityVal.textContent = Math.round(v * 100) + "%";
  applyChatBgOpacity(v);
});

const bubbleOpacitySlider = document.getElementById("bubble-opacity");
const bubbleOpacityVal = document.getElementById("bubble-opacity-val");
bubbleOpacitySlider.value = getBubbleOpacity();
bubbleOpacityVal.textContent = Math.round(getBubbleOpacity() * 100) + "%";
bubbleOpacitySlider.addEventListener("input", () => {
  const v = parseFloat(bubbleOpacitySlider.value);
  bubbleOpacityVal.textContent = Math.round(v * 100) + "%";
  applyBubbleOpacity(v);
});

// 页面加载时应用保存的气泡透明度
applyBubbleOpacity(getBubbleOpacity());

document.getElementById("settings-cancel").addEventListener("click", () => {
  document.getElementById("settings-modal").classList.add("hidden");
});

async function loadCharacterList() {
  try {
    const chars = await api("GET", "/characters");
    const sel = document.getElementById("character-select");
    if (!sel) return;
    sel.innerHTML = chars.map(c =>
      `<option value="${c.id}" ${c.is_active ? "selected" : ""}>${c.name}</option>`
    ).join("");
    sel.onchange = async () => {
      await api("PATCH", `/characters/${sel.value}`, { is_active: true });
      setChatBackground(null);
      await newSession();
      await loadCharacter();
      showToast("已切换角色");
    };
  } catch {}
}

async function openSettings() {
  await loadCharacterList();
  document.getElementById("settings-modal").classList.remove("hidden");
  // 同步滑块显示值
  const bgSlider = document.getElementById("bg-opacity");
  const bgVal = document.getElementById("bg-opacity-val");
  bgSlider.value = getChatBgOpacity();
  bgVal.textContent = Math.round(getChatBgOpacity() * 100) + "%";
  const bbSlider = document.getElementById("bubble-opacity");
  const bbVal = document.getElementById("bubble-opacity-val");
  bbSlider.value = getBubbleOpacity();
  bbVal.textContent = Math.round(getBubbleOpacity() * 100) + "%";
  try {
    const [gs, mood, user, voiceData] = await Promise.all([
      api("GET", "/settings"),
      currentSessionId ? api("GET", `/sessions/${currentSessionId}/mood`) : Promise.resolve(null),
      api("GET", "/auth/me").catch(() => ({ is_admin: 0 })),
      api("GET", "/character/voice").catch(() => null),
    ]);
    const chatImgToggle = document.getElementById("chat-image-toggle");
    const fallbackToggle = document.getElementById("image-fallback-toggle");
    const autoExpandToggle = document.getElementById("image-auto-expand-toggle");
    if (chatImgToggle) chatImgToggle.classList.toggle("on", !!gs.chatImageEnabled);
    if (fallbackToggle) fallbackToggle.classList.toggle("on", !!gs.imageFallbackEnabled);
    if (autoExpandToggle) autoExpandToggle.classList.toggle("on", !!gs.imageAutoExpand);
    window._imageAutoExpand = !!gs.imageAutoExpand;
    window._collapseAction = !!gs.collapseAction;
    const collapseToggle = document.getElementById("collapse-action-toggle");
    if (collapseToggle) collapseToggle.classList.toggle("on", !!gs.collapseAction);
    const ttsToggle = document.getElementById("tts-enabled-setting-toggle");
    if (ttsToggle) ttsToggle.classList.toggle("on", !!gs.ttsEnabled);
    const ttsLangSelect = document.getElementById("tts-lang-select");
    if (ttsLangSelect) ttsLangSelect.value = gs.ttsLang || "zh";
    const ttsHint = document.querySelector(".settings-hint.tts-hint");
    if (ttsHint) {
      if (gs.ttsEnabled && !voiceData?.voice_id) {
        ttsHint.textContent = "⚠️ 当前角色尚未复刻声音，配音不会生效。请在角色设定中上传音频。";
        ttsHint.style.color = "#f87171";
      } else {
        ttsHint.textContent = "开启后，角色每条回复将自动配音。需先在角色设定中上传音频完成声音复刻。";
        ttsHint.style.color = "";
      }
    }
    const providerRow = document.getElementById("llm-provider-row");
    const providerSelect = document.getElementById("llm-provider-select");
    if (user?.is_admin && providerRow) {
      providerRow.style.display = "";
      if (providerSelect) providerSelect.value = gs.llmProvider || "deepseek";
    }
    if (mood) {
      document.getElementById("dnd-start").value = mood.dnd_start || "";
      document.getElementById("dnd-end").value = mood.dnd_end || "";
      document.getElementById("proactive-idle").value = mood.proactive_idle_minutes || "";
    }
  } catch {}
}

document.getElementById("settings-save").addEventListener("click", async () => {
  const dndStart = document.getElementById("dnd-start").value || null;
  const dndEnd = document.getElementById("dnd-end").value || null;
  const idleVal = document.getElementById("proactive-idle").value;
  const proactiveIdleMinutes = idleVal ? Number(idleVal) : null;
  const slideshowEnabled = document.getElementById("slideshow-toggle").classList.contains("on");
  const slideshowInterval = Number(document.getElementById("slideshow-interval").value) || 30;
  const chatImageEnabled = document.getElementById("chat-image-toggle").classList.contains("on");
  const imageFallbackEnabled = document.getElementById("image-fallback-toggle").classList.contains("on");
  const imageAutoExpand = document.getElementById("image-auto-expand-toggle").classList.contains("on");
  const collapseAction = document.getElementById("collapse-action-toggle").classList.contains("on");
  const ttsEnabled = document.getElementById("tts-enabled-setting-toggle")?.classList.contains("on") ?? false;
  const ttsLangSelect = document.getElementById("tts-lang-select");
  const ttsLang = ttsLangSelect ? ttsLangSelect.value : "zh";
  const providerSelect = document.getElementById("llm-provider-select");
  const llmProvider = providerSelect ? providerSelect.value : "deepseek";
  const tasks = [
    api("PATCH", "/character/slideshow", { enabled: slideshowEnabled, interval_minutes: slideshowInterval }),
    api("PATCH", "/settings", { chatImageEnabled, imageFallbackEnabled, imageAutoExpand, collapseAction, ttsEnabled, ttsLang, llmProvider })
  ];
  if (currentSessionId) {
    tasks.push(api("PATCH", `/sessions/${currentSessionId}/settings`, { dnd_start: dndStart, dnd_end: dndEnd, proactive_idle_minutes: proactiveIdleMinutes }));
  }
  await Promise.all(tasks);
  window._imageAutoExpand = imageAutoExpand;
  window._collapseAction = collapseAction;
  document.getElementById("settings-modal").classList.add("hidden");
  showToast("设置已保存");
  renderRightPanelDnd(dndStart, dndEnd);
  initSlideshow(slideshowEnabled, slideshowInterval);
});

// ── 右侧面板：角色设定 ────────────────────────────────────────────────────────
async function loadSoulIntoPanel() {
  try {
    const soulData = await api("GET", "/character/soul");
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
    set("char-name", soulData.name);
    set("char-appearance", soulData.appearance);
    set("char-description", soulData.description);
    set("char-personality", soulData.personality);
    set("soul-editor", soulData.soul);
  } catch {}
  await loadCharacterList();
  await loadVoiceSection("rp");
}

async function loadVoiceSection(prefix) {
  try {
    const data = await api("GET", "/character/voice");
    const statusEl = document.getElementById(`${prefix === "rp" ? "" : "cm-"}voice-status`);
    const previewBtn = document.getElementById(`${prefix === "rp" ? "" : "cm-"}voice-preview-btn`);
    const deleteBtn = document.getElementById(`${prefix === "rp" ? "" : "cm-"}voice-delete-btn`);
    if (!statusEl) return;
    if (data?.voice_id) {
      statusEl.textContent = "已复刻 ✓";
      statusEl.style.color = "var(--accent, #7c6fcd)";
      if (previewBtn) previewBtn.style.display = "";
      if (deleteBtn) deleteBtn.style.display = "";
    } else {
      statusEl.textContent = "未设置";
      statusEl.style.color = "var(--text-dim)";
      if (previewBtn) previewBtn.style.display = "none";
      if (deleteBtn) deleteBtn.style.display = "none";
    }
  } catch {}
}

function setupVoiceSection(prefix) {
  const uploadInput = document.getElementById(`${prefix}voice-upload`);
  const uploadBtn = document.getElementById(`${prefix}voice-upload-btn`);
  const previewBtn = document.getElementById(`${prefix}voice-preview-btn`);
  const deleteBtn = document.getElementById(`${prefix}voice-delete-btn`);
  const statusEl = document.getElementById(`${prefix}voice-status`);
  const rpPrefix = prefix === "" ? "rp" : "cm";

  uploadBtn?.addEventListener("click", () => uploadInput?.click());
  uploadInput?.addEventListener("change", async () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = "复刻中…";
    try {
      await fetch("/character/voice", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": file.type || "audio/wav" },
        body: file
      }).then(async r => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      });
      await loadVoiceSection(rpPrefix);
    } catch (err) {
      if (statusEl) { statusEl.textContent = "复刻失败：" + err.message.slice(0, 60); statusEl.style.color = "#f87171"; }
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = "上传音频复刻";
      uploadInput.value = "";
    }
  });

  previewBtn?.addEventListener("click", async () => {
    previewBtn.disabled = true;
    previewBtn.textContent = "生成中…";
    try {
      const data = await api("POST", "/character/voice/preview", { text: "你好，我是你的专属伴侣，很高兴认识你。", lang: "zh" });
      if (data?.audio_url) {
        const audio = new Audio(data.audio_url);
        audio.play().catch(() => {});
      }
    } catch {}
    previewBtn.disabled = false;
    previewBtn.textContent = "试听";
  });

  deleteBtn?.addEventListener("click", async () => {
    if (!confirm("确认删除音色？")) return;
    await api("DELETE", "/character/voice");
    await loadVoiceSection(rpPrefix);
  });
}

setupVoiceSection("");
setupVoiceSection("cm-");

document.getElementById("rp-soul-toggle")?.addEventListener("click", async () => {
  const header = document.getElementById("rp-soul-toggle");
  const body = document.getElementById("rp-soul-body");
  const isOpen = !body.classList.contains("hidden");
  if (isOpen) {
    body.classList.add("hidden");
    header.classList.remove("open");
  } else {
    body.classList.remove("hidden");
    header.classList.add("open");
    await loadSoulIntoPanel();
  }
});

document.getElementById("rp-soul-save")?.addEventListener("click", async () => {
  const get = (id) => document.getElementById(id)?.value ?? "";
  await api("PATCH", "/character/soul", {
    name: get("char-name"),
    appearance: get("char-appearance"),
    personality: get("char-personality"),
    description: get("char-description"),
    soul: get("soul-editor")
  });
  showToast("角色设定已保存");
  await loadCharacter();
  location.reload();
});

document.getElementById("character-new-btn")?.addEventListener("click", async () => {
  const name = prompt("新角色名称：");
  if (!name?.trim()) return;
  const result = await api("POST", "/characters", { name: name.trim() });
  await api("PATCH", `/characters/${result.id}`, { is_active: true });
  location.reload();
});

// ── 伴侣弹窗 ──────────────────────────────────────────────────────────────────
async function openCompanionModal() {
  const modal = document.getElementById("companion-modal");
  modal.classList.remove("hidden");
  const syncSrc = (fromId, toId) => {
    const from = document.getElementById(fromId);
    const to = document.getElementById(toId);
    if (from && to) { to.src = from.src; to.classList.toggle("hidden", from.classList.contains("hidden")); }
  };
  syncSrc("rp-card-img", "cm-card-img");
  const nameFrom = document.getElementById("rp-card-name");
  const nameTo = document.getElementById("cm-card-name");
  if (nameFrom && nameTo) nameTo.textContent = nameFrom.textContent;
  const skeleton = document.getElementById("cm-card-skeleton");
  const rpSkeleton = document.getElementById("rp-card-skeleton");
  if (skeleton && rpSkeleton) skeleton.classList.toggle("hidden", rpSkeleton.classList.contains("hidden"));
  const moodFrom = document.getElementById("rp-mood-label");
  const moodTo = document.getElementById("cm-mood-label");
  if (moodFrom && moodTo) moodTo.textContent = moodFrom.textContent;
  // 默认展开角色设定，加载数据
  try {
    const soulData = await api("GET", "/character/soul");
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
    set("cm-char-name", soulData.name);
    set("cm-char-appearance", soulData.appearance);
    set("cm-char-description", soulData.description);
    set("cm-char-personality", soulData.personality);
    set("cm-soul-editor", soulData.soul);
  } catch {}
  try {
    const chars = await api("GET", "/characters");
    const sel = document.getElementById("cm-character-select");
    if (sel) {
      sel.innerHTML = chars.map(c =>
        `<option value="${c.id}" ${c.is_active ? "selected" : ""}>${c.name}</option>`
      ).join("");
      sel.onchange = async () => {
        await api("PATCH", `/characters/${sel.value}`, { is_active: true });
        setChatBackground(null);
        await newSession();
        await loadCharacter();
        showToast("已切换角色");
      };
    }
  } catch {}
  await loadVoiceSection("cm");
}

document.getElementById("companion-close")?.addEventListener("click", () => {
  document.getElementById("companion-modal").classList.add("hidden");
});
document.getElementById("companion-modal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
});

document.getElementById("cm-card-regen")?.addEventListener("click", async () => {
  document.getElementById("rp-card-regen")?.click();
});
document.getElementById("cm-card-library")?.addEventListener("click", () => {
  document.getElementById("companion-modal").classList.add("hidden");
  openCardLibrary();
});
document.getElementById("cm-avatar-reset")?.addEventListener("click", () => {
  document.getElementById("rp-avatar-reset")?.click();
});

document.getElementById("cm-ingest-btn")?.addEventListener("click", () => {
  document.getElementById("rp-ingest-btn")?.click();
});

document.getElementById("cm-soul-toggle")?.addEventListener("click", () => {
  const header = document.getElementById("cm-soul-toggle");
  const body = document.getElementById("cm-soul-body");
  const isOpen = !body.classList.contains("hidden");
  if (isOpen) {
    body.classList.add("hidden");
    header.classList.remove("open");
  } else {
    body.classList.remove("hidden");
    header.classList.add("open");
  }
});

document.getElementById("cm-soul-save")?.addEventListener("click", async () => {
  const get = (id) => document.getElementById(id)?.value ?? "";
  await api("PATCH", "/character/soul", {
    name: get("cm-char-name"),
    appearance: get("cm-char-appearance"),
    personality: get("cm-char-personality"),
    description: get("cm-char-description"),
    soul: get("cm-soul-editor")
  });
  showToast("角色设定已保存");
  await loadCharacter();
  location.reload();
});

document.getElementById("cm-character-new-btn")?.addEventListener("click", async () => {
  const name = prompt("新角色名称：");
  if (!name?.trim()) return;
  const result = await api("POST", "/characters", { name: name.trim() });
  await api("PATCH", `/characters/${result.id}`, { is_active: true });
  location.reload();
});

// ── 导出 ──────────────────────────────────────────────────────────────────────
function exportSession() {
  if (!currentSessionId) return;
  const a = document.createElement("a");
  a.href = `/sessions/${currentSessionId}/export`;
  a.download = `chat-${currentSessionId}.txt`;
  a.click();
}

// ── 归档会话 ──────────────────────────────────────────────────────────────────
async function openArchivedSessions() {
  const modal = document.getElementById("archived-modal");
  const grid = document.getElementById("archived-list");
  modal.classList.remove("hidden");
  grid.innerHTML = '<div style="padding:16px;color:var(--text-dim)">加载中…</div>';
  const sessions = await api("GET", "/sessions/archived");
  grid.innerHTML = "";
  if (sessions.length === 0) {
    grid.innerHTML = '<div style="padding:16px;color:var(--text-dim)">暂无归档会话</div>';
    return;
  }
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "archived-item";

    const info = document.createElement("div");
    info.className = "archived-info";
    const title = document.createElement("div");
    title.className = "archived-title";
    title.textContent = s.title || "新对话";
    const preview = document.createElement("div");
    preview.className = "archived-preview";
    preview.textContent = s.last_message || "";
    info.appendChild(title);
    info.appendChild(preview);

    const btn = document.createElement("button");
    btn.className = "archived-restore-btn";
    btn.textContent = "恢复";
    btn.addEventListener("click", async () => {
      await api("POST", `/sessions/${s.id}/restore`);
      await loadSessions();
      item.remove();
      if (!document.querySelector(".archived-item")) {
        grid.innerHTML = '<div style="padding:16px;color:var(--text-dim)">暂无归档会话</div>';
      }
    });

    item.appendChild(info);
    item.appendChild(btn);
    grid.appendChild(item);
  }
}

// ── 图片画廊关闭 ──────────────────────────────────────────────────────────────
document.getElementById("gallery-close").addEventListener("click", () => {
  document.getElementById("gallery-modal").classList.add("hidden");
  if (_galleryObserver) { _galleryObserver.disconnect(); _galleryObserver = null; }
});

// ── 右侧面板按钮 ──────────────────────────────────────────────────────────────
document.getElementById("rp-ingest-btn").addEventListener("click", async () => {
  if (!currentSessionId) return;
  const btn = document.getElementById("rp-ingest-btn");
  btn.disabled = true;
  btn.textContent = "存入中…";
  try {
    const res = await api("POST", `/sessions/${currentSessionId}/ingest`);
    if (res.skipped) showToast("该对话没有内容");
    else if (res.ok) showToast("已保存到记忆库 · <a href='http://localhost:8880' target='_blank' style='color:var(--accent)'>查看</a>", true);
    else showToast("保存失败");
  } catch {
    showToast("保存失败");
  } finally {
    btn.disabled = false;
    btn.textContent = "存入记忆库";
  }
});

document.getElementById("rp-view-all").addEventListener("click", openGallery);

document.getElementById("rp-dnd-toggle").addEventListener("click", () => {
  openSettings();
});

// ── 侧边栏快捷按钮 ────────────────────────────────────────────────────────────
document.getElementById("sc-search").addEventListener("click", focusSearch);
document.getElementById("sc-export").addEventListener("click", exportSession);
document.getElementById("sc-gallery").addEventListener("click", openGallery);
document.getElementById("sc-archive").addEventListener("click", openArchivedSessions);
document.getElementById("sc-call-logs").addEventListener("click", () => {
  closeSidebar();
  openCallLogs();
});
document.getElementById("sc-logout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/auth";
});
document.getElementById("archived-close").addEventListener("click", () => {
  document.getElementById("archived-modal").classList.add("hidden");
});
document.getElementById("call-logs-close").addEventListener("click", () => {
  document.getElementById("call-logs-modal").classList.add("hidden");
});

async function openCallLogs() {
  const modal = document.getElementById("call-logs-modal");
  const list = document.getElementById("call-logs-list");
  modal.classList.remove("hidden");
  list.innerHTML = '<div style="padding:16px;color:var(--text-dim)">加载中…</div>';
  const logs = await api("GET", "/call-logs");
  list.innerHTML = "";
  if (!logs || logs.length === 0) {
    list.innerHTML = '<div style="padding:16px;color:var(--text-dim)">暂无来电记录</div>';
    return;
  }
  for (const log of logs) {
    const item = document.createElement("div");
    item.className = "archived-item";
    item.style.flexDirection = "column";
    item.style.alignItems = "flex-start";
    item.style.gap = "6px";

    const top = document.createElement("div");
    top.style.cssText = "display:flex;align-items:center;gap:10px;width:100%";

    const status = document.createElement("span");
    status.style.cssText = `font-size:11px;padding:2px 7px;border-radius:10px;background:${log.answered ? "rgba(61,186,110,0.15)" : "rgba(224,82,82,0.15)"};color:${log.answered ? "#3dba6e" : "#e05252"}`;
    status.textContent = log.answered ? "已接听" : "未接听";

    const charName = document.createElement("span");
    charName.style.cssText = "font-size:13px;font-weight:600;color:var(--text);flex:1";
    charName.textContent = log.char_name;

    const time = document.createElement("span");
    time.style.cssText = "font-size:11px;color:var(--text-dim)";
    time.textContent = log.created_at ? log.created_at.slice(0, 16).replace("T", " ") : "";

    top.appendChild(status);
    top.appendChild(charName);
    top.appendChild(time);

    const script = document.createElement("div");
    script.style.cssText = "font-size:12px;color:var(--text-dim);line-height:1.5;max-height:60px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical";
    script.textContent = log.script || "";

    item.appendChild(top);
    item.appendChild(script);

    const replayBtn = document.createElement("button");
    replayBtn.className = "archived-restore-btn";
    replayBtn.textContent = "重播来电";
    replayBtn.addEventListener("click", () => {
      document.getElementById("call-logs-modal").classList.add("hidden");
      showIncomingCall({
        char_name: log.char_name,
        script: log.script,
        audio_url: log.audio_url || null,
        show_subtitle: true
      });
    });
    item.appendChild(replayBtn);

    list.appendChild(item);
  }
}

// ── 聊天区更多按钮 ────────────────────────────────────────────────────────────
// ── 全屏 ──────────────────────────────────────────────────────────────────────
// ── 沉浸模式 ──────────────────────────────────────────────────────────────────
let immersiveMode = false;

function setImmersive(on) {
  immersiveMode = on;
  document.querySelector(".layout").classList.toggle("immersive", on);
  const enter = document.getElementById("icon-immersive-enter");
  const exit = document.getElementById("icon-immersive-exit");
  if (enter) enter.style.display = on ? "none" : "";
  if (exit) exit.style.display = on ? "" : "none";
  document.getElementById("btn-immersive").classList.toggle("active", on);
}

document.getElementById("btn-immersive").addEventListener("click", () => {
  setImmersive(!immersiveMode);
});

document.getElementById("btn-fullscreen").addEventListener("click", () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
});

document.addEventListener("fullscreenchange", () => {
  const isFs = !!document.fullscreenElement;
  document.getElementById("btn-fullscreen").classList.toggle("active", isFs);
});

// ── 搜索 ──────────────────────────────────────────────────────────────────────
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) { searchResults.classList.add("hidden"); return; }
  searchTimer = setTimeout(async () => {
    try {
      const rows = await api("GET", `/search?q=${encodeURIComponent(q)}`);
      searchResults.innerHTML = "";
      if (rows.length === 0) {
        searchResults.innerHTML = `<div style="padding:12px 14px;color:var(--text-dim);font-size:13px">没有找到相关消息</div>`;
      } else {
        for (const row of rows) {
          const item = document.createElement("div");
          item.className = "search-result-item";
          const highlighted = row.content.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<em>${m}</em>`);
          item.innerHTML = `<div class="sr-session">${row.title}</div><div class="sr-content">${highlighted}</div>`;
          item.addEventListener("click", async () => {
            searchResults.classList.add("hidden");
            searchInput.value = "";
            await selectSession(row.session_id);
            setTimeout(() => {
              const el = messages.querySelector(`[data-msg-id="${row.id}"]`);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 300);
          });
          searchResults.appendChild(item);
        }
      }
      searchResults.classList.remove("hidden");
    } catch {}
  }, 300);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { searchResults.classList.add("hidden"); searchInput.value = ""; }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-input") && !e.target.closest("#search-results")) {
    searchResults.classList.add("hidden");
  }
});

// Ctrl+K 聚焦搜索
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    focusSearch();
  }
});

// ── 初始化 ────────────────────────────────────────────────────────────────────
async function loadCharacter() {
  try {
    const data = await api("GET", "/character");
    const prevName = localStorage.getItem("last-character-name") || "";
    characterName = data.name || "";
    if (characterName) AVATAR_DEFAULTS.assistant = characterName[0];
    // 角色名变了，清掉旧角色的头像缓存和手动标记
    if (prevName && prevName !== characterName) {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(`avatar:assistant:${prevName}`) || key === `avatar:manual:${prevName}`) {
          localStorage.removeItem(key);
        }
      }
    }
    localStorage.setItem("last-character-name", characterName);
    // 更新 header 角色名和头像初始状态
    const titleEl = document.getElementById("chat-title-text");
    if (titleEl) titleEl.textContent = characterName;
    const headerAvatar = document.getElementById("chat-header-avatar");
    if (headerAvatar && !headerAvatar.querySelector("img")) {
      headerAvatar.textContent = characterName ? characterName[0] : "?";
    }
    renderCharacterCard(data.card_url || null);
    initSlideshow(data.slideshow_enabled, data.slideshow_interval ?? 30);
    startCardCarousel();
    renderAffection(data.affection ?? 10);
    // 同步设置面板
    const toggle = document.getElementById("slideshow-toggle");
    const intervalInput = document.getElementById("slideshow-interval");
    if (toggle) toggle.classList.toggle("on", !!data.slideshow_enabled);
    if (intervalInput) intervalInput.value = data.slideshow_interval ?? 30;
  } catch {}
  // 拉取当前角色的最新头像，刷新 localStorage（外貌变了也能同步，但不覆盖用户手动设置的头像）
  try {
    const av = await api("GET", "/avatars");
    const manualKey = `avatar:manual:${characterName}`;
    const manualSet = new Set(JSON.parse(localStorage.getItem(manualKey) || "[]"));
    for (const [mood, url] of Object.entries(av.avatars || {})) {
      const key = avatarKey("assistant", mood === "neutral" ? null : mood);
      if (!manualSet.has(key)) localStorage.setItem(key, url);
    }
    refreshAllAssistantAvatars();
    renderMoodIndicator(currentMood);
  } catch {}
}

// ── 卡片重新生成 ──────────────────────────────────────────────────────────────
document.getElementById("rp-card-regen").addEventListener("click", async () => {
  const btn = document.getElementById("rp-card-regen");
  btn.disabled = true;
  const img = document.getElementById("rp-card-img");
  const skeleton = document.getElementById("rp-card-skeleton");
  if (img) img.classList.add("hidden");
  if (skeleton) skeleton.classList.remove("hidden");
  // 60s 超时兜底，防止 SSE 未到达时按钮永久禁用
  const fallback = setTimeout(() => { btn.disabled = false; }, 60000);
  try {
    await api("POST", "/character/cards/generate");
    // 结果通过 SSE card_update 推送；SSE 到达时会清除 disabled
    // 同时在 SSE handler 里 clearTimeout(fallback) 是做不到的，靠超时兜底即可
  } catch {
    clearTimeout(fallback);
    btn.disabled = false;
    if (skeleton) skeleton.classList.remove("hidden");
  }
});

// ── 卡片库 ────────────────────────────────────────────────────────────────────
document.getElementById("rp-card-library").addEventListener("click", openCardLibrary);
document.getElementById("card-library-close").addEventListener("click", () => {
  document.getElementById("card-library-modal").classList.add("hidden");
});

// ── 重置情绪头像 ──────────────────────────────────────────────────────────────
document.getElementById("rp-avatar-reset").addEventListener("click", async () => {
  const btn = document.getElementById("rp-avatar-reset");
  btn.disabled = true;
  try {
    // 清除数据库中的情绪头像
    await api("DELETE", "/avatars");
    // 清除 localStorage 中该角色的所有头像缓存（手动和自动）
    const prefix = `avatar:assistant:${characterName}`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
    localStorage.removeItem(`avatar:manual:${characterName}`);
    // 刷新 UI，触发重新生成
    refreshAllAssistantAvatars();
    renderMoodIndicator(currentMood);
    renderRightPanelMood(currentMood);
    showToast("情绪头像已重置，将在下次情绪更新时重新生成");
  } catch {
    showToast("重置失败");
  } finally {
    btn.disabled = false;
  }
});

async function openCardLibrary() {
  const modal = document.getElementById("card-library-modal");
  const grid = document.getElementById("card-library-grid");
  grid.innerHTML = `<div style="color:var(--text-dim);font-size:13px;padding:20px;grid-column:1/-1">加载中…</div>`;
  modal.classList.remove("hidden");
  try {
    const cards = await api("GET", "/character/cards");
    grid.innerHTML = "";
    if (cards.length === 0) {
      grid.innerHTML = `<div style="color:var(--text-dim);font-size:13px;padding:20px;grid-column:1/-1">还没有卡片</div>`;
      return;
    }
    for (const card of cards) {
      const item = document.createElement("div");
      item.className = "card-library-item" + (card.is_active ? " active" : "");
      item.innerHTML = `
        <img src="${card.image_url}" loading="lazy">
        ${card.is_active ? '<span class="cli-badge">当前</span>' : ""}
        <button class="cli-del" title="删除">✕</button>
      `;
      item.querySelector("img").addEventListener("click", async () => {
        const res = await api("PATCH", `/character/cards/${card.id}/activate`);
        modal.classList.add("hidden");
        if (res?.card_url) renderCharacterCard(res.card_url);
      });
      item.querySelector(".cli-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        await api("DELETE", `/character/cards/${card.id}`);
        item.remove();
      });
      grid.appendChild(item);
    }
  } catch {
    grid.innerHTML = `<div style="color:#e05;font-size:13px;padding:20px;grid-column:1/-1">加载失败</div>`;
  }
}

// ── 卡片轮播 ──────────────────────────────────────────────────────────────────
let _slideshowTimer = null;

function initSlideshow(enabled, intervalMinutes) {
  clearInterval(_slideshowTimer);
  if (!enabled) return;
  const ms = Math.max(1, intervalMinutes) * 60 * 1000;
  _slideshowTimer = setInterval(async () => {
    try {
      await api("POST", "/character/cards/generate");
    } catch {}
  }, ms);
}

// ── 多卡片轮播（每 5 分钟切换一张已有卡片）────────────────────────────────────
let _carouselTimer = null;
let _carouselIndex = 0;

async function startCardCarousel() {
  clearInterval(_carouselTimer);
  _carouselTimer = setInterval(async () => {
    try {
      const cards = await api("GET", "/character/cards");
      if (!cards || cards.length < 2) return;
      _carouselIndex = (_carouselIndex + 1) % cards.length;
      renderCharacterCard(cards[_carouselIndex].image_url);
    } catch {}
  }, 5 * 60 * 1000);
}

// 设置面板中的轮播 toggle
document.getElementById("slideshow-toggle").addEventListener("click", () => {
  document.getElementById("slideshow-toggle").classList.toggle("on");
});
document.getElementById("chat-image-toggle").addEventListener("click", () => {
  document.getElementById("chat-image-toggle").classList.toggle("on");
});
document.getElementById("image-auto-expand-toggle").addEventListener("click", () => {
  document.getElementById("image-auto-expand-toggle").classList.toggle("on");
});
document.getElementById("image-fallback-toggle").addEventListener("click", () => {
  document.getElementById("image-fallback-toggle").classList.toggle("on");
});
document.getElementById("collapse-action-toggle").addEventListener("click", () => {
  document.getElementById("collapse-action-toggle").classList.toggle("on");
});

document.getElementById("tts-enabled-setting-toggle")?.addEventListener("click", () => {
  document.getElementById("tts-enabled-setting-toggle").classList.toggle("on");
});

// ── 公告弹窗 ──────────────────────────────────────────────────────────────────
async function checkAnnouncements() {
  try {
    const list = await api("GET", "/announcements/unread");
    if (!list || !list.length) return;
    showAnnouncementModal(list, 0);
  } catch {}
}

function showAnnouncementModal(list, index) {
  const ann = list[index];
  if (!ann) return;

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px";

  const box = document.createElement("div");
  box.style.cssText = "background:var(--surface,#16161a);border:1px solid var(--border,#2a2a35);border-radius:12px;padding:24px;max-width:480px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.5)";

  const title = document.createElement("h3");
  title.style.cssText = "margin:0 0 12px;font-size:16px;font-weight:600";
  title.textContent = ann.title;

  const content = document.createElement("p");
  content.style.cssText = "margin:0 0 20px;font-size:14px;line-height:1.6;color:var(--text-dim,#aaa);white-space:pre-wrap";
  content.textContent = ann.content;

  const footer = document.createElement("div");
  footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px";

  const closeBtn = document.createElement("button");
  closeBtn.textContent = list.length > index + 1 ? `知道了（${index + 1}/${list.length}）` : "知道了";
  closeBtn.style.cssText = "padding:8px 20px;border-radius:6px;border:none;background:var(--accent,#7c6fcd);color:#fff;cursor:pointer;font-size:14px;font-family:inherit";

  closeBtn.addEventListener("click", async () => {
    document.body.removeChild(overlay);
    try { await api("POST", `/announcements/${ann.id}/read`); } catch {}
    if (index + 1 < list.length) showAnnouncementModal(list, index + 1);
  });

  footer.appendChild(closeBtn);
  box.appendChild(title);
  box.appendChild(content);
  box.appendChild(footer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

(async () => {
  await loadCharacter();
  try {
    const gs = await api("GET", "/settings");
    window._imageAutoExpand = !!gs.imageAutoExpand;
    window._collapseAction = !!gs.collapseAction;
  } catch {}
  initMoodGrid();
  initBottomNav();
  initChatTitleEdit();
  loadSessions();
  checkAnnouncements();
  checkVoicemail();

  // 新用户引导：打开右侧状态面板并展开角色设定
  if (localStorage.getItem("show_onboarding") === "1") {
    localStorage.removeItem("show_onboarding");
    setTimeout(() => {
      openRightPanel();
      const body = document.getElementById("rp-soul-body");
      const header = document.getElementById("rp-soul-toggle");
      if (body && body.classList.contains("hidden")) {
        body.classList.remove("hidden");
        header?.classList.add("open");
      }
      body?.scrollIntoView({ behavior: "smooth", block: "start" });
      showToast("欢迎！已为你创建默认角色「龙卷」，可在【角色设定】中修改或新建角色", false, 6000);
    }, 800);
  }
})();
