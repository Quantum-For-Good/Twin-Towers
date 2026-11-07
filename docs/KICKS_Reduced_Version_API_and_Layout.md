# KICK'S Reduced Version — API Specs + Full Layout Outline

Reduced version, Android-first, target Tuesday, November 24, 2026.
Two separate apps (iOS + Android) — this outline is the shared contract;
each app implements it natively. Full app (both apps, KICK'S 3.0) Q1 2027.

Status key: EXISTS = in local main (2f357dc) as checked 2026-11-06.
IN #68 = merged into main via PR #87 (e100794) — device-bearer collector gates.
IN #62 = in PR #62 branch only, blocked on the 13-file auth conflict.
TO BUILD = not in the repo yet, needed for Nov 24.

All prices / partners in examples are mock unless a real offer sets them.

---

## Part 1 — API specs

Base: Fastify 5, Node, TypeScript, Zod, pg. Auth: device Bearer token
(SHA-256 tokenHash, revoked=false, subjectId must match) — the incumbent
model in main. JWT/OIDC is the #62 model and conflicts with it; do not mix
the two in one server until the auth decision is made.

### 1. Health & identity

| Method + path | Auth | Request | Response | Errors | Status |
|---|---|---|---|---|---|
| GET /health | none | — | `{status:'ok', service:'kicks-api', collector:'metadata-only', durability:'memory' \| 'postgres'}` | — | EXISTS |
| POST /v1/staging/devices | X-Admin-Secret | `{subjectId: uuid}` | 201 `{deviceId, token, tokenType:'Bearer'}` | 403 forbidden, 400 invalid_request | EXISTS — staging only; disable / remove for production |
| POST /v1/devices/enroll | IdP token + X-Kicks-Device | `{deviceId}` | binds device to account `sub` | 403 device_owned_by_another_account | IN #62 — needs rework onto device-bearer |
| POST /v1/devices/:id/revoke | IdP token / device Bearer | — | device revoked | 403 / 404 | IN #62 — needs rework |
| GET /v1/collector/eligibility | device Bearer | — | session / owner / consent / data-sharing state | 401, 403 | IN #68 (POST form) / IN #62 (GET form) — **decide one** |

### 2. Consent — the core of the product

| Method + path | Auth | Request | Response | Errors | Status |
|---|---|---|---|---|---|
| POST /v1/consent-events | device Bearer | `{permissionId, purpose, policyVersion, purposeVersion, action: 'grant' \| 'revoke'}` | 202 `{id, occurredAt, …decision, status:'accepted'}` | 401 unauthorized, 400 invalid_request | EXISTS |
| GET /v1/permissions/users/:user_id/consent-log | device Bearer | — | append-only consent events for the user | 401, 403 | EXISTS |
| GET /v1/permissions/users/:user_id/effective | device Bearer | — | effective permissions for the user | 401, 403 | EXISTS |
| GET /v1/permissions/users/:user_id/apps | device Bearer | — | per-app permissions | 401, 403 | EXISTS |
| POST /v1/permissions/users/:user_id/apps | device Bearer | permission grant/revoke | updated permission | 401, 403, 400 | EXISTS |
| GET /v1/permissions/users/:user_id/apps/:app_id/metadata | device Bearer | — | metadata for one app permission | 401, 403, 404 | EXISTS |
| POST /v1/permissions/users/:user_id/apps/:app_id/metadata | device Bearer | metadata update | updated | 401, 403, 400 | EXISTS |
| GET /v1/permissions/users/:user_id/buyers | device Bearer | — | buyers the user has permitted | 401, 403 | EXISTS |
| POST /v1/permissions/users/:user_id/buyers | device Bearer | buyer permission | updated | 401, 403, 400 | EXISTS |
| PUT /v1/data-sharing | device Bearer | `{dataSharing: boolean}` | updated sharing choice (separate from consent) | 401, 403, 400 | IN #62 — **keep as a separate toggle** |

Rules: consent is append-only. A grant never implies collection. A revoke
stops capture/upload within ~15s and purges the queue. Every observation
carries the consentId + consentPurpose it was collected under; a mismatch
is rejected.

### 3. DNS monitoring — collector upload

| Method + path | Auth | Request | Response | Errors | Status |
|---|---|---|---|---|---|
| POST /v1/metadata-batches | device Bearer | `{batchId, observations: [{eventId, occurredAt, sourceApp, attribution, destinationHost, protocol, bytesBucket, classification, consentId, consentPurpose}]}` — strict schema, ≤250 per batch | 202 `{batchId, accepted: n}` | 401 unauthorized, 400 invalid_or_non_minimized_metadata, 403 active_purpose_consent_required, 409 replay_detected | EXISTS (schema + consent check) |

Rules: batchId is idempotent — a replay returns 409 and is treated as
delivered by the client. 400 discards the batch. 401/403 halts the collector.
Only the minimized schema is accepted; anything else is rejected, never stored.
Client queue: 2,000 max, AES-GCM encrypted, backoff 2s → 5 min, discard after
8 fails, auth re-checked every 15s.

Phase 0 eligibility and metadata authorization use PostgreSQL device status,
current unexpired consent and the independent data-sharing flag. This path does
not wait for a chain proof. Metadata ingestion rechecks these gates inside the
same transaction that stores the batch. The stricter proof-verification
authorization service remains available separately; chain anchoring is not the
Phase 0 live gate.

### 4. Opportunities, wallet & ledger

| Method + path | Auth | Request | Response | Errors | Status |
|---|---|---|---|---|---|
| POST /v1/marketplace/match | device Bearer | study / opportunity match request | matched opportunities | 401, 400 | EXISTS |
| GET /v1/wallet/:user_id | device Bearer | — | wallet balance / state | 401, 403, 404 | EXISTS |
| GET /v1/wallet/:user_id/ledger | device Bearer | — | append-only ledger entries (incl. #4821-style entries) | 401, 403 | EXISTS |
| POST /v1/wallet/events/earn | device Bearer | earn event | recorded earn | 401, 400 | EXISTS |
| GET /v1/wallet/:user_id/progress | device Bearer | — | tier / level progress | 401, 403 | EXISTS |
| GET /v1/wallet/:user_id/apps | device Bearer | — | apps tied to the wallet | 401, 403 | EXISTS |
| GET /v1/wallet/:user_id/metadata | device Bearer | — | wallet metadata | 401, 403 | EXISTS |
| POST /v1/wallet/:user_id/payout | device Bearer | payout request | payout record | 401, 400, 403 | EXISTS — **payout provider not chosen; sandbox only until decided** |
| GET /v1/intelligence/events/:event_id | device Bearer | — | one intelligence event | 401, 404 | EXISTS |
| POST /v1/intelligence/events | device Bearer | intelligence event | recorded | 401, 400 | EXISTS |
| GET /v1/intelligence/apps/:app_id/summary | device Bearer | — | app summary | 401, 404 | EXISTS |
| GET /v1/inspector/events/:event_id/metadata | device Bearer | — | inspector metadata | 401, 404 | EXISTS |
| GET /v1/inspector/apps/:app_id/gates | device Bearer | — | gates for an app | 401, 404 | EXISTS |
| POST /v1/inspector/apps/:app_id/gates | device Bearer | gate decision | recorded | 401, 400 | EXISTS |
| GET /v1/branding | none | — | KICK'S branding | — | EXISTS |
| GET /v1/branding/mascot | none | — | Kick mascot assets | — | EXISTS |

Fixed $5 rule: every cash/credit opportunity is labelled $5 flat.
Study shares are priced per study, shown in the Ask screen.
No earnings promise. **We never award over-sharing.**

### 5. NOT in the reduced version (full app / 3.0)

- Gamification API v1.4 (`/v1/gamification`, 28 paths, 50 CoCreator Badges,
  gates G1–G11) — spec approved, code not approved, not in main.
- Health datasets, full studies, partner tooling, country boards.

### 6. Data & environments

- Store: memoryStore Maps/Sets in the API today; Postgres is the target —
  disposable test DB only so far (D: drive, port 5433 runbook, not run).
  Do NOT use the existing PostgreSQL instance. DigitalOcean on hold.
- Environments (dev / staging / production) use separate credentials,
  databases, identity tenants, payout accounts, and signing keys.
  Production data is never copied into lower environments.
- Release is blocked until the lifecycle succeeds end to end: real MFA, KYC,
  consent grant, one opportunity, versioned agreement, minimized data result,
  immutable reward entry, sandbox payout, revocation enforcement, audit
  export, backup restore, negative authorization tests.

---

## Part 2 — Full layout, reduced version

Two separate apps (iOS + Android) implementing the same layout and contracts.
Design: SF Pro, white cards, black primary buttons, #2563EB accent,
KICK'S branding throughout, Kick mascot.

### App shell — bottom tabs (existing structure in `apps/mobile/app/`)

| Tab | Route | What it shows |
|---|---|---|
| Activity | `index.tsx` | Home — vault summary, tier card ("Your tier — Contributor, 60% to Co-Creator" + progress bar), recent activity, DNS monitoring status (ON/OFF + why) |
| Engine | `engine.tsx` | Monitoring — DNS monitoring state, gates checklist, what is being watched (systems, not you), pause / resume, **exfiltration feed** (see below) |
| Permissions | `permissions.tsx` | Permissions — per-app permissions, buyers, consent log, data-sharing toggle (separate from consent) |
| Opportunities | `opportunities.tsx` | Opportunities — matched studies, fixed $5 opportunities, Ask flow entry |
| Wallet | `wallet.tsx` | Wallet — balance, ledger (incl. Ledger #4821-style entries), earn events, payout (sandbox until provider chosen) |
| Settings | `settings.tsx` | Settings — account, monitoring toggle (explicit activation, never persisted), notifications, revoke all, sign out, leaderboard opt-in |

### Consent flow — Ask / Modify / Receipt (the core screens)

**Screen 1 — Data Request (Ask)**
- Header: KICK'S, Verified badge, requester card (mock: Nike Running)
- "wants to know:" — specific count, e.g. Last 30 days of running routes, 12 runs
- For: personalized shoe recommendation
- Pays: $2.50 credit (mock example)
- Access: 24 hours, then auto-revoked
- Banner: "You control what you share. No data leaves your vault until you approve."
- Buttons: Decline | Modify | Allow Once
- Modify focuses Screen 2.

**Screen 2 — Modify Request**
- Toggles: Distance & pace $0.90 (4 runs), Exact map routes $0.70 (4 runs),
  Shoe type $0.90 (4 runs)
- Live price: $2.50 all on / $1.80 with maps off / $0.90 distance only —
  pulses blue "updated" (#2563EB) on change
- Privacy ↔ Value slider (0 Privacy, 1 Balanced, 2 Value) drives the toggles
- Buttons: Cancel | Update & Continue → Screen 3

**Screen 3 — Receipt**
- Done checkmark, "Shared 8 runs with Nike for $1.80" (tied to toggles left on)
- Expires tomorrow, 9:41 AM
- Revoke Now → switches to Revoked (disabled) + banner
  "Access revoked. Data no longer accessible."
- Ledger card: Ledger entry #4821, Confirmed, Requester / Runs shared /
  Amount / Shared / Expires / Access, View proof >
- Bottom nav: Vault / Ledger / Requests / Settings

### Consent and enrollment acceptance criteria

The iOS account-registration screen now has two steps (email, then password and
account choices), a step indicator, inline email validation, accessible field
labels, and screen-reader focus on errors. Users can opt in to an encrypted
on-device draft, or explicitly save it before returning to sign-in. Drafts
expire after 30 days and contain only the email, current step, optional
marketing choice, and policy versions; passwords and consent choices are never
saved. Users can resume or discard a draft. This is registration recovery, not
proof that a user has granted monitoring consent.

Remaining release criteria:

- Use short, plain-language summaries that say what is requested, why, who
  receives it, the reward (clearly marked as an example where applicable), and
  when access ends. Show these terms before the decision and repeat the exact
  saved choices and expiry on the receipt.
- Allow users to decline without penalty or blocking unrelated app use. Record
  the decline as a decision; no collection or upload is allowed. The user can
  return to Permissions later and make a new decision.
- Test that leaving and reopening the app restores an opted-in draft, while
  opting out or discarding it removes the local draft. Test that changed Terms
  or Privacy versions restart the decision step and require fresh acceptance.
  Never treat a draft as consent.
- On loss of connectivity or app closure, do not display an unconfirmed
  decision as saved. On return, reload the authoritative server state before
  showing or changing consent. Retries must be idempotent; if the saved state
  cannot be confirmed, keep collection off and offer retry.
- Let users review and change saved choices from Permissions. A change creates
  a new append-only decision, and the screen reflects server-confirmed state.
  Expired or revoked decisions never resume collection automatically.
- Verify all steps, choices, errors, and recovery actions with keyboard and
  screen-reader testing on supported devices. Labels must identify their
  control, errors must be announced and actionable, and focus must move to the
  error summary after a failed submission.
- Before release, test declined consent, abandonment and resume, incomplete
  input, offline submission, return after expiry, and changed choices. Record
  enrollment starts/completions, declines, recovery completions, and consent
  comprehension in aggregate only; do not include consent contents or user
  identifiers. Report denominators and compare completion and comprehension
  against a pre-change baseline before claiming an improvement.

### Exfiltration feed — inside Monitoring (Engine tab)

Monitoring is consistent by design — it runs continuously, in the background,
so the feed is always live. Inside the Engine tab, the feed is a list of
**data cards**, one per exfiltration event (one DNS observation / one system
contact).

- Each card shows at a glance: destination host, when it happened, protocol
  (dns), bytes bucket (e.g. 0-1KB), and the consent it was collected under.
- **Hover over a card (desktop / web) or tap it (mobile) to expand it** —
  full details: eventId, occurredAt, destinationHost, bytesBucket,
  classification, attribution (unknown for DNS), consentId + consentPurpose,
  and the Revoke / pause action for that source.
- Cards are minimized by design: no payloads, no URLs, no paths, no content.
  What you see is what the system did — which domain was contacted, when,
  how much — not what you said or did.
- Feed is live while monitoring is ON, and stops (with a clear "monitoring
  paused" state) when monitoring is OFF, revoked, or a gate fails.
- Filter: by consent, by time, by destination host. No filter ever shows
  data collected without consent — that data does not exist in the feed.

### Leaderboard (small, global, opt-in)

- Card on Activity / profile: tier, progress bar, one tap to the board.
- Board: top 100 global + your rank privately, weekly refresh, display name
  only, no earnings, no location, no study/data type. Opt-in only, default off.
- Never appears inside a consent decision.

### Screens NOT in the reduced version

- Gamification / badge collection screens (3.0)
- Health data screens (3.0, separate explicit consent)
- Partner / admin screens (separate portal, not the consumer app)

### Components (React Native, per app)

- `components/DataRequest.tsx` — Screen 1
- `components/ModifyRequest.tsx` — Screen 2 (toggles + slider + live price)
- `components/Receipt.tsx` — Screen 3 (Revoke + Ledger card)
- `components/VaultCard.tsx`, `components/TierCard.tsx`,
  `components/LeaderboardCard.tsx`, `components/MonitoringStatus.tsx`
- Shared tokens: `--accent: #2563EB`, `--ink: #0A0A0A`, `--bg: #F5F5F7`,
  iPhone frame 44px radius, notch, home indicator, safe-area-inset-top.
  Prototype implementation notes: Tailwind CSS + Lucide icons.

### Native per platform (separate apps)

- **Android app:** Expo / React Native + Kotlin native layer — VpnService
  DNS collector (TUN, 10.111.222.2/32, port 53 only), Keystore storage,
  foreground notification "KICK'S privacy monitoring".
- **iOS app:** Expo / React Native + native iOS layer — Packet Tunnel DOES exist in repo branches (PacketTunnelProvider.swift, WireGuard, NEPacketTunnelProvider, commit b63bc17, Oct 10, 2026; KicksTunnelModule, with-kicks-packet-tunnel plugin, ios-tunnel-validation workflow) — NOT in main HEAD; still needs merge + target/entitlements/signing + signed-device verification before DNS monitoring ships on iOS.
- Shared: API contracts, consent logic, design tokens, navigation model.
