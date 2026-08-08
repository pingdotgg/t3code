package expo.modules.t3agentliveupdate

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentLiveUpdateModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) {
      "T3AgentLiveUpdate requires an active React context."
    }

  override fun definition() = ModuleDefinition {
    Name("T3AgentLiveUpdate")

    AsyncFunction("ensureChannel") {
      manager().apply { ensureChannel() }.status()
    }

    AsyncFunction("getStatus") {
      manager().status()
    }

    AsyncFunction("show") { snapshot: LiveUpdateSnapshot ->
      manager().show(snapshot)
    }

    AsyncFunction("cancel") {
      manager().cancel()
    }

    AsyncFunction("openPromotionSettings") {
      manager().openPromotionSettings()
    }
  }

  private fun manager() = AgentLiveUpdateManager(context.applicationContext)
}
