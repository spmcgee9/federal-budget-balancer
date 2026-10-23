# US Federal Budget Balancer

An interactive tool for trying to balance the U.S. federal budget. It starts from the President's budget request and lets you cut, grow, or eliminate spending, then shows what your choices do to the deficit.

Companion to the Federal Budget Explorer.

## What it does (Phase 1)

- **Spending tree by budget function** (National Defense, Health, Medicare, Social Security…), drilling down to subfunctions, agencies/bureaus, and individual budget accounts.
- **Adjust at any level.** Every row has an on/off switch, a percent slider (−100% to +100%), and a box for larger increases. Setting a category applies to everything inside it; you can then override individual accounts.
- **Mandatory programs are locked by default.** A toggle at the top unlocks them. Any change to mandatory spending is flagged in the scoreboard, on the changed rows, and in its own section of "Your changes."
- **"What is this?"** on every row: a plain-language description, the amount, the agency, and links to USAspending.gov and the source data.
- **Your changes** tab summarizes every difference from the baseline, with undo buttons.
- **Share links.** Your plan is saved in the page URL, so copying the link shares the plan.

Locked rows: net interest (calculated from debt, coming in Projections), offsetting receipts (collections netted against spending, not programs), and internal transfers (one government account paying another, such as the general fund paying into the Medicare trust funds; the matching receipt is a negative entry, so cutting the payment would show savings that don't exist). Transfer patterns are listed in `data/descriptions.json` under `transfers`.

Accounts with $0 in the budget year are hidden from the tree.

## Data

`data/budget.json` is built from OMB's **Public Budget Database** for the President's budget: account-level outlays and receipts, FY2025 (actual) through FY2031, in millions of dollars. Descriptions live in `data/descriptions.json` and can be edited by hand.

### Rebuilding the data

Automatically: on GitHub, go to **Actions → Build data and deploy → Run workflow**. Enter the budget year (and OMB's upload folder if the default guess is wrong). The workflow downloads the files, rebuilds `data/budget.json`, commits it, and redeploys the site.

Locally:

```
pip install openpyxl
python scripts/build_data.py                    # downloads FY2027 files from OMB
python scripts/build_data.py --outlays outlays_fy2027.xlsx --receipts receipts_fy2027.xlsx
```

The script prints total outlays, receipts, and the deficit so you can check them against the budget's summary tables.

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
2. Projections: 10- and 30-year deficits and debt ($ and % of GDP), interest calculated from your plan, debt payoff year, OMB vs. CBO economic assumptions
3. Revenue levers: corporate, payroll, capital gains, estate, excise, tariffs, and tax breaks
4. Editable income-tax curve calibrated to IRS income data
5. Economic assumptions and behavioral response settings
6. Proposed new programs (universal health care, universal pre-K, UBI, free college…)

## Caveats

This is a simplified, static model: it does not estimate how spending or tax changes would affect economic growth, and a percentage change is applied to an account's whole amount. It is meant for exploring trade-offs, not for official scoring.
