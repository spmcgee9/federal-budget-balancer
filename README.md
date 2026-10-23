# US Federal Budget Balancer

An interactive tool for trying to balance the U.S. federal budget. It starts from the President's budget request and lets you cut, grow, or eliminate spending, then shows what your choices do to the deficit.

Companion to the Federal Budget Explorer.

## Spending (Phase 1)

- **Spending tree by budget function** (National Defense, Health, Medicare, Social Security…), drilling down to subfunctions, agencies/bureaus, and individual budget accounts.
- **Adjust at any level.** Every row has an on/off switch, a percent slider (−100% to +100%), and a box for larger increases. Setting a category applies to everything inside it; you can then override individual accounts.
- **Mandatory programs are locked by default.** A toggle at the top unlocks them. Any change to mandatory spending is flagged in the scoreboard, on the changed rows, and in its own section of "Your changes."
- **"What is this?"** on every row: a plain-language description, the amount, the agency, and links to USAspending.gov and the source data.
- **Your changes** tab summarizes every difference from the baseline, with undo buttons.
- **Share links.** Your plan is saved in the page URL, so copying the link shares the plan.

Locked rows: net interest (calculated from debt, coming in Projections), offsetting receipts (collections netted against spending, not programs), and internal transfers (one government account paying another, such as the general fund paying into the Medicare trust funds; the matching receipt is a negative entry, so cutting the payment would show savings that don't exist). Transfer patterns are listed in `data/descriptions.json` under `transfers`.

Accounts with $0 in the budget year are hidden from the tree.

## Projections (Phase 2)

The **Projections** tab carries your plan forward to 2056: debt, deficits, and interest in dollars, inflation-adjusted dollars, or % of GDP; the spending mix; and an aging-population chart for context. It reports debt in 10, 20, and 30 years, total deficits over the next decade, and, if your plan gets there, the year the debt is paid off.

How it works:
- **Baseline:** CBO's February 2026 current-law projections, plus CBO's estimate of the President's 2027 spending proposals, plus CBO's July 2026 tariff update (after the Supreme Court ended the IEEPA tariffs). The President's budget proposed no tax changes.
- **Your plan:** 2027–2031 changes come from OMB's year-by-year account data (the same numbers as the Spending tab); after 2031 each category's change grows with CBO's projection for that category.
- **Interest:** CBO's baseline interest plus interest on the extra or avoided debt at CBO's projected average rate on federal debt.
- Past 2056 (payoff only), 2056's ratios to GDP are held constant. Economic feedback isn't modeled yet.

## Revenue (Phase 3)

The **Revenue** tab has levers for individual income tax brackets and a surtax, capital gains (with a revenue curve that peaks near a 28% rate), corporate taxes, payroll taxes (Social Security cap and rates, Medicare rate), the estate tax, excise taxes, tariffs, a VAT, carbon tax, financial transaction tax, and wealth tax, plus 19 of the largest tax breaks (scale back or repeal). Each shows its first-year and 10-year effect, its source, and how it was calibrated.

- Most levers are calibrated to CBO's budget options and scaled to today's economy in proportion to GDP. Estimates whose tax base the 2025 reconciliation law changed are tagged "pre-2025-law estimate."
- Payroll levers are computed from CBO's wage and taxable-share projections; tariffs from CBO's customs projections with an import response.
- Tax breaks use OMB's FY2027 tax expenditure estimates, counted at 75% because repeal raises less than the published cost (behavior and overlaps).
- The wealth tax has no official estimate; it uses the Penn Wharton Budget Model's and is flagged as highly uncertain.
- Levers are added independently; interactions between them aren't modeled.
- **Phase-in:** every change, spending or revenue, can take effect immediately or ramp in over 3, 5, or 10 years (a plan-wide default, with a per-item override in its "What is this?" panel).

## Income tax curve (Phase 4)

At the top of the Revenue tab, an editable chart of income tax brackets for single filers (log scale, $5K to $10M of taxable income). Drag a point up or down to change a bracket's rate, sideways to move where it starts; add or remove brackets; or type exact values in the table. Married couples' thresholds follow current law's relationship (about double). The chart also shows your average tax rate, and a "who pays" table spreads the change across income groups.

- Revenue is computed from IRS Statistics of Income data (tax year 2023, Table 3.4): taxable income taxed at each rate, by filing status, rebuilt into a distribution of taxable income (power-law within each bracket). Current law reproduces IRS's ordinary-rate tax exactly.
- Behavioral response: an elasticity of taxable income of 0.25 (income reported at each level changes with the after-tax share of an extra dollar).
- The 2023 change is grown with GDP and multiplied by 0.85, so a 1-point increase in every bracket matches CBO's estimate ($1.2 trillion over 10 years).
- The "who pays" table (IRS Table 1.1) is approximate: it uses each income group's average taxable income, before behavioral responses.

## Assumptions (Phase 5)

An **Economic and behavioral assumptions** panel at the top of the Projections tab changes the outlook for both the President's budget and your plan:

- **Forecast:** CBO (default) or OMB's FY2027 economic assumptions (faster growth, lower rates). OMB's GDP and interest rates are applied relative to CBO's through 2036, then held.
- **Growth:** ± real growth per year. Revenue moves in proportion; mandatory spending moves 0.4% per 1% of GDP; discretionary spending is fixed in dollars. (0.1 point slower growth ≈ +$305B in deficits over 2027–2036; CBO's rule of thumb for productivity growth: +$317B.)
- **Interest rates:** ± points, reaching the average rate on the debt over about six years. (+0.1 point ≈ +$391B over 2027–2036; CBO's rule of thumb: +$379B.)
- **Debt feedback:** optional; each point of debt-to-GDP above CBO's current-law path raises rates 2 basis points.
- **Behavior:** elasticity of taxable income for the income tax curve (default 0.25) and the share of tax-break estimates counted on repeal (default 75%).

Assumptions are saved in share links and reset by "Start over."

## Data

- `data/budget.json`: OMB's **Public Budget Database** for the President's budget: account-level outlays and receipts, FY2025 (actual) through FY2031, in millions of dollars. Built by `scripts/build_data.py`.
- `data/projections.json`: CBO projections, in billions of dollars. Built by `scripts/build_projections.py`.
- `data/tax_breaks.json`: OMB tax expenditure estimates for the tax-break levers. Built by `scripts/build_tax_breaks.py --file ap_10_tables_fy2027.xlsx` (from the Analytical Perspectives page).
- `data/taxcurve.json`: IRS income distribution for the tax curve. Built by `scripts/build_taxcurve.py --t34 23in34tr.xls --t11 23in11si.xls` (needs `pip install xlrd`).
- `data/descriptions.json`: plain-language descriptions, search keywords, and internal-transfer rules. Edit by hand.

### Rebuilding the spending data

Automatically: on GitHub, go to **Actions → Build data and deploy → Run workflow**. Enter the budget year (and OMB's upload folder if the default guess is wrong). The workflow downloads the files, rebuilds `data/budget.json`, commits it, and redeploys the site.

Locally:

```
pip install openpyxl
python scripts/build_data.py                    # downloads FY2027 files from OMB
python scripts/build_data.py --outlays outlays_fy2027.xlsx --receipts receipts_fy2027.xlsx
```

The script prints total outlays, receipts, and the deficit so you can check them against the budget's summary tables.

### Rebuilding the projections

Download CBO's workbooks into a folder and run `python scripts/build_projections.py --dir that_folder`:

- Long-term budget projections: `51119-…-LTBO-Budget.xlsx` (cbo.gov/recurring-data/51119)
- Long-term economic projections: `57054-…-LTBO-econ.xlsx` (cbo.gov/recurring-data/57054)
- 10-year budget projections, used as a check: `51118-…-Budget-Projections.xlsx` (cbo.gov/recurring-data/51118)
- CBO's analysis of the President's budget: `62385-data.xlsx` (cbo.gov/publication/62385)
- Demographic outlook: `61879-Data.xlsx` (cbo.gov/publication/61879)

The tariff adjustment is a constant at the top of the script; update or remove it when CBO publishes a new baseline.

## Running it locally

The page loads its data with `fetch`, so open it through a local web server rather than double-clicking the file:

```
python -m http.server
```

Then visit http://localhost:8000.

## Hosting on GitHub Pages

1. Create a repository and push this folder to `main`.
2. In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. The included workflow deploys the site on every push.

## Roadmap

1. ✅ Spending tree, controls, mandatory lock, descriptions, change summary, share links
2. ✅ Projections: 10-, 20-, and 30-year deficits and debt ($, today's $, % of GDP), interest calculated from your plan, debt payoff year
3. ✅ Revenue levers (income, capital gains, corporate, payroll, estate, excise, tariffs, new taxes, tax breaks) and phase-ins
4. ✅ Editable income-tax curve calibrated to IRS income data
5. ✅ Economic assumptions (growth, interest rates, OMB vs. CBO forecasts, debt feedback) and behavioral response settings
6. Proposed new programs (universal health care, universal pre-K, UBI, free college…)

## Caveats

This is a simplified, static model: it does not estimate how spending or tax changes would affect economic growth, and a percentage change is applied to an account's whole amount. It is meant for exploring trade-offs, not for official scoring.
