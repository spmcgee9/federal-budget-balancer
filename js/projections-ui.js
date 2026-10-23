import { project, summarize } from "./projection.js";
import { lineChart, stackChart } from "./charts.js";
import { fmt } from "./model.js";

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const MIX = [
  ["ss", "Social Security", "--mix-1"],
  ["medicare", "Medicare", "--mix-2"],
  ["health", "Medicaid & other health", "--mix-3"],
  ["othm", "Other mandatory", "--mix-4"],
  ["disc", "Discretionary", "--mix-5"],
  ["netint", "Net interest", "--mix-6"],
];

let P, model, state = { units: "usd", h: 30 }, last;

export function initProjections(projData, budgetModel) {
  P = projData;
  P.planStart = budgetModel.fy;
  model = budgetModel;
  try { Object.assign(state, JSON.parse(localStorage.getItem("proj-view") || "{}")); } catch {}
  for (const b of document.querySelectorAll("#proj-units button")) {
    b.addEventListener("click", () => { state.units = b.dataset.units; save(); render(); });
  }
  for (const b of document.querySelectorAll("#proj-horizon button")) {
    b.addEventListener("click", () => { state.h = +b.dataset.h; save(); render(); });
  }
  const src = $("#proj-sources");
  src.textContent = "Sources: ";
  P.meta.sources.forEach((s, i) => {
    const a = el("a", "", s.name); a.href = s.url; a.target = "_blank"; a.rel = "noopener";
    src.append(a, document.createTextNode(i < P.meta.sources.length - 1 ? "; " : "."));
  });
  let w = 0;
  new ResizeObserver(() => {
    const nw = $("[data-panel=projections]").clientWidth;
    if (nw && Math.abs(nw - w) > 20) { w = nw; if (!$("[data-panel=projections]").hidden) render(); }
  }).observe($("[data-panel=projections]"));
}

function save() { try { localStorage.setItem("proj-view", JSON.stringify(state)); } catch {} }

// Convert billions of nominal dollars in year index i to the chosen units.
function conv(v, i) {
  if (state.units === "gdp") return (v / P.gdp[i]) * 100;
  if (state.units === "real") return v / P.deflator[i];
  return v;
}
const money = (b) => fmt(b * 1000);
function fmtU(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (state.units === "gdp") return (Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)) + "%";
  return money(v);
}
function fmtTick(v) {
  if (state.units === "gdp") return v + "%";
  const a = Math.abs(v);
  const s = a === 0 ? "$0" : a >= 1000 ? "$" + +(a / 1000).toFixed(1) + "T" : "$" + Math.round(a) + "B";
  return (v < 0 ? "−" : "") + s;
}

