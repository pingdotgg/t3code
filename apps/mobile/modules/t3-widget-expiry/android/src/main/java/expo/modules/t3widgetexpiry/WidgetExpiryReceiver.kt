package expo.modules.t3widgetexpiry

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/**
 * The generated expo-widgets provider re-runs the stored JS layout on ACTION_APPWIDGET_UPDATE,
 * so an expiry broadcast works even while the app is closed.
 */
class WidgetExpiryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
      val stored = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      for ((name, value) in stored.all) {
        val deadlines = (value as? String)?.split(',')?.mapNotNull { it.toLongOrNull() }
          ?.toLongArray() ?: continue
        refresh(context, name)
        schedule(context, name, deadlines)
      }
      return
    }
    val name = intent.getStringExtra(EXTRA_NAME) ?: return
    val remaining = intent.getLongArrayExtra(EXTRA_DEADLINES) ?: LongArray(0)
    refresh(context, name)
    schedule(context, name, remaining)
  }

  private fun refresh(context: Context, name: String) {
    val provider = providerComponent(context, name)
    val ids = AppWidgetManager.getInstance(context).getAppWidgetIds(provider)
    if (ids.isNotEmpty()) {
      context.sendBroadcast(
        Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
          .setComponent(provider)
          .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
      )
    }
  }

  companion object {
    private const val EXTRA_NAME = "expo.modules.t3widgetexpiry.NAME"
    private const val EXTRA_DEADLINES = "expo.modules.t3widgetexpiry.DEADLINES"
    private const val PREFERENCES = "expo.modules.t3widgetexpiry.DEADLINES"

    fun schedule(context: Context, name: String, deadlines: LongArray) {
      val alarms = context.getSystemService(AlarmManager::class.java)
      val now = System.currentTimeMillis()
      val pending = deadlines.filter { it > now }.sorted()
      val stored = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
      if (pending.isEmpty()) {
        stored.remove(name)
      } else {
        stored.putString(name, pending.joinToString(","))
      }
      stored.apply()
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
