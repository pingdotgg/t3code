import AppIntents
import Foundation

public struct T3IntentsCorePackage: AppIntentsPackage {}

public enum T3IntentsDependencyRegistration {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var registered = false

  /// Registers shared dependencies with AppDependencyManager during launch (must run in
  /// `willFinishLaunchingWithOptions` on iOS or extension init on macOS).
  public static func registerIfNeeded(
    store: T3IndexStore = .shared,
    client: any T3EnvironmentOperating = T3ServerClient.shared
  ) {
    lock.lock()
    defer { lock.unlock() }
    guard !registered else { return }
    registered = true
    AppDependencyManager.shared.add(dependency: store)
    AppDependencyManager.shared.add(dependency: client)
  }
}
