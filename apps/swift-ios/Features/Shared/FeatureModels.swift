import Foundation

public struct FeatureConnection: Sendable, Equatable, Codable {
    public enum State: String, Sendable, Hashable, Codable {
        case disconnected
        case connecting
        case connected
        case reconnecting
    }

    public var state: State
    public var environmentName: String?
    public var endpoint: String?
    public var detail: String?

    public init(
        state: State = .disconnected,
        environmentName: String? = nil,
        endpoint: String? = nil,
        detail: String? = nil
    ) {
        self.state = state
        self.environmentName = environmentName
        self.endpoint = endpoint
        self.detail = detail
    }
}

public struct FeatureEnvironment: Identifiable, Sendable, Equatable, Hashable, Codable {
    public enum Source: String, Sendable, Equatable, Hashable, Codable {
        case direct
        case t3Connect
    }

    public let id: String
    public var name: String
    public var endpoint: String
    /// Internal stream-leader compatibility. Product routing must use the
    /// project or thread environment instead.
    public var isActive: Bool
    public var isEnabled: Bool
    public var source: Source
    /// Reachability from the latest aggregate refresh. `nil` means the client
    /// has not probed this saved environment yet.
    public var connectionState: FeatureConnection.State?
    public var connectionDetail: String?
    public var machineIcon: String? = nil
    public var canCustomizeIcon: Bool? = nil

    public var systemImage: String {
        switch machineIcon {
        case "cloud": "cloud"
        case "desktop": "desktopcomputer"
        case "laptop": "laptopcomputer"
        case "mac-mini": "macmini"
        case "mac-studio": "macstudio"
        default: "server.rack"
        }
    }

    public init(
        id: String,
        name: String,
        endpoint: String,
        isActive: Bool = false,
        isEnabled: Bool = true,
        source: Source = .direct,
        connectionState: FeatureConnection.State? = nil,
        connectionDetail: String? = nil
    ) {
        self.id = id
        self.name = name
        self.endpoint = endpoint
        self.isActive = isActive
        self.isEnabled = isEnabled
        self.source = source
        self.connectionState = connectionState
        self.connectionDetail = connectionDetail
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case endpoint
        case isActive
        case isEnabled
        case source
        case connectionState
        case connectionDetail
        case machineIcon
        case canCustomizeIcon
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        endpoint = try container.decode(String.self, forKey: .endpoint)
        isActive = try container.decodeIfPresent(Bool.self, forKey: .isActive) ?? false
        isEnabled = try container.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? true
        source = try container.decodeIfPresent(Source.self, forKey: .source) ?? .direct
        connectionState = try container.decodeIfPresent(
            FeatureConnection.State.self,
            forKey: .connectionState
        )
        connectionDetail = try container.decodeIfPresent(String.self, forKey: .connectionDetail)
        machineIcon = try container.decodeIfPresent(String.self, forKey: .machineIcon)
        canCustomizeIcon = try container.decodeIfPresent(Bool.self, forKey: .canCustomizeIcon)
    }
}

public struct FeatureRepositoryIdentity: Sendable, Equatable, Hashable, Codable {
    public var canonicalKey: String
    public var rootPath: String?
    public var displayName: String?
    public var name: String?

    public init(
        canonicalKey: String,
        rootPath: String? = nil,
        displayName: String? = nil,
        name: String? = nil
    ) {
        self.canonicalKey = canonicalKey
        self.rootPath = rootPath
        self.displayName = displayName
        self.name = name
    }
}

