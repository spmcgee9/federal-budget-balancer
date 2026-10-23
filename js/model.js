// Budget model: the data tree, the user's settings, and the arithmetic.
// All dollar amounts are in millions.

export const ASSUME_DEFAULTS = { fc: "cbo", dg: 0, dr: 0, fb: false, eti: 0.25, real: 75 };

export class BudgetModel {
  constructor(data, descriptions) {
    this.meta = data.meta;
    this.receipts = data.receipts;
    this.fy = data.meta.fy;
    this.bi = data.meta.years.indexOf(this.fy);
    this.desc = descriptions || { nodes: {}, accounts: [] };
    this.nodes = new Map();
    this.leaves = [];
    this.roots = data.tree;
    for (const r of this.roots) this.#index(r, null, r);
    // Largest functions first, mandatory or not: the point is to show where the money goes.
    this.roots.sort((a, b) => this.#rawTotal(b) - this.#rawTotal(a));
    for (const a of this.desc.accounts || []) {
      a.re = new RegExp(a.match, "i");
      a.agRe = a.agency ? new RegExp(a.agency, "i") : null;
    }
    // Search text: names, agency/bureau, acronyms, keywords, and descriptions.
    const aliases = this.desc.aliases || {};
    const acro = (s) => (s || "").replace(/\(.*?\)|--.*$/g, "").split(/[\s,-]+/)
      .filter((w) => w && !/^(and|of|the|for|on|in|to|u\.?s\.?)$/i.test(w)).map((w) => w[0]).join("");
    for (const n of this.nodes.values()) {
      const parts = [n.name, n.agency, n.bureau, aliases[n.agency], aliases[n.bureau]];
      const words = [acro(n.agency), acro(n.bureau)].filter((a) => a.length >= 2);
      const m = n.leaf && this.#matchAccount(n);
      if (m) parts.push(m.keywords, m.text);
      else parts.push(this.desc.nodes?.[n.id]);
      n.search = parts.filter(Boolean).join(" ").toLowerCase();
      n.acros = words.map((w) => w.toLowerCase());
    }
    // Intragovernmental transfers: one account pays another; the receiving side is a
    // negative (offsetting) entry. Lock the paying side so it can't be "cut" for fake savings.
    const locks = (this.desc.transfers || []).map((t) => ({ re: new RegExp(t.match, "i"), cat: t.cat }));
    for (const leaf of this.leaves) {
      if (locks.some((l) => l.re.test(leaf.name) && (!l.cat || l.cat === leaf.cat))) leaf.xfer = true;
    }
    // User state
    this.mandatoryUnlocked = false;
    this.phase = 0;            // default phase-in years for every change (0 = immediately)
    this.settings = new Map(); // nodeId -> {on:boolean, pct:number, m:boolean, ph?:years}
    this.rev = new Map();      // revenue lever id -> value
    this.revPh = new Map();    // revenue lever id -> phase-in years override
    this.revScore = null;      // set by the app: () => FY budget-year revenue change (millions)
    this.prop = new Map();     // proposal id -> { opt, amt? }
    this.propPh = new Map();   // proposal id -> phase-in override
    this.propScore = null;     // set by the app: () => { spend, rev } in the budget year (millions)
    this.assume = { ...ASSUME_DEFAULTS }; // economic and behavioral assumptions (Projections tab)
    this.recompute();
  }

  #index(n, parent, fn) {
    n.parent = parent;
    n.fn = fn; // owning budget function node
    this.nodes.set(n.id, n);
    if (n.children && n.children.length) {
      n.children.sort((a, b) => Math.abs(this.#rawTotal(b)) - Math.abs(this.#rawTotal(a)));
      for (const c of n.children) this.#index(c, n, fn);
    } else {
      n.leaf = true;
      this.leaves.push(n);
    }
  }

  #rawTotal(n) {
    if (!n.children) return n.v[this.bi] || 0;
    return n.children.reduce((s, c) => s + this.#rawTotal(c), 0);
  }

  // Why a leaf can't be changed right now (null if it can).
  lockReason(leaf) {
    const f = leaf.fn.code;
    if (leaf.cat === "I" || f === "900") return "computed";
    if (leaf.xfer) return "transfer";
    if (f === "920") return "allowance";
    if (f === "950" || (leaf.v[this.bi] || 0) < 0) return "offset";
    if (leaf.cat === "M" && !this.mandatoryUnlocked) return "mandatory";
    return null;
  }

  // The setting that decides a leaf's value: nearest setting on the leaf or an ancestor.
  // A setting made while mandatory edits were off never reaches mandatory leaves.
  decidingSetting(leaf) {
    if (this.lockReason(leaf)) return null;
    for (let n = leaf; n; n = n.parent) {
      const s = this.settings.get(n.id);
      if (s && (leaf.cat !== "M" || s.m)) return [n.id, s];
    }
    return null;
  }

  // Phase-in: share of a change in effect in a given fiscal year (0 before the budget year).
  // N = 0 means immediately; otherwise the change grows evenly to full strength over N years.
  ramp(N, year) {
    if (year < this.fy) return 0;
    return N ? Math.min(1, (year - this.fy + 1) / N) : 1;
  }

  phaseOf(s) { return s && s.ph != null ? s.ph : this.phase; }

  leafValue(leaf, yi = this.bi, full = false) {
    const base = leaf.v[yi] || 0;
    const d = this.decidingSetting(leaf);
    if (!d) return base;
    const s = d[1];
    const year = this.meta.years[yi];
    const f = full ? (year < this.fy ? 0 : 1) : this.ramp(this.phaseOf(s), year);
    return s.on ? base * (1 + (s.pct / 100) * f) : base * (1 - f);
  }

  recompute() {
    const bi = this.bi;
    for (const n of this.nodes.values()) {
      n.base = 0; n.eff = 0; n.adjBase = 0; n.adjEff = 0;
      n.baseD = 0; n.baseM = 0; n.baseX = 0; // discretionary, mandatory, other (interest/offsets)
      n.nAdj = 0; n.nOff = 0; n.mChanged = 0; n.nLeaves = 0;
    }
    this.changes = new Map(); // settingId -> {delta, deltaM, deltaD, leaves}
    for (const leaf of this.leaves) {
      const base = leaf.v[bi] || 0;
      const lock = this.lockReason(leaf);
      const d = this.decidingSetting(leaf);
      const eff = this.leafValue(leaf);
      if (d) {
        const c = this.changes.get(d[0]) || { delta: 0, deltaM: 0, deltaD: 0, leaves: 0 };
        c.delta += eff - base;
        if (leaf.cat === "M") c.deltaM += eff - base; else c.deltaD += eff - base;
        c.leaves++;
        this.changes.set(d[0], c);
      }
      const offPart = d && !d[1].on;
      const mChanged = leaf.cat === "M" && d && Math.abs(eff - base) > 1e-9 ? 1 : 0;
      for (let n = leaf; n; n = n.parent) {
        n.base += base; n.eff += eff; n.nLeaves++;
        if (lock && lock !== "mandatory") n.baseX += base;
        else if (leaf.cat === "D") n.baseD += base;
        else n.baseM += base;
        if (!lock) { n.adjBase += base; n.adjEff += eff; n.nAdj++; if (offPart) n.nOff++; }
        n.mChanged += mChanged;
      }
    }
    // Spending split for the scoreboard bar: mandatory, net interest, defense and nondefense discretionary.
    this.seg = { base: { M: 0, I: 0, DD: 0, ND: 0, NEW: 0 }, eff: { M: 0, I: 0, DD: 0, ND: 0, NEW: 0 } };
    for (const leaf of this.leaves) {
      const k = leaf.cat === "I" ? "I" : leaf.cat === "M" ? "M" : leaf.fn.code === "050" ? "DD" : "ND";
      this.seg.base[k] += leaf.v[bi] || 0;
      this.seg.eff[k] += this.leafValue(leaf);
    }
    this.totalOutlays = this.roots.reduce((s, r) => s + r.base, 0);
    const ps = this.propScore ? this.propScore() : { spend: 0, rev: 0 };
    this.propSpend = ps.spend; this.propRev = ps.rev;
    this.seg.eff.NEW = Math.max(0, ps.spend);
    this.planOutlays = this.roots.reduce((s, r) => s + r.eff, 0) + ps.spend;
    this.totalReceipts = this.receipts.reduce((s, r) => s + (r.v[bi] || 0), 0);
    this.revDelta = this.revScore ? this.revScore() : 0;
    this.planReceipts = this.totalReceipts + this.revDelta + ps.rev;
  }

  // Composition of a node: "D", "M", "X" (computed/offsets) or "mixed".
  kind(n) {
    if (n.leaf) {
      const lock = this.lockReason(n);
      if (lock && lock !== "mandatory") return "X";
      return n.cat;
    }
    // Call a group "mixed" only when the smaller side is at least 5% of it.
    const tot = n.baseD + n.baseM;
    if (tot < 0.5) return "X";
    const minor = Math.min(n.baseD, n.baseM) / tot;
    if (minor >= 0.05) return "mixed";
    return n.baseD >= n.baseM ? "D" : "M";
  }

  // The control state to show for a node.
  controlState(n) {
    const own = this.settings.get(n.id);
    const editable = n.nAdj > 0;
    let pct = 0, on = true, mixed = false;
    if (own && (n.leaf || editable)) {
      pct = own.pct; on = own.on;
      // descendants can't override (we clear them), but scope can differ for mandatory leaves
    } else if (editable) {
      on = n.nOff < n.nAdj;
      mixed = n.nOff > 0 && n.nOff < n.nAdj;
      pct = n.adjBase ? ((n.adjEff - n.adjBase) / Math.abs(n.adjBase)) * 100 : 0;
      if (!on) pct = 0;
    }
    return { editable, pct, on, mixed, own: !!own };
  }

  setNode(id, patch) {
    const n = this.nodes.get(id);
    const prev = this.settings.get(id);
    const cur = this.controlState(n);
    const s = {
      on: patch.on !== undefined ? patch.on : (prev ? prev.on : true),
      pct: patch.pct !== undefined ? patch.pct : (prev ? prev.pct : (cur.on ? Math.round(cur.pct) : 0)),
      m: this.mandatoryUnlocked,
    };
    if (patch.ph !== undefined) { if (patch.ph != null) s.ph = patch.ph; }
    else if (prev && prev.ph != null) s.ph = prev.ph;
    if (patch.on === true && prev && !prev.on && patch.pct === undefined) s.pct = prev.pct;
    // Setting a node replaces anything set underneath it.
    if (n.children) this.#clearBelow(n);
    if (s.on && Math.abs(s.pct) < 1e-9 && !n.parent && s.ph == null) this.settings.delete(id);
    else if (s.on && Math.abs(s.pct) < 1e-9 && !this.#ancestorSetting(n)) this.settings.delete(id);
    else this.settings.set(id, s);
    this.recompute();
  }

  // Set a node directly (used by Simple mode). m = whether the setting reaches mandatory programs.
  setNodeRaw(id, pct, m) {
    const n = this.nodes.get(id);
    if (!n) return;
    if (n.children) this.#clearBelow(n);
    if (Math.abs(pct) < 1e-9) this.settings.delete(id);
    else this.settings.set(id, { on: true, pct, m: !!m });
  }

  #ancestorSetting(n) {
    for (let p = n.parent; p; p = p.parent) if (this.settings.has(p.id)) return true;
    return false;
  }

  #clearBelow(n) {
    for (const c of n.children || []) {
      this.settings.delete(c.id);
      this.#clearBelow(c);
    }
  }

  resetNode(id) {
    const n = this.nodes.get(id);
    this.settings.delete(id);
    if (n.children) this.#clearBelow(n);
    this.recompute();
  }

  resetAll() {
    this.settings.clear();
    this.prop.clear();
    this.propPh.clear();
    this.rev.clear();
    this.revPh.clear();
    this.phase = 0;
    this.assume = { ...ASSUME_DEFAULTS };
    this.recompute();
  }

  setAssume(k, v) { this.assume[k] = v; this.recompute(); }
  resetAssume() { this.assume = { ...ASSUME_DEFAULTS }; this.recompute(); }
  assumeChanged() { return Object.keys(ASSUME_DEFAULTS).some((k) => this.assume[k] !== ASSUME_DEFAULTS[k]); }

  setPhase(n) { this.phase = n; this.recompute(); }

  setRev(id, value, dflt) {
    if (value === dflt || value == null) { this.rev.delete(id); this.revPh.delete(id); }
    else this.rev.set(id, value);
    this.recompute();
  }

  setRevPhase(id, n) {
    if (n == null) this.revPh.delete(id); else this.revPh.set(id, n);
    this.recompute();
  }

  hasChanges() { return this.settings.size > 0 || this.rev.size > 0 || this.prop.size > 0; }

  setProp(id, st) { if (st) this.prop.set(id, st); else { this.prop.delete(id); this.propPh.delete(id); } this.recompute(); }
  setPropPhase(id, n) { if (n == null) this.propPh.delete(id); else this.propPh.set(id, n); this.recompute(); }

  setMandatoryUnlocked(v) {
    this.mandatoryUnlocked = v;
    this.recompute();
  }

  // Settings that are paused because mandatory edits are off.
  pausedMandatoryCount() {
    if (this.mandatoryUnlocked) return 0;
    let k = 0;
    for (const [id, s] of this.settings) if (s.m && this.nodes.get(id).baseM > 0.5) k++;
    return k;
  }

  // Projection category of a leaf, matching CBO's long-term categories.
  projCat(leaf) {
    if (leaf.cat === "D") return "disc";
    if (leaf.cat === "I") return null;
    const sub = leaf.id.slice(1, 4);
    if (sub === "651") return "ss";
    if (sub === "571") return "medicare";
    if (sub === "551") return "health";
    return "othm";
  }

  // Full-strength dollar change from the user's plan, by projection category, phase-in length,
  // and OMB year (millions). The projection applies the phase-in itself, so that a 10-year
  // phase-in keeps ramping after OMB's last year.
  yearDeltas(onlyIds = null) {
    const years = this.meta.years;
    const out = {};
    for (const leaf of this.leaves) {
      const d = this.decidingSetting(leaf);
      if (!d) continue;
      if (onlyIds && !onlyIds.has(d[0])) continue;
      const c = this.projCat(leaf);
      if (!c) continue;
      const N = this.phaseOf(d[1]);
      const byN = out[c] || (out[c] = {});
      const row = byN[N] || (byN[N] = years.map(() => 0));
      for (let i = 0; i < years.length; i++) row[i] += this.leafValue(leaf, i, true) - (leaf.v[i] || 0);
    }
    return { years, d: out, fy: this.fy };
  }

  path(n) {
    const out = [];
    for (let p = n.parent; p; p = p.parent) out.unshift(p.name);
    return out;
  }

  description(n) {
    const d = this.desc.nodes || {};
    if (d[n.id]) return d[n.id];
    if (n.type === "function" && n.subCode && d["s" + n.subCode]) return d["s" + n.subCode];
    if (n.leaf) return this.#matchAccount(n)?.text || null;
    return null;
  }

  #matchAccount(n) {
    for (const a of this.desc.accounts || []) {
      if (a.re.test(n.name) && (!a.agRe || a.agRe.test(n.agency || ""))) return a;
    }
    return null;
  }

