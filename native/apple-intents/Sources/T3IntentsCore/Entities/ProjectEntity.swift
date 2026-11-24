import AppIntents
import CoreSpotlight
import Foundation

@available(iOS 27.3, macOS 27.3, *)
public struct ProjectEntity: AppEntity, IndexedEntity, URLRepresentableEntity, Sendable {
  public static let typeDisplayRepresentation = TypeDisplayRepresentation(
    name: LocalizedStringResource("Project"),
    numericFormat: LocalizedStringResource("\(placeholder: .int) projects")
  )

  public static let defaultQuery = ProjectEntityQuery()

  public static var urlRepresentation: URLRepresentation {
    "t3code://new?environmentId=\(\.$environmentId)&projectId=\(\.$projectId)"
  }

  public let id: String

  @Property(
    title: "Environment ID",
    description: "Internal identifier of the T3 Code host environment owning this project.",
    visibility: .internal
  )
  public var environmentId: String

  @Property(
    title: "Project ID",
    description: "Internal identifier of this project within its T3 Code environment.",
    visibility: .internal
  )
  public var projectId: String

  @Property(
    title: "Name",
    description: "Name of this coding project or workspace.",
    indexingKey: \.displayName
  )
  public var name: String

  @Property(
    title: "Workspace Path",
    description: "Directory path of this project on its host machine.",
    indexingKey: \.path
  )
  public var workspaceRoot: String

  @Property(
    title: "Repository",
    description: "Canonical Git repository identifier such as github.com/owner/repo.",
    indexingKey: \.contentDescription
  )
  public var repositoryIdentity: String?

  @Property(
    title: "Branch",
    description: "Active Git branch in this project."
  )
  public var branch: String?

  public var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: LocalizedStringResource(stringLiteral: name),
      subtitle: LocalizedStringResource(stringLiteral: repositoryIdentity ?? workspaceRoot),
      image: .init(systemName: "folder.fill")
    )
  }

  public var attributeSet: CSSearchableItemAttributeSet {
    let attrs = CSSearchableItemAttributeSet(contentType: .folder)
    attrs.displayName = name
    attrs.title = name
    attrs.path = workspaceRoot
    attrs.contentDescription = repositoryIdentity ?? workspaceRoot
    var keywords = [name, "T3 Code", "project"]
    if let repositoryIdentity { keywords.append(repositoryIdentity) }
    if let branch { keywords.append(branch) }
    attrs.keywords = keywords
    attrs.domainIdentifier = "\(T3IntentsConfig.spotlightDomainPrefix).project"
    return attrs
  }

  public init(record: T3ProjectRecord) {
    self.id = record.id
    self.environmentId = record.environmentId
    self.projectId = record.projectId
    self.name = record.name
    self.workspaceRoot = record.workspaceRoot
    self.repositoryIdentity = record.repositoryIdentity
    self.branch = record.branch
  }
}

@available(iOS 27.3, macOS 27.3, *)
public struct ProjectEntityQuery: IndexedEntityQuery, EnumerableEntityQuery, EntityStringQuery, Sendable {
  @Dependency
  private var store: T3IndexStore

  public init() {}

  public func entities(for identifiers: [ProjectEntity.ID]) async throws -> [ProjectEntity] {
    store.projects(for: identifiers).map(ProjectEntity.init(record:))
  }

  public func allEntities() async throws -> [ProjectEntity] {
    store.allProjects().map(ProjectEntity.init(record:))
  }

  public func suggestedEntities() async throws -> [ProjectEntity] {
    Array(store.allProjects().prefix(15)).map(ProjectEntity.init(record:))
  }

  public func entities(matching string: String) async throws -> [ProjectEntity] {
    store.searchProjects(matching: string).map(ProjectEntity.init(record:))
  }

  public func reindexEntities(
    for identifiers: [ProjectEntity.ID],
    indexDescription: CSSearchableIndexDescription
  ) async throws {
    let store = store
    try await T3IndexOperationQueue.run {
      let entities = store.projects(for: identifiers).map(ProjectEntity.init(record:))
      try await CSSearchableIndex.default().indexAppEntities(entities)
    }
  }

  public func reindexAllEntities(indexDescription: CSSearchableIndexDescription) async throws {
    let store = store
    try await T3IndexOperationQueue.run {
      let entities = store.allProjects().map(ProjectEntity.init(record:))
      try await CSSearchableIndex.default().indexAppEntities(entities)
    }
  }
}