public struct FeatureProject: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    /// The environment-local identifier sent over the wire. Native aggregate
    /// snapshots scope `id` by environment so cloned databases remain distinct.
    public var wireID: String?
    public var environmentID: String
    public var name: String
    public var path: String
    public var threadCount: Int
    public var defaultSelection: FeatureSelection?
    public var repositoryIdentity: FeatureRepositoryIdentity?
    public var createdAt: String?
    public var updatedAt: String?
    public var projectIcon: ProjectIconOverride? = nil

    public init(
        id: String,
        wireID: String? = nil,
        environmentID: String,
        name: String,
        path: String,
        threadCount: Int = 0,
        defaultSelection: FeatureSelection? = nil,
        repositoryIdentity: FeatureRepositoryIdentity? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.wireID = wireID
        self.environmentID = environmentID
        self.name = name
        self.path = path
        self.threadCount = threadCount
        self.defaultSelection = defaultSelection
        self.repositoryIdentity = repositoryIdentity
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public enum FeatureThreadState: String, Sendable, Codable {
    case idle
    case queued
    case working
    case monitoring
    case waitingForApproval
    case waitingForInput
    case failed
    case completed
}

public enum FeatureRuntimeMode: String, CaseIterable, Sendable, Codable {
    case approvalRequired
    case autoAcceptEdits
    case automatic
    case fullAccess

    /// Mobile offers the two current modes. Legacy modes remain distinct so
    /// existing threads keep their exact server permission.
    public static let allCases: [FeatureRuntimeMode] = [.automatic, .fullAccess]
}

public enum FeatureInteractionMode: String, CaseIterable, Sendable, Codable {
    case standard
    case plan

    /// Plan remains decodable for existing server state, but is no longer a
    /// mobile prompt choice.
    public static let allCases: [FeatureInteractionMode] = [.standard]

    public var mobileNormalized: FeatureInteractionMode { .standard }
}

public enum FeatureThreadSettlementOverride: String, Sendable, Equatable, Hashable, Codable {
    case settled
    case active
}

public struct FeatureThreadSettlementFacts: Sendable, Equatable, Hashable, Codable {
    public struct LatestTurn: Sendable, Equatable, Hashable, Codable {
        public var requestedAt: Date?
        public var startedAt: Date?
        public var completedAt: Date?
        public var requestedAtIsInvalid: Bool
        public var startedAtIsInvalid: Bool
        public var completedAtIsInvalid: Bool

        public init(
            requestedAt: Date? = nil,
            startedAt: Date? = nil,
            completedAt: Date? = nil,
            requestedAtIsInvalid: Bool = false,
            startedAtIsInvalid: Bool = false,
            completedAtIsInvalid: Bool = false
        ) {
            self.requestedAt = requestedAt
            self.startedAt = startedAt
            self.completedAt = completedAt
            self.requestedAtIsInvalid = requestedAtIsInvalid
            self.startedAtIsInvalid = startedAtIsInvalid
            self.completedAtIsInvalid = completedAtIsInvalid
        }
    }

    public var settlementOverride: FeatureThreadSettlementOverride?
    public var sessionStatus: String?
    public var hasPendingApprovals: Bool
    public var hasPendingUserInput: Bool
    public var latestUserMessageAt: Date?
    public var latestTurn: LatestTurn?

    public init(
        settlementOverride: FeatureThreadSettlementOverride? = nil,
        sessionStatus: String? = nil,
        hasPendingApprovals: Bool = false,
        hasPendingUserInput: Bool = false,
        latestUserMessageAt: Date? = nil,
        latestTurn: LatestTurn? = nil
    ) {
        self.settlementOverride = settlementOverride
        self.sessionStatus = sessionStatus
        self.hasPendingApprovals = hasPendingApprovals
        self.hasPendingUserInput = hasPendingUserInput
        self.latestUserMessageAt = latestUserMessageAt
        self.latestTurn = latestTurn
    }
}

public struct FeatureThread: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    /// The environment-local identifier sent over the wire.
    public var wireID: String?
    public var projectID: String
    public var environmentID: String?
    public var environmentName: String?
    public var title: String
    public var preview: String?
    public var branch: String?
    public var worktreePath: String?
    public var linkedPullRequest: ThreadLinkedPullRequest?
    public var createdAt: Date
    public var updatedAt: Date
    public var state: FeatureThreadState
    public var providerID: String?
    public var providerName: String?
    public var modelID: String?
    public var modelOptions: [FeatureModelOptionSelection]
    public var isArchived: Bool
    public var isSettled: Bool
    public var keepsActive: Bool
    public var settledAt: Date?
    public var unsettledAt: Date?
    public var lastActivityAt: Date?
    public var snoozedUntil: Date?
    public var snoozedAt: Date?
    public var pinnedAt: Date?
    public var supportsSettlement: Bool?
    public var supportsSnooze: Bool?
    public var supportsPinning: Bool?
    public var supportsTitleRegeneration: Bool?
    public var supportsPullRequestLinking: Bool?
    public var attentionAt: Date?
    public var workingStartedAt: Date?
    public var latestTurnCompletedAt: Date?
    public var settlementFacts: FeatureThreadSettlementFacts?
    public var runtimeMode: FeatureRuntimeMode
    public var interactionMode: FeatureInteractionMode

    public init(
        id: String,
        wireID: String? = nil,
        projectID: String,
        environmentID: String? = nil,
        environmentName: String? = nil,
        title: String,
        preview: String? = nil,
        branch: String? = nil,
        worktreePath: String? = nil,
        linkedPullRequest: ThreadLinkedPullRequest? = nil,
        createdAt: Date = .now,
        updatedAt: Date = .now,
        state: FeatureThreadState = .idle,
        providerID: String? = nil,
        providerName: String? = nil,
        modelID: String? = nil,
        modelOptions: [FeatureModelOptionSelection] = [],
        isArchived: Bool = false,
        isSettled: Bool = false,
        keepsActive: Bool = false,
        settledAt: Date? = nil,
        unsettledAt: Date? = nil,
        lastActivityAt: Date? = nil,
        snoozedUntil: Date? = nil,
        snoozedAt: Date? = nil,
        pinnedAt: Date? = nil,
        supportsSettlement: Bool? = nil,
        supportsSnooze: Bool? = nil,
        supportsPinning: Bool? = nil,
        supportsTitleRegeneration: Bool? = nil,
        supportsPullRequestLinking: Bool? = nil,
        attentionAt: Date? = nil,
        workingStartedAt: Date? = nil,
        latestTurnCompletedAt: Date? = nil,
        settlementFacts: FeatureThreadSettlementFacts? = nil,
        runtimeMode: FeatureRuntimeMode = .fullAccess,
        interactionMode: FeatureInteractionMode = .standard
    ) {
        self.id = id
        self.wireID = wireID
        self.projectID = projectID
        self.environmentID = environmentID
        self.environmentName = environmentName
        self.title = title
        self.preview = preview
        self.branch = branch
        self.worktreePath = worktreePath
        self.linkedPullRequest = linkedPullRequest
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.state = state
        self.providerID = providerID
        self.providerName = providerName
        self.modelID = modelID
        self.modelOptions = modelOptions
        self.isArchived = isArchived
        self.isSettled = isSettled
        self.keepsActive = keepsActive
        self.settledAt = settledAt
        self.unsettledAt = unsettledAt
        self.lastActivityAt = lastActivityAt
        self.snoozedUntil = snoozedUntil
        self.snoozedAt = snoozedAt
        self.pinnedAt = pinnedAt
        self.supportsSettlement = supportsSettlement
        self.supportsSnooze = supportsSnooze
        self.supportsPinning = supportsPinning
        self.supportsTitleRegeneration = supportsTitleRegeneration
        self.supportsPullRequestLinking = supportsPullRequestLinking
        self.attentionAt = attentionAt
        self.workingStartedAt = workingStartedAt
        self.latestTurnCompletedAt = latestTurnCompletedAt
        self.settlementFacts = settlementFacts
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
    }

    /// Missing capabilities mean unsupported. Existing states remain reversible
    /// so older cached snapshots cannot trap a thread in its current state.
    public var canTogglePin: Bool {
        pinnedAt != nil || supportsPinning == true
    }

    public var canToggleSettlement: Bool {
        isSettled || supportsSettlement == true
    }

    public var canToggleSnooze: Bool {
        snoozedUntil != nil || supportsSnooze == true
    }

}

