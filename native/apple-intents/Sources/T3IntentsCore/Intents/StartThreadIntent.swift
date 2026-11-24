import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
@AppIntent(.tool)
public struct StartThreadIntent: Sendable {
  public static let title: LocalizedStringResource = "Start Thread"
  public static let description = IntentDescription(
    "Start a new coding agent thread in a T3 Code project with an initial task prompt.",
    categoryName: "Threads"
  )
  public static let supportedModes: IntentModes = .background

  @Parameter(
    title: "Project",
    description: "The T3 Code project where the coding agent should work."
  )
  public var project: ProjectEntity

  @Parameter(
    title: "Prompt",
    description: "The task instructions to send to the coding agent."
  )
  public var prompt: String

  @Parameter(
    title: "Title",
    description: "Optional short title for the new thread."
  )
  public var threadTitle: String?

  @Parameter(
    title: "Interaction Mode",
    description: "Use Plan mode to ask for a plan before editing files.",
    default: .default
  )
  public var interactionMode: ThreadInteractionMode

  @Dependency
  private var store: T3IndexStore

  @Dependency
  private var client: any T3EnvironmentOperating

  public static var parameterSummary: some ParameterSummary {
    Summary("Start thread in \(\.$project) with \(\.$prompt)") {
      \.$threadTitle
      \.$interactionMode
    }
  }

  public init() {}

  public init(
    project: ProjectEntity,
    prompt: String,
    threadTitle: String? = nil,
    interactionMode: ThreadInteractionMode = .default
  ) {
    self.project = project
    self.prompt = prompt
    self.threadTitle = threadTitle
    self.interactionMode = interactionMode
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<ThreadEntity> & ProvidesDialog {
    let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedPrompt.isEmpty else {
      throw T3IntentError.invalidInput("Provide instructions for the coding agent before starting a thread.")
    }
    let response = try await client.launchThread(
      environmentId: project.environmentId,
      projectId: project.projectId,
      title: threadTitle,
      message: trimmedPrompt,
      interactionMode: interactionMode.rawValue
    )
    let encodedEnv = project.environmentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? project.environmentId
    let encodedThread = response.threadId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? response.threadId
    let record = T3ThreadRecord(
      id: "\(project.environmentId):\(response.threadId)",
      environmentId: project.environmentId,
      threadId: response.threadId,
      projectId: project.projectId,
      projectName: project.name,
      title: response.title,
      branch: project.branch,
      status: "running",
      hasPendingRequest: false,
      pendingRequestSummary: nil,
      isPinned: false,
      isSettled: false,
      isSnoozed: false,
      snoozedUntil: nil,
      lastMessagePreview: nil,
      providerLabel: nil,
      modelLabel: nil,
      updatedAt: ISO8601DateFormatter().string(from: Date()),
      deepLinkUrl: "\(T3IntentsConfig.urlScheme)://threads/\(encodedEnv)/\(encodedThread)"
    )
    try? store.upsertThreadRecord(record)
    let entity = ThreadEntity(record: record)
    return .result(
      value: entity,
      dialog: IntentDialog("Started “\(entity.title)” in \(project.name).")
    )
  }
}
