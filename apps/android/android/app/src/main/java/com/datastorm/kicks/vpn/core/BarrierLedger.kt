package com.datastorm.kicks.vpn.core

import java.net.URLDecoder
import java.net.URLEncoder

/**
 * The barrier ledger: a SEPARATE record of gate decisions, kept apart from the consent
 * ledger and from the collector's observation queue.
 *
 * - One record per DNS gate decision: event id, time, destination host, decision, reason,
 *   consent id. No content, no payload, no source app: the barrier decides on destination
 *   and authorization only.
 * - The consent ledger stays consent-only. The barrier ledger carries the consent id of the
 *   grant that authorized the decision so a decision can always be traced back to the
 *   consent that covered it, without ever writing into the consent ledger.
 * - [reason] is an extension of the five-field minimized form in the design (event id,
 *   time, destination host, decision, consent id): a block without a reason is unauditable,
 *   so the reason the gate gave is recorded with it. It is nullable and bounded (the
 *   server rejects anything longer than 64 characters).
 * - [consentId] is the live grant's id on an allow. On a block it is the last-known
 *   grant's id when one exists (for example a revoked consent), and null when no consent
 *   ever existed: a block must still be recorded even though there is no consent to name.
 *   The server accepts a null consent id only on a block, never on an allow.
 * - The ledger is an audit trail, so it is NEVER purged: unlike the collector queue, a
 *   stop for authorization loss persists the ledger instead of purging it. Records survive
 *   restarts in the encrypted store and upload when authorization returns. There is no
 *   retain-consent step: a decision recorded under a consent that is later revoked is
 *   still a true historical decision and stays in the ledger.
 */
data class BarrierDecisionRecord(
  val eventId: String,
  val occurredAt: String,
  val destinationHost: String,
  val decision: String,
  val reason: String?,
  val consentId: String?
) {
  fun toJson(): String = buildString {
    append('{')
    append("\"eventId\":").append(Json.str(eventId)).append(',')
    append("\"occurredAt\":").append(Json.str(occurredAt)).append(',')
    append("\"destinationHost\":").append(Json.str(destinationHost)).append(',')
    append("\"decision\":").append(Json.str(decision)).append(',')
    append("\"reason\":").append(if (reason == null) "null" else Json.str(reason)).append(',')
    append("\"consentId\":").append(if (consentId == null) "null" else Json.str(consentId))
    append('}')
  }
}

object BarrierLedger {
  const val SCHEMA_VERSION = "2026-11-10"
  const val DECISION_ALLOW = "allow"
  const val DECISION_BLOCK = "block"
}

data class BarrierLedgerBatch(val batchId: String, val decisions: List<BarrierDecisionRecord>) {
  fun toJson(): String =
    "{\"batchId\":${Json.str(batchId)},\"schemaVersion\":${Json.str(BarrierLedger.SCHEMA_VERSION)}," +
      "\"decisions\":[${decisions.joinToString(",") { it.toJson() }}]}"
}

interface BarrierLedgerUploader {
  fun upload(batch: BarrierLedgerBatch, session: Session): UploadResult
}

/**
 * Bounded barrier-ledger queue. Mirrors [BoundedQueue]'s backpressure and persistence
 * (oldest record dropped first when full, in-flight batch kept across retries and
 * restarts so the server's replay protection makes redelivery idempotent) but is typed
 * to [BarrierDecisionRecord] and has no consent-retention step: the ledger is an audit
 * trail and is never rewritten after the fact.
 */
