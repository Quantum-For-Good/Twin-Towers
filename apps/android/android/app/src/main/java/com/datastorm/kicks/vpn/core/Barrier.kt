package com.datastorm.kicks.vpn.core

import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Gated Fail-Closed Lock: network enforcement barrier (Android proof).
 *
 * Pure JVM Kotlin: no android.* imports, so it compiles in the collector-core CI job.
 *
 * Authorization means all three, checked together every time: a device bearer, an active
 * session, and an unrevoked consent for the purpose. Anything else — absent, expired,
 * revoked, or unverifiable authorization — means traffic is blocked (fail closed).
 *
 * How it differs from the collector's [AuthorizationGate] (deliberate, documented):
 * - No data-sharing gate. Data sharing governs whether collected data leaves the device;
 *   the barrier enforces traffic, it does not share data, so it does not gate on it.
 * - A 1-hour authorization TTL instead of the collector's 30-second buffer cache. DNS and
 *   packet decisions may reuse a cached authorization younger than the TTL; start,
 *   resume, upload, and refresh always ask the authority again. The ledger worker
 *   re-checks the gate (always a fresh fetch) at least every 15 seconds while the barrier
 *   is ACTIVE, so a revocation is noticed within ~15s and the worker's halt stops the
 *   barrier; once the TTL expires without a successful refresh, the next check is
 *   unverifiable and the barrier locks.
 * - Its own reasons ([BarrierReason]) and decisions ([BarrierDecision]): the barrier's
 *   vocabulary is enforcement, not collection, and the two must not drift into each other.
 * - Its own ledger ([BarrierLedgerQueue]): gate decisions are recorded in a separate
 *   barrier ledger, never in the consent ledger and never in the collector's queue.
 *
 * The barrier and the collector are independently gated and independently killable: this
 * controller owns its own gate, queue, pump, and worker, and shares only the
 * session store, the device binding, and the authority client with the collector — the
 * same device bearer and the same consent, read through the same server, never a copy.
 */
enum class BarrierReason {
  BARRIER_DISABLED,
  BARRIER_NOT_CONFIGURED,
  NOT_EXPLICITLY_ACTIVATED,
  NO_SESSION,
  SESSION_EXPIRED,
  SESSION_REVOKED,
  CROSS_ACCOUNT_REJECTED,
  DEVICE_NOT_OWNED,
  CONSENT_NOT_GRANTED,
  OS_VPN_NOT_AUTHORIZED,
  NOTIFICATIONS_BLOCKED,
  AUTHORITY_UNAVAILABLE,
  TUNNEL_FAILED,
  USER_STOP,
  SERVICE_STOPPED
}

/** Points in the barrier lifecycle at which authorization is re-evaluated. */
enum class BarrierPhase { START, RESUME, DNS, PACKET, UPLOAD, REFRESH }

sealed class BarrierDecision {
  data class Allow(val grant: Grant, val session: Session) : BarrierDecision()
  data class Deny(val reason: BarrierReason) : BarrierDecision()
  data class Unavailable(val detail: String) : BarrierDecision()
}

/**
 * Single authorization decision point for the barrier. Every gate is evaluated as a
 * distinct check and everything fails closed: anything other than an explicit
 * [BarrierDecision.Allow] means "block the traffic".
 */
