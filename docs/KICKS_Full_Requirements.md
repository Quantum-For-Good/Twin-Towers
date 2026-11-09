# KICK'S — Full Requirements (reduced version + full app)

Compiled 2026-11-06. Status notes are as verified that day — recheck before building.
All prices / partners in examples are mock unless a real offer sets them.

## Dates

- **Reduced version: Tuesday, November 24, 2026** (early, ahead of the Nov 28 beta goal)
- **Full app: Q1 2027** (January–March 2027) — this is KICK'S 3.0
- Today: November 6, 2026 — 18 days to the reduced-version date.

## 1. What the app is

KICK'S is DataStorm Inc.'s consumer data rights and compensated participation
product. A consumer owns their data in a Personal Data Vault, sees exactly what
is being asked for, chooses what to share, gets compensated when it is used,
and can revoke it in one tap.

Branding stays KICK'S — same name, same Kick mascot, no rebrand.

## 1a. Two separate apps — Ezekiel, 2026-11-06

Build TWO separate apps: one for iOS, one for Android. That makes the merge
easier — Android work does not block iOS work, and iOS work does not block Android.

Shared across both apps (one contract, two implementations):
- API and contracts (Fastify, PostgreSQL, device-bearer auth)
- Consent flow — Ask / Modify / Receipt, same screens, same prices, same rules
- Vault, Ledger, Revoke Now
- Tiers + global leaderboard, fixed $5 opportunities
- Branding — KICK'S, same name, same Kick mascot

