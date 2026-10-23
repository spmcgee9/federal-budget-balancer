// Small dependency-free SVG charts: line/bar charts with a hover crosshair, and a stacked area chart.
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
};

// Text width in px for an 11px chart label (canvas measurement; no layout needed).
let ctx2d;
function textWidth(str, weight = 500, size = 11) {
  ctx2d = ctx2d || document.createElement("canvas").getContext("2d");
  const fam = getComputedStyle(document.body).fontFamily || "sans-serif";
  ctx2d.font = `${weight} ${size}px ${fam}`;
  return ctx2d.measureText(str).width;
}

// Spread labels vertically so none are closer than `gap`, staying within [lo, hi]
// and as close as possible to where each wants to be.
function spread(items, lo, hi, gap) {
  const a = items.slice().sort((p, q) => p.want - q.want);
  a.forEach((it, k) => (it.y = Math.max(it.want, k ? a[k - 1].y + gap : lo)));
  for (let k = a.length - 1; k >= 0; k--) a[k].y = Math.min(a[k].y, k < a.length - 1 ? a[k + 1].y - gap : hi);
  for (let k = 0; k < a.length; k++) a[k].y = Math.max(a[k].y, k ? a[k - 1].y + gap : lo);
  return items;
}

// Right-hand labels: a short leader from the line end to "Name  value".
function endLabels(f, items) {
  const { svg, m, iw, ih } = f;
  spread(items, m.t + 6, m.t + ih, 14);
  const g = svgEl("g", { class: "end-labels" }, svg);
  const x0 = m.l + iw;
  for (const it of items) {
    if (it.leader !== false) {
      svgEl("path", { d: `M${x0 + 2},${it.want.toFixed(1)}L${x0 + 6},${it.want.toFixed(1)}L${x0 + 10},${it.y.toFixed(1)}`,
        class: "leader", stroke: it.color }, g);
    }
    const t = svgEl("text", { x: x0 + 13, y: (it.y + 4).toFixed(1), class: "end-label" }, g);
    const n = svgEl("tspan", {}, t); n.textContent = it.text;
    if (it.value) { const v = svgEl("tspan", { class: "end-val", dx: 5 }, t); v.textContent = it.value; }
  }
}
const endWidth = (items) => Math.max(0, ...items.map((it) => textWidth(it.text) + (it.value ? 5 + textWidth(it.value, 600) : 0)));

function niceTicks(lo, hi, count = 5) {
  if (hi === lo) { hi = lo + 1; }
  const span = hi - lo;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  // Keep adding ticks until the top tick covers the data.
  for (let v = start; ticks.length < 2 || ticks[ticks.length - 1] < hi - step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function frame(container, height, rightLabelWidth = 0) {
  container.textContent = "";
  container.classList.add("chart");
  const W = Math.max(280, container.clientWidth || 600);
  const H = height;
  const narrow = W < 480;
  // Room on the right for the end labels (measured), plus half a year label so the last tick isn't cut off.
  const m = { t: 12, r: narrow || !rightLabelWidth ? 16 : Math.min(200, Math.ceil(rightLabelWidth) + 18), b: 26, l: narrow ? 46 : 58 };
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, role: "img" }, container);
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  container.append(tip);
  return { svg, tip, W, H, m, iw: W - m.l - m.r, ih: H - m.t - m.b, narrow };
}

