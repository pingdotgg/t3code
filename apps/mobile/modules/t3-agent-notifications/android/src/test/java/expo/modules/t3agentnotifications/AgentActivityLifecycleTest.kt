package expo.modules.t3agentnotifications

import android.app.Activity
import android.app.AlarmManager
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 26, 33, 36], manifest = Config.NONE)
class AgentActivityLifecycleTest {
  private lateinit var context: Application
  private lateinit var manager: NotificationManager
  private lateinit var lifecycle: LifecycleRegistry

  @Before
  fun setUp() {
    context = RuntimeEnvironment.getApplication()
    manager = context.getSystemService(NotificationManager::class.java)
    shadowOf(manager).setNotificationsEnabled(true)
    lifecycle = ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry
    lifecycle.currentState = Lifecycle.State.CREATED

    val launcher = ComponentName(context, Activity::class.java)
    shadowOf(context.packageManager).addActivityIfNotPresent(launcher)
    shadowOf(context.packageManager).addIntentFilterForActivity(
      launcher,
      IntentFilter(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_LAUNCHER)
      }
    )
    AgentNotifications.clear(context)
    AgentNotifications.configure(context, "device", "user", "t3code-dev", true)
    AgentNotifications.setThreadOnScreen("/threads/environment/thread")
  }

  private fun update(alertId: String, active: Boolean) = mapOf(
    "device_id" to "device",
    "user_id" to "user",
    "updated_at" to System.currentTimeMillis().toString(),
    "active" to active.toString(),
    "activity_title" to "1 active agent",
    "activity_body" to "Test thread · Working",
    "activity_path" to "/threads/environment/thread",
    "alert_id" to alertId,
    "alert_group" to "environment/thread",
    "alert_title" to "Test thread",
    "alert_body" to "Done: Test project",
    "alert_path" to "/threads/environment/thread",
  )

  @Test
  fun retainedUnreadResultHasNoTimeoutAndReadingItClearsTheCard() {
    lifecycle.currentState = Lifecycle.State.RESUMED
    AgentNotifications.receive(
      context,
      update("done", true) + mapOf(
        "activity_phase" to "completed",
        "activity_expires_at" to "0",
      )
    )
    val card = manager.activeNotifications.single().notification
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) assertEquals(0L, card.timeoutAfter)
    assertTrue(
      shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.isEmpty()
    )
    AgentNotifications.expire(context, System.currentTimeMillis() + 24 * 60 * 60 * 1000L)
    assertEquals(1, manager.activeNotifications.size)
    AgentNotifications.receive(
      context,
      update("done-read", false) + mapOf(
        "activity_expires_at" to "0",
      )
    )
    assertEquals(0, manager.activeNotifications.size)
  }

  @Test
  fun waitingThreadsShowTheirCountInsteadOfZeroWorking() {
    lifecycle.currentState = Lifecycle.State.RESUMED
    val data = update("waiting-only", true) + mapOf(
      "activity_line_0" to "Input\tChoose a model\tProject",
      "activity_line_1" to "Input\tChoose an icon\tProject",
      "activity_phase" to "waiting_for_input",
      "activity_active_count" to "2",
      "activity_attention_count" to "2",
      "activity_working_count" to "0",
      "activity_total_count" to "2",
    )
    AgentNotifications.receive(context, data)
    val card = manager.activeNotifications.single().notification
    assertEquals("Project · 2 threads", card.extras.getString(Notification.EXTRA_SUB_TEXT))
  }
}