class BarrierGate(
  private val barrierEnabled: Boolean,
  private val sessions: SessionSource,
  private val os: OsAuthorization,
  private val authority: AuthorityClient?,
  private val binding: DeviceBindingStore,
  private val clock: Clock,
  private val authorizationTtlMs: Long = 3_600_000
) {
  @Volatile private var explicitlyActivated = false
  private class Cached(val session: Session, val response: AuthorityResponse, val atMs: Long)
  private var cached: Cached? = null
  @Volatile private var lastGrant: Grant? = null; private set

  fun activate() { explicitlyActivated = true }
  fun deactivate() { explicitlyActivated = false; invalidate() }
  fun isActivated() = explicitlyActivated

  @Synchronized fun invalidate() { cached = null }

  /** The grant that authorized the most recent allow, if any: used to name the consent on a block record. */
  fun lastKnownGrant(): Grant? = lastGrant

  fun check(phase: BarrierPhase): BarrierDecision {
    if (!barrierEnabled) return BarrierDecision.Deny(BarrierReason.BARRIER_DISABLED)
    if (authority == null) return BarrierDecision.Deny(BarrierReason.BARRIER_NOT_CONFIGURED)
    if (!explicitlyActivated) return BarrierDecision.Deny(BarrierReason.NOT_EXPLICITLY_ACTIVATED)
    val session = sessions.current() ?: return BarrierDecision.Deny(BarrierReason.NO_SESSION)
    if (session.expiresAtMs <= clock.nowMs()) return BarrierDecision.Deny(BarrierReason.SESSION_EXPIRED)
    val bound = binding.boundAccount()
    if (bound != null && bound != session.accountId) return BarrierDecision.Deny(BarrierReason.CROSS_ACCOUNT_REJECTED)
    if (!os.vpnAuthorized()) return BarrierDecision.Deny(BarrierReason.OS_VPN_NOT_AUTHORIZED)
    if (!os.notificationsAllowed()) return BarrierDecision.Deny(BarrierReason.NOTIFICATIONS_BLOCKED)

    val response = when (val r = authoritative(phase, session)) {
      is AuthorityResult.Ok -> r.response
      is AuthorityResult.Rejected -> { invalidate(); return BarrierDecision.Deny(mapRejection(r.reason)) }
      is AuthorityResult.Unavailable -> { invalidate(); return BarrierDecision.Unavailable(r.detail) }
    }
    if (!response.sessionActive) return BarrierDecision.Deny(BarrierReason.SESSION_REVOKED)
    if (response.accountId != session.accountId) return BarrierDecision.Deny(BarrierReason.SESSION_REVOKED)
    val owner = response.deviceOwnerAccountId ?: return BarrierDecision.Deny(BarrierReason.DEVICE_NOT_OWNED)
    if (owner != session.accountId) return BarrierDecision.Deny(BarrierReason.CROSS_ACCOUNT_REJECTED)
    if (response.consentState != "granted" || response.consentId.isNullOrBlank() || response.consentPurpose.isNullOrBlank()) {
      return BarrierDecision.Deny(BarrierReason.CONSENT_NOT_GRANTED)
    }
    // Local one-device-one-account binding is recorded only once the server confirmed ownership.
    if (bound == null) binding.bind(session.accountId)
    val grant = Grant(response.consentId, response.consentPurpose)
    lastGrant = grant
    return BarrierDecision.Allow(grant, session)
  }

  /** Background refresh: always asks the authority again and renews the cached authorization. */
  fun refresh(): BarrierDecision = check(BarrierPhase.REFRESH)

  /**
   * Only DNS and PACKET may reuse a cached authorization younger than the TTL; every other
   * phase asks the authority again. A stale cache is never trusted: past the TTL the next
   * check fetches, and a fetch that cannot prove authorization locks the barrier.
   */
  @Synchronized private fun authoritative(phase: BarrierPhase, session: Session): AuthorityResult {
    val now = clock.nowMs()
    val c = cached
    if ((phase == BarrierPhase.DNS || phase == BarrierPhase.PACKET) && c != null && c.session == session && now - c.atMs in 0..authorizationTtlMs) {
      return AuthorityResult.Ok(c.response)
    }
    val result = authority!!.fetch(session)
    cached = if (result is AuthorityResult.Ok) Cached(session, result.response, now) else null
    return result
  }

  /** The authority client reports rejections in the collector's vocabulary; map them to the barrier's. */
  private fun mapRejection(reason: Reason): BarrierReason = when (reason) {
    Reason.SESSION_REVOKED -> BarrierReason.SESSION_REVOKED
    Reason.CROSS_ACCOUNT_REJECTED -> BarrierReason.CROSS_ACCOUNT_REJECTED
    Reason.CONSENT_NOT_GRANTED -> BarrierReason.CONSENT_NOT_GRANTED
    else -> BarrierReason.SESSION_REVOKED
  }
}

sealed class BarrierDnsVerdict {
  data class Allow(val grant: Grant, val session: Session) : BarrierDnsVerdict()
  data class Block(val reason: BarrierReason) : BarrierDnsVerdict()
}

sealed class BarrierPacketVerdict {
  data class AllowUdp(val packet: BarrierPacket.IpPacket) : BarrierPacketVerdict()
  data class AllowTcp(val packet: BarrierPacket.IpPacket) : BarrierPacketVerdict()
  data class Block(val reason: BarrierPacketReason) : BarrierPacketVerdict()
}

data class BarrierStatus(
  val state: State,
  val reason: BarrierReason?,
  val allowedDns: Long,
  val blockedDns: Long,
  val blockedPackets: Long,
  val ledgerQueued: Int,
  val ledgerDropped: Long,
  val flows: Int,
  val resolvedHosts: Int
)

