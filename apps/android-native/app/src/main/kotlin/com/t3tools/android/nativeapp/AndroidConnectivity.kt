package com.t3tools.android.nativeapp

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class ConnectivityStatus { Unknown, Offline, Online }

class AndroidConnectivity(context: Context) : AutoCloseable {
  private val manager = context.getSystemService(ConnectivityManager::class.java)
  private val mutableStatus = MutableStateFlow(readStatus())
  val status: StateFlow<ConnectivityStatus> = mutableStatus.asStateFlow()

  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = refresh()
    override fun onLost(network: Network) = refresh()
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = refresh()
  }

  init {
    runCatching { manager.registerDefaultNetworkCallback(callback) }
      .onFailure { mutableStatus.value = ConnectivityStatus.Unknown }
  }

  private fun refresh() {
    mutableStatus.value = readStatus()
  }

  private fun readStatus(): ConnectivityStatus = runCatching {
    val network = manager.activeNetwork ?: return@runCatching ConnectivityStatus.Offline
    val capabilities = manager.getNetworkCapabilities(network)
      ?: return@runCatching ConnectivityStatus.Offline
    if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
      ConnectivityStatus.Online
    } else {
      ConnectivityStatus.Offline
    }
  }.getOrDefault(ConnectivityStatus.Unknown)

  override fun close() {
    runCatching { manager.unregisterNetworkCallback(callback) }
  }
}
