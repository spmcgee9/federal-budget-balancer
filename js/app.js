import { BudgetModel, fmt, fmtPct } from "./model.js";
import { initProjections, render as renderProjections } from "./projections-ui.js";

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let model;
const rendered = new Map(); // nodeId -> [row elements] (a node can show in the tree and in search)
const expanded = new Set();

const KIND_LABEL = { D: "Discretionary", M: "Mandatory", mixed: "Mixed", X: "Locked" };
const LOCK_TEXT = {
  mandatory: "Mandatory spending. Turn on “Allow changes to mandatory programs” above to edit it.",
  computed: "Interest on the debt follows from borrowing and interest rates, so it can't be cut directly. It will be calculated from your plan in Projections.",
  allowance: "Allowances are placeholder amounts for costs or savings the budget expects but hasn't assigned to specific programs, so they're locked.",
  transfer: "An internal transfer: one part of the government paying another (for example, the general fund paying into a trust fund). The receiving side shows up as a matching negative entry, so cutting this would create savings that don't exist. Cut the programs the money pays for instead.",
  offset: "Offsetting receipts: money the government collects that is netted against spending. Not a spending program, so it's locked.",
};

async function init() {
  const [data, desc, proj] = await Promise.all([
    fetch("data/budget.json").then((r) => r.json()),
    fetch("data/descriptions.json").then((r) => r.json()).catch(() => null),
    fetch("data/projections.json").then((r) => r.json()).catch(() => null),
  ]);
  model = new BudgetModel(data, desc);
  if (proj) initProjections(proj, model);
  else $("[data-panel=projections]").prepend(Object.assign(document.createElement("p"), { className: "note", textContent: "Projection data couldn't be loaded." }));
  document.querySelectorAll("[data-fy]").forEach((e) => (e.textContent = "FY" + model.fy));
  document.querySelectorAll("[data-fy-num]").forEach((e) => (e.textContent = model.fy));
  document.querySelectorAll("[data-src]").forEach((e) => (e.href = model.meta.sourceUrls?.[0] || "#"));
  $("#gen").textContent = `Data built ${model.meta.generated}.`;

  if (location.hash.length > 1) model.decode(decodeURIComponent(location.hash.slice(1)));
  $("#mand-toggle").checked = model.mandatoryUnlocked;

  renderTree();
  renderRevenue();
  refresh();
  wire();
}

// ---------- tree ----------
function renderTree() {
  const tree = $("#tree");
  tree.textContent = "";
  rendered.clear();
  for (const r of model.roots) tree.append(renderNode(r, 0));
}

