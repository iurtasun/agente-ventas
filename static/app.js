/* Agente de ventas — cliente vanilla que consume la API y servidor SSE. */

const STORAGE_KEY = "agente-ventas.session";

const state = {
  currentId: localStorage.getItem(STORAGE_KEY) || null,
  streaming: false,
  controller: null,
  sessions: [],
  sidebarAuto: false,
};

const $ = (sel) => document.querySelector(sel);

const els = {
  sidebar: $("#sidebar"),
  sessionList: $("#session-list"),
  messages: $("#messages"),
  chat: $("#chat"),
  welcome: $("#welcome"),
  composer: $("#composer"),
  input: $("#input"),
  send: $("#send"),
  stop: $("#stop"),
  statusDot: $("#status-dot"),
  statusText: $("#status-text"),
  modelLine: $("#model-line"),
  modelBadge: $("#model-badge"),
  topbarTitle: $("#topbar-title"),
  toast: $("#toast"),
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function inlineMarkdown(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  return s;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function cellClass(cell) {
  return /^-?[\d.,]+\s*%?$/.test(cell.replace(/[€$]/g, "").trim()) ? "num" : "";
}

function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((c) => c.startsWith(":") || c.endsWith(":"));
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const th = header
    .map((c, idx) => `<th class="${cellClass(c)}"${align[idx] ? ' style="text-align:right"' : ""}>${inlineMarkdown(c)}</th>`)
    .join("");
  const tb = rows
    .map(
      (r) =>
        `<tr>${r.map((c, idx) => `<td class="${cellClass(c)}"${align[idx] ? ' style="text-align:right"' : ""}>${inlineMarkdown(c)}</td>`).join("")}</tr>`
    )
    .join("");
  return { html: `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`, next: i };
}

function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];

  const flush = () => {
    if (para.length) {
      out.push(`<p>${inlineMarkdown(para.join(" "))}</p>`);
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush();
      const { html, next } = parseTable(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      flush();
      const ordered = /^\d+\./.test(trimmed);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inlineMarkdown(t)}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }

    if (!trimmed) {
      flush();
      i++;
      continue;
    }

    para.push(trimmed);
    i++;
  }

  flush();
  return out.join("");
}

let toastTimer = null;
function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3800);
}

async function errorMessage(response) {
  try {
    const data = await response.json();
    if (typeof data.detail === "string") return data.detail;
    return JSON.stringify(data.detail ?? data);
  } catch {
    return `Error ${response.status}`;
  }
}

/* ------------------------------------------------------------------ */
/* Estado de la interfaz                                               */
/* ------------------------------------------------------------------ */

function setStreaming(active) {
  state.streaming = active;
  els.send.classList.toggle("hidden", active);
  els.stop.classList.toggle("hidden", !active);
  els.input.disabled = active;
  updateSendState();
}

function updateSendState() {
  if (state.streaming) return;
  els.send.disabled = !els.input.value.trim();
}

function showWelcome(visible) {
  els.welcome.classList.toggle("hidden", !visible);
}

function scrollToBottom() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
}

/* ------------------------------------------------------------------ */
/* Mensajes                                                            */
/* ------------------------------------------------------------------ */

function addUserMessage(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  const body = document.createElement("div");
  body.className = "msg-body";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdown(text);
  body.appendChild(bubble);
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  scrollToBottom();
}

function addAssistantMessage() {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "✦";

  const body = document.createElement("div");
  body.className = "msg-body";

  const tools = document.createElement("div");
  tools.className = "tools hidden";

  const thinking = document.createElement("details");
  thinking.className = "thinking hidden";
  const thinkingSummary = document.createElement("summary");
  thinkingSummary.textContent = "Razonamiento";
  const thinkingBody = document.createElement("div");
  thinkingBody.className = "thinking-body";
  thinking.append(thinkingSummary, thinkingBody);

  const bubble = document.createElement("div");
  bubble.className = "bubble cursor-blink";
  bubble.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';

  body.append(tools, thinking, bubble);
  wrap.append(avatar, body);
  els.messages.appendChild(wrap);
  scrollToBottom();

  let currentText = "";
  let thinkingText = "";

  const setText = (text, isError = false) => {
    currentText = text;
    bubble.classList.toggle("error-bubble", isError);
    bubble.innerHTML = text ? renderMarkdown(text) : "";
    scrollToBottom();
  };

  const appendDelta = (text) => {
    currentText += text;
    bubble.innerHTML = renderMarkdown(currentText);
    scrollToBottom();
  };

  // Un mensaje nuevo del modelo empieza: lo anterior era razonamiento.
  const startSegment = () => {
    const carry = currentText.trim();
    if (carry) {
      thinkingText += `${thinkingText ? "\n\n" : ""}${carry}`;
      thinkingBody.innerHTML = renderMarkdown(thinkingText);
      thinking.classList.remove("hidden");
      thinkingSummary.textContent = `Razonamiento · ${thinkingText.split("\n\n").length} pasos`;
    }
    currentText = "";
    bubble.innerHTML = "";
    bubble.classList.add("cursor-blink");
    scrollToBottom();
  };

  const setThinking = (text) => {
    if (!text || !text.trim()) return;
    thinkingText = text;
    thinkingBody.innerHTML = renderMarkdown(text);
    thinking.classList.remove("hidden");
    thinkingSummary.textContent = "Razonamiento";
  };

  const getText = () => currentText;
  const finish = () => {
    bubble.classList.remove("cursor-blink");
    thinkingSummary.textContent = "Razonamiento";
  };

  return { wrap, tools, bubble, thinking, setText, appendDelta, startSegment, setThinking, getText, finish };
}

