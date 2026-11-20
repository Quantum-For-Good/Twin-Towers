package com.datastorm.kicks.vpn

import com.datastorm.kicks.vpn.core.BarrierLedgerBatch
import com.datastorm.kicks.vpn.core.BarrierLedgerUploader
import com.datastorm.kicks.vpn.core.Session
import com.datastorm.kicks.vpn.core.UploadResult
import com.datastorm.kicks.vpn.core.sessionHeaders
import java.net.HttpURLConnection
import java.net.URL

/**
 * Barrier-ledger upload (device-bearer, same contract as the metadata uploader).
 *
 * NOTE: POST /v1/barrier-decisions is the contract this client expects from the backend
 * (the companion to this proof; see BARRIER_PROOF_NOTES.md). Until that endpoint exists
 * the call fails and the ledger stays queued on the device — the barrier keeps enforcing
 * and the records upload when the endpoint lands. A 409 is treated as delivered, a 400
 * discards the batch, a 401/403 halts the barrier, anything else retries with backoff.
 */
class HttpBarrierLedgerUploader(private val baseUrl: String) : BarrierLedgerUploader {
  override fun upload(batch: BarrierLedgerBatch, session: Session): UploadResult = try {
    val c = connect(baseUrl, session)
    c.doOutput = true
    c.setRequestProperty("Content-Type", "application/json")
    try {
      c.outputStream.use { it.write(batch.toJson().toByteArray(Charsets.UTF_8)) }
      when (val code = c.responseCode) {
        202 -> UploadResult.Accepted
        409 -> UploadResult.Duplicate
        401, 403 -> UploadResult.Unauthorized(code)
        400 -> UploadResult.Rejected
        else -> UploadResult.Transient("http_$code")
      }
    } finally { c.disconnect() }
  } catch (e: Exception) { UploadResult.Transient(e.javaClass.simpleName) }

  private fun connect(base: String, session: Session): HttpURLConnection {
    require(base.startsWith("https://")) { "https required" }
    return (URL(base.trimEnd('/') + "/v1/barrier-decisions").openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 8_000
      readTimeout = 10_000
      instanceFollowRedirects = false
      sessionHeaders(session).forEach { (name, value) -> setRequestProperty(name, value) }
      setRequestProperty("Accept", "application/json")
    }
  }
}
