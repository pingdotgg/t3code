package expo.modules.t3agentnotifications

import android.app.NotificationChannel
import android.app.Notification
import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

class AgentMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (remoteMessage.data["t3_kind"] == "agent_activity") {
      AgentNotifications.receive(this, remoteMessage.data)
    } else {
      super.onMessageReceived(remoteMessage)
    }
  }
}

class AgentActivityDismissReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    AgentNotifications.dismiss(context)
  }
}

class AgentActivityExpiryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    AgentNotifications.expire(context)
  }
}

/** Handles data pushes natively so delivery does not depend on a running JS bridge. */
object AgentNotifications {
  private const val STORE = "t3-agent-notifications"
  private const val ACTIVITY_CHANNEL = "agent-activity"
  private const val ALERT_CHANNEL = "agent-alerts"
  private const val ACTIVITY_TAG = "t3-agent-activity"
  private const val ALERT_TAG = "t3-agent-alert"
  private const val ACTIVITY_ID = 73001
  private const val MAX_MESSAGE_AGE_MS = 10 * 60 * 1000L
  private const val RUNNING_LIFETIME_MS = 2 * 60 * 60 * 1000L
  private const val MAX_LIFETIME_MS = 24 * 60 * 60 * 1000L

  @Synchronized
  fun configure(
    context: Context,
    deviceId: String,
    userId: String,
    scheme: String,
    ongoingEnabled: Boolean
  ) {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    // JS identity is empty on a cold start. Compare the durable identity here
    // so reopening preserves cards, dismissal and replay history for this user.
    if (prefs.getString("userId", null) != userId ||
      prefs.getString("deviceId", null) != deviceId
    ) {
      clear(context)
    }
    val wasEnabled = prefs.getBoolean("ongoing", false)
    prefs.edit().putString(
      "deviceId",
      deviceId
    ).putString("userId", userId).putString("scheme", scheme)
      .putBoolean("enabled", true).putBoolean("ongoing", ongoingEnabled).apply()
    if (ongoingEnabled && !wasEnabled) prefs.edit().putBoolean("dismissed", false).apply()
    if (!ongoingEnabled) cancelActivity(context)
    channels(context)
  }

  @Synchronized
  fun clear(context: Context) {
    cancelActivity(context)
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().clear().apply()
    val manager = manager(context)
    manager.activeNotifications.filter { it.tag == ACTIVITY_TAG || it.tag == ALERT_TAG }
      .forEach { manager.cancel(it.tag, it.id) }
  }

  @Synchronized
  fun dismiss(context: Context) {
    context.getSharedPreferences(
      STORE,
      Context.MODE_PRIVATE
    ).edit().putBoolean("dismissed", true).apply()
    cancelActivity(context)
  }

  @Synchronized
  fun expire(context: Context, now: Long = System.currentTimeMillis()) {
    val expiresAt = context.getSharedPreferences(
      STORE,
      Context.MODE_PRIVATE
    ).getLong("expiresAt", 0)
    // An already-dispatched alarm must not remove a newer run's card.
    if (expiresAt > 0 && expiresAt <= now) cancelActivity(context)
  }

  @Synchronized
  fun receive(context: Context, data: Map<String, String>) {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    val updatedAt = data["updated_at"]?.toLongOrNull() ?: return
    val registered = prefs.getBoolean("enabled", false) &&
      data["device_id"] == prefs.getString("deviceId", null) &&
      data["user_id"] == prefs.getString("userId", null)
    val fresh = System.currentTimeMillis() - updatedAt in -MAX_MESSAGE_AGE_MS..MAX_MESSAGE_AGE_MS
    if (registered && fresh && NotificationManagerCompat.from(context).areNotificationsEnabled()) {
      channels(context)
      val scheme = prefs.getString("scheme", "t3code") ?: "t3code"
      showAlert(context, prefs, scheme, data)
      updateActivity(context, prefs, scheme, data, updatedAt)
    }
  }

  private fun showAlert(
    context: Context,
    prefs: SharedPreferences,
    scheme: String,
    data: Map<String, String>
  ) {
    // Queue retries carry the same alert id. Keep a bounded history even when
    // notification A is retried after notification B has already arrived.
    val alertId = data["alert_id"]
    val seen = prefs.getString("seenAlertsOrdered", null)?.split('\n')
      ?: prefs.getStringSet("seenAlerts", emptySet()).orEmpty().toList()
    if (alertId != null && alertId !in seen) {
      // Match iOS foreground presentation. Consume suppressed alerts as well,
      // so a delivery retry cannot surface them after the app backgrounds.
      if (!ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
        val title = data["alert_title"].orEmpty().take(120)
        // Grouped alerts list up to five 120-character thread titles.
        val body = data["alert_body"].orEmpty().take(608)
        val id = alertId.hashCode()
        val notification = base(context, ALERT_CHANNEL)
          .setContentTitle(title).setContentText(body)
          .setStyle(NotificationCompat.BigTextStyle().bigText(body))
          .setAutoCancel(true)
          .setContentIntent(contentIntent(context, scheme, data["alert_path"], id))
          .build()
        manager(context).notify(ALERT_TAG, id, notification)
      }
      prefs.edit().remove("seenAlerts").putString(
        "seenAlertsOrdered",
        (seen.takeLast(63) + alertId).joinToString("\n")
      ).apply()
    }
  }

