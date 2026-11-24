package expo.modules.t3nativecontrols

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AppLockModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AppLock")

    AsyncFunction("getStatus") {
      T3AppLock.status(appContext.reactContext ?: error("The app is not active."))
    }

    AsyncFunction("configure") { enabled: Boolean, timeoutSeconds: Int, promise: Promise ->
      val activity = appContext.currentActivity ?: error("The app is not active.")
      T3AppLock.configure(
        activity,
        enabled,
        timeoutSeconds,
        onResult = { promise.resolve(it) },
        onUnavailable = {
          promise.reject(
            CodedException("ERR_APP_LOCK_UNAVAILABLE", "Set a screen lock to use App Lock.", null)
          )
        }
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setStrings") { unlockLabel: String, reason: String ->
      T3AppLock.setStrings(unlockLabel, reason)
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, (requestCode, resultCode) ->
      T3AppLock.onActivityResult(requestCode, resultCode)
    }
  }
}
