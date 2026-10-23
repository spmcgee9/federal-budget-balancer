// Simple mode: a short list of big, familiar levers that write into the same plan as Advanced mode.
import { fmt } from "./model.js?v=dev";
import { leverById, scoreAll, tenYear } from "./levers.js?v=dev";
import { baseSchedule, decodeSchedule, encodeSchedule, BASE_CODE } from "./taxcurve.js?v=dev";
import { scoreProposals, tenYearCost, proposalById } from "./proposals.js?v=dev";
import { computeResults, spendingTenYear } from "./projections-ui.js?v=dev";
import { lineChart } from "./charts.js?v=dev";

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const money = (b, o) => fmt(b * 1000, o);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- lever definitions ----
const SPENDING = [
  { key: "ss", name: "Social Security", desc: "Retirement, survivor, and disability benefits for about 70 million people.", nodes: ["f650"], mand: true },
  { key: "medicare", name: "Medicare", desc: "Health insurance for people 65 and older and some people with disabilities.", nodes: ["f570"], mand: true },
  { key: "medicaid", name: "Medicaid and health insurance subsidies", desc: "Health coverage for lower-income people, CHIP for children, and ACA marketplace subsidies.", nodes: ["s551"], mand: true },
  { key: "defense", name: "Defense", desc: "The military: troops, weapons, operations, and research. Covers yearly appropriations (about $1 trillion).", nodes: ["f050"], mand: false },
  { key: "domestic", name: "Everything else the government runs", desc: "Yearly appropriations for education, science, transportation, housing, law enforcement, parks, health research, and more.", nodes: ["f250", "f270", "f300", "f350", "f370", "f400", "f450", "f500", "f600", "f750", "f800", "s552", "s554"], mand: false },
  { key: "foreign", name: "Foreign aid and diplomacy", desc: "Embassies, the State Department, humanitarian and development aid, and security assistance.", nodes: ["f150"], mand: false },
];
const PROPOSALS = ["single_payer", "prek", "free_college", "ctc_arpa", "ss_tax_end", "tariff_rebate"];
const SIMPLE_REV = new Set(["itax", "corp_rate", "ss_cap", "tariff"]);

// Income tax levers adjust the bracket schedule: "high earners" = the 35% and 37% brackets
// (taxable income above about $256,000 single / $512,000 married); "middle class" = 12%, 22%, and 24%.
const TOP = [5, 6], MID = [1, 2, 3];
function scheduleFor(top, mid) {
  const s = baseSchedule();
  for (const k of TOP) s[k].r = Math.max(0, s[k].r + top / 100);
  for (const k of MID) s[k].r = Math.max(0, s[k].r + mid / 100);
  return s;
}
function readIncome(code) {
  if (!code || code === BASE_CODE) return { top: 0, mid: 0 };
  const s = decodeSchedule(code), b = baseSchedule();
  if (!s || s.length !== b.length || s.some((p, k) => Math.abs(p.t - b[k].t) > 0.5)) return null;
  const d = s.map((p, k) => Math.round((p.r - b[k].r) * 1000) / 10);
  const top = d[5], mid = d[1];
  const ok = d[0] === 0 && d[4] === 0 && d[6] === top && d[2] === mid && d[3] === mid;
  return ok ? { top, mid } : null;
}

let model, ctx, onChange, goAdvanced;
const rows = new Map();

export function initSimple(m, c, { changed, advanced }) {
  model = m; ctx = c; onChange = changed; goAdvanced = advanced;
}

function subtreeSettingIds(nodeIds) {
  const ids = [];
  for (const id of model.settings.keys()) {
    for (let n = model.nodes.get(id); n; n = n.parent) if (nodeIds.includes(n.id)) { ids.push(id); break; }
  }
  return ids;
}

// Current value of a spending lever: its own percent if all its nodes share one, else null (set in Advanced).
function spendValue(L) {
  const own = L.nodes.map((id) => model.settings.get(id));
  const under = subtreeSettingIds(L.nodes).filter((id) => !L.nodes.includes(id));
  if (under.length) return null;
  if (own.every((s) => !s)) return 0;
  if (own.every((s) => s && s.on && s.pct === own[0].pct)) return own[0].pct;
  return null;
}

