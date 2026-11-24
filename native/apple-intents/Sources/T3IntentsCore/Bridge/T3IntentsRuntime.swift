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
  private var onscreenContextJSON: String?
  private var onscreenEntityResolved = false
  private let operationLock = NSLock()
  private var operationTail: Task<Void, Never>?

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

  /// Runs index mutations one at a time, each store write together with its Spotlight update,
  /// so a clear can never interleave with an in-flight sync.
  private func serialized(_ work: @escaping @Sendable () async throws -> Void) async throws {
    let task: Task<Void, any Error> = operationLock.withLock {
      let previous = operationTail
      let task = Task {
        await previous?.value
        try await work()
      }
      operationTail = Task { _ = await task.result }
      return task
    }
    try await task.value
  }

  public func syncIndexJSON(_ jsonString: String) async throws {
    let delta = try JSONDecoder().decode(T3IndexDelta.self, from: Data(jsonString.utf8))
    try await applyDelta(delta)
  }

  private func applyDelta(_ delta: T3IndexDelta) async throws {
    let store = self.store
    try await serialized {
      // Spotlight removals run before the store commits, so a failed removal leaves the store
      // unchanged and the host's retry plans the same removals again.
      let plan = try store.planDelta(delta)
      try await T3SpotlightIndexer.removeEntities(
        threadIds: plan.removedThreadIds,
        projectIds: plan.removedProjectIds
      )
      try store.applyDelta(delta, plan: plan)
      try await T3SpotlightIndexer.indexEntities(
        projects: delta.upsertedProjects,
        threads: delta.upsertedThreads
      )
    }
    refreshOnscreenEntityIfNeeded()
    if #available(iOS 27.3, macOS 27.3, *) {
      T3AppShortcuts.updateAppShortcutParameters()
    }
  }

  public func removeEnvironment(environmentId: String) async throws {
    try await applyDelta(T3IndexDelta(removedEnvironmentIds: [environmentId]))
    credentials.removeCredential(for: environmentId)
  }

  public func clearIndex() async throws {
    let store = self.store
    let credentials = self.credentials
    try await serialized {
      try store.clearAll()
      credentials.clearAllCredentials()
      try await T3SpotlightIndexer.clearAll()
    }
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

  /// Context published before its entity reached the index has no entity identifier; republish it.
  private func refreshOnscreenEntityIfNeeded() {
    activityLock.lock()
    let pending = onscreenEntityResolved ? nil : onscreenContextJSON
    activityLock.unlock()
    if let pending {
      setOnscreenContextJSON(pending)
    }
  }

  /// Publishes or clears the onscreen NSUserActivity with `appEntityIdentifier` so Siri
  /// ("summarize this thread", "stop this agent") resolves the visible thread or project.
  public func setOnscreenContextJSON(_ jsonString: String?) {
    activityLock.lock()
    let previous = activeUserActivity
    activeUserActivity = nil
    onscreenContextJSON = jsonString
    onscreenEntityResolved = false
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

    var entityResolved = false
    if #available(iOS 27.3, macOS 27.3, *) {
      if context.kind == "thread", let compositeId = context.compositeEntityId {
        if let record = store.thread(id: compositeId) {
          activity.appEntityIdentifier = EntityIdentifier(for: ThreadEntity(record: record))
          entityResolved = true
        }
      } else if context.kind == "project", let compositeId = context.compositeEntityId {
        if let record = store.projects(for: [compositeId]).first {
          activity.appEntityIdentifier = EntityIdentifier(for: ProjectEntity(record: record))
          entityResolved = true
        }
      }
    }

    activity.becomeCurrent()
    activityLock.lock()
    activeUserActivity = activity
    onscreenEntityResolved = entityResolved
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