export function render() {
  if (!P || !model) return;
  document.querySelectorAll("#proj-units button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.units === state.units));
  document.querySelectorAll("#proj-horizon button").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.h === state.h));

  const res = project(P, { deltas: model.yearDeltas() });
  const sum = summarize(P, res);
  last = { res, sum };
  const Y = res.years;
  const i0 = Y.indexOf(P.planStart) - 1; // show the last actual-ish year (2026) as the starting point
  const iz = Math.min(Y.length - 1, Y.indexOf(P.planStart) + state.h - 1);
  const yrs = Y.slice(i0, iz + 1);
  const cut = (arr) => arr.slice(i0, iz + 1).map((v, k) => conv(v, i0 + k));

  headline(res, sum);
  kpis(res, sum);

  const planC = css("--plan"), baseC = css("--base-line");
  const unitWord = state.units === "gdp" ? "percent of GDP" : state.units === "real" ? "FY2026 dollars" : "dollars";
  const refs = state.units === "gdp" ? [{ value: 106, label: "Post-WWII record (106%, 1946)" }] : [];
  lineChart($("#ch-debt"), {
    years: yrs, fmt: fmtU, fmtTick, refs, zeroBase: true, label: `Debt held by the public, ${unitWord}`,
    series: [
      { name: "President's budget", short: "President", values: cut(res.base.debt), color: baseC, dash: true },
      { name: "Your plan", short: "Your plan", values: cut(res.mine.debt), color: planC, width: 2.5 },
    ],
  });
  const inC = css("--in"), outC = css("--out");
  lineChart($("#ch-def"), {
    years: yrs, fmt: (v) => (v >= 0 ? "Surplus " : "Deficit ") + fmtU(Math.abs(v)), fmtTick,
    label: `Annual deficit or surplus, ${unitWord}`,
    series: [
      { name: "Your plan", values: cut(res.mine.deficit), type: "bar", color: outC, barColor: (v) => (v >= 0 ? inC : outC) },
      { name: "President's budget", short: "President", values: cut(res.base.deficit), color: baseC, dash: true },
    ],
  });
  lineChart($("#ch-int"), {
    years: yrs, fmt: fmtU, fmtTick, zeroBase: true, label: `Net interest, ${unitWord}`,
    series: [
      { name: "President's budget", short: "President", values: cut(res.base.netint), color: baseC, dash: true },
      { name: "Your plan", short: "Your plan", values: cut(res.mine.netint), color: planC, width: 2.5 },
    ],
  });
  const leg = $("#mix-legend");
  leg.textContent = "";
  for (const [, name, v] of MIX) { const s = el("span"); const sw = el("i", "sq"); sw.style.background = css(v); s.append(sw, name); leg.append(s); }
  const rl = el("span"); rl.append(el("i", "ln rev"), "Revenue"); leg.append(rl);
  stackChart($("#ch-mix"), {
    years: yrs, fmt: fmtU, fmtTick, label: `Spending by category under your plan, ${unitWord}`,
    layers: MIX.map(([k, name, v]) => ({ name, short: name.replace(" & other health", "+"), values: cut(res.mine.mix[k]), color: css(v) })),
    line: { name: "Revenue", values: cut(res.mine.rev), color: css("--ink") },
  });
  demoChart();
  table(res);
}

function headline(res, sum) {
  const b = sum.base, m = sum.mine;
  const Y = res.years, L = Y[Y.length - 1];
  const changed = res.userSpend.some((v) => Math.abs(v) > 0.05);
  const today = (P.base.debt[Y.indexOf(P.planStart) - 1] / P.gdp[Y.indexOf(P.planStart) - 1]) * 100;
  const box = $("#proj-headline");
  box.textContent = "";
  const add = (t, cls) => { const s = el(cls ? "strong" : "span", cls || "", t); box.append(s); };
  if (!changed) {
    add(`Under the President's budget, as estimated by CBO, debt held by the public grows from ${Math.round(today)}% of GDP today to `);
    add(`${Math.round(b.d30.pct)}% in ${L}`, "add");
    add(`, and interest reaches ${money(b.intLast)} a year. Make changes on the Spending tab to see how your plan compares.`);
    return;
  }
  const cut10 = b.cum10 - m.cum10;
  if (cut10 >= 0) { add("Your plan cuts deficits by "); add(money(cut10), "cut"); add(" over the next 10 years. "); }
  else { add("Your plan adds "); add(money(-cut10), "add"); add(" to deficits over the next 10 years. "); }
  if (m.d30.debt <= 0) {
    add(`By ${L} the debt is gone and the government holds net assets worth ${Math.round(-m.d30.pct)}% of GDP, instead of debt of ${Math.round(b.d30.pct)}%`);
  } else {
    add(`In ${L}, debt is `);
    add(`${Math.round(m.d30.pct)}% of GDP`, m.d30.pct <= b.d30.pct ? "cut" : "add");
    add(` instead of ${Math.round(b.d30.pct)}%`);
  }
  const di = b.intLast - m.intLast;
  if (m.intLast < 0) add(`, and the government earns ${money(-m.intLast)} a year in interest instead of paying ${money(b.intLast)}`);
  else if (Math.abs(di) > 1) add(`, and that year's interest bill is ${money(Math.abs(di))} ${di > 0 ? "lower" : "higher"}`);
  add(". ");
  if (m.payoff) add(`The debt would be fully paid off in ${m.payoff.year}${m.payoff.extrapolated ? " (extrapolated past CBO's horizon)" : ""}.`, "cut");
  else if (m.firstSurplus) add(`You reach a surplus in ${m.firstSurplus}, but the debt isn't paid off by 2150.`);
}