Separate per app:
- Native app code, builds, CI, and signing — Android and iOS each on their own track
- Native collector — Android: VpnService DNS TUN (in PR #62, blocked);
  iOS: Packet Tunnel DOES exist in repo branches (PacketTunnelProvider.swift, WireGuard) — NOT in main HEAD, needs merge + signed-device verification
- Device verification — signed-device acceptance per platform, separately

Reduced version (Nov 24, 2026) is Android-first for DNS monitoring. The iOS app
is the second app; the full app (Q1 2027) is both apps together.

## 2. Reduced version — scope (frozen for Nov 24)

In:
- Vault (account, opportunities, active studies, earnings, permissions, history)
- Consent flow — Ask / Modify / Receipt (see §3)
- Ledger + Revoke Now (one tap, ~15s effect on monitoring)
- DNS monitoring — core feature, both versions (see §4)
- Level-up tiers + global leaderboard, small, opt-in (see §5)
- Fixed $5 economic opportunities (see §6)
- Android-first. iOS DNS monitoring is NOT in the reduced version (no Packet
  Tunnel in the repo).

Out (saved for the full app / KICK'S 3.0, Q1 2027):
- Gamification phase 1 — all 50 CoCreator Badges (spec v1.4 approved, code not
  approved, not in main)
- Full studies / partner tooling
- Health datasets (longitudinal) — highest value, highest risk, goes last
- Country boards, seasonal challenges, team boards

## 3. Consent flow — Ask / Modify / Receipt

Screens (from the approved photo + saved code
`kicks-consent-flow-code.js`):
- **Screen 1 — Data Request:** requester card (mock example: Nike Running),
  Verified badge, 12 runs, For / Pays / Access (24 hours, then auto-revoked),
  banner "No data leaves your vault until you approve", Decline / Modify /
  Allow Once. Modify focuses Screen 2.
- **Screen 2 — Modify:** toggles Distance 0.90 / Maps 0.70 / Shoe 0.90,
  4 runs each, live price $2.50 all on / $1.80 with maps off / $0.90 distance
  only. Privacy ↔ Value slider drives the toggles (0 Privacy, 1 Balanced,
  2 Value). Price pulses blue "updated" (#2563EB) on change.
  Update & Continue takes you to Receipt.
- **Screen 3 — Receipt:** Done checkmark, shared count tied to what was left
  toggled on, Revoke Now button that switches to Revoked, Ledger #4821 card
  (mock) with full audit details.

Design: SF Pro, white cards, black primary buttons, #2563EB accent,
iPhone frames (44px radius, notch, home indicator, safe-area-inset-top),
responsive — horizontal scroll on mobile, side-by-side on desktop.
Implementation notes: Tailwind CSS + Lucide icons for the prototype;
React Native components for the app (`components/DataRequest.tsx` etc.).

MVP rule: see exactly what row is leaving, change the price, revoke in one tap.

## 4. DNS monitoring — core feature, both versions

- Android VpnService TUN, DNS only (IPv4/UDP, port 53). Tunnel owns only
  virtual DNS 10.111.222.2/32. All other traffic never enters the tunnel.
- DNS forwarded unchanged via protect()ed socket; reply written back to tun.
  Fail open for connectivity, fail closed for collection.
- Known limits: Private DNS (DoT/DoH), hard-coded resolvers, DNS over TCP,
  oversized replies are not seen.
- Only the DNS question name is read. No payloads, URLs, paths, query strings,
  credentials.
- Minimized observation schema only: eventId, occurredAt, sourceApp null,
  attribution unknown, destinationHost, protocol dns, bytesBucket,
  classification unknown, consentId, consentPurpose. IP literals / malformed
  hosts dropped.
- Gates — all required, fail closed: build enabled; explicit activation toggle
  (never persisted, never implied by consent); signed-in session; device
  ownership confirmed by server; collection consent granted (consentId +
  purpose); data sharing on separately; OS VPN authorization; notifications on.
  Consent alone never starts it.
- Queue: 2,000 max, oldest dropped first; batches ≤250; AES-GCM encrypted
  (Android Keystore); backoff 2s → 5 min; discard after 8 fails; auth
  re-checked every 15s; revocation stops capture/upload within ~15s.
- Narrative: "consistent monitoring" = monitoring of *systems* — watching and
  listening to how systems behave — so KICK'S stays privacy-by-default while
  promoting consistently monitoring. We watch how systems behave. We don't
  watch you. Honest guardrail: minimized DNS signal *is* observed, consent-
  gated and revocable — do not claim nothing is observed from the device.
- **Current state (2026-11-06):** main's VPN service is a deliberate no-TUN
  stub — no tunnel, no capture. Full TUN lives in PR #62, blocked on the
  13-file auth-model conflict, and needs separate on-device verification.
  iOS Packet Tunnel exists in repo branches (see §1a correction), not in main HEAD; signed-device verification still outstanding.

## 5. Tiers + global leaderboard

- Five tiers: Starter, Contributor, Co-Creator, Advocate, Guardian.
- Level up by participation and contribution — NOT by volume of data shared.
- XP caps (gamification v1.4): 500/session, 2,000/24h, 5.0x max. No XP for a
  revoked share.
- Board: one global board from day one, opt-in only (default off), display
  name only, no real name / photo / location / earnings / study / data type,
  weekly refresh (not live), top 100 + your own rank privately, no country
  boards to start. No money on the board, ever.
- Board never appears inside a consent decision.
- **Standing rule: we never award over-sharing.** No reward, bonus, tier,
  level-up, or leaderboard progress for sharing more than a consumer chose.

## 6. Economic opportunities — fixed $5

- **Fixed $5 rule:** label everything a fixed $5. Every cash/credit opportunity
  is $5 flat. Exception: login streaks pay in tiers, not cash.
- Examples: load Facebook data $5; connect a second social $5; Google/email $5;
  Spotify/streaming $5; fitness wearable $5; shopping/receipts $5.
- Log in 7 days straight → level up (tier, not cash).
- Study shares are priced per study, per data type, per time window, shown in
  the Ask screen (e.g. 12 runs, $2.50 credit, 24h — mock example).
- $5 is the label, not a guaranteed payout. No earnings promise anywhere.
- Loading data into your own vault is not sharing it — sharing needs its own Ask.
- Best combinations: fastest start (Facebook + second social + profile +
  7-day streak); highest study value (wearable + location + receipts, linked,
  30 days); best for AI training (preference + media + minimized DNS);
  steady earner (streak + one study/month + one linked share/month);
  community (invite a friend + onboarding + global board).
- Full lists: `KICKS_Economic_Opportunities.md`,
  `KICKS_Highest_Value_Datasets.md`, `KICKS_Level_Up_Tier_Leaderboard.md`.

## 7. Highest-value datasets (for studies, research, AI training)

Tier 1: health & wellness longitudinal (wearable/fitness/sleep — highest
per-record, highest sensitivity, separate explicit consent, no raw medical
records first); location & mobility patterns; verified purchase/transaction
behaviour; human interaction & preference data (the consent flow itself
generates consented preference data).
Tier 2: media & attention; app/system behaviour (DNS); work/learning patterns.
Do not build on: demographics alone, social/public-record, raw identifiers
(lowest value, highest risk).
Multiplier: consented linkage across datasets over time — link only what the
consumer explicitly approved, for a named study, for a named time, revocable
in one tap.

## 8. Lean tech stack

### App (client)
- Expo SDK 57, React Native 0.86.2, React 19.2.3, Expo Router, TypeScript 5.9
- react-native-safe-area-context, react-native-screens, @expo/vector-icons
- Native Android (Kotlin): VpnService collector, Keystore secure storage,
  Gradle / Android Studio via Expo prebuild (no gradlew in repo — generated)
- iOS: Expo app exists; native Packet Tunnel DOES exist in repo branches — PacketTunnelProvider.swift (WireGuard, NEPacketTunnelProvider, added Oct 10, 2026, commit b63bc17), KicksTunnelModule, with-kicks-packet-tunnel plugin, ios-tunnel-validation workflow — but it is NOT in main HEAD (local main 2f357dc), and signed-device / physical-device verification is still outstanding

### API (server)
- Fastify 5, Node, TypeScript, tsx, Zod, pg (PostgreSQL driver)
- Device-bearer auth in main (CollectorAuthorizationService, SHA-256 tokenHash)
  — this is the incumbent model; PR #62's OIDC model conflicts with it

### Data
- PostgreSQL — disposable test database only so far (D: drive, port 5433 in the
  Windows runbook). No production database chosen. Do NOT use the existing
  PostgreSQL instance. DigitalOcean is on hold.

### Auth / identity (decision needed)
- Consumer broker: Auth0 (OIDC, PKCE, `kicks://auth/callback`) — tenant NOT
  configured: domain, API audience, Native app client ID, Google/Apple social
  connections still needed. Non-production tenant seen in docs:
  dev-dxqiztc3dpbtcfkd.us.auth0.com (unverified).
- No production enrollment path in main — only admin-secret staging minting.

### CI / hosting
- GitHub Actions: verify, api-persistence, android-debug-build, collector-core,
  ios-simulator-build, CodeQL (java-kotlin config failing — autobuild issue),
  Workers (Cloudflare wrangler previews config missing — not code)
- Vercel: web preview / builds (passing on PRs that run)
- Cloudflare: Workers + Tunnel — ON HOLD. Staging API currently returns
  Tunnel Error 1033 / HTTP 530 because cloudflared is not running.
- GitHub repo: DataStorm-Inc/KICKS_101_Android-, private since 2026-11-06
  (was GlobalCommerce91210, public). Main head e0fb06d.

### Platforms & services required
| Need | Platform / service | Status |
|---|---|---|
| Code + CI | GitHub (repo, Actions) | **BLOCKED on billing / Enterprise trial lock** — Ezekiel fixing |
| App framework | Expo / React Native | In repo, v0.2.5, target 0.2.6 |
| API | Fastify on Node | In repo |
| Database | PostgreSQL (disposable test; production TBD) | Test runbook ready, not run |
| Identity | Auth0 tenant | Not configured |
| Design | Figma (connected) | Ready |
| Tracking / gates | Notion — KICK'S DEVELOPMENT / KICK'S HQ | See §9 — tracker, not builder |
| Web preview | Vercel | Passing |
| Tunnel / Workers | Cloudflare | On hold |
| Payouts | **Not chosen** — payout reconciliation is a gate, no provider selected | Decision needed |
| iOS distribution | Apple signing / TestFlight | No signed-device acceptance yet |

## 9. Notion — shift of agents: how it is doing

Checked live 2026-11-06, pages "KICK'S DEVELOPMENT" and
"KICK'S engineering shift — November 5, 2026" (KICK-SHIFT-20261105-01).

- **KICK'S DEVELOPMENT: HOLD — no production action is authorized.**
  Production needs a CTO decision record / Founder-authorized change record
  with exact target, change set, SHA, window, rollback, validation evidence,
  and named owner + approver. Missing fields = BLOCKED FOR PRODUCTION.
  Collector monitoring remains OFF.
- **16 blocked delivery items (12 P0, 4 P1)** as of the November 5 reconciliation.
- **Shift Nov 5: OPEN, but 0 newly completed tasks, 0 newly executed tests,
  0 newly accepted builds.** Engineering / QA / Security / Oversight: NOT RUN
  for this shift. Overall acceptance: PENDING. Owner acknowledgment: PENDING.
- **Prior shift closed with FAILED VALIDATION** — blockers included incomplete
  account-session/device-proof integration, Android quality workflow failure,
  security audit findings, missing signed/physical-device acceptance, incomplete
  independent QA.
- Governance in Notion: Founder (MVP scope, budget, release); CTO (engineering);
  COO (delivery); CPS (requirements, parity, acceptance); CIO (engine charters,
  pseudonymization, retention); ONB (account, consent, activation).
- A shift opening or page assignment does **not** prove agent activation,
  implementation, test execution, or acceptance. The Nov 5 shift log itself
  records: "No agent session, build, test, merge, deployment or collector
  activation was performed by this shift-opening action."

### Should Notion build the app? No.

Notion is the tracker and the source of truth for gates, holds, shifts, and
evidence — it is not a builder. It cannot write code, run builds, sign apps,
run CI, or deploy. The agents in Notion are management roles (CTO, COO, QA,
Security, Oversight) that *coordinate and verify*; the building happens in
the GitHub repo (Expo / React Native + Fastify + Postgres), by devs
with passing checks and Ezekiel's explicit approval per merge. Use Notion to
track the work and to hold the go / no-go gates — do not ask it to build the app.

## 10. Estimate — reduced version

Today is Nov 6. Reduced version target is Nov 24 — **18 days**.

Honest estimate, based on the current state:
- **If GitHub is fixed immediately and scope is frozen:** the reduced version
  is a **2–3 week** build — Nov 24 is tight but reachable for a scoped,
  Android-first beta, *if* the auth-model decision is made fast and the DNS
  collector merges and passes on-device verification in the first week.
- **If GitHub is not fixed, or the auth decision drags:** Nov 24 slips. CI
  cannot verify anything while the lock is active, and the collector cannot
  merge while the 13-file conflict is undecided.
- **Full app (Q1 2027):** roughly **8–12 weeks after the reduced version**,
  for gamification, full studies, partner tooling, and health datasets —
  assuming the reduced version ships and the 3.0 scope stays frozen while it
  is built.

These are estimates, not commitments. The three decisions that decide the
date: (1) GitHub fixed, (2) auth model for the collector, (3) frozen scope
for the reduced version.

## 11. Go / no-go checklist (before giving the project a go)

- [ ] GitHub billing / Enterprise trial lock resolved — CI actually runs
- [ ] Auth model decided: main device-bearer wins, #62 enrollment reworked in
- [ ] Reduced-version scope frozen (in §2) — nothing added mid-build
- [ ] DNS collector merged + verified on a real Android device
- [ ] Postgres restart / idempotency / revocation evidence (disposable DB)
- [ ] Auth0 tenant configured + production enrollment path built
- [ ] Signed-device acceptance + independent QA
- [ ] Workers / CodeQL config: in scope or out, decided
- [ ] Payout provider chosen (or explicitly deferred past Nov 24)
- [ ] Health datasets confirmed OUT of the reduced version
- [ ] No earnings promise in any screen, reel, or post
