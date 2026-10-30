// Lives in the app target (an Expo inline module directory): App Intents metadata extraction
// skips intents compiled into CocoaPods pods.
import AppIntents
import Foundation
import OSLog

enum FocusFilterStore {
  private static let environmentsKey = "t3.focusFilter.environments"

  /// The App Group suite when the build has one, so a future extension can read the same list.
  private static var defaults: UserDefaults {
    (Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String)
      .flatMap(UserDefaults.init(suiteName:)) ?? .standard
  }

  static func environments() -> [FocusEnvironmentEntity] {
    (defaults.array(forKey: environmentsKey) as? [[String: String]] ?? []).compactMap { entry in
      guard let id = entry["id"], let label = entry["label"] else { return nil }
      return FocusEnvironmentEntity(id: id, label: label)
    }
  }

  static func setEnvironments(_ environments: [FocusEnvironmentEntity]) {
    defaults.set(environments.map { ["id": $0.id, "label": $0.label] }, forKey: environmentsKey)
  }
}

struct FocusEnvironmentEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Environment"
  static let defaultQuery = FocusEnvironmentQuery()

  let id: String
  let label: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(label)") }
}

struct FocusEnvironmentQuery: EntityStringQuery {
  /// Resolves every saved id, even one the app has not published yet, so a cold start or a
  /// removed environment never silently widens the Focus to "all environments".
  func entities(for identifiers: [String]) async throws -> [FocusEnvironmentEntity] {
    let known = Dictionary(
      FocusFilterStore.environments().map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return identifiers.map { known[$0] ?? FocusEnvironmentEntity(id: $0, label: $0) }
  }

  func entities(matching string: String) async throws -> [FocusEnvironmentEntity] {
    FocusFilterStore.environments().filter { $0.label.localizedCaseInsensitiveContains(string) }
  }

  func suggestedEntities() async throws -> [FocusEnvironmentEntity] {
    FocusFilterStore.environments()
  }
}

struct EnvironmentFocusFilter: SetFocusFilterIntent {
  static let title: LocalizedStringResource = "Set Environments"
  static let description: IntentDescription? = IntentDescription(
    "Only connect to the chosen environments and silence notifications from the others.")

  @Parameter(title: "Environments")
  var environments: [FocusEnvironmentEntity]?

  /// Nil or empty means the Focus does not restrict environments.
  var allowedEnvironmentIds: [String]? {
    guard let environments, !environments.isEmpty else { return nil }
    return environments.map(\.id)
  }

  var displayRepresentation: DisplayRepresentation {
    guard let environments, !environments.isEmpty else {
      return DisplayRepresentation(title: "All environments")
    }
    return DisplayRepresentation(
      title: "Only these environments",
      subtitle: "\(environments.map(\.label).joined(separator: ", "))")
  }

  /// The relay sends each push's environment id as `aps.filter-criteria`.
  var appContext: FocusFilterAppContext {
    FocusFilterAppContext(
      notificationFilterPredicate: allowedEnvironmentIds.map { NSPredicate(format: "SELF IN %@", $0) })
  }

  /// iOS calls this only while the app runs in the foreground; the app also reads
  /// `EnvironmentFocusFilter.current` on launch and on every return to the foreground.
  func perform() async throws -> some IntentResult {
    let allowed = allowedEnvironmentIds
    Logger(subsystem: "com.t3tools.t3code", category: "focus-filter")
      .log("perform allowed=\(allowed?.description ?? "all", privacy: .public)")
    NotificationCenter.default.post(
      name: .t3FocusFilterChanged, object: nil, userInfo: allowed.map { ["environmentIds": $0] })
    return .result()
  }
}

extension Notification.Name {
  static let t3FocusFilterChanged = Notification.Name("T3FocusFilterChanged")
}
