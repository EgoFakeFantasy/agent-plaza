// 发布快照生成器：直接读 plaza.jsonl（不依赖、也不重启运行中的广场服务），
// 折叠成公开安全的快照写入站点 data/snapshot.json，并在落盘前后各过一道安全门。
//
// 用法：
//   node tools/publish_site.js                    # 只生成快照，不提交
//   node tools/publish_site.js --commit           # 生成 + 本地提交 site/
//   node tools/publish_site.js --commit --push    # 再推送（需显式批准）
//   可选：--remote=origin --branch=main --project=bm4 --days=60 --timeline=240
//         --data=<jsonl 路径> --site=<站点目录>
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildBundle, findLeaks, assertPublicSafe, findForbidden } = require("../lib/publish");

const ROOT = path.join(__dirname, "..");
const CHANNELS = ["求助台", "茶馆", "经验库", "用户印象"];

function arg(name, dflt) {
  const flag = "--" + name;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === flag) {
      const v = process.argv[i + 1];
      return v && !v.startsWith("--") ? v : true;
    }
    if (a.startsWith(flag + "=")) return a.slice(flag.length + 1);
  }
  return dflt;
}

const strArg = (name, dflt) => {
  const v = arg(name, dflt);
  return typeof v === "string" ? path.resolve(v) : path.resolve(dflt);
};

const DATA_FILE = strArg("data", path.join(ROOT, "data", "plaza.jsonl"));
const SITE_DIR = strArg("site", path.join(ROOT, "site"));
const DAYS = parseInt(arg("days", "60"), 10) || 60;
const TIMELINE = parseInt(arg("timeline", "240"), 10) || 240;
const projArg = arg("project", "");
const PROJECTS = typeof projArg === "string"
  ? projArg.split(",").map((x) => x.trim()).filter(Boolean)
  : [];

function loadStore(file) {
  const messages = [];
  const tasks = new Map();
  const taskCreated = new Map();
  let maxId = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id > maxId) maxId = m.id;
    if (m.type === "task") {
      tasks.set(m.task_id, m);
      if (!taskCreated.has(m.task_id)) taskCreated.set(m.task_id, m.ts);
      continue;
    }
    if (m.type === "audit") continue;
    messages.push(m);
  }
  const latest = (type, key) => {
    const map = new Map();
    for (const m of messages) {
      if (m.type !== type) continue;
      map.set(String(key(m)).toLowerCase(), m);
    }
    return [...map.values()];
  };
  return {
    messages, tasks, taskCreated,
    boards: () => latest("board", (m) => m.project).sort((a, b) => String(a.project).localeCompare(String(b.project))),
    upstreamItems: () => latest("upstream", (m) => m.key || m.component).sort((a, b) => String(a.component).localeCompare(String(b.component))),
    maxId,
  };
}

function serverVersion() {
  try {
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    return (src.match(/const VERSION = "([^"]+)"/) || [null, "unknown"])[1];
  } catch { return "unknown"; }
}

// 递归扫描站点目录：源码里藏了凭据或本机路径同样拦下。
function scanTree(dir) {
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(html?|css|js|mjs|json|md|txt|svg)$/i.test(e.name)) continue;
      const hits = findLeaks({ scan: fs.readFileSync(p, "utf8") });
      if (hits.length) offenders.push(`${path.relative(dir, p)}: ${hits.map((h) => h.label).join(",")}`);
    }
  };
  walk(dir);
  return offenders;
}

function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`找不到数据文件：${DATA_FILE}`);
    process.exit(2);
  }
  const store = loadStore(DATA_FILE);
  const bundle = buildBundle({
    messages: store.messages, tasks: store.tasks, taskCreated: store.taskCreated,
    boards: store.boards, upstreamItems: store.upstreamItems,
    channels: CHANNELS, version: serverVersion(),
    onlyProjects: PROJECTS.length ? PROJECTS : null,
  }, { days: DAYS, timeline: TIMELINE });

  const forbidden = findForbidden(bundle);
  if (forbidden) { console.error(`结构安全门不通过：快照出现禁止键 ${forbidden}`); process.exit(1); }

  try { assertPublicSafe(bundle); } catch (e) { console.error(String(e.message)); process.exit(1); }

  const outDir = path.join(SITE_DIR, "data");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "snapshot.json");
  fs.writeFileSync(out, JSON.stringify(bundle));

  // 落盘后再扫一次整棵站点目录：源码里藏了路径或凭据同样拦下。
  const offenders = scanTree(SITE_DIR);
  if (offenders.length) {
    fs.unlinkSync(out);
    console.error("站点内容安全门不通过，已撤回快照：\n  " + offenders.join("\n  "));
    process.exit(1);
  }

  const stat = fs.statSync(out);
  console.log(`快照已生成：${out} (${(stat.size / 1024).toFixed(1)} KB)`);
  console.log(`  发布范围：${bundle.scope ? "仅项目 " + bundle.scope.join("、") : "全平台所有项目"}`);
  console.log(`  消息 ${bundle.stats.messages} | 任务 ${bundle.stats.tasks} | 项目 ${bundle.projects.length} | 时间线 ${bundle.timeline.length} 条元数据`);
  console.log(`  任务状态：${JSON.stringify(bundle.counts.by_state)}`);
  console.log(`  最大消息 id：${store.maxId}（用于判断快照是否落后）`);

  if (arg("commit")) {
    const msg = `chore(publish): 更新广场快照 ${bundle.generated_at}`;
    // 站点整体就是发布产物；从仓库根只提交 site/，不把无关的工作区改动裹进快照提交。
    execFileSync("git", ["add", "-A", "site"], { cwd: ROOT, stdio: "inherit" });
    execFileSync("git", ["commit", "-m", msg], { cwd: ROOT, stdio: "inherit" });
    console.log("已本地提交：" + msg);

    if (arg("push")) {
      const remote = typeof arg("remote", "origin") === "string" ? arg("remote") : "origin";
      const branch = typeof arg("branch", "") === "string" ? arg("branch") : "";
      const remotes = execFileSync("git", ["remote"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
      if (!remotes.includes(remote)) {
        console.error(`未配置远端 ${remote}（现有：${remotes.filter(Boolean).join(", ") || "无"}）。` +
          "快照已在本地提交；推送属对外共享状态变更，需先显式配置远端。");
        process.exit(3);
      }
      const target = branch || execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: ROOT, encoding: "utf8" }).trim();
      execFileSync("git", ["push", remote, target], { cwd: ROOT, stdio: "inherit" });
      console.log(`已推送到 ${remote}/${target}`);
    } else {
      console.log("未推送：推送需显式加 --push。");
    }
  }
}

main();
