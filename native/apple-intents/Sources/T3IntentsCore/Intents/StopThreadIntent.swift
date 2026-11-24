import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
@AppIntent(.tool)
public struct StopThreadIntent: Sendable {
  public static let title: LocalizedStringResource = "Stop Thread"
  public static let description = IntentDescription(
    "Stop an actively running coding agent turn in a T3 Code thread.",
    categoryName: "Threads"
  )
  public static let supportedModes: IntentModes = .background

  @Parameter(
    title: "Thread",
    description: "The running T3 Code thread to stop."
  )
  public var thread: ThreadEntity

  @Dependency
  private var client: any T3EnvironmentOperating

  public static var parameterSummary: some ParameterSummary {
    Summary("Stop \(\.$thread)")
  }

  public init() {}

  public init(thread: ThreadEntity) {
    self.thread = thread
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<ThreadEntity> & ProvidesDialog {
    try await requestConfirmation(
      actionName: .custom(
        acceptLabel: "Stop Run",
        acceptAlternatives: [],
        denyLabel: "Keep Running",
        denyAlternatives: [],
        destructive: true
      ),
      dialog: IntentDialog("Stop the active run on “\(thread.title)”?")
    )

    let payload: [String: AnySendable] = [
      "type": .string("thread.stop"),
      "commandId": .string(UUID().uuidString),
      "threadId": .string(thread.threadId),
      "reason": .string("Stopped from Siri"),
    ]
    _ = try await client.dispatchCommand(environmentId: thread.environmentId, payload: payload)
    return .result(
      value: thread,
      dialog: IntentDialog("Stopped “\(thread.title)”.")
    )
  }
}
