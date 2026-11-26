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
    JSONObject(update(alertId, false) + ("t3_kind" to kind) + ("user_id" to "user")).toString().toByteArray()

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

  private fun card(source: String, phase: String, active: Int, attention: Int, line: String) =
    mapOf(
      "t3_kind" to "agent_activity",
      "device_id" to "device",
      "user_id" to "user",
      "user_hash" to "60a4ea94a99303630c40fff23f4de5c06a8f978289a3889f31edfac3b89f85d7",
      "updated_at" to System.currentTimeMillis().toString(),
      "source" to source,
      "active" to (active > 0).toString(),
      "activity_phase" to phase,
      "activity_active_count" to active.toString(),
      "activity_attention_count" to attention.toString(),
      "activity_body" to line,
      "activity_line_0" to line,
      "activity_path" to "/threads/$source/thread",
      "activity_expires_at" to (System.currentTimeMillis() + 60_000).toString(),
    )

  @Test
  fun oneServerCardPassesThroughUnchanged() {
    val only = card("a", "running", 1, 0, "Working\tA\tP")
    assertEquals(only, AgentUnifiedPush.mergeCards(only, listOf(only)))
  }

  @Test
  fun cardsFromTwoServersMergeWithTheAttentionServerFirst() {
    val working = card("a", "running", 1, 0, "Working\tA\tP")
    val waiting = card("b", "waiting_for_approval", 1, 1, "Approve\tB\tQ")
    val merged = AgentUnifiedPush.mergeCards(working, listOf(working, waiting))
    assertEquals("2", merged["activity_active_count"])
    assertEquals("1", merged["activity_attention_count"])
    assertEquals("2 active agents · 1 needs attention", merged["activity_title"])
    assertEquals("waiting_for_approval", merged["activity_phase"])
    assertEquals("/threads/b/thread", merged["activity_path"])
    assertEquals(
      listOf("Approve\tB\tQ", "Working\tA\tP"),
      listOf(merged["activity_line_0"], merged["activity_line_1"])
    )
  }

  @Test
  fun aServerWhoseCardExpiredDropsOutOfTheMerge() {
    val stale = card("a", "running", 1, 0, "Working\tA\tP") +
      ("activity_expires_at" to (System.currentTimeMillis() - 1).toString())
    AgentUnifiedPush.receive(context, JSONObject(stale).toString().toByteArray())
    val fresh = card("b", "running", 1, 0, "Working\tB\tQ")
    AgentUnifiedPush.receive(context, JSONObject(fresh).toString().toByteArray())
    val shown = manager.activeNotifications.single { it.tag == "t3-agent-activity" }
    // One row left: the card is titled by that thread, not "2 working".
    assertEquals("B", shown.notification.extras.getString(android.app.Notification.EXTRA_TITLE))
  }

  private fun at(card: Map<String, String>, updatedAt: Long) =
    card + ("updated_at" to updatedAt.toString())

  private fun shownTitle() = manager.activeNotifications.single { it.tag == "t3-agent-activity" }
    .notification.extras.getString(android.app.Notification.EXTRA_TITLE)

  @Test
  fun aServerWhoseOlderMessageArrivesLateStillJoinsTheCard() {
    val now = System.currentTimeMillis()
    val newer = at(card("a", "running", 1, 0, "Working\tA\tP"), now)
    val olderFromB = at(card("b", "running", 1, 0, "Working\tB\tQ"), now - 5_000)
    AgentUnifiedPush.receive(context, JSONObject(newer).toString().toByteArray())
    AgentUnifiedPush.receive(context, JSONObject(olderFromB).toString().toByteArray())
    assertEquals("2 working", shownTitle())
  }

  @Test
  fun anOlderMessageFromTheSameServerDoesNotReplaceItsNewerCard() {
    val now = System.currentTimeMillis()
    val finished = at(card("a", "completed", 0, 0, "Done\tA\tP"), now)
    val staleRunning = at(card("a", "running", 1, 0, "Working\tA\tP"), now - 5_000)
    val other = at(card("b", "running", 1, 0, "Working\tB\tQ"), now + 1_000)
    AgentUnifiedPush.receive(context, JSONObject(finished).toString().toByteArray())
    AgentUnifiedPush.receive(context, JSONObject(staleRunning).toString().toByteArray())
    AgentUnifiedPush.receive(context, JSONObject(other).toString().toByteArray())
    // A is still finished, so only B is working.
    assertEquals("1 working", shownTitle())
  }

  @Test
  fun aCompletionInTheSameMillisecondReplacesThatServersRunningCard() {
    val now = System.currentTimeMillis()
    val running = at(card("a", "running", 1, 0, "Working\tA\tP"), now)
    val completed = at(card("a", "completed", 0, 0, "Done\tA\tP"), now)
    val other = at(card("b", "running", 1, 0, "Working\tB\tQ"), now + 1_000)
    AgentUnifiedPush.receive(context, JSONObject(running).toString().toByteArray())
    AgentUnifiedPush.receive(context, JSONObject(completed).toString().toByteArray())
    AgentUnifiedPush.receive(context, JSONObject(other).toString().toByteArray())
    assertEquals("1 working", shownTitle())
  }
}
