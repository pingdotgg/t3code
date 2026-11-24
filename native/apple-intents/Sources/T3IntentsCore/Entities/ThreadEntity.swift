import AppIntents
import CoreSpotlight
import Foundation
import SwiftUI

@available(iOS 27.3, macOS 27.3, *)
public struct ThreadEntity: AppEntity, IndexedEntity, URLRepresentableEntity, OwnershipProvidingEntity, SnippetRepresentableEntity, Sendable {
  public static let typeDisplayRepresentation = TypeDisplayRepresentation(
    name: LocalizedStringResource("Thread"),
    numericFormat: LocalizedStringResource("\(placeholder: .int) threads")
  )

  public static let defaultQuery = ThreadEntityQuery()

  public static var urlRepresentation: URLRepresentation {
    "t3code://threads/\(\.$environmentId)/\(\.$threadId)"
  }

  public static var snippet: some EntitySnippetContent<ThreadEntity> {
    CardSnippet(supportedFamilies: [.compact, .standard]) { thread, context in
      ThreadStatusCardView(thread: thread, isCompact: context.family == .compact)
    }
  }

  public let id: String
  public let ownership: EntityOwnership = []

  @Property(
    title: "Environment ID",
    description: "Internal identifier of the T3 Code host environment running this thread.",
    visibility: .internal
  )
  public var environmentId: String

  @Property(
    title: "Thread ID",
    description: "Internal identifier of this thread within its T3 Code environment.",
    visibility: .internal
  )
  public var threadId: String

  @Property(
    title: "Project ID",
    description: "Internal identifier of the project owning this thread.",
    visibility: .internal
  )
  public var projectId: String

  @Property(
    title: "Title",
    description: "Title of this coding agent thread.",
    indexingKey: \.displayName
  )
  public var title: String

  @Property(
    title: "Project",
    description: "Name of the project this thread belongs to."
  )
  public var projectName: String

  @Property(
    title: "Status",
    description: "Current execution state of the agent (running, waiting, queued, idle, or error)."
  )
  public var status: ThreadRunStatus

  @Property(
    title: "Branch",
    description: "Git branch associated with this thread."
  )
  public var branch: String?

  @Property(
    title: "Needs Input",
    description: "Whether the agent is blocked waiting for user approval or an answer."
  )
  public var hasPendingRequest: Bool

  @Property(
    title: "Pending Request",
    description: "Short summary of the approval or question blocking the thread."
  )
  public var pendingRequestSummary: String?

  @Property(
    title: "Pinned",
    description: "Whether the thread is pinned in the sidebar."
  )
  public var isPinned: Bool

  @Property(
    title: "Settled",
    description: "Whether the thread is marked as settled."
  )
  public var isSettled: Bool

  @Property(
    title: "Snoozed",
    description: "Whether the thread is currently snoozed."
  )
  public var isSnoozed: Bool

  @Property(
    title: "Latest Message",
    description: "Optional sanitized preview of the latest visible message in this thread.",
    indexingKey: \.contentDescription
  )
  public var lastMessagePreview: String?

  @Property(
    title: "Model",
    description: "Coding agent model running this thread."
  )
  public var modelLabel: String?

  @Property(
    title: "Updated At",
    description: "Last activity timestamp for this thread.",
    indexingKey: \.contentModificationDate
  )
  public var updatedAt: Date

  public var displayRepresentation: DisplayRepresentation {
    let statusBadge: String
    switch status {
    case .waiting:
      statusBadge = pendingRequestSummary ?? "Needs input"
    case .running:
      statusBadge = "Running"
    case .queued:
      statusBadge = "Queued"
    case .error:
      statusBadge = "Error"
    case .idle:
      statusBadge = isSettled ? "Settled" : "Idle"
    }
    let subtitleParts = [projectName, branch, statusBadge].compactMap { $0 }.filter { !$0.isEmpty }
    return DisplayRepresentation(
      title: LocalizedStringResource(stringLiteral: title),
      subtitle: LocalizedStringResource(stringLiteral: subtitleParts.joined(separator: " · ")),
      image: .init(systemName: hasPendingRequest ? "hand.raised.circle.fill" : (status == .running ? "sparkles" : "bubble.left.and.bubble.right"))
    )
  }

  public var attributeSet: CSSearchableItemAttributeSet {
    let attrs = CSSearchableItemAttributeSet(contentType: .text)
    attrs.displayName = title
    attrs.title = title
    attrs.contentModificationDate = updatedAt
    var descriptionParts = [projectName]
    if let branch { descriptionParts.append(branch) }
    if let pendingRequestSummary { descriptionParts.append(pendingRequestSummary) }
    if let lastMessagePreview { descriptionParts.append(lastMessagePreview) }
    attrs.contentDescription = descriptionParts.joined(separator: " — ")
    var keywords = [title, projectName, status.rawValue, "T3 Code", "thread"]
    if let branch { keywords.append(branch) }
    if let modelLabel { keywords.append(modelLabel) }
    attrs.keywords = keywords
    attrs.domainIdentifier = "\(T3IntentsConfig.spotlightDomainPrefix).thread"
    return attrs
  }

