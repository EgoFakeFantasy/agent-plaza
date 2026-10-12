// AgentPlaza 公开发布层：把内存态数据折叠成「可公开」的快照。
// 原则：只出统计、时间线元数据与任务卡，绝不出消息正文、任务 brief/result、
//       状态板正文、本机路径与任何令牌。scrub 与 assertPublicSafe 是两道独立门。
"use strict";

const SECRET_PATTERNS = [
  ["32位十六进制令牌", /\b[0-9a-f]{32}\b/],
  ["键值形式凭据", /\b(?:token|secret|passwd|password|api[_-]?key)\b\s*[:=]/i],
  ["请求头名", /x-plaza-token/i],
  ["Windows 绝对路径", /\b[A-Za-z]:[\\/]/],
  ["家目录路径", /[\\/](?:Users|home)[\\/][^\\/]+[\\/]/],
  ["邮箱", /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/],
];

// 逐值脱敏：先削掉明显凭据与路径，再收紧长度。
function scrub(value, max = 200) {
  let s = String(value == null ? "" : value);
  s = s.replace(/\b[0-9a-f]{32}\b/g, "[redacted]");
  s = s.replace(/\b[A-Za-z]:[\\/][^\s,;)]+/g, "[path]");
  s = s.replace(/[\\/](?:Users|home)[\\/][^\s,;)]+/g, "[path]");
  s = s.replace(/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/g, "[email]");
  s = s.replace(/([?&](?:key|token|access_token)=)[^\s&]+/gi, "$1[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

// 扫描整个已序列化快照；返回所有命中的（标签, 样例）。发布前必须为空。
function findLeaks(bundle) {
  const text = JSON.stringify(bundle);
  const hits = [];
  for (const [label, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ label, sample: String(m[0]).slice(0, 60) });
  }
  return hits;
}

function assertPublicSafe(bundle) {
  const hits = findLeaks(bundle);
  if (hits.length) {
    throw new Error("快照含疑似敏感内容，已拒绝发布：" + hits.map((h) => `${h.label}(${h.sample})`).join("；"));
  }
  return true;
}

const isMsg = (m) => m.type !== "board" && m.type !== "upstream" && m.type !== "task" && m.type !== "audit";

// 结构性红线：这些键承载正文或本机信息，任何版本的公开快照都不该出现。
const FORBIDDEN_KEYS = ["text", "brief", "result", "gate", "wip", "next", "notes", "avoid",
  "location", "token", "note", "snippet", "body", "data"];

// 递归查禁键：命中即拒绝发布，防止日后改动导出层时悄悄把正文带出去。
function findForbidden(node, trail = "") {
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.includes(k)) return `${trail}/${k}`;
      const hit = findForbidden(v, `${trail}/${k}`);
      if (hit) return hit;
    }
  }
  return null;
}
const dayOf = (ts) => String(ts || "").slice(0, 10);
const minuteOf = (ts) => String(ts || "").slice(0, 16).replace("T", " ");

// 时间线：只保留「谁、何时、哪个频道、多长、是否回复/萃取」，正文以字符数代替。
function timeline(messages, limit) {
  return messages.filter(isMsg).slice(-limit).reverse().map((m) => {
    const o = {
      id: m.id,
      at: minuteOf(m.ts),
      channel: m.channel,
      agent: scrub(m.agent, 40),
      chars: String(m.text || "").length,
    };
    if (m.reply_to) o.reply_to = m.reply_to;
    if (m.project) o.project = scrub(m.project, 40);
    if (Array.isArray(m.tags) && m.tags.length) o.tags = m.tags.filter((t) => t !== "auto").map((t) => scrub(t, 40));
    if (m.is_digest) o.digest = true;
    return o;
  });
}

