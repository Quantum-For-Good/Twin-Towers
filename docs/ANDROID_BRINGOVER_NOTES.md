# Android-first bring-over — notes

Source: `DataStorm-Inc/KICKS_101_Android-`, branch
`copilot/implement-native-collector-end-to-end` (PR #62, head `8083b72`),
compared against that repo's main (`2f357dc`).
Destination: this repo, branch `android/collector-bringover` → main (draft PR).

## What came over

- **Expo app** (`apps/mobile/` → `apps/android/`): screens, components,
  services, constants, `app.json`, `package.json`, `tsconfig.json`,
  `expo-env.d.ts`, `assets/brand-manifest.json`.
- **Android native collector** (`apps/android/android/`): `VpnService` DNS TUN
  (`KicksVpnService`, `KicksVpnModule`, `KicksVpnPackage`, `CollectorRuntime`,
  `AuthorityHttp`, `SecureStorage`) plus pure-Kotlin core (`Authorization`,
  `BoundedQueue`, `CollectorController`, `DnsPacket`, `HttpAuthHeaders`,
  `Minimizer`, `Upload`) and the core JVM tests.
- **API, auth-neutral parts only** (`services/api/`): `branding.ts`,
  `intelligence.ts`, `permissions.ts`, `wallet.ts`, `start.ts`,
  `package.json`, `tsconfig.json`, `db/schema.sql`.
- **Workspace root**: `package.json` (workspaces `apps/*`, `services/*`),
  `package-lock.json`, `.env.example` (placeholders only, no secrets).
- **Docs**: `ANDROID_COLLECTOR.md`, `ZERO_TRUST_COLLECTOR.md`.

## What was deliberately left out — and why

- **`services/api/src/server.ts`, `server.test.ts`, `oidc.ts`, `oidc.test.ts` —
  THE AUTH DECISION.** PR #62's server authenticates with OIDC IdP JWTs
  (`oidcFromEnv`, `POST /v1/devices/enroll`, `GET /v1/collector/eligibility`,
  `PUT /v1/data-sharing`, staging devices gated behind
  `KICKS_ENABLE_STAGING_DEVICES`). Main's incumbent model is device-bearer
  auth (`CollectorAuthorizationService`, merged via PR #87, `e100794`).
  The two models conflict across 13 files. Neither was picked here.
  **The API as brought over will not typecheck or run** — `start.ts` imports
  `./server.js`, which is absent until Ezekiel decides: device-bearer (main)
  wins, OIDC (#62) wins, or a reconciled server is written.
  The client `identityApi.ts` still calls `POST /v1/devices/enroll` (OIDC);
  that call has no server to answer it until the decision is made.
- **`apps/android/assets/kicks-mascot.png`** — binary. The connector's
  snapshot push carries UTF-8 text only; add the mascot image separately
  (web UI or a later push that supports binaries).
- **`.github/workflows/`** — `quality.yml` on #62 adds a `collector-core` job
  with the path `apps/mobile/android/...` hard-coded; it needs adapting to
  `apps/android/...` before it can run here. No CI exists in this repo yet;
  no checks have passed on this branch.
- **Old-repo `README.md`, `SECURITY.md`, `metadata.json`, `vercel.json`** —
  superseded by this repo's branded README; deployment is on hold.
- **Other docs** (`ANDROID_BETA_LAUNCH_PLAN.md`, `ARCHITECTURE.md`,
  `DESIGN_BASELINE.md`, `PRODUCT_SCOPE.md`) — not needed for this bring-over;
  bring them in later if wanted.

## Status

Draft. Nothing here is merged. The collector code is as-written on PR #62;
it has not been verified on a device from this repo, and the API is
incomplete pending the auth-model decision above.
