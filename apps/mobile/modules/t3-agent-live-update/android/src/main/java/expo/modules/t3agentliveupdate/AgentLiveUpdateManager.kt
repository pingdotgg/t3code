package expo.modules.t3agentliveupdate

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

internal class AgentLiveUpdateManager(private val context: Context) {
  private val notificationManager = context.getSystemService(NotificationManager::class.java)
  private val notificationManagerCompat = NotificationManagerCompat.from(context)

  fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

    val channel = NotificationChannel(
      CHANNEL_ID,
      "Agent live updates",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Ongoing status for active T3 Code agents"
      enableVibration(false)
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      setShowBadge(false)
      setSound(null, null)
    }
    notificationManager.createNotificationChannel(channel)
  }

  fun show(snapshot: LiveUpdateSnapshot): Map<String, Any> {
    ensureChannel()
    checkNotificationPermission()

    val title = snapshot.title.trim().ifEmpty { "T3 Code agents" }.take(MAX_TITLE_LENGTH)
    val summary = snapshot.summary.trim().ifEmpty { "Agent activity is in progress" }
    val expandedText = snapshot.lines
      .asSequence()
      .map(String::trim)
      .filter(String::isNotEmpty)
      .take(MAX_VISIBLE_LINES)
      .joinToString("\n")
      .ifEmpty { summary }

    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.t3_agent_live_update)
      .setContentTitle(title)
      .setContentText(summary)
      .setStyle(NotificationCompat.BigTextStyle().bigText(expandedText))
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .setAutoCancel(false)
      .setOnlyAlertOnce(true)
      .setColorized(false)
      .setRequestPromotedOngoing(true)
      .setWhen(System.currentTimeMillis())
      .setShowWhen(true)
      .setDeleteIntent(dismissPendingIntent())
      .addAction(
        NotificationCompat.Action.Builder(
          0,
          "Stop",
          dismissPendingIntent(),
        ).build(),
      )

    contentPendingIntent()?.let(builder::setContentIntent)
    snapshot.shortCriticalText
      .trim()
      .take(MAX_SHORT_CRITICAL_TEXT_LENGTH)
      .takeIf(String::isNotEmpty)
      ?.let(builder::setShortCriticalText)

    val notification = builder.build()
    notificationManagerCompat.notify(NOTIFICATION_TAG, NOTIFICATION_ID, notification)
    return status()
  }

  fun cancel(): Map<String, Any> {
    notificationManagerCompat.cancel(NOTIFICATION_TAG, NOTIFICATION_ID)
    return status(null)
  }

  fun status(): Map<String, Any> = status(activeNotification())

  fun openPromotionSettings(): Map<String, Any> {
    val promotionIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
      Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
    } else {
      appNotificationSettingsIntent()
    }
    promotionIntent
      .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    try {
      context.startActivity(promotionIntent)
    } catch (_: ActivityNotFoundException) {
      context.startActivity(appNotificationSettingsIntent())
    }
    return status()
  }

  private fun status(notification: Notification?): Map<String, Any> {
    val supportsPromotion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA
    val promotable = supportsPromotion && notification?.hasPromotableCharacteristics() == true
    val promoted = supportsPromotion &&
      notification != null &&
      notification.flags.and(Notification.FLAG_PROMOTED_ONGOING) != 0
    val channelImportance = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notificationManager.getNotificationChannel(CHANNEL_ID)?.importance
        ?: NotificationManager.IMPORTANCE_UNSPECIFIED
    } else {
      NotificationManager.IMPORTANCE_UNSPECIFIED
    }

    return mapOf(
      "apiLevel" to Build.VERSION.SDK_INT,
      "supportsPromotion" to supportsPromotion,
      "notificationsEnabled" to notificationManagerCompat.areNotificationsEnabled(),
      "canPostPromotedNotifications" to (
        supportsPromotion && notificationManagerCompat.canPostPromotedNotifications()
        ),
      "channelImportance" to channelImportance,
      "active" to (notification != null),
      "promotable" to promotable,
      "promoted" to promoted,
    )
  }

  private fun activeNotification(): Notification? = notificationManagerCompat.activeNotifications
    .firstOrNull { it.tag == NOTIFICATION_TAG && it.id == NOTIFICATION_ID }
    ?.notification

  private fun checkNotificationPermission() {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      throw SecurityException("Notification permission is required to show an agent Live Update.")
    }
  }

  private fun dismissPendingIntent(): PendingIntent {
    val intent = Intent(context, AgentLiveUpdateDismissReceiver::class.java).apply {
      action = ACTION_DISMISS
    }
    return PendingIntent.getBroadcast(
      context,
      DISMISS_REQUEST_CODE,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun contentPendingIntent(): PendingIntent? {
    val intent =
      context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      CONTENT_REQUEST_CODE,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun appNotificationSettingsIntent(): Intent =
    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
      .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  private companion object {
    const val CHANNEL_ID = "t3_agent_live_updates"
    const val NOTIFICATION_TAG = "t3-agent-live-update"
    const val NOTIFICATION_ID = 44_001
    const val ACTION_DISMISS = "com.t3tools.agentliveupdate.action.DISMISS"
    const val DISMISS_REQUEST_CODE = 44_002
    const val CONTENT_REQUEST_CODE = 44_003
    const val MAX_VISIBLE_LINES = 3
    const val MAX_TITLE_LENGTH = 80
    const val MAX_SHORT_CRITICAL_TEXT_LENGTH = 7
  }
}
