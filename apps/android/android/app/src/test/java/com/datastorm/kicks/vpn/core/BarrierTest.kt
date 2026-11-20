package com.datastorm.kicks.vpn.core

import org.junit.Assert.*
import org.junit.Test

class FakeBarrierUploader(var next: () -> UploadResult = { UploadResult.Accepted }) : BarrierLedgerUploader {
  val batches = ArrayList<BarrierLedgerBatch>()
  override fun upload(batch: BarrierLedgerBatch, session: Session): UploadResult { batches.add(batch); return next() }
}

class BarrierHarness(
  enabled: Boolean = true,
  configured: Boolean = true,
  val clock: FakeClock = FakeClock(),
  sessionExpiresAtMs: Long = 1_000_000L + 3_600_000,
  val sessions: FakeSessions = FakeSessions(Session("acct-a", "dev-1", "secret-token", sessionExpiresAtMs)),
  val os: FakeOs = FakeOs(),
  val binding: FakeBinding = FakeBinding(),
  val authority: FakeAuthority = FakeAuthority(okResponse()),
  val uploader: FakeBarrierUploader = FakeBarrierUploader(),
  capacity: Int = 10,
  maxBatch: Int = 4,
  worker: Boolean = false
) {
  val store = MemoryQueueStore()
  private var ids = 0
  val newId: () -> String = { "00000000-0000-4000-8000-%012d".format(++ids) }
  val gate = BarrierGate(enabled, sessions, os, if (configured) authority else null, binding, clock)
  val ledger = BarrierLedgerQueue(capacity, maxBatch, store, newId)
  val controller = BarrierController(gate, ledger, uploader, clock, Backoff(jitter = { it }), newId, worker)
  val pump = BarrierLedgerPump(ledger, gate, uploader, Backoff(jitter = { it }))
  val stops = ArrayList<BarrierReason>()
  init { controller.onStopped = { stops.add(it) } }

  fun startOk(): BarrierDecision { gate.activate(); return controller.start { true } }

  fun dnsQuery(name: String?, srcPort: Int = 12345): DnsQuery =
    DnsQuery(name, byteArrayOf(10, 111.toByte(), 222.toByte(), 1), byteArrayOf(10, 111.toByte(), 222.toByte(), 2), srcPort, 53, ByteArray(12))

  fun dnsResponse(host: String, answers: List<Triple<Int, Long, ByteArray>>): ByteArray {
    val labels = host.split('.')
    val qnameLen = labels.sumOf { it.length + 1 } + 1
    val answerLen = answers.sumOf { 2 + 2 + 2 + 4 + 2 + it.third.size }
    val b = ByteArray(12 + qnameLen + 4 + answerLen)
    b[0] = 0x12; b[1] = 0x34
    b[2] = 0x81.toByte(); b[3] = 0x80.toByte()
    b[4] = 0; b[5] = 1
    b[6] = 0; b[7] = answers.size.toByte()
    var off = 12
    for (label in labels) {
      b[off++] = label.length.toByte()
      label.toByteArray(Charsets.UTF_8).copyInto(b, off)
      off += label.length
    }
    b[off++] = 0
    b[off++] = 0; b[off++] = 1
    b[off++] = 0; b[off++] = 1
    for ((type, ttl, rdata) in answers) {
      b[off++] = 0xC0.toByte(); b[off++] = 0x0C
      b[off++] = 0; b[off++] = type.toByte()
      b[off++] = 0; b[off++] = 1
      b[off++] = (ttl ushr 24).toByte(); b[off++] = (ttl ushr 16).toByte()
      b[off++] = (ttl ushr 8).toByte(); b[off++] = ttl.toByte()
      b[off++] = 0; b[off++] = rdata.size.toByte()
      rdata.copyInto(b, off)
      off += rdata.size
    }
    return b
  }

  fun ipPacket(protocol: Int, dstIp: ByteArray, dstPort: Int, srcPort: Int = 12345, payload: ByteArray = byteArrayOf(1, 2, 3)): ByteArray {
    val srcIp = byteArrayOf(10, 111.toByte(), 222.toByte(), 1)
    val transportLen = when (protocol) { 17 -> 8; 6 -> 20; else -> 0 }
    val total = 20 + transportLen + payload.size
    val b = ByteArray(total)
    b[0] = 0x45
    b[2] = (total ushr 8).toByte(); b[3] = total.toByte()
    b[8] = 64
    b[9] = protocol.toByte()
    srcIp.copyInto(b, 12); dstIp.copyInto(b, 16)
    if (protocol == 17) {
      b[20] = (srcPort ushr 8).toByte(); b[21] = srcPort.toByte()
      b[22] = (dstPort ushr 8).toByte(); b[23] = dstPort.toByte()
      val udpLen = 8 + payload.size
      b[24] = (udpLen ushr 8).toByte(); b[25] = udpLen.toByte()
      payload.copyInto(b, 28)
    } else if (protocol == 6) {
      b[20] = (srcPort ushr 8).toByte(); b[21] = srcPort.toByte()
      b[22] = (dstPort ushr 8).toByte(); b[23] = dstPort.toByte()
      b[32] = 0x50
      payload.copyInto(b, 40)
    } else {
      payload.copyInto(b, 20)
    }
    var sum = 0
    var i = 0
    while (i < 20) { sum += ((b[i].toInt() and 0xff) shl 8) or (b[i + 1].toInt() and 0xff); i += 2 }
    while (sum ushr 16 != 0) sum = (sum and 0xffff) + (sum ushr 16)
    val chk = sum.inv() and 0xffff
    b[10] = (chk ushr 8).toByte(); b[11] = chk.toByte()
    return b
  }
}