function setSpend(L, pct) {
  if (L.mand && pct !== 0 && !model.mandatoryUnlocked) {
    model.mandatoryUnlocked = true;
    const t = document.getElementById("mand-toggle");
    if (t) t.checked = true;
  }
  for (const id of L.nodes) model.setNodeRaw(id, pct, L.mand);
  model.recompute();
  onChange();
}

// ---------- render ----------
export function renderSimple() {
  const box = $("#simple");
  if (!box) return;
  box.textContent = "";
  rows.clear();
  const intro = el("div", "simple-intro");
  intro.id = "simple-intro";
  box.append(intro);

  const grid = el("div", "simple-grid");
  const left = el("div", "simple-col");
  const right = el("div", "simple-col simple-results");

  // Spending
  const sp = section("Spending", "Each slider changes a program's budget by a percentage. Cuts or increases apply every year.");
  for (const L of SPENDING) sp.append(spendRow(L));
  left.append(sp);

  // Taxes
  const tx = section("Taxes", "");
  tx.append(incomeRow("top", "Income tax rate on high earners", "The 35% and 37% brackets: taxable income above about $256,000 (single) or $512,000 (married).", -10, 25));
  tx.append(incomeRow("mid", "Income tax rate on the middle class", "The 12%, 22%, and 24% brackets, which cover most working households.", -5, 5));
  tx.append(leverRow("corp_rate", "Corporate tax rate", "The tax on company profits, 21% today.", { min: 15, max: 35, step: 1, fmt: (v) => v + "%" }));
  tx.append(capRow());
  tx.append(leverRow("tariff", "Tariffs on imports", "The average tax on imported goods, about 10% today.", { min: 0, max: 40, step: 0.5, fmt: (v) => v + "%" }));
  left.append(tx);

  // Proposals
  const pr = section("Big proposals", "Ideas that have been proposed but aren't law. Middle estimates.");
  for (const id of PROPOSALS) { const p = proposalById(id); if (p) pr.append(propRow(p)); }
  left.append(pr);

  // Results
  const res = el("div", "simple-card");
  res.append(el("h3", "", "Where the debt goes"), el("p", "small", "Debt held by the public as a share of the economy, under the President's budget and your plan."));
  const leg = el("div", "legend-row");
  leg.innerHTML = '<span><i class="ln plan"></i>Your plan</span><span><i class="ln base"></i>President\'s budget</span>';
  res.append(leg, Object.assign(el("div", "simple-chart"), { id: "simple-chart" }), Object.assign(el("div", "simple-kpis"), { id: "simple-kpis" }));
  const more = el("div", "simple-more");
  more.id = "simple-more";
  res.append(more);
  const adv = el("button", "btn ghost", "Open Advanced mode for every line of the budget →");
  adv.addEventListener("click", () => goAdvanced());
  res.append(adv);
  const how = el("a", "small how-link", "How these numbers are calculated");
  how.href = "about.html#how";
  res.append(how);
  right.append(res);

  grid.append(left, right);
  box.append(grid);
  updateSimple();
}

function section(title, note) {
  const s = el("div", "simple-card");
  s.append(el("h3", "", title));
  if (note) s.append(el("p", "small", note));
  return s;
}

function rowShell(name, desc) {
  const r = el("div", "simple-row");
  const head = el("div", "simple-head");
  const t = el("div", "simple-title");
  const nameLine = el("span", "simple-name-line");
  const warn = el("span", "chip warn simple-warn", "⚠ Mandatory: needs a change in law");
  warn.title = "This program's spending is set by permanent law, not yearly appropriations. Changing it takes new legislation.";
  warn.hidden = true;
  nameLine.append(el("span", "simple-name", name), warn);
  t.append(nameLine, el("span", "simple-desc", desc));
  const eff = el("div", "simple-eff");
  head.append(t, eff);
  const ctl = el("div", "simple-ctl");
  r.append(head, ctl);
  return { r, eff, ctl, warn };
}

function slider(min, max, step) {
  const s = el("input", "range");
  s.type = "range"; s.min = min; s.max = max; s.step = step;
  return s;
}

