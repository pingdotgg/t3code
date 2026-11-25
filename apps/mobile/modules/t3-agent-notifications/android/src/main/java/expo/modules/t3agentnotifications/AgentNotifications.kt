package expo.modules.t3agentnotifications

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
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
import java.security.MessageDigest

class AgentMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (remoteMessage.data["t3_kind"] == "agent_activity") {
      AgentNotifications.receive(this, remoteMessage.data)
    } else if (
      remoteMessage.data["t3_kind"] == "paired_alert" ||
      remoteMessage.data["t3_kind"] == "paired_activity_v1"
    ) {
      AgentNotifications.receivePaired(this, remoteMessage.data)
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
  private const val ACTIVITY_STORE = "t3-agent-activity-presentation"
  private const val ACTIVITY_CHANNEL = "agent-activity"
  private const val ALERT_CHANNEL = "agent-alerts"
  private const val ACTIVITY_TAG = "t3-agent-activity"
  private const val ALERT_TAG = "t3-agent-alert"
  private const val ACTIVITY_ID = 73001
  private const val MAX_MESSAGE_AGE_MS = 10 * 60 * 1000L
  private const val RUNNING_LIFETIME_MS = 2 * 60 * 60 * 1000L
  private const val MAX_LIFETIME_MS = 24 * 60 * 60 * 1000L
  private const val PAIRED_STORE = "t3-paired-notifications"
  private const val PAIRED_TAG = "t3-paired-alert:"

  /** Paired subscriptions are independent of the T3 Connect account lifecycle. */
  @Synchronized
  fun configurePaired(
    context: Context,
    registrationIds: List<String>,
    scheme: String,
    ongoingEnabled: Boolean = true
  ) {
    val prefs = context.getSharedPreferences(PAIRED_STORE, Context.MODE_PRIVATE)
    val wasEnabled = prefs.getBoolean("ongoing", true)
    val previous = prefs.getStringSet("registrations", emptySet()).orEmpty()
    (previous - registrationIds.toSet()).forEach { registration ->
      PairedNotificationKeys.remove(context, registration)
      AgentActivitySnapshots.remove(context, "$PAIRED_TAG$registration")
      context.deleteSharedPreferences("$PAIRED_STORE:$registration")
    }
    prefs
      .edit()
      .putStringSet("registrations", registrationIds.toSet())
      .putString("scheme", scheme)
      .putBoolean("ongoing", ongoingEnabled)
      .apply()
    if (ongoingEnabled && !wasEnabled) {
      context
        .getSharedPreferences(ACTIVITY_STORE, Context.MODE_PRIVATE)
        .edit()
        .putBoolean("dismissed", false)
        .apply()
    }
    manager(context)
      .activeNotifications
      .filter {
        it.tag?.startsWith(PAIRED_TAG) == true &&
          registrationIds.none { registration ->
            it.tag == "$PAIRED_TAG$registration" ||
              it.tag?.startsWith("$PAIRED_TAG$registration-summary:") == true
          }
      }
      .forEach { manager(context).cancel(it.tag, it.id) }
    refreshActivity(context)
  }

  @Synchronized
  fun receivePaired(context: Context, data: Map<String, String>) {
    val prefs = context.getSharedPreferences(PAIRED_STORE, Context.MODE_PRIVATE)
    val registrationId = data["registration_id"] ?: return
    if (registrationId !in prefs.getStringSet("registrations", emptySet()).orEmpty()) return
    if (data["t3_kind"] == "paired_activity_v1") {
      val decoded = PairedNotificationKeys.privateKey(context, registrationId)?.let { key ->
        PairedNotificationCrypto.open(key, data)
      }
      if (decoded != null) receivePairedActivity(context, registrationId, decoded)
    } else {
      receiveLegacyPairedAlert(context, prefs, registrationId, data)
    }
  }

  private fun receiveLegacyPairedAlert(
    context: Context,
    prefs: SharedPreferences,
    registrationId: String,
    data: Map<String, String>
  ) {
    val notificationId = data["notification_id"]
    val updatedAt = data["updated_at"]?.toLongOrNull()
    val body =
      when (data["phase"]) {
        "waiting_for_approval" -> "An agent needs your approval."
        "waiting_for_input" -> "An agent needs your input."
        "completed" -> "An agent finished."
        "failed" -> "An agent failed."
        else -> null
      }
    val seen = prefs.getString("seen", null)?.split('\n').orEmpty()
    if (notificationId == null || updatedAt == null || body == null) return
    if (System.currentTimeMillis() - updatedAt !in -MAX_MESSAGE_AGE_MS..MAX_MESSAGE_AGE_MS ||
      !NotificationManagerCompat.from(context).areNotificationsEnabled() || notificationId in seen
    ) {
      return
    }
    prefs.edit().putString("seen", (seen.takeLast(63) + notificationId).joinToString("\n")).apply()
    channels(context)
    val scheme = prefs.getString("scheme", "t3code") ?: "t3code"
    val id = notificationId.hashCode()
    val notification =
      base(context, ALERT_CHANNEL)
        .setContentTitle("T3 Code")
        .setContentText(body)
        .setAutoCancel(true)
        .setContentIntent(
          contentIntent(context, scheme, "/notifications/$registrationId/$notificationId", id)
        )
        .build()
    manager(context).notify("$PAIRED_TAG$registrationId", id, notification)
  }

  /** Registration and ciphertext checks stay at ingress; presentation is shared with Connect. */
  @Synchronized
  internal fun receivePairedActivity(
    context: Context,
    registrationId: String,
    data: Map<String, String>
  ) {
    val prefs = context.getSharedPreferences(PAIRED_STORE, Context.MODE_PRIVATE)
    val updatedAt = data["updated_at"]?.toLongOrNull() ?: return
    if (
      registrationId !in prefs.getStringSet("registrations", emptySet()).orEmpty() ||
      System.currentTimeMillis() - updatedAt !in -MAX_MESSAGE_AGE_MS..MAX_MESSAGE_AGE_MS ||
      !NotificationManagerCompat.from(context).areNotificationsEnabled()
    ) {
      return
    }
    channels(context)
    val scheme = prefs.getString("scheme", "t3code") ?: "t3code"
    val history =
      context.getSharedPreferences("$PAIRED_STORE:$registrationId", Context.MODE_PRIVATE)
    val source = "$PAIRED_TAG$registrationId"
    val alerted = showAlert(context, history, scheme, data, source)
    AgentActivitySnapshots.update(context, source, data)
    if (alerted) coverTerminal(context, data)
    refreshActivity(context)
  }

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
    if (
      prefs.getString("userId", null) != userId || prefs.getString("deviceId", null) != deviceId
    ) {
      clear(context)
    }
    val wasEnabled = prefs.getBoolean("ongoing", false)
    prefs
      .edit()
      .putString(
        "deviceId",
        deviceId,
      )
      .putString("userId", userId)
      .putString("scheme", scheme)
      .putBoolean("enabled", true)
      .putBoolean("ongoing", ongoingEnabled)
      .apply()
    if (ongoingEnabled && !wasEnabled) {
      context
        .getSharedPreferences(ACTIVITY_STORE, Context.MODE_PRIVATE)
        .edit()
        .putBoolean("dismissed", false)
        .apply()
    }
    refreshActivity(context)
    channels(context)
  }

  @Synchronized
  fun clear(context: Context) {
    cancelActivity(context)
    AgentActivitySnapshots.remove(context, AgentActivitySnapshots.CONNECT)
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().clear().apply()
    if (
      context
        .getSharedPreferences(PAIRED_STORE, Context.MODE_PRIVATE)
        .getStringSet("registrations", emptySet())
        .orEmpty()
        .isEmpty()
    ) {
      context.getSharedPreferences(ACTIVITY_STORE, Context.MODE_PRIVATE).edit().clear().apply()
    }
    val manager = manager(context)
    manager.activeNotifications
      .filter {
        it.tag == ACTIVITY_TAG ||
          it.tag == ALERT_TAG ||
          it.tag?.startsWith("$ALERT_TAG-summary:") == true
      }
      .forEach { manager.cancel(it.tag, it.id) }
    refreshActivity(context)
  }

  @Volatile private var threadOnScreen: String? = null

  fun setThreadOnScreen(path: String?) {
    threadOnScreen = path
  }

  @Synchronized
  fun dismiss(context: Context) {
    context
      .getSharedPreferences(
        ACTIVITY_STORE,
        Context.MODE_PRIVATE,
      )
      .edit()
      .putBoolean("dismissed", true)
      .apply()
    cancelActivity(context)
  }

  @Synchronized
  fun expire(context: Context, now: Long = System.currentTimeMillis()) {
    refreshActivity(context, now)
  }

  @Synchronized
  fun receive(context: Context, data: Map<String, String>) {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    val updatedAt = data["updated_at"]?.toLongOrNull() ?: return
    val deviceId = prefs.getString("deviceId", null)
    val userId = prefs.getString("userId", null)
    val registered = prefs.getBoolean("enabled", false) &&
      deviceId != null && userId != null &&
      data["device_id"] == deviceId &&
      data["user_hash"] == userHash(userId, deviceId)
    val fresh = System.currentTimeMillis() - updatedAt in -MAX_MESSAGE_AGE_MS..MAX_MESSAGE_AGE_MS
    if (registered && fresh && NotificationManagerCompat.from(context).areNotificationsEnabled()) {
      channels(context)
      val scheme = prefs.getString("scheme", "t3code") ?: "t3code"
      val alerted = showAlert(context, prefs, scheme, data)
      AgentActivitySnapshots.update(context, AgentActivitySnapshots.CONNECT, data)
      if (alerted) coverTerminal(context, data)
      refreshActivity(context)
    }
  }

  // The relay sends this hash instead of the account id, which FCM would see.
  private fun userHash(userId: String, deviceId: String): String =
    MessageDigest.getInstance("SHA-256").digest("$userId:$deviceId".toByteArray())
      .joinToString("") { "%02x".format(it) }

  private fun showAlert(
    context: Context,
    prefs: SharedPreferences,
    scheme: String,
    data: Map<String, String>,
    tag: String = ALERT_TAG
  ): Boolean {
    // Queue retries carry the same alert id. Keep a bounded history even when
    // notification A is retried after notification B has already arrived.
    val alertId = data["alert_id"]
    val seen =
      prefs.getString("seenAlertsOrdered", null)?.split('\n')
        ?: prefs.getStringSet("seenAlerts", emptySet()).orEmpty().toList()
    if (alertId != null && alertId !in seen) {
      // Consume suppressed alerts so retries cannot resurface them later.
      val resumed =
        ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
      val visibleThread = threadOnScreen
      val onScreen = resumed && visibleThread != null && data["alert_path"] == visibleThread
      if (!onScreen) {
        postAlert(context, scheme, data, alertId, tag)
      }
      prefs
        .edit()
        .remove("seenAlerts")
        .putString(
          "seenAlertsOrdered",
          (seen.takeLast(63) + alertId).joinToString("\n"),
        )
        .apply()
      // Android drops posts to a blocked channel, so that alert shows nothing.
      return !onScreen && (
        Build.VERSION.SDK_INT < 26 ||
          manager(context).getNotificationChannel(ALERT_CHANNEL)?.importance !=
          NotificationManager.IMPORTANCE_NONE
        )
    }
    return false
  }

  private fun postAlert(
    context: Context,
    scheme: String,
    data: Map<String, String>,
    alertId: String,
    tag: String = ALERT_TAG
  ) {
    val title = data["alert_title"].orEmpty().take(120)
    // Grouped alerts list up to five 120-character thread titles.
    val body = data["alert_body"].orEmpty().take(608)
    val id = alertId.hashCode()
    val group = data["alert_group"]?.takeIf { it.isNotBlank() } ?: tag
    val notification =
      base(context, ALERT_CHANNEL)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setAutoCancel(true)
        .setGroup(group)
        .setContentIntent(contentIntent(context, scheme, data["alert_path"], id))
        .build()
    manager(context).notify(tag, id, notification)
    val children =
      manager(context).activeNotifications.filter {
        it.tag == tag && it.notification.group == group
      }
    if (children.size > 1) {
      val style = NotificationCompat.InboxStyle()
      children.forEach {
        style.addLine(it.notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT))
      }
      val summary =
        base(context, ALERT_CHANNEL)
          .setContentTitle(title)
          .setContentText(body)
          .setStyle(style)
          .setGroup(group)
          .setGroupSummary(true)
          .setSilent(true)
          .setAutoCancel(true)
          .setContentIntent(contentIntent(context, scheme, data["alert_path"], 0))
          .build()
      manager(context).notify("$tag-summary:$group", 0, summary)
    }
  }

  /**
   * Renders a relay-shaped payload without the registration, freshness and foreground checks, for
   * the showcase capture's staged notifications.
   */
  @Synchronized
  fun showcase(context: Context, scheme: String, data: Map<String, String>) {
    channels(context)
    data["alert_id"]?.let { postAlert(context, scheme, data, it) }
    showActivity(context, scheme, data, data["active"] == "true", RUNNING_LIFETIME_MS)
  }

  private fun updateActivity(
    context: Context,
    prefs: SharedPreferences,
    scheme: String,
    data: Map<String, String>,
    updatedAt: Long
  ) {
    // Ingress stores order each source independently before merging them.
    val presentation = context.getSharedPreferences(ACTIVITY_STORE, Context.MODE_PRIVATE)
    val active = data["active"] == "true"
    // Use absolute state expiry: a replay must not extend a finished card or
    // make an abandoned host look active indefinitely. Older relays omit it.
    val expiresAt =
      data["activity_expires_at"]?.toLongOrNull()
        ?: if (active) updatedAt + RUNNING_LIFETIME_MS else 0L
    val remainingMs = (expiresAt - System.currentTimeMillis()).coerceAtMost(MAX_LIFETIME_MS)
    val wasActive = presentation.getBoolean("lastActive", false)
    presentation.edit().putBoolean("lastActive", active).apply()
    val paired = context.getSharedPreferences(PAIRED_STORE, Context.MODE_PRIVATE)
    val ongoing =
      if (paired.getStringSet("registrations", emptySet()).orEmpty().isNotEmpty()) {
        paired.getBoolean("ongoing", true)
      } else {
        prefs.getBoolean("ongoing", false)
      }
    if (remainingMs <= 0 || !ongoing) {
      cancelActivity(context)
      presentation.edit().putBoolean("dismissed", false).apply()
      return
    }
    // Dismissing a run includes its finished card. A new run, or toggling
    // activity off/on, arms it again; terminal replays stay dismissed.
    if (active && !wasActive) presentation.edit().putBoolean("dismissed", false).apply()
    val covered = singleTerminal(data)?.let { it in coveredTerminals(presentation) } == true
    if (presentation.getBoolean("dismissed", false) || covered) {
      cancelActivity(context)
    } else {
      showActivity(context, scheme, data, active, remainingMs)
    }
  }

  private fun refreshActivity(context: Context, now: Long = System.currentTimeMillis()) {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    val paired = context.getSharedPreferences(PAIRED_STORE, Context.MODE_PRIVATE)
    val scheme = paired.getString("scheme", null) ?: prefs.getString("scheme", "t3code") ?: "t3code"
    val data = AgentActivitySnapshots.merged(context, now)
    updateActivity(context, prefs, scheme, data, System.currentTimeMillis())
  }

  /** Identifies a finished one-thread card by its path, phase and absolute expiry. */
  private fun singleTerminal(data: Map<String, String>): String? {
    val phase = data["activity_phase"]
    val finished = phase == "completed" || phase == "failed"
    val single = data.containsKey("activity_line_0") && !data.containsKey("activity_line_1")
    val expiresAt = data["activity_expires_at"]
    return "${data["activity_path"]}\n$phase\n$expiresAt"
      .takeIf { finished && single && expiresAt != null }
  }

  /**
   * Only a one-row card on the alert's own thread is known to show nothing more than the alert.
   * Sources arrive out of order, so every covered finish stays covered until its card expires.
   */
  private fun coverTerminal(
    context: Context,
    data: Map<String, String>,
    now: Long = System.currentTimeMillis()
  ) {
    val terminal =
      singleTerminal(data)?.takeIf { data["alert_path"] == data["activity_path"] } ?: return
    val presentation = context.getSharedPreferences(ACTIVITY_STORE, Context.MODE_PRIVATE)
    val live =
      coveredTerminals(presentation).filter {
        (it.substringAfterLast('\n').toLongOrNull() ?: 0L) > now
      }
    presentation.edit().putStringSet("coveredTerminals", (live + terminal).toSet()).apply()
  }

  private fun coveredTerminals(presentation: SharedPreferences): Set<String> =
    presentation.getStringSet("coveredTerminals", emptySet()).orEmpty()

  private fun showActivity(
    context: Context,
    scheme: String,
    data: Map<String, String>,
    active: Boolean,
    remainingMs: Long
  ) {
    val dismissIntent =
      PendingIntent.getBroadcast(
        context,
        ACTIVITY_ID,
        Intent(context, AgentActivityDismissReceiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val presentation = ActivityPresentation(data, active)
    val openThread = contentIntent(context, scheme, data["activity_path"], ACTIVITY_ID)
    // Retained results still need Android's ongoing flag to remain promoted.
    val ongoing = active || Build.VERSION.SDK_INT >= 36
    val builder = base(context, ACTIVITY_CHANNEL)
      .setOngoing(ongoing).setOnlyAlertOnce(true).setSilent(true)
      .setTimeoutAfter(remainingMs)
      // Live Updates must remain uncolorized to qualify for promotion.
      .setColorized(false)
      .setRequestPromotedOngoing(ongoing)
      .setShortCriticalText(if (ongoing) presentation.chip else null)
      .setContentIntent(openThread)
      .setDeleteIntent(dismissIntent)
    presentation.applyTo(builder, context)
    val action = presentation.action
    if (action != null && openThread != null) builder.addAction(0, action, openThread)
    if (ongoing) builder.addAction(0, "Dismiss", dismissIntent)
    manager(context).notify(ACTIVITY_TAG, ACTIVITY_ID, builder.build())
    val refreshAt = data["activity_refresh_at"]?.toLongOrNull()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || refreshAt != null) {
      // One inexact alarm expires legacy cards or removes a shorter-lived
      // source from a combined card, without a foreground service or polling.
      val expiresAt = refreshAt ?: System.currentTimeMillis() + remainingMs
      context
        .getSharedPreferences(STORE, Context.MODE_PRIVATE)
        .edit()
        .putLong("expiresAt", expiresAt)
        .apply()
      context
        .getSystemService(AlarmManager::class.java)
        .setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, expiresAt, expiryIntent(context))
    } else {
      context.getSystemService(AlarmManager::class.java).cancel(expiryIntent(context))
    }
  }

  private fun expiryIntent(context: Context): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      ACTIVITY_ID,
      Intent(context, AgentActivityExpiryReceiver::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  private fun cancelActivity(context: Context) {
    manager(context).cancel(ACTIVITY_TAG, ACTIVITY_ID)
    context.getSystemService(AlarmManager::class.java).cancel(expiryIntent(context))
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().remove("expiresAt").apply()
  }

  private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

  private fun channels(context: Context) {
    if (Build.VERSION.SDK_INT >= 26) {
      manager(context)
        .createNotificationChannels(
          listOf(
            NotificationChannel(ALERT_CHANNEL, "Agent alerts", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(
              ACTIVITY_CHANNEL,
              "Ongoing agent activity",
              NotificationManager.IMPORTANCE_LOW,
            ),
          )
        )
    }
  }

  private fun base(context: Context, channel: String): NotificationCompat.Builder =
    NotificationCompat.Builder(context, channel)
      .setPriority(
        if (channel == ALERT_CHANNEL) {
          NotificationCompat.PRIORITY_HIGH
        } else {
          NotificationCompat.PRIORITY_LOW
        }
      )
      .setDefaults(if (channel == ALERT_CHANNEL) Notification.DEFAULT_ALL else 0)
      .setSmallIcon(R.drawable.agent_activity_mark)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setShowWhen(false)

  private fun contentIntent(
    context: Context,
    scheme: String,
    path: String?,
    id: Int
  ): PendingIntent? {
    val threadPath = path?.takeIf { it.startsWith("/threads/") || it.startsWith("/notifications/") }
    val route = threadPath?.takeUnless { it.contains('?') || it.contains('#') } ?: "/"
    val intent =
      context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    intent
      .setAction(Intent.ACTION_VIEW)
      .setData(Uri.parse("$scheme:/$route"))
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
