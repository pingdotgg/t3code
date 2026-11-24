import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
@AppIntent(.tool)
public struct GetThreadStatusIntent: Sendable {
  public static let title: LocalizedStringResource = "Get Thread Status"
  public static let description = IntentDescription(
    "Check the current status, pending approvals, and latest summary for a T3 Code thread.",
    categoryName: "Threads"
  )
  public static let supportedModes: IntentModes = .background

  @Parameter(
    title: "Thread",
    description: "The T3 Code thread whose status you want to check."
  )
  public var thread: ThreadEntity

  @Dependency
  private var store: T3IndexStore

  public static var parameterSummary: some ParameterSummary {
    Summary("Get status of \(\.$thread)")
  }

  public init() {}

  public init(thread: ThreadEntity) {
    self.thread = thread
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<ThreadEntity> & ProvidesDialog & ShowsSnippetIntent {
    let fresh = store.thread(id: thread.id).map(ThreadEntity.init(record:)) ?? thread
    let freshness = T3StatusFreshness.of(environmentId: fresh.environmentId, in: store)
    let dialogText: String
    if fresh.hasPendingRequest {
      let detail = fresh.pendingRequestSummary ?? "waiting for your input"
      dialogText = "\(fresh.title) in \(fresh.projectName) is \(detail.lowercased())."
    } else {
      switch fresh.status {
      case .running:
        dialogText = "\(fresh.title) in \(fresh.projectName) is actively running."
      case .queued:
        dialogText = "\(fresh.title) in \(fresh.projectName) has a queued follow-up."
      case .error:
        dialogText = "\(fresh.title) in \(fresh.projectName) hit an error on its last run."
      case .waiting:
        dialogText = "\(fresh.title) in \(fresh.projectName) is waiting for input."
      case .idle:
        dialogText = fresh.isSettled
          ? "\(fresh.title) in \(fresh.projectName) is settled."
          : "\(fresh.title) in \(fresh.projectName) is idle and ready."
      }
    }
    return .result(
      value: fresh,
      dialog: IntentDialog(stringLiteral: freshness.dialogPrefix() + dialogText),
      snippetIntent: ThreadStatusSnippetIntent(thread: fresh)
    )
  }
}

/// The index changes only when a host syncs, so an old sync, or a cached snapshot of an
/// environment the host cannot reach, must not be presented as current state.
public enum T3StatusFreshness: Equatable, Sendable {
  case fresh
  case neverSynced
  case stale(since: Date)
  /// The host keeps the last snapshot of a disconnected environment, and other environments'
  /// syncs keep the shared sync time current, so this status is only the last one known.
  case environmentOffline(label: String)

  static let staleAfter: TimeInterval = 120

  static func of(environmentId: String, in store: T3IndexStore, now: Date = Date()) -> Self {
    guard let syncedAt = store.lastSyncedAt() else { return .neverSynced }
    if let environment = store.environment(id: environmentId), !environment.isConnected {
      return .environmentOffline(label: environment.label)
    }
    return now.timeIntervalSince(syncedAt) > staleAfter ? .stale(since: syncedAt) : .fresh
  }

  func dialogPrefix(now: Date = Date()) -> String {
    switch self {
    case .fresh:
      return ""
    case .neverSynced:
      return "Not synced yet: "
    case let .stale(since):
      let relative = RelativeDateTimeFormatter().localizedString(for: since, relativeTo: now)
      return "Last synced \(relative): "
    case let .environmentOffline(label):
      return "\(label) is offline, so this is the last known status: "
    }
  }

  var cardLabel: String? {
    switch self {
    case .fresh:
      return nil
    case .neverSynced:
      return "Not synced yet"
    case let .stale(since):
      return "Last synced \(since.formatted(.relative(presentation: .named)))"
    case let .environmentOffline(label):
      return "\(label) offline · last known status"
    }
  }
}
