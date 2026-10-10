import Foundation

public struct ServerProviderAuthSnapshot: Codable, Equatable, Sendable {
    public let status: String
    public let type: String?
    public let label: String?
    public let email: String?
    public var canLogout: Bool? = nil
}

public struct ServerProviderOptionChoice: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let description: String?
    public let isDefault: Bool?
}

public struct ServerSelectOptionDescriptor: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let description: String?
    public let options: [ServerProviderOptionChoice]
    public let currentValue: String?
    public let promptInjectedValues: [String]?
}

public struct ServerBooleanOptionDescriptor: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let description: String?
    public let currentValue: Bool?
}

public enum ServerProviderOptionDescriptor: Codable, Equatable, Sendable {
    case select(ServerSelectOptionDescriptor)
    case boolean(ServerBooleanOptionDescriptor)

    private enum CodingKeys: String, CodingKey { case type }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "select":
            self = .select(try ServerSelectOptionDescriptor(from: decoder))
        case "boolean":
            self = .boolean(try ServerBooleanOptionDescriptor(from: decoder))
        case let type:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown provider option type \(type)"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case let .select(value):
            try value.encode(to: encoder)
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("select", forKey: .type)
        case let .boolean(value):
            try value.encode(to: encoder)
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("boolean", forKey: .type)
        }
    }
}

public struct ServerModelCapabilities: Codable, Equatable, Sendable {
    public let optionDescriptors: [ServerProviderOptionDescriptor]?
    public var supportedRuntimeModes: [RuntimeMode]? = nil
}

public struct ServerProviderModelSnapshot: Codable, Identifiable, Equatable, Sendable {
    public var id: String { slug }

    public let slug: String
    public let name: String
    public let shortName: String?
    public let subProvider: String?
    public let isCustom: Bool
    public let isDefault: Bool?
    public let isLegacy: Bool?
    public let capabilities: ServerModelCapabilities?
}

public struct ServerProviderSlashCommandSnapshot: Codable, Equatable, Sendable {
    public struct Input: Codable, Equatable, Sendable {
        public let hint: String
    }

    public let name: String
    public let description: String?
    public let input: Input?
}

public struct ServerProviderSkillSnapshot: Codable, Equatable, Sendable {
    public let name: String
    public let description: String?
    public let path: String
    public let scope: String?
    public let enabled: Bool
    public let displayName: String?
    public let shortDescription: String?
    public var userInvocationOnly: Bool? = nil
    public var userInvocable: Bool? = nil
}

public struct ServerProviderWorkspaceSnapshot: Codable, Equatable, Sendable {
    public let cwd: String
    public let checkedAt: String
    public let slashCommands: [ServerProviderSlashCommandSnapshot]
    public let skills: [ServerProviderSkillSnapshot]
    public var slashCommandsPending: Bool? = nil
}

public struct ServerProviderSnapshot: Codable, Identifiable, Equatable, Sendable {
    public var id: String { instanceId }

    public let instanceId: String
    public let driver: String
    public let displayName: String?
    public let accentColor: String?
    public let badgeLabel: String?
    public let showInteractionModeToggle: Bool?
    public let requiresNewThreadForModelChange: Bool?
    public let enabled: Bool
    public let installed: Bool
    public let version: String?
    public let status: String
    public let auth: ServerProviderAuthSnapshot
    public let checkedAt: String
    public let message: String?
    public let availability: String?
    public let unavailableReason: String?
    public let models: [ServerProviderModelSnapshot]
    public let slashCommands: [ServerProviderSlashCommandSnapshot]?
    public let skills: [ServerProviderSkillSnapshot]?
    public var workspaceSnapshots: [ServerProviderWorkspaceSnapshot]? = nil
    public var setup: ProviderSetupCapabilities? = nil
    public var versionAdvisory: ProviderVersionAdvisory? = nil
    public var compatibilityAdvisory: ProviderCompatibilityAdvisory? = nil
    public var updateState: ProviderUpdateState? = nil
    public var usageLimits: ServerProviderUsageLimits? = nil
    public var supportsConversationRollback: Bool? = nil
}

