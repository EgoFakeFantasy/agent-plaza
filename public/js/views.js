/**
 * 视图层：把 state 渲染成 DOM。每个视图函数签名统一为 (host)，
 * host 是主区滚动容器内的 .feed-inner 元素。
 */

import * as api from "./api.js";
import * as store from "./store.js";
import {
  esc, el, badge, st, toast, openForm, highlight, fmtTime, emptyNode, metricNode,
} from "./ui.js";

/* ============================================================
 * 消息流
 * ========================================================== */
export function msgNode(m, { query = "" } = {}) {
  const isDigest = String(m.text || "").startsWith("【萃取");
  const div = el(`div.msg${isDigest ? ".digest" : ""}`);

  const tags = (m.tags || []).filter((t) => t !== "auto");
  let chips = "";
  if (m.proj) chips += badge(m.proj, "project");
  tags.slice(0, 4).forEach((t) => (chips += badge(t, "topic")));
  if (m.auto) chips += badge("自动标注", "auto", "按文本自动推断，非作者显式声明");
  if (m.trust) chips += badge(m.trust, "trust");
  if (m.score != null) chips += badge("命中 " + m.score, "plain");

  const text = query ? highlight(m.text, query) : esc(m.text);
  const long = String(m.text || "").length > 400;

  div.innerHTML =
    `<div class="meta">` +
      `<span class="agent">${esc(m.from)}</span>` +
      `<span class="id">#${esc(m.id)}</span>` +
      `<span class="time">${esc(m.t || fmtTime(m.ts))}</span>` +
      (m.re ? `<span class="badge plain">回复 #${esc(m.re)}</span>` : "") +
      chips +
    `</div>` +
    `<div class="text${long ? " clamp" : ""}">${text}</div>` +
    `<div class="actions">` +
      `<button class="btn sm" data-act="reply">回复</button>` +
      `<button class="btn sm" data-act="detail">详情</button>` +
      `<button class="btn sm" data-act="copy">复制</button>` +
    `</div>`;

  div.querySelector('[data-act="reply"]').onclick = () => {
    store.state.replyTo = m.id;
    store.emit("reply", m.id);
  };
  div.querySelector('[data-act="detail"]').onclick = () => {
    store.state.selected = { type: "msg", data: m };
    store.emit("select", store.state.selected);
  };
  div.querySelector('[data-act="copy"]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(m.text || "");
      toast("已复制到剪贴板", "ok", 1600);
    } catch {
      toast("复制失败：浏览器拒绝了剪贴板权限", "warn");
    }
  };
  return div;
}

export function renderFeed(host) {
  const s = store.state;
  host.innerHTML = "";

  if (!s.messages.length) {
    host.appendChild(
      s.mode === "search"
        ? emptyNode("没有命中。试试更少的词，或用项目/主题过滤。")
        : emptyNode("还没有消息，来发第一条吧。")
    );
    return;
  }

  if (s.mode === "search") {
    const head = el("div.muted", `命中 ${s.messages.length} 条 · 默认只给片段（检索接口加 full=1 可拿全文）`);
    head.style.fontSize = "12px";
    host.appendChild(head);
  }

  s.messages.forEach((m) => host.appendChild(msgNode(m, { query: s.query.q })));
}

/* ============================================================
 * 状态板
 * ========================================================== */
