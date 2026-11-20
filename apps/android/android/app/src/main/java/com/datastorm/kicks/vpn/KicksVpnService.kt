package com.datastorm.kicks.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import androidx.core.app.NotificationCompat
import com.datastorm.kicks.MainActivity
import com.datastorm.kicks.R
import com.datastorm.kicks.vpn.core.BarrierDecision
import com.datastorm.kicks.vpn.core.BarrierDnsVerdict
import com.datastorm.kicks.vpn.core.BarrierPacket
import com.datastorm.kicks.vpn.core.BarrierPacketVerdict
import com.datastorm.kicks.vpn.core.BarrierReason
import com.datastorm.kicks.vpn.core.Decision
import com.datastorm.kicks.vpn.core.DnsPacket
import com.datastorm.kicks.vpn.core.Reason
import com.datastorm.kicks.vpn.core.State
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * DNS-metadata forwarder. The tunnel only owns a virtual DNS address (a single /32 route), so ALL other
 * traffic keeps using the normal network and connectivity is preserved by construction. DNS queries are
 * forwarded unmodified to the real resolver through a protect()ed socket; only the queried host name,
 * a size bucket and a timestamp are ever turned into an observation. If anything about authorization or
 * the tunnel fails, the tunnel is closed and the OS falls back to the network's own resolver.
 *
 * The Gated Fail-Closed Lock (barrier) shares this one service with the collector: Android allows a
 * single active VpnService, so the two subsystems are independently gated and independently killable
 * within it, not separate services. When the barrier is off, everything below is exactly the
 * collector-only behavior above. When the barrier is on, the tunnel becomes a full tunnel
 * (0.0.0.0/0) and every packet is decided by the barrier gate first: DNS is allowed only while
 * authorization is live (and the decision is recorded in the separate barrier ledger), and a
 * non-DNS packet is allowed only to an IP an authorized DNS answer returned. The KICK'S app
 * itself is excluded from the barrier tunnel (addDisallowedApplication) so the control plane —
 * authorization and ledger upload — can always reach the authority; without that exclusion the
 * barrier could never prove authorization, because its own authority call would be blocked by
 * itself. All other apps' traffic is enforced.
 *
 * TCP relay is the named gap in this proof: the barrier decides TCP packets (allow to a
 * resolved IP, block otherwise) but the service has no user-space TCP relay yet, so an
 * allowed TCP packet is dropped and counted until a relay lands. See BARRIER_PROOF_NOTES.md.
 * IPv6 is not routed through the barrier tunnel in this proof (IPv4 only).
 */
class KicksVpnService : VpnService() {
  companion object {
    const val ACTION_START = "com.datastorm.kicks.vpn.START"
    const val ACTION_STOP = "com.datastorm.kicks.vpn.STOP"
    const val ACTION_START_BARRIER = "com.datastorm.kicks.vpn.START_BARRIER"
    const val ACTION_STOP_BARRIER = "com.datastorm.kicks.vpn.STOP_BARRIER"
    private const val CHANNEL_ID = "kicks_privacy_monitor"
    private const val NOTIFICATION_ID = 731
    private const val CLIENT_ADDRESS = "10.111.222.1"
    private const val VIRTUAL_DNS = "10.111.222.2"
    private const val UPSTREAM_TIMEOUT_MS = 4_000
  }

  private enum class TunnelMode { COLLECTOR_ONLY, BARRIER }