public enum ServerThreadEnvironmentMode: String, Codable, Equatable, Sendable {
    case local
    case worktree
}

public enum ServerProjectGroupingMode: String, Codable, Equatable, Sendable {
    case repository
    case repositoryPath = "repository_path"
    case separate
}

/// New-thread preferences are server-authoritative, so every saved environment
/// can resolve these differently even though they share one mobile client.
public struct ServerSettingsSnapshot: Codable, Equatable, Sendable {
    public var defaultModelSelection: ModelSelection? = nil
    public var defaultRuntimeMode: RuntimeMode = .fullAccess
    public var supportsDefaultRuntimeMode = false
    public var defaultThreadEnvMode: ServerThreadEnvironmentMode?
    public var newWorktreesStartFromOrigin: Bool
    public let sidebarProjectGroupingMode: ServerProjectGroupingMode?
    public let sidebarProjectGroupingOverrides: [String: ServerProjectGroupingMode]?
    public var sidebarAutoSettleOnMerge: Bool
    public var sidebarAutoSettleAfterDays: Double?
    public var continueThreadsAfterServerUpdate: Bool
    public var defaultAutoPull = false
    public var defaultProjectScripts: [ProjectScript] = []
    public var projectScriptOverrides: [String: JSONValue] = [:]
    public var branchNamingMode: BranchNamingMode? = nil
    public var branchNamePrefix: String? = nil
    public var branchNameInstructions: String? = nil
    public var enableAgentBrowserAccess: Bool? = nil
    public var enableProviderUpdateChecks: Bool? = nil
    public var autoResumeLimitedThreads: Bool? = nil
    public var snoozeLimitedThreads: Bool? = nil
    public var storageCleanup: [String: JSONValue]? = nil
    public var worktreeCleanup: JSONValue? = nil
    public var worktreeSubmodules: WorktreeSubmodules? = nil
    public var supportsWorktreeSubmodules = false
    /// Missing on servers that do not support the current streaming setting.
    public var responseStreamingMode: ResponseStreamingMode? = nil
    public var projectSettingsOverrides: [String: [String: JSONValue]] = [:]
    public var projectSettingsFolded = false
    public var environmentIcon: String? = nil
    public var sourceControlWritingStyle: JSONValue? = nil
    public var worktreesDirectory: String? = nil
    public var previousWorktreesDirectories: [String]? = nil
    public var removeAgentCreditsOnMerge: Bool? = nil
    public var github: ServerGitHubSettings? = nil

    /// Optional fields indicate support on older servers. Do not send a newer
    /// preference to an environment that has not advertised it.
    var unsupportedPreferenceKeys: Set<String> {
        var keys = Set<String>()
        if !supportsDefaultRuntimeMode { keys.insert("defaultRuntimeMode") }
        if worktreesDirectory == nil { keys.insert("worktreesDirectory") }
        if removeAgentCreditsOnMerge == nil { keys.insert("removeAgentCreditsOnMerge") }
        if github == nil { keys.insert("github") }
        if branchNamingMode == nil { keys.insert("branchNamingMode") }
        if branchNamePrefix == nil { keys.insert("branchNamePrefix") }
        if branchNameInstructions == nil { keys.insert("branchNameInstructions") }
        if enableAgentBrowserAccess == nil { keys.insert("enableAgentBrowserAccess") }
        if enableProviderUpdateChecks == nil { keys.insert("enableProviderUpdateChecks") }
        if autoResumeLimitedThreads == nil { keys.insert("autoResumeLimitedThreads") }
        if snoozeLimitedThreads == nil { keys.insert("snoozeLimitedThreads") }
        return keys
    }

    public var sharedPatch: JSONValue {
        sharedPatch(supportsRestartContinuation: false)
    }