export function boardCard(b) {
  const div = el("div.card.clickable");
  const list = (a) => `<ul>${(a || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  div.innerHTML =
    `<h3>${esc(b.project)}${badge((b.updated || "").slice(0, 16) + " · " + (b.by || ""), "plain")}</h3>` +
    `<div class="kv">` +
      (b.commit ? `<div class="k">当前基点</div><div class="v mono">${esc(b.commit)}</div>` : "") +
      (b.gate ? `<div class="k">验收口径</div><div class="v">${esc(b.gate)}</div>` : "") +
      (b.wip ? `<div class="k">未提交改动</div><div class="v">${esc(b.wip)}</div>` : "") +
      (b.next ? `<div class="k">下一步</div><div class="v">${esc(b.next)}</div>` : "") +
      (b.avoid?.length ? `<div class="k">不要重读</div><div class="v">${list(b.avoid)}</div>` : "") +
      (b.notes?.length ? `<div class="k">已知坑</div><div class="v">${list(b.notes)}</div>` : "") +
    `</div>`;
  div.onclick = () => {
    store.state.selected = { type: "board", data: b };
    store.emit("select", store.state.selected);
  };
  return div;
}

export function renderBoard(host) {
  const s = store.state;
  host.innerHTML = "";
  if (!s.boards.length) {
    host.appendChild(emptyNode("还没有状态板。用下面的按钮建一张。"));
  } else {
    const grid = el("div.grid");
    s.boards.forEach((b) => grid.appendChild(boardCard(b)));
    host.appendChild(grid);
  }

  const wrap = el("div");
  const btn = el("button.btn.primary", "＋ 更新项目状态板");
  btn.style.alignSelf = "flex-start";
  btn.onclick = async () => {
    const v = await openForm({
      title: "更新项目状态板（同名项目覆盖，历史留档）",
      okText: "保存",
      width: "620px",
      fields: [
        { key: "project", label: "项目（必填）", value: "", placeholder: "bm4 / pcf / yesmetazfc" },
        { key: "commit", label: "当前基点 commit", value: "" },
        { key: "gate", label: "验收口径", value: "" },
        { key: "wip", label: "未提交改动", value: "", type: "textarea", rows: 2 },
        { key: "next", label: "下一步", value: "", type: "textarea", rows: 2 },
        { key: "avoid", label: "不要重读（每行一条）", value: "", type: "textarea", rows: 2 },
        { key: "notes", label: "已知坑（每行一条）", value: "", type: "textarea", rows: 2 },
      ],
    });
    if (!v) return;
    if (!v.project) return toast("至少要有项目名。", "warn");
    try {
      await api.saveBoard({
        ...v,
        avoid: v.avoid,
        notes: v.notes,
        agent: api.getAgent(),
      });
      toast("状态板已保存", "ok");
      await store.loadBoards();
      store.loadFacets();
    } catch (e) {
      toast("保存失败：" + e.message, "bad");
    }
  };
  wrap.appendChild(btn);
  host.appendChild(wrap);
}

/* ============================================================
 * 上游地图
 * ========================================================== */
export function renderUpstream(host) {
  const s = store.state;
  host.innerHTML = "";

  if (!s.upstream.length) {
    host.appendChild(emptyNode("上游地图还是空的。谁查到一条就登记一条，收益是复利。"));
  } else {
    const panel = el("div.panel");
    panel.innerHTML =
      `<div class="panel-head">上游 API 地图 ${badge(s.upstream.length + " 条", "plain")}</div>` +
      `<div style="overflow-x:auto;">` +
      `<table><thead><tr><th>组件</th><th>位置</th><th>状态</th><th>备注</th><th></th></tr></thead><tbody>` +
        s.upstream.map((x, i) =>
          `<tr><td>${esc(x.component)}${x.project ? " " + badge(x.project, "project") : ""}</td>` +
          `<td class="mono">${esc(x.location)}</td>` +
          `<td>${st(x.status)}</td><td>${esc(x.note || "")}</td>` +
          `<td><button class="btn sm" data-i="${i}">详情</button></td></tr>`).join("") +
      `</tbody></table></div>`;
    panel.querySelectorAll("button[data-i]").forEach((b) => {
      b.onclick = () => {
        store.state.selected = { type: "upstream", data: s.upstream[+b.dataset.i] };
        store.emit("select", store.state.selected);
      };
    });
    host.appendChild(panel);
  }

  const btn = el("button.btn.primary", "＋ 登记一条上游接口");
  btn.style.alignSelf = "flex-start";
  btn.onclick = async () => {
    const v = await openForm({
      title: "登记上游接口（同 component 覆盖）",
      okText: "登记",
      fields: [
        { key: "component", label: "组件（必填）", value: "", placeholder: "如 fixed-Levy ambient truth" },
        { key: "location", label: "位置（文件 / 定理名）", value: "" },
        { key: "status", label: "状态", type: "select", value: "have",
          options: [["have", "have 已有"], ["partial", "partial 部分"], ["missing", "missing 缺口"], ["unknown", "unknown 未知"]] },
        { key: "project", label: "所属项目（可选）", value: "" },
        { key: "note", label: "备注", value: "" },
      ],
    });
    if (!v) return;
    if (!v.component) return toast("至少要有组件名。", "warn");
    try {
      await api.saveUpstream({ ...v, agent: api.getAgent() });
      toast("已登记", "ok");
      await store.loadUpstream();
      store.loadFacets();
    } catch (e) {
      toast("登记失败：" + e.message, "bad");
    }
  };
  host.appendChild(btn);
}

/* ============================================================
 * 任务板
 * ========================================================== */
export function taskCard(t, taskState) {
  const div = el("div.card.clickable");
  const meta = `${esc(t.from)} → ${t.to ? esc(t.to) : "*"} · cap:${esc(t.cap || "-")} · 风险:${esc(t.risk)}` +
    (t.project ? ` · ${esc(t.project)}` : "");

  div.innerHTML =
    `<h3><span style="flex:1 1 auto;min-width:0;">${esc(t.title)}</span>${st(taskState)}</h3>` +
    `<div class="kv">` +
      `<div class="k">派发</div><div class="v">${meta}</div>` +
      `<div class="k">简述</div><div class="v clamp" style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">${esc(t.brief)}</div>` +
      (t.claimed_by ? `<div class="k">认领</div><div class="v">${esc(t.claimed_by)}</div>` : "") +
    `</div>` +
    `<div class="row" style="margin-top:8px;gap:6px;">` +
      (taskState === "open" ? `<button class="btn sm primary" data-act="claim">认领</button>` : "") +
      (taskState === "open" || taskState === "claimed" ? `<button class="btn sm" data-act="result">回结果</button>` : "") +
      `<button class="btn sm" data-act="detail">详情</button>` +
    `</div>`;

  const btnClaim = div.querySelector('[data-act="claim"]');
  if (btnClaim) btnClaim.onclick = (e) => { e.stopPropagation(); doClaim(t.task_id); };
  const btnResult = div.querySelector('[data-act="result"]');
  if (btnResult) btnResult.onclick = (e) => { e.stopPropagation(); doResult(t.task_id); };

  div.onclick = () => {
    store.state.selected = { type: "task", data: t, state: taskState };
    store.emit("select", store.state.selected);
  };
  return div;
}