class BarrierGateTest {
  private fun denied(h: BarrierHarness, reason: BarrierReason) {
    val d = h.startOk()
    assertEquals(BarrierDecision.Deny(reason), d)
    assertEquals(State.STOPPED, h.controller.state)
    assertEquals(reason, h.controller.reason)
  }

  @Test fun disabledByDefaultBuildFlag() = denied(BarrierHarness(enabled = false), BarrierReason.BARRIER_DISABLED)
  @Test fun unconfiguredAuthorityDenies() = denied(BarrierHarness(configured = false), BarrierReason.BARRIER_NOT_CONFIGURED)
  @Test fun noSessionDenies() { val h = BarrierHarness(); h.sessions.session = null; denied(h, BarrierReason.NO_SESSION) }
  @Test fun expiredSessionDenies() { val h = BarrierHarness(); h.clock.now += 3_600_001; denied(h, BarrierReason.SESSION_EXPIRED) }
  @Test fun osVpnNotAuthorizedDenies() { val h = BarrierHarness(); h.os.vpn = false; denied(h, BarrierReason.OS_VPN_NOT_AUTHORIZED) }
  @Test fun notificationsBlockedDenies() { val h = BarrierHarness(); h.os.notifications = false; denied(h, BarrierReason.NOTIFICATIONS_BLOCKED) }
  @Test fun consentNotGrantedDenies() { val h = BarrierHarness(); h.authority.result = okResponse(consent = "revoked"); denied(h, BarrierReason.CONSENT_NOT_GRANTED) }
  @Test fun serverSideSessionRevokedDenies() { val h = BarrierHarness(); h.authority.result = okResponse(active = false); denied(h, BarrierReason.SESSION_REVOKED) }
  @Test fun authorityRejectionDenies() { val h = BarrierHarness(); h.authority.result = AuthorityResult.Rejected(Reason.CONSENT_NOT_GRANTED); denied(h, BarrierReason.CONSENT_NOT_GRANTED) }
  @Test fun unprovenDeviceOwnershipDenies() { val h = BarrierHarness(); h.authority.result = okResponse(owner = null); denied(h, BarrierReason.DEVICE_NOT_OWNED) }

  @Test fun authorityOutageFailsClosedAtStart() {
    val h = BarrierHarness(); h.authority.result = AuthorityResult.Unavailable("timeout")
    assertTrue(h.startOk() is BarrierDecision.Unavailable)
    assertEquals(State.STOPPED, h.controller.state)
  }

  @Test fun dataSharingOffDoesNotGateEnforcement() {
    // The barrier enforces traffic; it does not share data, so it does not gate on data sharing.
    val h = BarrierHarness(); h.authority.result = okResponse(sharing = false)
    assertTrue(h.startOk() is BarrierDecision.Allow)
    assertEquals(State.ACTIVE, h.controller.state)
    h.controller.explicitStop()
  }