    /// Include restart continuation only when both environments support it.
    public func sharedPatch(supportsRestartContinuation: Bool) -> JSONValue {
        var fields: [String: JSONValue] = [
            "sidebarAutoSettleAfterDays": sidebarAutoSettleAfterDays.map(JSONValue.number) ?? .null,
            "sidebarAutoSettleOnMerge": .bool(sidebarAutoSettleOnMerge),
            "defaultThreadEnvMode": defaultThreadEnvMode.map { .string($0.rawValue) } ?? .null,
            "newWorktreesStartFromOrigin": .bool(newWorktreesStartFromOrigin),
            "defaultAutoPull": .bool(defaultAutoPull),
        ]
        if supportsDefaultRuntimeMode { fields["defaultRuntimeMode"] = .string(defaultRuntimeMode.rawValue) }
        if let branchNamingMode { fields["branchNamingMode"] = .string(branchNamingMode.rawValue) }
        if let branchNamePrefix { fields["branchNamePrefix"] = .string(branchNamePrefix) }
        if let branchNameInstructions { fields["branchNameInstructions"] = .string(branchNameInstructions) }
        if let enableAgentBrowserAccess { fields["enableAgentBrowserAccess"] = .bool(enableAgentBrowserAccess) }
        if let enableProviderUpdateChecks { fields["enableProviderUpdateChecks"] = .bool(enableProviderUpdateChecks) }
        if let autoResumeLimitedThreads { fields["autoResumeLimitedThreads"] = .bool(autoResumeLimitedThreads) }
        if let snoozeLimitedThreads { fields["snoozeLimitedThreads"] = .bool(snoozeLimitedThreads) }
        if let removeAgentCreditsOnMerge { fields["removeAgentCreditsOnMerge"] = .bool(removeAgentCreditsOnMerge) }
        if let sourceControlWritingStyle { fields["sourceControlWritingStyle"] = sourceControlWritingStyle }
        if supportsRestartContinuation {
            fields["continueThreadsAfterServerUpdate"] = .bool(continueThreadsAfterServerUpdate)
        }
        return .object(fields)
    }

    public init(
        defaultThreadEnvMode: ServerThreadEnvironmentMode? = nil,
        newWorktreesStartFromOrigin: Bool = true,
        sidebarProjectGroupingMode: ServerProjectGroupingMode? = nil,
        sidebarProjectGroupingOverrides: [String: ServerProjectGroupingMode]? = nil,
        sidebarAutoSettleOnMerge: Bool = true,
        sidebarAutoSettleAfterDays: Double? = 3,
        continueThreadsAfterServerUpdate: Bool = false
    ) {
        self.defaultThreadEnvMode = defaultThreadEnvMode
        self.newWorktreesStartFromOrigin = newWorktreesStartFromOrigin
        self.sidebarProjectGroupingMode = sidebarProjectGroupingMode
        self.sidebarProjectGroupingOverrides = sidebarProjectGroupingOverrides
        self.sidebarAutoSettleOnMerge = sidebarAutoSettleOnMerge
        self.sidebarAutoSettleAfterDays = sidebarAutoSettleAfterDays
        self.continueThreadsAfterServerUpdate = continueThreadsAfterServerUpdate
    }