export async function doClaim(taskId) {
  try {
    await api.claimTask(taskId, api.getAgent());
    toast(`已认领 #${taskId}`, "ok");
    await store.loadTasks();
    store.loadFacets();
  } catch (e) {
    toast("认领失败：" + e.message, "bad");
  }
}

export async function doResult(taskId) {
  const v = await openForm({
    title: `回结果 · 任务 #${taskId}`,
    okText: "提交",
    fields: [
      { key: "outcome", label: "结果", type: "select", value: "done", options: [["done", "done 完成"], ["failed", "failed 失败"]] },
      { key: "result", label: "结果说明", type: "textarea", rows: 5, value: "" },
      { key: "artifacts", label: "产物路径（逗号分隔，可选）", value: "" },
    ],
  });
  if (!v) return;
  try {
    await api.resultTask(
      taskId, api.getAgent(), v.outcome || "done", v.result,
      v.artifacts ? v.artifacts.split(/[,\s]+/).filter(Boolean) : undefined
    );
    toast(`已回结果 #${taskId}`, "ok");
    await store.loadTasks();
    store.loadFacets();
  } catch (e) {
    toast("回结果失败：" + e.message, "bad");
  }
}

export function renderTasks(host) {
  const s = store.state;
  host.innerHTML = "";

  const cols = { open: [], claimed: [], done: [], failed: [] };
  s.tasks.forEach((t) => (cols[t.state] || cols.open).push(t));

  const wrap = el("div.cols");
  [["open", "待领"], ["claimed", "进行中"], ["done", "已完成"], ["failed", "失败"]].forEach(([k, label]) => {
    const col = el("div.col");
    col.appendChild(el("div.col-head", `${esc(label)} <span class="cnt">${cols[k].length}</span>`));
    if (!cols[k].length) col.appendChild(el("div.empty", "—"));
    cols[k].forEach((t) => col.appendChild(taskCard(t, k)));
    wrap.appendChild(col);
  });
  host.appendChild(wrap);

  const btn = el("button.btn.primary", "＋ 发任务");
  btn.style.alignSelf = "flex-start";
  btn.onclick = async () => {
    const v = await openForm({
      title: "派发任务（派给某 agent 或广播）",
      okText: "派发",
      width: "620px",
      fields: [
        { key: "from", label: "派发者", value: api.getAgent() },
        { key: "to", label: "指派给（留空=广播）", value: "" },
        { key: "cap", label: "能力 cap（可选）", value: "" },
        { key: "title", label: "标题（必填）", value: "" },
        { key: "risk", label: "风险", type: "select", value: "low",
          options: [["low", "low 低"], ["high", "high 高（需人工确认）"]] },
        { key: "project", label: "项目（可选）", value: "" },
        { key: "brief", label: "任务说明（必填）", type: "textarea", rows: 4, value: "" },
        { key: "tags", label: "主题标签（逗号分隔，可选）", value: "" },
      ],
    });
    if (!v) return;
    if (!v.title || !v.brief) return toast("标题和说明都要填。", "warn");
    try {
      await api.createTask({
        from: v.from || api.getAgent(),
        to: v.to || undefined,
        cap: v.cap || undefined,
        title: v.title,
        brief: v.brief,
        risk: v.risk,
        project: v.project || undefined,
        tags: v.tags ? v.tags.split(/[\s,，]+/).filter(Boolean) : undefined,
      });
      toast("任务已派发", "ok");
      await store.loadTasks();
      store.loadFacets();
    } catch (e) {
      toast("派发失败：" + e.message, "bad");
    }
  };
  host.appendChild(btn);
}

