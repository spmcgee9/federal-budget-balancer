// Income tax curve: brackets you can edit, and the revenue they raise.
//
// How revenue is computed
//  - IRS data (tax year 2023) give, for each filing status and each current bracket, how much taxable
//    income was taxed at that rate and how many returns had that as their top rate. From that we build
//    n(x): the number of returns with taxable income above x, using a power-law (Pareto) shape within
//    each bracket that reproduces the IRS amounts exactly.
//  - Tax under any schedule = the integral over x of marginal rate m(x) times n(x).
//  - Behavior: income at each level shrinks or grows with the after-tax share of an extra dollar,
//    (1 - new rate) / (1 - old rate), raised to the elasticity of taxable income (0.25 by default).
//  - The change in 2023 liability is scaled to each future year in proportion to CBO's projected
//    individual income tax revenue, so current law reproduces CBO's baseline exactly.

export const RATES_2026 = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];
// 2026 thresholds (Rev. Proc. 2025-32), where each bracket starts.
export const THRESH_2026 = {
  single: [0, 12400, 50400, 105700, 201775, 256225, 640600],
  joint: [0, 24800, 100800, 211400, 403550, 512450, 768700],
  hoh: [0, 17700, 67450, 105700, 201750, 256200, 640600],
  mfs: [0, 12400, 50400, 105700, 201775, 256225, 384350],
};
export const STATUSES = ["single", "joint", "hoh", "mfs"];
export const DEFAULT_ETI = 0.25;

export function baseSchedule() {
  return THRESH_2026.single.map((t, i) => ({ t, r: RATES_2026[i] }));
}

// Encode/decode a schedule for share links: "t:r,t:r,..." with rates in percent.
export function encodeSchedule(s) {
  return s.map((p) => `${Math.round(p.t)}_${+(p.r * 100).toFixed(2)}`).join(".");
}
export function decodeSchedule(str) {
  if (!str || typeof str !== "string") return null;
  const pts = str.split(".").map((x) => x.split("_").map(Number)).filter((a) => a.length === 2 && a.every(Number.isFinite));
  if (!pts.length) return null;
  const s = pts.map(([t, r]) => ({ t: Math.max(0, t), r: Math.max(0, Math.min(0.99, r / 100)) })).sort((a, b) => a.t - b.t);
  s[0].t = 0;
  return s;
}
export const BASE_CODE = encodeSchedule(baseSchedule());

// Map a single-filer threshold to another filing status, following current law's relationship
// between the two (piecewise linear through the 2026 bracket pairs; proportional beyond the top).
export function mapThreshold(t, status) {
  if (status === "single") return t;
  const S = THRESH_2026.single, T = THRESH_2026[status];
  for (let k = 1; k < S.length; k++) {
    if (t <= S[k]) {
      const a = S[k - 1], b = S[k];
      return T[k - 1] + ((t - a) / (b - a)) * (T[k] - T[k - 1]);
    }
  }
  return t * (T[T.length - 1] / S[S.length - 1]);
}

export function marginal(s, x) {
  let r = s[0].r;
  for (const p of s) { if (x >= p.t) r = p.r; else break; }
  return r;
}

// Tax owed on taxable income x under schedule s (single filer).
export function taxAt(s, x) {
  let tax = 0;
  for (let k = 0; k < s.length; k++) {
    const lo = s[k].t, hi = k + 1 < s.length ? s[k + 1].t : Infinity;
    if (x <= lo) break;
    tax += (Math.min(x, hi) - lo) * s[k].r;
  }
  return tax;
}

// ---------- the income distribution ----------
// d.statuses[st] = { L: [lower bound of each 2023 bracket, $], N: [returns in each bracket], B: [income taxed in each bracket, $] }
// Build a function n(x) = returns with taxable income above x, per status.
export function buildDistribution(d) {
  return { seg: buildSegments(d), T23: d.thresholds, data: d };
}

function buildSegments(d) {
  const out = {};
  for (const st of Object.keys(d.statuses)) {
    const { L, N, B } = d.statuses[st];
    const K = L.length;
    const C = N.map((_, k) => N.slice(k).reduce((a, b) => a + b, 0)); // returns above L[k]
    const seg = [];
    for (let k = 0; k < K; k++) {
      const lo = L[k], hi = k + 1 < K ? L[k + 1] : Infinity;
      if (k === 0) {
        // Linear from C0 at 0 toward C1 at L1, scaled to match the bracket's income.
        const lin = ((C[0] + C[1]) / 2) * hi;
        seg.push({ lo, hi, kind: "lin", c0: C[0], c1: C[1], scale: B[0] / lin });
      } else if (hi === Infinity) {
        const alpha = 1 + (C[k] * lo) / B[k]; // Pareto tail with the right mean
        seg.push({ lo, hi, kind: "tail", c: C[k], alpha });
      } else {
        seg.push({ lo, hi, kind: "pow", c: C[k], beta: solveBeta(C[k], lo, hi, B[k]) });
      }
    }
    out[st] = seg;
  }
  return out;
}