    private enum CodingKeys: String, CodingKey {
        case defaultModelSelection
        case defaultRuntimeMode
        case defaultThreadEnvMode
        case newWorktreesStartFromOrigin
        case sidebarProjectGroupingMode
        case sidebarProjectGroupingOverrides
        case sidebarAutoSettleOnMerge
        case sidebarAutoSettleAfterDays
        case continueThreadsAfterServerUpdate
        case environmentIcon
        case sourceControlWritingStyle
        case worktreesDirectory, previousWorktreesDirectories, removeAgentCreditsOnMerge, github
        case worktreeSubmodules, storageCleanup, worktreeCleanup
        case defaultAutoPull, responseStreamingMode, projectSettingsOverrides, projectSettingsFolded
        case defaultProjectScripts, projectScriptOverrides
        case branchNamingMode, branchNamePrefix, branchNameInstructions
        case enableAgentBrowserAccess, enableProviderUpdateChecks, autoResumeLimitedThreads, snoozeLimitedThreads
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        defaultModelSelection = try container.decodeIfPresent(ModelSelection.self, forKey: .defaultModelSelection)
        defaultRuntimeMode = try container.decodeIfPresent(RuntimeMode.self, forKey: .defaultRuntimeMode) ?? .fullAccess
        supportsDefaultRuntimeMode = container.contains(.defaultRuntimeMode)
        defaultProjectScripts = try container.decodeIfPresent([ProjectScript].self, forKey: .defaultProjectScripts) ?? []
        projectScriptOverrides = try container.decodeIfPresent([String: JSONValue].self, forKey: .projectScriptOverrides) ?? [:]
        branchNamingMode = try container.decodeIfPresent(BranchNamingMode.self, forKey: .branchNamingMode)
        branchNamePrefix = try container.decodeIfPresent(String.self, forKey: .branchNamePrefix)
        branchNameInstructions = try container.decodeIfPresent(String.self, forKey: .branchNameInstructions)
        enableAgentBrowserAccess = try container.decodeIfPresent(Bool.self, forKey: .enableAgentBrowserAccess)
        enableProviderUpdateChecks = try container.decodeIfPresent(Bool.self, forKey: .enableProviderUpdateChecks)
        autoResumeLimitedThreads = try container.decodeIfPresent(Bool.self, forKey: .autoResumeLimitedThreads)
        snoozeLimitedThreads = try container.decodeIfPresent(Bool.self, forKey: .snoozeLimitedThreads)
        environmentIcon = try container.decodeIfPresent(String.self, forKey: .environmentIcon)
        sourceControlWritingStyle = try container.decodeIfPresent(JSONValue.self, forKey: .sourceControlWritingStyle)
        worktreesDirectory = try container.decodeIfPresent(String.self, forKey: .worktreesDirectory)
        previousWorktreesDirectories = try container.decodeIfPresent([String].self, forKey: .previousWorktreesDirectories)
        removeAgentCreditsOnMerge = try container.decodeIfPresent(Bool.self, forKey: .removeAgentCreditsOnMerge)
        github = try container.decodeIfPresent(ServerGitHubSettings.self, forKey: .github)
        storageCleanup = try container.decodeIfPresent([String: JSONValue].self, forKey: .storageCleanup)
        worktreeCleanup = try container.decodeIfPresent(JSONValue.self, forKey: .worktreeCleanup)
        worktreeSubmodules = try? container.decodeIfPresent(WorktreeSubmodules.self, forKey: .worktreeSubmodules)
        supportsWorktreeSubmodules = container.contains(.worktreeSubmodules)
        defaultAutoPull = try container.decodeIfPresent(Bool.self, forKey: .defaultAutoPull) ?? false
        responseStreamingMode = try container.decodeIfPresent(ResponseStreamingMode.self, forKey: .responseStreamingMode)
        projectSettingsOverrides = try container.decodeIfPresent([String: [String: JSONValue]].self, forKey: .projectSettingsOverrides) ?? [:]
        projectSettingsFolded = try container.decodeIfPresent(Bool.self, forKey: .projectSettingsFolded) ?? false
        continueThreadsAfterServerUpdate = try container.decodeIfPresent(
            Bool.self,
            forKey: .continueThreadsAfterServerUpdate
        ) ?? false
        defaultThreadEnvMode = try container.decodeIfPresent(
            ServerThreadEnvironmentMode.self,
            forKey: .defaultThreadEnvMode
        )
        newWorktreesStartFromOrigin = try container.decodeIfPresent(
            Bool.self,
            forKey: .newWorktreesStartFromOrigin
        ) ?? true
        sidebarProjectGroupingMode = try container.decodeIfPresent(
            ServerProjectGroupingMode.self,
            forKey: .sidebarProjectGroupingMode
        )
        sidebarProjectGroupingOverrides = try container.decodeIfPresent(
            [String: ServerProjectGroupingMode].self,
            forKey: .sidebarProjectGroupingOverrides
        )
        sidebarAutoSettleOnMerge = try container.decodeIfPresent(
            Bool.self,
            forKey: .sidebarAutoSettleOnMerge
        ) ?? true
        sidebarAutoSettleAfterDays = if container.contains(.sidebarAutoSettleAfterDays) {
            try container.decodeIfPresent(Double.self, forKey: .sidebarAutoSettleAfterDays)
        } else {
            3
        }
    }
}

