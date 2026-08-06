package expo.modules.t3backgroundconnection

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class T3BackgroundConnectionService : HeadlessJsTaskService() {
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onCreate() {
    super.onCreate()
    T3BackgroundConnectionState.initialize(this)
    startInForeground()
    T3BackgroundConnectionState.markServiceRunning(true)
    acquireWifiLock()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!T3BackgroundConnectionState.isEnabled(this)) {
      stopSelf(startId)
      return Service.START_NOT_STICKY
    }

    if (T3BackgroundConnectionState.claimTask()) {
      super.onStartCommand(intent, flags, startId)
    }
    return Service.START_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(
      T3BackgroundConnectionState.TASK_NAME,
      Arguments.createMap(),
      0,
      true,
    )

  override fun onHeadlessJsTaskFinish(taskId: Int) {
    val shouldRestart = T3BackgroundConnectionState.isEnabled(this)
    T3BackgroundConnectionState.releaseTask()
    super.onHeadlessJsTaskFinish(taskId)
    if (shouldRestart) {
      T3BackgroundConnectionState.scheduleRestartAfterUnexpectedTaskFinish(this)
    }
  }

  override fun onDestroy() {
    releaseWifiLock()
    T3BackgroundConnectionState.markServiceRunning(false)
    super.onDestroy()
  }

  private fun startInForeground() {
    createNotificationChannel()
    val notification = createNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      NOTIFICATION_CHANNEL_ID,
      "Background connection",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Keeps T3 Code connected while the app is in the background"
      setSound(null, null)
      enableLights(false)
      enableVibration(false)
      setShowBadge(false)
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun createNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val smallIcon = resources.getIdentifier("notification_icon", "drawable", packageName)
      .takeIf { it != 0 }
      ?: android.R.drawable.stat_notify_sync_noanim

    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }.apply {
      setContentTitle("T3 Code")
      setContentText("Connected in background")
      setSmallIcon(smallIcon)
      setOngoing(true)
      setOnlyAlertOnce(true)
      setShowWhen(false)
      setCategory(Notification.CATEGORY_SERVICE)
      setVisibility(Notification.VISIBILITY_PRIVATE)
      contentIntent?.let(::setContentIntent)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        @Suppress("DEPRECATION")
        setPriority(Notification.PRIORITY_LOW)
        @Suppress("DEPRECATION")
        setSound(null)
      }
    }.build()
  }

  @SuppressLint("WakelockTimeout")
  @Suppress("DEPRECATION")
  private fun acquireWifiLock() {
    try {
      val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      wifiLock = wifiManager.createWifiLock(
        WifiManager.WIFI_MODE_FULL_HIGH_PERF,
        "$packageName:t3-background-connection",
      ).apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (_: RuntimeException) {
      // The lock is best-effort. The foreground task and connection supervisor
      // remain authoritative on devices that reject or do not expose it.
      wifiLock = null
    }
  }

  private fun releaseWifiLock() {
    try {
      wifiLock?.takeIf { it.isHeld }?.release()
    } catch (_: RuntimeException) {
      // The system may already have released the lock during process teardown.
    } finally {
      wifiLock = null
    }
  }

  private companion object {
    const val NOTIFICATION_CHANNEL_ID = "t3code_background_connection"
    const val NOTIFICATION_ID = 0x7433
  }
}
