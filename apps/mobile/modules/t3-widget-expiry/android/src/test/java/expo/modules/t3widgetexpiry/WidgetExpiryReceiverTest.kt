package expo.modules.t3widgetexpiry

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 36], manifest = Config.NONE)
class WidgetExpiryReceiverTest {
  @Test
  fun bootRestoresTheNextAlarmFromPersistedDeadlines() {
    val context = RuntimeEnvironment.getApplication()
    val alarms = context.getSystemService(AlarmManager::class.java)
    val deadlines = longArrayOf(
      System.currentTimeMillis() + 60000,
      System.currentTimeMillis() + 120000
    )
    WidgetExpiryReceiver.schedule(context, "SubscriptionUsage", deadlines)
    val scheduled = shadowOf(alarms).scheduledAlarms.single()
    alarms.cancel(requireNotNull(scheduled.operation))
    assertTrue(shadowOf(alarms).scheduledAlarms.isEmpty())

    WidgetExpiryReceiver().onReceive(context, Intent(Intent.ACTION_BOOT_COMPLETED))

    assertEquals(deadlines[0], shadowOf(alarms).scheduledAlarms.single().triggerAtTime)
  }

  @Test
  fun bootDoesNotRestoreCancelledDeadlines() {
    val context = RuntimeEnvironment.getApplication()
    WidgetExpiryReceiver.schedule(
      context,
      "SubscriptionUsage",
      longArrayOf(System.currentTimeMillis() + 60000)
    )
    WidgetExpiryReceiver.schedule(context, "SubscriptionUsage", longArrayOf())

    WidgetExpiryReceiver().onReceive(context, Intent(Intent.ACTION_BOOT_COMPLETED))

    assertTrue(
      shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.isEmpty()
    )
    assertTrue(
      context.getSharedPreferences(
        "expo.modules.t3widgetexpiry.DEADLINES",
        Context.MODE_PRIVATE
      ).all.isEmpty()
    )
  }
}
