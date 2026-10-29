// 本地服务的安全与功能回归：每个用例共用一个跑在临时数据目录上的 server.js 实例。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.join(__dirname, "..");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let dir, child;

// fetch 不允许改 Host 头，这里用 http.request 发原始请求。
function raw(pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text: data });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}
const post = (p, body, headers = {}) => raw(p, { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-test-"));
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PLAZA_PORT: String(PORT), PLAZA_DATA: path.join(dir, "plaza.jsonl"), PLAZA_AGENTS: path.join(dir, "agents.json"), PLAZA_LOG_DIR: path.join(dir, "logs"), PLAZA_OLLAMA: "http://127.0.0.1:9" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await raw("/api/health")).status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
});
test.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test("JSON 响应不再带通配 CORS，跨站请求被拒绝", async () => {
  const h = await raw("/api/health");
  assert.equal(h.headers["access-control-allow-origin"], undefined);
  assert.equal(h.headers["x-content-type-options"], "nosniff");
  const read = await raw("/api/feed", { headers: { Origin: "https://evil.example" } });
  assert.equal(read.status, 403);
  const write = await raw("/api/post", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: { agent: "x", text: "csrf" } });
  assert.equal(write.status, 403);
  const same = await raw("/api/health", { headers: { Origin: BASE } });
  assert.equal(same.status, 200);
});

test("DNS 重绑定：非本机 Host 被拒绝", async () => {
  const r = await raw("/api/feed", { headers: { Host: `attacker.example:${PORT}` } });
  assert.equal(r.status, 421);
});

test("已注册 agent 的令牌不会被他人取回或改写", async () => {
  const first = await post("/api/register", { agent: "ext", trust: "external-allowlisted" });
  assert.equal(first.status, 200);
  assert.match(first.body.token, /^[0-9a-f]{32}$/);
  const again = await post("/api/register", { agent: "ext" });
  assert.equal(again.status, 200);
  assert.equal(again.body.token, undefined);
  const hijack = await post("/api/register", { agent: "ext", trust: "local", token: "a".repeat(20) });
  assert.equal(hijack.status, 401);
  const noToken = await post("/api/post", { agent: "ext", text: "hi" });
  assert.equal(noToken.status, 401);
  const ok = await post("/api/post", { agent: "ext", text: "hi", trust: "local" }, { "x-plaza-token": first.body.token });
  assert.equal(ok.status, 200);
  const feed = await raw("/api/feed?limit=1");
  assert.equal(feed.body.messages[0].trust, "external-allowlisted", "trust 来自注册表而不是客户端自报");
  const rotate = await post("/api/register", { agent: "ext", token: "b".repeat(20) }, { "x-plaza-token": first.body.token });
  assert.equal(rotate.status, 200);
  assert.equal(rotate.body.token, "b".repeat(20));
});

test("__proto__ 之类的名字不会污染原型", async () => {
  const r = await post("/api/register", { agent: "__proto__", trust: "external-readonly" });
  assert.equal(r.status, 200);
  const w = await post("/api/post", { agent: "__proto__", text: "x" });
  assert.equal(w.status, 403);
  const other = await post("/api/post", { agent: "constructor", text: "x" });
  assert.equal(other.status, 200);
  const caps = await raw("/api/caps");
  assert.ok(caps.body.agents.some((a) => a.agent === "__proto__"));
});

test("任务认领与回结果需要身份并遵守认领关系", async () => {
  await post("/api/register", { agent: "ro", trust: "external-readonly" });
  const t = await post("/api/task", { from: "boss", title: "t", brief: "b" });
  const id = t.body.task.task_id;
  assert.equal((await post(`/api/task/${id}/claim`, {})).status, 400);
  assert.equal((await post(`/api/task/${id}/claim`, { by: "ro" })).status, 403);
  assert.equal((await post(`/api/task/${id}/claim`, { by: "worker" })).status, 200);
  assert.equal((await post(`/api/task/${id}/result`, { by: "intruder", outcome: "done" })).status, 403);
  const done = await post(`/api/task/${id}/result`, { by: "worker", outcome: "done", result: "ok" });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.state, "done");
  const directed = await post("/api/task", { from: "boss", to: "alice", title: "t2", brief: "b" });
  assert.equal((await post(`/api/task/${directed.body.task.task_id}/claim`, { by: "bob" })).status, 403);
});

test("畸形输入只得到错误响应，不会让服务崩溃", async () => {
  assert.equal((await raw("/%E0%A4%A")).status, 404);
  assert.equal((await post("/api/digest", "null")).status, 400);
  assert.equal((await post("/api/post", "[1,2]")).status, 400);
  assert.equal((await post("/api/post", { agent: "a", text: "x", reply_to: 999999 })).status, 400);
  const feed = await raw("/api/feed?limit=abc");
  assert.equal(feed.status, 200);
  assert.ok(feed.body.messages.length <= 50);
  const neg = await raw("/api/feed?limit=-5");
  assert.equal(neg.body.messages.length, 1);
  assert.equal((await raw("/api/health")).status, 200);
});

test("回复会把求助从未答列表里移除", async () => {
  const ask = await post("/api/post", { agent: "a", channel: "求助台", text: "help" });
  let ctx = await raw("/api/context");
  assert.ok(ctx.body.unanswered_help.includes(ask.body.id));
  assert.equal((await post("/api/post", { agent: "b", channel: "求助台", text: "answer", reply_to: String(ask.body.id) })).status, 200);
  ctx = await raw("/api/context?per=abc");
  assert.ok(!ctx.body.unanswered_help.includes(ask.body.id));
});

test("静态资源带 CSP，目录穿越仍被挡住", async () => {
  const page = await raw("/");
  assert.match(page.headers["content-security-policy"], /default-src 'self'/);
  assert.equal((await raw("/..%2fserver.js")).status, 404);
  assert.equal((await raw("/js/ui.js")).status, 200);
});

test("agents.json 原子写入且仅属主可读", { skip: process.platform === "win32" }, () => {
  const file = path.join(dir, "agents.json");
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + ".tmp"));
  assert.equal(fs.statSync(file).mode & 0o077, 0);
});
