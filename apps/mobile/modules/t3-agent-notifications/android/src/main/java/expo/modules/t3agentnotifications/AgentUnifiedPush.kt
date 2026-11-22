package expo.modules.t3agentnotifications

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONException
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PublicKeySet
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

class AgentUnifiedPushService : PushService() {
  override fun onMessage(message: PushMessage, instance: String) =
    AgentUnifiedPush.receive(this, message.content)

  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) =
    AgentUnifiedPush.endpointChanged(this, endpoint.url, endpoint.pubKeySet)

  override fun onRegistrationFailed(reason: FailedReason, instance: String) =
    AgentUnifiedPush.registrationFailed(this, reason.name)

  override fun onUnregistered(instance: String) = AgentUnifiedPush.unregistered(this)
}

/**
 * Receives the relay-shaped agent payload that each paired T3 server pushes over UnifiedPush
 * and hands it to the same presentation the FCM path uses.
 */
object AgentUnifiedPush {
  private const val STORE = "t3-unified-push"
  private const val STATUS_CHANNEL = "agent-push-status"
  private const val STATUS_ID = 73002
  private const val MAX_MESSAGE_BYTES = 8192

  @Volatile var onChange: (() -> Unit)? = null

  fun decode(content: ByteArray): Map<String, String>? {
    if (content.size > MAX_MESSAGE_BYTES) return null
    return try {
      val json = JSONObject(String(content, Charsets.UTF_8))
      json.keys().asSequence().associateWith { json.optString(it) }
    } catch (_: JSONException) {
      null
    }
  }

  @Synchronized
  fun receive(context: Context, content: ByteArray) {
    val data = decode(content)?.takeIf { it["t3_kind"] == "agent_activity" } ?: return
    val updatedAt = acceptedAt(context, data) ?: return
    val now = System.currentTimeMillis()
    val prefs = prefs(context)
    // Each server pushes its own card, but the phone has one card slot, so the latest card
    // from every server is kept and merged. A server's older card never replaces a newer one;
    // one from the same millisecond does, since the server sends them in order.
    val stored = storedCards(prefs, now)
    val key = data["source"]?.let { "$SOURCE_PREFIX$it" }
    val newer = key != null &&
      (stored[key]?.get("updated_at")?.toLongOrNull() ?: Long.MIN_VALUE) <= updatedAt
    val cards = if (newer && key != null) stored + (key to data) else stored
    val edit = prefs.edit().putLong("lastMessageAt", now)
    prefs.all.keys.filter { it.startsWith(SOURCE_PREFIX) && it !in cards }.forEach(edit::remove)
    if (newer) edit.putString(key, JSONObject(data).toString())
    edit.apply()
    AgentNotifications.receive(context, mergeCards(data, cards.values))
    onChange?.invoke()
  }

  /** The message's time, or null for one the presentation would reject, so it is never stored. */
  private fun acceptedAt(context: Context, data: Map<String, String>): Long? {
    val updatedAt = data["updated_at"]?.toLongOrNull()
    val identity = context.getSharedPreferences("t3-agent-notifications", Context.MODE_PRIVATE)
    val fresh = updatedAt != null &&
      System.currentTimeMillis() - updatedAt in -MAX_MESSAGE_AGE_MS..MAX_MESSAGE_AGE_MS
    val ours = data["device_id"] == identity.getString("deviceId", null) &&
      data["user_id"] == identity.getString("userId", null)
    return updatedAt.takeIf { fresh && ours }
  }

  private fun storedCards(prefs: SharedPreferences, now: Long) =
    prefs.all.filterKeys { it.startsWith(SOURCE_PREFIX) }
      .mapNotNull { (key, value) ->
        (value as? String)?.let { decode(it.toByteArray()) }?.let { key to it }
      }
      .toMap()
      .filterValues { (it["activity_expires_at"]?.toLongOrNull() ?: 0) > now }

  private const val MAX_MESSAGE_AGE_MS = 10 * 60 * 1000L
  private const val SOURCE_PREFIX = "source:"
  private val activityKeys = listOf(
    "active", "activity_chip", "activity_title", "activity_phase", "activity_active_count",
    "activity_attention_count", "activity_body", "activity_path", "activity_expires_at"
  )

  private fun phasePriority(phase: String?) = when (phase) {
    "waiting_for_approval", "waiting_for_input" -> 0
    "failed" -> 1
    "starting", "running" -> 2
    else -> 3
  }

  /**
   * Combines one card per server into the single card the presentation draws. The incoming
   * message's alert always passes through, and the result carries the newest timestamp of its
   * parts, so a server whose message arrives late is never rejected as out of order.
   */
  fun mergeCards(
    incoming: Map<String, String>,
    cards: Collection<Map<String, String>>
  ): Map<String, String> {
    val alert = incoming.filterKeys { it.startsWith("alert_") }
    val newest = (cards + listOf(incoming)).maxOf { it["updated_at"]?.toLongOrNull() ?: 0 }
    val card = when (cards.size) {
      0 -> incoming
      1 -> cards.single()
      else -> mergeActivity(incoming, cards)
    }
    return card.filterKeys { !it.startsWith("alert_") } + alert +
      ("updated_at" to newest.toString())
  }