public enum FeatureMessageRole: String, Sendable, Codable {
    case user
    case assistant
    case system
    case tool
}

public enum FeatureMessageState: String, Sendable, Codable {
    case queued
    case streaming
    case complete
    case failed
}

public struct FeatureMessageAttachment: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var mimeType: String
    public var sizeBytes: Int
    public var url: URL?
    /// Small local preview retained only while an optimistic message is replaced
    /// by its server-backed attachment URL.
    public var previewData: Data?

    public init(
        id: String,
        name: String,
        mimeType: String,
        sizeBytes: Int,
        url: URL? = nil,
        previewData: Data? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.url = url
        self.previewData = previewData
    }
}

public struct FeatureUploadAttachment: Sendable, Equatable {
    public let id: UUID
    private var inlineData: Data?
    public var ownedFile: FeatureOwnedAttachmentFile?
    public var name: String
    public var mimeType: String
    public var uploadedReference: FeatureUploadedAttachmentReference?

    public init(
        id: UUID = UUID(),
        data: Data,
        name: String,
        mimeType: String,
        uploadedReference: FeatureUploadedAttachmentReference? = nil
    ) {
        self.id = id
        inlineData = data
        ownedFile = nil
        self.name = name
        self.mimeType = mimeType
        self.uploadedReference = uploadedReference
    }

