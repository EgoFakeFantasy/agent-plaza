/**
 * UI 组件层：转义、元素构造、徽章、指标卡、Toast、表单模态框。
 * 所有视图共用，避免各处重复拼 HTML 字符串。
 */

export function esc(s) {
  if (s == null) return "";
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

/** 构造元素：el("div.card", html) */
export function el(spec, html) {
  const [tag, ...cls] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (cls.length) node.className = cls.join(" ");
  if (html != null) node.innerHTML = html;
  return node;
}

export function fmtTime(ts) {
  if (!ts) return "";
  const s = String(ts).replace("T", " ").replace("Z", "");
  return s.slice(5, 16);
}

/* ---------- Toast ---------- */
let toastRoot = null;
export function toast(message, kind = "", ms = 3200) {
  if (!toastRoot) toastRoot = document.getElementById("toasts");
  if (!toastRoot) return;
  const t = el(`div.toast${kind ? "." + kind : ""}`, esc(message));
  toastRoot.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .2s";
    setTimeout(() => t.remove(), 220);
  }, ms);
}

/* ---------- 小组件 ---------- */
export function badge(text, kind = "plain", title = "") {
  return `<span class="badge ${esc(kind)}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
}
export function st(text, kind) {
  return `<span class="st ${esc(kind || text)}">${esc(text)}</span>`;
}
export function emptyNode(text) {
  return el("div.empty", esc(text));
}
export function metricNode(k, v, s) {
  return el("div.metric",
    `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>` +
    (s ? `<div class="s">${esc(s)}</div>` : ""));
}

/* ---------- 表单模态框 ---------- */
/**
 * fields: [{ key, label, type: 'text'|'textarea'|'select', value, placeholder, options:[[v,l]], rows, hint }]
 * 返回 Promise：确认时 resolve(表单值对象)，取消时 resolve(null)
 */
export function openForm({ title, fields = [], okText = "提交", width }) {
  return new Promise((resolve) => {
    const root = document.getElementById("modalRoot");
    const scrim = el("div.modal-scrim");
    const modal = el("div.modal");
    if (width) modal.style.width = width;

    const body = fields
      .map((f) => {
        const id = "f_" + f.key;
        const label = f.label ? `<label for="${id}">${esc(f.label)}</label>` : "";
        let input;
        if (f.type === "textarea") {
          input = `<textarea id="${id}" rows="${f.rows || 3}" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`;
        } else if (f.type === "select") {
          input = `<select id="${id}">` +
            (f.options || []).map(([v, l]) =>
              `<option value="${esc(v)}"${String(v) === String(f.value ?? "") ? " selected" : ""}>${esc(l)}</option>`).join("") +
            `</select>`;
        } else {
          input = `<input id="${id}" type="text" value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}" list="${esc(f.list || "")}" />`;
        }
        const hint = f.hint ? `<div class="muted" style="font-size:11px;">${esc(f.hint)}</div>` : "";
        return `<div class="field">${label}${input}${hint}</div>`;
      })
      .join("");

    modal.innerHTML =
      `<div class="modal-head">${esc(title)}</div>` +
      `<div class="modal-body">${body}</div>` +
      `<div class="modal-foot">` +
      `<button class="btn" data-cancel>取消</button>` +
      `<button class="btn primary" data-ok>${esc(okText)}</button>` +
      `</div>`;

    scrim.appendChild(modal);
    root.appendChild(scrim);

    const close = (val) => { scrim.remove(); resolve(val); };
    modal.querySelector("[data-cancel]").onclick = () => close(null);
    modal.querySelector("[data-ok]").onclick = () => {
      const out = {};
      for (const f of fields) {
        const node = modal.querySelector("#f_" + f.key);
        out[f.key] = node ? node.value.trim() : "";
      }
      close(out);
    };
    scrim.addEventListener("click", (e) => { if (e.target === scrim) close(null); });
    const onKey = (e) => {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(null); }
    };
    document.addEventListener("keydown", onKey);

    const first = modal.querySelector("input, textarea, select");
    if (first) first.focus();
  });
}

/* ---------- 高亮检索命中 ---------- */
export function highlight(text, query) {
  const safe = esc(text);
  const q = String(query || "").trim().split(/\s+/).filter(Boolean);
  if (!q.length) return safe;
  let out = safe;
  for (const w of q) {
    const re = new RegExp("(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }
  return out;
}