// Find beta so that the integral of c*(x/lo)^-beta from lo to hi equals B.
function solveBeta(c, lo, hi, B) {
  const f = (b) => (Math.abs(b - 1) < 1e-9 ? c * lo * Math.log(hi / lo) : (c * lo * (Math.pow(hi / lo, 1 - b) - 1)) / (1 - b)) - B;
  let a = -20, z = 40;
  for (let i = 0; i < 200; i++) { const m = (a + z) / 2; if (f(m) > 0) a = m; else z = m; }
  return (a + z) / 2;
}

function nAt(seg, x) {
  for (const s of seg) {
    if (x < s.hi) {
      if (s.kind === "lin") return s.scale * (s.c0 + (s.c1 - s.c0) * ((x - s.lo) / (s.hi - s.lo)));
      if (s.kind === "pow") return s.c * Math.pow(x / s.lo, -s.beta);
      return s.c * Math.pow(x / s.lo, -s.alpha);
    }
  }
  return 0;
}

// Integrate tax over the distribution for one status. sched: [{t (status $, 2023 dollars), r}], base likewise.
// Integration is over log-spaced income slices, with breakpoints at every threshold.
function liability(seg, sched, base, eti) {
  const pts = new Set([0, 1e3, 3e8]);
  for (const p of sched) pts.add(p.t);
  for (const p of base) pts.add(p.t);
  for (const s of seg) if (Number.isFinite(s.hi)) pts.add(s.hi);
  const xs = [...pts].filter((x) => x >= 0 && x <= 3e8).sort((a, b) => a - b);
  let tax = 0, taxBase = 0;
  for (let j = 0; j + 1 < xs.length; j++) {
    const a = xs[j], b = xs[j + 1];
    const steps = Math.max(4, Math.ceil(Math.log((b + 1) / (a + 1)) * 12));
    const m1 = marginal(sched, (a + b) / 2), m0 = marginal(base, (a + b) / 2);
    const f = eti ? Math.pow((1 - m1) / (1 - m0), eti) : 1;
    // Simpson's rule on the slice, in log-space for wide intervals
    const la = Math.log(a + 1), lb = Math.log(b + 1);
    let area = 0;
    for (let i = 0; i < steps; i++) {
      const u0 = la + ((lb - la) * i) / steps, u1 = la + ((lb - la) * (i + 1)) / steps, um = (u0 + u1) / 2;
      const g = (u) => { const x = Math.exp(u) - 1; return nAt(seg, x) * (x + 1); };
      area += ((u1 - u0) / 6) * (g(u0) + 4 * g(um) + g(u1));
    }
    tax += m1 * f * area;
    taxBase += m0 * area;
  }
  return { tax, base: taxBase };
}

// Convert a 2026 threshold for a filing status to the matching 2023 dollar amount, through
// the two years' bracket pairs (proportional beyond the top), so current law maps exactly.
function to2023(t, st, T23) {
  const A = THRESH_2026[st], Z = T23[st];
  for (let k = 1; k < A.length; k++) {
    if (t <= A[k]) return Z[k - 1] + ((t - A[k - 1]) / (A[k] - A[k - 1])) * (Z[k] - Z[k - 1]);
  }
  return t * (Z[Z.length - 1] / A[A.length - 1]);
}

// Change in 2023 ordinary-income tax liability from replacing current law with schedule s (2026 dollars).
export function liabilityChange(dist, s, { eti = DEFAULT_ETI } = {}) {
  let delta = 0, base = 0;
  const bySt = {};
  for (const st of STATUSES) {
    const seg = dist.seg[st];
    if (!seg) continue;
    const toStatus = (sched) => sched.map((p) => ({ t: to2023(mapThreshold(p.t, st), st, dist.T23), r: p.r }));
    const mine = toStatus(s);
    const cur = dist.T23[st].map((t, i) => ({ t, r: RATES_2026[i] }));
    const { tax, base: b0 } = liability(seg, mine, cur, eti);
    bySt[st] = tax - b0;
    delta += tax - b0;
    base += b0;
  }
  return { delta, base, bySt };
}
