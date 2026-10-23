// Small dependency-free SVG charts: line/bar charts with a hover crosshair, and a stacked area chart.
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
};

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

function frame(container, height) {
  container.textContent = "";
  container.classList.add("chart");
  const W = Math.max(280, container.clientWidth || 600);
  const H = height;
  const m = { t: 12, r: W < 480 ? 12 : 92, b: 26, l: W < 480 ? 46 : 58 };
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, role: "img" }, container);
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  container.append(tip);
  return { svg, tip, W, H, m, iw: W - m.l - m.r, ih: H - m.t - m.b, narrow: W < 480 };
}

function axes(f, years, y, ticks, fmtTick) {
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
  const x = (i) => m.l + (years.length === 1 ? iw / 2 : (i / (years.length - 1)) * iw);
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
    const i = Math.max(0, Math.min(years.length - 1, Math.round(((sx - m.l) / iw) * (years.length - 1))));
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
export function lineChart(container, { years, series, fmt, fmtTick = fmt, height = 260, refs = [], zeroBase = false, label }) {
  const f = frame(container, height);
  if (label) f.svg.setAttribute("aria-label", label);
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const r of refs) { lo = Math.min(lo, r.value); hi = Math.max(hi, r.value); }
  if (zeroBase || series.some((s) => s.type === "bar")) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = (hi - lo) * 0.06 || 1;
  const ticks = niceTicks(lo - (lo < 0 ? pad : 0), hi + pad);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const y = (v) => f.m.t + f.ih - ((v - y0) / (y1 - y0)) * f.ih;
  const x = axes(f, years, y, ticks, fmtTick);

  for (const r of refs) {
    const yy = y(r.value);
    svgEl("line", { x1: f.m.l, x2: f.m.l + f.iw, y1: yy, y2: yy, class: "ref" }, f.svg);
    const t = svgEl("text", { x: f.m.l + 4, y: yy - 4, class: "ref-label" }, f.svg);
    t.textContent = r.label;
  }

  const rows = [];
  // Bars first so lines draw over them.
  for (const s of series.filter((s) => s.type === "bar")) {
    const bw = Math.max(2, (f.iw / years.length) - 2);
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
  // Direct labels at the right end (wide screens); the legend above covers narrow ones.
  if (!f.narrow) {
    const placed = [];
    for (const s of series) {
      const v = s.values[s.values.length - 1];
      if (v == null) continue;
      let yy = y(v) + 4;
      for (const p of placed) if (Math.abs(p - yy) < 14) yy = p + (yy >= p ? 14 : -14);
      placed.push(yy);
      const t = svgEl("text", { x: f.m.l + f.iw + 6, y: yy, class: "end-label" }, f.svg);
      t.textContent = s.short || s.name;
    }
  }
  hover(f, years, x, rows);
}

/** layers: [{name, values, color}] stacked bottom-up; line: {name, values, color} drawn on top. */
export function stackChart(container, { years, layers, line, fmt, fmtTick = fmt, height = 280, label }) {
  const f = frame(container, height);
  if (label) f.svg.setAttribute("aria-label", label);
  const tot = years.map((_, i) => layers.reduce((s, l) => s + Math.max(0, l.values[i]), 0));
  const hi = Math.max(...tot, ...(line ? line.values : [0]));
  const ticks = niceTicks(0, hi * 1.05);
  const y1 = ticks[ticks.length - 1];
  const y = (v) => f.m.t + f.ih - (v / y1) * f.ih;
  const x = axes(f, years, y, ticks, fmtTick);
  const acc = years.map(() => 0);
  const rows = [];
  for (const l of layers) {
    const lower = acc.slice();
    years.forEach((_, i) => (acc[i] += Math.max(0, l.values[i])));
    let d = "";
    years.forEach((_, i) => (d += (i ? "L" : "M") + x(i).toFixed(1) + "," + y(acc[i]).toFixed(1)));
    for (let i = years.length - 1; i >= 0; i--) d += "L" + x(i).toFixed(1) + "," + y(lower[i]).toFixed(1);
    svgEl("path", { d: d + "Z", fill: l.color, class: "area" }, f.svg);
    rows.unshift({ ...l, y: () => 0, fmt, noDot: true });
    if (!f.narrow) {
      const i = years.length - 1;
      const mid = (acc[i] + lower[i]) / 2;
      if (y(lower[i]) - y(acc[i]) > 11) {
        const t = svgEl("text", { x: f.m.l + f.iw + 6, y: y(mid) + 4, class: "end-label" }, f.svg);
        t.textContent = l.short || l.name;
      }
    }
  }
  if (line) {
    let d = "";
    line.values.forEach((v, i) => (d += (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1)));
    svgEl("path", { d, fill: "none", stroke: line.color, "stroke-width": 2.5, "stroke-dasharray": "6 4" }, f.svg);
    rows.unshift({ ...line, y, fmt, dash: true });
  }
  rows.push({ name: "Total spending", values: tot, color: "transparent", y, fmt, noDot: true });
  hover(f, years, x, rows);
}