  @Test fun recordedConsentAloneNeverStartsEnforcement() {
    val h = BarrierHarness()
    assertEquals(State.IDLE, h.controller.state)
    assertEquals(BarrierDecision.Deny(BarrierReason.NOT_EXPLICITLY_ACTIVATED), h.gate.check(BarrierPhase.START))
    assertTrue(h.controller.onDnsQuery(h.dnsQuery("example.com")) is BarrierDnsVerdict.Block)
    assertEquals(0, h.ledger.size())
  }

  @Test fun activeOnlyAfterEveryGateAndTunnel() {
    val h = BarrierHarness()
    assertTrue(h.startOk() is BarrierDecision.Allow)
    assertEquals(State.ACTIVE, h.controller.state)
    h.controller.explicitStop()
  }

  @Test fun tunnelFailureIsNotReportedActive() {
    val h = BarrierHarness(); h.gate.activate()
    h.controller.start { false }
    assertEquals(State.STOPPED, h.controller.state)
    assertEquals(BarrierReason.TUNNEL_FAILED, h.controller.reason)
  }

  @Test fun authorizationReusedWithinOneHour() {
    val h = BarrierHarness(sessionExpiresAtMs = 1_000_000L + 10_000_000); h.startOk()
    val before = h.authority.calls.get()
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    h.controller.onDnsQuery(h.dnsQuery("b.example"))
    assertEquals(before, h.authority.calls.get())
    h.controller.explicitStop()
  }

  @Test fun authorizationRefreshedAfterOneHour() {
    val h = BarrierHarness(sessionExpiresAtMs = 1_000_000L + 10_000_000); h.startOk()
    val before = h.authority.calls.get()
    h.clock.now += 3_600_001
    h.controller.onDnsQuery(h.dnsQuery("c.example"))
    assertEquals(before + 1, h.authority.calls.get())
    h.controller.explicitStop()
  }

  @Test fun refreshRenewsCache() {
    val h = BarrierHarness(sessionExpiresAtMs = 1_000_000L + 10_000_000); h.startOk()
    val before = h.authority.calls.get()
    assertTrue(h.controller.refresh() is BarrierDecision.Allow)
    assertEquals(before + 1, h.authority.calls.get())
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    assertEquals(before + 1, h.authority.calls.get())
    h.controller.explicitStop()
  }
}

class BarrierDnsTest {
  @Test fun allowRecordsAllowDecision() {
    val h = BarrierHarness(); h.startOk()
    val verdict = h.controller.onDnsQuery(h.dnsQuery("Example.COM."))
    assertTrue(verdict is BarrierDnsVerdict.Allow)
    val batch = h.ledger.peekBatch()!!
    val record = batch.decisions.single()
    assertEquals("example.com", record.destinationHost)
    assertEquals(BarrierLedger.DECISION_ALLOW, record.decision)
    assertNull(record.reason)
    assertEquals(CONSENT, record.consentId)
    assertEquals(1, h.controller.status().allowedDns)
    h.controller.explicitStop()
  }

  @Test fun uncertainDestinationIsAllowedButNotRecorded() {
    val h = BarrierHarness(); h.startOk()
    assertTrue(h.controller.onDnsQuery(h.dnsQuery(null)) is BarrierDnsVerdict.Allow)
    assertTrue(h.controller.onDnsQuery(h.dnsQuery("10.1.2.3")) is BarrierDnsVerdict.Allow)
    assertTrue(h.controller.onDnsQuery(h.dnsQuery("bad host")) is BarrierDnsVerdict.Allow)
    assertEquals(0, h.ledger.size())
    h.controller.explicitStop()
  }

