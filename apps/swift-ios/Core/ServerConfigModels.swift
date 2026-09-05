import Foundation

public struct ServerProviderAuthSnapshot: Codable, Equatable, Sendable {
    public let status: String
    public let type: String?
    public let label: String?
    public let email: String?
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
    public var usageLimits: ServerProviderUsageLimits? = nil
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
    public let defaultThreadEnvMode: ServerThreadEnvironmentMode
    public let newWorktreesStartFromOrigin: Bool
    public let sidebarProjectGroupingMode: ServerProjectGroupingMode?
    public let sidebarProjectGroupingOverrides: [String: ServerProjectGroupingMode]?
    public let sidebarAutoSettleOnMerge: Bool
    public let sidebarAutoSettleAfterDays: Double?
    public let continueThreadsAfterServerUpdate: Bool
    public var environmentIcon: String? = nil
    public var sourceControlWritingStyle: JSONValue? = nil

    public var sharedPatch: JSONValue {
        sharedPatch(supportsRestartContinuation: false)
    }

    /// Include restart continuation only when both environments support it.
    public func sharedPatch(supportsRestartContinuation: Bool) -> JSONValue {
        var fields: [String: JSONValue] = [
            "sidebarAutoSettleAfterDays": sidebarAutoSettleAfterDays.map(JSONValue.number) ?? .null,
            "sidebarAutoSettleOnMerge": .bool(sidebarAutoSettleOnMerge),
            "defaultThreadEnvMode": .string(defaultThreadEnvMode.rawValue),
            "newWorktreesStartFromOrigin": .bool(newWorktreesStartFromOrigin),
        ]
        if let sourceControlWritingStyle { fields["sourceControlWritingStyle"] = sourceControlWritingStyle }
        if supportsRestartContinuation {
            fields["continueThreadsAfterServerUpdate"] = .bool(continueThreadsAfterServerUpdate)
        }
        return .object(fields)
    }

    public init(
        defaultThreadEnvMode: ServerThreadEnvironmentMode = .local,
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
        case defaultThreadEnvMode
        case newWorktreesStartFromOrigin
        case sidebarProjectGroupingMode
        case sidebarProjectGroupingOverrides
        case sidebarAutoSettleOnMerge
        case sidebarAutoSettleAfterDays
        case continueThreadsAfterServerUpdate
        case environmentIcon
        case sourceControlWritingStyle
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        environmentIcon = try container.decodeIfPresent(String.self, forKey: .environmentIcon)
        sourceControlWritingStyle = try container.decodeIfPresent(JSONValue.self, forKey: .sourceControlWritingStyle)
        continueThreadsAfterServerUpdate = try container.decodeIfPresent(
            Bool.self,
            forKey: .continueThreadsAfterServerUpdate
        ) ?? false
        defaultThreadEnvMode = try container.decodeIfPresent(
            ServerThreadEnvironmentMode.self,
            forKey: .defaultThreadEnvMode
        ) ?? .local
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
    case defaultThreadEnvMode(ServerThreadEnvironmentMode)
    case newWorktreesStartFromOrigin(Bool)
    case continueThreadsAfterServerUpdate(Bool)
    case environmentIcon(String?)
    case sharedPreferences(JSONValue)

    public var jsonValue: JSONValue {
        switch self {
        case let .defaultThreadEnvMode(value): .object(["defaultThreadEnvMode": .string(value.rawValue)])
        case let .newWorktreesStartFromOrigin(value): .object(["newWorktreesStartFromOrigin": .bool(value)])
        case let .continueThreadsAfterServerUpdate(value):
            .object(["continueThreadsAfterServerUpdate": .bool(value)])
        case let .environmentIcon(value): .object(["environmentIcon": value.map(JSONValue.string) ?? .null])
        case let .sharedPreferences(value): value
        case let .sidebarAutoSettleOnMerge(value):
            .object(["sidebarAutoSettleOnMerge": .bool(value)])
        case let .sidebarAutoSettleAfterDays(value):
            .object(["sidebarAutoSettleAfterDays": value.map(JSONValue.number) ?? .null])
        }
    }
}

/// Narrow decode view of the much larger `ServerConfig` RPC result.
public struct ServerConfigSnapshot: Codable, Equatable, Sendable {
    public let providers: [ServerProviderSnapshot]
    public let settings: ServerSettingsSnapshot?
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
        usageLimitSources: [UsageLimitSourceSnapshot] = []
    ) {
        self.providers = providers
        self.settings = settings
        self.threadSnapshotPagination = threadSnapshotPagination
        self.threadResumeCompletionMarker = threadResumeCompletionMarker
        self.environment = environment
        self.usageLimitSources = usageLimitSources
    }

    private enum CodingKeys: String, CodingKey {
        case providers, settings, threadSnapshotPagination, threadResumeCompletionMarker, environment
        case usageLimitSources
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
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