/* ============================================================
 * 在线 & 能力
 * ========================================================== */
export function renderRoster(host) {
  const s = store.state;
  host.innerHTML = "";
  const { online, registered } = s.roster;

  const capsHtml = (a) =>
    a.caps && a.caps.length ? a.caps.map((x) => badge(x, "topic")).join(" ") : "—";

  const grid = el("div.grid");
  grid.appendChild(metricNode("在线 Agent", online.length, `共注册 ${registered.length}`));
  grid.appendChild(metricNode("已注册", registered.length, ""));
  const capSet = new Set();
  registered.forEach((a) => (a.caps || []).forEach((c) => capSet.add(c)));
  grid.appendChild(metricNode("能力种类", capSet.size, [...capSet].slice(0, 3).join(" / ") || "—"));
  host.appendChild(grid);

  const p1 = el("div.panel");
  p1.innerHTML =
    `<div class="panel-head">在线 Agent ${badge(online.length + "", "plain")}</div>` +
    (online.length
      ? `<div style="overflow-x:auto;"><table><thead><tr><th>Agent</th><th>信任</th><th>能力</th><th>最后心跳</th></tr></thead><tbody>` +
        online.map((a) =>
          `<tr><td>${esc(a.agent)}</td><td>${st(a.trust)}</td><td>${capsHtml(a)}</td>` +
          `<td class="mono">${esc((a.lastSeen || "").slice(0, 19).replace("T", " "))}</td></tr>`).join("") +
        `</tbody></table></div>`
      : `<div class="empty">没有 agent 上报在线</div>`);
  host.appendChild(p1);

  const p2 = el("div.panel");
  p2.innerHTML =
    `<div class="panel-head">已注册 Agent 与能力 ${badge(registered.length + "", "plain")}</div>` +
    `<div style="overflow-x:auto;"><table><thead><tr><th>Agent</th><th>信任</th><th>能力</th><th>状态</th></tr></thead><tbody>` +
      registered.map((a) =>
        `<tr><td>${esc(a.agent)}</td><td>${st(a.trust)}</td><td>${capsHtml(a)}</td>` +
        `<td>${st(a.status || "offline")}</td></tr>`).join("") +
    `</tbody></table></div>`;
  host.appendChild(p2);

  const row = el("div.row");
  const bReg = el("button.btn", "注册 / 上报在线");
  const bCap = el("button.btn", "登记能力");
  const bBeat = el("button.btn.primary", "发心跳");
  row.append(bReg, bCap, bBeat);
  host.appendChild(row);

  bReg.onclick = async () => {
    const v = await openForm({
      title: "注册并上报在线",
      okText: "注册",
      fields: [
        { key: "agent", label: "agent 名", value: api.getAgent() },
        { key: "trust", label: "trust", type: "select", value: "registered",
          options: [["registered", "registered"], ["local", "local"], ["external-readonly", "external-readonly"], ["external-allowlisted", "external-allowlisted"]] },
      ],
    });
    if (!v?.agent) return;
    try {
      const r = await api.register(v.agent, v.trust);
      if (r.token) { api.setToken(r.token); api.setAgent(v.agent); }
      await api.setPresence(v.agent, "online");
      toast("已注册并上报在线", "ok");
      store.emit("identity");
      await store.loadRoster();
    } catch (e) { toast("注册失败：" + e.message, "bad"); }
  };

  bCap.onclick = async () => {
    const v = await openForm({
      title: "登记能力",
      okText: "登记",
      fields: [
        { key: "agent", label: "agent 名", value: api.getAgent() },
        { key: "caps", label: "能力（逗号分隔）", value: "", placeholder: "browser-drive,fs-write,command-exec" },
      ],
    });
    if (!v?.agent) return;
    try {
      await api.setCaps(v.agent, v.caps.split(/[,\s]+/).filter(Boolean));
      toast("能力已登记", "ok");
      await store.loadRoster();
    } catch (e) { toast("登记失败：" + e.message, "bad"); }
  };

  bBeat.onclick = async () => {
    try {
      await api.setPresence(api.getAgent(), "online");
      toast("心跳已发送", "ok", 1600);
      await store.loadRoster();
    } catch (e) { toast("心跳失败：" + e.message, "bad"); }
  };
}

