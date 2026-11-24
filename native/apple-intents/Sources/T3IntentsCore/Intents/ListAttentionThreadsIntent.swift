import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
@AppIntent(.tool)
public struct ListAttentionThreadsIntent: Sendable {
  public static let title: LocalizedStringResource = "List Attention Threads"
  public static let description = IntentDescription(
    "List T3 Code threads that need attention, are running, errored, or pinned.",
    categoryName: "Threads"
  )
  public static let supportedModes: IntentModes = .background

  @Parameter(
    title: "Filter",
    description: "Which subset of active threads to return.",
    default: .needsAttention
  )
  public var filter: ThreadStateFilter

  @Parameter(
    title: "Project",
    description: "Optionally limit results to a single project."
  )
  public var project: ProjectEntity?

  @Dependency
  private var store: T3IndexStore

  public static var parameterSummary: some ParameterSummary {
    Summary("List \(\.$filter) threads") {
      \.$project
    }
  }

  public init() {}

  public init(filter: ThreadStateFilter = .needsAttention, project: ProjectEntity? = nil) {
    self.filter = filter
    self.project = project
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<[ThreadEntity]> & ProvidesDialog {
    // Read the whole index (capped at 500 by the host) so filters apply before the result limit.
    var records = store.allThreads()
    if let project {
      records = records.filter {
        $0.environmentId == project.environmentId && $0.projectId == project.projectId
      }
    }
    let filtered = records.filter { record in
      switch filter {
      case .needsAttention:
        return record.hasPendingRequest || record.status == "waiting" || record.status == "error"
      case .running:
        return record.status == "running" || record.status == "queued"
      case .errored:
        return record.status == "error"
      case .pinned:
        return record.isPinned
      case .allActive:
        return !record.isSettled && !record.isSnoozed
      }
    }
    let entities = Array(filtered.prefix(20)).map(ThreadEntity.init(record:))
    let dialog: String
    if entities.isEmpty {
      dialog = "No T3 Code threads match that filter right now."
    } else if entities.count == 1 {
      dialog = "1 thread found: \(entities[0].title) in \(entities[0].projectName)."
    } else {
      let topNames = entities.prefix(3).map(\.title).joined(separator: ", ")
      dialog = "\(entities.count) threads found, including \(topNames)."
    }
    return .result(value: entities, dialog: IntentDialog(stringLiteral: dialog))
  }
}
