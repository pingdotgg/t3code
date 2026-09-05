package expo.modules.t3subscriptionwidget

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

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    update(context, manager, id)
  }

  companion object {
    const val PREFERENCES = "t3_subscription_widget"

    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      manager.getAppWidgetIds(ComponentName(context, SubscriptionUsageWidget::class.java))
        .forEach { update(context, manager, it) }
    }

    private fun update(context: Context, manager: AppWidgetManager, id: Int) {
      val saved = context.getSharedPreferences(PREFERENCES, 0).getString("snapshot", null)
      val snapshot = try { saved?.let { JSONObject(it) } } catch (_: Exception) { null }
      val views = RemoteViews(context.packageName, R.layout.t3_subscription_widget)
      // Explicitly target this variant's launcher so co-installed builds cannot steal the tap.
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse(snapshot?.optString("deepLink")?.takeIf { it.isNotBlank() }
          ?: "t3code://settings/usage?tab=limits")
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
      if (intent != null) {
        views.setOnClickPendingIntent(R.id.t3_widget_root, PendingIntent.getActivity(
          context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      }
      val rows = snapshot?.optJSONArray("rows")
      if (rows != null && rows.length() > 0) {
        views.removeAllViews(R.id.t3_widget_rows)
        val height = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180)
        val count = ((height - 64) / 66).coerceIn(1, 8).coerceAtMost(rows.length())
        var oldest = Long.MAX_VALUE
        for (index in 0 until count) {
          val row = rows.optJSONObject(index) ?: continue
          val child = RemoteViews(context.packageName, R.layout.t3_subscription_widget_row)
          val used = if (row.isNull("usedPercent")) null else row.optInt("usedPercent").coerceIn(0, 100)
          child.setTextViewText(R.id.t3_widget_label, row.optString("label"))
          child.setTextViewText(R.id.t3_widget_window, row.optString("window"))
          child.setTextViewText(R.id.t3_widget_percent, used?.let { context.getString(R.string.t3_subscription_widget_used, it) } ?: "—")
          child.setViewVisibility(R.id.t3_widget_progress, if (used == null) View.GONE else View.VISIBLE)
          if (used != null) child.setProgressBar(R.id.t3_widget_progress, 100, used, false)
          child.setTextViewText(R.id.t3_widget_reset,
            if (row.optLong("expiresAt") <= System.currentTimeMillis()) context.getString(R.string.t3_subscription_widget_refresh)
            else row.optString("resetLabel"))
          oldest = minOf(oldest, row.optLong("checkedAt"))
          views.addView(R.id.t3_widget_rows, child)
        }
        val remaining = (snapshot?.optInt("totalRows", rows.length()) ?: rows.length()) - count
        val formatted = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(oldest))
        views.setTextViewText(R.id.t3_widget_footer, context.getString(R.string.t3_subscription_widget_as_of, formatted) +
          if (remaining > 0) context.getString(R.string.t3_subscription_widget_more, remaining) else "")
      }
      manager.updateAppWidget(id, views)
    }
  }
}