class BarrierLedgerQueue(
  val capacity: Int = 2000,
  val maxBatch: Int = 250,
  private val store: QueueStore,
  private val newId: () -> String
) {
  private val pending = ArrayDeque<BarrierDecisionRecord>()
  private var inFlight: BarrierLedgerBatch? = null
  @Volatile var dropped: Long = 0; private set

  init { require(capacity in 1..100_000 && maxBatch in 1..250 && maxBatch <= capacity) }

  @Synchronized fun size() = pending.size + (inFlight?.decisions?.size ?: 0)

  @Synchronized fun offer(record: BarrierDecisionRecord) {
    while (size() >= capacity && pending.isNotEmpty()) { pending.removeFirst(); dropped++ }
    if (size() >= capacity) { dropped++; return }
    pending.addLast(record)
  }

  /** Returns the same batch until it is acknowledged or discarded. */
  @Synchronized fun peekBatch(): BarrierLedgerBatch? {
    inFlight?.let { return it }
    if (pending.isEmpty()) return null
    val items = ArrayList<BarrierDecisionRecord>()
    while (items.size < maxBatch && pending.isNotEmpty()) items.add(pending.removeFirst())
    return BarrierLedgerBatch(newId(), items).also { inFlight = it }
  }

  @Synchronized fun ack(batchId: String) { if (inFlight?.batchId == batchId) inFlight = null; persist() }

  @Synchronized fun purge() { pending.clear(); inFlight = null; store.clear() }

  @Synchronized fun persist() {
    if (pending.isEmpty() && inFlight == null) { store.clear(); return }
    val sb = StringBuilder()
    inFlight?.let { b -> sb.append("B\t").append(b.batchId).append('\n'); b.decisions.forEach { sb.append(line("F", it)) } }
    pending.forEach { sb.append(line("P", it)) }
    store.save(sb.toString())
  }

  /** Restores persisted state; malformed data is discarded rather than guessed at. Never trusted for authorization. */
  @Synchronized fun restore() {
    pending.clear(); inFlight = null
    val text = store.load() ?: return
    try {
      var batchId: String? = null
      val flight = ArrayList<BarrierDecisionRecord>()
      for (l in text.split('\n')) {
        if (l.isEmpty()) continue
        val f = l.split('\t')
        when (f[0]) {
          "B" -> batchId = f[1]
          "F" -> flight.add(decode(f))
          "P" -> pending.addLast(decode(f))
          else -> throw IllegalArgumentException()
        }
      }
      if (batchId != null && flight.isNotEmpty()) inFlight = BarrierLedgerBatch(batchId, flight)
      while (size() > capacity && pending.isNotEmpty()) { pending.removeFirst(); dropped++ }
    } catch (e: Exception) {
      pending.clear(); inFlight = null; store.clear()
    }
  }

  private fun enc(v: String?) = if (v == null) "-" else "~" + URLEncoder.encode(v, "UTF-8")
  private fun dec(v: String) = if (v == "-") null else URLDecoder.decode(v.substring(1), "UTF-8")
  private fun line(tag: String, r: BarrierDecisionRecord) = listOf(
    tag, r.eventId, r.occurredAt, r.destinationHost, r.decision, r.reason, r.consentId
  ).mapIndexed { i, v -> if (i == 0) v else enc(v) }.joinToString("\t") + "\n"
  private fun decode(f: List<String>): BarrierDecisionRecord {
    require(f.size == 7)
    val v = f.drop(1).map { dec(it) }
    return BarrierDecisionRecord(v[0]!!, v[1]!!, v[2]!!, v[3]!!, v[4], v[5])
  }
}

sealed class BarrierPumpResult {
  object Idle : BarrierPumpResult()
  data class Uploaded(val decisions: Int) : BarrierPumpResult()
  data class RetryLater(val delayMs: Long) : BarrierPumpResult()
  data class Halted(val reason: BarrierReason) : BarrierPumpResult()
}

/**
 * One authorization-checked ledger upload step. Mirrors [UploadPump]: the gate is checked
 * before every upload, so the ledger only leaves the device while authorization is live;
 * a 409 is treated as delivered, a 400 discards the batch, a 401/403 halts, and anything
 * else retries with backoff. The queued records themselves are never rewritten: a record
 * made under a consent that is later revoked is still uploaded as the historical decision
 * it is, once authorization returns.
 */
class BarrierLedgerPump(
  private val queue: BarrierLedgerQueue,
  private val gate: BarrierGate,
  private val uploader: BarrierLedgerUploader,
  private val backoff: Backoff
) {
  private var attempts = 0
  @Volatile var discardedBatches = 0; private set

  @Synchronized fun runOnce(): BarrierPumpResult {
    val decision = gate.check(BarrierPhase.UPLOAD)
    val allow = when (decision) {
      is BarrierDecision.Deny -> return BarrierPumpResult.Halted(decision.reason)
      is BarrierDecision.Unavailable -> {
        val delay = backoff.delayMs(attempts)
        attempts = minOf(attempts + 1, backoff.maxAttempts)
        return BarrierPumpResult.RetryLater(delay)
      }
      is BarrierDecision.Allow -> decision
    }
    val batch = queue.peekBatch() ?: run { attempts = 0; return BarrierPumpResult.Idle }
    return when (val r = uploader.upload(batch, allow.session)) {
      UploadResult.Accepted, UploadResult.Duplicate -> { attempts = 0; queue.ack(batch.batchId); BarrierPumpResult.Uploaded(batch.decisions.size) }
      UploadResult.Rejected -> { attempts = 0; discardedBatches++; queue.ack(batch.batchId); BarrierPumpResult.Uploaded(0) }
      is UploadResult.Unauthorized -> BarrierPumpResult.Halted(if (r.httpStatus == 403) BarrierReason.CONSENT_NOT_GRANTED else BarrierReason.SESSION_REVOKED)
      is UploadResult.Transient -> {
        attempts++
        if (attempts >= backoff.maxAttempts) { attempts = 0; discardedBatches++; queue.ack(batch.batchId); BarrierPumpResult.RetryLater(backoff.delayMs(backoff.maxAttempts)) }
        else BarrierPumpResult.RetryLater(backoff.delayMs(attempts))
      }
    }
  }
}