function addToolPill(toolsDiv, data) {
  toolsDiv.classList.remove("hidden");
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "tool running";
  pill.dataset.toolId = data.id || "";
  pill.innerHTML = `<span class="icon">⟳</span><span class="name">${escapeHtml(data.name || "herramienta")}</span><span class="status">consultando…</span>`;

  const detail = document.createElement("pre");
  detail.className = "tool-detail hidden";
  detail.textContent = JSON.stringify(data.arguments ?? {}, null, 2);

  pill.addEventListener("click", () => detail.classList.toggle("hidden"));
  toolsDiv.append(pill, detail);
  scrollToBottom();
  return pill;
}

function finishToolPill(toolsDiv, data) {
  const pills = [...toolsDiv.querySelectorAll(".tool")];
  const pill = pills.reverse().find((p) => p.dataset.toolId === (data.id || "")) || pills[0];
  if (!pill) return;

  pill.classList.remove("running");
  pill.classList.toggle("failed", !data.success);
  const icon = pill.querySelector(".icon");
  const status = pill.querySelector(".status");
  icon.textContent = data.success ? "✓" : "✕";
  status.textContent = data.success ? "hecho" : "error";

  const detail = pill.nextElementSibling;
  if (detail && detail.classList.contains("tool-detail")) {
    const parts = [detail.textContent];
    if (data.result) parts.push("— resultado —", data.result);
    if (data.error) parts.push("— error —", data.error);
    detail.textContent = parts.join("\n");
  }
}

function addErrorMessage(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "✦";
  const body = document.createElement("div");
  body.className = "msg-body";
  const bubble = document.createElement("div");
  bubble.className = "bubble error-bubble";
  bubble.innerHTML = renderMarkdown(text);
  body.appendChild(bubble);
  wrap.append(avatar, body);
  els.messages.appendChild(wrap);
  scrollToBottom();
}

function renderHistory(messages) {
  els.messages.innerHTML = "";
  if (!messages.length) {
    showWelcome(true);
    return;
  }
  showWelcome(false);
  for (const msg of messages) {
    if (msg.role === "user") {
      addUserMessage(msg.content);
    } else if (msg.role === "assistant") {
      const assistant = addAssistantMessage();
      for (const t of msg.tools || []) {
        addToolPill(assistant.tools, { id: t.id, name: t.name, arguments: t.arguments });
        finishToolPill(assistant.tools, { id: t.id, success: t.success === true, result: null });
      }
      assistant.setThinking(msg.thinking || "");
      assistant.setText(msg.content || "");
      assistant.finish();
    }
  }
  scrollToBottom();
}

/* ------------------------------------------------------------------ */
/* Sesiones                                                            */
/* ------------------------------------------------------------------ */

function sessionLabel(session) {
  return session.title || "Conversación sin título";
}

function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor(Math.max(0, Date.now() - then) / 60000);
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `hace ${days} d`;
  return new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

async function refreshSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) return;
    const data = await res.json();
    state.sessions = data.sessions || [];
    renderSessionList();
  } catch {
    /* silencioso: la lista es secundaria */
  }
}

function renderSessionList() {
  els.sessionList.innerHTML = "";
  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Aún no hay conversaciones.";
    els.sessionList.appendChild(empty);
    return;
  }
  for (const session of state.sessions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "session-item" + (session.id === state.currentId ? " active" : "");
    item.innerHTML = `<span class="s-main"><span class="label">${escapeHtml(sessionLabel(session))}</span><span class="meta">${escapeHtml(relativeTime(session.last_used_at))}</span></span>`;

    const del = document.createElement("span");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Eliminar conversación";
    del.addEventListener("click", async (evt) => {
      evt.stopPropagation();
      await deleteSession(session.id);
    });

    item.appendChild(del);
    item.addEventListener("click", () => openSession(session.id));
    els.sessionList.appendChild(item);
  }
}

async function openSession(id) {
  if (state.streaming) {
    showToast("Espera a que termine la respuesta o pulsa detener.");
    return;
  }
  try {
    const res = await fetch(`/api/sessions/${id}`);
    if (res.status === 404) {
      forgetSession();
      return;
    }
    if (!res.ok) throw new Error(await errorMessage(res));
    const data = await res.json();
    state.currentId = id;
    localStorage.setItem(STORAGE_KEY, id);
    els.topbarTitle.textContent = sessionLabel(data);
    if (data.model) els.modelBadge.textContent = data.model;
    renderHistory(data.messages || []);
    renderSessionList();
    if (window.innerWidth <= 780) els.sidebar.classList.add("collapsed");
  } catch (err) {
    showToast(err.message, true);
  }
}

