import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
@AppIntent(.tool)
public struct SendMessageToThreadIntent: Sendable {
  public static let title: LocalizedStringResource = "Send Prompt to Thread"
  public static let description = IntentDescription(
    "Send a follow-up coding prompt or steer an actively running coding agent in a T3 Code thread.",
    categoryName: "Threads"
  )
  public static let supportedModes: IntentModes = .background

  @Parameter(
    title: "Thread",
    description: "The existing T3 Code coding agent thread to instruct."
  )
  public var thread: ThreadEntity

  @Parameter(
    title: "Prompt",
    description: "The coding instruction or follow-up prompt for the agent to execute."
  )
  public var prompt: String

  @Dependency
  private var client: any T3EnvironmentOperating

  public static var parameterSummary: some ParameterSummary {
    Summary("Send \(\.$prompt) to \(\.$thread)")
  }

  public init() {}

  public init(thread: ThreadEntity, prompt: String) {
    self.thread = thread
    self.prompt = prompt
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<ThreadEntity> & ProvidesDialog {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      throw T3IntentError.invalidInput("Prompt text cannot be empty.")
    }
    let response = try await client.sendMessage(
      environmentId: thread.environmentId,
      threadId: thread.threadId,
      text: trimmed,
      mode: "auto"
    )
    let verb: String
    switch response.delivery {
    case "steered": verb = "Steered"
    case "queued": verb = "Queued your prompt on"
    case "restarted": verb = "Restarted"
    default: verb = "Sent your prompt to"
    }
    return .result(
      value: thread,
      dialog: IntentDialog("\(verb) “\(thread.title)”.")
    )
  }
}
