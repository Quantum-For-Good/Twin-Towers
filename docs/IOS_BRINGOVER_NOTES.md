# iOS bring-over notes — draft PR #2 (Quantum-For-Good/KICKS)

Source: old repo `DataStorm-Inc/KICKS_101_Android-`.
Primary source branch: `origin/codex/ios-fresh-consent-stop-20261029`
(head `2b4ccda`, KICK-S2-20261029-004, Oct 29, 2026) — the newest iOS work:
stop/cleanup, lease renewal (`activationId` / `revision` / `recoveryEpoch`),
`EncryptedObservationOutbox.swift`, session stack.
Plus one file from `origin/implementation/ios-native-collector`
(head `9d888ec`): `apps/ios/scripts/prepare-eas-go.cjs` (WireGuard Go archive
build). The two branches diverged; the fresh branch is otherwise a superset
of the implementation branch for iOS purposes (see "Left out" below).

Target branch: `ios/collector-bringover`. Draft PR, do not merge.
Auth: device-bearer throughout. **No OIDC code anywhere in this PR**
(grepped 2026-11-06: zero matches for oidc/Auth0/IdP in the staged iOS code).

## What is in apps/ios/ (63 files)

The full iOS app, self-contained — no imports across to `apps/android/`.
Staged as the fresh branch's `apps/mobile/` tree, minus the Android native
directory, with the mascot copied from the local Android staging copy.

**iOS-only (native/config):**
- `native/PacketTunnel/PacketTunnelProvider.swift` (+ README) — WireGuard
  `NEPacketTunnelProvider`, lease-gated, renewal via `renew-v1` / `status-v1`
  app messages. Origin: commit `b63bc17` (Oct 10, 2026), then the fresh
  branch's lease-renewal additions.
- `modules/kicks-tunnel/` — `KicksTunnelModule.swift`,
  `EncryptedObservationOutbox.swift`, `KicksTunnel.podspec`, config, README.
- `plugins/with-kicks-packet-tunnel.js`, `prepare-wireguard-source.js`,
  `WIREGUARD_BUILD.md`.
- `components/IosCollectorControls.tsx` (renders in Settings on iOS only).
- `services/iosApiOrigin.*`, `services/iosCollectorActivation.*`,
  `services/iosNativeAdapter.*` (each with tests).
- `app.config.js` (adds the tunnel plugin only when
  `KICKS_IOS_NATIVE_TUNNEL=1`), `eas.json` (`ios-device` profile sets it),
  `scripts/prepare-eas-go.cjs`, `scripts/install-eas-go.sh`,
  `scripts/test-encrypted-outbox.swift`.
- `app.json` — slug `ezekiel-ios`, owner `datastorm-inc`, version `0.2.6`,
  iOS bundle id `com.datastorm.kicks`, EAS projectId
  `1d2a0901-41c9-4026-b835-139e785db502` (reused from the existing EAS project).
- `.github/workflows/ios-tunnel-validation.yml`,
  `.github/workflows/ios-validation.yml` (paths adapted `apps/mobile` →
  `apps/ios`; validation push branch adapted to `main`).

**Shared Expo shell, iOS lineage (differs from apps/android/):**
- Session stack the collector controls depend on:
  `components/SessionProvider.tsx`, `components/useMonitoringPolicy.ts`,
  `services/sessionCore.ts`, `services/profileService.ts`,
  `services/deviceService.mjs`, `services/monitoringPolicy.ts` (+ tests).
- New screens: `app/account.tsx`, `app/profile.tsx`, `app/my-devices.tsx`;
  changed screens: `app/_layout.tsx` (SessionProvider wrapper, Profile /
  Account / My Devices tabs), `app/settings.tsx` (renders
  `IosCollectorControls` on iOS), `app/permissions.tsx`, `app/wallet.tsx`.
- `components/AccountPermissions.tsx`, `components/AccountWallet.tsx`,
  `components/live-engine.ts`.
- `services/intelligenceApi.ts`, `services/permissionsApi.ts`,
  `services/walletApi.ts` (small iOS-lineage diffs).
- `package.json` — version `0.2.6`, `test` script for the iOS suites,
  `eas-build-post-install`, deps add `expo-secure-store`, `expo-crypto`.