function axes(f, years, y, ticks, fmtTick, band = false) {
  const { svg, m, iw, ih } = f;
  const g = svgEl("g", { class: "axis" }, svg);
  for (const t of ticks) {
    const yy = y(t);
    svgEl("line", { x1: m.l, x2: m.l + iw, y1: yy, y2: yy, class: t === 0 ? "zero" : "grid" }, g);
    const lab = svgEl("text", { x: m.l - 6, y: yy + 4, "text-anchor": "end" }, g);
    lab.textContent = fmtTick(t);
  }
  // Label every 1, 2, 5, 10... years so that labels stay ~48px+ apart.
  const maxLabels = Math.max(3, Math.floor(iw / 48));
  const step = [1, 2, 5, 10, 20].find((s) => years.length / s <= maxLabels) || 25;
  // With bars, each year gets a band and the bar sits in its middle, so the first and last bars stay inside the plot.
  const n = years.length;
  const x = band ? (i) => m.l + ((i + 0.5) / n) * iw : (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  x.inv = band ? (px) => Math.floor(((px - m.l) / iw) * n) : (px) => Math.round(((px - m.l) / iw) * (n - 1));
  years.forEach((yr, i) => {
    const onStep = yr % step === 0;
    // The first year gets a label only if the next labeled year isn't too close.
    if (!onStep && !(i === 0 && (step - (yr % step)) >= step / 2)) return;
    const t = svgEl("text", { x: x(i), y: m.t + ih + 18, "text-anchor": "middle" }, g);
    t.textContent = yr;
  });
  return x;
}

// Hover layer: vertical crosshair + tooltip listing every series at that year.
function hover(f, years, x, rows) {
  const { svg, tip, m, iw, ih } = f;
  const cross = svgEl("line", { y1: m.t, y2: m.t + ih, class: "cross" }, svg);
  cross.style.display = "none";
  const dots = rows.map((r) => {
    const c = svgEl("circle", { r: 4, class: "hover-dot", fill: r.color }, svg);
    c.style.display = "none";
    return c;
  });
  const hit = svgEl("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
  const show = (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (f.W / rect.width);
    const i = Math.max(0, Math.min(years.length - 1, x.inv(sx)));
    const xx = x(i);
    cross.setAttribute("x1", xx); cross.setAttribute("x2", xx); cross.style.display = "";
    rows.forEach((r, k) => {
      const v = r.values[i];
      if (r.noDot || v == null) { dots[k].style.display = "none"; return; }
      dots[k].setAttribute("cx", xx); dots[k].setAttribute("cy", r.y(v)); dots[k].style.display = "";
    });
    tip.textContent = "";
    const h = document.createElement("div"); h.className = "tip-h"; h.textContent = "FY" + years[i]; tip.append(h);
    for (const r of rows) {
      const line = document.createElement("div"); line.className = "tip-row";
      const sw = document.createElement("i"); sw.style.background = r.color; if (r.dash) sw.className = "dash";
      const nm = document.createElement("span"); nm.textContent = r.name;
      const val = document.createElement("b"); val.textContent = r.fmt(r.values[i]);
      line.append(sw, nm, val); tip.append(line);
    }
    tip.hidden = false;
    const px = (xx / f.W) * rect.width;
    const left = px > rect.width / 2 ? px - tip.offsetWidth - 12 : px + 12;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = "8px";
  };
  const hide = () => { cross.style.display = "none"; dots.forEach((d) => (d.style.display = "none")); tip.hidden = true; };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", hide);
}

/**
 * series: [{name, values, color, dash?, type?: "line"|"bar", barColor?: (v)=>color}]
 * refs: [{value, label}] horizontal reference lines
 */
export function lineChart(container, { years, series, fmt, fmtTick = fmt, fmtEnd = fmt, height = 260, refs = [], zeroBase = false, label }) {
  const hasBar = series.some((s) => s.type === "bar");
  const lastOf = (s) => { for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) return s.values[i]; return null; };
  let ends = series.filter((s) => lastOf(s) != null).map((s) => ({ s, text: s.short || s.name, value: (s.fmtEnd || fmtEnd)(lastOf(s)), color: s.color }));
  // Lines that end at the same value share one label ("Your plan = President  171%").
  const lines = ends.filter((e) => e.s.type !== "bar");
  if (lines.length > 1 && lines.every((e) => e.value === lines[0].value)) {
    const order = lines.slice().sort((a, b) => (b.s.width || 2) - (a.s.width || 2));
    ends = [...ends.filter((e) => e.s.type === "bar"), { ...order[0], text: order.map((e) => e.text).join(" = ") }];
  }
  const narrowGuess = (container.clientWidth || 600) < 480;
  const f = frame(container, height, narrowGuess ? 0 : endWidth(ends));
  if (label) f.svg.setAttribute("aria-label", label);
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const r of refs) { lo = Math.min(lo, r.value); hi = Math.max(hi, r.value); }
  if (zeroBase || hasBar) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = (hi - lo) * 0.06 || 1;
  const ticks = niceTicks(lo - (lo < 0 ? pad : 0), hi + pad);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const y = (v) => f.m.t + f.ih - ((v - y0) / (y1 - y0)) * f.ih;
  const x = axes(f, years, y, ticks, fmtTick, hasBar);

  const rows = [];
  // Bars first so lines draw over them.
  for (const s of series.filter((s) => s.type === "bar")) {
    const bw = Math.max(2, (f.iw / years.length) * 0.78);
    s.values.forEach((v, i) => {
      if (v == null) return;
      const top = y(Math.max(0, v)), bot = y(Math.min(0, v));
      svgEl("rect", { x: x(i) - bw / 2, y: top, width: bw, height: Math.max(1, bot - top), rx: Math.min(3, bw / 3),
        fill: s.barColor ? s.barColor(v) : s.color, class: "bar" }, f.svg);
    });
    rows.push({ ...s, y, fmt, noDot: true });
  }
  for (const s of series.filter((s) => s.type !== "bar")) {
    let d = "";
    s.values.forEach((v, i) => { if (v != null) d += (d ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); });
    svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-dasharray": s.dash ? "5 4" : "none",
      "stroke-linejoin": "round", "stroke-linecap": "round" }, f.svg);
    rows.push({ ...s, y, fmt });
  }

  // Reference lines go on top of the data, with the label in whichever corner is clearest of the lines.
  for (const r of refs) refLine(f, r, y, x, series);

  if (!f.narrow) {
    endLabels(f, ends.map((e) => {
      const v = lastOf(e.s);
      // A bar's label points at the bar's end; a line's at its last point.
      return { ...e, want: y(v) + (e.s.type === "bar" ? (v < 0 ? -2 : 2) : 0) };
    }));
  }
  hover(f, years, x, rows);
}

