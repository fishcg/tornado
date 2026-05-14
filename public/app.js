async function api(path, options) {
  const hasBody = options?.body != null;
  const response = await fetch(path, {
    headers: hasBody ? { "Content-Type": "application/json" } : {},
    ...options
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value, max = 24) {
  const text = String(value || "").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function renderStats(stats) {
  const el = document.getElementById("stats");
  el.innerHTML = `
    <div class="stat"><span>${stats.total_memories}</span><small>Memories</small></div>
    <div class="stat"><span>${stats.unconsolidated}</span><small>Pending</small></div>
    <div class="stat"><span>${stats.consolidations}</span><small>Consolidations</small></div>
  `;
}

function renderMemories(memories) {
  const el = document.getElementById("memories");
  if (!memories.length) {
    el.innerHTML = `<p class="muted">还没有记忆。</p>`;
    return;
  }

  el.innerHTML = memories
    .map(
      (memory) => `
      <article class="memory-card">
        <div class="row">
          <strong>#${memory.id}</strong>
          <div class="memory-card-actions">
            <small>${memory.source || "unknown"}</small>
            <button type="button" class="memory-delete-btn" data-memory-id="${memory.id}">删除</button>
          </div>
        </div>
        <p>${memory.summary}</p>
        <div class="tags">
          ${memory.topics.map((topic) => `<span>${topic}</span>`).join("")}
        </div>
      </article>
    `
    )
    .join("");
}

function buildGraphLayout(nodes, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(90, Math.min(width, height) / 2 - 90);
  const ordered = [...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0) || String(a.id).localeCompare(String(b.id), "zh-Hans-CN"));

  return ordered.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(ordered.length, 1) - Math.PI / 2;
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    };
  });
}

function renderGraphMeta(meta) {
  const el = document.getElementById("graphMeta");
  if (!meta) {
    el.textContent = "";
    return;
  }

  el.innerHTML = `
    <span class="graph-meta">
      <span class="graph-chip">实体 ${meta.total_entities || 0}</span>
      <span class="graph-chip">关系 ${meta.total_relationships || 0}</span>
      <span class="graph-chip">证据记忆 ${meta.evidence_memories || 0}</span>
    </span>
  `;
}

function renderGraphDetails(html) {
  const el = document.getElementById("graphDetails");
  el.innerHTML = html;
}

