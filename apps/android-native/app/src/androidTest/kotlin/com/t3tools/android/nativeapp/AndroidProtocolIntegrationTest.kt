package com.t3tools.android.nativeapp

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import coil.imageLoader
import coil.request.ErrorResult
import coil.request.ImageRequest
import coil.request.SuccessResult
import com.t3tools.android.protocol.T3ProtocolClient
import com.t3tools.android.protocol.toShellSnapshot
import java.net.URI
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
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
    val workspaceCwd = InstrumentationRegistry.getArguments().getString("workspaceCwd")
    val workspaceThreadId = InstrumentationRegistry.getArguments().getString("workspaceThreadId")
    val cloneRemoteUrl = InstrumentationRegistry.getArguments().getString("cloneRemoteUrl")
    val cloneDestination = InstrumentationRegistry.getArguments().getString("cloneDestination")
    val gitCwd = InstrumentationRegistry.getArguments().getString("gitCwd")
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
      if (!workspaceCwd.isNullOrBlank()) {
        val entries = client.listWorkspaceEntries(connected.session, workspaceCwd)
        assertTrue(entries.entries.any { it.path == "README.md" && it.kind == "file" })
        assertTrue(client.searchWorkspaceEntries(connected.session, workspaceCwd, "README")
          .entries.any { it.path == "README.md" })
        assertTrue(client.searchWorkspaceContents(connected.session, workspaceCwd, "phase-three-alpha")
          .matches.any { it.path == "README.md" })
        assertEquals(
          "# Phase 3A\n\nphase-three-alpha\n",
          client.readWorkspaceFile(connected.session, workspaceCwd, "README.md").contents,
        )
        assertTrue(client.browseFilesystem(connected.session, "$workspaceCwd/")
          .entries.any { it.name == "src" })
        if (!workspaceThreadId.isNullOrBlank()) {
          val asset = client.createWorkspaceAssetUrl(
            connected.session,
            workspaceThreadId,
            "$workspaceCwd/assets/phase3a.svg",
          )
          val base = requireNotNull(pairingUrl).substringBefore("/pair").trimEnd('/')
          val url = URI("$base/").resolve(asset.relativeUrl.removePrefix("/")).toString()
          val result = instrumentation.targetContext.imageLoader.execute(
            ImageRequest.Builder(instrumentation.targetContext).data(url).build(),
          )
          val detail = (result as? ErrorResult)?.throwable?.stackTraceToString() ?: result.toString()
          assertTrue("Coil failed to decode the workspace asset: $detail", result is SuccessResult)
        }
      }
      if (!cloneRemoteUrl.isNullOrBlank() && !cloneDestination.isNullOrBlank()) {
        val cloned = client.cloneRepository(connected.session, cloneRemoteUrl, cloneDestination)
        assertEquals(cloneDestination, cloned.cwd)
        assertTrue(client.listWorkspaceEntries(connected.session, cloned.cwd)
          .entries.any { it.path == "README.md" })
      }
      if (!gitCwd.isNullOrBlank()) {
        val status = client.refreshVcsStatus(connected.session, gitCwd)
        val streamed = client.vcsStatus(connected.session, gitCwd).first()
        val refs = client.listVcsRefs(connected.session, gitCwd)

        assertTrue(status.isRepo)
        assertTrue(streamed is com.t3tools.android.protocol.VcsStatusEvent.Snapshot)
        assertTrue(refs.isRepo)
        assertTrue(refs.refs.any { it.current })
      }
    } finally {
      connected.session.close()
      store.clear(connected.descriptor.environmentId)
      client.close()
    }
  }
}