  // Search: every word must appear; a single word may also match an agency acronym exactly.
  search(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Short words (like "ice" or "nih") must match a whole word, not part of one.
    const tests = words.map((w) => w.length <= 4
      ? ((re) => (n) => re.test(n.search) || n.acros.includes(w))(new RegExp(`(^|[^a-z0-9])${esc(w)}([^a-z0-9]|$)`))
      : (n) => n.search.includes(w) || n.acros.includes(w));
    const out = [];
    for (const n of this.nodes.values()) {
      if (Math.abs(n.base) < 0.5) continue;
      const hit = tests.every((t) => t(n));
      if (hit) out.push(n);
    }
    // Prefer name matches, then size.
    const nameHit = (n) => words.every((w) => n.name.toLowerCase().includes(w)) ? 1 : 0;
    out.sort((a, b) => nameHit(b) - nameHit(a) || Math.abs(b.base) - Math.abs(a.base));
    return out;
  }

  // ---- shareable state ----
  encode() {
    const parts = ["v1", this.mandatoryUnlocked ? "m1" : "m0"];
    if (this.phase) parts.push("ph" + this.phase);
    for (const [id, s] of this.settings) {
      parts.push(`${id}:${s.on ? 1 : 0}:${+s.pct.toFixed(2)}${s.m ? ":m" : ":"}${s.ph != null ? ":" + s.ph : ""}`.replace(/:$/, ""));
    }
    for (const k of Object.keys(ASSUME_DEFAULTS)) {
      if (this.assume[k] !== ASSUME_DEFAULTS[k]) parts.push(`a.${k}=${this.assume[k] === true ? 1 : this.assume[k] === false ? 0 : this.assume[k]}`);
    }
    for (const [id, st] of this.prop) {
      const ph = this.propPh.get(id);
      parts.push(`p.${id}=${st.opt}${st.amt != null ? "_" + st.amt : ""}${ph != null ? "~" + ph : ""}`);
    }
    for (const [id, v] of this.rev) {
      const ph = this.revPh.get(id);
      parts.push(`r.${id}=${typeof v === "number" ? +v.toFixed(4) : v}${ph != null ? "~" + ph : ""}`);
    }
    return parts.join(";");
  }

