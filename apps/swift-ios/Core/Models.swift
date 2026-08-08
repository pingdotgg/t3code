import Foundation

/// Arrays sent by the server are allowed to grow new element variants before a
/// mobile release catches up. Decode each element independently so one future
/// project, thread, message, or activity cannot discard the rest of a snapshot.
@propertyWrapper
public struct ForwardCompatibleArray<Element>: Codable, Equatable, Sendable
where Element: Codable & Equatable & Sendable {
    public var wrappedValue: [Element]

    public init(wrappedValue: [Element]) {
        self.wrappedValue = wrappedValue
    }

    public init(from decoder: any Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var values: [Element] = []
        values.reserveCapacity(container.count ?? 0)
        while !container.isAtEnd {
            // `superDecoder` advances the unkeyed container even when the
            // element itself is not understood by this client.
            let elementDecoder = try container.superDecoder()
            if let value = try? Element(from: elementDecoder) {
                values.append(value)
            }
        }
        wrappedValue = values
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.unkeyedContainer()
        for value in wrappedValue {
            try container.encode(value)
        }
    }
}

public enum EnvironmentKind: String, Codable, Sendable {
    case bearer
    case local
    case managedDPoP = "managed-dpop"
}

public struct Environment: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var label: String
    public var httpBaseURL: URL
    public var webSocketBaseURL: URL
    public var kind: EnvironmentKind
    public var descriptor: EnvironmentDescriptor?

    public init(
        id: String,
        label: String,
        httpBaseURL: URL,
        webSocketBaseURL: URL,
        kind: EnvironmentKind = .bearer,
        descriptor: EnvironmentDescriptor? = nil
    ) {
        self.id = id
        self.label = label
        self.httpBaseURL = httpBaseURL
        self.webSocketBaseURL = webSocketBaseURL
        self.kind = kind
        self.descriptor = descriptor
    }
}

public struct EnvironmentDescriptor: Codable, Equatable, Sendable {
    public struct Platform: Codable, Equatable, Sendable {
        public let os: String
        public let arch: String
    }

    public struct Capabilities: Codable, Equatable, Sendable {
        public let repositoryIdentity: Bool
        public let connectionProbe: Bool?
        public let threadSettlement: Bool?
        public let threadSnooze: Bool?
        public let threadPinning: Bool?
        public let threadTitleRegeneration: Bool?
        public let serverSelfUpdate: String?
        public let serverSelfUpdateProgress: Bool?

        private enum CodingKeys: String, CodingKey {
            case repositoryIdentity
            case connectionProbe
            case threadSettlement
            case threadSnooze
            case threadPinning
            case threadTitleRegeneration
            case serverSelfUpdate
            case serverSelfUpdateProgress
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            repositoryIdentity =
                try container.decodeIfPresent(Bool.self, forKey: .repositoryIdentity) ?? false
            connectionProbe = try container.decodeIfPresent(Bool.self, forKey: .connectionProbe)
            threadSettlement = try container.decodeIfPresent(Bool.self, forKey: .threadSettlement)
            threadSnooze = try container.decodeIfPresent(Bool.self, forKey: .threadSnooze)
            threadPinning = try container.decodeIfPresent(Bool.self, forKey: .threadPinning)
            threadTitleRegeneration = try container.decodeIfPresent(
                Bool.self,
                forKey: .threadTitleRegeneration
            )
            serverSelfUpdate = try container.decodeIfPresent(String.self, forKey: .serverSelfUpdate)
            serverSelfUpdateProgress = try container.decodeIfPresent(
                Bool.self,
                forKey: .serverSelfUpdateProgress
            )
        }
    }

    public let environmentId: String
    public let label: String
    public let platform: Platform
    public let serverVersion: String
    public let capabilities: Capabilities
}

public enum EnvironmentCredentialAuthorizationMethod: String, Codable, Sendable {
    case bearer
    case dpop
}

public struct EnvironmentCredential: Codable, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible
{
    public let accessToken: String
    public let expiresAt: Date?
    public let scopes: [String]
    public let authorizationMethod: EnvironmentCredentialAuthorizationMethod
    public let managedEnvironmentID: String?
    public let proofKeyThumbprint: String?

