#!/usr/bin/env python3
"""
Build data/tax_breaks.json from OMB's tax expenditure tables (Analytical Perspectives, chapter 10).

Usage:
    pip install openpyxl
    python scripts/build_tax_breaks.py --file ap_10_tables_fy2027.xlsx

Uses Table 10-1 (total from corporations and individuals, millions of dollars, by fiscal year).
Each tax break below may combine several OMB line items (matched by OMB's item number and checked by name).
"""
import argparse
import json
import os
import re
import sys

try:
    import openpyxl
except ImportError:
    sys.exit("Please `pip install openpyxl` first.")

URL = "https://www.whitehouse.gov/omb/information-resources/budget/analytical-perspectives/"

# id, display name, [(OMB item number, name check regex)], description
BREAKS = [
    ("te_health", "Exclusion for employer-provided health insurance", [(130, r"employer contributions for medical")],
     "Health insurance premiums paid by employers aren't counted as taxable income for workers. It's the largest tax break, and it encourages more generous job-based coverage. Repealing it would also raise payroll taxes, which this estimate doesn't include. CBO's option to cap it instead (at the 50th percentile of premiums) raises about $1.2 trillion over 10 years."),
    ("te_retire", "Employer retirement plans (401(k)s and pensions)", [(149, r"defined contribution"), (148, r"defined benefit")],
     "Contributions to 401(k)s and pensions, and their investment earnings, aren't taxed until withdrawal. OMB's estimate counts this year's deferral, but much of it is repaid later when retirees pay tax on withdrawals, so the true long-run gain from repeal is smaller."),
    ("te_ira", "IRAs and self-employed retirement plans", [(150, r"individual retirement"), (153, r"self-employed plans")],
     "Tax deferral on Individual Retirement Accounts and plans for the self-employed. As with employer plans, part of this revenue would be collected later anyway when money is withdrawn."),
    ("te_homesale", "Capital gains exclusion on home sales", [(64, r"capital gains exclusion on home sales")],
     "Homeowners can exclude up to $250,000 ($500,000 for couples) of profit when they sell their main home."),
    ("te_passthru", "20% deduction for pass-through business income", [(83, r"20-percent deduction")],
     "Owners of partnerships, S corporations, and sole proprietorships can deduct up to 20% of their business income (Section 199A). The 2025 law made it permanent. Most of the benefit goes to high-income owners."),
    ("te_depr", "Accelerated depreciation (immediate expensing of equipment)", [(80, r"accelerated depreciation of machinery")],
     "Businesses can deduct the cost of equipment immediately instead of over its useful life. The 2025 law made 100% 'bonus depreciation' permanent. Because it shifts deductions earlier rather than eliminating them, repeal raises most in the first years."),
    ("te_charity", "Charitable contribution deductions", [(123, r"charitable contributions, other than"), (109, r"charitable contributions to educational"), (137, r"charitable contributions to health")],
     "Itemizers can deduct donations to charities, schools, and hospitals. The 2025 law adds a small deduction for non-itemizers and a 0.5%-of-income floor starting in 2026."),
    ("te_salt", "State and local tax (SALT) deduction", [(62, r"state and local property tax"), (174, r"nonbusiness state and local taxes")],
     "Itemizers can deduct state and local income (or sales) and property taxes. The 2025 law raised the cap from $10,000 to $40,000 through 2029 for most taxpayers."),
    ("te_mortgage", "Mortgage interest deduction", [(61, r"mortgage interest on owner-occupied")],
     "Itemizers can deduct interest on up to $750,000 of mortgage debt on a first or second home."),
    ("te_muni", "Tax-free interest on state and local bonds", [(172, r"public purpose state and local bonds")],
     "Interest on most bonds issued by states and cities isn't federally taxed, which lowers their borrowing costs. Repeal would raise costs for state and local governments."),
    ("te_socsec", "Partial exclusion of Social Security benefits", [(166, r"social security benefits for retired")],
     "Up to 85% of Social Security benefits are taxable, and only for people with income above fixed thresholds that have never been indexed to inflation. Taxing benefits like pensions would raise revenue, much of it credited to the Social Security and Medicare trust funds."),
    ("te_ctc", "Child tax credit (the part that reduces income tax)", [(141, r"child credit")],
     "The $2,200-per-child credit, to the extent it reduces income tax owed. The refundable part paid to families who owe little tax is spending, under Income Security on the Spending tab."),
    ("te_research", "Research and development tax breaks", [(8, r"credit for increasing research"), (7, r"expensing of research")],
     "The research credit plus immediate deduction of research costs, which the 2025 law restored for domestic research."),
    ("te_fdii", "Deduction for export-related income (FDII/FDDEI)", [(5, r"foreign-derived intangible")],
     "A lower tax rate on U.S. companies' income from serving foreign markets, meant to keep intellectual property in the U.S."),
    ("te_lifeins", "Exclusion of life insurance death benefits", [(55, r"life insurance death benefits")],
     "Life insurance payouts to beneficiaries aren't taxed."),
    ("te_lihtc", "Low-Income Housing Tax Credit", [(67, r"low-income housing")],
     "Credits for investors who build or renovate affordable rental housing. The 2025 law expanded it. Repeal would reduce affordable housing construction."),
    ("te_hsa", "Health savings accounts", [(132, r"health savings accounts")],
     "Contributions to HSAs paired with high-deductible health plans are tax-free, as are withdrawals for medical expenses."),
    ("te_energy", "Clean energy tax credits (what remains after 2025)", [(n, r".") for n in range(19, 39)],
     "Credits for wind, solar, nuclear, clean fuels, hydrogen, advanced manufacturing, and home energy efficiency. The 2025 law phased many of them out early; this is what remains."),
    ("te_obbba", "2025 law's temporary deductions (tips, overtime, car loans, seniors)", [(128, r"tip income"), (129, r"overtime"), (85, r"car interest"), (162, r"temporary additional deduction for the elderly")],
     "Deductions for tip income, overtime pay, interest on loans for new U.S.-assembled cars, and an extra $6,000 deduction for people 65 and older. All expire after 2028 under current law, so ending them early raises money only through 2028."),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "tax_breaks.json"))
    a = ap.parse_args()
    wb = openpyxl.load_workbook(a.file, read_only=True, data_only=True)
    rows = [list(r) for r in wb["Table 10-1"].iter_rows(values_only=True)]
    hdr = next(r for r in rows if any(c == 2025 or c == "2025" for c in r))
    ycol = {int(c): j for j, c in enumerate(hdr) if isinstance(c, (int, float)) or (isinstance(c, str) and re.fullmatch(r"\d{4}", c))}
    items = {}
    for r in rows:
        if isinstance(r[0], (int, float)) and isinstance(r[1], str):
            items[int(r[0])] = r
    years = sorted(ycol)
    out = []
    for bid, name, parts, desc in BREAKS:
        v = [0.0] * len(years)
        used = []
        for num, rx in parts:
            r = items.get(num)
            if r is None:
                sys.exit(f"{bid}: OMB item {num} not found")
            if not re.search(rx, r[1], re.I):
                sys.exit(f"{bid}: OMB item {num} is '{r[1]}', expected /{rx}/")
            for k, y in enumerate(years):
                x = r[ycol[y]]
                v[k] += float(x) if isinstance(x, (int, float)) else 0.0
            used.append(f"{num}: " + re.sub(r"\s+\d+/(\s+\d+/)*\s*$", "", r[1].strip()))
        out.append({"id": bid, "name": name, "desc": desc, "omb": used,
                    "years": years, "v": [round(x / 1000, 2) for x in v]})  # billions
    data = {"source": "OMB, Analytical Perspectives FY2027, Table 10-1 (tax expenditures)", "url": URL,
            "units": "billions of dollars, fiscal years", "breaks": out}
    with open(a.out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    for b in out:
        i = b["years"].index(2027)
        print(f"{b['id']:12} 2027 ${b['v'][i]:7.1f}B  10yr(26-35) ${sum(b['v'][1:11]):8.0f}B")


if __name__ == "__main__":
    main()
