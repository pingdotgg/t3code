import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
@AppIntent(.tool)
public struct OrganizeThreadIntent: Sendable {
  public static let title: LocalizedStringResource = "Organize Thread"
  public static let description = IntentDescription(
    "Settle, unsettle, snooze, unsnooze, pin, or unpin a T3 Code thread.",
    categoryName: "Threads"
  )
  public static let supportedModes: IntentModes = .background

  @Parameter(
    title: "Thread",
    description: "The T3 Code thread to organize."
  )
  public var thread: ThreadEntity

  @Parameter(
    title: "Action",
    description: "The organization action to perform on the thread."
  )
  public var action: ThreadOrganizationAction

  @Parameter(
    title: "Snooze Duration",
    description: "How long to snooze the thread when action is Snooze.",
    default: .oneHour
  )
  public var snoozeDuration: SnoozePreset

  @Dependency
  private var client: any T3EnvironmentOperating

  public static var parameterSummary: some ParameterSummary {
    When(\.$action, .equalTo, .snooze) {
      Summary("\(\.$action) \(\.$thread) for \(\.$snoozeDuration)")
    } otherwise: {
      Summary("\(\.$action) \(\.$thread)")
    }
  }

  public init() {}

  public init(
    thread: ThreadEntity,
    action: ThreadOrganizationAction,
    snoozeDuration: SnoozePreset = .oneHour
  ) {
    self.thread = thread
    self.action = action
    self.snoozeDuration = snoozeDuration
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<ThreadEntity> & ProvidesDialog {
    _ = try await client.dispatchCommand(environmentId: thread.environmentId, payload: makeCommandPayload())
    return .result(
      value: thread,
      dialog: IntentDialog("\(actionPastTenseLabel()) “\(thread.title)”.")
    )
  }

  private func makeCommandPayload() -> [String: AnySendable] {
    var payload: [String: AnySendable] = [
      "commandId": .string(UUID().uuidString),
      "threadId": .string(thread.threadId),
    ]
    switch action {
    case .settle:
      payload["type"] = .string("thread.settle")
    case .unsettle:
      payload["type"] = .string("thread.unsettle")
      payload["reason"] = .string("user")
    case .snooze:
      payload["type"] = .string("thread.snooze")
      payload["snoozedUntil"] = .string(ISO8601DateFormatter().string(from: snoozeDuration.targetDate()))
    case .unsnooze:
      payload["type"] = .string("thread.unsnooze")
      payload["reason"] = .string("user")
    case .pin:
      payload["type"] = .string("thread.pin")
    case .unpin:
      payload["type"] = .string("thread.unpin")
    }
    return payload
  }

  private func actionPastTenseLabel() -> String {
    switch action {
    case .settle: return "Settled"
    case .unsettle: return "Marked active"
    case .snooze: return "Snoozed"
    case .unsnooze: return "Unsnoozed"
    case .pin: return "Pinned"
    case .unpin: return "Unpinned"
    }
  }
}
