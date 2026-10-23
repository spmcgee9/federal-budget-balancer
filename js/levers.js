import { buildDistribution, liabilityChange, decodeSchedule, BASE_CODE, DEFAULT_ETI } from "./taxcurve.js";

// Revenue levers: what each one does, where its estimate comes from, and how it's scored.
//
// Scoring is "conventional," like CBO's and JCT's official estimates: it includes ordinary behavioral
// responses (people realize fewer capital gains when rates rise, imports fall when tariffs rise)
// but not effects on the overall economy. Most levers are calibrated to a published 10-year estimate,
// then scaled to today's economy in proportion to GDP and extended to 2056 as a constant share of GDP.
// A few are computed directly from CBO data (payroll taxes from wages; tariffs from customs revenue).
// Amounts are billions of dollars. All values are full strength; phase-ins are applied in scoreAll().

const CRFB = {
  name: "CBO, Options for Reducing the Deficit (Dec 2024), 2026–2035 estimates compiled by CRFB",
  url: "https://www.crfb.org/blogs/cbos-revenue-savings-options",
};
// Estimates whose tax base the 2025 reconciliation law (OBBBA) changed directly.
const CRFB_OLD = { ...CRFB, older: true };
const CBO_OPTIONS = "https://www.cbo.gov/publication/60557";

// Spread a 10-year estimate (calibrated to 2026–2035) across years in proportion to GDP.
function gdpPath(ctx, S10) {
  return ctx.P.gdp.map((g, i) => (ctx.Y[i] < ctx.start ? 0 : (S10 * g) / ctx.G10));
}
// Rate changes lose a little punch as they grow (more avoidance), and cuts lose a little more revenue per point.
const damp = (x, k) => x * (1 - k * x);

export const GROUPS = [
  { id: "ind", name: "Individual income tax", note: "Rates on wages, salaries, and business income (capital gains are taxed separately, below)." },
  { id: "cap", name: "Capital gains and investment income" },
  { id: "corp", name: "Corporate income tax" },
  { id: "pay", name: "Payroll taxes", note: "Social Security and Medicare taxes on wages. Paid half by workers and half by employers." },
  { id: "exc", name: "Excise taxes" },
  { id: "tar", name: "Tariffs" },
  { id: "new", name: "New taxes" },
  { id: "est", name: "Estate and gift tax" },
  { id: "brk", name: "Tax breaks", note: "Deductions, exclusions, and credits. Repealing one raises less than its published cost: people change behavior and breaks overlap, so this tool counts 75% of OMB's estimate." },
];

