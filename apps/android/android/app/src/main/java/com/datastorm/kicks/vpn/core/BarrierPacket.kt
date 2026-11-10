package com.datastorm.kicks.vpn.core

/**
 * Packet-layer enforcement for the Gated Fail-Closed Lock.
 *
 * Pure JVM Kotlin: no android.* imports, so it compiles in the collector-core CI job.
 *
 * What this file does, and what it deliberately does not do:
 * - Parses IPv4 packets (UDP / TCP / anything else) so the barrier can decide on them.
 * - Tracks authorized outbound flows ([BarrierConnectionTable]) so inbound traffic is allowed
 *   ONLY as a reply to an authorized outbound connection (asymmetric inbound).
 * - Caches the IP addresses that authorized DNS answers returned ([BarrierResolverCache]) so
 *   the packet layer can tell an authorized destination from a direct-IP bypass attempt.
 * - Parses DNS answers ([BarrierDnsAnswer]) to feed that cache.
 * - Builds the IPv4/UDP reply that carries a forwarded datagram back to the querying app.
 *
 * What it does not do: it never forwards a packet itself and never inspects a payload.
 * Forwarding lives in the service, which calls [BarrierController] for the decision and only
 * writes a reply after [BarrierController.allowReply] confirms the flow is still authorized.
 * Content inspection is out of scope by design: the barrier decides on destination and
 * authorization only, never on what a packet carries.
 *
 * IPv4 only. IPv6 traffic is not routed through the barrier tunnel in this proof and is a
 * named gap (see BARRIER_PROOF_NOTES.md): a production barrier must route ::/0 and enforce
 * IPv6 the same way before it can claim to cover the device.
 */
object BarrierPacket {
  const val PROTOCOL_ICMP = 1
  const val PROTOCOL_TCP = 6
  const val PROTOCOL_UDP = 17

  fun ipv4String(bytes: ByteArray): String =
    bytes.joinToString(".") { (it.toInt() and 0xff).toString() }

  fun u16(b: ByteArray, o: Int): Int = ((b[o].toInt() and 0xff) shl 8) or (b[o + 1].toInt() and 0xff)

  fun put16(b: ByteArray, o: Int, v: Int) {
    b[o] = (v ushr 8).toByte()
    b[o + 1] = v.toByte()
  }

  /**
   * One parsed IPv4 packet. [payload] is the transport payload (after the IP and transport
   * headers). [isFragment] is true for a non-first fragment, which carries no transport
   * header and therefore cannot be classified: the gate drops it (fail closed).
   */
  data class IpPacket(
    val protocol: Int,
    val srcIp: ByteArray,
    val dstIp: ByteArray,
    val srcPort: Int,
    val dstPort: Int,
    val payload: ByteArray,
    val rawLength: Int
  ) {
    /** Flow key for the outbound direction: "proto|srcIp:srcPort>dstIp:dstPort". */
    fun flowKey(): String =
      "$protocol|${ipv4String(srcIp)}:$srcPort>${ipv4String(dstIp)}:$dstPort"
  }

  fun parse(packet: ByteArray, length: Int = packet.size): IpPacket? {
    if (length < 20 || length > packet.size) return null
    if ((packet[0].toInt() ushr 4) != 4) return null
    val ihl = (packet[0].toInt() and 0x0f) * 4
    if (ihl < 20 || length < ihl) return null
    val totalLen = u16(packet, 2)
    if (totalLen < ihl || totalLen > length) return null
    // Non-first fragments carry no transport header: unclassifiable, so unparseable.
    if ((u16(packet, 6) and 0x1fff) != 0) return null
    val protocol = packet[9].toInt() and 0xff
    val srcIp = packet.copyOfRange(12, 16)
    val dstIp = packet.copyOfRange(16, 20)
    return when (protocol) {
      PROTOCOL_UDP -> {
        if (length < ihl + 8) return null
        val udpLen = u16(packet, ihl + 4)
        if (udpLen < 8 || ihl + udpLen > totalLen) return null
        IpPacket(
          protocol = protocol,
          srcIp = srcIp,
          dstIp = dstIp,
          srcPort = u16(packet, ihl),
          dstPort = u16(packet, ihl + 2),
          payload = packet.copyOfRange(ihl + 8, ihl + udpLen),
          rawLength = totalLen
        )
      }
      PROTOCOL_TCP -> {
        if (length < ihl + 20) return null
        val dataOffset = ((packet[ihl + 12].toInt() ushr 4) and 0xf) * 4
        if (dataOffset < 20 || ihl + dataOffset > totalLen) return null
        IpPacket(
          protocol = protocol,
          srcIp = srcIp,
          dstIp = dstIp,
          srcPort = u16(packet, ihl),
          dstPort = u16(packet, ihl + 2),
          payload = packet.copyOfRange(ihl + dataOffset, totalLen),
          rawLength = totalLen
        )
      }
      else -> IpPacket(
        protocol = protocol,
        srcIp = srcIp,
        dstIp = dstIp,
        srcPort = 0,
        dstPort = 0,
        payload = packet.copyOfRange(ihl, totalLen),
        rawLength = totalLen
      )
    }
  }