  private fun mergeActivity(
    incoming: Map<String, String>,
    cards: Collection<Map<String, String>>
  ): Map<String, String> {
    val sorted = cards.sortedBy { phasePriority(it["activity_phase"]) }
    val hero = sorted.first()
    val active = cards.sumOf { it["activity_active_count"]?.toIntOrNull() ?: 0 }
    val attention = cards.sumOf { it["activity_attention_count"]?.toIntOrNull() ?: 0 }
    val lines = sorted.flatMap { card -> (0..4).mapNotNull { card["activity_line_$it"] } }.take(5)
    val title = when {
      active > 0 -> "$active active agent${if (active == 1) "" else "s"}" +
        if (attention > 0) " · $attention need${if (attention == 1) "s" else ""} attention" else ""
      cards.any { it["activity_phase"] == "failed" } -> "Agent work failed"
      else -> "Agent work completed"
    }
    return incoming.filterKeys { it !in activityKeys && !it.startsWith("activity_line_") } +
      lines.mapIndexed { index, line -> "activity_line_$index" to line } +
      mapOf(
        "active" to (active > 0).toString(),
        "activity_chip" to if (active == 0) {
          ""
        } else if (attention > 0) {
          "Review"
        } else {
          "Active"
        },
        "activity_title" to title,
        "activity_phase" to hero["activity_phase"].orEmpty(),
        "activity_active_count" to active.toString(),
        "activity_attention_count" to attention.toString(),
        "activity_body" to hero["activity_body"].orEmpty(),
        "activity_path" to (hero["activity_path"] ?: "/"),
        "activity_expires_at" to
          cards.maxOf { it["activity_expires_at"]?.toLongOrNull() ?: 0 }.toString()
      )
  }

  /** Returns `registering`, `picking` (the system chooser is open) or `none`. */
  fun enable(context: Context, activity: Activity?): String {
    val external = UnifiedPush.getDistributors(context).filter { it != context.packageName }
    val chosen = UnifiedPush.getSavedDistributor(context) ?: external.singleOrNull()
    return when {
      chosen != null -> {
        register(context, chosen)
        "registering"
      }
      external.isEmpty() || activity == null -> "none"
      else -> {
        UnifiedPush.tryPickDistributor(activity) { picked ->
          if (picked) UnifiedPush.getSavedDistributor(context)?.let { register(context, it) }
        }
        "picking"
      }
    }
  }

  private fun register(context: Context, distributor: String) {
    UnifiedPush.saveDistributor(context, distributor)
    prefs(context).edit().putBoolean("enabled", true).remove("failure").apply()
    UnifiedPush.register(context, messageForDistributor = "T3 Code agent alerts")
    onChange?.invoke()
  }

  fun disable(context: Context) {
    UnifiedPush.unregister(context)
    prefs(context).edit().clear().apply()
    onChange?.invoke()
  }

  fun endpointChanged(context: Context, url: String, keys: PublicKeySet?) {
    val prefs = prefs(context)
    val previous = prefs.getString("endpoint", null)
    val previousAuth = prefs.getString("auth", null)
    prefs.edit().putString("endpoint", url).putString("p256dh", keys?.pubKey)
      .putString("auth", keys?.auth).remove("failure").apply()
    // The watcher posts to the endpoint and keys it was given, so new ones silence it until updated.
    if (previous != null && (previous != url || previousAuth != keys?.auth)) {
      noticeEndpointChanged(context)
    }
    onChange?.invoke()
  }

  fun registrationFailed(context: Context, reason: String) {
    prefs(context).edit().putString("failure", reason).apply()
    onChange?.invoke()
  }

  fun unregistered(context: Context) {
    prefs(context).edit().remove("endpoint").remove("p256dh").remove("auth").apply()
    onChange?.invoke()
  }

  fun state(context: Context): Map<String, Any?> {
    val prefs = prefs(context)
    val external = UnifiedPush.getDistributors(context).filter { it != context.packageName }
    return mapOf(
      "available" to external.isNotEmpty(),
      "distributor" to UnifiedPush.getSavedDistributor(context)?.let { label(context, it) },
      "enabled" to prefs.getBoolean("enabled", false),
      "endpoint" to prefs.getString("endpoint", null),
      "keys" to prefs.getString("auth", null)?.let { auth ->
        mapOf("p256dh" to prefs.getString("p256dh", null), "auth" to auth)
      },
      "failure" to prefs.getString("failure", null),
      "lastMessageAt" to prefs.getLong("lastMessageAt", 0).takeIf { it > 0 },
      // The device id the servers address pushes to, set by AgentNotifications.configure.
      "deviceId" to context.getSharedPreferences("t3-agent-notifications", Context.MODE_PRIVATE)
        .getString("deviceId", null),
    )
  }

  private fun label(context: Context, packageName: String): String = try {
    val info = context.packageManager.getApplicationInfo(packageName, 0)
    context.packageManager.getApplicationLabel(info).toString()
  } catch (_: PackageManager.NameNotFoundException) {
    packageName
  }

  private fun prefs(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  private fun noticeEndpointChanged(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(
        NotificationChannel(STATUS_CHANNEL, "Push status", NotificationManager.IMPORTANCE_DEFAULT)
      )
    }
    manager.notify(
      STATUS_ID,
      NotificationCompat.Builder(context, STATUS_CHANNEL)
        .setSmallIcon(R.drawable.agent_activity_mark)
        .setContentTitle("T3 Code push endpoint changed")
        .setContentText("Open T3 Code Fork so it can register the new endpoint with your servers.")
        .setAutoCancel(true)
        .build()
    )
  }
}
