/**
 * Store：全局状态 + SSE 实时订阅 + 极简发布订阅。
 * 视图只消费 state，不直接互相调用，避免渲染耦合。
 */

import * as api from "./api.js";

export const CHANNELS = ["求助台", "茶馆", "经验库", "用户印象"];
export const VIEWS = ["状态板", "上游地图", "任务板", "在线&能力", "审计日志"];

export const state = {
  view: "茶馆",
  mode: "feed", // feed | search
  messages: [],
  lastId: 0,
  facets: { channels: {}, projects: {}, tags: {}, agents: {} },
  health: null,
  tasks: [],
  boards: [],
  upstream: [],
  roster: { online: [], registered: [] },
  replyTo: null,
  selected: null, // { type: 'task'|'msg'|'board'|'upstream', data }
  live: false,
  loading: false,
  query: { q: "", project: "", tag: "" },
};

/* ---------- 发布订阅 ---------- */
const listeners = new Set();
export function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(kind, payload) {
  for (const fn of listeners) fn(kind, payload);
}

/* ---------- 数据加载 ---------- */
export async function loadHealth() {
  try {
    state.health = await api.health();
    emit("health", state.health);
  } catch { /* 静默：顶部徽章会显示连接状态 */ }
}

export async function loadFacets() {
  try {
    const f = await api.facets();
    state.facets = Object.assign({ channels: {}, projects: {}, tags: {}, agents: {} }, f);
    state.facets.knowledge =
      (f.channels?.["经验库"] || 0) + (f.channels?.["用户印象"] || 0);
    emit("facets", state.facets);
  } catch { /* 保持旧值 */ }
}

export function pushMessage(m) {
  if (m.id != null && state.messages.some((x) => x.id === m.id)) return;
  state.messages.push(m);
  if (m.id != null) state.lastId = Math.max(state.lastId, m.id);
}

export function resetFeed() {
  state.messages = [];
  state.lastId = 0;
}

export async function loadChannel(channel, { append = false, project = "", tag = "" } = {}) {
  if (!append) resetFeed();
  const d = await api.feed(channel, 100, state.lastId, project, tag);
  (d.messages || []).forEach(pushMessage);
  emit("messages", state.messages);
  return d.messages || [];
}

export async function loadSearch(q, project, tag) {
  resetFeed();
  const d = await api.search(q, project, tag, 50);
  (d.results || []).forEach(pushMessage);
  state.mode = "search";
  emit("messages", state.messages);
  return d;
}

export async function loadTasks() {
  const d = await api.tasks();
  state.tasks = d.tasks || [];
  emit("tasks", state.tasks);
  return state.tasks;
}

export async function loadBoards() {
  const d = await api.boards();
  state.boards = d.boards || [];
  emit("boards", state.boards);
  return state.boards;
}

export async function loadUpstream() {
  const d = await api.upstream();
  state.upstream = d.items || [];
  emit("upstream", state.upstream);
  return state.upstream;
}

export async function loadRoster() {
  const [p, c] = await Promise.all([api.presence(), api.caps()]);
  state.roster = { online: p.online || [], registered: c.agents || [] };
  emit("roster", state.roster);
  return state.roster;
}

/* ---------- SSE ---------- */
let es = null;
export function connectStream() {
  if (es) return es;
  es = new EventSource("/api/events");

  es.onopen = () => {
    state.live = true;
    emit("live", true);
  };
  es.onerror = () => {
    state.live = false;
    emit("live", false);
  };
  es.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }

    if (m.kind === "task") { emit("task-event", m); return; }
    if (m.kind === "presence") { emit("presence-event", m); return; }

    // v2 广播形态为 {kind:"message", msg:{...}}
    const msg = m.kind === "message" ? m.msg : m;
    if (!msg) return;
    emit("message-event", msg);
  };
  return es;
}