function renderNode(n, depth, opts = {}) {
  const wrap = el("div", "node");
  const row = el("div", `row depth-${Math.min(depth, 4)} t-${n.type}`);
  row.dataset.id = n.id;
  row.setAttribute("role", "treeitem");

  const lead = el("div", "lead");
  if (n.children && !opts.flat) {
    const chev = el("button", "chev", "▸");
    chev.setAttribute("aria-label", "Expand " + n.name);
    chev.addEventListener("click", () => toggleExpand(n, wrap, depth));
    lead.append(chev);
  } else lead.append(el("span", "chev-spacer"));

  const nameBox = el("div", "namebox");
  const name = el("button", "name", n.name);
  name.title = n.children ? "Expand" : "What is this?";
  name.addEventListener("click", () => (n.children && !opts.flat ? toggleExpand(n, wrap, depth) : openDrawer(n)));
  nameBox.append(name);
  if (opts.flat) nameBox.append(el("div", "path", model.path(n).join(" › ")));
  const tags = el("div", "tags");
  nameBox.append(tags);
  lead.append(nameBox);

  const amt = el("div", "amt");
  const ctr = el("div", "ctrls");
  const sw = el("input", "switch");
  sw.type = "checkbox";
  sw.setAttribute("aria-label", "Fund " + n.name);
  sw.addEventListener("change", () => change(n, { on: sw.checked }));
  const range = el("input", "range");
  range.type = "range"; range.min = -100; range.max = 100; range.step = 1;
  range.setAttribute("aria-label", "Change " + n.name + " by percent");
  range.addEventListener("input", () => change(n, { pct: +range.value, on: true }, true));
  range.addEventListener("change", () => commit());
  const numBox = el("label", "numbox");
  const num = el("input", "num");
  num.type = "number"; num.step = 1; num.min = -100; num.max = 1000;
  num.setAttribute("aria-label", "Percent change for " + n.name);
  num.addEventListener("change", () => {
    let v = Math.max(-100, Math.min(1000, +num.value || 0));
    change(n, { pct: v, on: true });
  });
  numBox.append(num, el("span", "", "%"));
  const reset = el("button", "reset", "↺");
  reset.title = "Reset to baseline";
  reset.setAttribute("aria-label", "Reset " + n.name);
  reset.addEventListener("click", () => { model.resetNode(n.id); refresh(); commit(); });
  const info = el("button", "info", "?");
  info.title = "What is this?";
  info.setAttribute("aria-label", "What is " + n.name + "?");
  info.addEventListener("click", () => openDrawer(n));
  const lock = el("span", "lock");
  ctr.append(sw, range, numBox, reset, lock, info);

  row.append(lead, amt, ctr);
  row._parts = { sw, range, num, amt, tags, reset, lock, ctr };
  wrap.append(row);
  const list = rendered.get(n.id) || [];
  list.push(row);
  rendered.set(n.id, list);
  if (!opts.flat && expanded.has(n.id)) {
    const kids = el("div", "kids");
    for (const c of visibleKids(n)) kids.append(renderNode(c, depth + 1));
    wrap.append(kids);
    row.classList.add("open");
  }
  updateRow(row, n);
  return wrap;
}

function toggleExpand(n, wrap, depth) {
  const row = wrap.firstChild;
  if (expanded.has(n.id)) {
    expanded.delete(n.id);
    wrap.querySelector(":scope > .kids")?.remove();
    row.classList.remove("open");
    pruneRendered();
  } else {
    expanded.add(n.id);
    const kids = el("div", "kids");
    for (const c of visibleKids(n)) kids.append(renderNode(c, depth + 1));
    wrap.append(kids);
    row.classList.add("open");
  }
}

// Accounts with no money in the budget year are hidden to keep lists readable.
const visibleKids = (n) => n.children.filter((c) => Math.abs(c.base) >= 0.5 || Math.abs(c.eff - c.base) >= 0.5);

function pruneRendered() {
  for (const [id, rows] of rendered) {
    const live = rows.filter((r) => r.isConnected);
    if (live.length) rendered.set(id, live); else rendered.delete(id);
  }
}

