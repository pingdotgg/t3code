import AppIntents
import CoreSpotlight
import Foundation

/// Process-local runtime bridge invoked by the Expo iOS module and macOS Electron host dylib.
public final class T3IntentsRuntime: @unchecked Sendable {
  public static let shared = T3IntentsRuntime()

  private let store: T3IndexStore
  private let credentials: any T3CredentialProviding
  private let activityLock = NSLock()
  private var activeUserActivity: NSUserActivity?

  public var onOpenURL: (@MainActor @Sendable (URL) -> Void)?

  public init(
    store: T3IndexStore = .shared,
    credentials: any T3CredentialProviding = T3KeychainCredentialStore.shared
  ) {
    self.store = store
    self.credentials = credentials
  }

  public static var isSupportedOS: Bool {
    if #available(iOS 27.3, macOS 27.3, *) {
      return true
    }
    return false
  }

  public func bootstrap() {
    T3IntentsDependencyRegistration.registerIfNeeded(store: store)
    if #available(iOS 27.3, macOS 27.3, *) {
      T3AppShortcuts.updateAppShortcutParameters()
    }
  }

  public func syncIndexJSON(_ jsonString: String) async throws {
    guard let data = jsonString.data(using: .utf8) else { return }
    let delta = try JSONDecoder().decode(T3IndexDelta.self, from: data)
    let diff = try store.applyDelta(delta)
    await T3SpotlightIndexer.apply(diff: diff)
    if #available(iOS 27.3, macOS 27.3, *) {
      T3AppShortcuts.updateAppShortcutParameters()
    }
  }

  public func removeEnvironment(environmentId: String) async throws {
    let diff = try store.removeEnvironment(environmentId: environmentId)
    credentials.removeCredential(for: environmentId)
    await T3SpotlightIndexer.apply(diff: diff)
    if #available(iOS 27.3, macOS 27.3, *) {
      T3AppShortcuts.updateAppShortcutParameters()
    }
  }

  public func clearIndex() async throws {
    try store.clearAll()
    credentials.clearAllCredentials()
    await T3SpotlightIndexer.clearAll()
    setOnscreenContextJSON(nil)
    if #available(iOS 27.3, macOS 27.3, *) {
      T3AppShortcuts.updateAppShortcutParameters()
    }
  }

  public func syncAuthCredentialsJSON(_ jsonString: String) throws {
    guard let data = jsonString.data(using: .utf8) else { return }
    let records = try JSONDecoder().decode([T3AuthCredentialRecord].self, from: data)
    credentials.saveCredentials(records)
  }

  /// Publishes or clears the onscreen NSUserActivity with `appEntityIdentifier` so Siri
  /// ("summarize this thread", "stop this agent") resolves the visible thread or project.
  public func setOnscreenContextJSON(_ jsonString: String?) {
    activityLock.lock()
    let previous = activeUserActivity
    activeUserActivity = nil
    activityLock.unlock()
    previous?.invalidate()

    guard let jsonString,
          let data = jsonString.data(using: .utf8),
          let context = try? JSONDecoder().decode(T3OnscreenContextRecord.self, from: data)
    else {
      return
    }

    let activityType = context.kind == "project"
      ? T3IntentsConfig.projectActivityType
      : T3IntentsConfig.threadActivityType
    let activity = NSUserActivity(activityType: activityType)
    activity.title = context.title
    activity.isEligibleForSearch = false
    activity.isEligibleForHandoff = false
    if let url = URL(string: context.deepLinkUrl) {
      activity.webpageURL = nil
      activity.userInfo = ["deepLinkUrl": url.absoluteString]
    }

    if #available(iOS 27.3, macOS 27.3, *) {
      if context.kind == "thread", let compositeId = context.compositeEntityId {
        if let record = store.thread(id: compositeId) {
          activity.appEntityIdentifier = EntityIdentifier(for: ThreadEntity(record: record))
        }
      } else if context.kind == "project", let compositeId = context.compositeEntityId {
        if let record = store.projects(for: [compositeId]).first {
          activity.appEntityIdentifier = EntityIdentifier(for: ProjectEntity(record: record))
        }
      }
    }

    activity.becomeCurrent()
    activityLock.lock()
    activeUserActivity = activity
    activityLock.unlock()
  }

  /// Resolves a CoreSpotlight `CSSearchableItemActivityIdentifier` back to a T3 Code deep link URL.
  public func resolveDeepLink(forSpotlightIdentifier identifier: String) -> URL? {
    if let thread = store.thread(id: identifier), let url = URL(string: thread.deepLinkUrl) {
      return url
    }
    if let project = store.projects(for: [identifier]).first, let url = URL(string: project.deepLinkUrl) {
      return url
    }
    // Fallback parsing when identifier is "<environmentId>:<threadId>".
    let parts = identifier.split(separator: ":", maxSplits: 1).map(String.init)
    if parts.count == 2 {
      let env = parts[0].addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? parts[0]
      let item = parts[1].addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? parts[1]
      return URL(string: "\(T3IntentsConfig.urlScheme)://threads/\(env)/\(item)")
    }
    return nil
  }
}