  @Test fun consentRevokedMidFlightStopsAndRecordsBlockWithLastKnownConsent() {
    val h = BarrierHarness(sessionExpiresAtMs = 1_000_000L + 10_000_000); h.startOk()
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    h.clock.now += 3_600_001 // authorization TTL stale -> authoritative re-check
    h.authority.result = okResponse(consent = "revoked")
    val verdict = h.controller.onDnsQuery(h.dnsQuery("b.example"))
    assertEquals(BarrierDnsVerdict.Block(BarrierReason.CONSENT_NOT_GRANTED), verdict)
    assertEquals(State.STOPPED, h.controller.state)
    assertEquals(BarrierReason.CONSENT_NOT_GRANTED, h.controller.reason)
    assertEquals(2, h.ledger.size())
    val batch = h.ledger.peekBatch()!!
    val block = batch.decisions.last()
    assertEquals(BarrierLedger.DECISION_BLOCK, block.decision)
    assertEquals("b.example", block.destinationHost)
    assertEquals("CONSENT_NOT_GRANTED", block.reason)
    assertEquals(CONSENT, block.consentId) // last-known grant names the revoked consent
    assertFalse(h.gate.isActivated())
  }

  @Test fun revocationPreservesLedgerInsteadOfPurging() {
    val h = BarrierHarness(sessionExpiresAtMs = 1_000_000L + 10_000_000); h.startOk()
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    h.authority.result = okResponse(consent = "revoked")
    h.clock.now += 3_600_001
    h.controller.onDnsQuery(h.dnsQuery("b.example"))
    assertEquals(2, h.ledger.size())
    assertNotNull(h.store.load())
    assertTrue(h.uploader.batches.isEmpty())
  }

  @Test fun sessionExpiryStopsBarrierAndRecordsBlock() {
    val h = BarrierHarness(); h.startOk()
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    h.clock.now += 3_600_001
    val verdict = h.controller.onDnsQuery(h.dnsQuery("b.example"))
    assertEquals(BarrierDnsVerdict.Block(BarrierReason.SESSION_EXPIRED), verdict)
    assertEquals(State.STOPPED, h.controller.state)
    assertEquals(2, h.ledger.size())
    assertNotNull(h.store.load())
  }

  @Test fun authorityOutagePausesAndBlocksThenResumes() {
    val h = BarrierHarness(sessionExpiresAtMs = 1_000_000L + 10_000_000); h.startOk()
    h.clock.now += 3_600_001
    h.authority.result = AuthorityResult.Unavailable("offline")
    val blocked = h.controller.onDnsQuery(h.dnsQuery("a.example"))
    assertEquals(BarrierDnsVerdict.Block(BarrierReason.AUTHORITY_UNAVAILABLE), blocked)
    assertEquals(State.PAUSED, h.controller.state)
    assertEquals(1, h.controller.status().blockedDns)
    val batch = h.ledger.peekBatch()!!
    assertEquals("AUTHORITY_UNAVAILABLE", batch.decisions.single().reason)
    h.authority.result = okResponse()
    assertTrue(h.controller.onDnsQuery(h.dnsQuery("b.example")) is BarrierDnsVerdict.Allow)
    assertEquals(State.ACTIVE, h.controller.state)
    h.controller.explicitStop()
  }

  @Test fun localSessionLossStopsImmediatelyDespiteFreshCache() {
    val h = BarrierHarness(); h.startOk()
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    h.sessions.session = null // logout
    val verdict = h.controller.onDnsQuery(h.dnsQuery("b.example"))
    assertEquals(BarrierDnsVerdict.Block(BarrierReason.NO_SESSION), verdict)
    assertEquals(BarrierReason.NO_SESSION, h.controller.reason)
  }

  @Test fun userStopKeepsLedger() {
    val h = BarrierHarness(); h.startOk()
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    h.controller.explicitStop()
    assertEquals(1, h.ledger.size())
    assertNotNull(h.store.load())
  }
}

class BarrierPacketTest {
  private val exampleIp = byteArrayOf(93, 184.toByte(), 216.toByte(), 34)

  @Test fun parseUdp() {
    val h = BarrierHarness()
    val raw = h.ipPacket(17, exampleIp, 443)
    val p = BarrierPacket.parse(raw)!!
    assertEquals(17, p.protocol)
    assertEquals("10.111.222.1", BarrierPacket.ipv4String(p.srcIp))
    assertEquals("93.184.216.34", BarrierPacket.ipv4String(p.dstIp))
    assertEquals(12345, p.srcPort)
    assertEquals(443, p.dstPort)
    assertEquals(3, p.payload.size)
  }

