// Editable income tax bracket chart.
import { baseSchedule, decodeSchedule, encodeSchedule, marginal, taxAt, mapThreshold, liabilityChange, BASE_CODE } from "./taxcurve.js?v=dev";
import { fmt } from "./model.js?v=dev";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const usd = (v) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? "$" + +(a / 1e6).toFixed(a >= 1e7 ? 0 : 2) + "M" : a >= 1e3 ? "$" + +(a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K" : "$" + Math.round(a);
  return (v < 0 ? "−" : "") + s;
};
const usdFull = (v) => "$" + Math.round(v).toLocaleString("en-US");
const pct = (r) => +(r * 100).toFixed(2) + "%";

const XMIN = 5000, XMAX = 10e6;
const TICKS = [5e3, 1e4, 2.5e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7];
const MAX_POINTS = 14;

export function curveEditor(L, { get, set, scorePath, ctx }) {
  const root = el("div", "curve");
  const help = el("p", "small curve-help",
    "Drag a point up or down to change a bracket's rate, or sideways to move where it starts. Use the table for exact numbers. The chart shows single filers' taxable income on a log scale.");
  const chartBox = el("div", "curve-chart");
  const tip = el("div", "chart-tip"); tip.hidden = true;
  chartBox.append(tip);
  const legend = el("div", "legend-row");
  legend.innerHTML = '<span><i class="ln plan"></i>Your brackets</span><span><i class="ln base"></i>Current law</span><span><i class="ln avg"></i>Your average tax rate</span>';
  const bar = el("div", "curve-bar");
  const addBtn = el("button", "btn ghost small-btn", "+ Add bracket");
  const rmBtn = el("button", "btn ghost small-btn", "Remove selected");
  const resetBtn = el("button", "btn ghost small-btn", "Reset to current law");
  const effect = el("div", "curve-effect");
  bar.append(addBtn, rmBtn, resetBtn, effect);
  const table = el("table", "curve-table data-table");
  const tableWrap = el("div", "table-wrap"); tableWrap.append(table);
  const who = el("div", "curve-who table-wrap");
  root.append(help, legend, chartBox, bar, tableWrap, who);

  let sched = decodeSchedule(get()) || baseSchedule();
  let selected = -1;
  const base = baseSchedule();

  const commit = (live = false) => {
    sched.sort((a, b) => a.t - b.t);
    sched[0].t = 0;
    set(encodeSchedule(sched), live);
  };

  // ----- chart -----
  let geom;
  function draw() {
    chartBox.querySelector("svg")?.remove();
    const W = Math.max(300, chartBox.clientWidth || 700), H = W < 480 ? 260 : 300;
    const m = { t: 14, r: 14, b: 30, l: 44 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const maxR = Math.max(0.5, ...sched.map((p) => p.r + 0.08));
    const yMax = Math.ceil(maxR * 10) / 10;
    const lx = (v) => Math.log10(Math.max(XMIN, v));
    const x = (v) => m.l + ((lx(v) - lx(XMIN)) / (lx(XMAX) - lx(XMIN))) * iw;
    const xinv = (px) => Math.pow(10, lx(XMIN) + ((px - m.l) / iw) * (lx(XMAX) - lx(XMIN)));
    const y = (r) => m.t + ih - (r / yMax) * ih;
    const yinv = (py) => ((m.t + ih - py) / ih) * yMax;
    geom = { W, H, m, iw, ih, x, y, xinv, yinv, yMax };
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, role: "img", "aria-label": "Income tax brackets for single filers" });
    chartBox.prepend(svg);
    const g = svgEl("g", { class: "axis" }, svg);
    for (let r = 0; r <= yMax + 1e-9; r += yMax > 0.6 ? 0.2 : 0.1) {
      svgEl("line", { x1: m.l, x2: m.l + iw, y1: y(r), y2: y(r), class: r === 0 ? "zero" : "grid" }, g);
      svgEl("text", { x: m.l - 6, y: y(r) + 4, "text-anchor": "end" }, g).textContent = Math.round(r * 100) + "%";
    }
    for (const t of TICKS) {
      if (W < 480 && [2.5e4, 2.5e5, 2.5e6].includes(t)) continue;
      svgEl("text", { x: x(t), y: m.t + ih + 18, "text-anchor": "middle" }, g).textContent = usd(t);
    }
    const stepPath = (s) => {
      let d = "";
      s.forEach((p, k) => {
        const x0 = x(Math.max(p.t, XMIN)), x1 = x(k + 1 < s.length ? Math.min(s[k + 1].t, XMAX) : XMAX);
        if (k + 1 < s.length && s[k + 1].t <= XMIN) return;
        d += (d ? `L${x0},${y(p.r)}` : `M${x0},${y(p.r)}`) + `L${x1},${y(p.r)}`;
      });
      return d;
    };
    const avgPath = (s) => {
      let d = "";
      for (let i = 0; i <= 120; i++) {
        const v = Math.pow(10, lx(XMIN) + (i / 120) * (lx(XMAX) - lx(XMIN)));
        d += (i ? "L" : "M") + x(v).toFixed(1) + "," + y(taxAt(s, v) / v).toFixed(1);
      }
      return d;
    };
    svgEl("path", { d: stepPath(base), class: "curve-base" }, svg);
    svgEl("path", { d: avgPath(sched), class: "curve-avg" }, svg);
    svgEl("path", { d: stepPath(sched), class: "curve-line" }, svg);
    // handles
    sched.forEach((p, k) => {
      const hx = k === 0 ? x(XMIN) : x(p.t);
      if (p.t > XMAX) return;
      const h = svgEl("circle", { cx: hx, cy: y(p.r), r: 7, class: "curve-handle" + (k === selected ? " sel" : ""), tabindex: 0,
        role: "slider", "aria-label": `Bracket ${k + 1}: ${pct(p.r)} starting at ${usdFull(p.t)}` }, svg);
      h.addEventListener("pointerdown", (e) => startDrag(e, k));
      h.addEventListener("keydown", (e) => keyNudge(e, k));
      h.addEventListener("focus", () => { selected = k; syncButtons(); });
    });
    // hover readout
    const hit = svgEl("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", class: "curve-hit" }, svg);
    svg.insertBefore(hit, svg.querySelector(".curve-handle"));
    hit.addEventListener("pointermove", (e) => hover(e, svg));
    hit.addEventListener("pointerleave", () => (tip.hidden = true));
    hit.addEventListener("pointerdown", () => { selected = -1; draw(); syncButtons(); });
  }

  function hover(e, svg) {
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (geom.W / rect.width);
    const v = geom.xinv(px);
    const inc = v < 20000 ? Math.round(v / 100) * 100 : Math.round(v / 1000) * 1000;
    const t1 = taxAt(sched, inc), t0 = taxAt(base, inc);
    tip.textContent = "";
    tip.append(el("div", "tip-h", `Taxable income ${usdFull(inc)} (single)`));
    const row = (a, b) => { const r = el("div", "tip-row two"); r.append(el("span", "", a), el("b", "", b)); tip.append(r); };
    row("Your rate on the next dollar", pct(marginal(sched, inc)));
    row("Current law", pct(marginal(base, inc)));
    row("Your tax / average rate", `${usdFull(t1)} · ${pct(t1 / inc)}`);
    row("Change from current law", (t1 - t0 >= 0 ? "+" : "−") + usdFull(Math.abs(t1 - t0)));
    tip.hidden = false;
    const left = px > geom.W / 2 ? (px / geom.W) * rect.width - tip.offsetWidth - 12 : (px / geom.W) * rect.width + 12;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = "8px";
  }

  // Snap thresholds to tidy numbers and rates to half points.
  const snapT = (v) => { const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1); return Math.round(v / mag) * mag; };
  const snapR = (r) => Math.max(0, Math.min(0.99, Math.round(r * 200) / 200));

  function startDrag(e, k) {
    e.preventDefault();
    selected = k;
    const svg = chartBox.querySelector("svg");
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX, t0 = sched[k].t;
    const move = (ev) => {
      const px = (ev.clientX - rect.left) * (geom.W / rect.width);
      const py = (ev.clientY - rect.top) * (geom.H / rect.height);
      const p = sched[k];
      p.r = snapR(geom.yinv(py));
      // Only move the threshold once the pointer has clearly moved sideways.
      if (Math.abs(ev.clientX - sx) < 6) p.t = t0;
      else if (k > 0) {
        const lo = sched[k - 1].t * 1.02 + 100, hi = k + 1 < sched.length ? sched[k + 1].t / 1.02 - 100 : XMAX;
        p.t = Math.max(lo, Math.min(hi, snapT(geom.xinv(px))));
      }
      draw(); renderTable(); commit(true);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); commit(false); refreshAll(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    draw(); syncButtons();
  }

  function keyNudge(e, k) {
    const p = sched[k];
    let used = true;
    if (e.key === "ArrowUp") p.r = snapR(p.r + 0.005);
    else if (e.key === "ArrowDown") p.r = snapR(p.r - 0.005);
    else if (e.key === "ArrowRight" && k > 0) p.t = Math.min(k + 1 < sched.length ? sched[k + 1].t * 0.98 : XMAX, snapT(p.t * 1.05));
    else if (e.key === "ArrowLeft" && k > 0) p.t = Math.max(sched[k - 1].t * 1.02 + 100, snapT(p.t / 1.05));
    else used = false;
    if (used) { e.preventDefault(); commit(); refreshAll(); chartBox.querySelectorAll(".curve-handle")[k]?.focus(); }
  }

  // ----- buttons & table -----
  addBtn.addEventListener("click", () => {
    if (sched.length >= MAX_POINTS) return;
    // Split the widest bracket (on the log scale) at its midpoint, keeping its rate.
    let best = -1, bestW = -1;
    for (let k = 0; k < sched.length; k++) {
      const a = Math.max(sched[k].t, XMIN), b = k + 1 < sched.length ? sched[k + 1].t : XMAX * 0.5;
      const w = Math.log(b / a);
      if (w > bestW) { bestW = w; best = k; }
    }
    const a = Math.max(sched[best].t, XMIN), b = best + 1 < sched.length ? sched[best + 1].t : XMAX * 0.5;
    sched.splice(best + 1, 0, { t: snapT(Math.sqrt(a * b)), r: sched[best].r });
    selected = best + 1;
    commit(); refreshAll();
  });
  rmBtn.addEventListener("click", () => removePoint(selected));
  resetBtn.addEventListener("click", () => { sched = baseSchedule(); selected = -1; commit(); refreshAll(); });

  function removePoint(k) {
    if (k <= 0 || k >= sched.length) return;
    sched.splice(k, 1);
    selected = -1;
    commit(); refreshAll();
  }

  function syncButtons() {
    rmBtn.disabled = selected <= 0;
    addBtn.disabled = sched.length >= MAX_POINTS;
    resetBtn.disabled = encodeSchedule(sched) === BASE_CODE;
  }

  function renderTable() {
    table.textContent = "";
    const head = el("tr");
    for (const h of ["Rate", "Starts at (single)", "Married filing jointly", ""]) head.append(el("th", "", h));
    table.append(head);
    sched.forEach((p, k) => {
      const tr = el("tr");
      if (k === selected) tr.className = "sel";
      const rIn = el("input", "num"); rIn.type = "number"; rIn.step = 0.1; rIn.min = 0; rIn.max = 99; rIn.value = +(p.r * 100).toFixed(2);
      rIn.setAttribute("aria-label", `Rate for bracket ${k + 1}`);
      rIn.addEventListener("change", () => { p.r = Math.max(0, Math.min(0.99, Math.round((+rIn.value || 0) * 10) / 1000)); commit(); refreshAll(); });
      const tIn = el("input", "num wide"); tIn.type = "number"; tIn.step = 100; tIn.min = 0; tIn.value = Math.round(p.t);
      tIn.disabled = k === 0;
      tIn.setAttribute("aria-label", `Starting income for bracket ${k + 1}`);
      tIn.addEventListener("change", () => {
        let v = Math.max(1, +tIn.value || 0);
        const lo = sched[k - 1].t + 100, hi = k + 1 < sched.length ? sched[k + 1].t - 100 : 1e9;
        p.t = Math.max(lo, Math.min(hi, v));
        commit(); refreshAll();
      });
      const rm = el("button", "reset", "×"); rm.title = "Remove this bracket"; rm.disabled = k === 0;
      rm.addEventListener("click", () => removePoint(k));
      const td = (c) => { const d = el("td"); d.append(c); return d; };
      const rWrap = el("span", "numbox"); rWrap.append(rIn, el("span", "", "%"));
      const tWrap = el("span", "numbox"); tWrap.append(el("span", "", "$"), tIn);
      tr.append(td(rWrap), td(tWrap), el("td", "muted", k === 0 ? "$0" : usdFull(mapThreshold(p.t, "joint"))), td(rm));
      tr.addEventListener("click", (e) => { if (e.target.tagName !== "INPUT" && e.target.tagName !== "BUTTON") { selected = k; refreshAll(); } });
      table.append(tr);
    });
  }

  // How the change is spread across income groups (approximate).
  function renderWho() {
    who.textContent = "";
    if (encodeSchedule(sched) === BASE_CODE) return;
    const tc = L.tc, dist = L.dist;
    const total = liabilityChange(dist, sched).delta;
    const groups = tc.agiGroups.map((g) => {
      const avg = g.tiReturns ? g.ti / g.tiReturns : 0;
      // Representative return in the group: average of single and joint filers at the group's average taxable income.
      const per = ["single", "joint"].map((st) => {
        const s2023 = (s) => s.map((p) => ({ t: to2023(mapThreshold(p.t, st), st, tc), r: p.r }));
        return taxAt(s2023(sched), avg) - taxAt(s2023(baseSchedule()), avg);
      });
      return { ...g, raw: g.tiReturns * (per[0] + per[1]) / 2 };
    });
    const rawSum = groups.reduce((s, g) => s + g.raw, 0) || 1;
    const t = el("table", "data-table who-table");
    const head = el("tr");
    for (const h of ["Income (AGI)", "Returns", "Avg. change per return", "Share of the change"]) head.append(el("th", "", h));
    t.append(head);
    const scale = total / rawSum;
    for (const g of groups) {
      const amt = g.raw * scale;
      const tr = el("tr");
      tr.append(el("th", "", g.label), el("td", "", (g.returns / 1e6).toFixed(1) + "M"),
        Math.abs(amt / g.returns) < 0.5 ? el("td", "muted", "no change")
          : el("td", amt >= 0 ? "add" : "cut", (amt >= 0 ? "+" : "−") + usdFull(Math.abs(amt / g.returns))),
        el("td", "", Math.abs(amt / total) < 0.005 ? "—" : Math.round((amt / total) * 100) + "%"));
      t.append(tr);
    }
    who.append(el("h4", "", "Who pays (approximate, 2023 incomes)"), t,
      el("p", "small", "Tax change per return in 2023 dollars, before behavioral responses, using each group's average taxable income. Positive = pays more."));
  }

  function renderEffect() {
    const path = scorePath();
    const i = ctx.Y.indexOf(ctx.start);
    const fy = path[i] || 0;
    const ten = path.reduce((s, v, k) => s + (ctx.Y[k] >= ctx.start && ctx.Y[k] < ctx.start + 10 ? v : 0), 0);
    effect.textContent = "";
    if (encodeSchedule(sched) === BASE_CODE) { effect.append(el("span", "e1 none", "no change")); return; }
    effect.append(el("span", "e1 " + (fy >= 0 ? "cut" : "add"), `${fmt(fy * 1000, { sign: true })} in ${ctx.start}`),
      el("span", "e2 " + (ten >= 0 ? "cut" : "add"), `${fmt(ten * 1000, { sign: true })} over 10 years`));
  }

  function refreshAll() { draw(); renderTable(); syncButtons(); renderWho(); renderEffect(); }

  // External refresh (e.g., Start over, share link, phase-in change)
  root.update = () => {
    const code = get();
    if (code !== encodeSchedule(sched)) { sched = decodeSchedule(code) || baseSchedule(); selected = -1; refreshAll(); }
    else renderEffect();
  };
  let w = 0;
  new ResizeObserver(() => { const nw = chartBox.clientWidth; if (nw && Math.abs(nw - w) > 10) { w = nw; draw(); } }).observe(chartBox);
  requestAnimationFrame(refreshAll);
  return root;
}

// 2026 -> 2023 threshold mapping for the "who pays" table (mirrors taxcurve.js).
import { THRESH_2026 } from "./taxcurve.js?v=dev";
function to2023(t, st, tc) {
  const A = THRESH_2026[st], Z = tc.thresholds[st];
  for (let k = 1; k < A.length; k++) if (t <= A[k]) return Z[k - 1] + ((t - A[k - 1]) / (A[k] - A[k - 1])) * (Z[k] - Z[k - 1]);
  return t * (Z[Z.length - 1] / A[A.length - 1]);
}