function nodeDetailsMarkup(node, graph) {
  const relatedEdges = (graph.edges || []).filter((edge) => edge.source === node.id || edge.target === node.id);
  return `
    <h4>${escapeHtml(node.label || node.id)}</h4>
    <p>关联边数：${relatedEdges.length} · 涉及记忆：${(node.memory_ids || []).join(", ") || "无"}</p>
    <ul>
      ${relatedEdges
        .map((edge) => {
          return `<li>${escapeHtml(edge.source)} → ${escapeHtml(edge.relationship)} → ${escapeHtml(edge.target)}（证据 #${(edge.evidence_memory_ids || []).join(", #")}）</li>`;
        })
        .join("")}
    </ul>
    <button class="secondary" style="margin-top:8px;font-size:12px" data-delete-entity="${escapeHtml(node.id)}">删除此节点</button>
  `;
}

function edgeDetailsMarkup(edge) {
  return `
    <h4>${escapeHtml(edge.source)} → ${escapeHtml(edge.relationship)} → ${escapeHtml(edge.target)}</h4>
    <p>聚合权重：${edge.weight || 1}</p>
    <p>证据记忆：${(edge.evidence_memory_ids || []).map((id) => `#${id}`).join(", ") || "无"}</p>
  `;
}

function renderGraph(graph) {
  const el = document.getElementById("graph");
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  renderGraphMeta(graph?.meta);

  if (!nodes.length || !edges.length) {
    el.innerHTML = `<p class="muted graph-empty">还没有可展示的实体关系。需要先完成巩固，LLM 才会抽取实体关系。</p>`;
    renderGraphDetails("选中节点或边后，这里会显示证据记忆与关系详情。");
    return;
  }

  const width = 920;
  const height = 520;
  const degreeMap = new Map(nodes.map((node) => [node.id, Number(node.degree) || 0]));

  for (const edge of edges) {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1);
    degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1);
  }

  const laidOutNodes = buildGraphLayout(
    nodes.map((node) => ({
      ...node,
      degree: degreeMap.get(node.id) || 0
    })),
    width,
    height
  );

  const positions = new Map(laidOutNodes.map((node) => [node.id, node]));

  // 统计同一对节点之间的边，用于偏移重叠的边和标签
  const pairCount = new Map();
  const pairIndex = new Map();
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join("||");
    pairCount.set(key, (pairCount.get(key) || 0) + 1);
  }

  const edgeMarkup = edges
    .map((edge, index) => {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) {
        return "";
      }

      const key = [edge.source, edge.target].sort().join("||");
      const total = pairCount.get(key) || 1;
      const idx = pairIndex.get(key) || 0;
      pairIndex.set(key, idx + 1);

      // 多条边时用曲线，偏移量让各条边分开
      const mx = (source.x + target.x) / 2;
      const my = (source.y + target.y) / 2;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      // 垂直方向偏移，第 0 条不偏移，后续交替偏移
      const offsetStep = 28;
      const offsetIndex = total === 1 ? 0 : (idx - (total - 1) / 2);
      const offsetX = (-dy / len) * offsetStep * offsetIndex;
      const offsetY = (dx / len) * offsetStep * offsetIndex;
      const cx = mx + offsetX;
      const cy = my + offsetY;

      const pathD = total === 1
        ? `M ${source.x} ${source.y} L ${target.x} ${target.y}`
        : `M ${source.x} ${source.y} Q ${cx} ${cy} ${target.x} ${target.y}`;

      const labelX = total === 1 ? mx : (source.x + target.x) / 4 + cx / 2;
      const labelY = total === 1 ? my - 6 : (source.y + target.y) / 4 + cy / 2 - 6;

      const title = `${edge.source} → ${edge.relationship} → ${edge.target}\n证据记忆: ${(edge.evidence_memory_ids || []).join(", ") || "无"}`;
      return `
        <g class="graph-edge-group" data-edge-index="${index}">
          <path class="graph-edge" d="${pathD}" fill="none"></path>
          <text class="graph-edge-label" x="${labelX}" y="${labelY}" text-anchor="middle">${escapeHtml(truncate(edge.relationship, 24))}</text>
          <title>${escapeHtml(title)}</title>
        </g>
      `;
    })
    .join("");

  const nodeMarkup = laidOutNodes
    .map((node) => {
      const radius = 20 + Math.min(16, (node.degree || 0) * 2) + Math.min(12, (node.memory_ids || []).length * 2);
      return `
        <g class="graph-node-group" data-node-id="${escapeHtml(node.id)}">
          <circle class="graph-node" cx="${node.x}" cy="${node.y}" r="${radius}"></circle>
          <text class="graph-node-id" x="${node.x}" y="${node.y + 2}" text-anchor="middle">${escapeHtml(truncate(node.label || node.id, 10))}</text>
          <title>${escapeHtml(`${node.label || node.id}\n关联边数: ${node.degree || 0}\n记忆: ${(node.memory_ids || []).join(", ") || "无"}`)}</title>
        </g>
      `;
    })
    .join("");

  el.innerHTML = `
    <svg class="graph-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="实体关系图谱">
      ${edgeMarkup}
      ${nodeMarkup}
    </svg>
  `;

  renderGraphDetails("选中节点或边后，这里会显示证据记忆与关系详情。");

  for (const edgeEl of el.querySelectorAll(".graph-edge-group")) {
    edgeEl.addEventListener("click", () => {
      el.querySelectorAll(".graph-edge-group, .graph-node-group").forEach((item) => item.classList.remove("is-active"));
      edgeEl.classList.add("is-active");
      const edge = edges[Number(edgeEl.dataset.edgeIndex)];
      if (edge) {
        renderGraphDetails(edgeDetailsMarkup(edge));
      }
    });
  }

  for (const nodeEl of el.querySelectorAll(".graph-node-group")) {
    nodeEl.addEventListener("click", () => {
      el.querySelectorAll(".graph-edge-group, .graph-node-group").forEach((item) => item.classList.remove("is-active"));
      nodeEl.classList.add("is-active");
      const node = nodes.find((item) => item.id === nodeEl.dataset.nodeId);
      if (node) {
        renderGraphDetails(nodeDetailsMarkup(node, graph));
      }
    });
  }
}

document.getElementById("graphDetails").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-delete-entity]");
  if (!btn) return;
  const name = btn.dataset.deleteEntity;
  btn.disabled = true;
  btn.textContent = "删除中…";
  try {
    await api(`/graph/entity/${encodeURIComponent(name)}`, { method: "DELETE" });
    await refresh();
  } catch {
    btn.disabled = false;
    btn.textContent = "删除此节点";
  }
});

async function refresh() {
  const source = document.getElementById("sourceFilter")?.value || "";
  const qs = source ? `?source=${encodeURIComponent(source)}` : "";
  const [stats, memories, graph] = await Promise.all([
    api("/status"),
    api(`/memories${qs}`),
    api(`/graph${qs}`)
  ]);
  renderStats(stats);
  renderMemories(memories.memories || []);
  renderGraph(graph);
}

async function refreshSources() {
  const sel = document.getElementById("sourceFilter");
  if (!sel) return;
  const current = sel.value;
  const { sources } = await api("/sources");

  // 提取用户前缀（tornado-{userId}），去重
  const userPrefixes = [...new Set(
    sources
      .filter((s) => s.startsWith("tornado-"))
      .map((s) => {
        const parts = s.split("-");
        return parts.length >= 2 ? `tornado-${parts[1]}` : null;
      })
      .filter(Boolean)
  )].sort();

  const otherSources = sources.filter((s) => !s.startsWith("tornado-"));

  sel.innerHTML = `<option value="">全部</option>` +
    userPrefixes.map((p) => {
      const uid = p.split("-")[1];
      return `<option value="${p}"${p === current ? " selected" : ""}>用户 ${uid}</option>`;
    }).join("") +
    otherSources.map((s) => `<option value="${s}"${s === current ? " selected" : ""}>${s}</option>`).join("");
}

function withLoading(btn, loadingText, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = loadingText;
    const start = Date.now();
    try {
      await fn(...args);
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 400) await new Promise((r) => setTimeout(r, 400 - elapsed));
      btn.disabled = false;
      btn.textContent = original;
    }
  };
}

const refreshBtn = document.getElementById("refreshButton");
refreshBtn.addEventListener("click", withLoading(refreshBtn, "刷新中…", async () => {
  await refreshSources();
  await refresh();
}));

const consolidateBtn = document.getElementById("consolidateButton");
consolidateBtn.addEventListener(
  "click",
  withLoading(consolidateBtn, "巩固中…", async () => {
    const source = document.getElementById("sourceFilter")?.value || "";
    const body = source ? { source } : {};
    const result = await api("/consolidate", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("queryResult").textContent = result.response || "";
    await refresh();
  })
);

const ingestSubmitBtn = document.querySelector("#ingestForm button[type=submit]");
document.getElementById("ingestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (ingestSubmitBtn.disabled) return;
  const original = ingestSubmitBtn.textContent;
  ingestSubmitBtn.disabled = true;
  ingestSubmitBtn.textContent = "写入中…";
  try {
    const form = new FormData(event.currentTarget);
    const result = await api("/ingest", {
      method: "POST",
      body: JSON.stringify({
        source: form.get("source") || "dashboard",
        text: form.get("text") || ""
      })
    });
    document.getElementById("ingestResult").textContent = JSON.stringify(result, null, 2);
    event.currentTarget.reset();
    await refresh();
  } finally {
    ingestSubmitBtn.disabled = false;
    ingestSubmitBtn.textContent = original;
  }
});

document.getElementById("memories").addEventListener("click", async (event) => {
  const button = event.target.closest(".memory-delete-btn");
  if (!button || button.disabled) return;

  const memoryId = Number(button.dataset.memoryId);
  if (!memoryId) return;

  const original = button.textContent;
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    await api("/delete", {
      method: "POST",
      body: JSON.stringify({ memory_id: memoryId })
    });
    await refresh();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

const querySubmitBtn = document.querySelector("#queryForm button[type=submit]");
document.getElementById("queryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (querySubmitBtn.disabled) return;
  const original = querySubmitBtn.textContent;
  querySubmitBtn.disabled = true;
  querySubmitBtn.textContent = "查询中…";
  try {
    const form = new FormData(event.currentTarget);
    const question = form.get("question") || "";
    const source = document.getElementById("sourceFilter")?.value || "";
    const url = source
      ? `/query?q=${encodeURIComponent(question)}&source=${encodeURIComponent(source)}`
      : `/query?q=${encodeURIComponent(question)}`;
    const result = await api(url);
    document.getElementById("queryResult").textContent = result.answer || "";
  } finally {
    querySubmitBtn.disabled = false;
    querySubmitBtn.textContent = original;
  }
});

document.getElementById("sourceFilter")?.addEventListener("change", refresh);

void refreshSources().then(() => refresh());
