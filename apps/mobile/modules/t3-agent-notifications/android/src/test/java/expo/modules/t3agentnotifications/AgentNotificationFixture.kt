package expo.modules.t3agentnotifications

import android.app.Activity
import android.app.Application
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import org.junit.Before
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

abstract class AgentNotificationFixture {
  protected lateinit var context: Application
  protected lateinit var manager: NotificationManager
  protected lateinit var lifecycle: LifecycleRegistry

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
      IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) }
    )
    AgentNotifications.clear(context)
    context.getSharedPreferences(
      "t3-paired-notifications",
      Application.MODE_PRIVATE
    ).edit().clear().apply()
    AgentNotifications.configure(context, "device", "user", "t3code-dev", true)
    AgentNotifications.setThreadOnScreen("/threads/environment/thread")
  }

  protected fun update(alertId: String, active: Boolean): Map<String, String> = mapOf(
    "device_id" to "device", "user_hash" to "60a4ea94a99303630c40fff23f4de5c06a8f978289a3889f31edfac3b89f85d7",
    "updated_at" to System.currentTimeMillis().toString(), "active" to active.toString(),
    "activity_title" to "1 active agent", "activity_body" to "Test thread · Working",
    "activity_path" to "/threads/environment/thread", "alert_id" to alertId,
    "alert_group" to "environment/thread", "alert_title" to "Test thread",
    "alert_body" to "Done: Test project", "alert_path" to "/threads/environment/thread"
  )
}
