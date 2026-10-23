import { proposalData, proposalById, costPath, scoreProposals, tenYearCost } from "./proposals.js?v=dev";
import { fmt } from "./model.js?v=dev";
import { PHASES } from "./revenue-ui.js?v=dev";

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const money = (b, o) => fmt(b * 1000, o);

let model, ctx, onChange, drawer;
const cards = new Map();

export function initProposalsUI(m, c, { changed, openDrawer }) {
  model = m; ctx = c; onChange = changed; drawer = openDrawer;
}

export function proposalScores() {
  if (!model || !ctx || !proposalData()) return null;
  return scoreProposals(ctx, model);
}

const phaseOf = (p) => (model.propPh.has(p.id) ? model.propPh.get(p.id) : p.phase ?? 0);

export function renderProposals() {
  const box = $("#proposals");
  if (!box || !proposalData()) return;
  box.textContent = "";
  cards.clear();
  const D = proposalData();
  const head = el("div", "prop-summary");
  head.id = "prop-summary";
  box.append(head);
  box.append(el("p", "small rev-intro", "Programs and tax cuts that have been proposed but aren't law. Switch one on to add its cost to your plan. Where published estimates disagree, pick low, middle, or high. Older estimates are scaled to today's economy as a share of GDP. Costs don't include any new taxes a proposal's sponsors suggested to pay for it; use the Revenue tab for that."));
  for (const g of D.groups) {
    const list = D.proposals.filter((p) => p.group === g.id);
    if (!list.length) continue;
    const sec = el("div", "lever-group prop-group");
    sec.append(el("h3", "", g.name));
    if (g.note) sec.append(el("p", "small", g.note));
    for (const p of list) sec.append(card(p));
    box.append(sec);
  }
  updateProposals();
}

function card(p) {
  const c = el("div", "prop");
  c.dataset.id = p.id;
  const top = el("div", "prop-top");
  const sw = el("input", "switch");
  sw.type = "checkbox";
  sw.setAttribute("aria-label", "Include " + p.name);
  sw.addEventListener("change", () => {
    model.setProp(p.id, sw.checked ? { opt: p.default, ...(p.amount ? { amt: p.amount.def } : {}) } : null);
    onChange();
  });
  const name = el("button", "name", p.name);
  name.addEventListener("click", () => openProp(p));
  const info = el("button", "info", "?");
  info.title = "What is this?";
  info.setAttribute("aria-label", "What is " + p.name + "?");
  info.addEventListener("click", () => openProp(p));
  const tags = el("span", "tags");
  if (p.older) tags.append(el("span", "chip X", "older estimate"));
  top.append(sw, name, tags, info);

  const ctl = el("div", "prop-ctl");
  let seg = null, range = null, rangeVal = null;
  if (p.options.length > 1) {
    seg = el("div", "seg-ctl small-seg");
    for (const o of p.options) {
      const b = el("button", "", o.label);
      b.dataset.key = o.key;
      b.title = o.note || "";
      b.addEventListener("click", () => {
        const st = model.prop.get(p.id) || {};
        model.setProp(p.id, { ...st, opt: o.key });
        onChange();
      });
      seg.append(b);
    }
    ctl.append(seg);
  } else {
    ctl.append(el("span", "prop-note", p.options[0].note || ""));
  }
  if (p.amount) {
    range = el("input", "range");
    range.type = "range"; range.min = p.amount.min; range.max = p.amount.max; range.step = p.amount.step;
    range.setAttribute("aria-label", "Monthly amount");
    range.addEventListener("input", () => {
      const st = model.prop.get(p.id) || { opt: p.default };
      model.setProp(p.id, { ...st, amt: +range.value });
      onChange();
    });
    rangeVal = el("span", "lever-val");
    const wrap = el("div", "prop-amt");
    wrap.append(el("span", "small", "Per adult, per month:"), range, rangeVal);
    ctl.append(wrap);
  }
  const eff = el("div", "lever-eff prop-eff");
  const e1 = el("span", "e1"), e2 = el("span", "e2"), e3 = el("span", "e3");
  eff.append(e1, e2, e3);
  c.append(top, ctl, eff);
  cards.set(p.id, { c, sw, seg, range, rangeVal, e1, e2, e3, p });
  return c;
}

