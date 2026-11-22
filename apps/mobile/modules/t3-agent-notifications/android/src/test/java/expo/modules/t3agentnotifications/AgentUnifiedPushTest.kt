package expo.modules.t3agentnotifications

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.unifiedpush.android.connector.data.PublicKeySet

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 36], manifest = Config.NONE)
class AgentUnifiedPushTest : AgentNotificationsFixture() {
  private fun body(alertId: String, kind: String = "agent_activity") =
    JSONObject(update(alertId, false) + ("t3_kind" to kind)).toString().toByteArray()

  @Test
  fun deliversTheWatcherPayloadThroughTheSharedPresentation() {
    AgentUnifiedPush.receive(context, body("pushed"))
    assertEquals("pushed".hashCode(), manager.activeNotifications.single().id)
  }

  @Test
  fun ignoresPayloadsThatAreNotAgentActivity() {
    AgentUnifiedPush.receive(context, body("other", kind = "something_else"))
    AgentUnifiedPush.receive(context, "not json".toByteArray())
    assertTrue(manager.activeNotifications.isEmpty())
  }

  @Test
  fun rejectsOversizedBodies() {
    assertNull(AgentUnifiedPush.decode(ByteArray(9000) { 'a'.code.toByte() }))
    assertNotNull(AgentUnifiedPush.decode(body("small")))
  }

  @Test
  fun aNewEndpointAfterAnotherPostsAChangeNotice() {
    AgentUnifiedPush.endpointChanged(context, "http://push.example/up1", null)
    assertTrue(manager.activeNotifications.isEmpty())
    AgentUnifiedPush.endpointChanged(context, "http://push.example/up1", null)
    assertTrue(manager.activeNotifications.isEmpty())
    AgentUnifiedPush.endpointChanged(context, "http://push.example/up2", null)
    assertEquals(73002, manager.activeNotifications.single().id)
    assertEquals("http://push.example/up2", AgentUnifiedPush.state(context)["endpoint"])
  }

  @Test
  fun keysAreExposedAndANewAuthSecretPostsAChangeNotice() {
    AgentUnifiedPush.endpointChanged(
      context,
      "http://push.example/up",
      PublicKeySet("p256", "auth1")
    )
    assertEquals(
      mapOf("p256dh" to "p256", "auth" to "auth1"),
      AgentUnifiedPush.state(context)["keys"]
    )
    assertTrue(manager.activeNotifications.isEmpty())
    AgentUnifiedPush.endpointChanged(
      context,
      "http://push.example/up",
      PublicKeySet("p256", "auth2")
    )
    assertEquals(73002, manager.activeNotifications.single().id)
  }
}