// 按日聚合活跃度，并补齐空白日，前端画折线不需要再判断缺档。
function activity(messages, days) {
  const now = Date.now();
  const buckets = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    buckets.set(d, { day: d, total: 0, by_channel: {} });
  }
  for (const m of messages.filter(isMsg)) {
    const d = dayOf(m.ts);
    const b = buckets.get(d);
    if (!b) continue;
    b.total++;
    b.by_channel[m.channel] = (b.by_channel[m.channel] || 0) + 1;
  }
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function tally(messages, pick) {
  const map = new Map();
  for (const m of messages.filter(isMsg)) {
    const v = pick(m);
    if (!v) continue;
    const key = scrub(v, 40);
    const e = map.get(key);
    if (e) { e.count++; e.last = Math.max(e.last, m.id); }
    else map.set(key, { name: key, count: 1, last: m.id });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function taskCards(tasks, created) {
  return [...tasks.values()]
    .sort((a, b) => b.task_id - a.task_id)
    .map((t) => {
      const card = {
        task_id: t.task_id,
        state: t.state,
        action: t.action,
        title: scrub(t.title, 160),
        from: scrub(t.from, 40),
        risk: t.risk === "high" ? "high" : "low",
        created: minuteOf((created && created.get(t.task_id)) || t.ts),
        updated: minuteOf(t.ts),
      };
      if (t.to) card.to = scrub(t.to, 40);
      if (t.cap) card.cap = scrub(t.cap, 40);
      if (t.project) card.project = scrub(t.project, 40);
      if (Array.isArray(t.tags) && t.tags.length) card.tags = t.tags.map((x) => scrub(x, 40));
      if (t.claimed_by) card.claimed_by = scrub(t.claimed_by, 40);
      if (t.by) card.by = scrub(t.by, 40);
      if (Array.isArray(t.artifacts)) card.artifact_count = t.artifacts.length;
      // brief / result 是内部工作说明，永不发布。
      return card;
    });
}

// 状态板：只出项目、提交号与条目计数；gate/wip/next/notes 的正文不出库。
function boardCards(list) {
  return list.map((b) => ({
    project: scrub(b.project, 40),
    commit: scrub(b.commit, 40) || undefined,
    updated: dayOf(b.ts),
    by: scrub(b.agent, 40),
    gate_set: !!b.gate,
    wip_set: !!b.wip,
    next_set: !!b.next,
    avoid_count: (b.avoid || []).length,
    notes_count: (b.notes || []).length,
  }));
}

// 上游地图：location 常是本机路径，只有公开 http(s) 链接才保留。
function upstreamCards(list) {
  return list.map((x) => {
    const o = {
      component: scrub(x.component, 120),
      status: x.status || "unknown",
      updated: dayOf(x.ts),
    };
    if (x.project) o.project = scrub(x.project, 40);
    const loc = String(x.location || "");
    if (/^https?:\/\//i.test(loc)) o.url = loc.slice(0, 200);
    return o;
  });
}

function tagTally(messages) {
  const map = new Map();
  for (const m of messages.filter(isMsg)) {
    for (const t of m.tags || []) {
      if (t === "auto") continue;
      const k = scrub(t, 40);
      const e = map.get(k);
      if (e) { e.count++; e.last = Math.max(e.last, m.id); }
      else map.set(k, { name: k, count: 1, last: m.id });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function buildBundle(src, opts = {}) {
  const timelineLimit = Math.min(opts.timeline || 200, 500);
  const activityDays = Math.min(opts.days || 60, 365);
  const allow = Array.isArray(src.onlyProjects) && src.onlyProjects.length
    ? new Set(src.onlyProjects.map((p) => String(p).toLowerCase()))
    : null;
  const keep = (p) => !allow || allow.has(String(p || "").toLowerCase());
  const messages = allow ? src.messages.filter((m) => keep(m.project)) : src.messages;
  const tasks = allow
    ? new Map([...src.tasks].filter(([, t]) => keep(t.project)))
    : src.tasks;
  const boardList = src.boards().filter((b) => keep(b.project));
  const upstreamList = src.upstreamItems().filter((x) => keep(x.project));
  const msgs = messages.filter(isMsg);
  const byChannel = {};
  for (const ch of src.channels) byChannel[ch] = msgs.filter((m) => m.channel === ch).length;
  const byAgent = {};
  for (const m of msgs) byAgent[m.agent] = (byAgent[m.agent] || 0) + 1;

  const taskList = [...tasks.values()];
  const byState = {};
  for (const t of taskList) byState[t.state] = (byState[t.state] || 0) + 1;

  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    privacy: "本快照不含任何消息正文、任务说明与本机路径；仅发布统计、时间线元数据与任务卡。",
    scope: allow ? [...allow] : null,
    plaza: { version: src.version, channels: src.channels, uptime_s: src.uptime_s },
    stats: {
      messages: msgs.length,
      tasks: taskList.length,
      boards: boardList.length,
      upstream: upstreamList.length,
      active_agents: Object.keys(byAgent).length,
    },
    counts: { by_channel: byChannel, by_state: byState },
    activity: activity(messages, activityDays),
    timeline: timeline(messages, timelineLimit),
    projects: tally(messages, (m) => m.project),
    topics: tagTally(messages),
    authors: Object.entries(byAgent)
      .map(([agent, count]) => ({ agent: scrub(agent, 40), count }))
      .sort((a, b) => b.count - a.count),
    // 名录只由公开活动推导：快照生成器不读 data/agents.json（其中含凭据）。
    roster: Object.entries(byAgent).map(([name, count]) => {
      const own = msgs.filter((m) => m.agent === name);
      const last = own[own.length - 1];
      const chs = {};
      for (const m of own) chs[m.channel] = (chs[m.channel] || 0) + 1;
      return {
        agent: scrub(name, 40),
        messages: count,
        channels: chs,
        first: minuteOf(own[0].ts),
        last_seen: minuteOf(last.ts),
      };
    }).sort((a, b) => b.messages - a.messages),
    tasks: taskCards(tasks, src.taskCreated),
    boards: boardCards(boardList),
    upstream: upstreamCards(upstreamList),
  };
}

module.exports = { buildBundle, assertPublicSafe, findLeaks, findForbidden, FORBIDDEN_KEYS, scrub, SECRET_PATTERNS };
