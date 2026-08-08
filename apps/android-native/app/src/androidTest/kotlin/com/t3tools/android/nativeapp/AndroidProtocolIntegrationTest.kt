package com.t3tools.android.nativeapp

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.t3tools.android.protocol.T3ProtocolClient
import com.t3tools.android.protocol.toShellSnapshot
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidProtocolIntegrationTest {
  @Test
  fun pairs_and_loads_shell_on_android() = runBlocking {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val pairingUrl = InstrumentationRegistry.getArguments().getString("pairingUrl")
    assumeTrue("pairingUrl instrumentation argument is required", !pairingUrl.isNullOrBlank())

    val store = AndroidCredentialStore(instrumentation.targetContext)
    val client = T3ProtocolClient(credentialStore = store)
    val connected = client.pairAndConnect(requireNotNull(pairingUrl))
    try {
      var snapshotSeen = false
      client.shell(connected.session).first { item ->
        if (item["kind"]?.jsonPrimitive?.content == "snapshot") {
          snapshotSeen = true
          // Fresh disposable servers may have zero projects; only require a decodable snapshot.
          assertNotNull(item.toShellSnapshot())
        }
        item["kind"]?.jsonPrimitive?.content == "synchronized"
      }
      assertTrue(snapshotSeen)
      assertNotNull(connected.config["environment"])
      client.probe(connected.session)
    } finally {
      connected.session.close()
      store.clear(connected.descriptor.environmentId)
      client.close()
    }
  }
}
