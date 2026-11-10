# Consumer Data Portfolio (CDP) — Prototype Notes

Mock interactive prototype for the KICK'S project. Not a live valuation engine.
Not a shipping feature. Nothing here is real pricing, real demand, or an earnings promise.

## What was built

Single-page web prototype, vanilla HTML/CSS/JS, no external calls, no real user data.
Repo placement: `apps/web/cdp-prototype/` — the repo has `apps/android` and `apps/ios`
and no web app yet, so this creates `apps/web/` as the home for the web prototype.
Prepared locally only; the parent pushes it as a draft PR.

Files:

- `index.html` — all 13 screens, tab navigation, mock banner on every screen
- `styles.css` — all styling, system font stack, no external fonts or images
- `app.js` — tab switching, donut chart, performance line chart, license revoke (mock)
- `CDP_PROTOTYPE_NOTES.md` — this file

Screens (all from the founder's spec):

1. Portfolio Home (reduced 2026-11-10, see below) — Portfolio Value "Not yet
   valued", Active Consents 3, Data Sources Connected 2, DNS Observations 1,240
   (mock), Vault Locked, plus a revocable consent list (3 records).
2. Asset Allocation — Behavioral 42%, Health 19%, Location 14%, Purchase 11%,
   Financial 8%, Device Telemetry 6% (donut chart).
3. Data Value Heat Map — Health Very High, Purchase Intent High, Financial
   Behavior High, Mobility Medium, Social Activity Medium, Device Metadata Low.
4. Data Income Statement — Health Study $18, Retail Research $9, AI Training
   Dataset $6, Usage Analytics $3, total $36 (this month).
5. Data Balance Sheet — assets vs liabilities; Gross $5,200, Risk Adjustment
   −$1,800, Net Data Equity $3,400.
6. Data Demand Terminal — top requested data today, demand index bars, demand
   curve sketch, supply bottlenecks (rare data), top-5%-demand callout.
7. Opportunity Scanner — Heart Health Study $75, Smart Home Usage Study $28,
   Veteran Technology Survey $19, Electric Vehicle Behavior Study $52 (all mock).
8. Privacy Risk Dashboard — exposure score bars, active licenses, data retained
   by buyers, geographic transfers, re-identification probability.
9. Data Liquidity Meter — highly liquid vs illiquid categories.
10. Data Performance History — Jan $410, Apr $620, Jul $980, Oct $1,480 (line chart).
11. Data Diversification Index — over-concentrated (GPS + shopping, 90%) vs diversified.
12. Marketplace Analytics — users available: Fitness 250,000; EV Drivers 87,000;
    Diabetes Patients 21,000; Rare Conditions 2,100.
13. Data Credit Rating — Portfolio Reliability Score, grade "AAA Data Contributor",
    factors: verified identity, device consistency, data completeness, historical
    participation.

## Reduced intro (2026-11-10)

The founder asked to reduce the CDP's introductory info to fit where KICK'S is
now. The original intro showed a mature market: Net Data Worth $2,487, Projected
Annual Value $641, 14 study licenses, 38 data sources, Portfolio Health Score
91/100. That is not where KICK'S is.

Where KICK'S is now: reduced MVP, Android-first, launching Nov 17. The core is
DNS monitoring plus the consent flow (Ask/Modify/Receipt) plus vault plus
ledger/revoke. Phase 0 is not yet operable. There are no live valuations, no
buyers, no earnings, no marketplace yet.

What changed in the intro (Portfolio Home only):
- Cut: the dollar-valuation hero ($2,487), the $641 projected annual value, the
  91/100 health score, the 38 data sources, and the 14 study licenses.
- Now shows: Portfolio Value "Not yet valued — value appears as studies and
  buyers join", Active Consents 3, Data Sources Connected 2, DNS Observations
  1,240 (mock count, minimized DNS observations only), Vault Locked.
- The consent list is now 3 consent records from the current product — the DNS
  Monitoring consent plus two consented categories from the existing consent flow
  (Distance & pace, Exact map routes) — framed as consent records, not study
  licenses. Revoke still works (mock): revoking flips the row to Revoked and
  decrements the active-consent count everywhere it appears (Home and the Risk
  Dashboard share the count; the count is also synced on page load).
- The Risk Dashboard's "Number of active licenses" metric follows the same
  shared count and now reads "Number of active consents" (3).

What did not change: the other 12 screens are untouched — they are the future
vision, already labelled mock on every screen. No onboarding question or signup
step was added; the reduction removed content only. All figures remain mock and
labelled; the "we never award over-sharing" rule still holds.

## What is mock

Everything with a number in it. Every screen carries the label
"Mock data — illustrative only, not a valuation or an earnings promise."
No figure in this prototype is a real price, payout, or guarantee. The demand
levels, marketplace counts, performance history, and credit grade are invented
illustrations of the concept, not measured data.

## The $5-label tension (flagged, not resolved)

The spec's opportunity values ($75 / $28 / $19 / $52) conflict with the standing
KICK'S rule: every cash/credit opportunity carries a fixed $5 label until real
per-study pricing is set. The prototype keeps the spec's numbers as mock values
(because the spec is the source of the screen) and puts a visible note on the
Opportunity Scanner: "Values shown are mock; KICK'S labels every opportunity $5
until real per-study pricing is set." This tension must be reconciled before
shipping — either the $5 label rule is extended to the CDP (all opportunities
shown as $5), or real per-study pricing is set and the Ask screen shows the real
amount per offer. Do not ship the $75/$28/$19/$52 figures as if they were offers.

## Zero onboarding questions — confirmed

Standing rule (2026-11-10): no upgrade may lengthen consumer onboarding. No extra
questions for the consumer.

This prototype adds **zero onboarding questions**. Verified screen by screen:

- No screen adds a signup step, a profiling question, or a "complete your profile"
  prompt.
- The portfolio is framed as built only from data the user has already consented
  to share through existing KICK'S onboarding. The Home screen states this outright.
- The Opportunity Scanner matches studies to already-consented data; it does not
  ask the user anything new to qualify.
- The Diversification screen shows concentration for information only and states
  that improving diversification is never a reason to share more or to add an
  onboarding question.
- The Credit Rating "data completeness" factor is labelled as reflecting
  already-consented data only — it is not a prompt to add more.
- Nothing in the prototype rewards sharing more data. Standing rule: we never
  award over-sharing.

If a future real build needs a new data category, that is a consent decision in
the existing Ask/Modify/Receipt flow, not a new onboarding question — out of scope
for this prototype.

## Consent-gated framing

The portfolio only shows data the user has consented to share. Every consent
record on the Home screen has a Revoke affordance (mock in the prototype:
revoking flips the row to Revoked and decrements the active-consent count
everywhere it appears). In the real product, revocation would apply promptly and
the consent would stop being counted, per the existing Revoke Now behavior.

## What would need to be real before shipping

- Live valuations: real pricing per data category from real buyers, not illustrative
  figures. No earnings promise anywhere.
- Real buyer demand: the Demand Terminal and Marketplace Analytics need a real
  demand feed; the mock "top requested" and "users available" numbers must be replaced.
- Real consent wiring: the portfolio must read live consent state (Ask/Modify/Receipt
  flow, consent ledger) and real revocation; the revoke buttons must call the real
  revoke endpoint.
- Real income: earnings must come from the real ledger/wallet, not hard-coded rows.
- The $5-label tension above must be resolved (see above).
- Privacy risk metrics (re-identification probability, geographic transfers, buyer
  retention) need real measurement, not illustrative values.
- Accessibility and real-device testing in the Android and iOS apps; this prototype
  is a web page, not the app.
- Founder approval of the final copy, destination, and timing before any public
  exposure. Nothing merges without the founder's explicit approval.

## How to run

Open `index.html` in a browser, or serve the directory:

```
cd apps/web/cdp-prototype
python3 -m http.server 8000
```

Then open http://127.0.0.1:8000/index.html. No build step, no dependencies,
no network calls — the page works from the local files alone.

## Verification done

- `node --check app.js` — syntax clean.
- HTML parsed and served locally; all three files return HTTP 200.
- No external URLs, no fetch/XHR, no API calls in any file.
- No named AI agent appears in any file, doc, or comment.
- Branding stays KICK'S; no rebrand.