  @Test fun parseTcp() {
    val h = BarrierHarness()
    val p = BarrierPacket.parse(h.ipPacket(6, exampleIp, 443))!!
    assertEquals(6, p.protocol)
    assertEquals(443, p.dstPort)
    assertEquals(3, p.payload.size)
  }

  @Test fun parseNonIpv4ReturnsNull() {
    val raw = ByteArray(20)
    raw[0] = 0x60 // version 6
    assertNull(BarrierPacket.parse(raw))
  }

  @Test fun parseTruncatedReturnsNull() {
    assertNull(BarrierPacket.parse(ByteArray(10)))
  }

  @Test fun parseFragmentReturnsNull() {
    val h = BarrierHarness()
    val raw = h.ipPacket(17, exampleIp, 443)
    raw[6] = 0x20 // more-fragments flag, offset 0
    raw[7] = 0x01 // fragment offset 1 (non-first fragment)
    assertNull(BarrierPacket.parse(raw))
  }

  @Test fun buildUdpResponseSwapsAddressesAndPorts() {
    val h = BarrierHarness()
    val request = BarrierPacket.parse(h.ipPacket(17, exampleIp, 443))!!
    val reply = BarrierPacket.buildUdpResponse(request, byteArrayOf(9, 9, 9))
    val parsed = BarrierPacket.parse(reply)!!
    assertEquals("93.184.216.34", BarrierPacket.ipv4String(parsed.srcIp))
    assertEquals("10.111.222.1", BarrierPacket.ipv4String(parsed.dstIp))
    assertEquals(443, parsed.srcPort)
    assertEquals(12345, parsed.dstPort)
    assertEquals(3, parsed.payload.size)
  }

  @Test fun connectionTableMatchesOnlyRecordedFlows() {
    val clock = FakeClock()
    val table = BarrierConnectionTable(clock)
    val h = BarrierHarness()
    val outbound = BarrierPacket.parse(h.ipPacket(17, exampleIp, 443))!!
    assertFalse(table.hasFlow(outbound))
    table.noteOutbound(outbound)
    assertTrue(table.hasFlow(outbound))
    val other = BarrierPacket.parse(h.ipPacket(17, exampleIp, 444))!!
    assertFalse(table.hasFlow(other))
    clock.now += 120_001
    assertFalse(table.hasFlow(outbound))
    table.noteOutbound(outbound)
    table.clear()
    assertFalse(table.hasFlow(outbound))
  }

  @Test fun resolverCacheAuthorizesOnlyAnsweredIps() {
    val clock = FakeClock()
    val cache = BarrierResolverCache(clock)
    assertFalse(cache.isAuthorizedIp("93.184.216.34", clock.nowMs()))
    cache.noteAnswer("example.com", listOf("93.184.216.34"), 300, clock.nowMs())
    assertTrue(cache.isAuthorizedIp("93.184.216.34", clock.nowMs()))
    assertFalse(cache.isAuthorizedIp("1.2.3.4", clock.nowMs()))
    assertEquals(setOf("93.184.216.34"), cache.ipsFor("example.com", clock.nowMs()))
    clock.now += 300_001
    assertFalse(cache.isAuthorizedIp("93.184.216.34", clock.nowMs()))
    assertTrue(cache.ipsFor("example.com", clock.nowMs()).isEmpty())
  }

  @Test fun dnsAnswerParsesARecordWithCompressedName() {
    val h = BarrierHarness()
    val response = h.dnsResponse("example.com", listOf(Triple(1, 300L, exampleIp)))
    val answer = BarrierDnsAnswer.parse(response)!!
    assertEquals(listOf("93.184.216.34"), answer.ips)
    assertEquals(300L, answer.ttlSeconds)
  }

  @Test fun dnsAnswerSkipsAaaaAndTakesMinimumATtl() {
    val h = BarrierHarness()
    val v6 = ByteArray(16)
    val response = h.dnsResponse(
      "example.com",
      listOf(
        Triple(1, 300L, exampleIp),
        Triple(28, 60L, v6),
        Triple(1, 60L, byteArrayOf(1, 2, 3, 4))
      )
    )
    val answer = BarrierDnsAnswer.parse(response)!!
    assertEquals(listOf("93.184.216.34", "1.2.3.4"), answer.ips)
    assertEquals(60L, answer.ttlSeconds)
  }

