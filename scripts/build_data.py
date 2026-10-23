#!/usr/bin/env python3
"""
Build the Budget Balancer's data file from OMB's Public Budget Database (PBD).

Usage (from the repo root):
    pip install openpyxl
    python scripts/build_data.py                      # downloads FY2027 files from OMB
    python scripts/build_data.py --outlays path/to/outlays_fy2027.xlsx \
                                 --receipts path/to/receipts_fy2027.xlsx

For a new budget year, pass --fy 2028 (the script builds the default OMB URLs
from it) or point --outlays / --receipts at the new files.

Output: data/budget.json  (all amounts in millions of dollars)

Source format (OMB PBD user's guide): amounts in thousands of dollars; one row per
account x subfunction x BEA category x grant/non-grant split; year columns 1962..BY+4.
Offsetting receipts appear as negative outlays. Receipts file = governmental receipts.
"""
import argparse
import datetime as dt
import io
import json
import os
import re
import sys
import urllib.request
from collections import OrderedDict, defaultdict

try:
    import openpyxl
except ImportError:
    sys.exit("Please `pip install openpyxl` first.")

OMB_BASE = "https://www.whitehouse.gov/wp-content/uploads/{pub}/outlays_fy{fy}.xlsx"

# Budget function titles (stable OMB classification).
FUNCTIONS = OrderedDict([
    ("050", "National Defense"),
    ("150", "International Affairs"),
    ("250", "General Science, Space, and Technology"),
    ("270", "Energy"),
    ("300", "Natural Resources and Environment"),
    ("350", "Agriculture"),
    ("370", "Commerce and Housing Credit"),
    ("400", "Transportation"),
    ("450", "Community and Regional Development"),
    ("500", "Education, Training, Employment, and Social Services"),
    ("550", "Health"),
    ("570", "Medicare"),
    ("600", "Income Security"),
    ("650", "Social Security"),
    ("700", "Veterans Benefits and Services"),
    ("750", "Administration of Justice"),
    ("800", "General Government"),
    ("900", "Net Interest"),
    ("920", "Allowances"),
    ("950", "Undistributed Offsetting Receipts"),
])

FIRST_YEAR, LAST_YEAR = 2025, 2031  # last actual year .. BY+4 (adjusted from file)


def load_workbook(src):
    """src is a local path or an https URL."""
    if re.match(r"^https?://", src):
        print(f"Downloading {src} ...")
        req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0 budget-balancer"})
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
        return openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    return openpyxl.load_workbook(src, read_only=True, data_only=True)


def norm(h):
    return re.sub(r"[^a-z0-9]+", " ", str(h or "").lower()).strip()


def read_rows(wb, required_header):
    """Yield dicts keyed by normalized header; finds the header row by a required column."""
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = None
    for row in rows:
        if any(norm(c) == required_header for c in row):
            header = [norm(c) for c in row]
            break
    if header is None:
        sys.exit(f"Could not find header row containing '{required_header}'.")
    for row in rows:
        if row is None or all(c in (None, "") for c in row):
            continue
        yield dict(zip(header, row)), header


def year_columns(header):
    years = {}
    for h in header:
        m = re.fullmatch(r"(?:fy )?(\d{4})(?: value)?", h)
        if m:
            years[int(m.group(1))] = h
    return years


def num(v):
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(",", "").replace("$", "").strip()
    if s in ("", "-", "--", ".."):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def pad(code, n):
    s = str(code if code is not None else "").strip()
    if s.endswith(".0"):
        s = s[:-2]
    return s.zfill(n) if s.isdigit() else s


def cat_code(bea):
    b = norm(bea)
    if b.startswith("mand"):
        return "M"
    if b.startswith("disc"):
        return "D"
    if "interest" in b:
        return "I"
    return "M"  # conservative: unknown categories are treated as locked mandatory


def build_outlays(src):
    wb = load_workbook(src)
    acc = OrderedDict()
    sub_titles = {}
    years = None
    for row, header in read_rows(wb, "agency code"):
        if years is None:
            ycols = year_columns(header)
            years = [y for y in range(FIRST_YEAR, max(ycols) + 1) if y in ycols]
        sub = pad(row.get("subfunction code"), 3)
        if not sub.isdigit():
            continue
        sub_titles[sub] = str(row.get("subfunction title") or "").strip()
        key = (
            sub,
            pad(row.get("agency code"), 3),
            pad(row.get("bureau code"), 2),
            pad(row.get("account code"), 6),
            cat_code(row.get("bea category")),
        )
        rec = acc.get(key)
        if rec is None:
            rec = acc[key] = {
                "agency": str(row.get("agency name") or "").strip(),
                "bureau": str(row.get("bureau name") or "").strip(),
                "account": str(row.get("account name") or "").strip(),
                "tac": pad(row.get("treasury agency code"), 3),
                "offBudget": norm(row.get("on or off budget indicator")).startswith("off"),
                "v": [0.0] * len(years),
            }
        for i, y in enumerate(years):
            rec["v"][i] += num(row.get(ycols[y])) / 1000.0  # thousands -> millions
    return acc, sub_titles, years


