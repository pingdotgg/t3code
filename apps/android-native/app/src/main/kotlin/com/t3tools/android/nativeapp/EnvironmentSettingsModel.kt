package com.t3tools.android.nativeapp

data class EnvironmentSettingsSections(
  val local: List<SavedEnvironment>,
  val connectedRelay: List<SavedEnvironment>,
  val availableRelay: List<RelayEnvironment>,
)

fun splitEnvironmentSettings(
  saved: List<SavedEnvironment>,
  listedRelay: List<RelayEnvironment>,
): EnvironmentSettingsSections {
  val savedIds = saved.mapTo(mutableSetOf(), SavedEnvironment::environmentId)
  return EnvironmentSettingsSections(
    local = saved.filter { it.kind == EnvironmentKind.Bearer },
    connectedRelay = saved.filter { it.kind == EnvironmentKind.Relay },
    availableRelay = listedRelay.filterNot { it.environmentId in savedIds },
  )
}

fun environmentConnectionLabel(status: EnvironmentConnectionStatus?): String = when (status?.connectionPhase) {
  ConnectionPhase.Connected -> "Connected"
  ConnectionPhase.Connecting -> "Connecting…"
  ConnectionPhase.Backoff -> status.error?.let { "Failed to connect. Reconnecting… Reason: $it" }
    ?: "Reconnecting…"
  ConnectionPhase.Blocked, ConnectionPhase.Error -> status.error?.let { "Connection failed. Reason: $it" }
    ?: "Connection failed"
  ConnectionPhase.Offline -> "Offline"
  ConnectionPhase.Empty, null -> "Saved"
}
