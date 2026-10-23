import { GROUPS, LEVERS, leverById, scoreAll, tenYear } from "./levers.js";
import { fmt } from "./model.js";
import { curveEditor } from "./taxcurve-ui.js";

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const money = (b, o) => fmt(b * 1000, o);
export const PHASES = [[0, "Immediately"], [3, "Over 3 years"], [5, "Over 5 years"], [10, "Over 10 years"]];

let model, ctx, onChange, openDrawerShell;
const rows = new Map(); // lever id -> row parts

export function initRevenue(m, c, { changed, drawer }) {
  model = m; ctx = c; onChange = changed; openDrawerShell = drawer;
}

export function revenueScores() {
  return scoreAll(ctx, model);
}

const valueOf = (L) => (model.rev.has(L.id) ? model.rev.get(L.id) : L.control.def);
const isChanged = (L) => model.rev.has(L.id);

function set(L, v) {
  model.setRev(L.id, v, L.control.def);
  onChange();
}

export function renderRevenue() {
  const box = $("#revenue");
  box.textContent = "";
  rows.clear();
  box.append(summaryBox());
  box.append(el("p", "small rev-intro", "Estimates come from CBO and other published sources, scaled to today's economy, and include ordinary behavioral responses but not effects on economic growth. Changes stack: the tool doesn't model how levers interact (for example, a higher income tax rate makes each deduction worth more), so very large combined plans are approximate."));
  for (const g of GROUPS) {
    const levers = LEVERS.filter((l) => l.group === g.id);
    if (!levers.length) continue;
    const card = el("div", "lever-group");
    const h = el("h3", "", g.name);
    card.append(h);
    if (g.note) card.append(el("p", "small", g.note));
    for (const L of levers) card.append(leverRow(L));
    box.append(card);
  }
  updateRevenue();
}

function summaryBox() {
  const s = el("div", "rev-summary");
  s.id = "rev-summary";
  const bi = model.bi;
  const list = el("div", "rev-sources");
  const max = Math.max(...model.receipts.map((r) => r.v[bi]));
  for (const r of model.receipts) {
    const row = el("div", "rev-src");
    row.append(el("span", "rev-name", r.name), el("span", "rev-amt", fmt(r.v[bi])));
    const bar = el("div", "rev-bar"); const fill = el("span");
    fill.style.width = Math.max(0, (r.v[bi] / max) * 100) + "%";
    bar.append(fill); row.append(bar);
    list.append(row);
  }
  const head = el("div", "rev-head");
  head.append(el("div", "rev-total", ""), el("div", "rev-ten", ""));
  s.append(head);
  const det = el("details", "rev-details");
  det.append(el("summary", "", `Where FY${model.fy} revenue comes from (President's budget)`), list);
  s.append(det);
  return s;
}

function curveRow(L) {
  const row = el("div", "lever lever-curve");
  row.dataset.id = L.id;
  const top = el("div", "lever-top");
  const name = el("button", "name", L.name);
  name.addEventListener("click", () => openLever(L));
  const info = el("button", "info", "?");
  info.title = "What is this?";
  info.addEventListener("click", () => openLever(L));
  top.append(name, info);
  const editor = curveEditor(L, {
    get: () => valueOf(L),
    set: (code) => set(L, code),
    scorePath: () => scoreAll(ctx, model).byId[L.id] || ctx.zero(),
    ctx,
  });
  row.append(top, editor);
  rows.set(L.id, { row, L, editor, curve: true });
  return row;
}

function leverRow(L) {
  if (L.control.type === "curve") return curveRow(L);
  const row = el("div", "lever");
  row.dataset.id = L.id;
  const top = el("div", "lever-top");
  const name = el("button", "name", L.name);
  name.addEventListener("click", () => openLever(L));
  const tags = el("span", "tags");
  if (L.source?.older) tags.append(el("span", "chip X", "pre-2025-law estimate"));
  if (L.uncertain) tags.append(el("span", "chip warn-soft", "high uncertainty"));
  const info = el("button", "info", "?");
  info.title = "What is this?";
  info.setAttribute("aria-label", "What is " + L.name + "?");
  info.addEventListener("click", () => openLever(L));
  const reset = el("button", "reset", "↺");
  reset.title = "Reset";
  reset.setAttribute("aria-label", "Reset " + L.name);
  reset.addEventListener("click", () => set(L, L.control.def));
  top.append(name, tags);

  const ctl = el("div", "lever-ctl");
  let input, label;
  const c = L.control;
  if (c.type === "slider") {
    input = el("input", "range");
    input.type = "range"; input.min = c.min; input.max = c.max; input.step = c.step;
    input.setAttribute("aria-label", L.name);
    input.addEventListener("input", () => { set(L, +input.value); });
    label = el("span", "lever-val");
    ctl.append(input, label);
  } else if (c.type === "toggle") {
    input = el("input", "switch");
    input.type = "checkbox";
    input.setAttribute("aria-label", L.name);
    input.addEventListener("change", () => set(L, input.checked));
    label = el("span", "lever-val");
    ctl.append(input, label);
  } else {
    input = el("select", "lever-select");
    input.setAttribute("aria-label", L.name);
    for (const o of c.options) { const op = el("option", "", o.label); op.value = o.v; input.append(op); }
    input.addEventListener("change", () => set(L, input.value));
    ctl.append(input);
  }
  const eff = el("div", "lever-eff");
  const e1 = el("span", "e1"), e2 = el("span", "e2");
  eff.append(e1, e2);
  ctl.append(reset, info);
  row.append(top, ctl, eff);
  rows.set(L.id, { row, input, label, e1, e2, reset, L });
  return row;
}

