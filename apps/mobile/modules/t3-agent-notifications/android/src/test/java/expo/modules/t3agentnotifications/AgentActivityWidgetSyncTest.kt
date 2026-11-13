package expo.modules.t3agentnotifications

import android.content.Context
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 36], manifest = Config.NONE)
class AgentActivityWidgetSyncTest : AgentNotificationsFixture() {
  private fun widgetStore() = context.getSharedPreferences("expo.modules.widgets", Context.MODE_PRIVATE)

  private fun props() =
    JSONObject(requireNotNull(widgetStore().getString("__expo_widgets_AgentActivity_props", null)))

  private fun push(updatedAt: Long, vararg lines: String) = mapOf(
    "device_id" to "device",
    "user_id" to "user",
    "updated_at" to updatedAt.toString(),
    "activity_title" to "2 active agents",
    "activity_active_count" to "2",
    "activity_path" to "/threads/env/first",
  ) + lines.mapIndexed { index, line -> "activity_line_$index" to line }

  @Test
  fun pushRepaintsTheWidget() {
    val now = System.currentTimeMillis()

    AgentNotifications.receive(
      context,
      push(now, "Approval\tShip it\tweb", "Working\tRefactor\tapi", "Done\tDocs\tweb")
    )

    val props = props()
    assertEquals(2, props.getInt("activeCount"))
    val rows = props.getJSONArray("activities")
    assertEquals(
      listOf("waiting_for_approval", "running", "completed"),
      (0 until rows.length()).map { rows.getJSONObject(it).getString("phase") }
    )
    assertEquals("Refactor", rows.getJSONObject(1).getString("threadTitle"))
    assertEquals("/threads/env/first", rows.getJSONObject(0).getString("deepLink"))
    val stale = props.getJSONObject("stale")
    assertEquals(now + 2 * 60 * 60 * 1000L, stale.getLong("at"))
    assertEquals(
      listOf("Out of date", "Out of date", "Done"),
      (0 until 3).map { stale.getJSONArray("activities").getJSONObject(it).getString("status") }
    )
    val broadcast = shadowOf(context).broadcastIntents.last()
    assertEquals("expo.modules.t3widgetexpiry.WidgetExpiryReceiver", broadcast.component?.className)
    assertEquals("AgentActivity", broadcast.getStringExtra("expo.modules.t3widgetexpiry.NAME"))
  }

  @Test
  fun anOlderPushDoesNotReplaceNewerRows() {
    val now = System.currentTimeMillis()
    AgentNotifications.receive(context, push(now, "Done\tNewer\tweb"))
    AgentNotifications.receive(context, push(now - 1000, "Working\tOlder\tweb"))

    val props = props()
    assertEquals("Newer", props.getJSONArray("activities").getJSONObject(0).getString("threadTitle"))
    assertFalse(props.has("stale"))
  }
}
