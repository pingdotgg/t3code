package expo.modules.t3subscriptionwidget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

class SubscriptionUsageWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { update(context, manager, it) }
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == EXPIRE) updateAll(context)
  }

  override fun onDisabled(context: Context) {
    context.getSystemService(AlarmManager::class.java).cancel(expiryIntent(context))
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle
  ) {
    update(context, manager, id)
  }

  companion object {
    const val PREFERENCES = "t3_subscription_widget"
    private const val EXPIRE = "expo.modules.t3subscriptionwidget.EXPIRE"

    private fun expiryIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
      context,
      0,
      Intent(context, SubscriptionUsageWidget::class.java).setAction(EXPIRE),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      manager.getAppWidgetIds(ComponentName(context, SubscriptionUsageWidget::class.java))
        .forEach { update(context, manager, it) }
    }

    private fun update(context: Context, manager: AppWidgetManager, id: Int) {
      val saved = context.getSharedPreferences(PREFERENCES, 0).getString("snapshot", null)
      val snapshot = runCatching { JSONObject(saved.orEmpty()) }.getOrNull()
      val views = RemoteViews(context.packageName, R.layout.t3_subscription_widget)
      openAppIntent(context, id, snapshot)?.let {
        views.setOnClickPendingIntent(R.id.t3_widget_root, it)
      }
      val providers = snapshot?.optJSONArray("providers")
      val now = System.currentTimeMillis()
      var nextExpiry = Long.MAX_VALUE
      var totalRows = 0
      val groups = (0 until (providers?.length() ?: 0)).mapNotNull { index ->
        val provider = providers?.optJSONObject(index) ?: return@mapNotNull null
        val windows = provider.optJSONArray("windows")
        val expiresAt = provider.optLong("expiresAt")
        if (expiresAt > now && windows != null && windows.length() > 0) {
          nextExpiry = minOf(nextExpiry, expiresAt)
          totalRows += provider.optInt("totalWindows", windows.length())
          (0 until windows.length()).map { provider to windows.optJSONObject(it) }
        } else {
          totalRows++
          listOf(provider to null)
        }
      }
      // Show each provider before filling spare space with its other windows.
      val rows = (0 until (groups.maxOfOrNull { it.size } ?: 0)).flatMap { index ->
        groups.mapNotNull { it.getOrNull(index) }
      }
      if (rows.isNotEmpty()) {
        views.removeAllViews(R.id.t3_widget_rows)
        val options = manager.getAppWidgetOptions(id)
        val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180)
        val count = ((height - 64) / 66).coerceIn(1, 12).coerceAtMost(rows.size)
        for ((provider, window) in rows.take(count)) {
          views.addView(R.id.t3_widget_rows, rowView(context, provider, window))
        }
        val remaining = totalRows - count
        val checkedAt = snapshot?.optLong("checkedAt") ?: 0
        val formatted = DateFormat.getDateTimeInstance(
          DateFormat.SHORT,
          DateFormat.SHORT
        ).format(Date(checkedAt))
        val more = if (remaining > 0) {
          context.getString(R.string.t3_subscription_widget_more, remaining)
        } else {
          ""
        }
        val checked = if (checkedAt > 0) {
          context.getString(R.string.t3_subscription_widget_as_of, formatted)
        } else {
          context.getString(R.string.t3_subscription_widget_unknown_check)
        }
        views.setTextViewText(R.id.t3_widget_footer, checked + more)
      }
      val alarms = context.getSystemService(AlarmManager::class.java)
      alarms.cancel(expiryIntent(context))
      // Inexact and non-wakeup: the timestamp remains visible if Android delays expiry.
      if (nextExpiry != Long.MAX_VALUE) {
        alarms.set(AlarmManager.RTC, nextExpiry, expiryIntent(context))
      }
      manager.updateAppWidget(id, views)
    }

    private fun openAppIntent(context: Context, id: Int, snapshot: JSONObject?): PendingIntent? {
      // Target this variant's launcher so co-installed builds cannot steal the tap.
      val intent =
        context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      intent.action = Intent.ACTION_VIEW
      val deepLink = snapshot?.optString("url")?.takeIf { it.isNotBlank() }
        ?: "t3code://settings/usage?tab=limits"
      intent.data = Uri.parse(deepLink)
      intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      return PendingIntent.getActivity(
        context,
        id,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }

    private fun rowView(context: Context, provider: JSONObject, window: JSONObject?): RemoteViews {
      val child = RemoteViews(context.packageName, R.layout.t3_subscription_widget_row)
      val remaining = window?.optInt("remaining")?.coerceIn(0, 100)
      val detail = provider.optString("detail")
      val label = provider.optString("name")
      val windowLabel = window?.optString("label") ?: detail
      child.setTextViewText(R.id.t3_widget_label, label)
      child.setTextViewText(R.id.t3_widget_window, windowLabel)
      val percent = remaining?.let {
        context.getString(R.string.t3_subscription_widget_remaining, it)
      } ?: "—"
      child.setTextViewText(R.id.t3_widget_percent, percent)
      val visibility = if (remaining == null) View.GONE else View.VISIBLE
      child.setViewVisibility(R.id.t3_widget_progress, visibility)
      if (remaining != null) child.setProgressBar(R.id.t3_widget_progress, 100, remaining, false)
      val reset = window?.optString("reset")
        ?: context.getString(R.string.t3_subscription_widget_refresh)
      child.setTextViewText(R.id.t3_widget_reset, reset)
      child.setContentDescription(
        R.id.t3_widget_row,
        "$label. $windowLabel. $percent. $reset. $detail"
      )
      return child
    }
  }
}
