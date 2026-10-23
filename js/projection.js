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
    const li = Y.indexOf(last);
    const fy = plan.deltas.fy || P.planStart;
    const ramp = (N, y) => (y < fy ? 0 : N ? Math.min(1, (y - fy + 1) / N) : 1);
    for (const c of CATS) {
      byCat[c] = new Array(n).fill(0);
      const byN = plan.deltas.d[c];
      if (!byN) continue;
      for (const [Nk, row] of Object.entries(byN)) {
        const N = +Nk;
        const lastVal = row[oy.length - 1] / 1000; // full-strength change in OMB's last year
        for (let i = 0; i < n; i++) {
          const y = Y[i];
          if (y < P.planStart) continue;
          let full;
          if (y <= last) full = row[oy.indexOf(y)] / 1000;
          else full = catPath[c][li] ? lastVal * (catPath[c][i] / catPath[c][li]) : 0;
          const v = full * ramp(N, y);
          byCat[c][i] += v;
          userSpend[i] += v;
        }
      }
    }
  }
  const userRev = plan.rev || new Array(n).fill(0);
  // New programs from the Proposals tab (spending, billions).
  const newSpend = plan.newSpend || new Array(n).fill(0);
  for (let i = 0; i < n; i++) userSpend[i] += newSpend[i];

  // ---- economic assumptions (Phase 5) ----
  // A = { fc: "cbo"|"omb", dg: real growth change (pts/yr), dr: interest-rate change (pts), fb: debt feedback on/off }
  const A = plan.assume || {};
  const start = P.planStart;
  const gdpRatio = Y.map((y, i) => {
    let r = A.fc === "omb" ? P.omb.gdpRatio[i] / P.omb.gdpRatio[Y.indexOf(start - 1)] : 1;
    if (A.dg) r *= Math.pow(1 + A.dg / 100, Math.max(0, y - (start - 1)));
    return y < start ? 1 : r;
  });
  const gdp = P.gdp.map((g, i) => g * gdpRatio[i]);
  // Interest-rate changes reach the average rate on the debt gradually as it rolls over (about 5 years).
  const ROLL_YEARS = plan.rollYears || 6;
  const roll = (y) => Math.max(0, Math.min(1, (y - (start - 1)) / ROLL_YEARS));
  const drBase = Y.map((y, i) => (y < start ? 0 : ((A.dr || 0) + (A.fc === "omb" ? P.omb.dr[i] : 0)) * roll(y)));
  const MAND_ELASTICITY = 0.4;  // mandatory spending rises 0.4% for each 1% of extra GDP (benefits partly tied to wages and prices)
  const FEEDBACK_BP = 2;        // basis points of interest per percentage point of debt-to-GDP above CBO's path

  const track = (withPlan) => {
    let X = 0; // debt above CBO current law
    const o = { rev: [], nonint: [], netint: [], out: [], deficit: [], debt: [], extraInt: [], rate: [], gdp };
    let prevRatioGap = 0;
    for (let i = 0; i < n; i++) {
      const r = P.rate[i] / 100;
      const pbE = P.pb.mand[i] + P.pb.dd[i] + P.pb.nd[i];
      const tar = P.tariff[i];
      const uS = withPlan ? userSpend[i] : 0;
      const uR = withPlan ? userRev[i] : 0;
      const uSm = withPlan ? uS - (byCat.disc?.[i] || 0) : 0;
      const g = gdpRatio[i] - 1;
      const revTot = b.rev[i] - tar + uR;
      const mandTot = b.ss[i] + b.medicare[i] + b.health[i] + b.othm[i] + P.pb.mand[i] + uSm;
      // A bigger economy brings in proportionally more revenue and raises mandatory spending somewhat;
      // discretionary spending is set in dollars by Congress, so it doesn't change.
      const econE = -revTot * g + MAND_ELASTICITY * mandTot * g;
      const e = pbE + tar + uS - uR + econE;   // added to the primary deficit vs. current law
      const fbShift = A.fb && Y[i] >= start ? (FEEDBACK_BP / 1e4) * prevRatioGap : 0;
      const dr = drBase[i] / 100 + fbShift;
      const debtPrev = (i > 0 ? b.debt[i - 1] : b.debt[0] + b.deficit[0]) + X;
      // Interest on the extra debt at CBO's rate, plus any rate change applied to all debt.
      const ii = r * (X + e / 2) + dr * (debtPrev + e / 2);
      X += e + ii;
      const nonint = b.ss[i] + b.medicare[i] + b.health[i] + b.othm[i] + b.disc[i] + pbE + uS + MAND_ELASTICITY * mandTot * g;
      const rev = revTot * (1 + g);
      const netint = b.netint[i] + ii;
      o.rev.push(rev);
      o.nonint.push(nonint);
      o.netint.push(netint);
      o.out.push(nonint + netint);
      o.deficit.push(rev - nonint - netint);    // negative = deficit
      o.debt.push(b.debt[i] + X);
      o.extraInt.push(ii);
      o.rate.push((r + dr) * 100);
      prevRatioGap = ((b.debt[i] + X) / gdp[i] - b.debt[i] / P.gdp[i]) * 100;
    }
    return o;
  };

  const base = track(false);
  const mine = track(true);
  // Spending mix (plan) for the stacked chart, as dollars.
  const gm = (i) => 1 + MAND_ELASTICITY * (gdpRatio[i] - 1);
  mine.mix = {
    ss: b.ss.map((v, i) => (v + (byCat.ss?.[i] || 0)) * gm(i)),
    medicare: b.medicare.map((v, i) => (v + (byCat.medicare?.[i] || 0)) * gm(i)),
    health: b.health.map((v, i) => (v + (byCat.health?.[i] || 0)) * gm(i)),
    othm: b.othm.map((v, i) => (v + P.pb.mand[i] + (byCat.othm?.[i] || 0)) * gm(i)),
    disc: catPath.disc.map((v, i) => v + (byCat.disc?.[i] || 0)),
    newp: newSpend.slice(),
    netint: mine.netint,
  };
  return { years: Y, base, mine, userSpend, gdp };
}

// After CBO's horizon: hold the last year's revenue and spending shares of GDP, GDP growth,
// and interest rate constant, and see when (if ever) the debt is paid off.
export function extendPayoff(P, o, maxYear = 2150) {
  const Y = P.meta.years, n = Y.length;
  const last = n - 1;
  for (let i = 0; i < n; i++) if (o.debt[i] <= 0) return { year: Y[i], extrapolated: false };
  if (o.deficit[last] <= 0) return null;
  const G = o.gdp || P.gdp;
  const g = G[last] / G[last - 1] - 1;
  const r = (o.rate ? o.rate[last] : P.rate[last]) / 100;
  const primaryShare = (o.rev[last] - o.nonint[last]) / G[last];
  let gdp = G[last], debt = o.debt[last];
  for (let y = Y[last] + 1; y <= maxYear; y++) {
    gdp *= 1 + g;
    const prim = primaryShare * gdp;
    debt = debt - prim + r * debt;
    if (debt <= 0) return { year: y, extrapolated: true };
  }
  return null;
}

export function summarize(P0, res) {
  const P = { ...P0, gdp: res.gdp || P0.gdp };
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
      firstSurplus: firstSurplus(o), peak: peak(o), payoff: extendPayoff(P0, o),
    };
  }
  return out;
}
