package expo.modules.t3backgroundconnection

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean

internal object T3BackgroundConnectionState {
  const val TASK_NAME = "T3BackgroundConnection"
  const val STATUS_EVENT = "onStatusChange"
  const val STOP_REQUEST_EVENT = "onStopRequested"
  const val RESTART_ACTION =
    "expo.modules.t3backgroundconnection.action.RESTART_BACKGROUND_CONNECTION"

  private const val PREFERENCES_NAME = "t3_background_connection"
  private const val ENABLED_KEY = "enabled"
  private const val STOP_FALLBACK_DELAY_MS = 5_000L
  private const val STABLE_RUNTIME_RESET_DELAY_MS = 60_000L

  private val mainHandler = Handler(Looper.getMainLooper())
  private val serviceRunning = AtomicBoolean(false)
  private val runtimeReady = AtomicBoolean(false)
  private val taskStarted = AtomicBoolean(false)
  private val statusListeners = CopyOnWriteArraySet<(Map<String, Any>) -> Unit>()
  private val stopRequestListeners = CopyOnWriteArraySet<() -> Unit>()

  @Volatile
  private var applicationContext: Context? = null

  @Volatile
  private var stopFallback: Runnable? = null

  @Volatile
  private var restartFallback: Runnable? = null

  @Volatile
  private var stableRuntimeReset: Runnable? = null

  private var consecutiveUnexpectedFailures = 0

  fun initialize(context: Context) {
    applicationContext = context.applicationContext
  }

  fun isEnabled(context: Context): Boolean =
    preferences(context).getBoolean(ENABLED_KEY, false)

  @SuppressLint("ApplySharedPref")
  fun setEnabled(context: Context, enabled: Boolean) {
    initialize(context)
    val wasEnabled = isEnabled(context)
    // Commit before starting the service so a process death cannot start a
    // sticky service whose boot-time preference still says it is disabled.
    preferences(context).edit().putBoolean(ENABLED_KEY, enabled).commit()
    if (enabled) {
      cancelStopFallback()
      if (!wasEnabled) {
        resetUnexpectedRestartBackoff()
      }
    } else {
      resetUnexpectedRestartBackoff()
    }
    emitStatus()
  }

  fun status(context: Context): Map<String, Any> {
    initialize(context)

    return mapOf(
      "supported" to true,
      "enabled" to isEnabled(context),
      "serviceRunning" to serviceRunning.get(),
      "runtimeReady" to runtimeReady.get(),
      "batteryOptimizationIgnored" to isBatteryOptimizationIgnored(context),
    )
  }

  fun shouldEnsureStartedOnActivityForeground(context: Context): Boolean =
    T3BackgroundConnectionRecoveryPolicy.shouldEnsureStartedOnActivityForeground(
      enabled = isEnabled(context),
      serviceRunning = serviceRunning.get(),
      runtimeReady = runtimeReady.get(),
    )

  fun isBatteryOptimizationIgnored(context: Context): Boolean {
    val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    return powerManager.isIgnoringBatteryOptimizations(context.packageName)
  }

  fun addStatusListener(listener: (Map<String, Any>) -> Unit) {
    statusListeners.add(listener)
  }

  fun removeStatusListener(listener: (Map<String, Any>) -> Unit) {
    statusListeners.remove(listener)
  }

  fun addStopRequestListener(listener: () -> Unit) {
    stopRequestListeners.add(listener)
  }

  fun removeStopRequestListener(listener: () -> Unit) {
    stopRequestListeners.remove(listener)
  }

  fun refreshStatus() {
    emitStatus()
  }

  fun markServiceRunning(running: Boolean) {
    serviceRunning.set(running)
    if (!running) {
      runtimeReady.set(false)
      taskStarted.set(false)
      cancelStopFallback()
      cancelStableRuntimeReset()
    }
    emitStatus()
  }

  fun markRuntimeReady(ready: Boolean) {
    val appliedReady = ready && serviceRunning.get()
    runtimeReady.set(appliedReady)
    if (appliedReady) {
      scheduleStableRuntimeReset()
    } else {
      cancelStableRuntimeReset()
    }
    emitStatus()
  }

  fun claimTask(): Boolean = taskStarted.compareAndSet(false, true)

  fun releaseTask() {
    taskStarted.set(false)
    runtimeReady.set(false)
    cancelStableRuntimeReset()
    emitStatus()
  }

  fun requestOrderlyStop(context: Context) {
    initialize(context)
    cancelStopFallback()
    if (!serviceRunning.get()) {
      stopService(context)
      return
    }

    // A claimed task can be creating the React context, or can already own
    // subscriptions while it bootstraps Clerk and persistence. Keep the
    // service alive long enough for that task to observe the disabled
    // preference and unwind; only an idle service is safe to stop immediately.
    // The bounded fallback below still handles a runtime that never responds.
    if (!taskStarted.get()) {
      stopService(context)
      return
    }

    mainHandler.post {
      if (!isEnabled(context)) {
        stopRequestListeners.forEach { listener -> listener() }
      }
    }

    val fallback = Runnable {
      stopFallback = null
      if (isEnabled(context)) return@Runnable
      runtimeReady.set(false)
      emitStatus()
      stopService(context)
    }
    stopFallback = fallback
    mainHandler.postDelayed(fallback, STOP_FALLBACK_DELAY_MS)
  }

