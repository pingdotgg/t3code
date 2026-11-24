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
    let staleSince = T3StatusFreshness.staleSince(store)
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
      dialog: IntentDialog(stringLiteral: T3StatusFreshness.dialogPrefix(staleSince: staleSince) + dialogText),
      snippetIntent: ThreadStatusSnippetIntent(thread: fresh)
    )
  }
}

/// The index changes only when a host syncs, so an old sync must not be presented as current state.
enum T3StatusFreshness {
  static let staleAfter: TimeInterval = 120

  /// Nil when the index is fresh; otherwise when it was last synced (`distantPast` if never).
  static func staleSince(_ store: T3IndexStore, now: Date = Date()) -> Date? {
    guard let syncedAt = store.lastSyncedAt() else { return .distantPast }
    return now.timeIntervalSince(syncedAt) > staleAfter ? syncedAt : nil
  }

  static func dialogPrefix(staleSince: Date?, now: Date = Date()) -> String {
    guard let staleSince else { return "" }
    guard staleSince != .distantPast else { return "Not synced yet: " }
    let relative = RelativeDateTimeFormatter().localizedString(for: staleSince, relativeTo: now)
    return "Last synced \(relative): "
  }
}
