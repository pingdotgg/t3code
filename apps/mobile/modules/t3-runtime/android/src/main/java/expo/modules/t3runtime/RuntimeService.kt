package expo.modules.t3runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder

class RuntimeService : Service() {
  private var explicitStop = false
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() {
    super.onCreate()
    val notifications = getSystemService(NotificationManager::class.java)
    notifications.createNotificationChannel(NotificationChannel("t3mobile-runtime", "Coding agents", NotificationManager.IMPORTANCE_LOW))
    val stop = PendingIntent.getService(this, 1, Intent(this, RuntimeService::class.java).setAction("stop"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification = Notification.Builder(this, "t3mobile-runtime")
      .setContentTitle("T3 Mobile runtime")
      .setContentText("Local coding agents are available")
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build())
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      notification.setContentIntent(PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
    startForeground(87, notification.build())
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "stop") {
      explicitStop = true
      Thread { RuntimeManager.get(this).stop(); stopSelfResult(startId) }.start()
    } else explicitStop = false
    return START_NOT_STICKY
  }
  override fun onDestroy() {
    if (!explicitStop) RuntimeManager.get(applicationContext).stopAsync()
    super.onDestroy()
  }
}
