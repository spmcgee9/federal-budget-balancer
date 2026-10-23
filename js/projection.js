// Long-term projections of deficits and debt.
//
// Method
//  1. Start from CBO's current-law extended baseline (Feb 2026), in dollars.
//  2. Add CBO's estimate of the President's 2027 spending proposals, and CBO's July 2026 tariff update.
//     That is the "President's budget" baseline.
//  3. Add the user's plan. For 2027-2031 the plan's dollar changes come straight from OMB's
//     account data (the same numbers as the Spending tab). After 2031 each category's change grows
//     with CBO's projection for that category (e.g. a Social Security cut grows with Social Security).
//  4. Interest: CBO's baseline interest, plus interest on the extra (or reduced) debt at CBO's
//     projected average interest rate on federal debt. That compounding is what makes early
//     deficit reduction so valuable.
// All amounts here are billions of dollars.

const CATS = ["ss", "medicare", "health", "othm", "disc"];

export function project(P, plan = {}) {
  const Y = P.meta.years;
  const n = Y.length;
  const b = P.base;
  // Category paths used to grow the plan's changes after the OMB years.
  const catPath = {
    ss: b.ss, medicare: b.medicare, health: b.health, othm: b.othm,
    disc: b.disc.map((v, i) => v + P.pb.dd[i] + P.pb.nd[i]),
  };
  // Plan changes in spending by year (billions).
  const userSpend = new Array(n).fill(0);
  const byCat = {};
  if (plan.deltas) {
    const oy = plan.deltas.years;
    const last = oy[oy.length - 1];
    for (const c of CATS) {
      const row = plan.deltas.d[c];
      byCat[c] = new Array(n).fill(0);
      if (!row) continue;
      const lastVal = row[oy.length - 1] / 1000;
      const li = Y.indexOf(last);
      for (let i = 0; i < n; i++) {
        const y = Y[i];
        let v = 0;
        if (y < P.planStart) v = 0;
        else if (y <= last) v = row[oy.indexOf(y)] / 1000;
        else v = catPath[c][li] ? lastVal * (catPath[c][i] / catPath[c][li]) : 0;
        byCat[c][i] = v;
        userSpend[i] += v;
      }
    }
  }
  const userRev = plan.rev || new Array(n).fill(0); // revenue levers arrive in Phase 3

  const track = (withPlan) => {
    let X = 0; // debt above CBO current law
    const o = { rev: [], nonint: [], netint: [], out: [], deficit: [], debt: [], extraInt: [] };
    for (let i = 0; i < n; i++) {
      const r = P.rate[i] / 100;
      const pbE = P.pb.mand[i] + P.pb.dd[i] + P.pb.nd[i];
      const tar = P.tariff[i];
      const uS = withPlan ? userSpend[i] : 0;
      const uR = withPlan ? userRev[i] : 0;
      const e = pbE + tar + uS - uR;            // added to the primary deficit vs. current law
      const ii = r * (X + e / 2);               // interest on the difference (mid-year convention)
      X += e + ii;
      const nonint = b.ss[i] + b.medicare[i] + b.health[i] + b.othm[i] + b.disc[i] + pbE + uS;
      const rev = b.rev[i] - tar + uR;
      const netint = b.netint[i] + ii;
      o.rev.push(rev);
      o.nonint.push(nonint);
      o.netint.push(netint);
      o.out.push(nonint + netint);
      o.deficit.push(rev - nonint - netint);    // negative = deficit
      o.debt.push(b.debt[i] + X);
      o.extraInt.push(ii);
    }
    return o;
  };

  const base = track(false);
  const mine = track(true);
  // Spending mix (plan) for the stacked chart, as dollars.
  mine.mix = {
    ss: b.ss.map((v, i) => v + (byCat.ss?.[i] || 0)),
    medicare: b.medicare.map((v, i) => v + (byCat.medicare?.[i] || 0)),
    health: b.health.map((v, i) => v + (byCat.health?.[i] || 0)),
    othm: b.othm.map((v, i) => v + P.pb.mand[i] + (byCat.othm?.[i] || 0)),
    disc: catPath.disc.map((v, i) => v + (byCat.disc?.[i] || 0)),
    netint: mine.netint,
  };
  return { years: Y, base, mine, userSpend, extend: (o) => extendPayoff(P, o) };
}

// After CBO's horizon: hold the last year's revenue and spending shares of GDP, GDP growth,
// and interest rate constant, and see when (if ever) the debt is paid off.
export function extendPayoff(P, o, maxYear = 2150) {
  const Y = P.meta.years, n = Y.length;
  const last = n - 1;
  for (let i = 0; i < n; i++) if (o.debt[i] <= 0) return { year: Y[i], extrapolated: false };
  if (o.deficit[last] <= 0) return null;
  const g = P.gdp[last] / P.gdp[last - 1] - 1;
  const r = P.rate[last] / 100;
  const primaryShare = (o.rev[last] - o.nonint[last]) / P.gdp[last];
  let gdp = P.gdp[last], debt = o.debt[last];
  for (let y = Y[last] + 1; y <= maxYear; y++) {
    gdp *= 1 + g;
    const prim = primaryShare * gdp;
    debt = debt - prim + r * debt;
    if (debt <= 0) return { year: y, extrapolated: true };
  }
  return null;
}

export function summarize(P, res) {
  const Y = res.years;
  const at = (y) => Y.indexOf(y);
  const pick = (o, y) => ({ debt: o.debt[at(y)], pct: (o.debt[at(y)] / P.gdp[at(y)]) * 100 });
  const sum = (arr, a, z) => arr.slice(at(a), at(z) + 1).reduce((s, v) => s + v, 0);
  const firstSurplus = (o) => { for (let i = at(P.planStart); i < Y.length; i++) if (o.deficit[i] >= 0) return Y[i]; return null; };
  const peak = (o) => {
    let best = -Infinity, yr = null;
    for (let i = at(P.planStart); i < Y.length; i++) { const p = o.debt[i] / P.gdp[i]; if (p > best) { best = p; yr = Y[i]; } }
    return { year: yr, pct: best * 100 };
  };
  const out = {};
  for (const k of ["base", "mine"]) {
    const o = res[k];
    out[k] = {
      d10: pick(o, P.planStart + 9), d20: pick(o, P.planStart + 19), d30: pick(o, Y[Y.length - 1]),
      cum10: -sum(o.deficit, P.planStart, P.planStart + 9),
      int10: sum(o.netint, P.planStart, P.planStart + 9),
      intLast: o.netint[Y.length - 1], intLastPct: (o.netint[Y.length - 1] / P.gdp[Y.length - 1]) * 100,
      firstSurplus: firstSurplus(o), peak: peak(o), payoff: extendPayoff(P, o),
    };
  }
  return out;
}
