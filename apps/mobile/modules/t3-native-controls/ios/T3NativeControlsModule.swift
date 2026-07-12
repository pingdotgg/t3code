import ExpoModulesCore
import Foundation

public final class T3NativeControlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3NativeControls")

    // Durable last-chance write for fatal JS records. Expo FileSystem write can
    // lose the race with RCTFatal abort; this fsyncs to Documents.
    Function("writeSyncText") { (relativePath: String, contents: String) -> Bool in
      T3CrashLog.writeSyncText(relativePath: relativePath, contents: contents)
    }

    // AppDelegate installs the native RCTFatal hooks; this is a no-op ack for JS.
    Function("installFatalHandler") { () -> Bool in
      true
    }

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