def build_receipts(src, years):
    wb = load_workbook(src)
    by_src = OrderedDict()
    ycols = None
    for row, header in read_rows(wb, "source category name"):
        if ycols is None:
            ycols = year_columns(header)
        name = str(row.get("source category name") or "Other").strip()
        sub = str(row.get("source subcategory name") or "").strip()
        s = by_src.setdefault(name, {"name": name, "v": [0.0] * len(years), "sub": OrderedDict()})
        for i, y in enumerate(years):
            val = num(row.get(ycols.get(y))) / 1000.0 if y in ycols else 0.0
            s["v"][i] += val
            if sub:
                s["sub"].setdefault(sub, [0.0] * len(years))
                s["sub"][sub][i] += val
    out = []
    for s in by_src.values():
        out.append({
            "name": s["name"],
            "v": [round(x) for x in s["v"]],
            "sub": [{"name": k, "v": [round(x) for x in v]} for k, v in s["sub"].items()],
        })
    return out


def build_tree(acc, sub_titles, years):
    # Detect accounts split across BEA categories, so their leaves get a suffix.
    split = defaultdict(set)
    for (sub, ag, bu, ac, cat), rec in acc.items():
        if any(abs(x) >= 0.5 for x in rec["v"]):
            split[(sub, ag, bu, ac)].add(cat)

    funcs = OrderedDict()
    for (sub, ag, bu, ac, cat), rec in acc.items():
        if all(abs(x) < 0.5 for x in rec["v"]):
            continue
        fcode = sub[:2] + "0"
        if fcode not in FUNCTIONS and sub.startswith("92"):
            fcode = "920"
        f = funcs.setdefault(fcode, OrderedDict())
        s = f.setdefault(sub, OrderedDict())
        g = s.setdefault((ag, bu), [])
        name = rec["account"]
        if len(split[(sub, ag, bu, ac)]) > 1:
            name += {"M": " (mandatory portion)", "D": " (discretionary portion)",
                     "I": " (interest portion)"}[cat]
        g.append({
            "id": f"a{sub}{ag}{bu}{ac}{cat}",
            "type": "account",
            "name": name,
            "agency": rec["agency"],
            "bureau": rec["bureau"],
            "tac": rec["tac"],
            "acct": ac,
            "cat": cat,
            "off": rec["offBudget"] or None,
            "v": [round(x) for x in rec["v"]],
        })

    tree = []
    for fcode in sorted(funcs, key=lambda c: list(FUNCTIONS).index(c) if c in FUNCTIONS else 99):
        fnode = {"id": f"f{fcode}", "type": "function", "code": fcode,
                 "name": FUNCTIONS.get(fcode, f"Function {fcode}"), "children": []}
        for sub, groups in sorted(funcs[fcode].items()):
            snode = {"id": f"s{sub}", "type": "subfunction", "code": sub,
                     "name": sub_titles.get(sub) or f"Subfunction {sub}", "children": []}
            if len(groups) == 1:
                snode["children"] = next(iter(groups.values()))
            else:
                for (ag, bu), leaves in groups.items():
                    if len(leaves) == 1:
                        snode["children"].append(leaves[0])
                        continue
                    first = leaves[0]
                    label = first["bureau"] or first["agency"]
                    snode["children"].append({"id": f"g{sub}-{ag}-{bu}", "type": "group",
                                              "name": label, "children": leaves})
            fnode["children"].append(snode)
        # A function with one subfunction of the same scope (e.g. 570 Medicare) is flattened.
        if len(fnode["children"]) == 1:
            only = fnode["children"][0]
            fnode["subCode"] = only["code"]
            fnode["children"] = only["children"]
        tree.append(fnode)
    return tree


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fy", type=int, default=2027, help="Budget fiscal year (default 2027)")
    ap.add_argument("--pub", default=None, help="OMB upload folder, e.g. 2026/04")
    ap.add_argument("--outlays")
    ap.add_argument("--receipts")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "budget.json"))
    a = ap.parse_args()

    pub = a.pub or f"{a.fy - 1}/04"
    outlays_src = a.outlays or OMB_BASE.format(pub=pub, fy=a.fy)
    receipts_src = a.receipts or OMB_BASE.format(pub=pub, fy=a.fy).replace("outlays_", "receipts_")

    acc, sub_titles, years = build_outlays(outlays_src)
    receipts = build_receipts(receipts_src, years)
    tree = build_tree(acc, sub_titles, years)

    bi = years.index(a.fy)
    receipts.sort(key=lambda s: -s["v"][bi])
    total_out = sum(r["v"][bi] for r in acc.values())
    total_rec = sum(s["v"][bi] for s in receipts)
    data = {
        "meta": {
            "fy": a.fy,
            "years": years,
            "units": "millions of dollars",
            "generated": dt.date.today().isoformat(),
            "source": "OMB Public Budget Database, Budget of the U.S. Government FY%d" % a.fy,
            "sourceUrls": [outlays_src if outlays_src.startswith("http") else OMB_BASE.format(pub=pub, fy=a.fy),
                           (receipts_src if receipts_src.startswith("http")
                            else OMB_BASE.format(pub=pub, fy=a.fy).replace("outlays_", "receipts_"))],
            "check": {"outlays": round(total_out, 1), "receipts": round(total_rec, 1),
                      "deficit": round(total_rec - total_out, 1)},
        },
        "receipts": receipts,
        "tree": tree,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    n_leaves = sum(1 for _ in acc)
    print(f"FY{a.fy}: outlays ${total_out/1e6:,.3f}T, receipts ${total_rec/1e6:,.3f}T, "
          f"deficit ${ (total_rec-total_out)/1e6:,.3f}T  ({n_leaves} account rows) -> {a.out}")


if __name__ == "__main__":
    main()
