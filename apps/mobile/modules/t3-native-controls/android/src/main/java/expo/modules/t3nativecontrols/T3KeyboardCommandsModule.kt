package expo.modules.t3nativecontrols

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3KeyboardCommandsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3KeyboardCommands")

    View(T3KeyboardCommandsView::class) {
      Prop("enabledCommands") { view: T3KeyboardCommandsView, enabledCommands: List<String> ->
        view.setEnabledCommands(enabledCommands)
      }

      Events("onCommand")
    }
  }
}