import AppIntents
import T3IntentsCore

struct T3MacAppIntentsPackage: AppIntentsPackage {
  static var includedPackages: [any AppIntentsPackage.Type] {
    [T3IntentsCorePackage.self]
  }
}

@main
struct T3AppIntentsExtensionEntry: AppIntentsExtension {
  init() {
    T3IntentsDependencyRegistration.registerIfNeeded()
  }
}