function updateRow(row, n) {
  const p = row._parts;
  const st = model.controlState(n);
  const kind = model.kind(n);
  const changed = Math.abs(n.eff - n.base) > 0.05;
  const lockR = n.leaf ? model.lockReason(n) : (st.editable ? null : groupLockReason(n));

  // amount
  // Always two lines (amount, then change) so rows don't jump when a slider crosses zero.
  p.amt.textContent = "";
  const line1 = el("span", "amt-line");
  if (changed) line1.append(el("span", "was", fmt(n.base)), el("span", "arrow", "→"), el("span", "now", fmt(n.eff)));
  else line1.append(el("span", "now", fmt(n.base)));
  const d = n.eff - n.base;
  const line2 = changed
    ? el("span", "delta " + (d < 0 ? "cut" : "add"), fmt(d, { sign: true }))
    : el("span", "delta none", lockR ? "\u00a0" : "no change");
  p.amt.append(line1, line2);

  // tags
  p.tags.textContent = "";
  const chip = el("span", "chip " + (kind === "mixed" ? "mixed" : kind), KIND_LABEL[kind]);
  if (!n.leaf) chip.title = `${fmt(n.baseD)} discretionary, ${fmt(n.baseM)} mandatory`;
  p.tags.append(chip);
  if (n.type === "function" && n.base > 0) {
    const sh = (n.base / model.totalOutlays) * 100;
    p.tags.append(el("span", "share", `${sh < 1 ? sh.toFixed(1) : Math.round(sh)}% of spending`));
  }
  if (n.mChanged > 0) p.tags.append(el("span", "chip warn", "⚠ Mandatory changed"));
  if (!n.leaf && st.editable && n.baseM > 0.5 && !model.mandatoryUnlocked) {
    p.tags.append(el("span", "scope", `controls apply to ${fmt(n.adjBase)} discretionary`));
  }

  // controls
  row.classList.toggle("changed", changed);
  row.classList.toggle("m-changed", n.mChanged > 0);
  row.classList.toggle("locked", !!lockR);
  p.sw.hidden = p.range.hidden = p.num.parentElement.hidden = !!lockR;
  p.lock.hidden = !lockR;
  p.lock.textContent = lockR ? "🔒" : "";
  p.lock.title = lockR ? LOCK_TEXT[lockR] : "";
  p.reset.hidden = !(changed || model.settings.has(n.id));
  if (!lockR) {
    p.sw.checked = st.on;
    p.sw.indeterminate = st.mixed;
    const v = st.on ? Math.round(st.pct) : -100;
    if (document.activeElement !== p.range) p.range.value = Math.max(-100, Math.min(100, v));
    if (document.activeElement !== p.num) p.num.value = st.on ? +st.pct.toFixed(1) : -100;
    p.range.disabled = p.num.disabled = !st.on;
    const f = (Math.max(-100, Math.min(100, v)) + 100) / 2;
    const col = v < 0 ? "var(--in)" : "var(--out)";
    const [a, b] = v < 0 ? [f, 50] : [50, f];
    p.range.style.setProperty("--track", `linear-gradient(90deg, var(--line) 0 ${a}%, ${col} ${a}% ${b}%, var(--line) ${b}% 100%)`);
    row.classList.toggle("is-off", !st.on && !st.mixed);
  } else row.classList.remove("is-off");
}

function groupLockReason(n) {
  if (n.baseM > 0.5 && !model.mandatoryUnlocked) return "mandatory";
  if (n.fn.code === "900") return "computed";
  if (n.fn.code === "920") return "allowance";
  let xfer = false;
  (function scan(m) { if (m.leaf) { if (m.xfer) xfer = true; } else m.children.forEach(scan); })(n);
  return xfer ? "transfer" : "offset";
}

function change(n, patch, live = false) {
  model.setNode(n.id, patch);
  refresh();
  if (!live) commit();
}

// Update every visible row plus the scoreboard.
function refresh() {
  for (const [id, rows] of rendered) {
    const n = model.nodes.get(id);
    for (const r of rows) updateRow(r, n);
  }
  renderScore();
  if (!$("[data-panel=changes]").hidden) renderChanges();
  if (!$("[data-panel=projections]").hidden) scheduleProjections();
  updateChangeCount();
}

let projTimer;
function scheduleProjections() {
  clearTimeout(projTimer);
  projTimer = setTimeout(renderProjections, 60);
}

let commitTimer;
function commit() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    const s = model.encode();
    const h = s === "v1;m0" ? "" : "#" + s;
    history.replaceState(null, "", location.pathname + location.search + h);
  }, 250);
}

