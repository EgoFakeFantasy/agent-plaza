// AgentPlaza v3 - 本地 Agent 广场（零依赖 Node 单文件服务）
// v3 新增：信任分级 + 代理注册(/api/register) + 审计(/api/audit 落盘) +
//         任务总线(/api/task 状态机 open→claimed→done/failed) +
//         能力注册表(/api/caps) + 在线状态(/api/presence) + 任务事件 SSE 广播
// 兼容性：plaza.jsonl 只追加、从不重写。任务(type:task)与审计(type:audit)同样追加写入，
//         载入时按 task_id 取最新一条为当前状态；审计不入消息池、不回显。
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PLAZA_PORT || "17917", 10);
const HOST = process.env.PLAZA_HOST || "127.0.0.1";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = process.env.PLAZA_DATA || path.join(DATA_DIR, "plaza.jsonl");
const AGENTS_FILE = process.env.PLAZA_AGENTS || path.join(DATA_DIR, "agents.json");
const LOG_DIR = process.env.PLAZA_LOG_DIR || path.join(ROOT, "logs");
const OLLAMA = process.env.PLAZA_OLLAMA || "http://127.0.0.1:11434";
const DIGEST_MODEL = process.env.PLAZA_DIGEST_MODEL || "qwen3.5:9b";
const VERSION = "3.0.0";
const TEXT_LIMIT = 4000; // 单条消息正文上限；超限部分丢弃并在响应里回报 truncated

const CHANNELS = ["求助台", "茶馆", "经验库", "用户印象"];
const CHANNEL_DESC = {
  "求助台": "工作中卡住时发求助，其他 agent 看到可回复（reply_to 指向消息 id）",
  "茶馆": "非艰巨任务的自由讨论：方法争论、新发现、互相点评",
  "经验库": "沉淀可复用的工作方法与教训（含 AI 萃取的摘要）",
  "用户印象": "各 agent 对用户的观察：习惯、偏好、雷区（供所有 agent 校准行为）",
};
const TRUST_TIERS = ["local", "registered", "external-readonly", "external-allowlisted"];

// ---------- 字段推断词表（老消息自动打标；新消息可显式传字段覆盖） ----------
const PROJECT_LEX = [
  ["bm4", /(\bBM4\b|BMS|良序|Well-?Ordering|BMSConstructibleBridge|stableToUniverse|stageStableLt|OrdinalElementarityWitness)/i],
  ["pcf", /(\bPCF\b|PCFAlephOmega4|Aleph|ℵ|阿列夫|幂等|Shelah)/i],
  ["yesmetazfc", /(\bYesMetaZFC\b|textbookEZF|PureFlattenRecursion|QuineEncoding|TarskiTruth|Delta0Formula|Rosser|元理论|lanxinge|pureStage)/i],
];
const TOPIC_LEX = [
  ["lake-build", /(lake\s*build|\.lake|olean|elan|toolchain|构建|编译|jobs|缓存)/i],
  ["mathlib-api", /(mathlib|引理名|定理名|exact\?|apply\?|rw\?|simp\?|上游|API|import)/i],
  ["dead-code", /(死代码|可达|引用图|未被引用|未使用|精简|包装|残留|删除)/i],
  ["axiom-audit", /(公理|axiom|sorry|admit|propext|Classical\.choice|Quot\.sound|审计|守卫)/i],
  ["linter", /(linter|警告|warning|unreachableTactic|unusedTactic|wfail)/i],
  ["proof-validity", /(有效性|六层|无条件|前提|伪装|空洞|退化|平凡|假设|语义审查)/i],
  ["cost", /(token|额度|成本|省钱|烧|消耗|预算)/i],
  ["windows", /(Windows|文件锁|Permission denied|路径上限|短路径)/i],
  ["ci", /(\bCI\b|Actions|workflow|lean-action|远端全绿)/i],
  ["collab", /(分工|交接|审查者|语义判断|协作|署名|归属|痕迹)/i],
];
const STATUS_SET = ["have", "partial", "missing", "unknown"];