export function updateProposals() {
  if (!cards.size) return;
  const sc = scoreProposals(ctx, model);
  const i = ctx.Y.indexOf(model.fy);
  let fyTot = 0, tenTot = 0;
  for (const [id, k] of cards) {
    const st = model.prop.get(id);
    const on = !!st;
    k.sw.checked = on;
    k.c.classList.toggle("on", on);
    const optKey = st?.opt || k.p.default;
    if (k.seg) k.seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.key === optKey));
    const amt = st?.amt ?? k.p.amount?.def;
    if (k.range) { if (document.activeElement !== k.range) k.range.value = amt; k.rangeVal.textContent = "$" + amt.toLocaleString("en-US"); }
    // Show what the proposal would cost even when it's off (at full strength, with its default phase-in).
    const full = costPath(ctx, k.p, optKey, amt).cost;
    const N = phaseOf(k.p);
    const path = on ? sc.byId[id] : full.map((v, j) => v * model.ramp(N, ctx.Y[j]));
    const fy = path[i], ten = tenYearCost(ctx, path);
    if (on) { fyTot += fy; tenTot += ten; }
    const cls = (v) => (v > 0.05 ? "add" : v < -0.05 ? "cut" : "none");
    k.e1.className = "e1 " + (on ? cls(fy) : "none");
    k.e2.className = "e2 " + (on ? cls(ten) : "none");
    const word = (v) => (v >= 0 ? "cost" : "savings");
    k.e1.textContent = Math.abs(fy) < 0.05 ? `nothing in ${model.fy}` : `${money(Math.abs(fy))} ${word(fy)} in ${model.fy}`;
    k.e2.textContent = `${money(Math.abs(ten))} ${word(ten)} over 10 years`;
    k.e3.textContent = N ? `phases in over ${N} years` : "\u00a0";
  }
  const head = $("#prop-summary");
  if (head) {
    head.textContent = "";
    const a = el("div"), b = el("div");
    a.append(el("span", "label", "Proposals switched on"), el("span", "val", String(model.prop.size)));
    b.append(el("span", "label", "Their cost"),
      el("span", "val " + (fyTot > 0.05 ? "out" : fyTot < -0.05 ? "in" : ""), model.prop.size ? `${money(Math.abs(fyTot))} in ${model.fy}` : "none yet"),
      el("span", "sub", model.prop.size ? `${money(Math.abs(tenTot))} ${tenTot >= 0 ? "added to" : "saved from"} deficits over 10 years` : ""));
    head.append(a, b);
  }
}

export function openProp(p) {
  const st = model.prop.get(p.id);
  const facts = [];
  for (const o of p.options) facts.push([p.options.length > 1 ? o.label : "Estimate", o.note || ""]);
  facts.push(["Source", p.source?.name || ""]);
  facts.push(["Scaling", p.options.some((o) => ["window", "annual", "gdp"].includes(o.kind)) ? "Held at the same share of GDP as the original estimate, so it grows with the economy." : "Computed directly; see the description."]);
  if (p.older) facts.push(["Note", "This estimate is several years old or was made before later law changes; treat it as approximate."]);
  if ((p.phase ?? 0) > 0) facts.push(["Default phase-in", `${p.phase} years`]);
  drawer({
    path: "Proposals › " + proposalData().groups.find((g) => g.id === p.group).name,
    title: p.name,
    desc: p.desc,
    facts,
    links: [[p.source?.url, "Source ↗"]].filter((x) => x[0]),
    phase: st ? {
      value: model.propPh.has(p.id) ? model.propPh.get(p.id) : null,
      defaultLabel: `Proposal default (${(p.phase ?? 0) ? p.phase + " years" : "immediately"})`,
      set: (n) => { model.setPropPhase(p.id, n); onChange(); },
    } : null,
  });
}

// For the Changes tab
export function proposalChanges() {
  if (!proposalData()) return [];
  const sc = scoreProposals(ctx, model);
  const i = ctx.Y.indexOf(model.fy);
  return [...model.prop.entries()].map(([id, st]) => {
    const p = proposalById(id);
    if (!p) return null;
    const path = sc.byId[id] || [];
    const o = p.options.find((x) => x.key === st.opt) || p.options[0];
    return { p, fy: path[i] || 0, ten: tenYearCost(ctx, path), what: (p.amount ? `$${st.amt}/month` : p.options.length > 1 ? o.label : "On") + (phaseOf(p) ? ` · ${phaseOf(p)}-yr phase-in` : "") };
  }).filter(Boolean);
}