public enum ServerSettingsChange: Equatable, Sendable {
    case sidebarAutoSettleOnMerge(Bool)
    case sidebarAutoSettleAfterDays(Double?)
    case defaultRuntimeMode(RuntimeMode)
    case defaultThreadEnvMode(ServerThreadEnvironmentMode?)
    case defaultAutoPull(Bool)
    case worktreesDirectory(String)
    case removeAgentCreditsOnMerge(Bool)
    case branchNamingMode(BranchNamingMode)
    case branchNamePrefix(String)
    case branchNameInstructions(String)
    case enableAgentBrowserAccess(Bool)
    case enableProviderUpdateChecks(Bool)
    case autoResumeLimitedThreads(Bool)
    case snoozeLimitedThreads(Bool)
    case newWorktreesStartFromOrigin(Bool)
    case continueThreadsAfterServerUpdate(Bool)
    case environmentIcon(String?)
    case sharedPreferences(JSONValue)
    case worktreeCleanup(JSONValue)
    case storageCleanup([String: JSONValue])
    case worktreeSubmodules(WorktreeSubmodules?)
    case responseStreamingMode(ResponseStreamingMode)
    case projectSettingsOverrides(projectID: String, entry: [String: JSONValue]?)

    public var jsonValue: JSONValue {
        switch self {
        case let .defaultRuntimeMode(value): .object(["defaultRuntimeMode": .string(value.rawValue)])
        case let .defaultThreadEnvMode(value): .object(["defaultThreadEnvMode": value.map { .string($0.rawValue) } ?? .null])
        case let .worktreesDirectory(value): .object(["worktreesDirectory": .string(value)])
        case let .removeAgentCreditsOnMerge(value): .object(["removeAgentCreditsOnMerge": .bool(value)])
        case let .defaultAutoPull(value): .object(["defaultAutoPull": .bool(value)])
        case let .branchNamingMode(value): .object(["branchNamingMode": .string(value.rawValue)])
        case let .branchNamePrefix(value): .object(["branchNamePrefix": .string(value)])
        case let .branchNameInstructions(value): .object(["branchNameInstructions": .string(value)])
        case let .enableAgentBrowserAccess(value): .object(["enableAgentBrowserAccess": .bool(value)])
        case let .enableProviderUpdateChecks(value): .object(["enableProviderUpdateChecks": .bool(value)])
        case let .autoResumeLimitedThreads(value): .object(["autoResumeLimitedThreads": .bool(value)])
        case let .snoozeLimitedThreads(value): .object(["snoozeLimitedThreads": .bool(value)])
        case let .newWorktreesStartFromOrigin(value): .object(["newWorktreesStartFromOrigin": .bool(value)])
        case let .continueThreadsAfterServerUpdate(value):
            .object(["continueThreadsAfterServerUpdate": .bool(value)])
        case let .environmentIcon(value): .object(["environmentIcon": value.map(JSONValue.string) ?? .null])
        case let .sharedPreferences(value): value
        case let .worktreeCleanup(value): .object(["worktreeCleanup": value])
        case let .storageCleanup(value): .object(["storageCleanup": .object(value)])
        case let .worktreeSubmodules(value): .object(["worktreeSubmodules": value.map { .string($0.rawValue) } ?? .null])
        case let .responseStreamingMode(value): .object(["responseStreamingMode": .string(value.rawValue)])
        case let .projectSettingsOverrides(projectID, entry):
            .object(["projectSettingsOverrides": .object([projectID: entry.map(JSONValue.object) ?? .null])])
        case let .sidebarAutoSettleOnMerge(value):
            .object(["sidebarAutoSettleOnMerge": .bool(value)])
        case let .sidebarAutoSettleAfterDays(value):
            .object(["sidebarAutoSettleAfterDays": value.map(JSONValue.number) ?? .null])
        }
    }
}