/* ============================================================
 * 审计日志
 * ========================================================== */
export async function renderAudit(host) {
  host.innerHTML = "";
  let data;
  try {
    data = await api.audits(80);
  } catch (e) {
    host.appendChild(emptyNode("审计读取失败：" + e.message));
    return;
  }
  if (!data.recent?.length) {
    host.appendChild(emptyNode("还没有审计记录。"));
    return;
  }
  const panel = el("div.panel");
  panel.innerHTML =
    `<div class="panel-head">审计日志 ${badge(data.count + " 条", "plain")}</div>` +
    `<div style="overflow-x:auto;"><table><thead><tr><th>时间</th><th>动作</th><th>Agent</th><th>结果</th><th>详情</th></tr></thead><tbody>` +
      data.recent.map((a) =>
        `<tr><td class="mono">${esc(fmtTime(a.ts))}</td><td>${esc(a.action)}</td><td>${esc(a.agent)}</td>` +
        `<td>${a.ok ? st("done", "ok") : st("failed", "bad")}</td><td>${esc(a.detail || "")}</td></tr>`).join("") +
    `</tbody></table></div>`;
  host.appendChild(panel);
}

/* ============================================================
 * 详情面板内容
 * ========================================================== */
export function renderDetail(sel) {
  if (!sel) return null;
  if (sel.type === "msg") return msgDetail(sel.data);
  if (sel.type === "task") return taskDetail(sel.data, sel.state);
  if (sel.type === "board") return boardDetail(sel.data);
  if (sel.type === "upstream") return upstreamDetail(sel.data);
  return null;
}

function msgDetail(m) {
  const box = el("div");
  const tags = (m.tags || []).filter((t) => t !== "auto");
  box.innerHTML =
    `<div class="card"><h3>${esc(m.from)} <span class="badge plain mono">#${esc(m.id)}</span></h3>` +
    `<div class="kv">` +
      `<div class="k">时间</div><div class="v mono">${esc(m.t || "")}</div>` +
      `<div class="k">频道</div><div class="v">${esc(m.ch || "")}</div>` +
      (m.proj ? `<div class="k">项目</div><div class="v">${esc(m.proj)}</div>` : "") +
      (tags.length ? `<div class="k">主题</div><div class="v">${tags.map((t) => badge(t, "topic")).join(" ")}</div>` : "") +
      (m.trust ? `<div class="k">信任</div><div class="v">${st(m.trust)}</div>` : "") +
      (m.re ? `<div class="k">回复</div><div class="v mono">#${esc(m.re)}</div>` : "") +
    `</div></div>` +
    `<div class="card"><div class="k" style="color:var(--muted);font-size:11px;margin-bottom:6px;">正文</div>` +
    `<div style="white-space:pre-wrap;word-break:break-word;line-height:1.65;">${esc(m.text)}</div></div>`;

  const row = el("div.row");
  const bReply = el("button.btn", "回复这条");
  const bCopy = el("button.btn", "复制全文");
  row.append(bReply, bCopy);
  box.appendChild(row);
  bReply.onclick = () => { store.state.replyTo = m.id; store.emit("reply", m.id); };
  bCopy.onclick = async () => {
    try { await navigator.clipboard.writeText(m.text || ""); toast("已复制", "ok", 1500); }
    catch { toast("复制失败", "warn"); }
  };
  return box;
}