    public init(
        id: UUID = UUID(),
        ownedFile: FeatureOwnedAttachmentFile,
        name: String,
        mimeType: String,
        uploadedReference: FeatureUploadedAttachmentReference? = nil
    ) {
        self.id = id
        inlineData = nil
        self.ownedFile = ownedFile
        self.name = name
        self.mimeType = mimeType
        self.uploadedReference = uploadedReference
    }

    public init(_ draft: FeatureDraftAttachment) {
        id = draft.id
        inlineData = draft.ownedFile == nil ? draft.data : nil
        ownedFile = draft.ownedFile
        name = draft.filename
        mimeType = draft.mimeType
        uploadedReference = draft.uploadedReference
    }

    public var data: Data {
        get { inlineData ?? Data() }
        set {
            inlineData = newValue
            ownedFile = nil
        }
    }

    public var byteCount: Int {
        inlineData?.count ?? ownedFile?.byteCount ?? 0
    }
}

public struct FeatureMessage: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var role: FeatureMessageRole
    public var text: String
    public var createdAt: Date
    public var state: FeatureMessageState
    public var toolName: String?
    public var attachments: [FeatureMessageAttachment]
    public var workLogImagePaths: [String]?
    public var activeWorkLabel: String?
    public var toolPresentation: ToolActivityPresentation? = nil

    public init(
        id: String,
        role: FeatureMessageRole,
        text: String,
        createdAt: Date = .now,
        state: FeatureMessageState = .complete,
        toolName: String? = nil,
        attachments: [FeatureMessageAttachment] = [],
        workLogImagePaths: [String]? = nil,
        activeWorkLabel: String? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.state = state
        self.toolName = toolName
        self.attachments = attachments
        self.workLogImagePaths = workLogImagePaths
        self.activeWorkLabel = activeWorkLabel
    }
}

public enum FeatureApprovalKind: String, Sendable, Codable {
    case command
    case fileRead
    case fileChange
    case mcpElicitation
    case patch
    case other
}

public struct FeatureApprovalOption: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: FeatureApprovalDecision { decision }
    public let decision: FeatureApprovalDecision
    public let label: String

    public init(decision: FeatureApprovalDecision, label: String) {
        self.decision = decision
        self.label = label
    }
}

public struct FeatureApproval: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    /// The provider request identifier sent over the wire.
    public var wireID: String?
    public var threadID: String
    public var kind: FeatureApprovalKind
    public var title: String
    public var detail: String
    public var appName: String?
    public var options: [FeatureApprovalOption]?

    public init(
        id: String,
        wireID: String? = nil,
        threadID: String,
        kind: FeatureApprovalKind,
        title: String,
        detail: String,
        appName: String? = nil,
        options: [FeatureApprovalOption]? = nil
    ) {
        self.id = id
        self.wireID = wireID
        self.threadID = threadID
        self.kind = kind
        self.title = title
        self.detail = detail
        self.appName = appName
        self.options = options
    }
}

public struct FeatureInputOption: Sendable, Equatable, Hashable, Codable {
    public var label: String
    public var detail: String

    public init(label: String, detail: String) {
        self.label = label
        self.detail = detail
    }
}

/// A provider answer is either free-form/single-select text or the selected
/// labels for a multi-select question. Its Codable shape intentionally matches
/// the provider wire contract: a JSON string or an array of JSON strings.
public enum FeatureInputAnswer: Sendable, Equatable, Hashable, Codable {
    case text(String)
    case selections([String])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .text(value)
        } else {
            self = try .selections(container.decode([String].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .text(value):
            try container.encode(value)
        case let .selections(values):
            try container.encode(values)
        }
    }
}

extension FeatureInputAnswer {
    var normalized: FeatureInputAnswer? {
        switch self {
        case let .text(value):
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return normalized.isEmpty ? nil : .text(normalized)
        case let .selections(values):
            var seen: Set<String> = []
            let normalized = values.compactMap { value -> String? in
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { return nil }
                return trimmed
            }
            return normalized.isEmpty ? nil : .selections(normalized)
        }
    }

    func togglingOption(_ label: String, allowsMultiple: Bool) -> FeatureInputAnswer {
        guard allowsMultiple else { return .text(label) }

        let current: [String]
        if case let .selections(values) = self {
            current = values
        } else {
            current = []
        }

        if current.contains(label) {
            return .selections(current.filter { $0 != label })
        }
        return .selections(current + [label])
    }
}