function spendRow(L) {
  const { r, eff, ctl, warn } = rowShell(L.name, L.desc);
  const s = slider(-50, 50, 1);
  s.setAttribute("aria-label", L.name);
  const val = el("span", "lever-val");
  s.addEventListener("input", () => setSpend(L, +s.value));
  const note = el("span", "simple-custom", "");
  ctl.append(s, val, note);
  rows.set("s:" + L.key, { kind: "spend", L, r, eff, s, val, note, warn });
  return r;
}

function incomeRow(which, name, desc, min, max) {
  const { r, eff, ctl } = rowShell(name, desc);
  const s = slider(min, max, 0.5);
  s.setAttribute("aria-label", name);
  const val = el("span", "lever-val");
  s.addEventListener("input", () => {
    const cur = readIncome(model.rev.get("itax")) || { top: 0, mid: 0 };
    cur[which] = +s.value;
    const code = encodeSchedule(scheduleFor(cur.top, cur.mid));
    model.setRev("itax", code, BASE_CODE);
    onChange();
  });
  const note = el("span", "simple-custom", "");
  ctl.append(s, val, note);
  rows.set("i:" + which, { kind: "income", which, r, eff, s, val, note });
  return r;
}

function leverRow(id, name, desc, c) {
  const L = leverById(id);
  const { r, eff, ctl } = rowShell(name, desc);
  const s = slider(c.min, c.max, c.step);
  s.setAttribute("aria-label", name);
  const val = el("span", "lever-val");
  s.addEventListener("input", () => { model.setRev(id, +s.value, L.control.def); onChange(); });
  ctl.append(s, val);
  rows.set("r:" + id, { kind: "rev", id, L, c, r, eff, s, val });
  return r;
}

function capRow() {
  const L = leverById("ss_cap");
  const { r, eff, ctl } = rowShell("Social Security tax cap", "The 12.4% Social Security tax applies only to wages up to $184,500. Raise the cap to tax more of high earners' pay.");
  const seg = el("div", "seg-ctl small-seg");
  for (const [v, label] of [["law", "Current cap"], ["90", "Cover 90% of wages"], ["100", "No cap"]]) {
    const b = el("button", "", label); b.dataset.v = v;
    b.addEventListener("click", () => { model.setRev("ss_cap", v, L.control.def); onChange(); });
    seg.append(b);
  }
  ctl.append(seg);
  rows.set("r:ss_cap", { kind: "seg", id: "ss_cap", L, r, eff, seg });
  return r;
}

function propRow(p) {
  const { r, eff, ctl } = rowShell(p.name, p.desc.split(". ")[0] + ".");
  const sw = el("input", "switch");
  sw.type = "checkbox";
  sw.setAttribute("aria-label", "Include " + p.name);
  sw.addEventListener("change", () => {
    model.setProp(p.id, sw.checked ? { opt: p.default, ...(p.amount ? { amt: p.amount.def } : {}) } : null);
    onChange();
  });
  ctl.append(sw, el("span", "small", "Include in my plan"));
  rows.set("p:" + p.id, { kind: "prop", p, r, eff, sw });
  return r;
}

function effText(target, fy, ten, isCost, steady = true) {
  // fy/ten: billions; for spending/costs, positive = adds to the deficit.
  // steady = false when the first year isn't typical (phasing in, or a one-time cost).
  target.textContent = "";
  if (Math.abs(fy) < 0.05 && Math.abs(ten) < 0.05) { target.append(el("span", "none", "no change")); return; }
  const saves = isCost ? ten < 0 : ten > 0;
  const when = steady ? "a year" : `in ${model.fy}`;
  const a = el("span", "big " + (saves ? "cut" : "add"), `${saves ? "Saves" : "Costs"} ${money(Math.abs(fy))} ${when}`);
  const b = el("span", "small", `${money(Math.abs(ten))} over 10 years`);
  target.append(a, b);
}