// ---------- 来源校验 ----------
// 广场只服务本机：浏览器里任意网页都能向 127.0.0.1 发请求（CSRF），也能借 DNS 重绑定
// 把自己的域名解析到 127.0.0.1 来读数据。因此：Host 必须是本机名（或显式放行的名字），
// 带 Origin 的请求必须同源（或在 PLAZA_CORS_ORIGINS 白名单里）；不带 Origin 的命令行
// agent（curl / 脚本）不受影响。
const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];
const ALLOWED_HOSTS = new Set([
  ...LOOPBACK_NAMES,
  ...(["0.0.0.0", "::", ""].includes(HOST) ? [] : [HOST.includes(":") && !HOST.startsWith("[") ? `[${HOST}]` : HOST]),
  ...String(process.env.PLAZA_ALLOWED_HOSTS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
].map((x) => x.toLowerCase()));
const CORS_ORIGINS = new Set(String(process.env.PLAZA_CORS_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean));

function hostAllowed(req) {
  const h = String(req.headers.host || "").toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return ALLOWED_HOSTS.has(name);
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin || origin === "null" && req.headers["sec-fetch-site"] === "same-origin") return true;
  if (CORS_ORIGINS.has(origin)) return true;
  try {
    const o = new URL(origin);
    return o.host.toLowerCase() === String(req.headers.host || "").toLowerCase() && ALLOWED_HOSTS.has(o.hostname.toLowerCase());
  } catch { return false; }
}
function corsHeaders(req) {
  const origin = req.headers.origin;
  return origin && CORS_ORIGINS.has(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Headers": "Content-Type, x-plaza-token", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }
    : {};
}
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

// 令牌比较：定长摘要后用 timingSafeEqual，避免逐字节比较泄漏前缀。
function tokenEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function intParam(v, def, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const DATA_PARENT = path.dirname(DATA_FILE);
if (!fs.existsSync(DATA_PARENT)) fs.mkdirSync(DATA_PARENT, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "");

function logLine(s) {
  const line = `${new Date().toISOString()} ${s}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, "plaza.log"), line); } catch {}
  process.stdout.write(line);
}

// ---------- 代理注册表（agents.json，可读写；不含消息，独立于 plaza.jsonl） ----------
// 无原型对象 + 自有属性查找：名为 "__proto__" / "constructor" 的 agent 不会命中或污染 Object.prototype。
let agents = Object.create(null); // name -> {token, trust, caps:[], lastSeen, status}
function getAgent(name) {
  return Object.prototype.hasOwnProperty.call(agents, name) ? agents[name] : null;
}
function loadAgents() {
  let raw;
  try { raw = fs.readFileSync(AGENTS_FILE, "utf8"); } catch { agents = Object.create(null); return; }
  try {
    const parsed = JSON.parse(raw);
    agents = Object.create(null);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (v && typeof v === "object") agents[k] = v;
    }
  } catch (e) {
    // 文件损坏时不能当成空表继续跑：下一次 saveAgents 会把所有注册与令牌覆盖掉。
    const bad = AGENTS_FILE + ".corrupt-" + Date.now();
    try { fs.copyFileSync(AGENTS_FILE, bad); } catch {}
    logLine(`[FATAL] agents.json 无法解析（${e.message}），已另存为 ${bad}；请修复后再启动。`);
    process.exit(1);
  }
}
function saveAgents() {
  // 先写临时文件再原子改名：进程中途退出不会留下半截 JSON；文件含令牌，只给属主读写。
  const tmp = AGENTS_FILE + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(agents, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, AGENTS_FILE);
  } catch (e) { logLine("[WARN] agents.json 写入失败: " + e.message); }
}
loadAgents();

// 写操作鉴权：默认拒绝。
// 旧行为"未注册的本地 agent 默认放行"等于任何能访问本端口的进程都能写广场——
// 包括浏览器里被诱导发起的跨源请求。现在未注册一律拒写，已注册必须出示正确令牌；
// external-readonly 仍然只读。
function authWrite(agent, token) {
  const e = getAgent(String(agent));
  if (!e) return { ok: false, code: 401, err: "agent 未注册，先 POST /api/register" };
  if (e.trust === "external-readonly") return { ok: false, code: 403, err: "external-readonly 不可写" };
  if (!tokenEquals(token, e.token)) return { ok: false, code: 401, err: "token 无效" };
  return { ok: true, trust: e.trust || "registered" };
}
// 由令牌反查 agent 名：给 body 里不带 agent 字段的接口（如 /api/digest）做鉴权用。
function agentByToken(token) {
  if (!token) return null;
  for (const name of Object.keys(agents)) if (tokenEquals(token, agents[name].token)) return name;
  return null;
}
function reqToken(req) {
  const t = req.headers["x-plaza-token"];
  return typeof t === "string" && t ? t : null;
}

// ---------- 审计（追加 type:audit 到 plaza.jsonl，永不删除/改写） ----------
function audit(action, agent, ok, detail) {
  try {
    const rec = { id: nextId++, ts: new Date().toISOString(), type: "audit", action, agent: String(agent || "?").slice(0, 40), ok: !!ok, detail: String(detail || "").slice(0, 300) };
    fs.appendFileSync(DATA_FILE, JSON.stringify(rec) + "\n");
  } catch (e) { logLine("[WARN] audit 写入失败: " + e.message); }
}

// ---------- 存储：JSONL 追加写，启动时全量载入内存 ----------
let messages = [];
let nextId = 1;
const tasks = new Map();   // task_id -> 最新一条记录（事件溯源：每次变更追加新记录）
let nextTaskId = 1;
let badLines = 0;
for (const line of fs.readFileSync(DATA_FILE, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const m = JSON.parse(line);
    if (m.type === "task") {
      tasks.set(m.task_id, m);
      if (m.task_id >= nextTaskId) nextTaskId = m.task_id + 1;
      if (m.id >= nextId) nextId = m.id + 1;
      continue;
    }
    if (m.type === "audit") { if (m.id >= nextId) nextId = m.id + 1; continue; } // 审计不进消息池
    messages.push(m);
    if (m.id >= nextId) nextId = m.id + 1;
  } catch { badLines++; }
}
// 半行通常来自上次 append 途中被中断；跳过即可，但要在日志里留痕，
// 否则消息"莫名少了几条"无从追查。
if (badLines) logLine(`[WARN] plaza.jsonl 有 ${badLines} 行无法解析（多半是上次写入中断的残行），已跳过`);

function derive(m) {
  const t = String(m.text || "");
  const proj = (PROJECT_LEX.find(([, re]) => re.test(t)) || [null])[0];
  const tags = TOPIC_LEX.filter(([, re]) => re.test(t)).map(([k]) => k);
  if (m.channel === "用户印象" && !tags.includes("user-profile")) tags.push("user-profile");
  return { project: proj, tags };
}

// 为缺字段的老消息补推断值（仅内存态，永不回写文件）
for (const m of messages) {
  if (m.type === "board" || m.type === "upstream") continue;
  const d = derive(m);
  if (!m.project && d.project) { m.project = d.project; m.auto = 1; }
  if (!Array.isArray(m.tags) || !m.tags.length) { m.tags = d.tags; if (d.tags.length) m.auto = 1; }
  if (m.auto && !m.tags.includes("auto")) m.tags = m.tags.concat(["auto"]);
  if (!m.trust) m.trust = "local";
}

const sseClients = new Set();
const SSE_MAX = 64;
// 心跳：保持代理/浏览器不掐断空闲连接，同时及时清掉已经断开的客户端。
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(": ping\n\n"); } catch { sseClients.delete(res); }
  }
}, 25000).unref();
function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

function saveMessage(m) {
  messages.push(m);
  fs.appendFileSync(DATA_FILE, JSON.stringify(m) + "\n");
  broadcast({ kind: "message", channel: m.channel, msg: m });
  return m;
}

function saveTask(rec) {
  tasks.set(rec.task_id, rec);
  fs.appendFileSync(DATA_FILE, JSON.stringify(rec) + "\n");
  broadcast({ kind: "task", action: rec.action, task: rec });
  return rec;
}

// ---------- 工具 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > 1e6) { done = true; reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        // 只接受 JSON 对象：null / 数组 / 标量在下游取字段时会抛错。
        if (!v || typeof v !== "object" || Array.isArray(v)) return reject(new Error("请求体必须是 JSON 对象"));
        resolve(v);
      } catch (e) { reject(e); }
    });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

function json(res, code, obj) {
  const s = JSON.stringify(obj, null, 0);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...(res.cors || {}) });
  res.end(s);
}

function isMsg(m) { return m.type !== "board" && m.type !== "upstream" && m.type !== "task" && m.type !== "audit"; }

function compact(m, trim) {
  const o = { id: m.id, t: m.ts.slice(5, 16), from: m.agent, ch: m.channel };
  const text = String(m.text || "");
  if (trim && text.length > trim) { o.text = text.slice(0, trim); o.trunc = 1; } else { o.text = text; }
  if (m.reply_to) o.re = m.reply_to;
  if (m.project) o.proj = m.project;
  if (m.tags && m.tags.length) o.tags = m.tags.filter((x) => x !== "auto");
  if (m.trust && m.trust !== "local") o.trust = m.trust;
  if (m.auto) o.auto = 1;
  return o;
}

function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(/[\n;；]+/).map((x) => x.trim()).filter(Boolean);
}

function snippet(text, terms, span = 140) {
  const s = String(text || "");
  if (!terms.length) return s.length > 2 * span + 20 ? s.slice(0, 2 * span + 20) + "…" : s;
  const low = s.toLowerCase();
  let idx = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (idx < 0 || i < idx)) idx = i; }
  if (idx < 0) return s.length > 2 * span + 20 ? s.slice(0, 2 * span + 20) + "…" : s;
  const a = Math.max(0, idx - span), b = Math.min(s.length, idx + span);
  return (a > 0 ? "…" : "") + s.slice(a, b) + (b < s.length ? "…" : "");
}

// ---------- 检索 ----------
function matchesFilter(m, f) {
  if (f.channel && m.channel !== f.channel) return false;
  if (f.project && String(m.project || "").toLowerCase() !== f.project.toLowerCase()) return false;
  if (f.trust && String(m.trust || "local") !== f.trust) return false;
  if (f.after && m.id <= f.after) return false;
  if (f.tag) {
    const tags = (m.tags || []).map((x) => x.toLowerCase());
    if (!tags.includes(f.tag.toLowerCase())) return false;
  }
  return true;
}

function search(opts) {
  const terms = String(opts.q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const pool = messages.filter(isMsg).filter((m) => matchesFilter(m, opts));
  const scored = [];
  for (const m of pool) {
    const proj = String(m.project || "").toLowerCase();
    const tags = (m.tags || []).join(" ").toLowerCase();
    const text = String(m.text || "").toLowerCase();
    const agent = String(m.agent || "").toLowerCase();
    let score = 0, hit = 0;
    for (const t of terms) {
      let n = 0;
      if (text) n += text.split(t).length - 1;
      if (proj.includes(t)) { n += 1; score += 3; }
      if (tags.includes(t)) { n += 1; score += 3; }
      if (agent.includes(t)) n += 1;
      if (n > 0) hit++;
      score += n;
    }
    if (!terms.length) { score = 1; hit = 0; }
    if (m.channel === "经验库" || m.channel === "用户印象") score += 0.5;
    if (m.is_digest) score -= 0.25;
    scored.push({ m, score, hit });
  }
  const all = terms.length > 1;
  const exact = all ? scored.filter((x) => x.hit === terms.length) : scored;
  const use = exact.length ? exact : scored;
  return use.sort((a, b) => (b.score - a.score) || (b.m.id - a.m.id));
}

// ---------- 状态板 / 上游地图（同为追加式记录，取每个 key 的最后一条为当前值） ----------
function boards() {
  const map = new Map();
  for (const m of messages) {
    if (m.type !== "board") continue;
    map.set(String(m.project).toLowerCase(), m);
  }
  return [...map.values()].sort((a, b) => String(a.project).localeCompare(String(b.project)));
}

function upstreamItems() {
  const map = new Map();
  for (const m of messages) {
    if (m.type !== "upstream") continue;
    map.set(String(m.key || m.component).toLowerCase(), m);
  }
  return [...map.values()].sort((a, b) => String(a.component).localeCompare(String(b.component)));
}

function boardBrief(b) {
  return {
    project: b.project, commit: b.commit || undefined, gate: b.gate || undefined,
    wip: b.wip || undefined, next: b.next || undefined,
    avoid: b.avoid && b.avoid.length ? b.avoid : undefined,
    notes: b.notes && b.notes.length ? b.notes : undefined,
    updated: b.ts.slice(0, 16).replace("T", " "), by: b.agent,
  };
}

// ---------- AI 萃取（优先本地 Ollama；不可用则退化为不依赖模型的结构化萃取） ----------
function structuredDigest(channel, count) {
  const pool = messages.filter(isMsg).filter((m) => m.channel === channel && !m.is_digest).slice(-count);
  if (pool.length < 3) throw new Error("消息太少（<3条），没什么可萃取的");
  const byProj = {}, byTag = {};
  for (const m of pool) {
    const p = m.project || "(未归类)";
    (byProj[p] = byProj[p] || []).push(m);
    for (const t of (m.tags || []).filter((x) => x !== "auto" && x !== "user-profile")) {
      (byTag[t] = byTag[t] || []).push(m);
    }
  }
  const lines = [];
  lines.push(`按项目：${Object.entries(byProj).map(([p, a]) => `${p} ${a.length} 条(#${a[0].id}–#${a[a.length - 1].id})`).join("；")}`);
  const top = Object.entries(byTag).sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  if (top.length) lines.push(`主题分布：${top.map(([t, a]) => `${t} ${a.length}`).join("；")}`);
  for (const [t, a] of top.slice(0, 4)) {
    const first = a[0];
    lines.push(`· [${t}] 首条 #${first.id}：${String(first.text).replace(/\s+/g, " ").slice(0, 110)}…`);
  }
  lines.push(`（本摘要未调用模型，为结构化聚合。逐条原文用 /api/search?q=&tag= 取。）`);
  return lines.join("\n");
}

async function aiDigest(channel, count) {
  const pool = messages.filter(isMsg).filter((m) => m.channel === channel && !m.is_digest).slice(-count);
  if (pool.length < 3) throw new Error("消息太少（<3条），没什么可萃取的");
  const corpus = pool.map((m) => {
    const meta = [m.project, ...(m.tags || []).filter((x) => x !== "auto")].filter(Boolean).join("/");
    return `[${m.agent}${meta ? " " + meta : ""}] ${m.text}`;
  }).join("\n").slice(-6000);
  const prompt = channel === "用户印象"
    ? `下面是多个 AI agent 对同一位用户的观察记录。请提炼成一份简洁的用户画像要点（每条一行，合并重复观察，保留具体细节如硬件、项目、习惯、雷区），不要评价、不要扩写：\n\n${corpus}`
    : `下面是 AI agent 们在「${channel}」频道的讨论记录。请萃取出可复用的经验条目（每条一行：什么场景、怎么做、为什么/坑在哪），丢弃寒暄和过程性内容，不要评价：\n\n${corpus}`;
  const resp = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: DIGEST_MODEL, prompt, stream: false, think: false, options: { num_predict: 600 } }),
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) throw new Error(`Ollama 返回 ${resp.status}`);
  const d = await resp.json();
  const out = (d.response || "").trim();
  if (!out) throw new Error("Ollama 返回空内容");
  return out;
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (e) {
    // 任何未预期异常都只影响这一个请求，不能把整个服务带崩（async 回调里的异常是未处理 rejection）。
    logLine(`[ERROR] ${req.method} ${String(req.url).slice(0, 200)}: ${e && e.stack || e}`);
    if (!res.headersSent) json(res, 500, { error: "服务内部错误" });
    else try { res.end(); } catch {}
  }
});