function refLine(f, r, y, x, series) {
  const { svg, m, iw } = f;
  const yy = y(r.value);
  svgEl("line", { x1: m.l, x2: m.l + iw, y1: yy, y2: yy, class: "ref" }, svg);
  const w = textWidth(r.label, 400) + 4, h = 12;
  const n = series[0]?.values.length || 1;
  const xi = (px) => Math.max(0, Math.min(n - 1, x.inv(px)));
  // Clearance between a candidate label box and the plotted values beneath it, in pixels.
  const clearance = (x0, top) => {
    let best = Infinity;
    for (let i = xi(x0 - 4); i <= xi(x0 + w + 4); i++) {
      for (const s of series) {
        const v = s.values[i];
        if (v == null) continue;
        const py = s.type === "bar" ? [y(Math.max(0, v)), y(Math.min(0, v))] : [y(v), y(v)];
        const d = py[1] < top ? top - py[1] : py[0] > top + h ? py[0] - top - h : 0;
        best = Math.min(best, d);
      }
    }
    return best;
  };
  const cands = [
    { x0: m.l + 4, top: yy - h - 3 }, { x0: m.l + 4, top: yy + 3 },
    { x0: m.l + iw - w - 4, top: yy - h - 3 }, { x0: m.l + iw - w - 4, top: yy + 3 },
    { x0: m.l + iw / 2 - w / 2, top: yy - h - 3 }, { x0: m.l + iw / 2 - w / 2, top: yy + 3 },
  ].filter((c) => c.top >= m.t - 2 && c.top + h <= m.t + f.ih);
  let pick = cands[0] || { x0: m.l + 4, top: yy - h - 3 }, bestC = -1;
  for (const c of cands) { const cl = Math.min(clearance(c.x0, c.top), 30); if (cl > bestC + 0.5) { bestC = cl; pick = c; } }
  const t = svgEl("text", { x: pick.x0 + 2, y: pick.top + h - 2, class: "ref-label halo" }, svg);
  t.textContent = r.label;
}

/** layers: [{name, values, color}] stacked bottom-up; line: {name, values, color} drawn on top. */
export function stackChart(container, { years, layers, line, fmt, fmtTick = fmt, height = 280, label }) {
  const names = [...layers.map((l) => l.short || l.name), ...(line ? [line.short || line.name] : [])];
  const narrowGuess = (container.clientWidth || 600) < 480;
  const f = frame(container, height, narrowGuess ? 0 : Math.max(...names.map((n) => textWidth(n))));
  if (label) f.svg.setAttribute("aria-label", label);
  const tot = years.map((_, i) => layers.reduce((s, l) => s + Math.max(0, l.values[i]), 0));
  const hi = Math.max(...tot, ...(line ? line.values : [0]));
  const ticks = niceTicks(0, hi * 1.05);
  const y1 = ticks[ticks.length - 1];
  const y = (v) => f.m.t + f.ih - (v / y1) * f.ih;
  const x = axes(f, years, y, ticks, fmtTick);
  const acc = years.map(() => 0);
  const rows = [];
  const labels = [];
  const last = years.length - 1;
  for (const l of layers) {
    const lower = acc.slice();
    years.forEach((_, i) => (acc[i] += Math.max(0, l.values[i])));
    let d = "";
    years.forEach((_, i) => (d += (i ? "L" : "M") + x(i).toFixed(1) + "," + y(acc[i]).toFixed(1)));
    for (let i = years.length - 1; i >= 0; i--) d += "L" + x(i).toFixed(1) + "," + y(lower[i]).toFixed(1);
    svgEl("path", { d: d + "Z", fill: l.color, class: "area" }, f.svg);
    rows.unshift({ ...l, y: () => 0, fmt, noDot: true });
    if (y(lower[last]) - y(acc[last]) > 0.5) labels.push({ text: l.short || l.name, want: y((acc[last] + lower[last]) / 2), color: l.color });
  }
  if (line) {
    let d = "";
    line.values.forEach((v, i) => (d += (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1)));
    svgEl("path", { d, fill: "none", stroke: line.color, "stroke-width": 2.5, "stroke-dasharray": "6 4" }, f.svg);
    rows.unshift({ ...line, y, fmt, dash: true });
    labels.push({ text: line.short || line.name, want: y(line.values[last]), color: line.color, line: true });
  }
  if (!f.narrow) endLabels(f, labels);
  rows.push({ name: "Total spending", values: tot, color: "transparent", y, fmt, noDot: true });
  hover(f, years, x, rows);
}