  @Test fun dnsAnswerReturnsNullOnMalformed() {
    assertNull(BarrierDnsAnswer.parse(ByteArray(5)))
    assertNull(BarrierDnsAnswer.parse(ByteArray(12)))
  }

  @Test fun onPacketBlocksDirectIpAttempt() {
    val h = BarrierHarness(); h.startOk()
    val verdict = h.controller.onPacket(h.ipPacket(17, exampleIp, 443))
    assertEquals(BarrierPacketVerdict.Block(BarrierPacketReason.DESTINATION_NOT_AUTHORIZED), verdict)
    assertEquals(1, h.controller.status().blockedPackets)
    h.controller.explicitStop()
  }

  @Test fun onPacketAllowsResolvedIpAndReplyIsRecognized() {
    val h = BarrierHarness(); h.startOk()
    assertTrue(h.controller.onDnsQuery(h.dnsQuery("example.com")) is BarrierDnsVerdict.Allow)
    h.controller.noteDnsAnswer("example.com", h.dnsResponse("example.com", listOf(Triple(1, 300L, exampleIp))))
    val raw = h.ipPacket(17, exampleIp, 443)
    val verdict = h.controller.onPacket(raw)
    assertTrue(verdict is BarrierPacketVerdict.AllowUdp)
    val packet = BarrierPacket.parse(raw)!!
    assertTrue(h.controller.allowUdpReply(packet))
    h.controller.explicitStop()
  }

  @Test fun onPacketAllowsTcpToResolvedIp() {
    val h = BarrierHarness(); h.startOk()
    assertTrue(h.controller.onDnsQuery(h.dnsQuery("example.com")) is BarrierDnsVerdict.Allow)
    h.controller.noteDnsAnswer("example.com", h.dnsResponse("example.com", listOf(Triple(1, 300L, exampleIp))))
    val verdict = h.controller.onPacket(h.ipPacket(6, exampleIp, 443))
    assertTrue(verdict is BarrierPacketVerdict.AllowTcp)
    h.controller.explicitStop()
  }

  @Test fun onPacketBlocksTcpToUnauthorizedIp() {
    val h = BarrierHarness(); h.startOk()
    val verdict = h.controller.onPacket(h.ipPacket(6, exampleIp, 443))
    assertEquals(BarrierPacketVerdict.Block(BarrierPacketReason.DESTINATION_NOT_AUTHORIZED), verdict)
    h.controller.explicitStop()
  }

  @Test fun onPacketBlocksUnsupportedProtocol() {
    // The destination must be authorized first: an unauthorized destination is blocked
    // as DESTINATION_NOT_AUTHORIZED before the protocol is ever considered.
    val h = BarrierHarness(); h.startOk()
    assertTrue(h.controller.onDnsQuery(h.dnsQuery("example.com")) is BarrierDnsVerdict.Allow)
    h.controller.noteDnsAnswer("example.com", h.dnsResponse("example.com", listOf(Triple(1, 300L, exampleIp))))
    val verdict = h.controller.onPacket(h.ipPacket(1, exampleIp, 0, 0, byteArrayOf(8, 0, 0, 0)))
    assertEquals(BarrierPacketVerdict.Block(BarrierPacketReason.UNSUPPORTED_PROTOCOL), verdict)
    h.controller.explicitStop()
  }

  @Test fun dnsReplyRequiresRecordedFlowAndActiveState() {
    val h = BarrierHarness(); h.startOk()
    val q = h.dnsQuery("example.com")
    assertFalse(h.controller.allowDnsReply(q))
    assertTrue(h.controller.onDnsQuery(q) is BarrierDnsVerdict.Allow)
    assertTrue(h.controller.allowDnsReply(q))
    h.controller.explicitStop()
    assertFalse(h.controller.allowDnsReply(q))
  }
}

class BarrierLedgerTest {
  @Test fun queueBoundsAndDropsOldest() {
    val h = BarrierHarness(capacity = 3, maxBatch = 3)
    repeat(4) {
      h.ledger.offer(BarrierDecisionRecord("e$it", "2026-11-10T00:00:00Z", "a.example", "allow", null, CONSENT))
    }
    assertEquals(3, h.ledger.size())
    assertEquals(1, h.ledger.dropped)
  }

