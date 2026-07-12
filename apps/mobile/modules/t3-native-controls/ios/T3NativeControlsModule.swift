import ExpoModulesCore

public final class T3NativeControlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3NativeControls")

    View(T3HeaderButtonView.self) {
      Prop("label") { (view: T3HeaderButtonView, label: String) in
        view.setLabel(label)
      }
      Prop("systemImage") { (view: T3HeaderButtonView, systemImage: String) in
        view.setSystemImage(systemImage)
      }

      Events("onTriggered")
    }
  }
}
