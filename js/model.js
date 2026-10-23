// Budget model: the data tree, the user's settings, and the arithmetic.
// All dollar amounts are in millions.

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
    this.settings = new Map(); // nodeId -> {on:boolean, pct:number, m:boolean}
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

  leafValue(leaf, yi = this.bi) {
    const base = leaf.v[yi] || 0;
    const d = this.decidingSetting(leaf);
    if (!d) return base;
    const s = d[1];
    return s.on ? base * (1 + s.pct / 100) : 0;
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
    this.totalOutlays = this.roots.reduce((s, r) => s + r.base, 0);
    this.planOutlays = this.roots.reduce((s, r) => s + r.eff, 0);
    this.totalReceipts = this.receipts.reduce((s, r) => s + (r.v[bi] || 0), 0);
    this.planReceipts = this.totalReceipts; // revenue levers arrive in Phase 3
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
    if (patch.on === true && prev && !prev.on && patch.pct === undefined) s.pct = prev.pct;
    // Setting a node replaces anything set underneath it.
    if (n.children) this.#clearBelow(n);
    if (s.on && Math.abs(s.pct) < 1e-9 && !n.parent) this.settings.delete(id);
    else if (s.on && Math.abs(s.pct) < 1e-9 && !this.#ancestorSetting(n)) this.settings.delete(id);
    else this.settings.set(id, s);
    this.recompute();
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
    this.recompute();
  }

  setMandatoryUnlocked(v) {
    this.mandatoryUnlocked = v;
    this.recompute();
  }

  // Settings that are paused because mandatory edits are off.
  pausedMandatoryCount() {
    if (this.mandatoryUnlocked) return 0;
    let k = 0;
    for (const [id, s] of this.settings) if (s.m && !this.changes.has(id)) k++;
    return k;
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
    for (const [id, s] of this.settings) {
      parts.push(`${id}:${s.on ? 1 : 0}:${+s.pct.toFixed(2)}${s.m ? ":m" : ""}`);
    }
    return parts.join(";");
  }

  decode(str) {
    if (!str || !str.startsWith("v1")) return false;
    this.settings.clear();
    for (const p of str.split(";").slice(1)) {
      if (p === "m1") { this.mandatoryUnlocked = true; continue; }
      if (p === "m0") { this.mandatoryUnlocked = false; continue; }
      const [id, on, pct, m] = p.split(":");
      if (!this.nodes.has(id)) continue; // ids from an older data year are skipped
      const v = Number(pct);
      this.settings.set(id, { on: on === "1", pct: Number.isFinite(v) ? v : 0, m: m === "m" });
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
  if (a >= 1e6) s = "$" + (a / 1e6).toFixed(digits ?? 2) + "T";
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