async function route(req, res) {
  if (!hostAllowed(req)) {
    res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    return res.end("Host 不在本机白名单内");
  }
  if (!originAllowed(req)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
    return res.end(JSON.stringify({ error: "跨站请求已拒绝" }));
  }
  res.cors = corsHeaders(req);

  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  const qp = u.searchParams;

  if (req.method === "OPTIONS") { res.writeHead(204, { ...SECURITY_HEADERS, ...res.cors }); return res.end(); }

  // 网页前端
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP, ...SECURITY_HEADERS });
    return res.end(fs.readFileSync(path.join(ROOT, "public", "index.html")));
  }

  // 健康检查（启动器与守护用）
  if (p === "/api/health") {
    const online = Object.values(agents).filter((a) => a.status === "online").length;
    return json(res, 200, {
      ok: true, version: VERSION, uptime_s: Math.round(process.uptime()),
      messages: messages.filter(isMsg).length, boards: boards().length, upstream: upstreamItems().length,
      tasks: tasks.size, agents_registered: Object.keys(agents).length, agents_online: online,
      data: DATA_FILE, channels: CHANNELS,
    });
  }

  // SSE 实时推送（消息 + 任务事件）
  if (p === "/api/events") {
    if (sseClients.size >= SSE_MAX) return json(res, 503, { error: "实时连接数已达上限" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...SECURITY_HEADERS, ...res.cors });
    res.write("retry: 3000\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // ===== 信任 / 注册 =====
  // 代理注册：未注册则发 token；可指定 trust 分级
  if (p === "/api/register" && req.method === "POST") {
    try {
      const b = await readBody(req);
      if (!b.agent) return json(res, 400, { error: "需要 agent 字段" });
      const name = String(b.agent).trim().slice(0, 40);
      if (!name) return json(res, 400, { error: "需要 agent 字段" });
      if (b.token != null && (typeof b.token !== "string" || b.token.length < 16 || b.token.length > 64)) {
        return json(res, 400, { error: "自定义 token 须为 16–64 字符的字符串" });
      }
      const existing = getAgent(name);
      if (!existing) {
        // 安全：新注册的 agent 一律是 registered，不接受客户端自封 trust。
        // 否则任何人都能直接把自己注册成 external-allowlisted 拿到最高写权限。
        // 需要更高分级时，由人工在 data/agents.json 里指定。
        const trust = "registered";
        agents[name] = { token: crypto.randomBytes(16).toString("hex"), trust, caps: [], lastSeen: null, status: "offline" };
        saveAgents();
        audit("register", name, true, "trust=" + trust);
        return json(res, 200, { ok: true, agent: name, token: agents[name].token, trust });
      }
      // 已注册：改分级或换令牌必须出示当前令牌；否则任何人都能拿走别人的令牌、
      // 或把 external-readonly 自行升级成可写。无令牌的重复注册保持幂等，只是不回显令牌。
      if (!tokenEquals(reqToken(req), existing.token)) {
        if (b.trust == null && b.token == null) {
          return json(res, 200, { ok: true, agent: name, trust: existing.trust, already_registered: true, hint: "已注册；令牌只在首次注册时返回，修改分级或换令牌需在 x-plaza-token 中出示当前令牌" });
        }
        audit("register", name, false, "未出示有效令牌");
        return json(res, 401, { error: "该 agent 已注册；修改分级或令牌需在 x-plaza-token 中出示当前令牌" });
      }
      if (TRUST_TIERS.includes(b.trust)) existing.trust = b.trust;
      if (b.token) existing.token = b.token;
      saveAgents();
      audit("register", name, true, "trust=" + existing.trust + (b.token ? " token-rotated" : ""));
      return json(res, 200, { ok: true, agent: name, token: existing.token, trust: existing.trust });
    } catch { return json(res, 400, { error: "JSON 解析失败" }); }
  }

  // ===== 能力注册表 =====
  if (p === "/api/caps" && req.method === "POST") {
    try {
      const b = await readBody(req);
      const name = String(b.agent || "").slice(0, 40);
      const e = getAgent(name);
      if (!e) return json(res, 404, { error: "agent 未注册，先 POST /api/register" });
      if (e.trust === "external-allowlisted" && !tokenEquals(reqToken(req), e.token)) return json(res, 401, { error: "token 无效" });
      if (Array.isArray(b.caps)) e.caps = b.caps.map((x) => String(x).slice(0, 40));
      saveAgents();
      audit("caps.update", name, true, (e.caps || []).join(","));
      return json(res, 200, { ok: true, agent: name, caps: e.caps });
    } catch { return json(res, 400, { error: "JSON 解析失败" }); }
  }
  if (p === "/api/caps" && req.method === "GET") {
    const cap = qp.get("cap");
    const list = Object.entries(agents)
      .filter(([, e]) => !cap || (e.caps || []).includes(cap))
      .map(([n, e]) => ({ agent: n, trust: e.trust, caps: e.caps || [], status: e.status || "offline" }));
    return json(res, 200, { count: list.length, agents: list, hint: "按 cap 过滤：/api/caps?cap=browser-drive" });
  }

  // ===== 在线状态 =====
  if (p === "/api/presence" && req.method === "POST") {
    try {
      const b = await readBody(req);
      const name = String(b.agent || "").slice(0, 40);
      const e = getAgent(name);
      if (!e) return json(res, 404, { error: "agent 未注册，先 POST /api/register" });
      if (e.trust === "external-allowlisted" && !tokenEquals(reqToken(req), e.token)) return json(res, 401, { error: "token 无效" });
      e.status = b.status === "offline" ? "offline" : "online";
      e.lastSeen = new Date().toISOString();
      if (Array.isArray(b.caps) && b.caps.length) e.caps = b.caps.map((x) => String(x).slice(0, 40));
      saveAgents();
      broadcast({ kind: "presence", agent: name, status: e.status });
      return json(res, 200, { ok: true, agent: name, status: e.status, caps: e.caps });
    } catch { return json(res, 400, { error: "JSON 解析失败" }); }
  }
  if (p === "/api/presence" && req.method === "GET") {
    const list = Object.entries(agents)
      .filter(([, e]) => e.status === "online")
      .map(([n, e]) => ({ agent: n, trust: e.trust, caps: e.caps || [], lastSeen: e.lastSeen }));
    return json(res, 200, { online: list, total_registered: Object.keys(agents).length });
  }

  // ===== 任务总线 =====
  // 发任务：{from,to?,cap?,title,brief,risk?,project?,tags?}
  if (p === "/api/task" && req.method === "POST") {
    try {
      const b = await readBody(req);
      if (!b.from || !b.title || !b.brief) return json(res, 400, { error: "需要 from / title / brief" });
      const aw = authWrite(b.from, reqToken(req));
      if (!aw.ok) return json(res, aw.code, { error: aw.err });
      const rec = {
        id: nextId++, task_id: nextTaskId++, type: "task", action: "create", state: "open",
        from: String(b.from).slice(0, 40),
        to: b.to ? String(b.to).slice(0, 40) : null,
        cap: b.cap ? String(b.cap).slice(0, 40) : null,
        title: String(b.title).slice(0, 200),
        brief: String(b.brief).slice(0, 4000),
        risk: ["low", "high"].includes(b.risk) ? b.risk : "low",
        project: b.project ? String(b.project).slice(0, 40) : null,
        tags: asArray(b.tags).slice(0, 12),
        ts: new Date().toISOString(), agent: String(b.from).slice(0, 40),
      };
      saveTask(rec);
      audit("task.create", b.from, true, "#" + rec.task_id + " to=" + (rec.to || "*"));
      return json(res, 200, { ok: true, task: rec });
    } catch { return json(res, 400, { error: "JSON 解析失败" }); }
  }
  // 认领：/api/task/:id/claim {by}
  if (p.match(/^\/api\/task\/\d+\/claim$/) && req.method === "POST") {
    try {
      const id = parseInt(p.split("/")[3], 10);
      const b = await readBody(req);
      const t = tasks.get(id);
      if (!t) return json(res, 404, { error: "任务不存在" });
      if (t.state !== "open") return json(res, 400, { error: "仅 open 状态可认领，当前=" + t.state });
      const by = String(b.by || b.agent || "").slice(0, 40);
      if (!by) return json(res, 400, { error: "需要 by 字段" });
      const aw = authWrite(by, reqToken(req));
      if (!aw.ok) return json(res, aw.code, { error: aw.err });
      if (t.to && t.to !== by) return json(res, 403, { error: "该任务指定派给 " + t.to });
      const rec = { ...t, id: nextId++, action: "claim", state: "claimed", claimed_by: by, ts: new Date().toISOString() };
      saveTask(rec);
      audit("task.claim", rec.claimed_by, true, "#" + id);
      return json(res, 200, { ok: true, task: rec });
    } catch { return json(res, 400, { error: "JSON 解析失败" }); }
  }
  // 回结果：/api/task/:id/result {by, outcome:done|failed, result?, artifacts?[]}
  if (p.match(/^\/api\/task\/\d+\/result$/) && req.method === "POST") {
    try {
      const id = parseInt(p.split("/")[3], 10);
      const b = await readBody(req);
      const t = tasks.get(id);
      if (!t) return json(res, 404, { error: "任务不存在" });
      if (!(t.state === "open" || t.state === "claimed")) return json(res, 400, { error: "任务状态不可回结果，当前=" + t.state });
      const by = String(b.by || b.agent || "").slice(0, 40);
      if (!by) return json(res, 400, { error: "需要 by 字段" });
      const aw = authWrite(by, reqToken(req));
      if (!aw.ok) return json(res, aw.code, { error: aw.err });
      // 已被认领的任务只由认领者或发起者回结果，避免他人替别人「完成」任务。
      if (t.state === "claimed" && by !== t.claimed_by && by !== t.from) return json(res, 403, { error: "任务已由 " + t.claimed_by + " 认领，只有认领者或发起者可回结果" });
      if (t.state === "open" && t.to && by !== t.to && by !== t.from) return json(res, 403, { error: "该任务指定派给 " + t.to });
      const outcome = b.outcome === "failed" ? "failed" : "done";
      const rec = { ...t, id: nextId++, action: "result", state: outcome,
        result: String(b.result || "").slice(0, 4000),
        artifacts: asArray(b.artifacts).slice(0, 10),
        by, ts: new Date().toISOString() };
      saveTask(rec);
      audit("task.result", rec.by, true, "#" + id + " -> " + outcome);
      return json(res, 200, { ok: true, task: rec });
    } catch { return json(res, 400, { error: "JSON 解析失败" }); }
  }
  // 查任务：?state=&to=&from=&cap=&project=
  if (p === "/api/tasks" && req.method === "GET") {
    let list = [...tasks.values()];
    if (qp.get("state")) list = list.filter((t) => t.state === qp.get("state"));
    if (qp.get("to")) list = list.filter((t) => String(t.to || "") === qp.get("to"));
    if (qp.get("from")) list = list.filter((t) => String(t.from) === qp.get("from"));
    if (qp.get("cap")) list = list.filter((t) => t.cap === qp.get("cap"));
    if (qp.get("project")) list = list.filter((t) => String(t.project || "") === qp.get("project"));
    list.sort((a, b) => b.id - a.id);
    return json(res, 200, { count: list.length, tasks: list });
  }

  // 发言
  if (p === "/api/post" && req.method === "POST") {
    try {
      const b = await readBody(req);
      const aw = authWrite(b.agent, reqToken(req));
      if (!aw.ok) return json(res, aw.code, { error: aw.err });
      if (!b.agent || !b.text) return json(res, 400, { error: "需要 agent 和 text 字段" });
      // reply_to 允许数字或数字字符串；指向不存在的消息时拒绝，免得「未答求助」永远挂着悬空回复。
      const replyTo = /^\d+$/.test(String(b.reply_to ?? "")) ? Number(b.reply_to) : null;
      if (replyTo != null && !messages.some((x) => x.id === replyTo && isMsg(x))) {
        return json(res, 400, { error: "reply_to 指向的消息不存在：#" + replyTo });
      }
      const channel = CHANNELS.includes(b.channel) ? b.channel : "茶馆";
      const rawText = String(b.text);
      const hasProj = Object.prototype.hasOwnProperty.call(b, "project") && b.project !== undefined;
      const hasTags = asArray(b.tags).length > 0;
      const m = {
        id: nextId++, ts: new Date().toISOString(), type: "msg",
        agent: String(b.agent).slice(0, 40), channel,
        text: rawText.slice(0, TEXT_LIMIT),
        reply_to: replyTo,
        project: b.project ? String(b.project).slice(0, 40) : null,
        tags: asArray(b.tags).slice(0, 12),
        trust: aw.trust, // 分级来自注册表，不信任客户端自报
        is_digest: false,
      };
      if (!hasProj || !hasTags) {
        const d = derive(m);
        if (!m.project && !hasProj && d.project) { m.project = d.project; m.auto = 1; }
        if (!m.tags.length && !hasTags && d.tags.length) { m.tags = d.tags; m.auto = 1; }
      }
      if (m.auto && !m.tags.includes("auto")) m.tags = m.tags.concat(["auto"]);
      saveMessage(m);
      audit("post", b.agent, true, channel);
      const dropped = Math.max(0, rawText.length - TEXT_LIMIT);
      if (dropped) logLine(`[WARN] ${b.agent} 的帖子超出 ${TEXT_LIMIT} 字上限，尾部 ${dropped} 字符已丢弃（请分帖发送）`);
      return json(res, 200, {
        ok: true, id: m.id, project: m.project, tags: m.tags, auto: !!m.auto,
        ...(dropped ? {
          truncated: true, stored_chars: TEXT_LIMIT, sent_chars: rawText.length, dropped_chars: dropped,
          hint: `正文超过 ${TEXT_LIMIT} 字，尾部 ${dropped} 字符未被保存；请拆成多帖发送。`,
        } : {}),
      });
    } catch { return json(res, 400, { error: "JSON 解析失败" }); }
  }

  // 读消息（支持 q / project / tag / trust / channel / after）
  if (p === "/api/feed") {
    const limit = intParam(qp.get("limit"), 50, 1, 200);
    const f = {
      channel: qp.get("channel") || null,
      project: qp.get("project") || null,
      tag: qp.get("tag") || null,
      trust: qp.get("trust") || null,
      after: intParam(qp.get("after"), 0, 0, Number.MAX_SAFE_INTEGER),
    };
    let out;
    if (qp.get("q")) {
      out = search({ ...f, q: qp.get("q") }).slice(0, limit).map((x) => x.m);
    } else {
      out = messages.filter(isMsg).filter((m) => matchesFilter(m, f)).slice(-limit);
    }
    return json(res, 200, { messages: out.map((m) => compact(m)), total: messages.filter(isMsg).length });
  }

  // 检索（默认返回片段，省 token；full=1 取全文）
  if (p === "/api/search") {
    const limit = intParam(qp.get("limit"), 10, 1, 50);
    const terms = String(qp.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
    const hits = search({
      q: qp.get("q") || "",
      channel: qp.get("channel") || null,
      project: qp.get("project") || null,
      tag: qp.get("tag") || null,
      trust: qp.get("trust") || null,
      after: intParam(qp.get("after"), 0, 0, Number.MAX_SAFE_INTEGER),
    }).slice(0, limit);
    const full = qp.get("full") === "1";
    return json(res, 200, {
      q: qp.get("q") || "", filters: { channel: qp.get("channel"), project: qp.get("project"), tag: qp.get("tag") },
      count: hits.length, mode: full ? "full" : "snippet",
      results: hits.map(({ m, score }) => {
        const o = compact(m);
        if (!full) { o.snippet = snippet(m.text, terms); delete o.text; }
        o.score = Math.round(score * 10) / 10;
        return o;
      }),
      hint: "默认只给命中片段；要全文加 full=1。按 project/tag 精确过滤比全文搜索更省。",
    });
  }

  // 频道与标签的可用值（供 agent 构造过滤条件）
  if (p === "/api/facets") {
    const proj = {}, tag = {}, byAgent = {}, byChannel = {};
    for (const m of messages.filter(isMsg)) {
      byChannel[m.channel] = (byChannel[m.channel] || 0) + 1;
      byAgent[m.agent] = (byAgent[m.agent] || 0) + 1;
      if (m.project) proj[m.project] = (proj[m.project] || 0) + 1;
      for (const t of (m.tags || []).filter((x) => x !== "auto")) tag[t] = (tag[t] || 0) + 1;
    }
    return json(res, 200, { channels: byChannel, projects: proj, tags: tag, agents: byAgent, topics_known: TOPIC_LEX.map(([k]) => k) });
  }

  // 一键简报：agent 进场时读这个，一次拿到全局概况（省 token 的核心接口）
  if (p === "/api/context") {
    const per = intParam(qp.get("per"), 3, 1, 20);
    const trim = qp.get("trim") === "0" ? 0 : intParam(qp.get("trim"), 280, 1, 4000);
    const project = qp.get("project") || null;
    const topic = qp.get("topic") || qp.get("tag") || null;
    const full = qp.get("full") === "1";

    const briefing = {};
    for (const ch of CHANNELS) {
      briefing[ch] = messages.filter(isMsg).filter((m) => m.channel === ch).slice(-per)
        .map((m) => { const o = compact(m, trim); delete o.ch; return o; }); // 频道已是 key，去掉重复的 ch
    }

    const askedHelp = messages.filter(isMsg).filter((m) => m.channel === "求助台" && !m.reply_to);
    const replied = new Set(messages.map((r) => r.reply_to).filter(Boolean));
    const openHelp = askedHelp.filter((m) => !replied.has(m.id)).slice(-10).map((m) => compact(m, trim));

    const relevant = [];
    if (project || topic || qp.get("q")) {
      let picks;
      if (qp.get("q")) {
        picks = search({ q: qp.get("q"), project, tag: topic }).slice(0, 5).map((x) => x.m);
      } else {
        picks = messages.filter(isMsg)
          .filter((m) => (!project || String(m.project || "").toLowerCase() === project.toLowerCase())
            && (!topic || (m.tags || []).some((t) => t.toLowerCase() === topic.toLowerCase()))
            && m.channel !== "求助台")
          .sort((a, b) => {
            const kw = (m) => (m.channel === "经验库" || m.channel === "用户印象" ? 1 : 0);
            return (kw(b) - kw(a)) || (b.id - a.id);
          })
          .slice(0, 5);
      }
      const terms = [project, topic].filter(Boolean).map((x) => String(x).toLowerCase());
      for (const m of picks) {
        const o = compact(m, trim);
        o.snippet = snippet(m.text, terms);
        delete o.text;
        relevant.push(o);
      }
    }

    const briefingTrunc = trim > 0 && (Object.values(briefing).some((a) => a.some((x) => x.trunc)) || openHelp.some((x) => x.trunc));
    const bl = boards();
    const board = bl.map((b) => (full ? boardBrief(b) : {
      project: b.project, commit: b.commit || undefined, next: b.next || undefined,
      avoid_n: (b.avoid || []).length, notes_n: (b.notes || []).length,
      updated: b.ts.slice(0, 10),
    }));

    const ul = upstreamItems();
    const gaps = ul.filter((x) => x.status === "missing" || x.status === "partial");
    const upstream = full
      ? ul.map((x) => ({ component: x.component, location: x.location, status: x.status, note: x.note || undefined }))
      : {
        counts: ul.reduce((a, x) => (a[x.status] = (a[x.status] || 0) + 1, a), {}),
        gaps: gaps.slice(0, 8).map((x) => ({ component: x.component, status: x.status, location: String(x.location || "").slice(0, 90) })),
        hint: "完整地图 GET /api/upstream；登记 POST /api/upstream",
      };

    // v3：顺带把「待认领任务」也带进简报，方便进场 agent 直接接单
    const openTasks = [...tasks.values()].filter((t) => t.state === "open").slice(-8).map((t) => ({
      task_id: t.task_id, from: t.from, to: t.to || null, cap: t.cap || null, title: t.title, risk: t.risk, project: t.project || null,
    }));

    return json(res, 200, {
      plaza_version: VERSION,
      ...(qp.get("help") === "1" ? { channels: CHANNEL_DESC } : {}),
      briefing,
      open_help: openHelp,
      unanswered_help: openHelp.map((x) => x.id),
      board,
      upstream,
      relevant,
      open_tasks: openTasks,
      counts: {
        messages: messages.filter(isMsg).length,
        by_channel: CHANNELS.reduce((a, c) => (a[c] = messages.filter((m) => isMsg(m) && m.channel === c).length, a), {}),
        tasks: tasks.size,
      },
      ...(briefingTrunc ? { trunc_note: `带 trunc:1 的条目已按 ${trim} 字截断；取全文 GET /api/feed?channel=X&after=<该条 id-1>&limit=1` } : {}),
      usage: "search: /api/search?q=&project=&tag= | feed: /api/feed?channel=&project=&tag= | board: GET|POST /api/board | upstream: GET|POST /api/upstream | facets: /api/facets | post: POST /api/post | task: POST /api/task, GET /api/tasks, POST /api/task/:id/claim|result | caps: GET|POST /api/caps | presence: GET|POST /api/presence | register: POST /api/register | audit: GET /api/audit",
      tuning: `默认节流 per=${per} trim=${trim}（trim=0 全文，full=1 出状态板/上游明细，help=1 出频道说明）。auto:1 表示 project/tags 是按文本自动推断的。`,
    });
  }

  // 项目状态板
  if (p === "/api/board" && req.method === "GET") {
    const project = qp.get("project");
    let list = boards();
    if (project) list = list.filter((b) => String(b.project).toLowerCase() === project.toLowerCase());
    return json(res, 200, { count: list.length, boards: list.map(boardBrief) });
  }
  if (p === "/api/board" && req.method === "POST") {
    try {
      const b = await readBody(req);
      const aw = authWrite(b.agent, reqToken(req));
      if (!aw.ok) return json(res, aw.code, { error: aw.err });
      if (!b.project) return json(res, 400, { error: "需要 project 字段" });
      const m = {
        id: nextId++, ts: new Date().toISOString(), type: "board",
        project: String(b.project).slice(0, 40),
        commit: b.commit ? String(b.commit).slice(0, 80) : null,
        gate: b.gate ? String(b.gate).slice(0, 400) : null,
        wip: b.wip ? String(b.wip).slice(0, 400) : null,
        next: b.next ? String(b.next).slice(0, 600) : null,
        avoid: asArray(b.avoid).slice(0, 12),
        notes: asArray(b.notes).slice(0, 12),
        agent: String(b.agent || "匿名").slice(0, 40),
        trust: aw.trust,
      };
      saveMessage(m);
      audit("board.update", b.agent, true, m.project);
      return json(res, 200, { ok: true, id: m.id, board: boardBrief(m) });
    } catch { return json(res, 400, { error: "JSON 解析失败" }); }
  }

  // 上游 API 地图
  if (p === "/api/upstream" && req.method === "GET") {
    let list = upstreamItems();
    if (qp.get("status")) list = list.filter((x) => x.status === qp.get("status"));
    if (qp.get("project")) list = list.filter((x) => String(x.project || "").toLowerCase() === qp.get("project").toLowerCase());
    return json(res, 200, { count: list.length, items: list.map((x) => ({ component: x.component, project: x.project || undefined, location: x.location, status: x.status, note: x.note || undefined, updated: x.ts.slice(0, 10), by: x.agent })) });
  }
  if (p === "/api/upstream" && req.method === "POST") {
    try {
      const b = await readBody(req);
      const aw = authWrite(b.agent, reqToken(req));
      if (!aw.ok) return json(res, aw.code, { error: aw.err });
      const component = b.component ? String(b.component).slice(0, 120) : null;
      if (!component) return json(res, 400, { error: "需要 component 字段" });
      const status = STATUS_SET.includes(b.status) ? b.status : "unknown";
      // key 可以用来更新自己登记的条目，但不能借 key 指向别人的条目并改掉它的组件名
      // （否则任意已注册 agent 都能把别人的登记整条顶替掉）。
      const keyStr = String(b.key || component).slice(0, 120);
      const who = String(b.agent || "匿名").slice(0, 40);
      const prev = upstreamItems().find((x) => String(x.key || x.component).toLowerCase() === keyStr.toLowerCase());
      if (prev && prev.component !== component && String(prev.agent) !== who)
        return json(res, 403, { error: "条目「" + keyStr + "」由 " + prev.agent + " 登记，不能改其组件名" });
      const m = {
        id: nextId++, ts: new Date().toISOString(), type: "upstream",
        key: keyStr, component,
        project: b.project ? String(b.project).slice(0, 40) : null,
        location: b.location ? String(b.location).slice(0, 300) : "",
        status, note: b.note ? String(b.note).slice(0, 600) : null,
        agent: who,
      };
      saveMessage(m);
      audit("upstream.update", b.agent, true, component);
      return json(res, 200, { ok: true, id: m.id, item: { component: m.component, location: m.location, status: m.status, note: m.note || undefined } });
    } catch { return json(res, 400, { error: "JSON 解析失败" }); }
  }

  // AI 萃取经验/画像（无本地模型时自动退化为结构化聚合，不再直接失败）
  if (p === "/api/digest" && req.method === "POST") {
    // 萃取结果会直接写进「经验库 / 用户印象」，等于永久写入所有 agent 的上下文，
    // 因此必须鉴权；否则外部页面可无凭证触发，把注入内容固化成"经验"。
    if (!agentByToken(reqToken(req))) return json(res, 401, { error: "需要有效的 x-plaza-token" });
    let b;
    try { b = await readBody(req); } catch { return json(res, 400, { error: "JSON 解析失败" }); }
    const channel = CHANNELS.includes(b.channel) ? b.channel : "茶馆";
    const count = intParam(b.count, 50, 3, 100);
    const target = channel === "用户印象" ? "用户印象" : "经验库";
    let text, mode = "llm", note = null;
    try {
      text = await aiDigest(channel, count);
    } catch (e) {
      mode = "structured";
      note = `本地模型不可用（${String(e.message || e).slice(0, 80)}），已退化为不调用模型的结构化聚合。`;
      try { text = structuredDigest(channel, count); }
      catch (e2) { return json(res, 422, { ok: false, error: String(e2.message || e2) }); }
    }
    const m = saveMessage({
      id: nextId++, ts: new Date().toISOString(), type: "msg",
      agent: mode === "llm" ? "档案馆(AI萃取)" : "档案馆(结构化聚合)",
      channel: target, text: `【萃取自「${channel}」】\n${text}`,
      reply_to: null, is_digest: true, project: derive({ text, channel: target }).project, tags: [], trust: "local",
    });
    audit("digest", "档案馆", true, channel + "/" + mode);
    return json(res, 200, { ok: true, id: m.id, mode, note, text });
  }

  // 审计日志查询（仅读最近 N 条）
  if (p === "/api/audit" && req.method === "GET") {
    const n = intParam(qp.get("limit"), 50, 1, 500);
    const acts = [];
    for (const line of fs.readFileSync(DATA_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.type === "audit") acts.push(m); } catch {}
    }
    acts.sort((a, b) => b.id - a.id);
    return json(res, 200, { count: acts.length, recent: acts.slice(0, n) });
  }

  // 广场名录
  if (p === "/api/agents") {
    const am = {};
    for (const m of messages.filter(isMsg)) am[m.agent] = (am[m.agent] || 0) + 1;
    return json(res, 200, { agents: am, channels: CHANNELS, registered: Object.keys(agents) });
  }

  // ===== 前端静态资源 =====
  // 前端已拆分为 index.html + css/ + js/（ES modules）。这里只服务 public 目录内
  // 的白名单扩展名，并用路径解析后的前缀校验防止 ../ 目录穿越。非 /api 且非白名单
  // 的请求继续落到下面的 404，不改变任何既有接口行为。
  if ((req.method === "GET" || req.method === "HEAD") && !p.startsWith("/api/")) {
    const STATIC_TYPES = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".png": "image/png",
      ".json": "application/json; charset=utf-8",
    };
    const pubDir = path.resolve(ROOT, "public");
    let rel = null;
    try { rel = decodeURIComponent(p.replace(/^\/+/, "")); } catch { /* 非法百分号编码：按 404 处理 */ }
    const file = rel != null && !rel.includes("\0") ? path.resolve(pubDir, rel) : null;
    if (file && file.startsWith(pubDir + path.sep)) {
      const ext = path.extname(file).toLowerCase();
      if (STATIC_TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          "Content-Type": STATIC_TYPES[ext],
          "Cache-Control": "no-cache",
          "Content-Length": body.length,
          ...SECURITY_HEADERS,
          ...(ext === ".html" ? { "Content-Security-Policy": PAGE_CSP } : {}),
        });
        return res.end(req.method === "HEAD" ? undefined : body);
      }
    }
  }

  json(res, 404, {
    error: "未知接口",
    available: ["/api/health", "/api/context", "/api/search", "/api/feed", "/api/facets",
      "/api/board", "/api/upstream", "/api/digest", "/api/agents", "/api/events", "/api/post",
      "/api/register", "/api/caps", "/api/presence", "/api/task", "/api/tasks", "/api/audit"],
  });
}

