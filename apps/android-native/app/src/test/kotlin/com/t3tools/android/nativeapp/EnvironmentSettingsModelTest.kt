package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Test

class EnvironmentSettingsModelTest {
  @Test
  fun `splits local and relay environments without duplicating saved relays`() {
    val local = environment("local", EnvironmentKind.Bearer)
    val connectedRelay = environment("connected", EnvironmentKind.Relay)
    val listedConnected = relay("connected")
    val listedAvailable = relay("available")

    val sections = splitEnvironmentSettings(
      saved = listOf(connectedRelay, local),
      listedRelay = listOf(listedConnected, listedAvailable),
    )

    assertEquals(listOf(local), sections.local)
    assertEquals(listOf(connectedRelay), sections.connectedRelay)
    assertEquals(listOf(listedAvailable), sections.availableRelay)
  }

  @Test
  fun `uses actionable connection errors when available`() {
    val status = EnvironmentConnectionStatus(
      environment = environment("local", EnvironmentKind.Bearer),
      connectionPhase = ConnectionPhase.Error,
      shellSyncPhase = SyncPhase.Error,
      error = "Token expired",
    )

    assertEquals("Connection failed. Reason: Token expired", environmentConnectionLabel(status))
    assertEquals("Saved", environmentConnectionLabel(null))
  }

  @Test
  fun `keeps saved relay environments visible without discovery`() {
    val connectedRelay = environment("connected", EnvironmentKind.Relay)

    val sections = splitEnvironmentSettings(listOf(connectedRelay), emptyList())

    assertEquals(listOf(connectedRelay), sections.connectedRelay)
    assertEquals(emptyList<RelayEnvironment>(), sections.availableRelay)
  }

  private fun environment(id: String, kind: EnvironmentKind) = SavedEnvironment(
    environmentId = id,
    label = id,
    httpBaseUrl = "https://$id.example.test",
    kind = kind,
  )

  private fun relay(id: String) = RelayEnvironment(
    environmentId = id,
    label = id,
    endpoint = RelayEndpoint(
      httpBaseUrl = "https://$id.example.test",
      wsBaseUrl = "wss://$id.example.test/ws",
      providerKind = "cloudflare_tunnel",
    ),
    linkedAt = "2026-01-01T00:00:00.000Z",
  )
}