// ---------- scoreboard ----------
function renderScore() {
  const R = model.planReceipts, O = model.planOutlays;
  const R0 = model.totalReceipts, O0 = model.totalOutlays;
  const bal = R - O, bal0 = R0 - O0;
  $("#sc-rev").textContent = fmt(R);
  $("#sc-out").textContent = fmt(O);
  const dO = O - O0;
  $("#sc-out-d").textContent = Math.abs(dO) > 0.05 ? `${fmt(dO, { sign: true })} vs. baseline` : "baseline";
  $("#sc-rev-d").textContent = Math.abs(R - R0) > 0.05 ? `${fmt(R - R0, { sign: true })} vs. baseline` : "baseline";
  $("#sc-bal-label").textContent = bal >= 0 ? "Surplus" : "Deficit";
  const balEl = $("#sc-bal");
  balEl.textContent = fmt(Math.abs(bal));
  balEl.className = "val " + (bal >= 0 ? "in" : "out");
  const closed = bal - bal0;
  const base = `${bal0 < 0 ? "Baseline deficit" : "Baseline surplus"} ${fmt(Math.abs(bal0))}`;
  let note = "Your plan matches the President's budget";
  if (Math.abs(closed) > 0.05) {
    note = closed > 0
      ? `${base} · you cut ${fmt(closed)}${bal0 < 0 ? ` (${Math.min(999, Math.round((closed / -bal0) * 100))}% of the gap)` : ""}`
      : `${base} · you added ${fmt(-closed)}`;
  }
  $("#sc-bal-d").textContent = note;

  // Spending bar, split into mandatory / interest / defense / nondefense.
  const max = Math.max(R, O, O0);
  $("#bar-rev").style.width = (R / max) * 100 + "%";
  const seg = model.seg.eff;
  const segTotal = seg.M + seg.I + seg.DD + seg.ND;
  for (const k of ["M", "I", "DD", "ND"]) {
    const w = Math.max(0, seg[k]) / max * 100;
    $(`#bar-out [data-seg=${k}]`).style.width = w + "%";
    const pct = (seg[k] / segTotal) * 100;
    $(`#seg-legend [data-leg=${k}] b`).textContent = Math.round(pct) + "%";
  }
  $("#bar-out-base").style.left = (O0 / max) * 100 + "%";
  const lockedM = !model.mandatoryUnlocked;
  $("#bar-out").classList.toggle("m-locked", lockedM);
  $("#seg-legend").classList.toggle("m-locked", lockedM);
  const lockedShare = Math.round(((lockedM ? seg.M : 0) + seg.I) / segTotal * 100);

  // Status line under the scoreboard. It is always present (no layout jump); only its message changes.
  let mTotal = 0;
  for (const c of model.changes.values()) mTotal += c.deltaM;
  const paused = model.pausedMandatoryCount();
  const flag = $("#mand-flag");
  let state, icon, text;
  if (Math.abs(mTotal) > 0.05) {
    state = "changed"; icon = "⚠";
    text = `Your plan changes mandatory programs by ${fmt(mTotal, { sign: true })}. That requires Congress to change existing law.`;
  } else if (!lockedM) {
    state = "unlocked"; icon = "⚠";
    text = "Mandatory programs unlocked. Changing them requires Congress to rewrite existing law.";
  } else if (paused) {
    state = "paused"; icon = "⏸";
    text = `${paused} mandatory change${paused > 1 ? "s are" : " is"} paused while mandatory programs are locked.`;
  } else {
    state = "locked"; icon = "🔒";
    text = `${lockedShare}% of spending (mandatory programs and interest) is locked. You can change the other ${100 - lockedShare}%.`;
  }
  flag.dataset.state = state;
  $("#mand-flag-icon").textContent = icon;
  $("#mand-flag-text").textContent = text;
}

// ---------- changes ----------
function updateChangeCount() {
  const n = model.changes.size;
  const c = $("#chg-count");
  c.hidden = n === 0;
  c.textContent = n;
}

