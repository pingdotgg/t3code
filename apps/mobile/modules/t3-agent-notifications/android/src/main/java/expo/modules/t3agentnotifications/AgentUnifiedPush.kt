package expo.modules.t3agentnotifications

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
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
 * Receives the relay-shaped agent payload over UnifiedPush from a self-run watcher and
 * hands it to the same presentation the FCM path uses.
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

  fun receive(context: Context, content: ByteArray) {
    val data = decode(content)?.takeIf { it["t3_kind"] == "agent_activity" } ?: return
    prefs(context).edit().putLong("lastMessageAt", System.currentTimeMillis()).apply()
    AgentNotifications.receive(context, data)
    onChange?.invoke()
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
        .setContentText("Copy the push config in Notifications settings and update the watcher.")
        .setAutoCancel(true)
        .build()
    )
  }
}