/// Narrow decode view of the much larger `ServerConfig` RPC result.
public struct ServerConfigSnapshot: Codable, Equatable, Sendable {
    public var auth: EnvironmentAuthMetadata? = nil
    public var directEndpoints: [EnvironmentDirectEndpoint]? = nil
    public var providers: [ServerProviderSnapshot]
    public var settings: ServerSettingsSnapshot?
    public var scratchWorkspaceRoot: String? = nil
    public var newProjectsRoot: String? = nil
    public let threadSnapshotPagination: Bool?
    public let threadResumeCompletionMarker: Bool?
    public let environment: EnvironmentDescriptor?
    public var usageLimitSources: [UsageLimitSourceSnapshot]

    public init(
        providers: [ServerProviderSnapshot],
        settings: ServerSettingsSnapshot? = nil,
        threadSnapshotPagination: Bool? = nil,
        threadResumeCompletionMarker: Bool? = nil,
        environment: EnvironmentDescriptor? = nil,
        usageLimitSources: [UsageLimitSourceSnapshot] = [],
        scratchWorkspaceRoot: String? = nil,
        auth: EnvironmentAuthMetadata? = nil,
        directEndpoints: [EnvironmentDirectEndpoint]? = nil
    ) {
        self.auth = auth
        self.directEndpoints = directEndpoints
        self.providers = providers
        self.settings = settings
        self.threadSnapshotPagination = threadSnapshotPagination
        self.threadResumeCompletionMarker = threadResumeCompletionMarker
        self.environment = environment
        self.usageLimitSources = usageLimitSources
        self.scratchWorkspaceRoot = scratchWorkspaceRoot
    }

    private enum CodingKeys: String, CodingKey {
        case providers, settings, threadSnapshotPagination, threadResumeCompletionMarker, environment
        case usageLimitSources, scratchWorkspaceRoot, newProjectsRoot, auth, directEndpoints
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        auth = try container.decodeIfPresent(EnvironmentAuthMetadata.self, forKey: .auth)
        directEndpoints = try container.decodeIfPresent(
            [LossyDecodableElement<EnvironmentDirectEndpoint>].self, forKey: .directEndpoints
        )?.compactMap(\.value)
        newProjectsRoot = try container.decodeIfPresent(String.self, forKey: .newProjectsRoot)
        scratchWorkspaceRoot = try container.decodeIfPresent(String.self, forKey: .scratchWorkspaceRoot)
        providers = try container.decode(
            [LossyDecodableElement<ServerProviderSnapshot>].self,
            forKey: .providers
        ).compactMap(\.value)
        settings = try container.decodeIfPresent(ServerSettingsSnapshot.self, forKey: .settings)
        threadSnapshotPagination = try container.decodeIfPresent(
            Bool.self,
            forKey: .threadSnapshotPagination
        )
        environment = try container.decodeIfPresent(EnvironmentDescriptor.self, forKey: .environment)
        threadResumeCompletionMarker = try container.decodeIfPresent(
            Bool.self, forKey: .threadResumeCompletionMarker
        )
        usageLimitSources = try container.decodeIfPresent(
            ForwardCompatibleArray<UsageLimitSourceSnapshot>.self,
            forKey: .usageLimitSources
        )?.wrappedValue ?? []
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(auth, forKey: .auth)
        try container.encodeIfPresent(directEndpoints, forKey: .directEndpoints)
        try container.encodeIfPresent(scratchWorkspaceRoot, forKey: .scratchWorkspaceRoot)
        try container.encodeIfPresent(newProjectsRoot, forKey: .newProjectsRoot)
        try container.encode(providers, forKey: .providers)
        try container.encodeIfPresent(settings, forKey: .settings)
        try container.encodeIfPresent(
            threadSnapshotPagination,
            forKey: .threadSnapshotPagination
        )
        try container.encodeIfPresent(environment, forKey: .environment)
        try container.encodeIfPresent(threadResumeCompletionMarker, forKey: .threadResumeCompletionMarker)
        try container.encode(usageLimitSources, forKey: .usageLimitSources)
    }
}

