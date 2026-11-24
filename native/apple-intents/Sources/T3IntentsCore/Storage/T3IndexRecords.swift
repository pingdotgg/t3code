import Foundation

public struct T3EnvironmentRecord: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let label: String
  public let httpBaseUrl: String?
  public let isLocal: Bool
  public let isConnected: Bool
  public let updatedAt: String

  public init(
    id: String,
    label: String,
    httpBaseUrl: String?,
    isLocal: Bool,
    isConnected: Bool,
    updatedAt: String
  ) {
    self.id = id
    self.label = label
    self.httpBaseUrl = httpBaseUrl
    self.isLocal = isLocal
    self.isConnected = isConnected
    self.updatedAt = updatedAt
  }
}

public struct T3ProjectRecord: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let environmentId: String
  public let projectId: String
  public let name: String
  public let workspaceRoot: String
  public let repositoryIdentity: String?
  public let branch: String?
  public let updatedAt: String
  public let deepLinkUrl: String

  public init(
    id: String,
    environmentId: String,
    projectId: String,
    name: String,
    workspaceRoot: String,
    repositoryIdentity: String?,
    branch: String?,
    updatedAt: String,
    deepLinkUrl: String
  ) {
    self.id = id
    self.environmentId = environmentId
    self.projectId = projectId
    self.name = name
    self.workspaceRoot = workspaceRoot
    self.repositoryIdentity = repositoryIdentity
    self.branch = branch
    self.updatedAt = updatedAt
    self.deepLinkUrl = deepLinkUrl
  }
}

public struct T3ThreadRecord: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let environmentId: String
  public let threadId: String
  public let projectId: String
  public let projectName: String
  public let title: String
  public let branch: String?
  public let status: String
  public let hasPendingRequest: Bool
  public let pendingRequestSummary: String?
  public let isPinned: Bool
  public let isSettled: Bool
  public let isSnoozed: Bool
  public let snoozedUntil: String?
  public let lastMessagePreview: String?
  public let providerLabel: String?
  public let modelLabel: String?
  public let updatedAt: String
  public let deepLinkUrl: String

  public init(
    id: String,
    environmentId: String,
    threadId: String,
    projectId: String,
    projectName: String,
    title: String,
    branch: String?,
    status: String,
    hasPendingRequest: Bool,
    pendingRequestSummary: String?,
    isPinned: Bool,
    isSettled: Bool,
    isSnoozed: Bool,
    snoozedUntil: String?,
    lastMessagePreview: String?,
    providerLabel: String?,
    modelLabel: String?,
    updatedAt: String,
    deepLinkUrl: String
  ) {
    self.id = id
    self.environmentId = environmentId
    self.threadId = threadId
    self.projectId = projectId
    self.projectName = projectName
    self.title = title
    self.branch = branch
    self.status = status
    self.hasPendingRequest = hasPendingRequest
    self.pendingRequestSummary = pendingRequestSummary
    self.isPinned = isPinned
    self.isSettled = isSettled
    self.isSnoozed = isSnoozed
    self.snoozedUntil = snoozedUntil
    self.lastMessagePreview = lastMessagePreview
    self.providerLabel = providerLabel
    self.modelLabel = modelLabel
    self.updatedAt = updatedAt
    self.deepLinkUrl = deepLinkUrl
  }
}

public struct T3IndexDelta: Codable, Sendable {
  public let environments: [T3EnvironmentRecord]
  public let removedEnvironmentIds: [String]
  public let upsertedProjects: [T3ProjectRecord]
  public let removedProjectIds: [String]
  public let upsertedThreads: [T3ThreadRecord]
  public let removedThreadIds: [String]

  public init(
    environments: [T3EnvironmentRecord] = [],
    removedEnvironmentIds: [String] = [],
    upsertedProjects: [T3ProjectRecord] = [],
    removedProjectIds: [String] = [],
    upsertedThreads: [T3ThreadRecord] = [],
    removedThreadIds: [String] = []
  ) {
    self.environments = environments
    self.removedEnvironmentIds = removedEnvironmentIds
    self.upsertedProjects = upsertedProjects
    self.removedProjectIds = removedProjectIds
    self.upsertedThreads = upsertedThreads
    self.removedThreadIds = removedThreadIds
  }
}

public struct T3AuthCredentialRecord: Codable, Sendable, Hashable {
  public let environmentId: String
  public let httpBaseUrl: String
  public let accessToken: String
  public let authScheme: String
  public let dpopKeyRef: String?

  public init(
    environmentId: String,
    httpBaseUrl: String,
    accessToken: String,
    authScheme: String,
    dpopKeyRef: String? = nil
  ) {
    self.environmentId = environmentId
    self.httpBaseUrl = httpBaseUrl
    self.accessToken = accessToken
    self.authScheme = authScheme
    self.dpopKeyRef = dpopKeyRef
  }
}

public struct T3OnscreenContextRecord: Codable, Sendable, Hashable {
  public let kind: String
  public let environmentId: String
  public let threadId: String?
  public let projectId: String?
  public let title: String
  public let deepLinkUrl: String

  public var compositeEntityId: String? {
    if kind == "thread", let threadId {
      return "\(environmentId):\(threadId)"
    }
    if kind == "project", let projectId {
      return "\(environmentId):\(projectId)"
    }
    return nil
  }
}

public struct T3SpotlightDiff: Sendable {
  public let upsertedProjects: [T3ProjectRecord]
  public let removedProjectIds: [String]
  public let upsertedThreads: [T3ThreadRecord]
  public let removedThreadIds: [String]

  public init(
    upsertedProjects: [T3ProjectRecord],
    removedProjectIds: [String],
    upsertedThreads: [T3ThreadRecord],
    removedThreadIds: [String]
  ) {
    self.upsertedProjects = upsertedProjects
    self.removedProjectIds = removedProjectIds
    self.upsertedThreads = upsertedThreads
    self.removedThreadIds = removedThreadIds
  }
}