  @Test fun queuePersistsAndRestoresIncludingNullConsentId() {
    val h = BarrierHarness()
    h.ledger.offer(BarrierDecisionRecord("e1", "2026-11-10T00:00:00Z", "a.example", "allow", null, CONSENT))
    h.ledger.offer(BarrierDecisionRecord("e2", "2026-11-10T00:00:01Z", "b.example", "block", "CONSENT_NOT_GRANTED", null))
    h.ledger.persist()
    val restored = BarrierLedgerQueue(10, 4, h.store, h.newId)
    restored.restore()
    assertEquals(2, restored.size())
    val batch = restored.peekBatch()!!
    assertEquals(CONSENT, batch.decisions[0].consentId)
    assertNull(batch.decisions[1].consentId)
    assertEquals("CONSENT_NOT_GRANTED", batch.decisions[1].reason)
  }

  @Test fun queueDiscardsMalformedRestore() {
    val h = BarrierHarness()
    h.store.save("garbage\nB\tnope\n")
    h.ledger.restore()
    assertEquals(0, h.ledger.size())
    assertNull(h.store.load())
  }

  @Test fun batchJsonCarriesBarrierSchemaVersion() {
    val h = BarrierHarness()
    h.ledger.offer(BarrierDecisionRecord("e1", "2026-11-10T00:00:00Z", "a.example", "block", "CONSENT_NOT_GRANTED", CONSENT))
    val json = h.ledger.peekBatch()!!.toJson()
    assertTrue(json.contains("\"schemaVersion\":\"2026-11-10\""))
    assertTrue(json.contains("\"decision\":\"block\""))
    assertTrue(json.contains("\"reason\":\"CONSENT_NOT_GRANTED\""))
    assertTrue(json.contains("\"consentId\":\"$CONSENT\""))
  }

  @Test fun pumpUploadsAndAcks() {
    val h = BarrierHarness(); h.startOk()
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    assertEquals(BarrierPumpResult.Uploaded(1), h.pump.runOnce())
    assertEquals(0, h.ledger.size())
    assertEquals(1, h.uploader.batches.size)
    assertEquals(1, h.uploader.batches.single().decisions.size)
    h.controller.explicitStop()
  }

  @Test fun pumpTreatsDuplicateAsDelivered() {
    val h = BarrierHarness(); h.startOk()
    h.uploader.next = { UploadResult.Duplicate }
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    assertEquals(BarrierPumpResult.Uploaded(1), h.pump.runOnce())
    assertEquals(0, h.ledger.size())
    h.controller.explicitStop()
  }

  @Test fun pumpDiscardsRejectedBatch() {
    val h = BarrierHarness(); h.startOk()
    h.uploader.next = { UploadResult.Rejected }
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    assertEquals(BarrierPumpResult.Uploaded(0), h.pump.runOnce())
    assertEquals(1, h.pump.discardedBatches)
    assertEquals(0, h.ledger.size())
    h.controller.explicitStop()
  }

  @Test fun pumpHaltsOnUnauthorized() {
    val h = BarrierHarness(); h.startOk()
    h.uploader.next = { UploadResult.Unauthorized(401) }
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    assertEquals(BarrierPumpResult.Halted(BarrierReason.SESSION_REVOKED), h.pump.runOnce())
    h.uploader.next = { UploadResult.Unauthorized(403) }
    assertEquals(BarrierPumpResult.Halted(BarrierReason.CONSENT_NOT_GRANTED), h.pump.runOnce())
    h.controller.explicitStop()
  }

  @Test fun pumpRetriesTransientThenDiscards() {
    val h = BarrierHarness(); h.startOk()
    h.uploader.next = { UploadResult.Transient("timeout") }
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    val shortPump = BarrierLedgerPump(h.ledger, h.gate, h.uploader, Backoff(maxAttempts = 2, jitter = { it }))
    assertTrue(shortPump.runOnce() is BarrierPumpResult.RetryLater)
    assertTrue(shortPump.runOnce() is BarrierPumpResult.RetryLater)
    assertEquals(1, shortPump.discardedBatches)
    assertEquals(0, h.ledger.size())
    h.controller.explicitStop()
  }

