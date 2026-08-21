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

    /// Mobile is a build surface. Legacy modes remain decodable for server
    /// history, but every command originating here uses full access.
    public static let allCases: [FeatureRuntimeMode] = [.fullAccess]

    public var mobileNormalized: FeatureRuntimeMode {
        .fullAccess
    }
}

public enum FeatureInteractionMode: String, CaseIterable, Sendable, Codable {
    case standard
    case plan

    /// Plan remains decodable for existing server state, but is no longer a
    /// mobile prompt choice.
    public static let allCases: [FeatureInteractionMode] = [.standard]

    public var mobileNormalized: FeatureInteractionMode { .standard }
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
    public var lastActivityAt: Date?
    public var snoozedUntil: Date?
    public var snoozedAt: Date?
    public var pinnedAt: Date?
    public var supportsSettlement: Bool?
    public var supportsSnooze: Bool?
    public var supportsPinning: Bool?
    public var supportsTitleRegeneration: Bool?
    public var attentionAt: Date?
    public var workingStartedAt: Date?
    public var latestTurnCompletedAt: Date?
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
        lastActivityAt: Date? = nil,
        snoozedUntil: Date? = nil,
        snoozedAt: Date? = nil,
        pinnedAt: Date? = nil,
        supportsSettlement: Bool? = nil,
        supportsSnooze: Bool? = nil,
        supportsPinning: Bool? = nil,
        supportsTitleRegeneration: Bool? = nil,
        attentionAt: Date? = nil,
        workingStartedAt: Date? = nil,
        latestTurnCompletedAt: Date? = nil,
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
        self.lastActivityAt = lastActivityAt
        self.snoozedUntil = snoozedUntil
        self.snoozedAt = snoozedAt
        self.pinnedAt = pinnedAt
        self.supportsSettlement = supportsSettlement
        self.supportsSnooze = supportsSnooze
        self.supportsPinning = supportsPinning
        self.supportsTitleRegeneration = supportsTitleRegeneration
        self.attentionAt = attentionAt
        self.workingStartedAt = workingStartedAt
        self.latestTurnCompletedAt = latestTurnCompletedAt
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
    }

    /// Older cached environment descriptors may omit the optional capability even
    /// when their server supports pinning. Always keep an existing pin reversible.
    public var canTogglePin: Bool {
        pinnedAt != nil || supportsPinning != false
    }

    public var canToggleSettlement: Bool {
        isSettled || supportsSettlement != false
    }

    public var canToggleSnooze: Bool {
        snoozedUntil != nil || supportsSnooze != false
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
    public var data: Data
    public var name: String
    public var mimeType: String

    public init(data: Data, name: String, mimeType: String) {
        self.data = data
        self.name = name
        self.mimeType = mimeType
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

    public init(
        id: String,
        role: FeatureMessageRole,
        text: String,
        createdAt: Date = .now,
        state: FeatureMessageState = .complete,
        toolName: String? = nil,
        attachments: [FeatureMessageAttachment] = []
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.state = state
        self.toolName = toolName
        self.attachments = attachments
    }
}

public enum FeatureApprovalKind: String, Sendable, Codable {
    case command
    case fileRead
    case fileChange
    case patch
    case other
}

public struct FeatureApproval: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    /// The provider request identifier sent over the wire.
    public var wireID: String?
    public var threadID: String
    public var kind: FeatureApprovalKind
    public var title: String
    public var detail: String

    public init(
        id: String,
        wireID: String? = nil,
        threadID: String,
        kind: FeatureApprovalKind,
        title: String,
        detail: String
    ) {
        self.id = id
        self.wireID = wireID
        self.threadID = threadID
        self.kind = kind
        self.title = title
        self.detail = detail
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

    public init(
        thread: FeatureThread,
        messages: [FeatureMessage] = [],
        approvals: [FeatureApproval] = [],
        userInputs: [FeatureUserInput] = [],
        page: FeatureThreadPage? = nil,
        activeSubagentCount: Int = 0,
        backgroundWorkIsActive: Bool = false
    ) {
        self.thread = thread
        self.messages = messages
        self.approvals = approvals
        self.userInputs = userInputs
        self.page = page
        self.activeSubagentCount = activeSubagentCount
        self.backgroundWorkIsActive = backgroundWorkIsActive
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

public struct FeatureProvider: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var isAvailable: Bool
    public var driver: String
    public var requiresNewThreadForModelChange: Bool
    public var models: [FeatureModel]
    public var slashCommands: [FeatureProviderSlashCommand]?
    public var skills: [FeatureProviderSkill]?

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

    public init(
        defaultWorkspaceMode: FeatureWorkspaceMode = .local,
        newWorktreesStartFromOrigin: Bool = true,
        projectGroupingMode: ProjectGroupingMode = .repository,
        projectGroupingOverrides: [String: ProjectGroupingMode] = [:]
    ) {
        self.defaultWorkspaceMode = defaultWorkspaceMode
        self.newWorktreesStartFromOrigin = newWorktreesStartFromOrigin
        self.projectGroupingMode = projectGroupingMode
        self.projectGroupingOverrides = projectGroupingOverrides
    }

    private enum CodingKeys: String, CodingKey {
        case defaultWorkspaceMode
        case newWorktreesStartFromOrigin
        case projectGroupingMode
        case projectGroupingOverrides
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
        projectGroupingOverrides = try container.decodeIfPresent(
            [String: ProjectGroupingMode].self,
            forKey: .projectGroupingOverrides
        ) ?? [:]
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(defaultWorkspaceMode, forKey: .defaultWorkspaceMode)
        try container.encode(newWorktreesStartFromOrigin, forKey: .newWorktreesStartFromOrigin)
        try container.encode(projectGroupingMode, forKey: .projectGroupingMode)
        try container.encode(projectGroupingOverrides, forKey: .projectGroupingOverrides)
    }
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
    case deny
}

public enum FeatureEvent: Sendable {
    case snapshot(FeatureSnapshot)
    case connection(FeatureConnection)
    case thread(FeatureThread)
    case threadRemoved(id: String)
    case detail(FeatureThreadDetail)
    case detailDelta(FeatureThreadDetail, FeatureDetailDelta)
    case failure(String)
}
