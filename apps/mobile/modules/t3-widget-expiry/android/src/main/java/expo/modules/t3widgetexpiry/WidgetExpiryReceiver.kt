package expo.modules.t3widgetexpiry

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/**
 * Re-renders an expo-widgets widget when a snapshot deadline passes while the app is closed.
 * The generated `<package>.<name>Provider` receiver re-runs the JS layout with the stored
 * snapshot on ACTION_APPWIDGET_UPDATE, so a deadline only needs to deliver that broadcast.
 */
class WidgetExpiryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val name = intent.getStringExtra(EXTRA_NAME) ?: return
    val remaining = intent.getLongArrayExtra(EXTRA_DEADLINES) ?: LongArray(0)
    val provider = providerComponent(context, name)
    val ids = AppWidgetManager.getInstance(context).getAppWidgetIds(provider)
    if (ids.isNotEmpty()) {
      context.sendBroadcast(
        Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
          .setComponent(provider)
          .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
      )
    }
    schedule(context, name, remaining)
  }

  companion object {
    private const val EXTRA_NAME = "expo.modules.t3widgetexpiry.NAME"
    private const val EXTRA_DEADLINES = "expo.modules.t3widgetexpiry.DEADLINES"

    /** Arms one inexact, non-wakeup alarm for the next future deadline and carries the rest. */
    fun schedule(context: Context, name: String, deadlines: LongArray) {
      val alarms = context.getSystemService(AlarmManager::class.java)
      val now = System.currentTimeMillis()
      val pending = deadlines.filter { it > now }.sorted()
      val intent = Intent(context, WidgetExpiryReceiver::class.java)
        .setAction("expo.modules.t3widgetexpiry.EXPIRE.$name")
        .putExtra(EXTRA_NAME, name)
        .putExtra(EXTRA_DEADLINES, pending.drop(1).toLongArray())
      val operation = PendingIntent.getBroadcast(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      alarms.cancel(operation)
      val next = pending.firstOrNull() ?: return
      alarms.set(AlarmManager.RTC, next, operation)
    }

    // Mirrors expo-widgets' widgetProviderComponentName for the generated provider class.
    private fun providerComponent(context: Context, name: String) =
      ComponentName(context.packageName, "${context.packageName}.${name}Provider")
  }
}