  public init(record: T3ThreadRecord) {
    self.id = record.id
    self.environmentId = record.environmentId
    self.threadId = record.threadId
    self.projectId = record.projectId
    self.title = record.title
    self.projectName = record.projectName
    self.status = ThreadRunStatus(rawStatus: record.status)
    self.branch = record.branch
    self.hasPendingRequest = record.hasPendingRequest
    self.pendingRequestSummary = record.pendingRequestSummary
    self.isPinned = record.isPinned
    self.isSettled = record.isSettled
    self.isSnoozed = record.isSnoozed
    self.lastMessagePreview = record.lastMessagePreview
    self.modelLabel = record.modelLabel
    self.updatedAt = Self.parseISO8601(record.updatedAt) ?? Date()
  }

  private static func parseISO8601(_ value: String) -> Date? {
    let withFractional = ISO8601DateFormatter()
    withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let parsed = withFractional.date(from: value) {
      return parsed
    }
    return ISO8601DateFormatter().date(from: value)
  }
}

@available(iOS 27.3, macOS 27.3, *)
public struct ThreadEntityQuery: IndexedEntityQuery, EntityStringQuery, Sendable {
  @Dependency
  private var store: T3IndexStore

  public init() {}

  public func entities(for identifiers: [ThreadEntity.ID]) async throws -> [ThreadEntity] {
    store.threads(for: identifiers).map(ThreadEntity.init(record:))
  }

  public func suggestedEntities() async throws -> [ThreadEntity] {
    Array(store.allThreads(limit: 15)).map(ThreadEntity.init(record:))
  }

  public func entities(matching string: String) async throws -> [ThreadEntity] {
    store.searchThreads(matching: string, limit: 25).map(ThreadEntity.init(record:))
  }

  public func reindexEntities(
    for identifiers: [ThreadEntity.ID],
    indexDescription: CSSearchableIndexDescription
  ) async throws {
    let store = store
    try await T3IndexOperationQueue.run {
      let entities = store.threads(for: identifiers).map(ThreadEntity.init(record:))
      try await T3SpotlightIndexer.withDeadline {
        try await T3SpotlightIndexer.indexAppEntities(threads: entities)
      }
    }
  }

  public func reindexAllEntities(indexDescription: CSSearchableIndexDescription) async throws {
    let store = store
    try await T3IndexOperationQueue.run {
      let entities = store.allThreads().map(ThreadEntity.init(record:))
      try await T3SpotlightIndexer.withDeadline {
        try await T3SpotlightIndexer.indexAppEntities(threads: entities)
      }
    }
  }
}

@available(iOS 27.3, macOS 27.3, *)
public struct ThreadStatusCardView: View {
  let thread: ThreadEntity
  let isCompact: Bool
  let freshness: T3StatusFreshness

  public init(thread: ThreadEntity, isCompact: Bool = false, freshness: T3StatusFreshness = .fresh) {
    self.thread = thread
    self.isCompact = isCompact
    self.freshness = freshness
  }

  private var statusColor: Color {
    switch thread.status {
    case .waiting: return .orange
    case .running: return .blue
    case .queued: return .indigo
    case .error: return .red
    case .idle: return .green
    }
  }

  private var statusLabel: String {
    switch thread.status {
    case .waiting: return thread.pendingRequestSummary ?? "Waiting for input"
    case .running: return "Running"
    case .queued: return "Queued"
    case .error: return "Error"
    case .idle: return thread.isSettled ? "Settled" : "Idle"
    }
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Circle()
          .fill(statusColor)
          .frame(width: 9, height: 9)
        Text(thread.title)
          .font(.headline)
          .lineLimit(isCompact ? 1 : 2)
        Spacer()
        if thread.isPinned {
          Image(systemName: "pin.fill")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      HStack(spacing: 6) {
        Text(thread.projectName)
          .font(.subheadline)
          .foregroundStyle(.secondary)
        if let branch = thread.branch, !branch.isEmpty {
          Text("·")
            .foregroundStyle(.tertiary)
          Text(branch)
            .font(.subheadline.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }

      Text(statusLabel)
        .font(.caption.weight(.medium))
        .foregroundStyle(statusColor)

      if let freshnessLabel = freshness.cardLabel {
        Text(freshnessLabel)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }

      if !isCompact, let preview = thread.lastMessagePreview, !preview.isEmpty {
        Text(preview)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(3)
      }
    }
    .padding(12)
  }
}