public struct FeatureInputQuestion: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var header: String
    public var question: String
    public var options: [FeatureInputOption]
    public var allowsMultiple: Bool

    public init(
        id: String,
        header: String,
        question: String,
        options: [FeatureInputOption] = [],
        allowsMultiple: Bool = false
    ) {
        self.id = id
        self.header = header
        self.question = question
        self.options = options
        self.allowsMultiple = allowsMultiple
    }
}

public struct FeatureUserInput: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    /// The provider request identifier sent over the wire.
    public var wireID: String?
    public var threadID: String
    public var questions: [FeatureInputQuestion]

    public init(
        id: String,
        wireID: String? = nil,
        threadID: String,
        questions: [FeatureInputQuestion]
    ) {
        self.id = id
        self.wireID = wireID
        self.threadID = threadID
        self.questions = questions
    }
}

/// Stable UI identity for entities merged from independent environments.
/// Length-prefixing avoids separator collisions without requiring IDs to be parsed.
enum FeatureScopedID {
    static func project(environmentID: String, wireID: String) -> String {
        make(kind: "project", environmentID: environmentID, wireID: wireID)
    }

    static func thread(environmentID: String, wireID: String) -> String {
        make(kind: "thread", environmentID: environmentID, wireID: wireID)
    }

    static func approval(environmentID: String, wireID: String) -> String {
        make(kind: "approval", environmentID: environmentID, wireID: wireID)
    }

    static func input(environmentID: String, wireID: String) -> String {
        make(kind: "input", environmentID: environmentID, wireID: wireID)
    }

    private static func make(kind: String, environmentID: String, wireID: String) -> String {
        "\(kind):\(environmentID.utf8.count):\(environmentID)\(wireID)"
    }
}

public struct FeatureThreadDetail: Sendable, Equatable, Codable {
    public var thread: FeatureThread
    public var messages: [FeatureMessage]
    public var approvals: [FeatureApproval]
    public var userInputs: [FeatureUserInput]
    public var page: FeatureThreadPage?
    public var activeSubagentCount: Int
    public var backgroundWorkIsActive: Bool
    public var isCompacting: Bool?

    public init(
        thread: FeatureThread,
        messages: [FeatureMessage] = [],
        approvals: [FeatureApproval] = [],
        userInputs: [FeatureUserInput] = [],
        page: FeatureThreadPage? = nil,
        activeSubagentCount: Int = 0,
        backgroundWorkIsActive: Bool = false,
        isCompacting: Bool = false
    ) {
        self.thread = thread
        self.messages = messages
        self.approvals = approvals
        self.userInputs = userInputs
        self.page = page
        self.activeSubagentCount = activeSubagentCount
        self.backgroundWorkIsActive = backgroundWorkIsActive
        self.isCompacting = isCompacting
    }
}

public struct FeatureThreadPage: Sendable, Equatable, Codable {
    public var beforeCursor: String?
    public var hasMore: Bool
    public var isLoading: Bool

    public init(beforeCursor: String?, hasMore: Bool, isLoading: Bool = false) {
        self.beforeCursor = beforeCursor
        self.hasMore = hasMore
        self.isLoading = isLoading
    }
}

/// The small rendered-message delta produced by the native thread stream.
/// Keeping this beside the authoritative detail lets recycled transcript rows
/// update in proportion to an event instead of rescanning the full history.
public struct FeatureDetailDelta: Sendable, Equatable {
    public var changedMessages: [FeatureMessage]
    public var appendedMessageIDs: [String]

    public init(
        changedMessages: [FeatureMessage],
        appendedMessageIDs: [String] = []
    ) {
        self.changedMessages = changedMessages
        self.appendedMessageIDs = appendedMessageIDs
    }
}

public struct FeatureModel: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var detail: String?
    public var supportsImages: Bool
    public var imageSupportIsUnknown: Bool? = nil
    public var supportsReasoning: Bool
    public var isDefault: Bool
    public var isLegacy: Bool?
    public var options: [FeatureModelOptionDescriptor]

    public init(
        id: String,
        name: String,
        detail: String? = nil,
        supportsImages: Bool = false,
        supportsReasoning: Bool = false,
        isDefault: Bool = false,
        isLegacy: Bool? = nil,
        options: [FeatureModelOptionDescriptor] = []
    ) {
        self.id = id
        self.name = name
        self.detail = detail
        self.supportsImages = supportsImages
        self.supportsReasoning = supportsReasoning
        self.isDefault = isDefault
        self.isLegacy = isLegacy
        self.options = options
    }
}

