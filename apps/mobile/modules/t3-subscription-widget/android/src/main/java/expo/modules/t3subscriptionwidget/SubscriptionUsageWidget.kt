package expo.modules.t3subscriptionwidget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
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
      // The receiver is disabled below 12L (values-v32/bools.xml), but the module still calls in.
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S_V2) return
      val saved = context.getSharedPreferences(PREFERENCES, 0).getString("snapshot", null)
      val snapshot = runCatching { JSONObject(saved.orEmpty()) }.getOrNull()
      val openApp = openAppIntent(context, id, snapshot)
      val providers = snapshot?.optJSONArray("providers")
      val now = System.currentTimeMillis()
      var nextExpiry = Long.MAX_VALUE
      val groups = (0 until (providers?.length() ?: 0)).mapNotNull { index ->
        val provider = providers?.optJSONObject(index) ?: return@mapNotNull null
        val windows = provider.optJSONArray("windows")
        val expiresAt = provider.optLong("expiresAt")
        if (expiresAt > now && windows != null && windows.length() > 0) {
          nextExpiry = minOf(nextExpiry, expiresAt)
          (0 until windows.length()).map { provider to windows.optJSONObject(it) }
        } else {
          listOf(provider to null)
        }
      }
      // Keep the first quota from each provider near the top of the list.
      val rows = (0 until (groups.maxOfOrNull { it.size } ?: 0)).flatMap { index ->
        groups.mapNotNull { it.getOrNull(index) }
      }
      val views = RemoteViews(context.packageName, R.layout.t3_subscription_widget)
      // Count limits only; "Open app to refresh" placeholders are not entries.
      val limits = rows.count { (_, window) -> window != null }
      // Without limits the layout's plain title stays.
      if (limits > 0) {
        views.setTextViewText(
          R.id.t3_widget_title,
          context.getString(R.string.t3_subscription_widget_title_count, limits)
        )
        views.setContentDescription(
          R.id.t3_widget_title,
          context.resources.getQuantityString(
            R.plurals.t3_subscription_widget_title_description,
            limits,
            limits
          )
        )
      }
      openApp?.let { views.setOnClickPendingIntent(R.id.t3_widget_root, it) }
      openAppIntent(context, id, snapshot, forCollection = true)?.let {
        views.setPendingIntentTemplate(R.id.t3_widget_rows, it)
      }
      val items = RemoteViews.RemoteCollectionItems.Builder()
      rows.forEachIndexed { index, (provider, window) ->
        items.addItem(index.toLong(), rowView(context, provider, window))
      }
      views.setRemoteAdapter(R.id.t3_widget_rows, items.build())
      views.setEmptyView(R.id.t3_widget_rows, R.id.t3_widget_empty)
      val checkedAt = snapshot?.optLong("checkedAt") ?: 0
      val checked = if (checkedAt > 0) {
        val formatted = DateFormat.getDateTimeInstance(
          DateFormat.SHORT,
          DateFormat.SHORT
        ).format(Date(checkedAt))
        context.getString(R.string.t3_subscription_widget_last_checked, formatted)
      } else {
        context.getString(R.string.t3_subscription_widget_unknown_check)
      }
      views.setTextViewText(R.id.t3_widget_footer, checked)
      val alarms = context.getSystemService(AlarmManager::class.java)
      alarms.cancel(expiryIntent(context))
      // Inexact and non-wakeup: the timestamp remains visible if Android delays expiry.
      if (nextExpiry != Long.MAX_VALUE) {
        alarms.set(AlarmManager.RTC, nextExpiry, expiryIntent(context))
      }
      manager.updateAppWidget(id, views)
    }

    private fun openAppIntent(
      context: Context,
      id: Int,
      snapshot: JSONObject?,
      forCollection: Boolean = false
    ): PendingIntent? {
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
        id * 2 + if (forCollection) 1 else 0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or if (forCollection) {
          // Collection rows use fill-in intents with an explicit app target.
          PendingIntent.FLAG_MUTABLE
        } else {
          PendingIntent.FLAG_IMMUTABLE
        }
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
      child.setOnClickFillInIntent(R.id.t3_widget_row, Intent())
      child.setContentDescription(
        R.id.t3_widget_row,
        "$label. $windowLabel. $percent. $reset. $detail"
      )
      return child
    }
  }
}
