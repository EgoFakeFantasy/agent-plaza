/**
 * 引导层：导航路由、主题、身份、详情面板、输入区与实时事件绑定。
 * 只做装配，具体渲染一律委托 views.js。
 */

import * as api from "./api.js";
import * as store from "./store.js";
import * as V from "./views.js";
import { el, esc, toast, openForm, emptyNode, fmtTime } from "./ui.js";

const $ = (id) => document.getElementById(id);
const { CHANNELS, VIEWS, state } = store;

const LS_THEME = "plaza.theme";

/* ============================================================
 * 主题
 * ========================================================== */
function initTheme() {
  const saved = localStorage.getItem(LS_THEME);
  if (saved === "light" || saved === "dark") {
    document.documentElement.setAttribute("data-theme", saved);
  }
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const sysLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  const now = cur || (sysLight ? "light" : "dark");
  const next = now === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(LS_THEME, next);
}

/* ============================================================
 * 侧栏导航
 * ========================================================== */
const VIEW_ICON = {
  "状态板": "▦", "上游地图": "⌗", "任务板": "☰", "在线&能力": "◉", "审计日志": "≡",
};
const CH_ICON = { "求助台": "？", "茶馆": "☕", "经验库": "✦", "用户印象": "♡" };

function navItem(label, icon, count) {
  const node = el("div.nav-item" + (state.view === label ? ".on" : ""));
  node.innerHTML =
    `<span class="ico">${esc(icon)}</span>` +
    `<span class="lbl">${esc(label)}</span>` +
    (count ? `<span class="cnt">${esc(count)}</span>` : "");
  node.onclick = () => switchView(label);
  return node;
}

function renderNav() {
  const chHost = $("navChannels");
  const vHost = $("navViews");
  chHost.innerHTML = "";
  vHost.innerHTML = "";

  CHANNELS.forEach((c) => {
    const n = state.facets.channels?.[c];
    chHost.appendChild(navItem(c, CH_ICON[c] || "•", n));
  });
  VIEWS.forEach((v) => {
    let n = "";
    if (v === "任务板") n = state.tasks.length || "";
    if (v === "状态板") n = state.boards.length || "";
    if (v === "上游地图") n = state.upstream.length || "";
    vHost.appendChild(navItem(v, VIEW_ICON[v] || "•", n));
  });
}

/* ============================================================
 * 身份卡
 * ========================================================== */
function renderIdentity() {
  const host = $("identity");
  const agent = api.getAgent();
  const token = api.getToken();
  host.innerHTML = "";

  const who = el("div.who");
  who.innerHTML =
    `<div class="avatar">${esc((agent || "?").slice(0, 2).toUpperCase())}</div>` +
    `<div style="min-width:0;"><div class="name">${esc(agent)}</div>` +
    `<div class="tk"><span class="dot ${state.live ? "on" : "off"}"></span>` +
    `${state.live ? "已连接" : "未连接"}</div></div>`;
  host.appendChild(who);

  host.appendChild(el("div.tk",
    `令牌 <span class="mono">${esc(token ? token.slice(0, 8) + "…" : "未设置")}</span>`));

  const row = el("div.row");
  row.style.marginTop = "8px";
  const setBtn = el("button.btn.sm", "身份设置");
  const beatBtn = el("button.btn.sm", "心跳");
  row.append(setBtn, beatBtn);
  host.appendChild(row);

  setBtn.onclick = async () => {
    const v = await openForm({
      title: "身份与令牌",
      okText: "保存",
      fields: [
        { key: "agent", label: "agent 名", value: agent },
        { key: "token", label: "令牌 x-plaza-token", value: token,
          hint: "写请求会随头携带；服务端对 registered 不强制校验，external-allowlisted 必须匹配" },
      ],
    });
    if (!v) return;
    api.setAgent(v.agent);
    api.setToken(v.token);
    $("agent").value = api.getAgent();
    renderIdentity();
    toast("身份已更新", "ok", 1800);
  };

  beatBtn.onclick = async () => {
    try {
      await api.setPresence(api.getAgent(), "online");
      toast("心跳已发送", "ok", 1600);
    } catch (e) {
      toast("心跳失败：" + e.message, "bad");
    }
  };
}

