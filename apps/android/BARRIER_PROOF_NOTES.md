# Gated Fail-Closed Lock — Android proof (issue #11)

Proof of the network enforcement barrier for the KICK'S Android app. Spec: issue #11
plus `Agent_Lock_plus_Gated_Fail_Closed_Lock_Design.md`. This note is the record of what
was built, what was deliberately left out, and what still needs a real device.

## What the barrier is

Authorization means all three, checked together every time: a device bearer, an active
session, and an unrevoked consent for the purpose. Absent, expired, revoked, or
unverifiable authorization means traffic is blocked (fail closed). Enforcement is DNS
first (IPv4/UDP port 53), then the packet layer. Only destinations covered by a live
authorization pass, within consent scope. Gate decisions are recorded in a separate
barrier ledger (event id, time, destination host, decision, reason, consent id) — never
in the consent ledger, never in the collector's observation queue.

## Locked decisions (applied)

- Android first, then Windows, then iOS.
- Authorization TTL 1 hour, refreshed silently in the background while online. The
  refresh is the ledger worker: its upload step re-checks the gate (always a fresh
  fetch) at least every 15 seconds while the barrier is ACTIVE. That is also the G3
  mechanism — a revocation halts the worker within one pump step (~15s) and the halt
  stops the barrier. There is no separate refresher thread.
- Asymmetric inbound: outbound needs authorization; inbound is allowed only as a reply
  to an authorized outbound connection. Enforced at the reply boundary: the service
  writes a reply back into the tunnel only while the barrier is ACTIVE and the outbound
  flow that caused it is still recorded (`allowDnsReply` / `allowUdpReply`).
- Separate barrier ledger, with the consent id on every record that has one to name
  (see "Consent id on a block" below). The consent ledger stays consent-only.

## Files

Android (pure core — compiled and run by the existing `collector-core` CI job, no
workflow change; files live directly in `vpn/core/`, no `android.*` imports):

- `apps/android/android/app/src/main/java/com/datastorm/kicks/vpn/core/Barrier.kt` —
  `BarrierReason`, `BarrierGate` (1-hour TTL cache; no data-sharing gate — the barrier
  enforces traffic, it does not share data), `BarrierDecision`, `BarrierController`
  (lifecycle, DNS + packet entry points, reply boundary, ledger worker).
- `apps/android/android/app/src/main/java/com/datastorm/kicks/vpn/core/BarrierLedger.kt` —
  `BarrierDecisionRecord`, `BarrierLedgerBatch`, `BarrierLedgerQueue` (bounded,
  encrypted persistence, replay-safe batch ids), `BarrierLedgerPump`.
- `apps/android/android/app/src/main/java/com/datastorm/kicks/vpn/core/BarrierPacket.kt` —
  IPv4 packet parsing, `BarrierConnectionTable` (authorized outbound flows),
  `BarrierResolverCache` (IPs that authorized DNS answers returned),
  `BarrierDnsAnswer` (DNS response parsing for A records), UDP reply building.
- `apps/android/android/app/src/test/java/com/datastorm/kicks/vpn/core/BarrierTest.kt` —
  62 tests: gate, DNS decisions, packet layer, ledger, controller lifecycle.

Android (service layer — same `KicksVpnService`, because Android allows one active
VpnService; the two subsystems are independently gated and independently killable
inside it):

- `apps/android/android/app/src/main/java/com/datastorm/kicks/vpn/BarrierRuntime.kt` —
  wiring. Shares the collector's session store, device binding, OS authorization, and
  authority endpoint (the same device bearer and consent, never a copy). Own Keystore
  key (`kicks_barrier_v1`) and ledger file (`barrier-ledger.bin`).
- `apps/android/android/app/src/main/java/com/datastorm/kicks/vpn/BarrierHttp.kt` —
  ledger uploader, POST /v1/barrier-decisions.
- `apps/android/android/app/src/main/java/com/datastorm/kicks/vpn/KicksVpnService.kt` —
  two tunnel modes (collector-only /32, barrier full 0.0.0.0/0), packet dispatch through
  the barrier gate, reply-boundary checks, tunnel rebuild when the barrier stops.
- `apps/android/android/app/src/main/java/com/datastorm/kicks/vpn/KicksVpnModule.kt` —
  `startBarrier` / `stopBarrier` / `getBarrierStatus`; session change and logout also
  stop the barrier.
- `apps/android/android/app/build.gradle` — `BARRIER_ENABLED` build flag
  (`kicks.barrierEnabled`, default false). The barrier reuses `COLLECTOR_API_BASE_URL`.

API (companion to this proof — the client works without it, the ledger just stays
queued on the device until the endpoint lands):

- `services/api/src/barrier-repository.ts` — `PostgresBarrierRepository`, mirroring
  `PostgresMetadataRepository`. The consent check is OWNERSHIP, not an active grant:
  a decision recorded under a consent that is later revoked is still a true historical
  record. It deliberately does not go through the collector authorization service
  (that service requires an active grant and would reject exactly the records the
  ledger exists to keep).
- `services/api/src/server.ts` — POST /v1/barrier-decisions (202 / 409 replay / 403
  consent_not_found / 401 device_not_active / 503 persistence unavailable). An allow
  must carry a consent id (400 otherwise); a block may carry null.
- `services/api/db/schema.sql` — `barrier_batches` + `barrier_decisions`, append-only
  (REVOKE UPDATE, DELETE), mirroring the metadata tables.
- `services/api/src/server.test.ts` — 7 tests for the route.

## What the barrier does NOT do (by design)