function renderChanges() {
  const box = $("#changes");
  box.textContent = "";
  const entries = [...model.changes.entries()]
    .filter(([, c]) => Math.abs(c.delta) > 0.05 || c.leaves)
    .map(([id, c]) => ({ n: model.nodes.get(id), s: model.settings.get(id), c }));
  if (!entries.length) {
    box.append(el("p", "empty", "No changes yet. Use the sliders on the Spending tab: move a whole category, or open it up and adjust individual programs."));
    return;
  }
  let cuts = 0, adds = 0, mand = 0;
  for (const e of entries) {
    if (e.c.delta < 0) cuts += e.c.delta; else adds += e.c.delta;
    mand += e.c.deltaM;
  }
  const sum = el("div", "chg-sum");
  sum.append(
    stat("Spending cuts", fmt(cuts), "cut"),
    stat("Spending increases", fmt(adds, { sign: true }), "add"),
    cuts + adds <= 0
      ? stat("Deficit reduction", fmt(-(cuts + adds)), "cut")
      : stat("Deficit increase", fmt(cuts + adds), "add"),
  );
  if (Math.abs(mand) > 0.05) sum.append(stat("…of which mandatory", fmt(mand, { sign: true }), "warn"));
  box.append(sum);

  const groups = [
    ["Mandatory program changes", entries.filter((e) => Math.abs(e.c.deltaM) > 0.05), true],
    ["Discretionary changes", entries.filter((e) => Math.abs(e.c.deltaM) <= 0.05), false],
  ];
  for (const [title, list, warn] of groups) {
    if (!list.length) continue;
    const sec = el("div", "chg-group" + (warn ? " warn" : ""));
    sec.append(el("h3", "", (warn ? "⚠ " : "") + title));
    if (warn) sec.append(el("p", "small", "Mandatory spending is set by permanent law. Changing it takes new legislation, not just a different appropriation."));
    list.sort((a, b) => a.c.delta - b.c.delta);
    for (const { n, s, c } of list) {
      const r = el("div", "chg-row");
      const left = el("div", "chg-name");
      left.append(el("button", "linklike", n.name));
      left.firstChild.addEventListener("click", () => revealInTree(n));
      left.append(el("div", "path", model.path(n).join(" › ") || "Budget function"));
      const what = s.on ? `${fmtPct(s.pct)}` : "Turned off";
      const mid = el("div", "chg-what", what + (c.leaves > 1 ? ` · ${c.leaves} accounts` : ""));
      const right = el("div", "chg-amt " + (c.delta < 0 ? "cut" : "add"), fmt(c.delta, { sign: true }));
      const undo = el("button", "reset", "↺");
      undo.title = "Undo this change";
      undo.addEventListener("click", () => { model.resetNode(n.id); refresh(); commit(); });
      r.append(left, mid, right, undo);
      sec.append(r);
    }
    box.append(sec);
  }
}

function stat(label, val, cls) {
  const d = el("div", "stat " + cls);
  d.append(el("span", "label", label), el("span", "val", val));
  return d;
}

function revealInTree(n) {
  selectTab("spending");
  clearSearch();
  const chain = [];
  for (let p = n.parent; p; p = p.parent) chain.unshift(p.id);
  chain.forEach((id) => expanded.add(id));
  renderTree();
  refresh();
  const row = rendered.get(n.id)?.[0];
  if (row) {
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 1600);
  }
}

// ---------- revenue ----------
function renderRevenue() {
  const box = $("#revenue");
  box.textContent = "";
  const bi = model.bi;
  const max = Math.max(...model.receipts.map((r) => r.v[bi]));
  for (const r of model.receipts) {
    const row = el("div", "rev-row");
    row.append(el("span", "rev-name", r.name), el("span", "rev-amt", fmt(r.v[bi])));
    const bar = el("div", "rev-bar");
    const fill = el("span");
    fill.style.width = Math.max(0, (r.v[bi] / max) * 100) + "%";
    bar.append(fill);
    row.append(bar);
    box.append(row);
  }
  const tot = el("div", "rev-row total");
  tot.append(el("span", "rev-name", "Total revenue"), el("span", "rev-amt", fmt(model.totalReceipts)));
  box.append(tot);
}