  private val closing = AtomicBoolean(false)
  private val started = AtomicBoolean(false)
  @Volatile private var running = false
  @Volatile private var tun: ParcelFileDescriptor? = null
  @Volatile private var tunnelMode = TunnelMode.COLLECTOR_ONLY
  @Volatile private var barrierWasActive = false
  @Volatile private var upstream: InetAddress? = null
  @Volatile private var upstreamNetwork: Network? = null
  private var reader: Thread? = null
  private var callback: ConnectivityManager.NetworkCallback? = null
  private val sockets: MutableSet<DatagramSocket> = ConcurrentHashMap.newKeySet()
  private val control: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "kicks-control") }
  private val resolvers: ExecutorService = Executors.newFixedThreadPool(4) { Thread(it, "kicks-dns").apply { isDaemon = true } }
  private val components by lazy { CollectorRuntime.get(this) }
  private val barrierComponents by lazy { BarrierRuntime.get(this) }

  override fun onBind(intent: Intent?): IBinder? = super.onBind(intent)

  override fun onCreate() {
    super.onCreate()
    CollectorRuntime.service = this
    BarrierRuntime.service = this
    // One service, two subsystems: a stop of one must not kill the other while it is still active.
    // The collector keeps running when the barrier stops, and the barrier keeps enforcing when the
    // collector stops; only when neither is active does the service shut down.
    components.controller.onStopped = {
      if (barrierComponents.controller.state != State.ACTIVE) shutdown()
    }
    barrierComponents.controller.onStopped = {
      if (!closing.get() && barrierWasActive) {
        barrierWasActive = false
        if (components.controller.state == State.ACTIVE) rebuildToCollectorMode() else shutdown()
      }
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        components.controller.explicitStop()
        barrierComponents.controller.explicitStop()
        shutdown()
        return START_NOT_STICKY
      }
      ACTION_STOP_BARRIER -> {
        barrierComponents.controller.explicitStop()
        return START_NOT_STICKY
      }
      ACTION_START_BARRIER -> {
        createChannel()
        startForegroundCompat(notification("Checking authorization before the barrier starts."))
        control.execute { startBarrier() }
        return START_NOT_STICKY
      }
      ACTION_START -> {
        createChannel()
        startForegroundCompat(notification("Checking authorization before monitoring starts."))
        // Never auto-start from a system restart or a stray intent: only an explicit, gated start proceeds.
        if (!started.compareAndSet(false, true)) {
          return START_NOT_STICKY
        }
        control.execute {
          val decision = components.controller.start { establishCollector() }
          if (decision is Decision.Allow) {
            refreshNotification()
          } else {
            if (barrierComponents.controller.state != State.ACTIVE) shutdown()
          }
        }
        return START_NOT_STICKY
      }
      else -> {
        shutdown()
        return START_NOT_STICKY
      }
    }
  }

  /** Starts the barrier on the control thread. A denial leaves the barrier stopped; the collector (if active) keeps running. */
  private fun startBarrier() {
    val barrier = barrierComponents.controller
    if (barrier.state == State.ACTIVE || barrier.state == State.STARTING) return
    val decision = barrier.start { establishBarrier() }
    if (decision is BarrierDecision.Allow) {
      barrierWasActive = true
      refreshNotification()
    }
  }

  /** The OS revoked VPN authorization (another VPN took over or the user removed it): stop at once. */
  override fun onRevoke() {
    barrierComponents.controller.stop(BarrierReason.OS_VPN_NOT_AUTHORIZED)
    components.controller.stop(Reason.OS_VPN_NOT_AUTHORIZED)
    shutdown()
    super.onRevoke()
  }

  override fun onDestroy() {
    barrierComponents.controller.stop(BarrierReason.SERVICE_STOPPED)
    components.controller.stop(Reason.SERVICE_STOPPED)
    teardown()
    CollectorRuntime.service = null
    BarrierRuntime.service = null
    super.onDestroy()
  }

  /** Collector-only tunnel. A barrier tunnel already up is left alone: the collector rides on it. */
  private fun establishCollector(): Boolean {
    if (tun != null) return true
    return establishTunnel(full = false) { components.controller.stop(Reason.NO_UPSTREAM_DNS) }
  }

  /** Barrier tunnel. Rebuilds a collector-only tunnel to full mode when one is already up. */
  private fun establishBarrier(): Boolean {
    if (tun != null && tunnelMode == TunnelMode.BARRIER) return true
    return establishTunnel(full = true) { barrierComponents.controller.stop(BarrierReason.TUNNEL_FAILED) }
  }

  /**
   * Builds (or rebuilds) the tunnel. A rebuild closes the current tunnel and waits for its
   * reader to exit before building the new one; the old reader recognizes the replaced
   * descriptor and exits without stopping any controller. The network callback is registered
   * once and survives rebuilds.
   */
  private fun establishTunnel(full: Boolean, onNoUpstream: () -> Unit): Boolean {
    if (tun != null && tunnelMode == if (full) TunnelMode.BARRIER else TunnelMode.COLLECTOR_ONLY) return true
    val cm = getSystemService(ConnectivityManager::class.java)
    // Pick the resolver before closing anything: a rebuild that cannot find an upstream
    // leaves the current tunnel alone instead of dropping the device offline.
    if (!refreshUpstream(cm)) { onNoUpstream(); return false }
    if (tun != null) {
      try { tun?.close() } catch (e: Exception) { }
      tun = null
      reader?.let { if (it !== Thread.currentThread()) it.join(2_000) }
    }
    val builder = Builder()
      .setSession(if (full) "KICK'S network barrier" else "KICK'S privacy monitoring")
      .addAddress(CLIENT_ADDRESS, 32)
      .addDnsServer(VIRTUAL_DNS)
      .addRoute(VIRTUAL_DNS, 32)
      .setMtu(1500)
      .setBlocking(true)
    if (full) {
      builder.addRoute("0.0.0.0", 0)
      // The KICK'S app itself bypasses its own barrier tunnel so the control plane
      // (authorization and ledger upload) can always reach the authority.
      builder.addDisallowedApplication(packageName)
    }
    val pfd = builder.establish() ?: return false
    tun = pfd
    tunnelMode = if (full) TunnelMode.BARRIER else TunnelMode.COLLECTOR_ONLY
    running = true
    if (callback == null) {
      val request = NetworkRequest.Builder()
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
        .build()
      val cb = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = networkChanged(cm)
        override fun onLinkPropertiesChanged(network: Network, lp: android.net.LinkProperties) = networkChanged(cm)
        override fun onLost(network: Network) = networkChanged(cm)
      }
      callback = cb
      cm.registerNetworkCallback(request, cb)
    }
    reader = Thread({ readLoop(pfd) }, "kicks-tun").also { it.start() }
    return true
  }

  /** The barrier stopped while the collector is still active: drop back to the collector-only tunnel. */
  private fun rebuildToCollectorMode() {
    control.execute {
      if (closing.get() || !running || tunnelMode != TunnelMode.BARRIER) return@execute
      establishTunnel(full = false) { components.controller.stop(Reason.NO_UPSTREAM_DNS) }
      refreshNotification()
    }
  }

  private fun notificationText(): String {
    val collectorActive = components.controller.state == State.ACTIVE
    val barrierActive = barrierComponents.controller.state == State.ACTIVE
    return when {
      collectorActive && barrierActive -> "Monitoring and network barrier are active. Tap to review or pause."
      barrierActive -> "Network barrier is active. Tap to review or pause."
      else -> "Metadata monitoring is active. Tap to review or pause."
    }
  }

  private fun refreshNotification() {
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(notificationText()))
  }

  /** Network-change recovery: re-pick the resolver, then re-run the authorization gates (RESUME). */
  private fun networkChanged(cm: ConnectivityManager) {
    if (!running) return
    refreshUpstream(cm)
    try { control.execute { if (running) { components.controller.resume(); barrierComponents.controller.resume() } } } catch (e: RejectedExecutionException) { }
  }

  private fun refreshUpstream(cm: ConnectivityManager): Boolean {
    val candidates = listOfNotNull(cm.activeNetwork) + cm.allNetworks
    for (n in candidates) {
      val caps = cm.getNetworkCapabilities(n) ?: continue
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
      val dns = cm.getLinkProperties(n)?.dnsServers?.filter { it.hostAddress != VIRTUAL_DNS } ?: continue
      val pick = dns.firstOrNull { it is Inet4Address } ?: dns.firstOrNull() ?: continue
      upstream = pick; upstreamNetwork = n
      return true
    }
    upstream = null; upstreamNetwork = null
    return false
  }

  private fun readLoop(pfd: ParcelFileDescriptor) {
    val input = FileInputStream(pfd.fileDescriptor)
    val output = FileOutputStream(pfd.fileDescriptor)
    val buf = ByteArray(32767)
    try {
      while (running) {
        val n = input.read(buf)
        if (n < 0) break
        if (n == 0) continue
        val barrierActive = barrierComponents.controller.state == State.ACTIVE
        val q = DnsPacket.parse(buf, n)
        if (q != null) {
          if (barrierActive) {
            // The barrier decides every DNS query first. A blocked query is dropped; the
            // decision is already in the barrier ledger.
            when (barrierComponents.controller.onDnsQuery(q)) {
              is BarrierDnsVerdict.Allow -> try { resolvers.execute { resolve(q, output) } } catch (e: RejectedExecutionException) { break }
              is BarrierDnsVerdict.Block -> Unit
            }
          } else {
            try { resolvers.execute { resolve(q, output) } } catch (e: RejectedExecutionException) { break }
          }
        } else if (barrierActive) {
          // Non-DNS packet, barrier on: the packet layer decides. Allowed UDP is
          // forwarded; allowed TCP is decided but dropped (no TCP relay yet — see the
          // class header); anything else is dropped.
          when (val v = barrierComponents.controller.onPacket(buf, n)) {
            is BarrierPacketVerdict.AllowUdp -> try { resolvers.execute { forwardUdp(v.packet, output) } } catch (e: RejectedExecutionException) { break }
            is BarrierPacketVerdict.AllowTcp -> Unit
            is BarrierPacketVerdict.Block -> Unit
          }
        }
        // Not DNS and the barrier is off: dropped, exactly as before.
      }
    } catch (e: Exception) {
      // A stale reader (its tunnel was replaced by a rebuild) exits silently; only a
      // failure of the current tunnel stops the collector.
      if (running && tun === pfd) components.controller.stop(Reason.TUNNEL_FAILED)
    }
  }

  private fun resolve(q: com.datastorm.kicks.vpn.core.DnsQuery, output: FileOutputStream) {
    val target = upstream ?: return
    val socket = DatagramSocket()
    sockets.add(socket)
    try {
      protect(socket)
      upstreamNetwork?.bindSocket(socket)
      socket.soTimeout = UPSTREAM_TIMEOUT_MS
      socket.send(DatagramPacket(q.payload, q.payload.size, target, 53))
      val rbuf = ByteArray(4096)
      val reply = DatagramPacket(rbuf, rbuf.size)
      socket.receive(reply)
      val response = rbuf.copyOf(reply.length)
      val barrier = barrierComponents.controller
      if (barrier.state == State.ACTIVE) {
        // Asymmetric inbound: the answer is written back only while the barrier is ACTIVE
        // and the outbound flow that caused it is still recorded.
        if (!barrier.allowDnsReply(q)) return
        barrier.noteDnsAnswer(q.qname, response)
      }
      synchronized(output) { output.write(DnsPacket.buildResponse(q, response)) }
      // Recorded after the answer is delivered so authorization lookups never delay DNS.
      components.controller.onDns(q.qname, q.payload.size + response.size)
    } catch (e: Exception) {
      // timeout/IO: the app retries on its own; nothing is recorded
    } finally {
      sockets.remove(socket); socket.close()
    }
  }

  /** Forwards one allowed non-DNS UDP datagram to its destination and returns the reply. */
  private fun forwardUdp(packet: BarrierPacket.IpPacket, output: FileOutputStream) {
    val destination = try { InetAddress.getByAddress(packet.dstIp) } catch (e: Exception) { return }
    val socket = DatagramSocket()
    sockets.add(socket)
    try {
      protect(socket)
      upstreamNetwork?.bindSocket(socket)
      socket.soTimeout = UPSTREAM_TIMEOUT_MS
      socket.send(DatagramPacket(packet.payload, packet.payload.size, destination, packet.dstPort))
      val rbuf = ByteArray(32767)
      val reply = DatagramPacket(rbuf, rbuf.size)
      socket.receive(reply)
      // The reply must come from the destination the packet was sent to.
      if (reply.address != destination || reply.port != packet.dstPort) return
      val response = rbuf.copyOf(reply.length)
      val barrier = barrierComponents.controller
      if (!barrier.allowUdpReply(packet)) return
      synchronized(output) { output.write(BarrierPacket.buildUdpResponse(packet, response)) }
    } catch (e: Exception) {
      // timeout/IO: the app retries on its own; nothing is recorded
    } finally {
      sockets.remove(socket); socket.close()
    }
  }

  /** Idempotent, deterministic teardown on its own thread (callers may be the worker or main thread). */
  fun shutdown() {
    Thread({ teardown() }, "kicks-shutdown").start()
  }

  private fun teardown() {
    if (!closing.compareAndSet(false, true)) return
    running = false
    callback?.let { try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (e: Exception) { } }
    callback = null
    try { tun?.close() } catch (e: Exception) { }
    tun = null
    resolvers.shutdownNow()
    control.shutdownNow()
    sockets.forEach { try { it.close() } catch (e: Exception) { } }
    sockets.clear()
    reader?.let { if (it !== Thread.currentThread()) it.join(2_000) }
    barrierComponents.controller.awaitShutdown(2_000)
    components.controller.awaitShutdown(2_000)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun startForegroundCompat(n: Notification) {
    if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(NOTIFICATION_ID, n)
  }

  private fun notification(text: String): Notification {
    val launch = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("KICK'S privacy monitoring")
      .setContentText(text)
      .setOngoing(true)
      .setContentIntent(launch)
      .build()
  }

  private fun createChannel() {
    val channel = NotificationChannel(CHANNEL_ID, "KICK'S privacy monitoring", NotificationManager.IMPORTANCE_LOW)
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }
}
