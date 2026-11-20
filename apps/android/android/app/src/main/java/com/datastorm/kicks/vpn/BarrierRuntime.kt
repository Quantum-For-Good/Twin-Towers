package com.datastorm.kicks.vpn

import android.content.Context
import com.datastorm.kicks.BuildConfig
import com.datastorm.kicks.vpn.core.BarrierController
import com.datastorm.kicks.vpn.core.BarrierGate
import com.datastorm.kicks.vpn.core.BarrierLedgerQueue
import com.datastorm.kicks.vpn.core.Clock
import java.io.File
import java.util.UUID

/**
 * Process-wide wiring for the Gated Fail-Closed Lock. Mirrors [CollectorComponents]:
 * the barrier is a separate subsystem with its own gate, controller, ledger queue, and
 * uploader, but it shares the collector's session store, device binding, OS authorization,
 * and authority endpoint — the same device bearer and the same consent, read through the
 * same server, never a copy.
 *
 * Separation that matters:
 * - The ledger lives in its own encrypted file ("barrier-ledger.bin") under its own
 *   Keystore key ("kicks_barrier_v1"), apart from the collector's queue and session.
 * - The barrier's authority client is a separate, stateless instance of the same
 *   [HttpAuthorityClient]: it asks the same GET /v1/collector/eligibility endpoint.
 * - The barrier is enabled by its own build flag ([BuildConfig.BARRIER_ENABLED],
 *   property `kicks.barrierEnabled`), independent of the collector flag.
 */
class BarrierComponents(context: Context, collector: CollectorComponents) {
  private val dir: File = context.noBackupFilesDir
  private val cipher = KeystoreCipher("kicks_barrier_v1")
  val configured = BuildConfig.BARRIER_ENABLED && BuildConfig.COLLECTOR_API_BASE_URL.startsWith("https://")
  val gate = BarrierGate(
    barrierEnabled = BuildConfig.BARRIER_ENABLED,
    sessions = collector.sessions,
    os = collector.os,
    authority = if (configured) HttpAuthorityClient(BuildConfig.COLLECTOR_API_BASE_URL) else null,
    binding = collector.binding,
    clock = Clock { System.currentTimeMillis() }
  )
  val controller = BarrierController(
    gate,
    BarrierLedgerQueue(store = EncryptedQueueStore(EncryptedFile(File(dir, "barrier-ledger.bin"), cipher)), newId = { UUID.randomUUID().toString() }),
    HttpBarrierLedgerUploader(BuildConfig.COLLECTOR_API_BASE_URL),
    Clock { System.currentTimeMillis() }
  )
}

object BarrierRuntime {
  @Volatile var service: KicksVpnService? = null
  @Volatile private var instance: BarrierComponents? = null

  fun get(context: Context): BarrierComponents =
    instance ?: synchronized(this) {
      instance ?: BarrierComponents(context.applicationContext, CollectorRuntime.get(context)).also { instance = it }
    }
}