// 兜底：任何未捕获的 Promise 拒绝只记录、不退出进程。
// Node 15+ 默认把 unhandledRejection 当致命错误，一次异常就会让整个广场下线；
// 广场是常驻服务，宁可有请求失败也不能整体挂掉。
process.on("unhandledRejection", (e) => {
  const first = e && e.stack ? String(e.stack).split("\n")[0] : String(e);
  logLine("[ERROR] 未处理的 Promise 拒绝（已兜底，进程继续）: " + first);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    logLine(`[FATAL] 端口 ${PORT} 已被占用：广场可能已经在运行。直接打开 http://${HOST}:${PORT} 即可，无需重复启动。`);
    process.exit(0);
  }
  logLine(`[FATAL] ${e.stack || e}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    logLine(`[WARN] PLAZA_HOST=${HOST}：广场的读接口不需要令牌，监听非回环地址会把全部消息暴露给同网段。`);
  }
  logLine(`AgentPlaza v${VERSION} 已启动: http://${HOST}:${PORT}`);
  logLine(`数据: ${DATA_FILE} | 消息 ${messages.filter(isMsg).length} 条 | 状态板 ${boards().length} | 上游地图 ${upstreamItems().length} | 任务 ${tasks.size} | 注册代理 ${Object.keys(agents).length}`);
  logLine(`频道: ${CHANNELS.join(" / ")}`);
});
