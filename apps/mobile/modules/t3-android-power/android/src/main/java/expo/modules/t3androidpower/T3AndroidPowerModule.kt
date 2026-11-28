package expo.modules.t3androidpower

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AndroidPowerModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val backgroundIdle = Runnable { sendEvent(BACKGROUND_IDLE, mapOf<String, Any?>()) }
  private var powerSaveReceiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("T3AndroidPower")

    Events(BACKGROUND_IDLE, POWER_SAVE_MODE_CHANGE)

    // React Native stops JS timers while the activity is paused, so the
    // background delay that suspends server connections has to run here.
    OnActivityEntersBackground {
      mainHandler.removeCallbacks(backgroundIdle)
      mainHandler.postDelayed(backgroundIdle, BACKGROUND_IDLE_AFTER_MS)
    }

    OnActivityEntersForeground { mainHandler.removeCallbacks(backgroundIdle) }

    OnCreate {
      val context = appContext.reactContext ?: return@OnCreate
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          sendEvent(POWER_SAVE_MODE_CHANGE, mapOf<String, Any?>())
        }
      }
      ContextCompat.registerReceiver(
        context,
        receiver,
        IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
        ContextCompat.RECEIVER_NOT_EXPORTED
      )
      powerSaveReceiver = receiver
    }

    OnDestroy {
      mainHandler.removeCallbacks(backgroundIdle)
      val receiver = powerSaveReceiver ?: return@OnDestroy
      powerSaveReceiver = null
      try {
        appContext.reactContext?.unregisterReceiver(receiver)
      } catch (_: IllegalArgumentException) {
      }
    }

    Function("isPowerSaveMode") {
      appContext.reactContext?.let { isPowerSaveMode(it) } ?: false
    }
  }
}

private fun isPowerSaveMode(context: Context): Boolean =
  context.getSystemService(PowerManager::class.java)?.isPowerSaveMode == true

private const val BACKGROUND_IDLE = "onBackgroundIdle"
private const val POWER_SAVE_MODE_CHANGE = "onPowerSaveModeChange"

// Long enough that a quick trip to another app keeps the live session.
private const val BACKGROUND_IDLE_AFTER_MS = 30_000L