function kpis(res, sum) {
  const box = $("#kpis");
  box.textContent = "";
  const b = sum.base, m = sum.mine;
  const Y = res.years;
  const show = (o) => state.units === "gdp" ? o.pct : state.units === "real" ? o.debt / P.deflator[Y.indexOf(o.y)] : o.debt;
  const card = (label, mine, base, better, sub) => {
    const c = el("div", "kpi");
    c.append(el("span", "label", label), el("span", "val " + (better == null ? "" : better ? "cut" : "add"), mine));
    c.append(el("span", "sub", sub ?? `President's budget: ${base}`));
    box.append(c);
  };
  const s = P.planStart;
  for (const [k, yr] of [["d10", s + 9], ["d20", s + 19], ["d30", Y[Y.length - 1]]]) {
    if (yr > s + state.h - 1 && k !== "d10") continue;
    const mm = { ...m[k], y: yr }, bb = { ...b[k], y: yr };
    const same = Math.abs(mm.debt - bb.debt) < 1;
    if (mm.debt <= 0) {
      card(`Debt in ${yr}`, "Paid off", null, true,
        `government holds ${fmtU(Math.abs(show(mm)))} in net assets · President's budget: ${fmtU(show(bb))} debt`);
      continue;
    }
    card(`Debt in ${yr}`, fmtU(show(mm)), fmtU(show(bb)), same ? null : mm.debt < bb.debt,
      same ? `${Math.round(mm.pct)}% of GDP · same as the President's budget` : `President's budget: ${fmtU(show(bb))}`);
  }
  const same10 = Math.abs(m.cum10 - b.cum10) < 1;
  if (m.cum10 >= 0) card(`Total deficits, ${s}–${s + 9}`, money(m.cum10), money(b.cum10), same10 ? null : m.cum10 < b.cum10);
  else card(`Total surpluses, ${s}–${s + 9}`, money(-m.cum10), null, true, `President's budget: ${money(b.cum10)} in deficits`);
  const p = m.payoff;
  if (p) card("Debt paid off", String(p.year), null, true, p.extrapolated ? "extrapolated past 2056" : "within CBO's 30-year horizon");
  else if (m.firstSurplus) card("First surplus", String(m.firstSurplus), null, true, "debt not paid off by 2150");
  else card("Debt peaks", m.peak.year === Y[Y.length - 1] ? "Still rising" : String(m.peak.year), null, null,
    m.peak.year === Y[Y.length - 1] ? `${Math.round(m.peak.pct)}% of GDP in ${m.peak.year} and climbing` : `at ${Math.round(m.peak.pct)}% of GDP`);
}

function demoChart() {
  const d = P.demo;
  const idx = d.years.map((y, i) => [y, i]).filter(([y]) => y >= 1990);
  const ratio = idx.map(([, i]) => (d.v[i][3] / (d.v[i][1] + d.v[i][2])) * 100);
  lineChart($("#ch-demo"), {
    years: idx.map(([y]) => y), height: 220, zeroBase: true, label: "People 65+ per 100 people aged 25 to 64",
    fmt: (v) => v.toFixed(1) + " per 100", fmtTick: (v) => String(v),
    series: [{ name: "65+ per 100 aged 25–64", short: "65+ per 100", values: ratio, color: css("--plan"), width: 2.5 }],
  });
}

function table(res) {
  const wrap = $("#proj-table");
  wrap.textContent = "";
  const t = el("table", "data-table");
  const head = el("tr");
  for (const h of ["FY", "Revenue", "Spending", "Interest", "Deficit (−) / surplus", "Debt", "Debt, % GDP", "President's budget: debt, % GDP"]) head.append(el("th", "", h));
  t.append(head);
  const Y = res.years;
  for (let i = Y.indexOf(P.planStart); i < Y.length; i++) {
    const r = el("tr");
    const m = res.mine;
    const cells = [String(Y[i]), money(m.rev[i]), money(m.out[i]), money(m.netint[i]), money(m.deficit[i]), money(m.debt[i]),
      ((m.debt[i] / P.gdp[i]) * 100).toFixed(1) + "%", ((res.base.debt[i] / P.gdp[i]) * 100).toFixed(1) + "%"];
    cells.forEach((c, k) => r.append(el(k ? "td" : "th", "", c)));
    t.append(r);
  }
  wrap.append(t);
  wrap.append(el("p", "small", "Dollar amounts are nominal. Revenue and spending are for your plan."));
}