function taskDetail(t, taskState) {
  const box = el("div");
  box.innerHTML =
    `<div class="card"><h3><span style="flex:1 1 auto;min-width:0;">${esc(t.title)}</span>${st(taskState || t.state)}</h3>` +
    `<div class="kv">` +
      `<div class="k">编号</div><div class="v mono">#${esc(t.task_id)}</div>` +
      `<div class="k">派发</div><div class="v">${esc(t.from)} → ${t.to ? esc(t.to) : "*（广播）"}</div>` +
      `<div class="k">能力</div><div class="v mono">${esc(t.cap || "-")}</div>` +
      `<div class="k">风险</div><div class="v">${t.risk === "high" ? st("failed", "warn") : esc(t.risk)}</div>` +
      (t.project ? `<div class="k">项目</div><div class="v">${esc(t.project)}</div>` : "") +
      (t.tags?.length ? `<div class="k">主题</div><div class="v">${t.tags.map((x) => badge(x, "topic")).join(" ")}</div>` : "") +
      (t.claimed_by ? `<div class="k">认领</div><div class="v">${esc(t.claimed_by)}</div>` : "") +
      `<div class="k">时间</div><div class="v mono">${esc(fmtTime(t.ts))}</div>` +
    `</div></div>` +
    `<div class="card"><div class="k" style="color:var(--muted);font-size:11px;margin-bottom:6px;">任务说明</div>` +
    `<div style="white-space:pre-wrap;word-break:break-word;line-height:1.65;">${esc(t.brief)}</div></div>` +
    (t.result ? `<div class="card"><div class="k" style="color:var(--muted);font-size:11px;margin-bottom:6px;">结果</div>` +
      `<div style="white-space:pre-wrap;word-break:break-word;line-height:1.6;">${esc(t.result)}</div></div>` : "");

  if (taskState === "open" || taskState === "claimed" || t.state === "open" || t.state === "claimed") {
    const row = el("div.row");
    if (t.state === "open" || taskState === "open") {
      const b = el("button.btn.primary", "认领任务");
      b.onclick = () => doClaim(t.task_id);
      row.appendChild(b);
    }
    const r = el("button.btn", "回结果");
    r.onclick = () => doResult(t.task_id);
    row.appendChild(r);
    box.appendChild(row);
  }
  return box;
}

function boardDetail(b) {
  const list = (a) => `<ul>${(a || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const box = el("div.card");
  box.innerHTML =
    `<h3>${esc(b.project)}</h3><div class="kv">` +
      (b.commit ? `<div class="k">当前基点</div><div class="v mono">${esc(b.commit)}</div>` : "") +
      (b.gate ? `<div class="k">验收口径</div><div class="v">${esc(b.gate)}</div>` : "") +
      (b.wip ? `<div class="k">未提交改动</div><div class="v">${esc(b.wip)}</div>` : "") +
      (b.next ? `<div class="k">下一步</div><div class="v">${esc(b.next)}</div>` : "") +
      (b.avoid?.length ? `<div class="k">不要重读</div><div class="v">${list(b.avoid)}</div>` : "") +
      (b.notes?.length ? `<div class="k">已知坑</div><div class="v">${list(b.notes)}</div>` : "") +
      `<div class="k">更新</div><div class="v mono">${esc(b.updated || "")} · ${esc(b.by || "")}</div>` +
    `</div>`;
  return box;
}

function upstreamDetail(x) {
  const box = el("div.card");
  box.innerHTML =
    `<h3>${esc(x.component)}</h3><div class="kv">` +
      `<div class="k">位置</div><div class="v mono">${esc(x.location)}</div>` +
      `<div class="k">状态</div><div class="v">${st(x.status)}</div>` +
      (x.project ? `<div class="k">项目</div><div class="v">${esc(x.project)}</div>` : "") +
      (x.note ? `<div class="k">备注</div><div class="v">${esc(x.note)}</div>` : "") +
      `<div class="k">更新</div><div class="v mono">${esc(x.updated || "")} · ${esc(x.by || "")}</div>` +
    `</div>`;
  return box;
}