/** Single daemon thread running the ledger pump. [stop] wakes it immediately and [join] guarantees it has exited. */
class BarrierLedgerWorker(
  private val step: () -> BarrierPumpResult,
  private val onHalt: (BarrierReason) -> Unit,
  private val idleMs: Long = 15_000
) {
  private val stopSignal = CountDownLatch(1)
  private var thread: Thread? = null

  @Synchronized fun start() {
    if (thread != null) return
    thread = Thread({
      while (stopSignal.count > 0) {
        val wait = try {
          when (val r = step()) {
            is BarrierPumpResult.Halted -> { onHalt(r.reason); return@Thread }
            is BarrierPumpResult.RetryLater -> r.delayMs
            is BarrierPumpResult.Uploaded -> 0L
            BarrierPumpResult.Idle -> idleMs
          }
        } catch (e: Exception) { idleMs }
        if (wait > 0 && stopSignal.await(wait, TimeUnit.MILLISECONDS)) return@Thread
      }
    }, "kicks-barrier-ledger").also { it.isDaemon = true; it.start() }
  }

  fun stop() = stopSignal.countDown()
  fun join(timeoutMs: Long): Boolean { val t = synchronized(this) { thread } ?: return true; if (t === Thread.currentThread()) return true; t.join(timeoutMs); return !t.isAlive }
}

/**
 * Owns the barrier lifecycle. State is ACTIVE only after the authoritative gate allowed the
 * start AND the tunnel was established; any denial locks the barrier, and an authority
 * outage pauses it (traffic stays blocked while paused: fail closed, never fail open).
 *
 * DNS decisions are recorded in the barrier ledger. Packet decisions are not: the ledger
 * records gate decisions, and a packet is allowed or blocked as the consequence of the
 * DNS decision that authorized its destination, so recording every packet would flood
 * the ledger with enforcement consequences instead of decisions. Blocked packets are
 * counted in [status] instead.
 *
 * The ledger is an audit trail and is never purged by a stop: [stop] persists it, and
 * the records upload when authorization returns.
 */