public enum FeatureModelOptionKind: String, Sendable, Equatable, Hashable, Codable {
    case select
    case boolean
}

public struct FeatureModelOptionChoice: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var label: String
    public var detail: String?
    public var isDefault: Bool

    public init(
        id: String,
        label: String,
        detail: String? = nil,
        isDefault: Bool = false
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.isDefault = isDefault
    }
}

public struct FeatureModelOptionDescriptor: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var label: String
    public var detail: String?
    public var kind: FeatureModelOptionKind
    public var choices: [FeatureModelOptionChoice]
    public var defaultValue: FeatureModelOptionValue?

    public init(
        id: String,
        label: String,
        detail: String? = nil,
        kind: FeatureModelOptionKind,
        choices: [FeatureModelOptionChoice] = [],
        defaultValue: FeatureModelOptionValue? = nil
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.kind = kind
        self.choices = choices
        self.defaultValue = defaultValue
    }
}

public enum FeatureModelOptionValue: Sendable, Equatable, Hashable, Codable {
    case string(String)
    case boolean(Bool)

    private enum CodingKeys: String, CodingKey {
        case type
        case value
    }

    private enum ValueType: String, Codable {
        case string
        case boolean
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(ValueType.self, forKey: .type) {
        case .string:
            self = try .string(container.decode(String.self, forKey: .value))
        case .boolean:
            self = try .boolean(container.decode(Bool.self, forKey: .value))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .string(value):
            try container.encode(ValueType.string, forKey: .type)
            try container.encode(value, forKey: .value)
        case let .boolean(value):
            try container.encode(ValueType.boolean, forKey: .type)
            try container.encode(value, forKey: .value)
        }
    }
}

public struct FeatureModelOptionSelection: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var value: FeatureModelOptionValue

    public init(id: String, value: FeatureModelOptionValue) {
        self.id = id
        self.value = value
    }
}

public struct FeatureProviderWorkspace: Sendable, Equatable, Hashable, Codable {
    public let cwd: String
    public let slashCommands: [FeatureProviderSlashCommand]
    public let skills: [FeatureProviderSkill]
}

public struct FeatureProvider: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var isAvailable: Bool
    public var driver: String
    public var requiresNewThreadForModelChange: Bool
    public var models: [FeatureModel]
    public var slashCommands: [FeatureProviderSlashCommand]?
    public var skills: [FeatureProviderSkill]?
    public var workspaceSnapshots: [FeatureProviderWorkspace]? = nil
    public var setup: ProviderSetupCapabilities? = nil
    public var isEnabled: Bool? = nil
    public var isInstalled: Bool? = nil
    public var authStatus: String? = nil
    public var statusMessage: String? = nil

    func workspaceCatalog(cwd: String?) -> FeatureProviderWorkspace {
        if let cwd, let workspace = workspaceSnapshots?.first(where: { $0.cwd == cwd }) {
            return workspace
        }
        // A catalog from another workspace must not leak into this composer.
        return FeatureProviderWorkspace(
            cwd: cwd ?? "",
            slashCommands: workspaceSnapshots == nil ? slashCommands ?? [] : [],
            skills: workspaceSnapshots == nil ? skills ?? [] : []
        )
    }

    public init(
        id: String,
        name: String,
        isAvailable: Bool = true,
        driver: String = "",
        requiresNewThreadForModelChange: Bool = false,
        models: [FeatureModel] = [],
        slashCommands: [FeatureProviderSlashCommand] = [],
        skills: [FeatureProviderSkill] = []
    ) {
        self.id = id
        self.name = name
        self.isAvailable = isAvailable
        self.driver = driver
        self.requiresNewThreadForModelChange = requiresNewThreadForModelChange
        self.models = models
        self.slashCommands = slashCommands
        self.skills = skills
    }
}

public struct FeatureSelection: Sendable, Equatable, Hashable, Codable {
    public var providerID: String
    public var modelID: String
    public var options: [FeatureModelOptionSelection]

    public init(
        providerID: String,
        modelID: String,
        options: [FeatureModelOptionSelection] = []
    ) {
        self.providerID = providerID
        self.modelID = modelID
        self.options = options
    }
}

public enum FeatureAppearance: String, CaseIterable, Sendable, Codable {
    case system
    case light
    case dark
}

public struct FeatureSettings: Sendable, Equatable, Codable {
    public var appearance: FeatureAppearance
    public var hapticsEnabled: Bool
    public var notificationsEnabled: Bool
    public var liveActivitiesEnabled: Bool
    public var defaultSelection: FeatureSelection?

