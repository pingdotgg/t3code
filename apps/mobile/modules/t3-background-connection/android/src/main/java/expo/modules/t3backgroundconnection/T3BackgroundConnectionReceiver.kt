package expo.modules.t3backgroundconnection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService

class T3BackgroundConnectionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (
      intent?.action != Intent.ACTION_BOOT_COMPLETED &&
      intent?.action != Intent.ACTION_MY_PACKAGE_REPLACED &&
      intent?.action != T3BackgroundConnectionState.RESTART_ACTION
    ) {
      return
    }
    if (!T3BackgroundConnectionState.isEnabled(context)) return

    if (T3BackgroundConnectionController.ensureStarted(context)) {
      // Acquire before returning from the receiver, but only after Android
      // accepted the service launch so a rejected FGS cannot leak the static
      // React Native wake lock.
      HeadlessJsTaskService.acquireWakeLockNow(context)
    }
  }
}