class BarrierController(
  private val gate: BarrierGate,
  val ledgerQueue: BarrierLedgerQueue,
  uploader: BarrierLedgerUploader,
  private val clock: Clock,
  backoff: Backoff = Backoff(),
  private val newId: () -> String = { UUID.randomUUID().toString() },
  private val runWorker: Boolean = true,
  private val connectionTable: BarrierConnectionTable = BarrierConnectionTable(clock),
  private val resolverCache: BarrierResolverCache = BarrierResolverCache(clock)
) {
  private val pump = BarrierLedgerPump(ledgerQueue, gate, uploader, backoff)
  // The worker is single-use per start: a fresh worker is created on every start() so a
  // restart after a stop re-activates background upload. (The collector's worker does not
  // restart; the barrier deliberately does not copy that.)
  private var worker: BarrierLedgerWorker? = null
  @Volatile var state = State.IDLE; private set
  @Volatile var reason: BarrierReason? = null; private set
  @Volatile var onStopped: (BarrierReason) -> Unit = {}
  private val allowedDns = AtomicLong(0)
  private val blockedDns = AtomicLong(0)
  private val blockedPackets = AtomicLong(0)

  fun status() = BarrierStatus(
    state, reason, allowedDns.get(), blockedDns.get(), blockedPackets.get(),
    ledgerQueue.size(), ledgerQueue.dropped, connectionTable.size(), resolverCache.size()
  )

  /** Called from a background thread. [establish] opens the tunnel and returns false on failure. */
  @Synchronized fun start(establish: () -> Boolean): BarrierDecision {
    state = State.STARTING; reason = null
    val d = gate.check(BarrierPhase.START)
    if (d !is BarrierDecision.Allow) { applyDenial(d); return d }
    ledgerQueue.restore()
    val ok = try { establish() } catch (e: Exception) { false }
    if (!ok) { stop(BarrierReason.TUNNEL_FAILED); return BarrierDecision.Deny(BarrierReason.TUNNEL_FAILED) }
    // Authorization may have been lost while the tunnel was coming up.
    val again = gate.check(BarrierPhase.RESUME)
    if (again !is BarrierDecision.Allow) { applyDenial(again); return again }
    state = State.ACTIVE
    if (runWorker) {
      worker = BarrierLedgerWorker({ pump.runOnce() }, { stop(it) }).also { it.start() }
    }
    return d
  }

  /** Re-checks after a network change or app/service resume. */
  @Synchronized fun resume(): BarrierDecision {
    if (state != State.ACTIVE && state != State.PAUSED) return BarrierDecision.Deny(reason ?: BarrierReason.SERVICE_STOPPED)
    val d = gate.check(BarrierPhase.RESUME)
    if (d is BarrierDecision.Allow) { state = State.ACTIVE; reason = null } else applyDenial(d)
    return d
  }

  /**
   * Manual refresh: renews the cached authorization on demand. The background refresh is
   * the ledger worker: its upload step re-checks the gate (always a fresh fetch) at least
   * every 15 seconds while the barrier is ACTIVE, so a revocation is noticed within ~15s
   * and the worker's halt stops the barrier. That is the G3 mechanism; there is no
   * separate refresher thread. Called directly by tests and available to the service/UI.
   */
  @Synchronized fun refresh(): BarrierDecision {
    if (state != State.ACTIVE) return BarrierDecision.Deny(reason ?: BarrierReason.SERVICE_STOPPED)
    val d = gate.refresh()
    when (d) {
      is BarrierDecision.Allow -> { reason = null }
      is BarrierDecision.Deny -> applyDenial(d)
      is BarrierDecision.Unavailable -> Unit // Cache ages out on its own; the next DNS check locks if the TTL expired.
    }
    return d
  }

  /**
   * Decides one DNS query. Allowed queries are recorded as allow decisions; blocked
   * queries are recorded as block decisions with the gate's reason. A query whose host
   * cannot be stated with certainty is allowed or blocked without a ledger record: the
   * minimized schema has no "unknown host" value. Never delays DNS: the record is
   * queued, and the upload happens on the worker.
   */
  fun onDnsQuery(q: DnsQuery): BarrierDnsVerdict {
    val now = clock.nowMs()
    if (state != State.ACTIVE && state != State.PAUSED) return BarrierDnsVerdict.Block(reason ?: BarrierReason.SERVICE_STOPPED)
    return when (val d = gate.check(BarrierPhase.DNS)) {
      is BarrierDecision.Allow -> {
        synchronized(this) { if (state == State.PAUSED) { state = State.ACTIVE; reason = null } }
        allowedDns.incrementAndGet()
        connectionTable.noteOutbound(dnsFlow(q))
        val host = Minimizer.normalizeHost(q.qname)
        if (host != null && state == State.ACTIVE) {
          ledgerQueue.offer(
            BarrierDecisionRecord(
              eventId = newId(),
              occurredAt = Instant.ofEpochMilli(now).toString(),
              destinationHost = host,
              decision = BarrierLedger.DECISION_ALLOW,
              reason = null,
              consentId = d.grant.consentId
            )
          )
        }
        BarrierDnsVerdict.Allow(d.grant, d.session)
      }
      is BarrierDecision.Deny -> {
        blockedDns.incrementAndGet()
        recordBlock(q.qname, d.reason, now)
        applyDenial(d)
        BarrierDnsVerdict.Block(d.reason)
      }
      is BarrierDecision.Unavailable -> {
        blockedDns.incrementAndGet()
        recordBlock(q.qname, BarrierReason.AUTHORITY_UNAVAILABLE, now)
        synchronized(this) { if (state == State.ACTIVE) { state = State.PAUSED; reason = BarrierReason.AUTHORITY_UNAVAILABLE } }
        BarrierDnsVerdict.Block(BarrierReason.AUTHORITY_UNAVAILABLE)
      }
    }
  }

  /**
   * Decides one non-DNS packet read from the tunnel (outbound, from an app). The
   * destination must be an IP an authorized DNS answer returned: a direct-IP attempt has
   * no cache entry and is blocked. An allowed packet's flow is recorded so the reply can
   * be recognized as the reply to an authorized outbound connection.
   */
  fun onPacket(packet: ByteArray, length: Int = packet.size): BarrierPacketVerdict {
    val now = clock.nowMs()
    val parsed = BarrierPacket.parse(packet, length)
      ?: return BarrierPacketVerdict.Block(BarrierPacketReason.MALFORMED).also { blockedPackets.incrementAndGet() }
    if (state != State.ACTIVE && state != State.PAUSED) {
      blockedPackets.incrementAndGet()
      return BarrierPacketVerdict.Block(BarrierPacketReason.DESTINATION_NOT_AUTHORIZED)
    }
    return when (val d = gate.check(BarrierPhase.PACKET)) {
      is BarrierDecision.Allow -> {
        synchronized(this) { if (state == State.PAUSED) { state = State.ACTIVE; reason = null } }
        if (!resolverCache.isAuthorizedIp(BarrierPacket.ipv4String(parsed.dstIp), now)) {
          blockedPackets.incrementAndGet()
          return BarrierPacketVerdict.Block(BarrierPacketReason.DESTINATION_NOT_AUTHORIZED)
        }
        connectionTable.noteOutbound(parsed)
        when (parsed.protocol) {
          BarrierPacket.PROTOCOL_UDP -> BarrierPacketVerdict.AllowUdp(parsed)
          BarrierPacket.PROTOCOL_TCP -> BarrierPacketVerdict.AllowTcp(parsed)
          else -> {
            blockedPackets.incrementAndGet()
            BarrierPacketVerdict.Block(BarrierPacketReason.UNSUPPORTED_PROTOCOL)
          }
        }
      }
      is BarrierDecision.Deny -> {
        blockedPackets.incrementAndGet()
        applyDenial(d)
        BarrierPacketVerdict.Block(BarrierPacketReason.DESTINATION_NOT_AUTHORIZED)
      }
      is BarrierDecision.Unavailable -> {
        blockedPackets.incrementAndGet()
        synchronized(this) { if (state == State.ACTIVE) { state = State.PAUSED; reason = BarrierReason.AUTHORITY_UNAVAILABLE } }
        BarrierPacketVerdict.Block(BarrierPacketReason.DESTINATION_NOT_AUTHORIZED)
      }
    }
  }

  /** Learns the IP addresses an authorized DNS answer returned, so the packet layer can recognize them. */
  fun noteDnsAnswer(qname: String?, response: ByteArray) {
    val host = Minimizer.normalizeHost(qname) ?: return
    val answer = BarrierDnsAnswer.parse(response) ?: return
    resolverCache.noteAnswer(host, answer.ips, answer.ttlSeconds, clock.nowMs())
  }

  /**
   * Reply boundary (asymmetric inbound): a reply may be written back into the tunnel only
   * while the barrier is ACTIVE and the outbound flow that caused it is still recorded.
   * The service must call this before writing any reply it fetched on a protected socket.
   */
  fun allowDnsReply(q: DnsQuery): Boolean =
    state == State.ACTIVE && connectionTable.hasFlow(dnsFlow(q))

  fun allowUdpReply(packet: BarrierPacket.IpPacket): Boolean =
    state == State.ACTIVE && connectionTable.hasFlow(packet)

  fun explicitStop() = stop(BarrierReason.USER_STOP)

  fun stop(why: BarrierReason) {
    synchronized(this) {
      if (state == State.STOPPED && reason != null) return
      gate.deactivate()
      worker?.stop()
      state = State.STOPPED; reason = why
      connectionTable.clear()
      resolverCache.clear()
      // The ledger is an audit trail: it is persisted, never purged.
      ledgerQueue.persist()
    }
    // Outside the lock so teardown can join the worker without deadlocking against it.
    onStopped(why)
  }

  /** Waits for the worker thread so shutdown never leaves a running thread behind. */
  fun awaitShutdown(timeoutMs: Long): Boolean = worker?.join(timeoutMs) ?: true

  private fun applyDenial(d: BarrierDecision) {
    when (d) {
      is BarrierDecision.Deny -> stop(d.reason)
      is BarrierDecision.Unavailable -> synchronized(this) { if (state == State.ACTIVE) { state = State.PAUSED; reason = BarrierReason.AUTHORITY_UNAVAILABLE } else if (state == State.STARTING) { stop(BarrierReason.AUTHORITY_UNAVAILABLE) } }
      is BarrierDecision.Allow -> Unit
    }
  }

  private fun recordBlock(qname: String?, reason: BarrierReason, nowMs: Long) {
    val host = Minimizer.normalizeHost(qname) ?: return
    ledgerQueue.offer(
      BarrierDecisionRecord(
        eventId = newId(),
        occurredAt = Instant.ofEpochMilli(nowMs).toString(),
        destinationHost = host,
        decision = BarrierLedger.DECISION_BLOCK,
        reason = reason.name,
        consentId = gate.lastKnownGrant()?.consentId
      )
    )
  }

  private fun dnsFlow(q: DnsQuery): BarrierPacket.IpPacket =
    BarrierPacket.IpPacket(
      protocol = BarrierPacket.PROTOCOL_UDP,
      srcIp = q.srcIp,
      dstIp = q.dstIp,
      srcPort = q.srcPort,
      dstPort = q.dstPort,
      payload = q.payload,
      rawLength = q.payload.size
    )
}
