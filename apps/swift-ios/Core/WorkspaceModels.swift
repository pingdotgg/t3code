import Foundation

// MARK: - Project files

public enum ProjectEntryKind: String, Codable, Sendable {
    case file
    case directory
}

public struct ProjectEntry: Codable, Equatable, Sendable {
    public let path: String
    public let kind: ProjectEntryKind
}

public struct ProjectEntriesResult: Codable, Equatable, Sendable {
    public let entries: [ProjectEntry]
    public let truncated: Bool
}

public struct ProjectReadFileResult: Codable, Equatable, Sendable {
    public let relativePath: String
    public let contents: String
    public let byteLength: Int
    public let truncated: Bool
}

public struct ProjectWriteFileResult: Codable, Equatable, Sendable {
    public let relativePath: String
}

public struct ThreadWorktreePreparation: Equatable, Sendable {
    public let projectCwd: String
    public let baseBranch: String
    public let branch: String
    public let startFromOrigin: Bool

    public init(
        projectCwd: String,
        baseBranch: String,
        branch: String,
        startFromOrigin: Bool
    ) {
        self.projectCwd = projectCwd
        self.baseBranch = baseBranch
        self.branch = branch
        self.startFromOrigin = startFromOrigin
    }
}

public struct FilesystemBrowseEntry: Codable, Equatable, Sendable {
    public let name: String
    public let fullPath: String
}

public struct FilesystemBrowseResult: Codable, Equatable, Sendable {
    public let parentPath: String
    public let entries: [FilesystemBrowseEntry]
}

// MARK: - Source control and VCS

public enum SourceControlProviderKind: String, Codable, CaseIterable, Sendable {
    case github
    case gitlab
    case azureDevOps = "azure-devops"
    case bitbucket
    case unknown
}

public struct SourceControlProviderInfo: Codable, Equatable, Sendable {
    public let kind: SourceControlProviderKind
    public let name: String
    public let baseUrl: String
}

public struct SourceControlRepositoryInfo: Codable, Equatable, Sendable {
    public let provider: SourceControlProviderKind
    public let nameWithOwner: String
    public let url: String
    public let sshUrl: String
}

public struct SourceControlCloneResult: Codable, Equatable, Sendable {
    public let cwd: String
    public let remoteUrl: String
    public let repository: SourceControlRepositoryInfo?
}

public struct SourceControlPublishResult: Codable, Equatable, Sendable {
    public let repository: SourceControlRepositoryInfo
    public let remoteName: String
    public let remoteUrl: String
    public let branch: String
    public let upstreamBranch: String?
    public let status: String
}

public enum SourceControlDiscoveryStatus: String, Codable, Sendable {
    case available
    case missing
}

public enum SourceControlProviderAuthStatus: String, Codable, Sendable {
    case authenticated
    case unauthenticated
    case unknown
}

public struct SourceControlProviderAuth: Decodable, Equatable, Sendable {
    public let status: SourceControlProviderAuthStatus
    public let account: String?
    public let host: String?
    public let detail: String?

    private enum CodingKeys: String, CodingKey {
        case status
        case account
        case host
        case detail
    }

    public init(
        status: SourceControlProviderAuthStatus,
        account: String? = nil,
        host: String? = nil,
        detail: String? = nil
    ) {
        self.status = status
        self.account = account
        self.host = host
        self.detail = detail
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(SourceControlProviderAuthStatus.self, forKey: .status)
        account = try container.decodeEffectOptionalString(forKey: .account)
        host = try container.decodeEffectOptionalString(forKey: .host)
        detail = try container.decodeEffectOptionalString(forKey: .detail)
    }
}

public struct SourceControlVCSDiscoveryItem: Decodable, Equatable, Sendable {
    public let kind: String
    public let label: String
    public let executable: String?
    public let implemented: Bool
    public let status: SourceControlDiscoveryStatus
    public let version: String?
    public let installHint: String
    public let detail: String?

    private enum CodingKeys: String, CodingKey {
        case kind
        case label
        case executable
        case implemented
        case status
        case version
        case installHint
        case detail
    }

    public init(
        kind: String,
        label: String,
        executable: String? = nil,
        implemented: Bool,
        status: SourceControlDiscoveryStatus,
        version: String? = nil,
        installHint: String,
        detail: String? = nil
    ) {
        self.kind = kind
        self.label = label
        self.executable = executable
        self.implemented = implemented
        self.status = status
        self.version = version
        self.installHint = installHint
        self.detail = detail
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        label = try container.decode(String.self, forKey: .label)
        executable = try container.decodeIfPresent(String.self, forKey: .executable)
        implemented = try container.decode(Bool.self, forKey: .implemented)
        status = try container.decode(SourceControlDiscoveryStatus.self, forKey: .status)
        version = try container.decodeEffectOptionalString(forKey: .version)
        installHint = try container.decode(String.self, forKey: .installHint)
        detail = try container.decodeEffectOptionalString(forKey: .detail)
    }
}

