# KICK'S — iOS app

Expo SDK 57 / React Native 0.86.2 / React 19.2.3 / Expo Router / TypeScript.
Version 0.2.6. EAS project `ezekiel-ios` (owner `datastorm-inc`, projectId
`1d2a0901-41c9-4026-b835-139e785db502` — reused from the existing EAS project).

## Native layer — Packet Tunnel

`PacketTunnelProvider.swift` (WireGuard, `NEPacketTunnelProvider`) + the
`kicks-tunnel` Expo module (`KicksTunnelModule.swift`,
`EncryptedObservationOutbox.swift`) + the `with-kicks-packet-tunnel` config
plugin. The tunnel is added only when `KICKS_IOS_NATIVE_TUNNEL=1`
(`app.config.js`, `eas.json` `ios-device` profile).

**Status: the tunnel exists in this repo's branches, NOT in any main branch,
and signed-device / physical-device verification is still outstanding.
Do not treat the tunnel as verified until that evidence exists.**

## Tabs

Activity · Engine (exfiltration feed) · Permissions · Opportunities · Wallet ·
Profile · Settings, plus Account and My Devices (reachable from Settings, not
on the tab bar). The iOS app wraps the tabs in a `SessionProvider`
(`components/SessionProvider.tsx`).

## What is iOS-only vs shared

- **iOS-only:** `native/PacketTunnel/`, `modules/kicks-tunnel/`,
  `plugins/with-kicks-packet-tunnel.js` (+ `prepare-wireguard-source.js`,
  `WIREGUARD_BUILD.md`), `components/IosCollectorControls.tsx`,
  `services/iosApiOrigin.*`, `services/iosCollectorActivation.*`,
  `services/iosNativeAdapter.*`, `app.config.js`, `eas.json`,
  `scripts/prepare-eas-go.cjs` + `install-eas-go.sh` +
  `test-encrypted-outbox.swift`, `.github/workflows/ios-tunnel-validation.yml`
  and `ios-validation.yml`.
- **Shared Expo shell, iOS lineage:** the screens, `SessionProvider`,
  `useMonitoringPolicy`, `AccountPermissions`/`AccountWallet`, `live-engine`,
  and the `profileService` / `sessionCore` / `deviceService` /
  `monitoringPolicy` services. These are the same app code as `apps/android/`
  except where the iOS lineage moved ahead (session stack, Profile / Account /
  My Devices screens, `settings.tsx` rendering `IosCollectorControls` on iOS).
  Files identical to `apps/android/` are noted in `docs/IOS_BRINGOVER_NOTES.md`.
- **Shared with Android:** `packages/consent-preview` supplies the floating ASK
  preview to both apps. The examples do not create consent, share data, or
  create a wallet receipt. Real grant and revocation controls remain unavailable
  until secure device enrollment and server-enforced study scope and expiry are
  implemented.

## Auth

Device-bearer throughout. No OIDC code anywhere in this app. The iOS client
calls `/v1/session`, `/v1/account`, `/v1/devices`, `/v1/monitoring-policy`,
`/v1/me/consumer-state`, `/v1/snapshot`, `/v1/products/kicks` — several of
these have no server implementation in the new repo yet (see
`docs/IOS_BRINGOVER_NOTES.md`). The tunnel lease protocol
(`activationId` / `revision` / `recoveryEpoch`) also has no server side yet;
its API support files were held for reconciliation onto the device-bearer
server.

## Tests

`npm test` in this directory runs the iOS service tests
(`node --test` on the `.mjs` / `.cjs` suites): 94 tests, all passing as staged
(verified locally 2026-11-06). TypeScript typecheck runs in CI
(`ios-validation.yml`); it was not run locally during staging.
