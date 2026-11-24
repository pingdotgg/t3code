import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
public struct EnvironmentEntity: AppEntity, Sendable {
  public static let typeDisplayRepresentation = TypeDisplayRepresentation(
    name: LocalizedStringResource("Environment"),
    numericFormat: LocalizedStringResource("\(placeholder: .int) environments")
  )

  public static let defaultQuery = EnvironmentEntityQuery()

  public let id: String

  @Property(
    title: "Name",
    description: "Display name of this T3 Code environment or machine."
  )
  public var label: String

  @Property(
    title: "Local Machine",
    description: "Whether this environment runs locally on this device."
  )
  public var isLocal: Bool

  @Property(
    title: "Connected",
    description: "Whether the client was recently connected to this environment."
  )
  public var isConnected: Bool

  public var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: LocalizedStringResource(stringLiteral: label),
      subtitle: LocalizedStringResource(stringLiteral: isLocal ? "Local" : (isConnected ? "Connected" : "Remote")),
      image: .init(systemName: isLocal ? "laptopcomputer" : "server.rack")
    )
  }

  public init(record: T3EnvironmentRecord) {
    self.id = record.id
    self.label = record.label
    self.isLocal = record.isLocal
    self.isConnected = record.isConnected
  }
}

@available(iOS 27.3, macOS 27.3, *)
public struct EnvironmentEntityQuery: EnumerableEntityQuery, EntityStringQuery, Sendable {
  @Dependency
  private var store: T3IndexStore

  public init() {}

  public func entities(for identifiers: [EnvironmentEntity.ID]) async throws -> [EnvironmentEntity] {
    store.environments(for: identifiers).map(EnvironmentEntity.init(record:))
  }

  public func allEntities() async throws -> [EnvironmentEntity] {
    store.allEnvironments().map(EnvironmentEntity.init(record:))
  }

  public func suggestedEntities() async throws -> [EnvironmentEntity] {
    store.allEnvironments().map(EnvironmentEntity.init(record:))
  }

  public func entities(matching string: String) async throws -> [EnvironmentEntity] {
    let needle = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return try await allEntities() }
    return store.allEnvironments()
      .filter { $0.label.lowercased().contains(needle) || $0.id.lowercased().contains(needle) }
      .map(EnvironmentEntity.init(record:))
  }
}