public struct SourceControlProviderDiscoveryItem: Decodable, Equatable, Sendable {
    public let kind: SourceControlProviderKind
    public let label: String
    public let executable: String?
    public let status: SourceControlDiscoveryStatus
    public let version: String?
    public let installHint: String
    public let detail: String?
    public let auth: SourceControlProviderAuth

    private enum CodingKeys: String, CodingKey {
        case kind
        case label
        case executable
        case status
        case version
        case installHint
        case detail
        case auth
    }

    public init(
        kind: SourceControlProviderKind,
        label: String,
        executable: String? = nil,
        status: SourceControlDiscoveryStatus,
        version: String? = nil,
        installHint: String,
        detail: String? = nil,
        auth: SourceControlProviderAuth
    ) {
        self.kind = kind
        self.label = label
        self.executable = executable
        self.status = status
        self.version = version
        self.installHint = installHint
        self.detail = detail
        self.auth = auth
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(SourceControlProviderKind.self, forKey: .kind)
        label = try container.decode(String.self, forKey: .label)
        executable = try container.decodeIfPresent(String.self, forKey: .executable)
        status = try container.decode(SourceControlDiscoveryStatus.self, forKey: .status)
        version = try container.decodeEffectOptionalString(forKey: .version)
        installHint = try container.decode(String.self, forKey: .installHint)
        detail = try container.decodeEffectOptionalString(forKey: .detail)
        auth = try container.decode(SourceControlProviderAuth.self, forKey: .auth)
    }
}

public struct SourceControlDiscoveryResult: Decodable, Equatable, Sendable {
    public let versionControlSystems: [SourceControlVCSDiscoveryItem]
    public let sourceControlProviders: [SourceControlProviderDiscoveryItem]

    public init(
        versionControlSystems: [SourceControlVCSDiscoveryItem],
        sourceControlProviders: [SourceControlProviderDiscoveryItem]
    ) {
        self.versionControlSystems = versionControlSystems
        self.sourceControlProviders = sourceControlProviders
    }
}

private struct EffectOptionalString: Decodable {
    let value: String?

    private enum CodingKeys: String, CodingKey {
        case _tag
        case value
    }

    init(from decoder: any Decoder) throws {
        let singleValue = try decoder.singleValueContainer()
        if singleValue.decodeNil() {
            value = nil
            return
        }
        if let direct = try? singleValue.decode(String.self) {
            value = direct
            return
        }

        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: ._tag) {
        case "Some":
            value = try container.decode(String.self, forKey: .value)
        case "None":
            value = nil
        case let tag:
            throw DecodingError.dataCorruptedError(
                forKey: ._tag,
                in: container,
                debugDescription: "Unknown Effect Option tag \(tag)"
            )
        }
    }
}

private extension KeyedDecodingContainer {
    func decodeEffectOptionalString(forKey key: Key) throws -> String? {
        guard contains(key), try !decodeNil(forKey: key) else { return nil }
        return try decode(EffectOptionalString.self, forKey: key).value
    }
}

public struct VCSWorkingTreeFile: Codable, Equatable, Sendable {
    public let path: String
    public let insertions: Int
    public let deletions: Int
}

public struct VCSWorkingTree: Codable, Equatable, Sendable {
    public let files: [VCSWorkingTreeFile]
    public let insertions: Int
    public let deletions: Int
}

public struct VCSChangeRequest: Codable, Equatable, Sendable {
    public let number: Int
    public let title: String
    public let url: String
    public let baseRef: String
    public let headRef: String
    public let state: String
}

public struct VCSLocalStatus: Codable, Equatable, Sendable {
    public let isRepo: Bool
    public let sourceControlProvider: SourceControlProviderInfo?
    public let hasPrimaryRemote: Bool
    public let isDefaultRef: Bool
    public let refName: String?
    public let hasWorkingTreeChanges: Bool
    public let workingTree: VCSWorkingTree
}

public struct VCSRemoteStatus: Codable, Equatable, Sendable {
    public let hasUpstream: Bool
    public let aheadCount: Int
    public let behindCount: Int
    public let aheadOfDefaultCount: Int?
    public let pr: VCSChangeRequest?
}

public struct VCSStatus: Codable, Equatable, Sendable {
    public let isRepo: Bool
    public let sourceControlProvider: SourceControlProviderInfo?
    public let hasPrimaryRemote: Bool
    public let isDefaultRef: Bool
    public let refName: String?
    public let hasWorkingTreeChanges: Bool
    public let workingTree: VCSWorkingTree
    public let hasUpstream: Bool
    public let aheadCount: Int
    public let behindCount: Int
    public let aheadOfDefaultCount: Int?
    public let pr: VCSChangeRequest?
}

public enum VCSStatusEvent: Decodable, Sendable {
    case snapshot(local: VCSLocalStatus, remote: VCSRemoteStatus?)
    case localUpdated(VCSLocalStatus)
    case remoteUpdated(VCSRemoteStatus?)

