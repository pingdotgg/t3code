package expo.modules.t3agentnotifications

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val backgroundIdle = Runnable { sendEvent("onBackgroundIdle", mapOf<String, Any?>()) }

  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")

    Function("configure") {
        deviceId: String,
        userId: String,
        scheme: String,
        ongoingEnabled: Boolean
      ->
      appContext.reactContext?.let {
        AgentNotifications.configure(it, deviceId, userId, scheme, ongoingEnabled)
      }
    }

    Function("clear") {
      appContext.reactContext?.let { AgentNotifications.clear(it) }
    }

    Events("onUnifiedPushState", "onBackgroundIdle")

    // React Native stops JS timers while the activity is paused, so the delay that closes
    // server connections in the background has to run here.
    OnActivityEntersBackground {
      mainHandler.removeCallbacks(backgroundIdle)
      mainHandler.postDelayed(backgroundIdle, BACKGROUND_IDLE_AFTER_MS)
    }

    OnActivityEntersForeground { mainHandler.removeCallbacks(backgroundIdle) }

    OnCreate {
      AgentUnifiedPush.onChange =
        { sendEvent("onUnifiedPushState", mapOf<String, Any?>()) }
    }

    OnDestroy {
      AgentUnifiedPush.onChange = null
      mainHandler.removeCallbacks(backgroundIdle)
    }

    Function("unifiedPushState") {
      appContext.reactContext?.let { AgentUnifiedPush.state(it) }
    }

    Function("unifiedPushEnable") {
      appContext.reactContext?.let { AgentUnifiedPush.enable(it, appContext.currentActivity) }
        ?: "none"
    }

    Function("unifiedPushDisable") {
      appContext.reactContext?.let { AgentUnifiedPush.disable(it) }
    }

    Function("showShowcaseActivity") { scheme: String, data: Map<String, String> ->
      appContext.reactContext?.let { AgentNotifications.showcase(it, scheme, data) }
    }

    Function("setThreadOnScreen") { path: String? ->
      AgentNotifications.setThreadOnScreen(path)
    }

    Function("openLiveUpdateSettings") {
      val context = appContext.reactContext
      if (context == null || Build.VERSION.SDK_INT < 36) {
        false
      } else {
        try {
          context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
              .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }
  }
}

// Long enough that a quick trip to another app keeps the live session.
private const val BACKGROUND_IDLE_AFTER_MS = 30_000L