- No content inspection, no payload. Decisions are on destination and authorization only.
- No data-sharing gate. Data sharing governs whether collected data leaves the device;
  the barrier enforces traffic, so it does not gate on it. (A build with data sharing
  off still enforces — tested.)
- The ledger is an audit trail and is never purged: a stop for authorization loss
  persists it instead of purging it (unlike the collector queue). Records survive
  restarts and upload when authorization returns. There is no retain-consent step.
- The ledger records DNS gate decisions only. Packet-layer blocks are counted in the
  barrier status, not uploaded as records: a packet is allowed or blocked as the
  consequence of the DNS decision that authorized its destination, so recording every
  packet would flood the ledger with enforcement consequences instead of decisions.

## Spec clarifications (decisions taken while building)

- **Consent id on a block.** The design says "consent id on every record". An allow
  always carries the live grant's id. A block carries the last-known grant's id when
  one exists (for example a revoked consent). When no consent ever existed there is no
  id to name, so the record carries null — a block must still be recorded. The server
  accepts null only on a block, never on an allow.
- **Reason field.** The design's minimized form is five fields (event id, time,
  destination host, decision, consent id). A sixth field, `reason`, is recorded with
  each decision: a block without a reason is unauditable. It is nullable and bounded
  to 64 characters on both sides.
- **Ledger schema version.** `2026-11-10` (the barrier ledger is a different schema
  from the `2026-08-01` observation schema).

## Named gaps (not built in this proof)

- **TCP relay.** The barrier decides TCP packets (allow to a resolved IP, block
  otherwise) but the service has no user-space TCP relay yet, so an allowed TCP packet
  is dropped and counted until a relay lands. This is the largest remaining piece
  before the barrier can be enabled for general use: without it, authorized HTTPS
  cannot connect. G2's "connect" half is therefore not demonstrable on a device yet.
- **IPv6.** The barrier tunnel is IPv4 only. IPv6 traffic is not routed through it.
  A production barrier must route ::/0 and enforce IPv6 the same way.
- **POST /v1/barrier-decisions is not in the repo yet.** The client side is complete
  and the companion route, repository, tables, and tests are in this proof; until the
  route is merged, the ledger stays queued on the device (the barrier keeps
  enforcing). The repository and schema have not been run against a live Postgres.
- **The KICK'S app is excluded from its own barrier tunnel**
  (`addDisallowedApplication`). This is the bootstrap exemption: the control plane
  (authorization and ledger upload) must be able to reach the authority, or the
  barrier could never prove authorization because its own authority call would be
  blocked by itself. All other apps' traffic is enforced. Consequence: the collector
  no longer observes the KICK'S app's own DNS while the barrier is on.
- **One-VpnService coordination.** The collector and barrier share one service. The
  coordination (tunnel rebuild when the barrier stops, service kept alive while either
  subsystem is active) is new logic in `KicksVpnService` and needs device verification.

## Gates G1–G7 (status)

All gates are **code ready, needs device verification**. None was run on a real device.

- G1 — no authorization → DNS blocked. Covered by `BarrierGateTest` (every denial
  reason) and `BarrierDnsTest`; device check: enable the barrier with no session and
  confirm DNS fails.
- G2 — authorization granted → authorized destinations resolve and connect. DNS half
  is covered by tests; the connect half is blocked by the TCP relay gap above.
- G3 — revoke → blocked within ~15s. Mechanism: the ledger worker re-checks the gate
  every ~15s and its halt stops the barrier (tested at the pump level). The DNS path
  itself reuses the 1-hour cached authorization, so the worker — not the DNS path —
  is what notices the revocation. Device check: revoke consent, confirm traffic stops
  within ~15s.
- G4 — kill the barrier → traffic stays blocked. The barrier's stop closes the tunnel
  (or rebuilds it to collector-only mode when the collector is still active). Device
  check: force-stop the barrier and confirm no traffic leaks.
- G5 — reboot → locked until re-authorized. The gate starts deactivated and the
  service never auto-starts; the session must be present and the authority must
  confirm. Device check: reboot, confirm the barrier does not come up on its own.
- G6 — authorization service unreachable → locked. Covered by tests (Unavailable →
  PAUSED, traffic blocked). Device check: authority down, confirm the barrier locks
  once the 1-hour TTL expires (the worker keeps it fresh while online).
- G7 — barrier disabled → device recorded as unprotected, no protection claimed.
  The barrier reports its state through `getBarrierStatus`; there is no ledger record
  for "disabled". Device check: disable the barrier, confirm the status reads
  disabled and nothing claims protection.

## Verification done here

- Kotlin core + tests: compiled with kotlinc 2.1.21 + JDK 17 (the exact CI
  collector-core job) and run with JUnitCore. 133 tests: 71 existing + 62 new barrier
  tests. All barrier tests pass. One existing collector test
  (`consentRevokedMidFlightStopsAndPurgesWithoutUpload`) is a pre-existing flake — it
  failed 1 of 3 runs with the original files alone (worker-thread race in that test),
  not a regression from this proof.
- Android service layer: compiled with kotlinc 2.1.21 against minimal Android/React
  stubs (no Android SDK on this machine). Type-checks clean. The stubs are
  verification scratch, not part of this proof.
- API: `tsc --noEmit` clean; `npm test` 22/23 pass. The one failure
  (`serves web app index.html on root path`) fails identically with the original files
  in this setup — it needs the built web app (`dist/`), which CI builds before testing.
- NOT verified: anything on a real device (G1–G7), the Postgres repository and schema
  against a live database, the Gradle build, the tunnel rebuild coordination, or the
  React Native bridge at runtime.
