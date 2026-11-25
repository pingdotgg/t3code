package expo.modules.t3agentnotifications

import android.app.Notification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 26, 33, 36], manifest = Config.NONE)
class AgentNotificationsThreadIdentityTest : AgentNotificationsFixture() {
  @Test
  fun repeatedThreadAlertsReplaceOneNotificationAndClear() {
    AgentNotifications.receive(context, update("first", false) + ("alert_group" to "thread-group"))
    AgentNotifications.receive(
      context,
      update("second", false) + mapOf(
        "alert_group" to "thread-group",
        "alert_title" to "Renamed thread",
        "alert_body" to "Failed: Test project",
      )
    )

    val alert = manager.activeNotifications.single().notification
    assertEquals("thread-group", alert.group)
    assertEquals("Renamed thread", alert.extras.getString(Notification.EXTRA_TITLE))
    val text = alert.extras.getCharSequence(Notification.EXTRA_TEXT).toString()
    assertEquals("Failed: Test project", text)

    AgentNotifications.clear(context)
    assertTrue(manager.activeNotifications.isEmpty())
  }

  @Test
  fun olderThreadAlertDoesNotReplaceNewerOne() {
    val now = System.currentTimeMillis()
    AgentNotifications.receive(
      context,
      update("newer", false) + mapOf(
        "alert_updated_at" to (now + 2000).toString(),
        "alert_body" to "Failed: Test project",
      )
    )
    AgentNotifications.receive(
      context,
      update("older", false) + mapOf(
        "alert_updated_at" to (now + 1000).toString(),
        "alert_body" to "Done: Test project",
      )
    )

    val alerts = manager.activeNotifications.filter { it.tag.startsWith("t3-agent-alert") }
    val alert = alerts.single().notification
    val text = alert.extras.getCharSequence(Notification.EXTRA_TEXT).toString()
    assertEquals("Failed: Test project", text)
  }

  @Test
  fun keyedAlertDoesNotBlockAnUnkeyedOne() {
    AgentNotifications.receive(
      context,
      update("keyed", false) + mapOf(
        "alert_updated_at" to (System.currentTimeMillis() + 2000).toString(),
        "alert_body" to "Failed: Test project",
      )
    )
    AgentNotifications.receive(context, update("unkeyed", false))

    val alerts = manager.activeNotifications.filter { it.tag.startsWith("t3-agent-alert") }
    val alert = alerts.single().notification
    val text = alert.extras.getCharSequence(Notification.EXTRA_TEXT).toString()
    assertEquals("Done: Test project", text)
  }

  @Test
  fun differentThreadsWithCollidingHashesKeepTheirOwnAlerts() {
    val groups = listOf("environment/Aa", "environment/BB")
    assertEquals(groups[0].hashCode(), groups[1].hashCode())
    for (group in groups) {
      AgentNotifications.receive(context, update(group, false) + ("alert_group" to group))
    }

    assertEquals(
      groups.map { "t3-agent-alert-thread:$it" }.toSet(),
      manager.activeNotifications.map { it.tag }.toSet()
    )
    assertEquals(2, manager.activeNotifications.size)
  }

  @Test
  fun differentThreadsKeepTheirOwnAlerts() {
    AgentNotifications.receive(context, update("first", false) + ("alert_group" to "environment/a"))
    AgentNotifications.receive(
      context,
      update("second", false) + ("alert_group" to "environment/b")
    )

    assertEquals(
      setOf("environment/a", "environment/b"),
      manager.activeNotifications.map { it.notification.group }.toSet()
    )
    assertEquals(2, manager.activeNotifications.size)
  }
}
