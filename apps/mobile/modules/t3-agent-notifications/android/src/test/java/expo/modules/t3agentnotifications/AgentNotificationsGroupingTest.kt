package expo.modules.t3agentnotifications

import android.app.Notification
import android.os.Build
import androidx.core.app.NotificationCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 26, 33, 36], manifest = Config.NONE)
class AgentNotificationsGroupingTest : AgentNotificationsFixture() {
  @Test
  fun differentThreadsAndBatchedAlertsShareOneAppWideGroupAndSummary() {
    AgentNotifications.receive(
      context,
      update("thread-a", false) + mapOf(
        "alert_group" to "[\"env\",\"a\"]",
        "alert_title" to "Fix auth",
        "alert_body" to "Done: t3code",
        "alert_path" to "/threads/env/a",
      )
    )
    AgentNotifications.receive(
      context,
      update("thread-b", false) + mapOf(
        "alert_group" to "[\"env\",\"b\"]",
        "alert_title" to "Refactor API",
        "alert_body" to "Approval: web",
        "alert_path" to "/threads/env/b",
      )
    )
    val batch = (update("batch-cd", false) - "alert_group") + mapOf(
      "alert_title" to "2 agents finished",
      "alert_body" to "Thread C, Thread D",
      "alert_path" to "/",
    )
    AgentNotifications.receive(context, batch)

    val children = alertChildren()
    assertEquals(3, children.size)
    assertEquals(setOf("t3-agent-alert"), children.map { it.notification.group }.toSet())
    children.forEach { child ->
      assertTrue(child.notification.flags and Notification.FLAG_AUTO_CANCEL != 0)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        assertEquals(
          NotificationCompat.GROUP_ALERT_CHILDREN,
          NotificationCompat.getGroupAlertBehavior(child.notification)
        )
      }
    }
    assertEquals(
      setOf(
        "t3code-dev://threads/env/a",
        "t3code-dev://threads/env/b",
        "t3code-dev://",
      ),
      children.map { shadowOf(it.notification.contentIntent).savedIntent.dataString }.toSet()
    )

    val summary = alertSummaries().single()
    assertEquals("t3-agent-alert-summary:t3-agent-alert", summary.tag)
    assertEquals(0, summary.id)
    assertEquals("t3-agent-alert", summary.notification.group)
    assertEquals("Agent alerts", summary.notification.extras.getString(Notification.EXTRA_TITLE))
    assertEquals("Agent updates", summary.notification.extras.getString(Notification.EXTRA_TEXT))
    assertNull(summary.notification.contentIntent)
    assertNull(summary.notification.sound)
    assertEquals(0, summary.notification.defaults)
    assertTrue(summary.notification.flags and Notification.FLAG_AUTO_CANCEL != 0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      assertEquals(
        NotificationCompat.GROUP_ALERT_CHILDREN,
        NotificationCompat.getGroupAlertBehavior(summary.notification)
      )
    }
  }

  @Test
  fun mixedSingleAndRepeatedThreadAlertsStayUnderOneSummary() {
    AgentNotifications.receive(
      context,
      update("single-a", false) + mapOf(
        "alert_group" to "[\"env\",\"a\"]",
        "alert_title" to "Thread A",
        "alert_path" to "/threads/env/a",
      )
    )
    AgentNotifications.receive(
      context,
      update("single-b", false) + mapOf(
        "alert_group" to "[\"env\",\"b\"]",
        "alert_title" to "Thread B",
        "alert_path" to "/threads/env/b",
      )
    )
    AgentNotifications.receive(
      context,
      update("repeat-c-1", false) + mapOf(
        "alert_group" to "[\"env\",\"c\"]",
        "alert_title" to "Thread C",
        "alert_path" to "/threads/env/c",
      )
    )
    AgentNotifications.receive(
      context,
      update("repeat-c-2", false) + mapOf(
        "alert_group" to "[\"env\",\"c\"]",
        "alert_title" to "Thread C",
        "alert_path" to "/threads/env/c",
      )
    )

    assertEquals(1, alertSummaries().size)
    assertEquals(
      setOf("t3-agent-alert"),
      manager.activeNotifications.map { it.notification.group }.toSet()
    )
    assertEquals(
      setOf(
        "t3code-dev://threads/env/a",
        "t3code-dev://threads/env/b",
        "t3code-dev://threads/env/c",
      ),
      alertChildren()
        .map { shadowOf(it.notification.contentIntent).savedIntent.dataString }
        .toSet()
    )
  }

  @Test
  fun ongoingActivityRemainsOutsideTheAppWideAlertGroup() {
    AgentNotifications.receive(
      context,
      update("thread-a", true) + mapOf(
        "alert_group" to "[\"env\",\"a\"]",
        "alert_path" to "/threads/env/a",
      )
    )
    AgentNotifications.receive(
      context,
      update("thread-b", true) + mapOf(
        "alert_group" to "[\"env\",\"b\"]",
        "alert_path" to "/threads/env/b",
      )
    )

    val activity = manager.activeNotifications.single { it.tag == "t3-agent-activity" }
    assertNotEquals("t3-agent-alert", activity.notification.group)
    assertEquals(2, alertChildren().size)
    assertEquals(1, alertSummaries().size)
  }

  @Test
  fun clearRemovesCurrentAndLegacyPerThreadSummaries() {
    val legacyChild = NotificationCompat.Builder(context, "agent-alerts")
      .setSmallIcon(R.drawable.agent_activity_mark)
      .setContentTitle("Old thread")
      .setContentText("Done: Legacy")
      .setGroup("[\"env\",\"legacy\"]")
      .build()
    val legacySummary = NotificationCompat.Builder(context, "agent-alerts")
      .setSmallIcon(R.drawable.agent_activity_mark)
      .setContentTitle("Old thread")
      .setGroup("[\"env\",\"legacy\"]")
      .setGroupSummary(true)
      .build()
    manager.notify("t3-agent-alert", "legacy-id".hashCode(), legacyChild)
    manager.notify("t3-agent-alert-summary:[\"env\",\"legacy\"]", 0, legacySummary)

    AgentNotifications.receive(
      context,
      update("new-thread", false) + mapOf(
        "alert_group" to "[\"env\",\"new\"]",
        "alert_title" to "New thread",
        "alert_body" to "Done: Current",
        "alert_path" to "/threads/env/new",
      )
    )

    assertEquals(
      1,
      manager.activeNotifications.count { it.tag == "t3-agent-alert-summary:t3-agent-alert" }
    )

    AgentNotifications.clear(context)
    assertTrue(manager.activeNotifications.isEmpty())
  }
}