private struct LossyDecodableElement<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: any Decoder) throws {
        value = try? Value(from: decoder)
    }
}

public enum ServerConfigStreamEvent: Decodable, Sendable {
    case snapshot(ServerConfigSnapshot)
    case providerStatuses([ServerProviderSnapshot])
    case settingsUpdated(ServerSettingsSnapshot)
    case usageLimitSourcesUpdated([UsageLimitSourceSnapshot])
    case unrelated(type: String)

    private enum CodingKeys: String, CodingKey { case type, config, payload }
    private struct ProviderPayload: Decodable {
        let providers: [ServerProviderSnapshot]

        private enum CodingKeys: String, CodingKey { case providers }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            providers = try container.decode(
                [LossyDecodableElement<ServerProviderSnapshot>].self,
                forKey: .providers
            ).compactMap(\.value)
        }
    }
    private struct SettingsPayload: Decodable { let settings: ServerSettingsSnapshot }
    private struct UsageLimitSourcesPayload: Decodable {
        @ForwardCompatibleArray var sources: [UsageLimitSourceSnapshot]
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "snapshot":
            self = .snapshot(
                try container.decode(ServerConfigSnapshot.self, forKey: .config)
            )
        case "providerStatuses":
            self = .providerStatuses(
                try container.decode(ProviderPayload.self, forKey: .payload).providers
            )
        case "settingsUpdated":
            self = .settingsUpdated(
                try container.decode(SettingsPayload.self, forKey: .payload).settings
            )
        case "usageLimitSourcesUpdated":
            self = .usageLimitSourcesUpdated(
                try container.decode(UsageLimitSourcesPayload.self, forKey: .payload).sources
            )
        default:
            self = .unrelated(type: type)
        }
    }
}

public struct ServerRefreshProvidersResult: Codable, Equatable, Sendable {
    @ForwardCompatibleArray public var providers: [ServerProviderSnapshot]

    public init(providers: [ServerProviderSnapshot]) {
        self.providers = providers
    }
}

/// Saved token values are server redaction markers, never credentials to use on the phone.
public struct ServerGitHubSettings: Codable, Equatable, Sendable {
    public var hosts: [String: ServerGitHubHostSettings]
    public var tokens: [String: String]

    public init(hosts: [String: ServerGitHubHostSettings] = [:], tokens: [String: String] = [:]) {
        self.hosts = hosts
        self.tokens = tokens
    }

    private enum CodingKeys: String, CodingKey { case hosts, tokens }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hosts = try container.decodeIfPresent([String: ServerGitHubHostSettings].self, forKey: .hosts) ?? [:]
        tokens = try container.decodeIfPresent([String: String].self, forKey: .tokens) ?? [:]
    }
}

public struct ServerGitHubHostSettings: Codable, Equatable, Sendable {
    public var account: String?
    public var enabled: Bool

    public init(account: String? = nil, enabled: Bool = true) {
        self.account = account
        self.enabled = enabled
    }

    private enum CodingKeys: String, CodingKey { case account, enabled }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        account = try container.decodeIfPresent(String.self, forKey: .account)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }
}