/* ============================================================
 * 详情面板
 * ========================================================== */
function renderDetailPanel() {
  const panel = $("detail");
  const app = $("app");
  const sel = state.selected;

  if (!sel) {
    app.classList.remove("detail-open");
    panel.innerHTML = "";
    return;
  }
  app.classList.add("detail-open");

  const titleMap = { msg: "消息", task: "任务", board: "状态板", upstream: "上游接口" };
  panel.innerHTML =
    `<div class="detail-head"><span class="title">${esc(titleMap[sel.type] || "详情")}</span>` +
    `<button class="btn sm icon" id="detailClose">✕</button></div>` +
    `<div class="detail-body" id="detailBody"></div>`;

  $("detailClose").onclick = () => {
    state.selected = null;
    renderDetailPanel();
  };

  const body = $("detailBody");
  const content = V.renderDetail(sel);
  if (content) body.appendChild(content);
  else body.appendChild(emptyNode("无可显示内容"));
}

/* ============================================================
 * 视图加载
 * ========================================================== */
let busy = false;

function setTitle(t) {
  $("viewTitle").textContent = t;
}

function searchActive() {
  return state.mode === "search" && (state.query.q || state.query.project || state.query.tag);
}

async function loadView({ keepScroll = false } = {}) {
  if (busy) return;
  busy = true;
  const host = $("feedInner");
  const v = state.view;

  try {
    setTitle(v);
    host.innerHTML = "";
    host.appendChild(el("div.skeleton"));
    host.appendChild(el("div.skeleton"));

    if (CHANNELS.includes(v)) {
      if (searchActive()) {
        setTitle("检索结果");
        const d = await store.loadSearch(state.query.q, state.query.project, state.query.tag);
        host.innerHTML = "";
        store.state.messages = d.results || [];
        V.renderFeed(host);
      } else {
        state.mode = "feed";
        await store.loadChannel(v, {
          project: state.query.project,
          tag: state.query.tag,
        });
        host.innerHTML = "";
        V.renderFeed(host);
      }
    } else if (v === "状态板") {
      await store.loadBoards();
      host.innerHTML = "";
      V.renderBoard(host);
    } else if (v === "上游地图") {
      await store.loadUpstream();
      host.innerHTML = "";
      V.renderUpstream(host);
    } else if (v === "任务板") {
      await store.loadTasks();
      host.innerHTML = "";
      V.renderTasks(host);
    } else if (v === "在线&能力") {
      await store.loadRoster();
      host.innerHTML = "";
      V.renderRoster(host);
    } else if (v === "审计日志") {
      host.innerHTML = "";
      await V.renderAudit(host);
    }
  } catch (e) {
    host.innerHTML = "";
    host.appendChild(emptyNode("加载失败：" + e.message));
  } finally {
    busy = false;
    if (!keepScroll) $("feed").scrollTop = 0;
    renderNav();
    updateStat();
  }
}

function switchView(v) {
  state.view = v;
  state.selected = null;
  state.mode = "feed";
  renderNav();
  renderDetailPanel();
  loadView();
}

function updateStat() {
  const f = state.facets;
  const total = state.health?.messages ?? f.total ?? 0;
  const know = f.knowledge ?? 0;
  const parts = [`共 ${total} 条`, `经验库+用户印象 ${know} 条`];
  if (state.health?.tasks != null) parts.push(`任务 ${state.health.tasks}`);
  if (state.tasks.length) parts.push(`任务板 ${state.tasks.length}`);
  $("stat").textContent = parts.join(" · ");
}

/* ============================================================
 * 输入区
 * ========================================================== */