  /** Builds the IPv4/UDP reply that carries [payload] back to the packet's sender. */
  fun buildUdpResponse(request: IpPacket, payload: ByteArray): ByteArray {
    val total = 20 + 8 + payload.size
    val out = ByteArray(total)
    out[0] = 0x45
    put16(out, 2, total)
    out[8] = 64
    out[9] = PROTOCOL_UDP.toByte()
    request.dstIp.copyInto(out, 12)
    request.srcIp.copyInto(out, 16)
    put16(out, 10, DnsPacket.checksum(out, 0, 20))
    put16(out, 20, request.dstPort)
    put16(out, 22, request.srcPort)
    put16(out, 24, 8 + payload.size)
    // UDP checksum 0 is valid for IPv4.
    payload.copyInto(out, 28)
    return out
  }
}

/** Why a packet was blocked. Kept separate from [BarrierReason]: this is the packet layer's own vocabulary. */
enum class BarrierPacketReason {
  DESTINATION_NOT_AUTHORIZED,
  NOT_A_REPLY,
  UNSUPPORTED_PROTOCOL,
  MALFORMED
}

/**
 * Authorized outbound flows. An entry is recorded when the barrier allows an outbound packet;
 * a reply is allowed only while its reversed flow is recorded and unexpired. Entries are
 * dropped on stop (revocation clears the table at once) and expire on their own, so a flow
 * cannot outlive the authorization that allowed it by more than [flowTtlMs].
 */
class BarrierConnectionTable(
  private val clock: Clock,
  private val flowTtlMs: Long = 120_000,
  private val capacity: Int = 1024
) {
  private val flows = LinkedHashMap<String, Long>()

  @Synchronized fun noteOutbound(packet: BarrierPacket.IpPacket) {
    val now = clock.nowMs()
    flows.entries.removeIf { it.value <= now }
    if (flows.size >= capacity) {
      val eldest = flows.entries.firstOrNull()?.key
      if (eldest != null) flows.remove(eldest)
    }
    flows[packet.flowKey()] = now + flowTtlMs
  }

  /** True only when [packet]'s outbound flow is recorded and unexpired. */
  @Synchronized fun hasFlow(packet: BarrierPacket.IpPacket): Boolean {
    val now = clock.nowMs()
    val expiry = flows[packet.flowKey()] ?: return false
    if (expiry <= now) {
      flows.remove(packet.flowKey())
      return false
    }
    return true
  }

  @Synchronized fun clear() = flows.clear()

  @Synchronized fun size(): Int {
    val now = clock.nowMs()
    flows.entries.removeIf { it.value <= now }
    return flows.size
  }
}

/**
 * IP addresses that authorized DNS answers returned, with their TTLs. The packet layer
 * allows an outbound packet only when its destination IP is in this cache: a destination
 * is authorized because an authorized DNS answer named it, never because an app guessed it.
 * A direct-IP connection attempt therefore has no cache entry and is blocked.
 */
