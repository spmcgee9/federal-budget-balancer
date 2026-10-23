#!/usr/bin/env python3
"""
Build data/projections.json from CBO's published data files.

Usage (from the repo root):
    pip install openpyxl
    python scripts/build_projections.py --dir path/to/cbo_files

The folder must contain these CBO workbooks (file names can keep CBO's ids; matched by pattern):
    *LTBO-Budget*.xlsx        Long-Term Budget Outlook data, extended baseline   (cbo.gov/publication/62044)
    *LTBO-econ*.xlsx          Long-term economic projections                     (cbo.gov/publication/62044)
    *Budget-Projections*.xlsx 10-year baseline budget projections (check only)   (cbo.gov/publication/61882)
    62385-data.xlsx           CBO's analysis of the President's 2027 budget      (cbo.gov/publication/62385)
    61879-Data.xlsx           Demographic Outlook                                (cbo.gov/publication/61879)

Output: all dollar amounts in billions of nominal dollars, by fiscal year.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import sys

try:
    import openpyxl
except ImportError:
    sys.exit("Please `pip install openpyxl` first.")

# CBO's July 31, 2026 update on tariffs (cbo.gov/publication/62704): after the Supreme Court's
# February 20, 2026 ruling ended the IEEPA tariffs, net customs revenue is about $250 billion lower
# in FY2026 (about half of it refunds), and primary deficits are about $0.7 trillion larger over
# 2027-2036. CBO did not publish year-by-year figures, so the 2027-2036 loss is spread in
# proportion to the February baseline's customs revenue and continues at the same share afterward.
TARIFF_FY2026_LOSS = 250.0
TARIFF_2027_2036_LOSS = 700.0
TARIFF_URL = "https://www.cbo.gov/publication/62704"

# OMB's economic assumptions for the FY2027 President's budget (Analytical Perspectives, Table 1-1 and 1-2,
# calendar years; information as of November 2025). Used for the "OMB forecast" option.
OMB_URL = "https://www.whitehouse.gov/wp-content/uploads/2026/04/ap_1_assumptions_fy2027.pdf"
OMB_GDP = {2025: 30705, 2026: 32525, 2027: 34223, 2028: 35989, 2029: 37845, 2030: 39772, 2031: 41755,
           2032: 43821, 2033: 45988, 2034: 48261, 2035: 50646, 2036: 53154}          # nominal GDP, $B
OMB_10Y = {2026: 3.7, 2027: 3.5, 2028: 3.5, 2029: 3.4, 2030: 3.3, 2031: 3.3, 2032: 3.3, 2033: 3.3,
           2034: 3.3, 2035: 3.3, 2036: 3.3}
OMB_BILL = {y: 3.1 for y in range(2027, 2037)} | {2026: 3.2}
CBO_BILL_IN_OMB_TABLE = {2026: 3.5, 2027: 3.2, 2028: 3.2, 2029: 3.1, 2030: 3.1, 2031: 3.1, 2032: 3.1,
                         2033: 3.0, 2034: 3.0, 2035: 3.0, 2036: 3.0}  # CBO's bill rates as shown in OMB's Table 1-2


def find(d, pattern):
    hits = sorted(glob.glob(os.path.join(d, pattern)))
    if not hits:
        sys.exit(f"Missing CBO file matching {pattern} in {d}")
    return hits[-1]


def rows_of(path, sheet):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet] if sheet in wb.sheetnames else next(wb[s] for s in wb.sheetnames if s.startswith(sheet))
    return [list(r) for r in ws.iter_rows(values_only=True)]


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def num(v):
    return float(v) if isinstance(v, (int, float)) else None


def year_header(rows, min_year=1990):
    """Return (row_index, {col: year}) for the first row that looks like a header of years."""
    for i, r in enumerate(rows):
        cols = {j: int(c) for j, c in enumerate(r)
                if isinstance(c, (int, float)) and float(c).is_integer() and min_year <= c <= 2100}
        if len(cols) >= 8:
            return i, cols
    sys.exit("No year header found")


def series_by_label(rows, hdr_cols, label_re, start=0, col0=0):
    rx = re.compile(label_re, re.I)
    for r in rows[start:]:
        if r[col0] is not None and rx.search(norm(r[col0])):
            return {y: num(r[j]) for j, y in hdr_cols.items() if num(r[j]) is not None}
    sys.exit(f"Row not found: {label_re}")


def ltbo_budget(path):
    rows = rows_of(path, "1. Summary")
    # Header row has text labels; years are down column A.
    hi = next(i for i, r in enumerate(rows) if norm(r[0]) == "fiscal year")
    labels = [norm(c) for c in rows[hi]]
    # The two header rows above hold group names; we only need the leaf labels.
    def col(rx):
        rxc = re.compile(rx, re.I)
        for j, l in enumerate(labels):
            if rxc.search(l):
                return j
        sys.exit(f"LTBO column not found: {rx}")
    cols = {
        "rev_ind": col(r"^individual income"), "rev_pay": col(r"^payroll"), "rev_corp": col(r"^corporate"),
        "rev_cust": col(r"^customs"), "rev_oth": col(r"^other$"), "rev": col(r"^total$"),
        "ss": col(r"^social security"), "medicare": col(r"^medicare\w?$"), "health": col(r"^medicaid"),
        "othm": col(r"^other mandatory"), "disc": col(r"^discretionary"), "nonint": col(r"total noninterest"),
        "netint": col(r"net interest"), "out": col(r"^total spending"), "deficit": col(r"^total deficit"),
        "debt": col(r"debt held by the public"), "gdp": col(r"^gdp"),
    }
    # "other" appears twice (revenue other, other mandatory); make sure rev_oth is the first one.
    data = {}
    for r in rows[hi + 1:]:
        y = r[0]
        if not (isinstance(y, (int, float)) and 2000 <= y <= 2100):
            continue
        y = int(y)
        rec = {k: num(r[j]) for k, j in cols.items()}
        data[y] = rec
    return data


def ltbo_econ(path):
    rows = rows_of(path, "1. Econ Vars_Annual Rates")
    hi, ycols = year_header(rows)
    rate = series_by_label(rows, ycols, r"^on all federal debt held by the public", hi)
    ten = None
    # 10-year nominal rate: the "Nominal rates" row after "On 10-year Treasury notes"
    for i, r in enumerate(rows):
        if norm(r[0]).startswith("on 10-year treasury"):
            for r2 in rows[i + 1:i + 4]:
                if norm(r2[0]).startswith("nominal"):
                    ten = {y: num(r2[j]) for j, y in ycols.items() if num(r2[j]) is not None}
            break
    pop = series_by_label(rows, ycols, r"^population", hi)
    capshare = series_by_label(rows, ycols, r"^share of earnings below the taxable maximum", hi)
    lv = rows_of(path, "3. Econ Vars_Annual Levels")
    hi2, ycols2 = year_header(lv)
    price = series_by_label(lv, ycols2, r"^gdp price", hi2)
    wages = series_by_label(lv, ycols2, r"wage and salary disbursements", hi2)
    gdp_cy = series_by_label(lv, ycols2, r"^nominal gdp", hi2)
    return rate, ten, pop, price, capshare, wages, gdp_cy


def pb_effects(path):
    rows = rows_of(path, "Table 1")
    hi, ycols = year_header(rows, 2020)
    mand = series_by_label(rows, ycols, r"^total effect on mandatory", hi)
    # Defense / Nondefense rows under "Changes to discretionary spending"
    start = next(i for i, r in enumerate(rows) if norm(r[0]).startswith("changes to discretionary"))
    dd = series_by_label(rows, ycols, r"^defense$", start)
    nd = series_by_label(rows, ycols, r"^nondefense$", start)
    disc_pb_pct = series_by_label(rows, ycols, r"^under the president", next(
        i for i, r in enumerate(rows) if norm(r[0]).startswith("discretionary outlays")))
    return mand, dd, nd, disc_pb_pct


def demographics(path):
    rows = rows_of(path, "Figure 2")
    hi = next(i for i, r in enumerate(rows) if norm(r[1]).startswith("24 or younger"))
    out = {}
    for r in rows[hi + 1:]:
        if isinstance(r[0], (int, float)) and 1900 < r[0] < 2100:
            out[int(r[0])] = [num(x) for x in r[1:6]]
    return out


def check_10yr(path, lt):
    """Compare our LTBO-derived dollars with CBO's 10-year table (they should match closely)."""
    rows = rows_of(path, "Table 1-1")
    hi, ycols = year_header(rows, 2020)
    deficit = series_by_label(rows, ycols, r"^total deficit", hi)
    debt = series_by_label(rows, ycols, r"^debt held by the public", hi)
    worst = 0
    for y in range(2026, 2037):
        d_lt = lt[y]["deficit"] / 100 * lt[y]["gdp"] * 1000
        worst = max(worst, abs(d_lt - deficit[y]), abs(lt[y]["debt"] / 100 * lt[y]["gdp"] * 1000 - debt[y]) / 10)
    return {y: {"deficit": round(deficit[y], 1), "debt": round(debt[y], 1)} for y in range(2025, 2037)}, worst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="Folder with the CBO workbooks")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "projections.json"))
    a = ap.parse_args()

    lt = ltbo_budget(find(a.dir, "*LTBO-Budget*.xlsx"))
    rate, ten, pop, price, capshare, wages, gdp_cy = ltbo_econ(find(a.dir, "*LTBO-econ*.xlsx"))
    mand, dd, nd, disc_pb_pct = pb_effects(find(a.dir, "*62385*data*.xlsx"))
    demo = demographics(find(a.dir, "*61879*.xlsx"))
    check, worst = check_10yr(find(a.dir, "*Budget-Projections*.xlsx"), lt)

    years = sorted(y for y in lt if y >= 2026)
    g = lambda y: lt[y]["gdp"] * 1000  # $ billions
    pct = lambda y, k: lt[y][k] / 100 * g(y)
    r = lambda x: round(x, 1)

    base = {k: [] for k in ["rev", "rev_ind", "rev_pay", "rev_corp", "rev_cust", "rev_oth",
                            "ss", "medicare", "health", "othm", "disc", "netint", "deficit", "debt"]}
    for y in years:
        for k in base:
            base[k].append(r(pct(y, k)))

    # President's budget adjustments (CBO estimate), $ billions. After 2036 CBO publishes nothing;
    # we hold the budget's 2036 discretionary level relative to current law constant as a share of GDP.
    gap36 = (dd[2036] + nd[2036]) / g(2036)
    pb_mand, pb_dd, pb_nd = [], [], []
    for y in years:
        if y <= 2036:
            pb_mand.append(r(mand.get(y, 0))); pb_dd.append(r(dd.get(y, 0))); pb_nd.append(r(nd.get(y, 0)))
        else:
            share_d = dd[2036] / (dd[2036] + nd[2036]) if (dd[2036] + nd[2036]) else 0.5
            tot = gap36 * g(y)
            pb_mand.append(0.0); pb_dd.append(r(tot * share_d)); pb_nd.append(r(tot * (1 - share_d)))

    cust = {y: pct(y, "rev_cust") for y in years}
    frac = TARIFF_2027_2036_LOSS / sum(cust[y] for y in range(2027, 2037))
    tariff = [r(TARIFF_FY2026_LOSS if y == 2026 else cust[y] * frac) for y in years]

    p0 = price[2026]
    # OMB forecast relative to CBO: GDP ratio, and a shift in the average interest rate on debt
    # (half bills, half 10-year notes). After 2036, OMB's level of GDP relative to CBO's is held constant.
    omb_ratio, omb_dr = [], []
    for y in years:
        yy = min(y, 2036)
        omb_ratio.append(round(OMB_GDP[yy] / (gdp_cy[yy] * 1000), 4))
        omb_dr.append(round(0.5 * (OMB_10Y[yy] - ten[yy]) + 0.5 * (OMB_BILL[yy] - CBO_BILL_IN_OMB_TABLE[yy]), 3))
    out = {
        "meta": {
            "generated": dt.date.today().isoformat(),
            "units": "billions of nominal dollars, fiscal years",
            "years": years,
            "check": {"maxDiffVs10yrTable": round(worst, 1), "cbo10yr": check},
            "sources": [
                {"name": "CBO, The Long-Term Budget Outlook Data: 2026 to 2056 (Feb 2026)", "url": "https://www.cbo.gov/publication/62044"},
                {"name": "CBO, The Budget and Economic Outlook: 2026 to 2036 (Feb 2026)", "url": "https://www.cbo.gov/publication/61882"},
                {"name": "CBO, An Analysis of Spending Proposals in the President's 2027 Budget (Jun 2026)", "url": "https://www.cbo.gov/publication/62385"},
                {"name": "CBO, Updated Budgetary Projections of Tariffs as of July 31, 2026", "url": TARIFF_URL},
                {"name": "CBO, The Demographic Outlook: 2026 to 2056 (Jan 2026)", "url": "https://www.cbo.gov/publication/61879"},
            ],
            "notes": {
                "tariffFrac": round(frac, 4),
                "pbAfter2036": "Discretionary gap vs. current law held at its 2036 share of GDP: %.2f%%" % (gap36 * 100),
            },
        },
        "gdp": [r(g(y)) for y in years],
        "rate": [round(rate[y], 3) for y in years],          # avg interest rate on debt held by public, %
        "rate10": [round(ten[y], 3) for y in years] if ten else None,
        "deflator": [round(price[y] / p0, 4) for y in years],  # GDP price index, FY2026 = 1
        "base": base,                                         # CBO current law (Feb 2026 extended baseline)
        "pb": {"mand": pb_mand, "dd": pb_dd, "nd": pb_nd},     # CBO estimate of President's proposals
        "tariff": tariff,                                     # customs revenue lost vs. Feb baseline
        "pop": [round(pop[y], 2) for y in years] if pop else None,
        "gdpCY2023": round(gdp_cy[2023] * 1000, 1),
        "gdpHist": {str(y): round(gdp_cy[y] * 1000, 1) for y in sorted(gdp_cy) if 2010 <= y <= 2056},  # calendar nominal GDP, $B
        "omb": {"gdpRatio": omb_ratio, "dr": omb_dr, "url": OMB_URL,
                "note": "OMB FY2027 economic assumptions vs. CBO Feb 2026; held at 2036 levels afterward"},                # calendar-2023 nominal GDP, $B (for IRS 2023 data)
        "wages": [round(wages[y] * 1000, 1) for y in years],      # wage and salary disbursements, $B (calendar year)
        "capShare": [round(capshare[y], 3) for y in years],      # % of earnings below the Social Security taxable maximum
        "demo": {"years": sorted(demo), "groups": ["24 or younger", "25 to 54", "55 to 64", "65 or older", "Total"],
                 "v": [demo[y] for y in sorted(demo)]},
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    i27 = years.index(2027)
    print(f"Wrote {a.out}: {years[0]}-{years[-1]}. FY2027 current-law deficit ${-base['deficit'][i27]:,.0f}B, "
          f"debt 2056 ${base['debt'][-1]/1000:,.1f}T. Max diff vs. CBO 10-yr table: {worst:.1f}B. "
          f"Tariff loss share of customs: {frac:.1%}")


if __name__ == "__main__":
    main()