  isDefault() { return this.encode() === "v1;m0"; }

  decode(str) {
    if (!str || !str.startsWith("v1")) return false;
    this.settings.clear();
    this.rev.clear();
    this.revPh.clear();
    this.prop.clear();
    this.propPh.clear();
    this.phase = 0;
    this.assume = { ...ASSUME_DEFAULTS };
    for (const p of str.split(";").slice(1)) {
      if (p.startsWith("a.")) {
        const [k, raw] = p.slice(2).split("=");
        if (!(k in ASSUME_DEFAULTS)) continue;
        const d = ASSUME_DEFAULTS[k];
        this.assume[k] = typeof d === "boolean" ? raw === "1" : typeof d === "number" ? (Number.isFinite(+raw) ? +raw : d) : raw;
        continue;
      }
      if (p === "m1") { this.mandatoryUnlocked = true; continue; }
      if (p === "m0") { this.mandatoryUnlocked = false; continue; }
      if (/^ph\d+$/.test(p)) { this.phase = +p.slice(2); continue; }
      if (p.startsWith("p.")) {
        const [kv, ph] = p.slice(2).split("~");
        const [id, raw] = kv.split("=");
        const [opt, amt] = (raw || "mid").split("_");
        this.prop.set(id, amt != null && amt !== "" ? { opt, amt: +amt } : { opt });
        if (ph != null && ph !== "") this.propPh.set(id, +ph);
        continue;
      }
      if (p.startsWith("r.")) {
        const [kv, ph] = p.slice(2).split("~");
        const [id, raw] = kv.split("=");
        const num = Number(raw);
        this.rev.set(id, raw === "true" ? true : raw === "false" ? false : Number.isFinite(num) && raw !== "" ? num : raw);
        if (ph != null && ph !== "") this.revPh.set(id, +ph);
        continue;
      }
      const [id, on, pct, m, ph] = p.split(":");
      if (!this.nodes.has(id)) continue; // ids from an older data year are skipped
      const v = Number(pct);
      const s = { on: on === "1", pct: Number.isFinite(v) ? v : 0, m: m === "m" };
      if (ph != null && ph !== "") s.ph = +ph;
      this.settings.set(id, s);
    }
    this.recompute();
    return true;
  }
}

export function fmt(m, { sign = false, digits } = {}) {
  if (!Number.isFinite(m)) return "—";
  const neg = m < 0;
  const a = Math.abs(m);
  let s;
  // About three significant figures: $8.09T, $56.3T, $155T.
  if (a >= 1e6) s = "$" + (a / 1e6).toFixed(digits ?? (a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)) + "T";
  else if (a >= 1e3) s = "$" + (a / 1e3).toFixed(digits ?? (a >= 1e5 ? 0 : 1)) + "B";
  else if (a >= 1) s = "$" + a.toFixed(digits ?? 0) + "M";
  else if (a > 0) s = "$" + (a * 1000).toFixed(0) + "K";
  else s = "$0";
  if (neg) return "−" + s;
  return (sign && m > 0 ? "+" : "") + s;
}

export function fmtPct(p) {
  if (!Number.isFinite(p)) return "";
  const r = Math.abs(p) < 10 ? Math.round(p * 10) / 10 : Math.round(p);
  if (r === 0) return "0%";
  return (r > 0 ? "+" : "−") + Math.abs(r) + "%";
}
