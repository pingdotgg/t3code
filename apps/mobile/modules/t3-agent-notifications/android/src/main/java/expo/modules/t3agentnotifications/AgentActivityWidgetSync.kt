package expo.modules.t3agentnotifications

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/**
 * Repaints the Agent Activity home screen widget from a relay push, so it stays current
 * while the app is closed. The app's foreground refresh still overwrites these props with
 * the full snapshot; this only keeps the widget from sitting on "Out of date" in between.
 */
internal object AgentActivityWidgetSync {
  private const val WIDGET = "AgentActivity"
  private const val WIDGET_STORE = "expo.modules.widgets"
  private const val PROPS_KEY = "__expo_widgets_${WIDGET}_props"
  private const val PUSH_AT_KEY = "t3_agent_activity_push_at"
  // Pushes arrive only on changes; match the relay's running-row TTL (and the app's
  // AGENT_ACTIVITY_ANDROID_WIDGET_STALE_AFTER_MS) instead of flagging quiet agents.
  private const val STALE_AFTER_MS = 2 * 60 * 60 * 1000L
  private const val EXPIRY_RECEIVER = "expo.modules.t3widgetexpiry.WidgetExpiryReceiver"
  private const val EXPIRY_NAME = "expo.modules.t3widgetexpiry.NAME"
  private const val EXPIRY_DEADLINES = "expo.modules.t3widgetexpiry.DEADLINES"

  fun update(context: Context, data: Map<String, String>, updatedAt: Long) {
    val store = context.applicationContext.getSharedPreferences(WIDGET_STORE, Context.MODE_PRIVATE)
    // FCM can deliver out of order; an older push must not replace newer rows.
    if (updatedAt <= store.getLong(PUSH_AT_KEY, 0)) return
    val rows = activityRows(data)
    val path = data["activity_path"].orEmpty()
    val updated = iso(updatedAt)
    val current = JSONArray()
    val stale = JSONArray()
    var inFlight = false
    rows.forEachIndexed { index, row ->
      val phase = widgetPhase(ActivityPhase.forStatus(row.status))
      val finished = phase == "completed" || phase == "failed"
      if (!finished) inFlight = true
      fun json(phase: String, status: String) = JSONObject()
        .put("environmentId", "push")
        .put("threadId", index.toString())
        .put("projectTitle", row.project)
        .put("threadTitle", row.title)
        .put("modelTitle", "")
        .put("phase", phase)
        .put("status", status)
        .put("updatedAt", updated)
        .put("deepLink", if (index == 0) path else "")
      current.put(json(phase, row.status))
      stale.put(if (finished) json(phase, row.status) else json("stale", "Out of date"))
    }
    val staleAt = updatedAt + STALE_AFTER_MS
    val props = JSONObject()
      .put("title", data["activity_title"].orEmpty())
      .put("subtitle", if (rows.isEmpty()) "No active agents" else "")
      .put("activeCount", data["activity_active_count"]?.toIntOrNull() ?: 0)
      .put("updatedAt", updated)
      .put("activities", current)
    if (inFlight) props.put("stale", JSONObject().put("at", staleAt).put("activities", stale))
    store.edit().putString(PROPS_KEY, props.toString()).putLong(PUSH_AT_KEY, updatedAt).commit()

    // The expiry receiver repaints now and sets the alarm that swaps in the stale rows.
    context.sendBroadcast(
      Intent().setComponent(ComponentName(context.packageName, EXPIRY_RECEIVER))
        .putExtra(EXPIRY_NAME, WIDGET)
        .putExtra(EXPIRY_DEADLINES, if (inFlight) longArrayOf(staleAt) else LongArray(0))
    )
  }

  private fun widgetPhase(phase: ActivityPhase?) = when (phase) {
    ActivityPhase.STARTING -> "starting"
    ActivityPhase.APPROVAL -> "waiting_for_approval"
    ActivityPhase.INPUT -> "waiting_for_input"
    ActivityPhase.STALE -> "stale"
    ActivityPhase.COMPLETED -> "completed"
    ActivityPhase.FAILED -> "failed"
    ActivityPhase.RUNNING, null -> "running"
  }

  private fun iso(millis: Long) =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
      .apply { timeZone = TimeZone.getTimeZone("UTC") }
      .format(Date(millis))
}