export const LEVERS = [
  // ---------- individual income tax ----------
  {
    id: "ind_surtax", group: "ind", name: "Surtax on income above $100,000 ($200,000 married)",
    control: { type: "slider", min: 0, max: 10, step: 0.5, def: 0, fmt: (v) => v + "%" },
    desc: "An additional tax on adjusted gross income above $100,000 for single filers and $200,000 for married couples, on top of regular rates.",
    source: { ...CRFB_OLD, detail: "$560 billion per percentage point, 2026–2035" },
    score: (v, ctx) => gdpPath(ctx, damp(v, 0.025) * 560),
  },

  // ---------- capital ----------
  {
    id: "cg_rate", group: "cap", name: "Top rate on capital gains and dividends",
    control: { type: "slider", min: 15, max: 40, step: 1, def: 20, fmt: (v) => v + "%" },
    desc: "The top rate on long-term capital gains and qualified dividends is 20% (plus the 3.8% net investment income tax). Investors can choose when to sell, so higher rates mean fewer sales: revenue rises at first, peaks around a 28% rate, then falls.",
    source: { ...CRFB, detail: "+2 points raises $110 billion, 2026–2035; revenue curve peaks near 28% (CBO/JCT realization response)" },
    score: (v, ctx) => {
      const d = v - 20, b = 110 / 28; // g(2) = 28b = $110B; peak at d = 8
      return gdpPath(ctx, 16 * b * d - b * d * d);
    },
  },
  {
    id: "cg_death", group: "cap", name: "Tax capital gains at death",
    control: { type: "toggle", def: false },
    desc: "Today, gains on assets held until death are never taxed: heirs get a 'stepped-up basis.' This would treat death as a sale and tax the gains, with an exemption for smaller estates.",
    source: { ...CRFB, detail: "$570 billion, 2026–2035" },
    score: (v, ctx) => gdpPath(ctx, v ? 570 : 0),
  },
  {
    id: "niit_pass", group: "cap", name: "Apply the 3.8% investment tax to all pass-through income",
    control: { type: "toggle", def: false },
    desc: "Some owners of partnerships and S corporations avoid both the 3.8% net investment income tax and Medicare payroll taxes. This closes that gap for high earners.",
    source: { ...CRFB_OLD, detail: "$440 billion, 2026–2035" },
    score: (v, ctx) => gdpPath(ctx, v ? 440 : 0),
  },
  {
    id: "carried", group: "cap", name: "Tax carried interest as ordinary income",
    control: { type: "toggle", def: false },
    desc: "Investment fund managers' share of profits ('carried interest') is taxed at capital gains rates. This would tax it like wages.",
    source: { ...CRFB, detail: "$15 billion, 2026–2035" },
    score: (v, ctx) => gdpPath(ctx, v ? 15 : 0),
  },

  // ---------- corporate ----------
  {
    id: "corp_rate", group: "corp", name: "Corporate tax rate",
    control: { type: "slider", min: 15, max: 35, step: 1, def: 21, fmt: (v) => v + "%" },
    desc: "The corporate income tax rate has been 21% since 2018 (it was 35% before). Companies respond to higher rates by shifting profits abroad and changing how they finance themselves, so each point raises a bit less than the last.",
    source: { ...CRFB, detail: "$140 billion per percentage point, 2026–2035" },
    score: (v, ctx) => gdpPath(ctx, damp(v - 21, 0.015) * 140),
  },
  {
    id: "corp_foreign", group: "corp", name: "Tax U.S. companies' foreign income at the full rate",
    control: { type: "toggle", def: false },
    desc: "U.S. companies' foreign profits are taxed at a reduced rate under the minimum tax on foreign income. This would tax them at the full corporate rate.",
    source: { ...CRFB_OLD, detail: "$345 billion, 2026–2035" },
    score: (v, ctx) => gdpPath(ctx, v ? 345 : 0),
  },

  // ---------- payroll (computed from CBO wage data) ----------
  {
    id: "ss_cap", group: "pay", name: "Social Security tax cap",
    control: { type: "select", def: "law", options: [
      { v: "law", label: "Current law (≈83% of wages taxed)" },
      { v: "87", label: "Raise it to cover 87% of wages" },
      { v: "90", label: "Cover 90% of wages (the 1983 target)" },
      { v: "95", label: "Cover 95% of wages" },
      { v: "100", label: "No cap: tax all wages" },
    ] },
    desc: "The 12.4% Social Security tax applies only to wages up to a cap ($184,500 in 2026). Because top earners' wages grew fastest, the share of wages under the cap has fallen from 90% in 1983 to about 83%. Raising the cap taxes more of high earners' wages. This estimate assumes no extra benefits are paid on the newly taxed wages.",
    source: { name: "Computed from CBO wage and taxable-share projections (Feb 2026), with a 22% income tax offset", url: "https://www.cbo.gov/publication/62044", detail: "Checked against CBO's payroll option: $1.3 trillion per point with no cap, 2026–2035" },
    score: (v, ctx) => {
      if (v === "law") return ctx.zero();
      const s = +v;
      return ctx.P.wages.map((w, i) => (ctx.Y[i] < ctx.start ? 0 : 0.124 * w * Math.max(0, s - ctx.P.capShare[i]) / 100 * ctx.OFFSET));
    },
  },
  {
    id: "ss_rate", group: "pay", name: "Social Security tax rate (12.4% today)",
    control: { type: "slider", min: -2, max: 4, step: 0.2, def: 0, fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1) + " pts" },
    desc: "Changes the combined worker-plus-employer Social Security rate on wages under the cap.",
    source: { name: "Computed from CBO wage and taxable-share projections (Feb 2026), with a 22% income tax offset", url: "https://www.cbo.gov/publication/62044" },
    score: (v, ctx) => ctx.P.wages.map((w, i) => (ctx.Y[i] < ctx.start ? 0 : (v / 100) * w * (ctx.P.capShare[i] / 100) * ctx.OFFSET)),
  },
  {
    id: "med_rate", group: "pay", name: "Medicare tax rate (2.9% today)",
    control: { type: "slider", min: -1, max: 3, step: 0.1, def: 0, fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1) + " pts" },
    desc: "Changes the combined Medicare hospital insurance tax, which applies to all wages with no cap.",
    source: { name: "Computed from CBO wage projections (Feb 2026), with a 22% income tax offset", url: "https://www.cbo.gov/publication/62044" },
    score: (v, ctx) => ctx.P.wages.map((w, i) => (ctx.Y[i] < ctx.start ? 0 : (v / 100) * w * ctx.OFFSET)),
  },

  // ---------- estate ----------
  {
    id: "estate", group: "est", name: "Restore the pre-2018 estate tax exemption",
    control: { type: "toggle", def: false },
    desc: "The estate tax applies to estates above an exemption at a 40% rate; fewer than 1 in 1,000 estates pay it. The 2025 law set the exemption at $15 million per person ($30 million per couple), indexed for inflation. Before 2018 it was about $5.5 million, which would have grown to roughly $7 million in 2026. This restores that lower exemption.",
    source: { name: "CBO's estimate of the 2025 reconciliation act (P.L. 119-21): the higher exemption costs $212 billion over 10 years, as cited by the Tax Law Center", url: "https://taxlawcenter.org/files/How-OBBBA-Weakens-the-Tax-System-2.pdf", detail: "$212 billion over 2025–2034, scaled to today's economy" },
    score: (v, ctx) => gdpPath(ctx, v ? 212 * 1.04 : 0),
  },

  // ---------- excise ----------
  {
    id: "gas", group: "exc", name: "Raise the federal gas tax",
    control: { type: "slider", min: 0, max: 50, step: 1, def: 0, fmt: (v) => "+" + v + "¢ / gallon" },
    desc: "The federal gas tax has been 18.4 cents a gallon since 1993 and isn't indexed to inflation. It pays for the Highway Trust Fund. This increase would also be indexed to inflation.",
    source: { ...CRFB, detail: "Increase 15¢ and index: $215 billion, 2026–2035 (scaled per cent)" },
    score: (v, ctx) => gdpPath(ctx, (v / 15) * 215),
  },
  {
    id: "alcohol", group: "exc", name: "Standardize and index alcohol taxes",
    control: { type: "toggle", def: false },
    desc: "Taxes beer, wine, and liquor at the same rate per ounce of alcohol (today liquor is taxed far more), and indexes the rate to inflation.",
    source: { ...CRFB, detail: "$105 billion, 2026–2035" },
    score: (v, ctx) => gdpPath(ctx, v ? 105 : 0),
  },
  {
    id: "tobacco", group: "exc", name: "Raise tobacco taxes",
    control: { type: "toggle", def: false },
    desc: "Raises the cigarette tax by 50 cents a pack, with similar increases for other tobacco products.",
    source: { ...CRFB, detail: "$50 billion, 2026–2035" },
    score: (v, ctx) => gdpPath(ctx, v ? 50 : 0),
  },

  // ---------- tariffs (computed from customs baseline) ----------
  {
    id: "tariff", group: "tar", name: "Average tariff rate on imports",
    control: { type: "slider", min: 0, max: 40, step: 0.5, def: 10, fmt: (v) => v + "%" },
    desc: "CBO estimates the average U.S. tariff rate at about 10% after the Supreme Court ended the IEEPA tariffs and new Section 301 tariffs took effect (July 2026). Higher tariffs shrink imports, so revenue rises less than the rate. Tariffs also reduce income and payroll tax receipts, because they raise costs for businesses; this tool counts 75% of the change in customs duties, as CBO and JCT do. Retaliation and other economic effects aren't modeled.",
    source: { name: "Computed from CBO's customs projections and July 31, 2026 tariff update; import price elasticity of 2", url: "https://www.cbo.gov/publication/62704" },
    score: (v, ctx) => {
      const t0 = 0.10, t = v / 100, eta = 2;
      const ratio = t === 0 ? 0 : (t / t0) * Math.pow((1 + t) / (1 + t0), -eta);
      return ctx.customs.map((c, i) => (ctx.Y[i] < ctx.start ? 0 : 0.75 * c * (ratio - 1)));
    },
  },

  // ---------- new taxes ----------
  {
    id: "vat", group: "new", name: "Value-added tax (VAT)",
    control: { type: "slider", min: 0, max: 10, step: 0.5, def: 0, fmt: (v) => v + "%" },
    desc: "A tax on the value added at each stage of production, like a national sales tax. Most other wealthy countries have one (the average rate is about 19%). This is a broad base covering most goods and services; exempting food, housing, and health care (a 'narrow base') would raise about a third less. A VAT falls hardest on lower-income households unless paired with rebates.",
    source: { ...CRFB, detail: "5% broad-base VAT: $3.5 trillion, 2026–2035 (scaled per point)" },
    score: (v, ctx) => gdpPath(ctx, (v / 5) * 3500),
  },
  {
    id: "carbon", group: "new", name: "Carbon tax",
    control: { type: "slider", min: 0, max: 100, step: 5, def: 0, fmt: (v) => "$" + v + " / ton CO₂" },
    desc: "A tax on carbon dioxide emissions from burning coal, oil, and natural gas, rising 5% a year. As emissions fall in response, revenue grows less than the price.",
    source: { ...CRFB, detail: "$25/ton rising 5% a year: $960 billion, 2026–2035" },
    score: (v, ctx) => gdpPath(ctx, v ? 960 * Math.pow(v / 25, 0.85) : 0),
  },
  {
    id: "ftt", group: "new", name: "Financial transaction tax",
    control: { type: "slider", min: 0, max: 10, step: 0.5, def: 0, fmt: (v) => (v / 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") + "%" },
    desc: "A small tax on the value of trades in stocks, bonds, and derivatives. Trading volume drops sharply as the rate rises, so revenue grows much more slowly than the rate.",
    source: { ...CRFB, detail: "0.01% tax: $340 billion, 2026–2035; CBO's earlier 0.1% option raised roughly twice as much" },
    score: (v, ctx) => gdpPath(ctx, v ? 340 * Math.pow(v, 0.35) : 0),
  },
  {
    id: "wealth", group: "new", name: "Annual wealth tax", uncertain: true,
    control: { type: "select", def: "off", options: [
      { v: "off", label: "None" },
      { v: "half", label: "1% above $50 million, 1.5% above $1 billion" },
      { v: "full", label: "2% above $50 million, 3% above $1 billion" },
    ] },
    desc: "A yearly tax on net worth above $50 million, affecting roughly 75,000–100,000 households. There's no official CBO or JCT estimate, and independent estimates differ widely because they depend on how much wealthy households avoid or evade the tax and how assets are valued. This uses the Penn Wharton Budget Model's best estimate (scaled to today's economy). Its range ran from about half to nearly double, depending on avoidance. A wealth tax may also face constitutional challenges.",
    source: { name: "Penn Wharton Budget Model (2019): $2.7 trillion over 2021–2030 for the 2%/3% plan; range $1.4–4.8 trillion. Saez and Zucman (2021): $3.0 trillion over 2023–2032", url: "https://knowledge.wharton.upenn.edu/article/smetters-wealth-tax/", uncertain: true },
    score: (v, ctx) => {
      if (v === "off") return ctx.zero();
      // $2.7T over 2021-2030 scaled to the 2026-2035 window by nominal GDP (≈ $311T vs. ctx.G10).
      const S = 2700 * (ctx.G10 / 311000) * (v === "half" ? 0.5 : 1);
      return gdpPath(ctx, S);
    },
  },
];

export function makeCtx(P, start) {
  const Y = P.meta.years;
  const G10 = Y.reduce((s, y, i) => s + (y >= 2026 && y <= 2035 ? P.gdp[i] : 0), 0);
  const customs = P.base.rev_cust.map((c, i) => c - P.tariff[i]);
  return { P, Y, start, G10, customs, OFFSET: 0.78, zero: () => Y.map(() => 0) };
}

export function leverById(id) {
  return LEVERS.find((l) => l.id === id);
}

export function addLevers(extra, { front = false } = {}) {
  for (const l of extra) if (!leverById(l.id)) (front ? LEVERS.unshift(l) : LEVERS.push(l));
}

// Score every active lever, applying each one's phase-in.
export function scoreAll(ctx, model) {
  const n = ctx.Y.length;
  const total = new Array(n).fill(0);
  const byId = {};
  for (const [id, v] of model.rev) {
    const L = leverById(id);
    if (!L) continue;
    const full = L.score(v, ctx);
    const N = model.revPh.has(id) ? model.revPh.get(id) : model.phase;
    const path = full.map((x, i) => x * model.ramp(N, ctx.Y[i]));
    byId[id] = path;
    for (let i = 0; i < n; i++) total[i] += path[i];
  }
  return { total, byId };
}

// 10-year total for a single lever at a given value (full strength, no phase-in), for display.
export function tenYear(ctx, L, v) {
  const p = L.score(v, ctx);
  return p.reduce((s, x, i) => s + (ctx.Y[i] >= ctx.start && ctx.Y[i] < ctx.start + 10 ? x : 0), 0);
}

// Tax-break levers from OMB's tax expenditure tables (data/tax_breaks.json).
// Slider = how much of the break to scale back; revenue = share x OMB estimate x 75% (see GROUPS note).
export const TAX_BREAK_REALIZATION = 0.75;
export function taxBreakLevers(tb) {
  return tb.breaks.map((b) => ({
    id: b.id, group: "brk", name: b.name,
    control: { type: "slider", min: 0, max: 100, step: 5, def: 0, fmt: (v) => (v === 100 ? "Repeal" : v === 0 ? "Keep" : `Cut ${v}%`) },
    desc: b.desc,
    source: { name: tb.source, url: tb.url, detail: `OMB line items: ${b.omb.join("; ")}. Counted at 75% of OMB's estimate.` },
    score: (v, ctx) => {
      const last = b.years[b.years.length - 1];
      const iLast = ctx.Y.indexOf(last);
      return ctx.Y.map((y, i) => {
        if (y < ctx.start || !v) return 0;
        const k = b.years.indexOf(y);
        // After OMB's last year, hold the break's share of GDP constant (expired breaks stay at zero).
        const val = k >= 0 ? b.v[k] : b.v[b.v.length - 1] * (ctx.P.gdp[i] / ctx.P.gdp[iLast]);
        return (v / 100) * val * TAX_BREAK_REALIZATION;
      });
    },
  }));
}

// The editable income tax curve (Phase 4). Value = the schedule, encoded (see taxcurve.js).
// Scored from IRS 2023 data; the 2023 change is grown with GDP and multiplied by a calibration factor
// (0.85) so a 1-point increase in every bracket matches CBO's estimate for that option.
export const CURVE_CALIBRATION = 0.85;
export function taxCurveLever(tc) {
  const dist = buildDistribution(tc);
  const cache = new Map();
  const delta2023 = (code, eti) => {
    const key = code + "|" + eti;
    if (!cache.has(key)) {
      const s = decodeSchedule(code);
      cache.set(key, s ? liabilityChange(dist, s, { eti }).delta / 1e9 : 0);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  };
  return {
    id: "itax", group: "ind", name: "Income tax brackets",
    control: { type: "curve", def: BASE_CODE },
    dist, tc,
    desc: "Edit the brackets: each point starts a bracket, and the rate applies to taxable income above it until the next point. The chart is for single filers; married couples' thresholds follow current law's relationship (about double). Revenue is computed from IRS data on how much taxable income falls at each level, including a moderate behavioral response: people report less taxable income when rates rise (an elasticity of taxable income of 0.25).",
    source: { name: tc.source, url: tc.url, detail: "Changes in 2023 tax are grown with GDP and scaled by 0.85, which makes a 1-point increase in every bracket match CBO's estimate ($1.2 trillion over 10 years)." },
    score: (v, ctx) => {
      if (!v || v === BASE_CODE) return ctx.zero();
      const d = delta2023(v, ctx.eti ?? DEFAULT_ETI) * CURVE_CALIBRATION;
      return ctx.P.gdp.map((g, i) => (ctx.Y[i] < ctx.start ? 0 : (d * g) / ctx.P.gdpCY2023));
    },
  };
}
