import ExpoModulesCore
import UIKit

public final class T3AppIconModule: Module {
  private var changingIcon = false

  public func definition() -> ModuleDefinition {
    Name("T3AppIcon")

    AsyncFunction("getState") { () -> [String: Any] in
      self.iconState()
    }.runOnQueue(.main)

    AsyncFunction("setIcon") { (id: String, promise: Promise) in
      let application = UIApplication.shared
      guard application.supportsAlternateIcons, let name = self.icons[id] else {
        promise.reject("ERR_APP_ICON_UNAVAILABLE", "This app icon is unavailable in this build.")
        return
      }
      guard !self.changingIcon else {
        promise.reject("ERR_APP_ICON_BUSY", "An app icon change is already in progress.")
        return
      }
      let alternateName: String? = name.isEmpty ? nil : name
      if application.alternateIconName == alternateName {
        promise.resolve(self.iconState())
        return
      }
      guard application.applicationState == .active else {
        promise.reject("ERR_APP_ICON_INACTIVE", "Return to the app to change its icon.")
        return
      }
      self.changingIcon = true
      application.setAlternateIconName(alternateName) { error in
        DispatchQueue.main.async {
          self.changingIcon = false
          if let error {
            promise.reject("ERR_APP_ICON_CHANGE", error.localizedDescription)
          } else {
            promise.resolve(self.iconState())
          }
        }
      }
    }.runOnQueue(.main)
  }

  private var icons: [String: String] {
    Bundle.main.object(forInfoDictionaryKey: "T3AppIcons") as? [String: String] ?? [:]
  }

  private func iconState() -> [String: Any] {
    let application = UIApplication.shared
    let name = application.alternateIconName ?? ""
    return [
      "icons": application.supportsAlternateIcons ? Array(icons.keys) : [],
      "selected": icons.first(where: { $0.value == name })?.key ?? "",
    ]
  }
}