async function deleteSession(id) {
  try {
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (res.status !== 204 && res.status !== 404) throw new Error(await errorMessage(res));
  } catch (err) {
    showToast(err.message, true);
    return;
  }
  if (state.currentId === id) forgetSession();
  await refreshSessions();
}

function forgetSession() {
  state.currentId = null;
  localStorage.removeItem(STORAGE_KEY);
  els.messages.innerHTML = "";
  els.topbarTitle.textContent = "Nueva conversación";
  showWelcome(true);
  renderSessionList();
}

function startNewChat() {
  if (state.streaming) {
    showToast("Detén la respuesta actual antes de empezar otra.");
    return;
  }
  forgetSession();
  els.input.focus();
}

/* ------------------------------------------------------------------ */
/* Envío con streaming                                                 */
/* ------------------------------------------------------------------ */

async function* readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      let event = "message";
      let data = null;
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          try {
            data = JSON.parse(line.slice(5).trim());
          } catch {
            data = null;
          }
        }
      }
      if (data !== null) yield { event, data };
    }
  }
}

async function ensureSession() {
  if (state.currentId) return state.currentId;
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const session = await res.json();
  state.currentId = session.id;
  localStorage.setItem(STORAGE_KEY, session.id);
  return session.id;
}

async function sendMessage(prompt) {
  const text = prompt.trim();
  if (!text || state.streaming) return;

  showWelcome(false);
  addUserMessage(text);
  els.input.value = "";
  autoGrow();

  const controller = new AbortController();
  state.controller = controller;
  setStreaming(true);

  const assistant = addAssistantMessage();

  try {
    const sessionId = await ensureSession();
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(await errorMessage(res));

    for await (const evt of readSSE(res)) {
      if (evt.event === "segment_start") {
        assistant.startSegment();
      } else if (evt.event === "delta") {
        assistant.appendDelta(evt.data.text || "");
      } else if (evt.event === "tool_start") {
        addToolPill(assistant.tools, evt.data);
        if (!assistant.getText().trim()) assistant.bubble.innerHTML = "";
      } else if (evt.event === "tool_end") {
        finishToolPill(assistant.tools, evt.data);
      } else if (evt.event === "error") {
        assistant.appendDelta(
          `${assistant.getText() ? "\n\n" : ""}⚠️ ${evt.data.message}`
        );
      } else if (evt.event === "done") {
        break;
      }
    }

    if (!assistant.getText().trim() && !assistant.tools.querySelector(".tool")) {
      assistant.setText("_El agente no devolvió contenido._");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      assistant.appendDelta(`${assistant.getText() ? "\n\n" : ""}_Respuesta detenida._`);
    } else {
      if (!assistant.getText().trim() && !assistant.tools.querySelector(".tool")) {
        assistant.wrap.remove();
      }
      addErrorMessage(`No se pudo completar la petición: ${err.message}`);
    }
  } finally {
    assistant.finish();
    setStreaming(false);
    state.controller = null;
    await refreshSessions();
    els.input.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    els.modelLine.textContent = data.default_model;
    els.modelBadge.textContent = data.default_model;

    if (!data.api_key_configured) {
      els.statusDot.className = "dot err";
      els.statusText.textContent = "Falta OPENROUTER_API_KEY";
      showToast("Crea un archivo .env con tu clave de OpenRouter.", true);
    } else if (!data.db_present) {
      els.statusDot.className = "dot err";
      els.statusText.textContent = "Base de datos ausente";
    } else {
      els.statusDot.className = "dot ok";
      els.statusText.textContent = "Listo";
    }
  } catch {
    els.statusDot.className = "dot err";
    els.statusText.textContent = "Servidor no disponible";
  }
}

function bindEvents() {
  els.composer.addEventListener("submit", (evt) => {
    evt.preventDefault();
    sendMessage(els.input.value);
  });

  els.input.addEventListener("input", () => {
    autoGrow();
    updateSendState();
  });

  els.input.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      sendMessage(els.input.value);
    }
  });

  els.stop.addEventListener("click", () => {
    if (state.controller) state.controller.abort();
  });

  $("#new-chat").addEventListener("click", startNewChat);

  $("#toggle-sidebar").addEventListener("click", () => {
    els.sidebar.classList.add("collapsed");
    state.sidebarAuto = false;
  });
  $("#open-sidebar").addEventListener("click", () => {
    els.sidebar.classList.remove("collapsed");
    state.sidebarAuto = false;
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 820 && state.sidebarAuto) {
      els.sidebar.classList.remove("collapsed");
      state.sidebarAuto = false;
    }
  });

  document.querySelectorAll(".suggestion").forEach((btn) => {
    btn.addEventListener("click", () => sendMessage(btn.dataset.prompt));
  });
}

async function init() {
  bindEvents();
  if (window.innerWidth <= 820) {
    els.sidebar.classList.add("collapsed");
    state.sidebarAuto = true;
  }
  autoGrow();
  updateSendState();
  await checkHealth();
  await refreshSessions();

  if (state.currentId) {
    await openSession(state.currentId);
  }
  els.input.focus();
}

init();