export function updateSimple() {
  if (!rows.size) return;
  const sc = scoreAll(ctx, model);
  const ps = scoreProposals(ctx, model);
  const i = ctx.Y.indexOf(model.fy);
  const ten = (path) => path ? path.reduce((s, v, k) => s + (ctx.Y[k] >= model.fy && ctx.Y[k] < model.fy + 10 ? v : 0), 0) : 0;
  const inc = readIncome(model.rev.get("itax"));
  const curveL = leverById("itax");
  for (const [, R] of rows) {
    if (R.kind === "spend") {
      const v = spendValue(R.L);
      const nodes = R.L.nodes.map((id) => model.nodes.get(id));
      const fy = nodes.reduce((s, n) => s + (n.eff - n.base), 0) / 1000;
      const t = spendingTenYear(subtreeSettingIds(R.L.nodes));
      R.s.disabled = false;
      if (v === null) { R.note.textContent = "Adjusted in Advanced mode; moving the slider replaces those changes."; R.val.textContent = "custom"; }
      else { R.note.textContent = ""; if (document.activeElement !== R.s) R.s.value = v; R.val.textContent = (v > 0 ? "+" : "") + v + "%"; }
      paintTrack(R.s, v ?? 0, -50, 50, 0, v != null && v < 0);
      const own = model.settings.get(R.L.nodes[0]);
      effText(R.eff, fy, t, true, !model.phaseOf(own));
      R.r.classList.toggle("changed", Math.abs(fy) > 0.05);
      // Flag changes to mandatory programs right on the row, as well as in the banner.
      const mand = nodes.some((n) => n.mChanged > 0);
      R.warn.hidden = !mand;
      R.r.classList.toggle("m-changed", mand);
    } else if (R.kind === "income") {
      if (!inc) {
        R.s.disabled = true; R.val.textContent = "custom";
        R.note.textContent = "You've edited the brackets in Advanced mode. Reset them there to use this slider.";
        effText(R.eff, (sc.byId.itax?.[i] || 0) / 2, ten(sc.byId.itax) / 2, false);
        continue;
      }
      R.s.disabled = false; R.note.textContent = "";
      const v = inc[R.which];
      if (document.activeElement !== R.s) R.s.value = v;
      R.val.textContent = (v > 0 ? "+" : "") + v + " pts";
      paintTrack(R.s, v, +R.s.min, +R.s.max, 0, v > 0);
      // Effect of this lever alone.
      const only = R.which === "top" ? scheduleFor(inc.top, 0) : scheduleFor(0, inc.mid);
      const code = encodeSchedule(only);
      const path = code === BASE_CODE ? null : curveL.score(code, ctx).map((x, k) => x * model.ramp(model.revPh.get("itax") ?? model.phase, ctx.Y[k]));
      effText(R.eff, path ? path[i] : 0, ten(path), false, !(model.revPh.get("itax") ?? model.phase));
      R.r.classList.toggle("changed", v !== 0);
    } else if (R.kind === "rev") {
      const v = model.rev.has(R.id) ? model.rev.get(R.id) : R.L.control.def;
      if (document.activeElement !== R.s) R.s.value = v;
      R.val.textContent = R.c.fmt(v);
      paintTrack(R.s, v, R.c.min, R.c.max, R.L.control.def, (sc.byId[R.id] ? ten(sc.byId[R.id]) : 0) >= 0);
      effText(R.eff, sc.byId[R.id]?.[i] || 0, ten(sc.byId[R.id]), false, !(model.revPh.get(R.id) ?? model.phase));
      R.r.classList.toggle("changed", model.rev.has(R.id));
    } else if (R.kind === "seg") {
      const v = model.rev.has(R.id) ? model.rev.get(R.id) : R.L.control.def;
      R.seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === String(v)));
      effText(R.eff, sc.byId[R.id]?.[i] || 0, ten(sc.byId[R.id]), false);
      R.r.classList.toggle("changed", model.rev.has(R.id));
    } else if (R.kind === "prop") {
      const on = model.prop.has(R.p.id);
      R.sw.checked = on;
      const path = ps.byId[R.p.id];
      const st = model.prop.get(R.p.id);
      const opt = R.p.options.find((o) => o.key === st?.opt) || R.p.options[0];
      const N = model.propPh.has(R.p.id) ? model.propPh.get(R.p.id) : R.p.phase ?? 0;
      effText(R.eff, on ? path[i] : 0, on ? tenYearCost(ctx, path) : 0, true, !N && opt.kind !== "once");
      R.r.classList.toggle("changed", on);
    }
  }
  renderIntro();
  renderResults();
}