// ---------- drawer ----------
function openDrawer(n) {
  $("#drawer-path").textContent = model.path(n).join(" › ") || "Budget function";
  $("#drawer-title").textContent = n.name;
  const desc = model.description(n);
  $("#drawer-desc").textContent = desc || fallbackDesc(n);
  $("#drawer-desc").classList.toggle("muted", !desc);
  const facts = $("#drawer-facts");
  facts.textContent = "";
  const add = (k, v) => { if (v) facts.append(el("dt", "", k), el("dd", "", v)); };
  add(`FY${model.fy} request`, fmt(n.base));
  if (Math.abs(n.eff - n.base) > 0.05) add("Your plan", `${fmt(n.eff)} (${fmt(n.eff - n.base, { sign: true })})`);
  const kind = model.kind(n);
  add("Type", !n.leaf && n.baseD > 0.5 && n.baseM > 0.5 ? `Mixed: ${fmt(n.baseD)} discretionary, ${fmt(n.baseM)} mandatory` : KIND_LABEL[kind] === "Locked" ? "Locked (interest, transfer, or offsetting receipt)" : KIND_LABEL[kind]);
  if (n.leaf) {
    add("Agency", n.agency);
    if (n.bureau && n.bureau !== n.agency) add("Bureau", n.bureau);
    if (n.off) add("Budget status", "Off-budget (counted in the total deficit)");
    const lockR = model.lockReason(n);
    if (lockR) add("Why locked", LOCK_TEXT[lockR]);
  } else {
    add("Contains", `${n.nLeaves} budget account${n.nLeaves === 1 ? "" : "s"}`);
  }
  add("Share of all spending", ((n.base / model.totalOutlays) * 100).toFixed(n.base / model.totalOutlays < 0.01 ? 2 : 1) + "%");
  const links = $("#drawer-links");
  links.textContent = "";
  if (n.leaf && n.tac && /^\d{3}$/.test(n.tac) && n.acct) {
    const a = el("a", "", "Spending details on USAspending.gov ↗");
    a.href = `https://www.usaspending.gov/federal_account/${n.tac}-${n.acct.slice(-4)}`;
    a.target = "_blank"; a.rel = "noopener";
    links.append(a);
  }
  const src = el("a", "", "Source data (OMB) ↗");
  src.href = model.meta.sourceUrls?.[0] || "#";
  src.target = "_blank"; src.rel = "noopener";
  links.append(src);
  $("#drawer").hidden = false;
  $("#drawer-close").focus();
}

function fallbackDesc(n) {
  if (n.leaf) {
    const where = n.bureau && n.bureau !== n.agency ? `${n.bureau}, ${n.agency}` : n.agency;
    return `A budget account run by ${where}, classified under ${model.path(n).slice(-1)[0] || "this budget function"}. A plain-language description for this account hasn't been written yet; the USAspending link below shows what it pays for.`;
  }
  return `A group of related budget accounts within ${model.path(n).slice(-1)[0] || "the federal budget"}.`;
}

// ---------- search ----------
let searchTimer;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = $("#search").value.trim().toLowerCase();
    const res = $("#search-results");
    if (q.length < 2) return clearSearch(true);
    const hits = model.search(q);
    res.textContent = "";
    rendered.clear();
    res.append(el("p", "small", `${hits.length} match${hits.length === 1 ? "" : "es"}${hits.length > 60 ? " (showing the top 60)" : ""}`));
    for (const n of hits.slice(0, 60)) res.append(renderNode(n, 0, { flat: true }));
    $("#tree").hidden = true;
    res.hidden = false;
    refresh();
  }, 150);
}

function clearSearch(keepText) {
  if (!keepText) $("#search").value = "";
  $("#search-results").hidden = true;
  $("#tree").hidden = false;
  renderTree();
  refresh();
}

// ---------- tabs & wiring ----------
function selectTab(name) {
  document.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === "changes") renderChanges();
  if (name === "projections") renderProjections();
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), 2400);
}

function wire() {
  document.querySelectorAll("[role=tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
  $("#mand-toggle").addEventListener("change", (e) => {
    model.setMandatoryUnlocked(e.target.checked);
    refresh();
    commit();
  });
  $("#search").addEventListener("input", onSearch);
  $("#drawer-close").addEventListener("click", () => ($("#drawer").hidden = true));
  $("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") $("#drawer").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#drawer").hidden = true; });
  $("#reset-all").addEventListener("click", () => {
    if (!confirm("Reset every change back to the President's budget?")) return;
    model.resetAll();
    refresh();
    commit();
  });
  $("#share").addEventListener("click", async () => {
    commit();
    clearTimeout(commitTimer);
    const s = model.encode();
    const url = location.origin + location.pathname + (s === "v1;m0" ? "" : "#" + s);
    history.replaceState(null, "", url);
    try { await navigator.clipboard.writeText(url); toast("Link copied. Anyone who opens it sees your plan."); }
    catch { prompt("Copy this link:", url); }
  });
}

init().catch((err) => {
  console.error(err);
  $("#tree").innerHTML = `<p class="empty">Couldn't load the budget data (${err.message}). If you opened this file directly, serve the folder instead: <code>python -m http.server</code>.</p>`;
});
