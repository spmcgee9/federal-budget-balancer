#!/usr/bin/env python3
"""
Build data/taxcurve.json from IRS Statistics of Income tables (tax year 2023).

Usage:
    pip install xlrd
    python scripts/build_taxcurve.py --t34 23in34tr.xls --t11 23in11si.xls

Table 3.4 classifies returns by the highest rate their income reached and reports, for each class,
the number of returns, taxable income at all rates, and the income taxed at that top rate. A return
whose top rate is 24% has filled the 10%, 12%, and 22% brackets completely, so the income taxed in each
bracket across all returns can be rebuilt exactly. Returns whose top rate is a capital gains rate are
treated as having (taxable income - income at the top rate) of ordinary income.

Table 1.1 gives returns, taxable income, and tax by size of adjusted gross income, used to show how
a change is spread across income groups.
"""
import argparse
import json
import os
import re
import sys

try:
    import xlrd
except ImportError:
    sys.exit("Please `pip install xlrd` first.")

YEAR = 2023
# 2023 ordinary brackets: where each rate starts (IRS Rev. Proc. 2022-38).
RATES = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37]
T2023 = {
    "single": [0, 11000, 44725, 95375, 182100, 231250, 578125],
    "joint": [0, 22000, 89450, 190750, 364200, 462500, 693750],
    "hoh": [0, 15700, 59850, 95350, 182100, 231250, 578100],
    "mfs": [0, 11000, 44725, 95375, 182100, 231250, 346875],
}
SECTIONS = [("joint", r"married persons filing jointly"), ("mfs", r"married persons filing separately"),
            ("hoh", r"heads of household"), ("single", r"single persons")]
AGI_GROUPS = [  # (label, IRS row labels that start with these)
    ("Under $25,000", ["$1 under $5,000", "$5,000 under", "$10,000 under", "$15,000 under", "$20,000 under"]),
    ("$25,000–$50,000", ["$25,000 under", "$30,000 under", "$40,000 under"]),
    ("$50,000–$100,000", ["$50,000 under", "$75,000 under"]),
    ("$100,000–$200,000", ["$100,000 under"]),
    ("$200,000–$500,000", ["$200,000 under"]),
    ("$500,000–$1 million", ["$500,000 under"]),
    ("$1–$5 million", ["$1,000,000 under", "$1,500,000 under", "$2,000,000 under"]),
    ("$5 million or more", ["$5,000,000 under", "$10,000,000 or more"]),
]


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def read(path):
    sh = xlrd.open_workbook(path).sheet_by_index(0)
    return [[sh.cell_value(i, j) for j in range(sh.ncols)] for i in range(sh.nrows)]


def table34(path):
    rows = read(path)
    out = {}
    for st, rx in SECTIONS:
        start = next(i for i, r in enumerate(rows) if re.search(rx, str(r[0]), re.I))
        classes = {}
        for r in rows[start + 1:start + 18]:
            lab = str(r[0]).strip().lower()
            if lab.startswith("returns of"):
                break
            classes[lab] = (num(r[1]), num(r[3]) * 1000, num(r[4]) * 1000)  # returns, TI all rates $, TI at top rate $
        L = T2023[st]
        K = len(L)
        width = [L[j + 1] - L[j] for j in range(K - 1)] + [None]
        B = [0.0] * K       # income taxed in each bracket
        N = [0.0] * K       # returns whose ordinary income tops out in each bracket
        for k, rate in enumerate(RATES):
            n, ti, top = classes.get(f"{int(rate * 100)} percent", (0, 0, 0))
            N[k] += n
            for j in range(k):
                B[j] += n * width[j]
            B[k] += top
        for lab, (n, ti, top) in classes.items():
            if "capital gains" not in lab or n <= 0:
                continue
            o = max(0.0, (ti - top) / n)  # average ordinary taxable income per return
            for j in range(K):
                hi = L[j + 1] if j + 1 < K else float("inf")
                B[j] += n * max(0.0, min(o, hi) - L[j])
            kk = max(j for j in range(K) if o > L[j]) if o > 0 else 0
            N[kk] += n
        tax = sum(RATES[j] * B[j] for j in range(K))
        out[st] = {"L": L, "N": [round(x) for x in N], "B": [round(x) for x in B], "ordTax": round(tax)}
    total = next(r for r in rows if str(r[0]).strip().lower() == "all tax rates")
    return out, {"returns": num(total[1]), "taxAfterCredits": num(total[7]) * 1000, "taxGenerated": num(total[5]) * 1000}


def table11(path):
    rows = read(path)
    end = next(i for i, r in enumerate(rows) if str(r[0]).lower().startswith("accumulated"))
    body = rows[:end]
    groups = []
    for label, starts in AGI_GROUPS:
        n = nt = ti = tax = agi = 0.0
        for r in body:
            lab = str(r[0]).strip()
            if any(lab.startswith(s) for s in starts):
                n += num(r[1]); agi += num(r[3]) * 1000; nt += num(r[10]); ti += num(r[11]) * 1000; tax += num(r[14]) * 1000
        groups.append({"label": label, "returns": round(n), "agi": round(agi), "tiReturns": round(nt), "ti": round(ti), "tax": round(tax)})
    return groups


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--t34", required=True)
    ap.add_argument("--t11", required=True)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "taxcurve.json"))
    a = ap.parse_args()
    st, tot = table34(a.t34)
    groups = table11(a.t11)
    data = {
        "year": YEAR, "rates": RATES, "thresholds": T2023, "statuses": st, "totals": tot, "agiGroups": groups,
        "source": "IRS Statistics of Income, Individual Income Tax Returns, tax year 2023 (Tables 1.1 and 3.4)",
        "url": "https://www.irs.gov/statistics/soi-tax-stats-individual-income-tax-returns-complete-report-publication-1304",
    }
    with open(a.out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    ord_tax = sum(v["ordTax"] for v in st.values())
    print(f"Ordinary-rate tax rebuilt from brackets: ${ord_tax/1e9:,.0f}B; IRS tax generated (incl. capital gains): "
          f"${tot['taxGenerated']/1e9:,.0f}B; after credits: ${tot['taxAfterCredits']/1e9:,.0f}B")
    for k, v in st.items():
        print(f"  {k:6} returns w/ taxable income {sum(v['N'])/1e6:6.1f}M  ordinary tax ${v['ordTax']/1e9:7.1f}B")
    print("AGI groups:", [(g["label"], round(g["tax"] / 1e9)) for g in groups])


if __name__ == "__main__":
    main()