    public init(
        appearance: FeatureAppearance = .system,
        hapticsEnabled: Bool = true,
        notificationsEnabled: Bool = true,
        liveActivitiesEnabled: Bool = true,
        defaultSelection: FeatureSelection? = nil
    ) {
        self.appearance = appearance
        self.hapticsEnabled = hapticsEnabled
        self.notificationsEnabled = notificationsEnabled
        self.liveActivitiesEnabled = liveActivitiesEnabled
        self.defaultSelection = defaultSelection
    }

    private enum CodingKeys: String, CodingKey {
        case appearance
        case hapticsEnabled
        case notificationsEnabled
        case liveActivitiesEnabled
        case defaultSelection
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        appearance = try container.decodeIfPresent(
            FeatureAppearance.self,
            forKey: .appearance
        ) ?? .system
        hapticsEnabled = try container.decodeIfPresent(
            Bool.self,
            forKey: .hapticsEnabled
        ) ?? true
        notificationsEnabled = try container.decodeIfPresent(
            Bool.self,
            forKey: .notificationsEnabled
        ) ?? true
        liveActivitiesEnabled = try container.decodeIfPresent(
            Bool.self,
            forKey: .liveActivitiesEnabled
        ) ?? true
        defaultSelection = try container.decodeIfPresent(
            FeatureSelection.self,
            forKey: .defaultSelection
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(appearance, forKey: .appearance)
        try container.encode(hapticsEnabled, forKey: .hapticsEnabled)
        try container.encode(notificationsEnabled, forKey: .notificationsEnabled)
        try container.encode(liveActivitiesEnabled, forKey: .liveActivitiesEnabled)
        try container.encodeIfPresent(defaultSelection, forKey: .defaultSelection)
    }
}

public struct FeatureEnvironmentPreferences: Sendable, Equatable, Codable {
    public enum ProjectGroupingMode: String, Sendable, Equatable, Codable {
        case repository
        case repositoryPath = "repository_path"
        case separate
    }

    public var defaultWorkspaceMode: FeatureWorkspaceMode
    public var newWorktreesStartFromOrigin: Bool
    public var projectGroupingMode: ProjectGroupingMode
    public var projectGroupingOverrides: [String: ProjectGroupingMode]
    public var automaticSettlement: FeatureAutomaticSettlementSettings?
    public var supportsImageUploads: Bool
    public var maxFileAttachmentBytes: Int?
    public var continueThreadsAfterServerUpdate: Bool?

    public init(
        defaultWorkspaceMode: FeatureWorkspaceMode = .local,
        newWorktreesStartFromOrigin: Bool = true,
        projectGroupingMode: ProjectGroupingMode = .repository,
        projectGroupingOverrides: [String: ProjectGroupingMode] = [:],
        automaticSettlement: FeatureAutomaticSettlementSettings? = nil,
        supportsImageUploads: Bool = false,
        maxFileAttachmentBytes: Int? = nil,
        continueThreadsAfterServerUpdate: Bool? = nil
    ) {
        self.defaultWorkspaceMode = defaultWorkspaceMode
        self.newWorktreesStartFromOrigin = newWorktreesStartFromOrigin
        self.projectGroupingMode = projectGroupingMode
        self.projectGroupingOverrides = projectGroupingOverrides
        self.automaticSettlement = automaticSettlement
        self.supportsImageUploads = supportsImageUploads
        self.maxFileAttachmentBytes = maxFileAttachmentBytes
        self.continueThreadsAfterServerUpdate = continueThreadsAfterServerUpdate
    }