class BarrierResolverCache(
  private val clock: Clock,
  private val capacity: Int = 512,
  private val minTtlMs: Long = 60_000,
  private val maxTtlMs: Long = 3_600_000
) {
  private data class Entry(val ips: Set<String>, val expiresAtMs: Long)

  private val hosts = LinkedHashMap<String, Entry>()

  @Synchronized fun noteAnswer(host: String, ips: List<String>, ttlSeconds: Long, nowMs: Long) {
    if (ips.isEmpty()) return
    val ttlMs = (ttlSeconds * 1_000).coerceIn(minTtlMs, maxTtlMs)
    if (hosts.size >= capacity) {
      val eldest = hosts.entries.firstOrNull()?.key
      if (eldest != null) hosts.remove(eldest)
    }
    hosts[host] = Entry(ips.toSet(), nowMs + ttlMs)
  }

  @Synchronized fun isAuthorizedIp(ip: String, nowMs: Long): Boolean {
    var found = false
    val expired = ArrayList<String>()
    for ((host, entry) in hosts) {
      if (entry.expiresAtMs <= nowMs) {
        expired.add(host)
      } else if (entry.ips.contains(ip)) {
        found = true
      }
    }
    expired.forEach { hosts.remove(it) }
    return found
  }

  @Synchronized fun ipsFor(host: String, nowMs: Long): Set<String> {
    val entry = hosts[host] ?: return emptySet()
    if (entry.expiresAtMs <= nowMs) {
      hosts.remove(host)
      return emptySet()
    }
    return entry.ips
  }

  @Synchronized fun clear() = hosts.clear()

  @Synchronized fun size(): Int {
    val now = clock.nowMs()
    hosts.entries.removeIf { it.value.expiresAtMs <= now }
    return hosts.size
  }
}

/**
 * Minimal DNS response parsing, only to learn which IP addresses an authorized answer
 * returned. A and AAAA records are skipped over correctly; only A records populate the
 * resolver cache (the barrier tunnel is IPv4 in this proof). Returns null on any
 * malformation: an answer that cannot be read with certainty teaches the cache nothing.
 */
object BarrierDnsAnswer {
  data class Answer(val ips: List<String>, val ttlSeconds: Long)

  fun parse(response: ByteArray): Answer? {
    if (response.size < 12) return null
    val qdCount = BarrierPacket.u16(response, 4)
    val anCount = BarrierPacket.u16(response, 6)
    if (anCount == 0) return null
    var off = 12
    repeat(qdCount) {
      val (_, next) = readName(response, off) ?: return null
      off = next + 4
      if (off > response.size) return null
    }
    val ips = ArrayList<String>()
    var minTtl = Long.MAX_VALUE
    repeat(anCount) {
      val (_, nameEnd) = readName(response, off) ?: return null
      off = nameEnd
      if (off + 10 > response.size) return null
      val type = BarrierPacket.u16(response, off)
      // val klass = BarrierPacket.u16(response, off + 2)
      val ttl = ((response[off + 4].toLong() and 0xff) shl 24) or
        ((response[off + 5].toLong() and 0xff) shl 16) or
        ((response[off + 6].toLong() and 0xff) shl 8) or
        (response[off + 7].toLong() and 0xff)
      val rdLength = BarrierPacket.u16(response, off + 8)
      off += 10
      if (off + rdLength > response.size) return null
      when (type) {
        1 -> {
          if (rdLength == 4) {
            ips.add(BarrierPacket.ipv4String(response.copyOfRange(off, off + 4)))
            if (ttl < minTtl) minTtl = ttl
          }
        }
        28 -> {
          // AAAA: skipped over (read correctly so the next record parses), never cached.
        }
        else -> Unit
      }
      off += rdLength
    }
    if (ips.isEmpty()) return null
    return Answer(ips, if (minTtl == Long.MAX_VALUE) 0 else minTtl)
  }

  /**
   * Reads a DNS name at [off], following compression pointers. Returns the name and the
   * offset just past the name (past the pointer when one was followed). A pointer loop or
   * any out-of-range read returns null.
   */
  private fun readName(msg: ByteArray, off: Int): Pair<String, Int>? {
    var pos = off
    var next = -1
    val sb = StringBuilder()
    var jumps = 0
    while (true) {
      if (pos >= msg.size) return null
      val len = msg[pos].toInt() and 0xff
      when {
        len == 0 -> {
          if (next == -1) next = pos + 1
          break
        }
        len and 0xc0 == 0xc0 -> {
          if (pos + 1 >= msg.size) return null
          if (++jumps > 8) return null
          if (next == -1) next = pos + 2
          pos = ((len and 0x3f) shl 8) or (msg[pos + 1].toInt() and 0xff)
        }
        len and 0xc0 != 0 -> return null
        len > 63 || pos + 1 + len > msg.size -> return null
        else -> {
          if (sb.isNotEmpty()) sb.append('.')
          for (k in 1..len) {
            val c = msg[pos + k].toInt() and 0xff
            if (c <= 0x20 || c >= 0x7f) return null
            sb.append(c.toChar())
          }
          pos += 1 + len
          if (sb.length > 253) return null
        }
      }
    }
    val name = sb.toString()
    return if (name.isEmpty()) null else name to next
  }
}