- `tsconfig.json` (iOS-lineage version).

**Files byte-identical to apps/android/ (deliberate duplication, each app is
self-contained):** `app/engine.tsx`, `app/index.tsx`,
`app/opportunities.tsx`, `components/ActivityFeed.tsx`,
`components/Brand.tsx`, `constants/branding.ts`, `expo-env.d.ts`,
`assets/brand-manifest.json`, `assets/kicks-mascot.png`.

**Rename made during staging:** `apps/ios/package.json` name changed
`@kicks/mobile` → `@kicks/ios`, and `ios-validation.yml` typecheck step
updated to `npm --workspace @kicks/ios run typecheck`. Both apps were named
`@kicks/mobile`, which npm workspaces rejects as a duplicate. Root
`package.json` `build` script still references `@kicks/mobile` (Android) —
left untouched; renaming Android to `@kicks/android` is a follow-up, not done
here.

## Verification done locally (2026-11-06)

- iOS service tests: **94 pass, 0 fail**
  (`node --test` on `iosApiOrigin`, `sessionCore`, `profileService`,
  `iosCollectorActivation`, `iosNativeAdapter`, `deviceService`,
  `monitoringPolicy` suites).
- `tsc --noEmit` was **NOT** run locally — no `node_modules` / TypeScript
  available in this environment without a heavy install. Typecheck runs in
  CI (`ios-validation.yml`); do not claim it passed.
- **Signed-device / physical-device verification of the iOS tunnel is still
  outstanding.** The tunnel exists in branches, not in any main branch, and
  has never been verified on a real iPhone from this repo.

## Left out — and why

- `apps/mobile/android/` (Android native layer) — lives in `apps/android/`.
- Old-repo API iOS support files (`services/api/src/ios-gateway-enrollment.ts`,
  `ios-device-provisioning.ts`, `ios-runtime-config.ts`,
  `collector-recovery.ts`, `batch-digest.ts`, `consumer-device-bindings.ts`,
  `ios-beta.mjs`, `store.ts`, `consumer-identity.ts`, …) — they belong to a
  different API lineage and import modules (`./store.js`,
  `./consumer-identity.js`) that do not exist in the new repo's device-bearer
  server. **HELD for reconciliation onto the device-bearer server.**
  Consequence: the tunnel lease protocol (`activationId` / `revision` /
  `recoveryEpoch`) and the iOS client endpoints `/v1/session`, `/v1/account`,
  `/v1/monitoring-policy`, `/v1/me/consumer-state`, `/v1/snapshot`,
  `/v1/products/kicks` have **no server implementation in the new repo yet**.
  The client code is staged; the server side is a follow-up, same as the
  Android auth decision was for PR #1.
- `.github/workflows/ios-operational-validation.yml` — references
  `services/api/src/ios-beta.test.mjs` and `infrastructure/ios-gateway/`,
  neither of which is staged. Held with the API files above.
- `infrastructure/ios-gateway/` (staging gateway, host runner, drills) —
  staging infrastructure, not app code; not in reduced-version scope.
- `docs/release/` except `IOS_COLLECTOR_RECONCILIATION_20261010.md` (staged)
  — other release docs are beta-process records, not code.
- Old-repo `README.md`, `SECURITY.md`, `CHANGELOG.md` — superseded by the
  new repo's branded README.
- `identityApi.ts` (OIDC enroll client from PR #62) — absent from the iOS
  lineage; correctly absent here under the device-bearer decision.

## Known CI blockers (do not claim checks passed)

1. **Root `package-lock.json` is stale for the iOS workspace.** It was
   brought over for `apps/android` only; `apps/ios` (`@kicks/ios` 0.2.6) is
   not in it, so `npm ci` at the workspace root will fail until the lockfile
   is regenerated (`npm install`) after this PR lands. Regeneration needs a
   full install; it was not done during staging.
2. **No iOS checks have run in the new repo.** The workflows are staged
   here; they run on the PR once it is pushed.
3. The tunnel validation workflow needs macOS runners, Xcode 26.6, Go 1.19.13,
   and the WireGuard Apple sources (`prepare-wireguard-source.js`); the
   unsigned-device build step asserts the `KicksPacketTunnel.appex` exists
   with bundle id `com.datastorm.kicks.PacketTunnel`.