    public init(accessToken: String, expiresAt: Date? = nil, scopes: [String] = []) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.scopes = scopes
        authorizationMethod = .bearer
        managedEnvironmentID = nil
        proofKeyThumbprint = nil
    }

    public static func managedDPoP(
        accessToken: String,
        expiresAt: Date,
        scopes: [String],
        environmentID: String,
        proofKeyThumbprint: String
    ) -> EnvironmentCredential {
        EnvironmentCredential(
            accessToken: accessToken,
            expiresAt: expiresAt,
            scopes: scopes,
            authorizationMethod: .dpop,
            managedEnvironmentID: environmentID,
            proofKeyThumbprint: proofKeyThumbprint
        )
    }

    public var description: String {
        "EnvironmentCredential(method: \(authorizationMethod.rawValue), token: <redacted>)"
    }

    public var debugDescription: String { description }

    private init(
        accessToken: String,
        expiresAt: Date?,
        scopes: [String],
        authorizationMethod: EnvironmentCredentialAuthorizationMethod,
        managedEnvironmentID: String?,
        proofKeyThumbprint: String?
    ) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.scopes = scopes
        self.authorizationMethod = authorizationMethod
        self.managedEnvironmentID = managedEnvironmentID
        self.proofKeyThumbprint = proofKeyThumbprint
    }

    private enum CodingKeys: String, CodingKey {
        case accessToken
        case expiresAt
        case scopes
        case authorizationMethod
        case managedEnvironmentID
        case proofKeyThumbprint
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try container.decode(String.self, forKey: .accessToken)
        expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
        scopes = try container.decodeIfPresent([String].self, forKey: .scopes) ?? []
        authorizationMethod = try container.decodeIfPresent(
            EnvironmentCredentialAuthorizationMethod.self,
            forKey: .authorizationMethod
        ) ?? .bearer
        managedEnvironmentID = try container.decodeIfPresent(
            String.self,
            forKey: .managedEnvironmentID
        )
        proofKeyThumbprint = try container.decodeIfPresent(
            String.self,
            forKey: .proofKeyThumbprint
        )

        if authorizationMethod == .dpop {
            guard expiresAt != nil,
                  managedEnvironmentID?.isEmpty == false,
                  proofKeyThumbprint?.isEmpty == false else {
                throw DecodingError.dataCorruptedError(
                    forKey: .authorizationMethod,
                    in: container,
                    debugDescription: "A DPoP credential is missing its binding metadata."
                )
            }
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(accessToken, forKey: .accessToken)
        try container.encodeIfPresent(expiresAt, forKey: .expiresAt)
        try container.encode(scopes, forKey: .scopes)
        try container.encode(authorizationMethod, forKey: .authorizationMethod)
        try container.encodeIfPresent(managedEnvironmentID, forKey: .managedEnvironmentID)
        try container.encodeIfPresent(proofKeyThumbprint, forKey: .proofKeyThumbprint)
    }
}

public struct ModelSelection: Codable, Equatable, Sendable {
    public struct OptionSelection: Codable, Equatable, Sendable {
        public let id: String
        public let value: JSONValue

        public init(id: String, value: JSONValue) {
            self.id = id
            self.value = value
        }
    }

    public let instanceId: String
    public let model: String
    public let options: [OptionSelection]?

    public init(instanceId: String, model: String, options: [OptionSelection]? = nil) {
        self.instanceId = instanceId
        self.model = model
        self.options = options
    }

    private enum CodingKeys: String, CodingKey {
        case instanceId, provider, model, options
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            ?? container.decode(String.self, forKey: .provider)
        model = try container.decode(String.self, forKey: .model)
        if let canonical = try? container.decode([OptionSelection].self, forKey: .options) {
            options = canonical
        } else if let legacy = try? container.decode(
            [String: JSONValue].self,
            forKey: .options
        ) {
            options = legacy.keys.sorted().map { OptionSelection(id: $0, value: legacy[$0]!) }
        } else {
            options = nil
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(instanceId, forKey: .instanceId)
        try container.encode(model, forKey: .model)
        try container.encodeIfPresent(options, forKey: .options)
    }
}

public struct RepositoryIdentity: Codable, Equatable, Sendable {
    public struct Locator: Codable, Equatable, Sendable {
        public let source: String
        public let remoteName: String
        public let remoteUrl: String
    }