    private enum CodingKeys: String, CodingKey {
        case defaultWorkspaceMode
        case newWorktreesStartFromOrigin
        case projectGroupingMode
        case projectGroupingOverrides
        case automaticSettlement
        case supportsImageUploads
        case maxFileAttachmentBytes
        case continueThreadsAfterServerUpdate
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        defaultWorkspaceMode = try container.decodeIfPresent(
            FeatureWorkspaceMode.self,
            forKey: .defaultWorkspaceMode
        ) ?? .local
        newWorktreesStartFromOrigin = try container.decodeIfPresent(
            Bool.self,
            forKey: .newWorktreesStartFromOrigin
        ) ?? true
        projectGroupingMode = try container.decodeIfPresent(
            ProjectGroupingMode.self,
            forKey: .projectGroupingMode
        ) ?? .repository
        supportsImageUploads = try container.decodeIfPresent(
            Bool.self,
            forKey: .supportsImageUploads
        ) ?? false
        maxFileAttachmentBytes = try container.decodeIfPresent(
            Int.self,
            forKey: .maxFileAttachmentBytes
        )
        continueThreadsAfterServerUpdate = try container.decodeIfPresent(
            Bool.self,
            forKey: .continueThreadsAfterServerUpdate
        )
        projectGroupingOverrides = try container.decodeIfPresent(
            [String: ProjectGroupingMode].self,
            forKey: .projectGroupingOverrides
        ) ?? [:]
        automaticSettlement = try container.decodeIfPresent(
            FeatureAutomaticSettlementSettings.self,
            forKey: .automaticSettlement
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(defaultWorkspaceMode, forKey: .defaultWorkspaceMode)
        try container.encode(newWorktreesStartFromOrigin, forKey: .newWorktreesStartFromOrigin)
        try container.encode(projectGroupingMode, forKey: .projectGroupingMode)
        try container.encode(projectGroupingOverrides, forKey: .projectGroupingOverrides)
        try container.encodeIfPresent(automaticSettlement, forKey: .automaticSettlement)
        try container.encode(supportsImageUploads, forKey: .supportsImageUploads)
        try container.encodeIfPresent(maxFileAttachmentBytes, forKey: .maxFileAttachmentBytes)
        try container.encodeIfPresent(continueThreadsAfterServerUpdate, forKey: .continueThreadsAfterServerUpdate)
    }
}

public struct FeatureAutomaticSettlementSettings: Sendable, Equatable, Codable {
    public var onMerge: Bool
    public var afterDays: Double?

    public init(onMerge: Bool, afterDays: Double?) {
        self.onMerge = onMerge
        self.afterDays = afterDays
    }
}

public enum FeatureAutomaticSettlementChange: Sendable, Equatable {
    case onMerge(Bool)
    case afterDays(Double?)
}

public struct FeatureSnapshot: Sendable, Equatable, Codable {
    public var connection: FeatureConnection
    public var environments: [FeatureEnvironment]
    public var projects: [FeatureProject]
    public var threads: [FeatureThread]
    public var providers: [FeatureProvider]
    /// Provider catalogues are environment-scoped. `providers` remains only
    /// for decoding older cached snapshots and must not drive product choices.
    public var providersByEnvironment: [String: [FeatureProvider]]?
    /// Server-authoritative new-thread defaults keyed by saved environment.
    public var preferencesByEnvironment: [String: FeatureEnvironmentPreferences]?
    public var settings: FeatureSettings

    public init(
        connection: FeatureConnection = .init(),
        environments: [FeatureEnvironment] = [],
        projects: [FeatureProject] = [],
        threads: [FeatureThread] = [],
        providers: [FeatureProvider] = [],
        providersByEnvironment: [String: [FeatureProvider]]? = nil,
        preferencesByEnvironment: [String: FeatureEnvironmentPreferences]? = nil,
        settings: FeatureSettings = .init()
    ) {
        self.connection = connection
        self.environments = environments
        self.projects = projects
        self.threads = threads
        self.providers = providers
        self.providersByEnvironment = providersByEnvironment
        self.preferencesByEnvironment = preferencesByEnvironment
        self.settings = settings
    }
}

public enum FeatureApprovalDecision: String, Sendable, Codable {
    case allowOnce
    case allowForSession
    case allowAlways
    case deny
    case cancel

    init?(wireValue: String) {
        switch wireValue {
        case "accept": self = .allowOnce
        case "acceptForSession": self = .allowForSession
        case "acceptAlways": self = .allowAlways
        case "decline": self = .deny
        case "cancel": self = .cancel
        default: return nil
        }
    }

    var wireValue: String {
        switch self {
        case .allowOnce: "accept"
        case .allowForSession: "acceptForSession"
        case .allowAlways: "acceptAlways"
        case .deny: "decline"
        case .cancel: "cancel"
        }
    }
}

public enum FeatureThreadSyncState: Sendable, Equatable {
    case catchingUp
    case reconnecting
    case live
    case failed(String)
}

public enum FeatureEvent: Sendable {
    case snapshot(FeatureSnapshot)
    case connection(FeatureConnection)
    case thread(FeatureThread)
    case threadRemoved(id: String)
    case detail(FeatureThreadDetail)
    case detailDelta(FeatureThreadDetail, FeatureDetailDelta)
    case threadSync(id: String, state: FeatureThreadSyncState?)
    case failure(String)
}
