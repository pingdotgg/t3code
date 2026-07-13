package expo.modules.t3nativecontrols

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3NativeControlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3NativeControls")

    View(T3HeaderButtonView::class) {
      Prop("label") { view: T3HeaderButtonView, label: String ->
        view.setLabel(label)
      }
      Prop("systemImage") { view: T3HeaderButtonView, systemImage: String ->
        view.setSystemImage(systemImage)
      }

      Events("onTriggered")
    }
  }
}
