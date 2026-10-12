// 凭据与本机信息扫描门：源码树与已发布快照都用同一套规则过一遍。
// 与 lib/publish 的 SECRET_PATTERNS 分工不同：那边管快照内容，这边管仓库文件，
// 因此不匹配 “token” 这类普通单词，只匹配真实凭据形态与本机痕迹。
//
//   node tools/check_secrets.js                 # 扫 git 跟踪的文件（发布范围）；无 git 时遍历目录
//   node tools/check_secrets.js --selftest      # 验证规则本身
//   node tools/check_secrets.js --snapshot site/data/snapshot.json
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { findForbidden, findLeaks } = require("../lib/publish");

const ROOT = path.join(__dirname, "..");

const PATTERNS = [
  ["十六进制凭据样式", /\b[0-9a-f]{32}\b/],
  ["私钥块", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["本机家目录", /(?:^|[\s"'`(=])[A-Za-z]:[\\/]{1,2}(?:Users|home)[\\/]/i],
  ["本机家目录（斜杠式）", /[\\/](?:Users|home)[\\/][^\\/"'\s]+[\\/]/],
  ["邮箱地址", /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/],
  ["凭据赋值", /(?:token|secret|passwd|password|api[_-]?key)\s*[:=]\s*["'`][A-Za-z0-9+\/=_-]{16,}["'`]/i],
];

// 本机运行数据与凭据文件不参与仓库扫描（它们由 .gitignore 排除在版本库之外）。
const SKIP_DIRS = new Set([".git", ".lake", "node_modules", "data", "logs", "backups"]);
const SKIP_FILES = new Set(["credentials.local.js"]);
const TEXT_EXT = /\.(html?|css|js|mjs|json|md|txt|svg|yml|yaml|ps1|vbs|bat|py|lean|toml|url)$/i;

function listTracked(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    return out.toString("utf8").split("\0").filter(Boolean).map((f) => path.join(root, f));
  } catch { return null; }
}

function walkDir(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkDir(path.join(dir, e.name), out);
    } else if (TEXT_EXT.test(e.name) && !SKIP_FILES.has(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function scanFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    for (const [label, re] of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      hits.push({ label, line: i + 1, sample: m[0].slice(0, 48) });
    }
  });
  return hits;
}

function report(label, items) {
  if (!items.length) { console.log(`通过：${label} 未发现凭据或本机痕迹`); return; }
  console.error(`不通过：${label} 命中 ${items.length} 处`);
  for (const it of items) {
    console.error(`  ${it.file}:${it.line} [${it.label}] ${it.sample}`);
  }
  process.exitCode = 1;
}

// 规则自测：既要抓得到真凭据，也不能把普通写法误报成凭据。
// 样本在源码里拆成片段、运行时才拼成完整形态，否则扫描门会把自己的测试数据报成泄露。
const SECRET_HEX = "0123456789abcdef".repeat(2);
const SECRET_WORD = "AbCdEf0123456789xyzW";
const KEY_MARK = "-----" + "BEGIN RSA PRIVATE KEY-----";
const WIN_HOME = "C:" + "\\" + "Users" + "\\" + "someone" + "\\" + "AgentPlaza";
const POSIX_HOME = "/" + "home" + "/" + "someone" + "/" + "plaza";
const MAIL = "a.b" + "@" + "example.com";

const SELFTEST = [
  [`export const DEFAULT_TOKEN = "${SECRET_HEX}";`, true],
  [`const secret = "${SECRET_WORD}";`, true],
  [KEY_MARK, true],
  [`数据在 ${WIN_HOME}\\data\\plaza.jsonl`, true],
  [`读 ${POSIX_HOME}/data 目录`, true],
  [`联系 ${MAIL}`, true],
  ['const LS_TOKEN = "plaza.token";', false],
  ["链接 https://github.com/someone/repo 可用", false],
  ["提交 013b0ed 与 1689b21131b488ec2ba2515bd630360371a2389d", false],
  ["theorem Classical.choice 与 x-plaza-token 请求头", false],
];

function selftest() {
  const failures = [];
  for (const [sample, shouldHit] of SELFTEST) {
    const hit = PATTERNS.some(([, re]) => re.test(sample));
    if (hit !== shouldHit) failures.push(`${shouldHit ? "应命中却漏报" : "误报"}：${sample}`);
  }
  if (failures.length) {
    console.error(`不通过：扫描规则自测失败 ${failures.length} 项`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log(`通过：扫描规则自测 ${SELFTEST.length} 项全部符合预期`);
}

function main() {
  if (process.argv.includes("--selftest")) { selftest(); return; }
  const snapArg = process.argv.indexOf("--snapshot");
  if (snapArg >= 0 && process.argv[snapArg + 1]) {
    const file = path.resolve(ROOT, process.argv[snapArg + 1]);
    const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
    const forbidden = findForbidden(bundle);
    const leaks = findLeaks(bundle);
    if (forbidden || leaks.length) {
      console.error(`不通过：${path.relative(ROOT, file)} 违反公开契约`);
      if (forbidden) console.error(`  禁止键 ${forbidden}`);
      for (const l of leaks) console.error(`  ${l.label}: ${l.sample}`);
      process.exit(1);
    }
    console.log(`通过：快照结构无禁止键，内容无凭据/路径命中（${(fs.statSync(file).size / 1024).toFixed(1)} KB）`);
    return;
  }

  const items = [];
  const files = listTracked(ROOT);
  const scope = files ? `git 跟踪清单（${files.length} 个文件）` : "目录遍历（非 git 仓库）";
  for (const file of (files || walkDir(ROOT))) {
    if (!fs.existsSync(file) || !TEXT_EXT.test(file) || SKIP_FILES.has(path.basename(file))) continue;
    for (const h of scanFile(file)) items.push({ ...h, file: path.relative(ROOT, file).replace(/\\/g, "/") });
  }
  report(`仓库源码树 · ${scope}`, items);
}

main();
