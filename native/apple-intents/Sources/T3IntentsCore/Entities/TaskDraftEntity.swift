import AppIntents
import Foundation

/// Generable draft container for Siri-constructed coding task prompts.
/// Per iOS/macOS 27.3 build rules, a GenerableEntity must NOT hold non-generable AppEntity properties.
@available(iOS 27.3, macOS 27.3, *)
@AppEntity(.generable)
public struct TaskDraftEntity: Sendable {
  public static let typeDisplayRepresentation = TypeDisplayRepresentation(
    name: LocalizedStringResource("Coding Task Draft")
  )

  @Property(
    title: "Title",
    description: "A concise title summarizing the coding task."
  )
  public var title: String?

  @Property(
    title: "Prompt",
    description: "Instructions describing what the coding agent should build, investigate, or fix."
  )
  public var prompt: String

  @Property(
    title: "Interaction Mode",
    description: "Whether the agent executes directly or proposes a plan first."
  )
  public var interactionMode: ThreadInteractionMode?

  public var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: LocalizedStringResource(stringLiteral: title ?? "New Coding Task"),
      subtitle: LocalizedStringResource(stringLiteral: String(prompt.prefix(80))),
      image: .init(systemName: "sparkles.rectangle.stack")
    )
  }

  public init() {
    self.title = nil
    self.prompt = ""
    self.interactionMode = .default
  }

  public init(title: String?, prompt: String, interactionMode: ThreadInteractionMode? = .default) {
    self.title = title
    self.prompt = prompt
    self.interactionMode = interactionMode
  }
}
