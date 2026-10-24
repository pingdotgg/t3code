import Foundation

public enum ProjectClonePhase: String, Codable, Sendable {
    case running, done, failed, cancelled
}

public enum ProjectCloneStage: String, Codable, Sendable {
    case connecting, counting, receiving, resolving, checkout

    public var label: String {
        switch self {
        case .connecting: "Connecting"
        case .counting: "Counting objects"
        case .receiving: "Receiving objects"
        case .resolving: "Resolving deltas"
        case .checkout: "Checking out files"
        }
    }
}

public struct ProjectCloneSnapshot: Codable, Equatable, Sendable {
    public let projectId: String
    public let remoteUrl: String
    public let destinationPath: String
    public let repository: SourceControlRepositoryInfo?
    public let phase: ProjectClonePhase
    public let stage: ProjectCloneStage
    public let percent: Int?
    public let detail: String?
    public let error: String?
    public let startedAt: String
    public let endedAt: String?
    public let sequence: Int

    public var displayName: String {
        repository?.nameWithOwner
            ?? destinationPath.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init)
            ?? destinationPath
    }

    public var progressSummary: String {
        ([stage.label] + (percent.map { ["\($0)%"] } ?? [])
            + (detail.flatMap { $0.isEmpty ? nil : [$0] } ?? [])).joined(separator: " · ")
    }
}

public struct ProjectCloneStartInput: Codable, Equatable, Sendable {
    public let projectId: String
    public let title: String
    public let createdAt: String
    public let remoteUrl: String
    public let destinationPath: String
}

public struct ProjectCloneStartResult: Codable, Equatable, Sendable {
    public let projectId: String
    public let cwd: String
    public let remoteUrl: String
    public let repository: SourceControlRepositoryInfo?
}

public enum ProjectCloneAction: String, Sendable {
    case cancel = "projectClone.cancel"
    case retry = "projectClone.retry"
}

public struct ProjectCloneActionResult: Codable, Equatable, Sendable {
    public let applied: Bool
}
