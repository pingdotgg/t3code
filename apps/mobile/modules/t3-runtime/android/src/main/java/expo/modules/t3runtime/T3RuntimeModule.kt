package expo.modules.t3runtime

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3RuntimeModule : Module() {
  private val manager get() = RuntimeManager.get(appContext.reactContext ?: error("Android context is unavailable"))
  private val observer: (Map<String, Any?>) -> Unit = { sendEvent("onState", it) }
  private var observedManager: RuntimeManager? = null
  override fun definition() = ModuleDefinition {
    Name("T3Runtime")
    Events("onState")
    OnCreate { observedManager = manager; manager.listeners.add(observer) }
    OnDestroy { observedManager?.listeners?.remove(observer); observedManager = null }
    AsyncFunction("start") {
      val context = appContext.reactContext ?: error("Android context is unavailable")
      ContextCompat.startForegroundService(context, Intent(context, RuntimeService::class.java))
      manager.start()
    }
    AsyncFunction("stop") {
      val context = appContext.reactContext ?: error("Android context is unavailable")
      context.startService(Intent(context, RuntimeService::class.java).setAction("stop"))
    }
    AsyncFunction("signIn") { manager.signIn() }
  }
}