  fun acknowledgeStop(context: Context) {
    initialize(context)
    cancelStopFallback()
    runtimeReady.set(false)
    emitStatus()
    if (!isEnabled(context)) {
      stopService(context)
    }
  }

  @Suppress("TooGenericExceptionCaught")
  fun scheduleRestartAfterUnexpectedTaskFinish(context: Context) {
    initialize(context)
    cancelScheduledRestart(context)
    val delayMs = T3BackgroundConnectionRestartBackoff.delayMs(consecutiveUnexpectedFailures)
    consecutiveUnexpectedFailures = (consecutiveUnexpectedFailures + 1).coerceAtMost(20)
    try {
      val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      alarmManager.setAndAllowWhileIdle(
        AlarmManager.ELAPSED_REALTIME_WAKEUP,
        SystemClock.elapsedRealtime() + delayMs,
        checkNotNull(restartPendingIntent(context, PendingIntent.FLAG_UPDATE_CURRENT)),
      )
    } catch (error: RuntimeException) {
      // AlarmManager is the durable path. Keep an in-process fallback for an
      // unusual vendor failure so recovery still has a best-effort attempt.
      Log.w("T3BackgroundConnection", "Could not schedule durable restart alarm", error)
      val restart = Runnable {
        restartFallback = null
        if (isEnabled(context)) {
          T3BackgroundConnectionController.ensureStarted(context)
        }
      }
      restartFallback = restart
      mainHandler.postDelayed(restart, delayMs)
    }
  }

  fun scheduleRestartAfterStartFailure(context: Context) {
    if (
      T3BackgroundConnectionRecoveryPolicy.shouldScheduleRestartAfterStartFailure(
        batteryOptimizationIgnored = isBatteryOptimizationIgnored(context),
      )
    ) {
      scheduleRestartAfterUnexpectedTaskFinish(context)
      return
    }

    // An alarm is not a valid exemption from Android's background foreground-
    // service launch restrictions. Re-arming it here would create an endless
    // failure ladder on a non-exempt app. Leave the feature enabled and recover
    // on the next Activity foreground, boot/package update, or sticky restart.
    cancelScheduledRestart(context)
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  private fun emitStatus() {
    val context = applicationContext ?: return
    val snapshot = status(context)
    mainHandler.post {
      statusListeners.forEach { listener -> listener(snapshot) }
    }
  }

  private fun cancelStopFallback() {
    stopFallback?.let(mainHandler::removeCallbacks)
    stopFallback = null
  }

  fun cancelScheduledRestart(context: Context) {
    restartFallback?.let(mainHandler::removeCallbacks)
    restartFallback = null
    val pendingIntent = restartPendingIntent(context, PendingIntent.FLAG_NO_CREATE) ?: return
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    alarmManager.cancel(pendingIntent)
    pendingIntent.cancel()
  }

  private fun scheduleStableRuntimeReset() {
    cancelStableRuntimeReset()
    val reset = Runnable {
      stableRuntimeReset = null
      if (runtimeReady.get() && serviceRunning.get()) {
        consecutiveUnexpectedFailures = 0
      }
    }
    stableRuntimeReset = reset
    mainHandler.postDelayed(reset, STABLE_RUNTIME_RESET_DELAY_MS)
  }

  private fun cancelStableRuntimeReset() {
    stableRuntimeReset?.let(mainHandler::removeCallbacks)
    stableRuntimeReset = null
  }

  private fun resetUnexpectedRestartBackoff() {
    consecutiveUnexpectedFailures = 0
    applicationContext?.let(::cancelScheduledRestart)
    cancelStableRuntimeReset()
  }

  private fun restartPendingIntent(context: Context, creationFlag: Int): PendingIntent? =
    PendingIntent.getBroadcast(
      context.applicationContext,
      RESTART_REQUEST_CODE,
      Intent(context.applicationContext, T3BackgroundConnectionReceiver::class.java).apply {
        action = RESTART_ACTION
      },
      creationFlag or PendingIntent.FLAG_IMMUTABLE,
    )

  private fun stopService(context: Context) {
    context.applicationContext.stopService(
      Intent(context.applicationContext, T3BackgroundConnectionService::class.java),
    )
  }

  private const val RESTART_REQUEST_CODE = 0x7434
}

internal object T3BackgroundConnectionController {
  @Suppress("TooGenericExceptionCaught")
  fun ensureStarted(context: Context): Boolean {
    val applicationContext = context.applicationContext
    T3BackgroundConnectionState.initialize(applicationContext)
    if (!T3BackgroundConnectionState.isEnabled(applicationContext)) return false

    val intent = Intent(applicationContext, T3BackgroundConnectionService::class.java)
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        applicationContext.startForegroundService(intent)
      } else {
        applicationContext.startService(intent)
      }
      T3BackgroundConnectionState.cancelScheduledRestart(applicationContext)
      true
    } catch (error: RuntimeException) {
      // Android can reject a background FGS launch. Keep the preference
      // enabled and let the recovery policy either retry an exempt app or
      // park until a foreground/OS trigger can legally start the service.
      Log.w("T3BackgroundConnection", "Could not start foreground service", error)
      T3BackgroundConnectionState.scheduleRestartAfterStartFailure(applicationContext)
      false
    }
  }
}
