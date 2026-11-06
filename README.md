<div align="center">

# KICK'S

### Your data. Your vault. Your pay.

**Consumer data rights and compensated participation.**

KICK'S flips uninformed consent into compensated participation. You choose what you share, you see the trade first, you can revoke it in one tap — and when your data is used, you are part of that value.

</div>

---

## Branding

- **Name:** KICK'S — keep the name, the Kick mascot, and the gold styling throughout.
- **Colours:** black background `#0A0A0A` · gold `#FFD700` / `#FFB800` · accent blue `#2563EB` · light background `#F5F5F7`
- **Voice:** Kick, the golden orb mascot. Warm, direct, plain language. No jargon.
- **Taglines:** "Consistent monitoring of the systems around you. Private by default, always." · "We watch how systems behave. We don't watch you."

## Two separate apps, one contract

This repository holds **two separate apps** so one's work can never block the other's. They share one API, one consent flow, one vault, one ledger — and ship separately.

| App | Path | Native layer |
|---|---|---|
| Android | `apps/android` | Kotlin `VpnService` DNS collector (TUN, `10.111.222.2/32`, port 53 only) |
| iOS | `apps/ios` | `PacketTunnelProvider` (WireGuard, `NEPacketTunnelProvider`) — exists in the KICKS_101_Android- repo branches, to be brought into this repo and merged |

**Shared:** API + contracts (`services/api`), consent flow (Ask / Modify / Receipt), vault, ledger + Revoke Now, tiers + global leaderboard, fixed $5 opportunities, KICK'S branding.

**Separate per app:** native code, builds, CI, signing, collector, device verification.

## Reduced version — Tuesday, November 24, 2026

Android-first for DNS monitoring. iOS is the second app. Full app (KICK'S 3.0, both apps) Q1 2027.

**In scope:** vault · Ask / Modify / Receipt · Ledger + Revoke (~15s) · DNS monitoring · tiers + global leaderboard · fixed $5 opportunities.

**Saved for 3.0:** gamification v1.4 / all 50 CoCreator Badges · full studies · partner tooling · health datasets · country boards.

## The core feature — DNS monitoring

Both versions carry it. Android `VpnService` TUN, DNS only (IPv4/UDP port 53). Only the destination host is read. Minimized schema only — no payloads, URLs, paths, or content. All gates fail closed; consent alone never starts collection; revocation stops capture within ~15 seconds. Monitoring is consistent by design: it watches how *systems* behave.

Inside the app (Engine tab) the **exfiltration feed** shows one data card per event — destination host, time, protocol, bytes bucket, consent at a glance. Hover (desktop/web) or tap (mobile) to expand full details, including Revoke / pause.

## Consent — Ask / Modify / Receipt

- **Ask:** a trade, not Terms. 12 runs, personalized shoe recommendation, $2.50 credit (mock example), 24 hours then auto-revoked. Decline / Modify / Allow Once.
- **Modify:** Distance & pace $0.90, Exact map routes $0.70, Shoe type $0.90. Live price, Privacy ↔ Value slider.
- **Receipt:** what was shared, Ledger entry, Revoke Now, into Vault history.

**MVP rule:** see exactly what row is leaving, change the price, revoke in one tap.

## Standing rules

- **Fixed $5:** every cash/credit opportunity is labelled $5 flat. Login streaks level you up; they don't pay cash.
- **We never award over-sharing.** No reward, bonus, tier, or leaderboard progress for sharing more data than a consumer chose to share. Pay is per study, per trade — never per gigabyte, never for volume.
- **No earnings promise** anywhere — app, reels, leaderboard, posts.
- **Merges** need passing checks **plus** explicit approval. No merging on a billing lock, no auto-resolving an auth-model conflict.

## Layout

```
apps/android/     Android app (Expo / React Native + Kotlin native layer)
apps/ios/         iOS app (Expo / React Native + Swift native layer)
services/api/     Fastify API — device Bearer auth, consent, metadata batches,
                  permissions, marketplace, wallet/ledger
docs/             API specs + full layout, requirements, datasets, opportunities
```

## Status

Scaffold only. The build starts from the reduced-version outline; the existing KICKS_101_Android- work (collector, consent, API) is the source to bring over, not to rewrite from memory.

*KICK'S is a DataStorm Inc. product. This repository lives under the Lgeci Insurance Group enterprise (org Quantum-For-Good) while the build starts.*