export function updateRevenue() {
  if (!rows.size) return;
  const sc = scoreAll(ctx, model);
  const i = ctx.Y.indexOf(model.fy);
  for (const [id, p] of rows) {
    if (p.curve) { p.row.classList.toggle("changed", isChanged(p.L)); p.editor.update(); continue; }
    const L = p.L, v = valueOf(L), c = L.control;
    if (c.type === "slider") {
      if (document.activeElement !== p.input) p.input.value = v;
      p.label.textContent = c.fmt(v);
      // Fill from the default outward.
      const pos = (x) => ((x - c.min) / (c.max - c.min)) * 100;
      const a = Math.min(pos(v), pos(c.def)), b = Math.max(pos(v), pos(c.def));
      const path = sc.byId[id];
      const up = path ? path.reduce((s, x) => s + x, 0) >= 0 : true;
      p.input.style.setProperty("--track", `linear-gradient(90deg, var(--line) 0 ${a}%, ${up ? "var(--in)" : "var(--out)"} ${a}% ${b}%, var(--line) ${b}% 100%)`);
    } else if (c.type === "toggle") {
      p.input.checked = !!v;
      p.label.textContent = v ? "On" : "Off";
    } else p.input.value = v;
    const changed = isChanged(L);
    p.row.classList.toggle("changed", changed);
    p.reset.disabled = !changed;
    const path = sc.byId[id];
    if (changed && path) {
      const fy = path[i];
      const ten = path.reduce((s, x, k) => s + (ctx.Y[k] >= model.fy && ctx.Y[k] < model.fy + 10 ? x : 0), 0);
      p.e1.textContent = `${money(fy, { sign: true })} in ${model.fy}`;
      p.e2.textContent = `${money(ten, { sign: true })} over 10 years`;
      p.e1.className = "e1 " + (fy >= 0 ? "cut" : "add");
      p.e2.className = "e2 " + (ten >= 0 ? "cut" : "add");
    } else {
      p.e1.textContent = "no change";
      p.e1.className = "e1 none";
      p.e2.textContent = " ";
      p.e2.className = "e2";
    }
  }
  // Summary
  const tot = sc.total[i];
  const ten = sc.total.reduce((s, x, k) => s + (ctx.Y[k] >= model.fy && ctx.Y[k] < model.fy + 10 ? x : 0), 0);
  const t = $("#rev-summary .rev-total"), t2 = $("#rev-summary .rev-ten");
  t.textContent = "";
  t.append(el("span", "label", `Revenue in FY${model.fy}`), el("span", "val in", fmt(model.totalReceipts + tot * 1000)));
  t2.textContent = "";
  t2.append(el("span", "label", "Your revenue changes"),
    el("span", "val " + (tot >= 0 ? "in" : "out"), Math.abs(tot) < 0.05 ? "none yet" : `${money(tot, { sign: true })} in ${model.fy}`),
    el("span", "sub", Math.abs(ten) < 0.05 ? "" : `${money(ten, { sign: true })} over 10 years`));
}

export function openLever(L) {
  const v = valueOf(L);
  const facts = [];
  const tenNow = tenYear(ctx, L, v);
  facts.push(["Setting", settingText(L, v)]);
  if (isChanged(L)) facts.push(["10-year effect", `${money(tenNow, { sign: true })} (${model.fy}–${model.fy + 9}, at full strength)`]);
  facts.push(["Estimate source", L.source?.name || "—"]);
  if (L.source?.detail) facts.push(["Calibration", L.source.detail]);
  if (L.source?.older) facts.push(["Note", "This estimate predates the 2025 reconciliation law (the One Big Beautiful Bill Act), which changed tax rates and deductions. It's scaled to today's economy, but treat it as approximate."]);
  openDrawerShell({
    path: "Revenue › " + GROUPS.find((g) => g.id === L.group).name,
    title: L.name,
    desc: L.desc,
    facts,
    links: [[L.source?.url, "Source ↗"], [L.source?.older ? "https://www.cbo.gov/publication/60557" : null, "CBO budget options ↗"]].filter((x) => x[0]),
    phase: isChanged(L) ? {
      value: model.revPh.has(L.id) ? model.revPh.get(L.id) : null,
      set: (n) => { model.setRevPhase(L.id, n); onChange(); },
    } : null,
  });
}

// For the Changes tab.
export function revenueChanges() {
  const sc = scoreAll(ctx, model);
  const i = ctx.Y.indexOf(model.fy);
  return [...model.rev.keys()].map((id) => {
    const L = leverById(id);
    if (!L) return null;
    const path = sc.byId[id] || [];
    const ten = path.reduce((s, x, k) => s + (ctx.Y[k] >= model.fy && ctx.Y[k] < model.fy + 10 ? x : 0), 0);
    const v = valueOf(L);
    const what = settingText(L, v);
    return { L, fy: path[i] || 0, ten, what, ph: model.revPh.has(id) ? model.revPh.get(id) : model.phase };
  }).filter(Boolean);
}

function settingText(L, v) {
  const c = L.control;
  if (c.type === "curve") return v === c.def ? "Current law" : "Custom brackets";
  if (c.type === "select") return c.options.find((o) => o.v === v)?.label;
  if (c.type === "toggle") return v ? "On" : "Off";
  return c.fmt(v);
}