    private enum CodingKeys: String, CodingKey { case _tag, local, remote }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let tag = try container.decode(String.self, forKey: ._tag)
        switch tag {
        case "snapshot":
            self = .snapshot(
                local: try container.decode(VCSLocalStatus.self, forKey: .local),
                remote: try container.decodeIfPresent(VCSRemoteStatus.self, forKey: .remote)
            )
        case "localUpdated":
            self = .localUpdated(try container.decode(VCSLocalStatus.self, forKey: .local))
        case "remoteUpdated":
            self = .remoteUpdated(
                try container.decodeIfPresent(VCSRemoteStatus.self, forKey: .remote)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: ._tag,
                in: container,
                debugDescription: "Unknown VCS status event \(tag)"
            )
        }
    }
}

public struct VCSRef: Codable, Equatable, Sendable {
    public let name: String
    public let isRemote: Bool?
    public let remoteName: String?
    public let current: Bool
    public let isDefault: Bool
    public let worktreePath: String?
}

public struct VCSRefsResult: Codable, Equatable, Sendable {
    public let refs: [VCSRef]
    public let isRepo: Bool
    public let hasPrimaryRemote: Bool
    public let nextCursor: Int?
    public let totalCount: Int
}

public struct VCSPullResult: Codable, Equatable, Sendable {
    public let status: String
    public let refName: String
    public let upstreamRef: String?
}

public struct VCSCreateRefResult: Codable, Equatable, Sendable {
    public let refName: String
}

public struct VCSSwitchRefResult: Codable, Equatable, Sendable {
    public let refName: String?
}

public struct VCSWorktree: Codable, Equatable, Sendable {
    public let path: String
    public let refName: String
}

public struct VCSCreateWorktreeResult: Codable, Equatable, Sendable {
    public let worktree: VCSWorktree
}

public enum GitStackedAction: String, Codable, CaseIterable, Sendable {
    case commit
    case push
    case createPullRequest = "create_pr"
    case commitAndPush = "commit_push"
    case commitPushAndPullRequest = "commit_push_pr"
}

public struct GitActionResult: Codable, Equatable, Sendable {
    public struct Branch: Codable, Equatable, Sendable {
        public let status: String
        public let name: String?
    }

    public struct Commit: Codable, Equatable, Sendable {
        public let status: String
        public let commitSha: String?
        public let subject: String?
    }

    public struct Push: Codable, Equatable, Sendable {
        public let status: String
        public let branch: String?
        public let upstreamBranch: String?
        public let setUpstream: Bool?
    }

    public struct PullRequest: Codable, Equatable, Sendable {
        public let status: String
        public let url: String?
        public let number: Int?
        public let baseBranch: String?
        public let headBranch: String?
        public let title: String?
    }

    public let action: GitStackedAction
    public let branch: Branch
    public let commit: Commit
    public let push: Push
    public let pr: PullRequest
    public let toast: JSONValue
}

public struct GitActionProgressEvent: Codable, Equatable, Sendable {
    public let actionId: String
    public let cwd: String
    public let action: GitStackedAction
    public let kind: String
    public let phases: [String]?
    public let phase: String?
    public let label: String?
    public let hookName: String?
    public let stream: String?
    public let text: String?
    public let exitCode: Int?
    public let durationMs: Int?
    public let result: GitActionResult?
    public let message: String?
}

// MARK: - Review

public struct ReviewDiffSource: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let title: String
    public let baseRef: String?
    public let headRef: String?
    public let diff: String
    public let diffHash: String
    public let truncated: Bool
}

public struct ReviewDiffPreview: Codable, Equatable, Sendable {
    public let cwd: String
    public let generatedAt: String
    public let sources: [ReviewDiffSource]
}

public struct ReviewDiffFileContents: Codable, Equatable, Sendable {
    public let oldContents: String
    public let newContents: String
}

// MARK: - Terminal

public enum TerminalSessionStatus: String, Codable, Sendable {
    case starting
    case running
    case exited
    case error
}

public struct TerminalSessionSnapshot: Codable, Equatable, Sendable {
    public let threadId: String
    public let terminalId: String
    public let cwd: String
    public let worktreePath: String?
    public let status: TerminalSessionStatus
    public let pid: Int?
    public let history: String
    public let exitCode: Int?
    public let exitSignal: Int?
    public let label: String
    public let updatedAt: String
    public let sequence: Int?
}

public struct TerminalSummary: Codable, Equatable, Sendable {
    public let threadId: String
    public let terminalId: String
    public let cwd: String
    public let worktreePath: String?
    public let status: TerminalSessionStatus
    public let pid: Int?
    public let exitCode: Int?
    public let exitSignal: Int?
    public let hasRunningSubprocess: Bool
    public let label: String
    public let updatedAt: String
}

public struct TerminalEvent: Codable, Equatable, Sendable {
    public let type: String
    public let threadId: String?
    public let terminalId: String?
    public let sequence: Int?
    public let snapshot: TerminalSessionSnapshot?
    public let data: String?
    public let exitCode: Int?
    public let exitSignal: Int?
    public let message: String?
    public let hasRunningSubprocess: Bool?
    public let label: String?
}

public struct TerminalMetadataEvent: Codable, Equatable, Sendable {
    public let type: String
    public let terminals: [TerminalSummary]?
    public let terminal: TerminalSummary?
    public let threadId: String?
    public let terminalId: String?
}