  private fun updateActivity(
    context: Context,
    prefs: SharedPreferences,
    scheme: String,
    data: Map<String, String>,
    updatedAt: Long
  ) {
    // Ignore reordered status updates without dropping an unrelated alert.
    if (updatedAt < prefs.getLong("lastUpdate", 0)) return
    prefs.edit().putLong("lastUpdate", updatedAt).apply()
    val active = data["active"] == "true"
    // Use absolute state expiry: a replay must not extend a finished card or
    // make an abandoned host look active indefinitely. Older relays omit it.
    val expiresAt = data["activity_expires_at"]?.toLongOrNull()
      ?: if (active) updatedAt + RUNNING_LIFETIME_MS else 0L
    val remainingMs = (expiresAt - System.currentTimeMillis()).coerceAtMost(MAX_LIFETIME_MS)
    val wasActive = prefs.getBoolean("lastActive", false)
    prefs.edit().putBoolean("lastActive", active).apply()
    if (remainingMs <= 0 || !prefs.getBoolean("ongoing", false)) {
      cancelActivity(context)
      prefs.edit().putBoolean("dismissed", false).apply()
      return
    }
    // Dismissing a run includes its finished card. A new run, or toggling
    // activity off/on, arms it again; terminal replays stay dismissed.
    if (active && !wasActive) prefs.edit().putBoolean("dismissed", false).apply()
    if (!prefs.getBoolean("dismissed", false)) {
      showActivity(context, scheme, data, active, remainingMs)
    }
  }

  private fun showActivity(
    context: Context,
    scheme: String,
    data: Map<String, String>,
    active: Boolean,
    remainingMs: Long
  ) {
    val dismissIntent = PendingIntent.getBroadcast(
      context,
      ACTIVITY_ID,
      Intent(context, AgentActivityDismissReceiver::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val presentation = ActivityPresentation(data, active)
    val openThread = contentIntent(context, scheme, data["activity_path"], ACTIVITY_ID)
    val builder = base(context, ACTIVITY_CHANNEL)
      .setOngoing(active).setOnlyAlertOnce(true).setSilent(true)
      .setTimeoutAfter(remainingMs)
      // Live Updates must remain uncolorized to qualify for promotion.
      .setColorized(false)
      .setRequestPromotedOngoing(active)
      .setShortCriticalText(presentation.chip)
      .setContentIntent(openThread)
      .setDeleteIntent(dismissIntent)
    presentation.applyTo(builder, context)
    // A finished card is no longer ongoing, so it swipes away and a tap opens
    // the thread; buttons would only repeat that.
    val action = presentation.action
    if (action != null) {
      if (openThread != null) builder.addAction(0, action, openThread)
      builder.addAction(0, "Dismiss", dismissIntent)
    }
    manager(context).notify(ACTIVITY_TAG, ACTIVITY_ID, builder.build())
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      // Notification timeouts were added in API 26. One inexact alarm also
      // expires cards on Android 7, including when the app process has exited.
      // No exact-alarm permission, foreground service or periodic work needed.
      val expiresAt = System.currentTimeMillis() + remainingMs
      context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit()
        .putLong("expiresAt", expiresAt).apply()
      context.getSystemService(
        AlarmManager::class.java
      ).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, expiresAt, expiryIntent(context))
    }
  }

  private fun expiryIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
    context,
    ACTIVITY_ID,
    Intent(context, AgentActivityExpiryReceiver::class.java),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
  )

  private fun cancelActivity(context: Context) {
    manager(context).cancel(ACTIVITY_TAG, ACTIVITY_ID)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      context.getSystemService(AlarmManager::class.java).cancel(expiryIntent(context))
      context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().remove("expiresAt").apply()
    }
  }

  private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

  private fun channels(context: Context) {
    if (Build.VERSION.SDK_INT >= 26) {
      manager(context).createNotificationChannels(
        listOf(
          NotificationChannel(ALERT_CHANNEL, "Agent alerts", NotificationManager.IMPORTANCE_HIGH),
          NotificationChannel(
            ACTIVITY_CHANNEL,
            "Ongoing agent activity",
            NotificationManager.IMPORTANCE_LOW
          ),
        )
      )
    }
  }

  private fun base(context: Context, channel: String): NotificationCompat.Builder {
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return NotificationCompat.Builder(context, channel)
      .setPriority(
        if (channel ==
          ALERT_CHANNEL
        ) {
          NotificationCompat.PRIORITY_HIGH
        } else {
          NotificationCompat.PRIORITY_LOW
        }
      )
      .setDefaults(if (channel == ALERT_CHANNEL) Notification.DEFAULT_ALL else 0)
      .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_dialog_info)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setShowWhen(false)
  }

  private fun contentIntent(
    context: Context,
    scheme: String,
    path: String?,
    id: Int
  ): PendingIntent? {
    val threadPath = path?.takeIf { it.startsWith("/threads/") }
    val route = threadPath?.takeUnless { it.contains('?') || it.contains('#') } ?: "/"
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: return null
    intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse("$scheme:/$route"))
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}
