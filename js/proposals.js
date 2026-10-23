// Proposals users can switch on (Phase 6): scoring.
// Each option's cost becomes a constant share of GDP (scaled from the estimate's own years),
// except one-time costs, UBI (computed from population), and the tax-break extensions
// (computed from OMB's tax expenditure data). Paths are billions of dollars, full strength;
// phase-ins are applied in scoreProposals().

let DATA = null, TB = null;
export function initProposals(data, taxBreaks) { DATA = data; TB = taxBreaks; }
export const proposalData = () => DATA;
export const proposalById = (id) => DATA?.proposals.find((p) => p.id === id);

const ADULT_SHARE = 0.78; // share of the population 18 and older (Census, about 78%)

function gdpOf(ctx, y) {
  const i = ctx.Y.indexOf(y);
  if (i >= 0) return ctx.P.gdp[i];
  return ctx.P.gdpHist?.[String(y)] ?? null;
}

// Share of GDP implied by an estimate.
function shareOf(ctx, o) {
  if (o.kind === "gdp") return o.pct / 100;
  if (o.kind === "annual") return o.amt / gdpOf(ctx, o.year);
  if (o.kind === "window") {
    let g = 0;
    for (let y = o.from; y <= o.to; y++) g += gdpOf(ctx, y);
    return o.S / g;
  }
  return 0;
}

function breakPath(id) {
  return TB?.breaks.find((b) => b.id === id);
}

// Full-strength cost path (positive = adds to the deficit), and how it splits into spending vs. revenue.
export function costPath(ctx, prop, optKey, amt) {
  const o = prop.options.find((x) => x.key === optKey) || prop.options[0];
  const Y = ctx.Y, n = Y.length, start = ctx.start;
  const path = new Array(n).fill(0);
  if (o.kind === "once") {
    const i = Y.indexOf(o.year || start);
    if (i >= 0) path[i] = o.amt;
  } else if (o.kind === "ubi") {
    const m = amt ?? prop.amount.def;
    for (let i = 0; i < n; i++) if (Y[i] >= start) {
      const adults = (ctx.P.pop?.[i] ?? 340) * ADULT_SHARE; // millions
      path[i] = (m * 12 * adults * (ctx.P.deflator[i] / ctx.P.deflator[Y.indexOf(start)])) / 1000;
    }
  } else if (o.kind === "te_extend" || o.kind === "salt") {
    const b = breakPath(o.te);
    if (b) {
      const k = b.years.indexOf(o.last);
      const iLast = Y.indexOf(o.last);
      for (let i = 0; i < n; i++) if (Y[i] > o.last) {
        const held = b.v[k] * (ctx.P.gdp[i] / ctx.P.gdp[iLast]);
        const kk = b.years.indexOf(Y[i]);
        const cur = kk >= 0 ? b.v[kk] : (b.v[b.v.length - 1] * ctx.P.gdp[i]) / ctx.P.gdp[Y.indexOf(b.years[b.years.length - 1])];
        path[i] = Math.max(0, held - cur);
      }
    }
  } else {
    const sh = shareOf(ctx, o);
    for (let i = 0; i < n; i++) if (Y[i] >= start) path[i] = sh * ctx.P.gdp[i];
  }
  const isTax = prop.group === "tax" || o.kind === "te_extend" || o.kind === "salt";
  const split = o.split || (isTax ? { spend: 0, rev: 1 } : { spend: 1, rev: 0 });
  // Estimates with S < 0 are already expressed as revenue losses or savings.
  const sign = o.kind === "window" && o.S < 0 && isTax ? -1 : 1;
  return { cost: path.map((v) => v * sign), split, option: o };
}

// Score every active proposal with its phase-in. Returns spending added, revenue change, and per-proposal costs.
export function scoreProposals(ctx, model) {
  const n = ctx.Y.length;
  const spend = new Array(n).fill(0), rev = new Array(n).fill(0);
  const byId = {};
  if (!DATA) return { spend, rev, byId };
  for (const [id, st] of model.prop) {
    const p = proposalById(id);
    if (!p) continue;
    const { cost, split } = costPath(ctx, p, st.opt, st.amt);
    const N = model.propPh.has(id) ? model.propPh.get(id) : p.phase ?? 0;
    const c = cost.map((v, i) => v * model.ramp(N, ctx.Y[i]));
    byId[id] = c;
    for (let i = 0; i < n; i++) { spend[i] += c[i] * split.spend; rev[i] -= c[i] * split.rev; }
  }
  return { spend, rev, byId };
}

export function tenYearCost(ctx, path) {
  return path.reduce((s, v, i) => s + (ctx.Y[i] >= ctx.start && ctx.Y[i] < ctx.start + 10 ? v : 0), 0);
}
