package expo.modules.t3backgroundconnection

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3BackgroundConnectionModule : Module() {
  private val statusListener: (Map<String, Any>) -> Unit = { status ->
    sendEvent(T3BackgroundConnectionState.STATUS_EVENT, status)
  }
  private val stopRequestListener: () -> Unit = {
    sendEvent(T3BackgroundConnectionState.STOP_REQUEST_EVENT)
  }

  override fun definition() = ModuleDefinition {
    Name("T3BackgroundConnection")

    Events(
      T3BackgroundConnectionState.STATUS_EVENT,
      T3BackgroundConnectionState.STOP_REQUEST_EVENT,
    )

    OnCreate {
      val context = applicationContext()
      T3BackgroundConnectionState.initialize(context)
      T3BackgroundConnectionState.addStatusListener(statusListener)
      T3BackgroundConnectionState.addStopRequestListener(stopRequestListener)
    }

    OnDestroy {
      T3BackgroundConnectionState.removeStatusListener(statusListener)
      T3BackgroundConnectionState.removeStopRequestListener(stopRequestListener)
    }

    OnActivityEntersForeground {
      // The battery-optimization request has no result callback. Refreshing on
      // resume makes the settings status reflect the user's choice immediately.
      val context = applicationContext()
      if (T3BackgroundConnectionState.shouldEnsureStartedOnActivityForeground(context)) {
        // A visible Activity is an allowed foreground-service start context.
        // A successful start also cancels any pending recovery alarm.
        T3BackgroundConnectionController.ensureStarted(context)
      }
      T3BackgroundConnectionState.refreshStatus()
    }

    Function("getStatus") {
      T3BackgroundConnectionState.status(applicationContext())
    }

    AsyncFunction("setEnabled") { enabled: Boolean ->
      val context = applicationContext()
      T3BackgroundConnectionState.setEnabled(context, enabled)
      if (enabled) {
        T3BackgroundConnectionController.ensureStarted(context)
      } else {
        T3BackgroundConnectionState.requestOrderlyStop(context)
      }
      T3BackgroundConnectionState.status(context)
    }.runOnQueue(Queues.MAIN)

    Function("ensureStarted") {
      val context = applicationContext()
      T3BackgroundConnectionController.ensureStarted(context)
      T3BackgroundConnectionState.status(context)
    }

    AsyncFunction("requestBatteryOptimizationExemption") {
      val context = applicationContext()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val intent = Intent(
          Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
          Uri.parse("package:${context.packageName}"),
        )
        val activity = appContext.currentActivity
        if (activity != null) {
          activity.startActivity(intent)
        } else {
          context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
      }
      T3BackgroundConnectionState.status(context)
    }.runOnQueue(Queues.MAIN)

    Function("setRuntimeReady") { ready: Boolean ->
      val context = applicationContext()
      T3BackgroundConnectionState.markRuntimeReady(ready)
      T3BackgroundConnectionState.status(context)
    }

    Function("acknowledgeStop") {
      val context = applicationContext()
      T3BackgroundConnectionState.acknowledgeStop(context)
      T3BackgroundConnectionState.status(context)
    }
  }

  private fun applicationContext(): Context =
    requireNotNull(appContext.reactContext?.applicationContext) {
      "T3BackgroundConnection requires an Android React context"
    }
}
