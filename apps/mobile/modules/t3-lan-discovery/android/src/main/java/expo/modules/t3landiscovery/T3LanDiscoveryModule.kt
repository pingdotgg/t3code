package expo.modules.t3landiscovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address

class T3LanDiscoveryModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val manager: NsdManager by lazy {
    appContext.reactContext!!.getSystemService(Context.NSD_SERVICE) as NsdManager
  }
  private var listener: NsdManager.DiscoveryListener? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private var generation = 0
  private val services = linkedMapOf<String, NsdServiceInfo>()
  private val pending = ArrayDeque<Pair<Int, String>>()
  private var resolving = false
  private val records = mutableMapOf<String, Map<String, Any>>()

  override fun definition() = ModuleDefinition {
    Name("T3LanDiscovery")
    Events("servicesChanged")
    AsyncFunction("start") { start() }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { stop() }.runOnQueue(Queues.MAIN)
    AsyncFunction("refresh") {
      if (listener != null) {
        stop()
        start()
      }
    }.runOnQueue(Queues.MAIN)
    OnDestroy { main.post { stop() } }
  }

  private fun id(service: NsdServiceInfo) = "${service.serviceName}.${service.serviceType}"

  private fun start() {
    if (listener != null) return
    val current = ++generation
    val wifi = appContext.reactContext?.applicationContext?.getSystemService(
      Context.WIFI_SERVICE
    ) as? WifiManager
    multicastLock =
      wifi?.createMulticastLock("t3-lan-discovery")?.apply {
        setReferenceCounted(false)
        acquire()
      }
    val discovery = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(type: String) = Unit
      override fun onDiscoveryStopped(type: String) = Unit
      override fun onStartDiscoveryFailed(type: String, code: Int) {
        main.post {
          if (listener === this) {
            stop()
          }
        }
      }
      override fun onStopDiscoveryFailed(type: String, code: Int) = Unit
      override fun onServiceFound(service: NsdServiceInfo) {
        main.post {
          if (generation != current || listener !== this) return@post
          val key = id(service)
          if (services.containsKey(key) || services.size >= 64) return@post
          services[key] = service
          pending.addLast(current to key)
          resolveNext()
        }
      }
      override fun onServiceLost(service: NsdServiceInfo) {
        main.post {
          if (generation != current || listener !== this) return@post
          val key = id(service)
          services.remove(key)
          pending.removeAll { it.second == key }
          if (records.remove(key) != null) publish()
        }
      }
    }
    listener = discovery
    runCatching {
      manager.discoverServices("_t3code._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery)
    }.onFailure { stop() }.getOrThrow()
  }

  private fun stop() {
    generation++
    listener?.let {
      try {
        manager.stopServiceDiscovery(it)
      } catch (_: IllegalArgumentException) { }
    }
    listener = null
    multicastLock?.let { if (it.isHeld) it.release() }
    multicastLock = null
    services.clear()
    pending.clear()
    records.clear()
    publish()
  }

  private fun resolveNext() {
    if (resolving) return
    while (pending.isNotEmpty()) {
      val (current, key) = pending.removeFirst()
      val service = services[key]
      if (current != generation || service == null) continue
      resolving = true
      val resolve = object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
          main.post {
            resolving = false
            resolveNext()
          }
        }
        override fun onServiceResolved(info: NsdServiceInfo) {
          main.post {
            resolving = false
            if (generation == current && services[key] === service) {
              val environmentId = info.attributes["environmentId"]?.toString(Charsets.UTF_8)
              val hosts = if (Build.VERSION.SDK_INT >= 34) {
                info.hostAddresses.filterIsInstance<Inet4Address>()
              } else {
                listOfNotNull(info.host as? Inet4Address)
              }
              val addresses = hosts.mapNotNull { it.hostAddress }.distinct()
              if (!environmentId.isNullOrEmpty() && addresses.isNotEmpty() &&
                info.port in 1..65535
              ) {
                records[key] =
                  mapOf(
                    "id" to key,
                    "environmentId" to environmentId,
                    "addresses" to addresses,
                    "port" to info.port
                  )
                publish()
              }
            }
            resolveNext()
          }
        }
      }
      try {
        @Suppress("DEPRECATION")
        manager.resolveService(service, resolve)
      } catch (_: RuntimeException) {
        resolving = false
      }
      if (resolving) return
    }
  }

  private fun publish() {
    sendEvent("servicesChanged", mapOf("services" to records.toSortedMap().values.toList()))
  }
}