function paintTrack(input, v, min, max, def, good) {
  const pos = (x) => ((x - min) / (max - min)) * 100;
  const a = Math.min(pos(v), pos(def)), b = Math.max(pos(v), pos(def));
  input.style.setProperty("--track", `linear-gradient(90deg, var(--line) 0 ${a}%, ${good ? "var(--in)" : "var(--out)"} ${a}% ${b}%, var(--line) ${b}% 100%)`);
}

function renderIntro() {
  const box = $("#simple-intro");
  const O = model.totalOutlays / 1000, R = model.totalReceipts / 1000, D = O - R;
  box.textContent = "";
  box.append(el("h2", "", "Can you balance the budget?"),
    el("p", "", `In ${model.fy} the government plans to spend ${money(O)} and collect ${money(R)}, a deficit of ${money(D)}. Most spending goes to Social Security, Medicare, Medicaid, defense, and interest on the debt. Move the sliders below to close the gap, and watch what happens to the debt over the next 30 years.`));
}

function renderResults() {
  const r = computeResults();
  if (!r) return;
  const { res, sum, P } = r;
  const Y = res.years;
  const i0 = Y.indexOf(P.planStart) - 1;
  const yrs = Y.slice(i0);
  const pct = (arr) => arr.slice(i0).map((v, k) => (v / res.gdp[i0 + k]) * 100);
  lineChart($("#simple-chart"), {
    years: yrs, height: 230, zeroBase: true, label: "Debt as a share of GDP",
    fmt: (v) => Math.round(v) + "%", fmtTick: (v) => v + "%",
    refs: [{ value: 106, label: "Post-WWII record (106%)" }],
    series: [
      { name: "President's budget", short: "President", values: pct(res.base.debt), color: css("--base-line"), dash: true },
      { name: "Your plan", short: "Your plan", values: pct(res.mine.debt), color: css("--plan"), width: 2.5 },
    ],
  });
  const k = $("#simple-kpis");
  k.textContent = "";
  const card = (label, val, sub, good) => {
    const c = el("div", "kpi");
    c.append(el("span", "label", label), el("span", "val " + (good == null ? "" : good ? "cut" : "add"), val), el("span", "sub", sub));
    k.append(c);
  };
  const L = Y[Y.length - 1];
  const fmtD = (d) => (d.debt <= 0 ? "Paid off" : Math.round(d.pct) + "% of GDP");
  const better = (a, b) => (Math.abs(a - b) < 0.5 ? null : a < b);
  card(`Debt in ${P.planStart + 9}`, fmtD(sum.mine.d10), `President's budget: ${Math.round(sum.base.d10.pct)}%`, better(sum.mine.d10.pct, sum.base.d10.pct));
  card(`Debt in ${L}`, fmtD(sum.mine.d30), `President's budget: ${Math.round(sum.base.d30.pct)}%`, better(sum.mine.d30.pct, sum.base.d30.pct));
  const m = sum.mine;
  if (m.payoff) card("Debt paid off", String(m.payoff.year), m.payoff.extrapolated ? "extrapolated past 2056" : "", true);
  else if (m.firstSurplus) card("First surplus", String(m.firstSurplus), "but debt isn't paid off by 2150", true);
  else card("Budget balanced?", "Not yet", `Still a deficit in ${L}`, null);

  const more = $("#simple-more");
  more.textContent = "";
  const n = detailedCount();
  if (n) more.append(el("p", "small simple-detail", `Your plan also includes ${n} detailed change${n > 1 ? "s" : ""} made in Advanced mode, counted in these results.`));
}

// Changes that Simple mode can't show (made in Advanced mode).
export function detailedCount() {
  const simpleNodes = new Set(SPENDING.flatMap((L) => L.nodes));
  let n = 0;
  for (const id of model.settings.keys()) if (!simpleNodes.has(id)) n++;
  for (const id of model.rev.keys()) {
    if (!SIMPLE_REV.has(id)) n++;
    else if (id === "itax" && !readIncome(model.rev.get("itax"))) n++;
  }
  for (const id of model.prop.keys()) if (!PROPOSALS.includes(id)) n++;
  if (model.assumeChanged()) n++;
  if (model.phase) n++;
  return n;
}