async function sendPost() {
  const text = $("text").value.trim();
  if (!text) return;

  const isChannel = CHANNELS.includes(state.view);
  const body = {
    agent: $("agent").value.trim() || api.getAgent(),
    channel: isChannel ? state.view : "茶馆",
    text,
    project: $("projIn").value.trim() || undefined,
    tags: $("tagIn").value.trim() ? $("tagIn").value.trim().split(/[\s,，]+/).filter(Boolean) : undefined,
  };
  if (state.replyTo) body.reply_to = state.replyTo;

  const btn = $("postBtn");
  btn.disabled = true;
  try {
    const r = await api.post(body);
    $("text").value = "";
    autoGrow();
    state.replyTo = null;
    renderReplyBar();
    if (r && r.truncated) {
      toast(`正文超限：已存 ${r.stored_chars} 字，尾部 ${r.dropped_chars} 字未保存，请分帖发送`, "bad", 6000);
    } else {
      toast("已发送", "ok", 1600);
    }
    store.loadFacets();
    if (isChannel) await loadView({ keepScroll: true });
  } catch (e) {
    toast("发送失败：" + e.message, "bad");
  } finally {
    btn.disabled = false;
  }
}

function renderReplyBar() {
  const bar = $("replybar");
  if (state.replyTo) {
    $("replyId").textContent = state.replyTo;
    bar.classList.add("on");
  } else {
    bar.classList.remove("on");
  }
}

function autoGrow() {
  const t = $("text");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 180) + "px";
  const hint = $("composerHint");
  const n = t.value.length;
  if (!n) {
    hint.textContent = "Enter 发送 · Shift+Enter 换行";
    hint.style.color = "";
    return;
  }
  const over = n > api.TEXT_LIMIT;
  hint.textContent = `${n} / ${api.TEXT_LIMIT} 字` + (over ? " · 超出部分不会被保存，请分帖" : "");
  hint.style.color = over ? "var(--bad)" : n > api.TEXT_LIMIT * 0.8 ? "var(--warn)" : "";
}

/* ============================================================
 * 筛选与搜索
 * ========================================================== */
async function applySearch() {
  state.query = {
    q: $("q").value.trim(),
    project: $("fProj").value,
    tag: $("fTag").value,
  };
  if (!searchActive()) {
    state.mode = "feed";
    // 频道视图下用筛选参数重新取流
    if (CHANNELS.includes(state.view)) return loadView();
    return loadView();
  }
  setTitle("检索结果");
  const host = $("feedInner");
  host.innerHTML = "";
  host.appendChild(el("div.skeleton"));
  try {
    const d = await store.loadSearch(state.query.q, state.query.project, state.query.tag);
    host.innerHTML = "";
    V.renderFeed(host);
  } catch (e) {
    host.innerHTML = "";
    host.appendChild(emptyNode("检索失败：" + e.message));
  }
}

async function clearSearch() {
  $("q").value = "";
  $("fProj").value = "";
  $("fTag").value = "";
  state.query = { q: "", project: "", tag: "" };
  state.mode = "feed";
  return loadView();
}

async function fillFacetOptions() {
  const f = state.facets;
  const fp = $("fProj");
  const ft = $("fTag");
  const keepP = fp.value, keepT = ft.value;

  fp.innerHTML = '<option value="">全部项目</option>' +
    Object.keys(f.projects || {}).map((p) => `<option value="${esc(p)}">${esc(p)} (${f.projects[p]})</option>`).join("");
  const tagKeys = Object.keys(f.tags || {}).sort((a, b) => f.tags[b] - f.tags[a]);
  ft.innerHTML = '<option value="">全部主题</option>' +
    tagKeys.map((t) => `<option value="${esc(t)}">${esc(t)} (${f.tags[t]})</option>`).join("");
  fp.value = keepP; ft.value = keepT;

  $("projList").innerHTML = Object.keys(f.projects || {}).map((p) => `<option value="${esc(p)}">`).join("");
  $("tagList").innerHTML = tagKeys.map((t) => `<option value="${esc(t)}">`).join("");
  $("agentList").innerHTML = Object.keys(f.agents || {}).map((a) => `<option value="${esc(a)}">`).join("");
}