    public let canonicalKey: String
    public let locator: Locator
    public let rootPath: String?
    public let displayName: String?
    public let provider: String?
    public let owner: String?
    public let name: String?
}

public struct ProjectScript: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let command: String
    public let icon: String
    public let runOnWorktreeCreate: Bool
    public let previewUrl: String?
    public let autoOpenPreview: Bool?
}

public struct OrchestrationProject: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let workspaceRoot: String
    public let repositoryIdentity: RepositoryIdentity?
    public let defaultModelSelection: ModelSelection?
    public let scripts: [ProjectScript]
    public let createdAt: String
    public let updatedAt: String
    public let deletedAt: String?
}

public enum RuntimeMode: String, Codable, CaseIterable, Sendable {
    case approvalRequired = "approval-required"
    case autoAcceptEdits = "auto-accept-edits"
    case auto
    case fullAccess = "full-access"
}

public enum InteractionMode: String, Codable, CaseIterable, Sendable {
    case `default`
    case plan
}

public struct OrchestrationLatestTurn: Codable, Equatable, Sendable {
    public let turnId: String
    public let state: String
    public let requestedAt: String
    public let startedAt: String?
    public let completedAt: String?
    public let assistantMessageId: String?
}

public struct OrchestrationSession: Codable, Equatable, Sendable {
    public let threadId: String
    public let status: String
    public let providerName: String?
    public let providerInstanceId: String?
    public let runtimeMode: RuntimeMode
    public let activeTurnId: String?
    public let lastError: String?
    public let updatedAt: String
}

public struct OrchestrationThreadShell: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let modelSelection: ModelSelection
    public let runtimeMode: RuntimeMode
    public let interactionMode: InteractionMode
    public let branch: String?
    public let worktreePath: String?
    public let latestTurn: OrchestrationLatestTurn?
    public let createdAt: String
    public let updatedAt: String
    public let archivedAt: String?
    public let settledOverride: String?
    public let settledAt: String?
    public let snoozedUntil: String?
    public let snoozedAt: String?
    public let pinnedAt: String?
    public let session: OrchestrationSession?
    public let latestUserMessageAt: String?
    public let hasPendingApprovals: Bool
    public let hasPendingUserInput: Bool
    public let hasActionableProposedPlan: Bool
}

public struct OrchestrationMessage: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let text: String
    public let attachments: [ChatAttachment]?
    public let turnId: String?
    public let streaming: Bool
    public let createdAt: String
    public let updatedAt: String
}

public struct ChatAttachment: Codable, Identifiable, Equatable, Sendable {
    public let type: String
    public let id: String
    public let name: String
    public let mimeType: String
    public let sizeBytes: Int
}

public struct OrchestrationActivity: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let tone: String
    public let kind: String
    public let summary: String
    public let payload: JSONValue
    public let turnId: String?
    public let sequence: Int?
    public let createdAt: String
}

public struct CheckpointFile: Codable, Equatable, Sendable {
    public let path: String
    public let kind: String
    public let additions: Int
    public let deletions: Int
}

public struct CheckpointSummary: Codable, Equatable, Sendable {
    public let turnId: String
    public let checkpointTurnCount: Int
    public let checkpointRef: String
    public let status: String
    public let files: [CheckpointFile]
    public let assistantMessageId: String?
    public let completedAt: String
}

public struct OrchestrationThread: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let modelSelection: ModelSelection
    public let runtimeMode: RuntimeMode
    public let interactionMode: InteractionMode
    public let branch: String?
    public let worktreePath: String?
    public let latestTurn: OrchestrationLatestTurn?
    public let createdAt: String
    public let updatedAt: String
    public let archivedAt: String?
    public let settledOverride: String?
    public let settledAt: String?
    public let snoozedUntil: String?
    public let snoozedAt: String?
    public let pinnedAt: String?
    public let deletedAt: String?
    @ForwardCompatibleArray public var messages: [OrchestrationMessage]
    @ForwardCompatibleArray public var activities: [OrchestrationActivity]
    @ForwardCompatibleArray public var checkpoints: [CheckpointSummary]
    public let session: OrchestrationSession?
}

public struct OrchestrationShellSnapshot: Codable, Equatable, Sendable {
    public let snapshotSequence: Int
    @ForwardCompatibleArray public var projects: [OrchestrationProject]
    @ForwardCompatibleArray public var threads: [OrchestrationThreadShell]
    public let updatedAt: String
}