  @Test fun pumpRetriesWhenAuthorityUnavailable() {
    val h = BarrierHarness(); h.startOk()
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    h.authority.result = AuthorityResult.Unavailable("offline")
    assertTrue(h.pump.runOnce() is BarrierPumpResult.RetryLater)
    assertEquals(1, h.ledger.size())
    h.controller.explicitStop()
  }

  @Test fun pumpHaltsWhenGateDenies() {
    // G3 mechanism: the upload step re-checks authorization, so a revocation halts the
    // worker within one pump step (~15s while idle) and the halt stops the barrier.
    val h = BarrierHarness(); h.startOk()
    h.controller.onDnsQuery(h.dnsQuery("a.example"))
    h.authority.result = okResponse(consent = "revoked")
    assertEquals(BarrierPumpResult.Halted(BarrierReason.CONSENT_NOT_GRANTED), h.pump.runOnce())
    h.controller.explicitStop()
  }

  @Test fun workerHaltsAndCallsOnHalt() {
    var halted: BarrierReason? = null
    val worker = BarrierLedgerWorker({ BarrierPumpResult.Halted(BarrierReason.SESSION_REVOKED) }, { halted = it })
    worker.start()
    assertTrue(worker.join(2_000))
    assertEquals(BarrierReason.SESSION_REVOKED, halted)
  }
}

class BarrierControllerLifecycleTest {
  @Test fun resumeAfterNetworkChangeRechecksAuthority() {
    val h = BarrierHarness(); h.startOk()
    val before = h.authority.calls.get()
    assertTrue(h.controller.resume() is BarrierDecision.Allow)
    assertEquals(before + 1, h.authority.calls.get())
    h.controller.explicitStop()
  }

  @Test fun resumeRecoversFromPause() {
    val h = BarrierHarness(sessionExpiresAtMs = 1_000_000L + 10_000_000); h.startOk()
    h.clock.now += 3_600_001
    h.authority.result = AuthorityResult.Unavailable("net")
    assertTrue(h.controller.resume() is BarrierDecision.Unavailable)
    assertEquals(State.PAUSED, h.controller.state)
    h.authority.result = okResponse()
    assertTrue(h.controller.resume() is BarrierDecision.Allow)
    assertEquals(State.ACTIVE, h.controller.state)
    h.controller.explicitStop()
  }

  @Test fun resumeStopsWhenOsAuthorizationLost() {
    val h = BarrierHarness(); h.startOk()
    h.os.vpn = false
    assertTrue(h.controller.resume() is BarrierDecision.Deny)
    assertEquals(State.STOPPED, h.controller.state)
  }

  @Test fun resumeDoesNothingWhenNotRunning() {
    val h = BarrierHarness()
    assertTrue(h.controller.resume() is BarrierDecision.Deny)
    assertEquals(0, h.authority.calls.get())
  }

  @Test fun stopIsIdempotentAndNotifiesOnce() {
    val h = BarrierHarness(); h.startOk()
    h.controller.explicitStop(); h.controller.stop(BarrierReason.SESSION_REVOKED)
    assertEquals(listOf(BarrierReason.USER_STOP), h.stops)
  }

  @Test fun workerThreadExitsOnStop() {
    val h = BarrierHarness(worker = true); h.startOk()
    h.controller.explicitStop()
    assertTrue(h.controller.awaitShutdown(2_000))
  }

  @Test fun restartAfterStopReactivatesWorker() {
    val h = BarrierHarness(worker = true); h.startOk()
    h.controller.explicitStop()
    assertTrue(h.controller.awaitShutdown(2_000))
    val before = h.authority.calls.get()
    assertTrue(h.startOk() is BarrierDecision.Allow)
    assertEquals(State.ACTIVE, h.controller.state)
    // The fresh worker's first pump step re-checks the gate (a fresh authority fetch).
    val deadline = System.currentTimeMillis() + 2_000
    while (h.authority.calls.get() == before && System.currentTimeMillis() < deadline) Thread.sleep(25)
    assertTrue(h.authority.calls.get() > before)
    h.controller.explicitStop()
    assertTrue(h.controller.awaitShutdown(2_000))
  }
}