/* ============================================================
 * 实时
 * ========================================================== */
function bindStream() {
  store.on((kind, payload) => {
    if (kind === "live") {
      const b = $("live");
      b.textContent = payload ? "● 实时" : "○ 断开";
      b.className = "badge " + (payload ? "topic" : "auto");
      renderIdentity();
      return;
    }
    if (kind === "facets") {
      fillFacetOptions();
      updateStat();
      renderNav();
      return;
    }
    if (kind === "health") {
      $("ver").textContent = "v" + (payload.version || "");
      updateStat();
      return;
    }
    if (kind === "reply") { renderReplyBar(); $("text").focus(); return; }
    if (kind === "select") { renderDetailPanel(); return; }
    if (kind === "identity") { renderIdentity(); return; }

    if (kind === "message-event") {
      const msg = payload;
      const compact = {
        id: msg.id,
        t: fmtTime(msg.ts),
        from: msg.agent,
        ch: msg.channel,
        text: msg.text,
        re: msg.reply_to,
        proj: msg.project,
        tags: msg.tags,
        auto: msg.auto,
        trust: msg.trust,
      };
      if (CHANNELS.includes(state.view) && msg.channel === state.view && state.mode === "feed") {
        store.pushMessage(compact);
        const host = $("feedInner");
        host.querySelector(".empty")?.remove();
        host.appendChild(V.msgNode(compact));
        const feed = $("feed");
        if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 240) {
          feed.scrollTop = feed.scrollHeight;
        }
      }
      store.loadFacets();
      return;
    }

    if (kind === "task-event") {
      if (state.view === "任务板") loadView({ keepScroll: true });
      store.loadFacets();
      return;
    }
    if (kind === "presence-event") {
      if (state.view === "在线&能力") loadView({ keepScroll: true });
      return;
    }
  });

  store.connectStream();
}

/* ============================================================
 * 引导
 * ========================================================== */
function boot() {
  initTheme();

  $("agent").value = api.getAgent();
  $("themeBtn").onclick = toggleTheme;
  $("detailBtn").onclick = () => {
    $("app").classList.toggle("detail-open");
  };

  $("postBtn").onclick = sendPost;
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPost(); }
  });
  $("text").addEventListener("input", autoGrow);
  $("cancelReply").onclick = () => { state.replyTo = null; renderReplyBar(); };

  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") applySearch(); });
  $("doSearch") && ($("doSearch").onclick = applySearch);
  $("fProj").onchange = applySearch;
  $("fTag").onchange = applySearch;
  $("refreshBtn").onclick = () => loadView({ keepScroll: true });
  $("clearSearch") && ($("clearSearch").onclick = clearSearch);

  $("digestBtn").onclick = async () => {
    if (!CHANNELS.includes(state.view)) return toast("萃取只对四个讨论频道有效。", "warn");
    const btn = $("digestBtn");
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "萃取中…";
    try {
      const d = await api.digest(state.view, 50);
      if (!d.ok) toast("萃取失败：" + (d.error || ""), "bad");
      else toast(d.mode === "structured"
        ? "本地模型不可用，已退化为结构化聚合（没有调用任何模型）。"
        : "萃取完成，已写入经验库。", "ok", 4000);
      await loadView({ keepScroll: true });
      store.loadFacets();
    } catch (e) {
      toast("萃取请求失败：" + e.message, "bad");
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.selected) { state.selected = null; renderDetailPanel(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("q").focus(); }
  });

  bindStream();
  renderNav();
  renderIdentity();
  renderReplyBar();

  (async () => {
    await store.loadHealth();
    await store.loadFacets();
    fillFacetOptions();
    renderNav();
    updateStat();
    await loadView();
  })();
}

boot();