public struct OrchestrationReadModel: Codable, Equatable, Sendable {
    public let snapshotSequence: Int
    @ForwardCompatibleArray public var projects: [OrchestrationProject]
    @ForwardCompatibleArray public var threads: [OrchestrationThread]
    public let updatedAt: String
}

public struct OrchestrationThreadDetailSnapshot: Codable, Equatable, Sendable {
    public let snapshotSequence: Int
    public let thread: OrchestrationThread
    public let page: OrchestrationThreadDetailPage?

    public init(
        snapshotSequence: Int,
        thread: OrchestrationThread,
        page: OrchestrationThreadDetailPage? = nil
    ) {
        self.snapshotSequence = snapshotSequence
        self.thread = thread
        self.page = page
    }
}

public struct OrchestrationThreadDetailPage: Codable, Equatable, Sendable {
    public let beforeCursor: String?
    public let hasMore: Bool
    public let snapshotSequence: Int
    public let threadSequence: Int?

    public init(
        beforeCursor: String?,
        hasMore: Bool,
        snapshotSequence: Int,
        threadSequence: Int? = nil
    ) {
        self.beforeCursor = beforeCursor
        self.hasMore = hasMore
        self.snapshotSequence = snapshotSequence
        self.threadSequence = threadSequence
    }
}

public enum ShellStreamItem: Decodable, Sendable {
    case synchronized
    case snapshot(OrchestrationShellSnapshot)
    case projectUpserted(sequence: Int, project: OrchestrationProject)
    case projectRemoved(sequence: Int, projectID: String)
    case threadUpserted(sequence: Int, thread: OrchestrationThreadShell)
    case threadRemoved(sequence: Int, threadID: String)
    /// A newer server emitted a delta this build cannot reduce. The live client
    /// should fetch an authoritative shell snapshot and keep the stream alive.
    case refreshRequired

    private enum CodingKeys: String, CodingKey {
        case kind, sequence, snapshot, project, projectId, thread, threadId
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "synchronized":
            self = .synchronized
        case "snapshot":
            guard let snapshot = try? container.decode(
                OrchestrationShellSnapshot.self,
                forKey: .snapshot
            ) else {
                self = .refreshRequired
                return
            }
            self = .snapshot(snapshot)
        case "project-upserted":
            guard let sequence = try? container.decode(Int.self, forKey: .sequence),
                  let project = try? container.decode(
                      OrchestrationProject.self,
                      forKey: .project
                  ) else {
                self = .refreshRequired
                return
            }
            self = .projectUpserted(
                sequence: sequence,
                project: project
            )
        case "project-removed":
            guard let sequence = try? container.decode(Int.self, forKey: .sequence),
                  let projectID = try? container.decode(String.self, forKey: .projectId) else {
                self = .refreshRequired
                return
            }
            self = .projectRemoved(
                sequence: sequence,
                projectID: projectID
            )
        case "thread-upserted":
            guard let sequence = try? container.decode(Int.self, forKey: .sequence),
                  let thread = try? container.decode(
                      OrchestrationThreadShell.self,
                      forKey: .thread
                  ) else {
                self = .refreshRequired
                return
            }
            self = .threadUpserted(
                sequence: sequence,
                thread: thread
            )
        case "thread-removed":
            guard let sequence = try? container.decode(Int.self, forKey: .sequence),
                  let threadID = try? container.decode(String.self, forKey: .threadId) else {
                self = .refreshRequired
                return
            }
            self = .threadRemoved(
                sequence: sequence,
                threadID: threadID
            )
        default:
            self = .refreshRequired
        }
    }
}

public enum ThreadStreamItem: Decodable, Sendable {
    case synchronized
    case snapshot(OrchestrationThreadDetailSnapshot)
    case event(JSONValue)

    private enum CodingKeys: String, CodingKey { case kind, snapshot, event }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "synchronized":
            self = .synchronized
        case "snapshot":
            guard let snapshot = try? container.decode(
                OrchestrationThreadDetailSnapshot.self,
                forKey: .snapshot
            ) else {
                self = .event(.null)
                return
            }
            self = .snapshot(snapshot)
        case "event":
            self = .event((try? container.decode(JSONValue.self, forKey: .event)) ?? .null)
        default:
            // The detail reducer already treats an unrecognized event as an
            // authoritative-refresh request. Reuse that path without adding a
            // second stream state or terminating the subscription.
            self = .event(.null)
        }
    }
}
