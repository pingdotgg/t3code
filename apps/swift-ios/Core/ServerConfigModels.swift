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

    public init(
        defaultThreadEnvMode: ServerThreadEnvironmentMode = .local,
        newWorktreesStartFromOrigin: Bool = true,
        sidebarProjectGroupingMode: ServerProjectGroupingMode? = nil,
        sidebarProjectGroupingOverrides: [String: ServerProjectGroupingMode]? = nil
    ) {
        self.defaultThreadEnvMode = defaultThreadEnvMode
        self.newWorktreesStartFromOrigin = newWorktreesStartFromOrigin
        self.sidebarProjectGroupingMode = sidebarProjectGroupingMode
        self.sidebarProjectGroupingOverrides = sidebarProjectGroupingOverrides
    }
}

/// Narrow decode view of the much larger `ServerConfig` RPC result.
public struct ServerConfigSnapshot: Codable, Equatable, Sendable {
    public let providers: [ServerProviderSnapshot]
    public let settings: ServerSettingsSnapshot?
    public let threadSnapshotPagination: Bool?

    public init(
        providers: [ServerProviderSnapshot],
        settings: ServerSettingsSnapshot? = nil,
        threadSnapshotPagination: Bool? = nil
    ) {
        self.providers = providers
        self.settings = settings
        self.threadSnapshotPagination = threadSnapshotPagination
    }

    private enum CodingKeys: String, CodingKey {
        case providers, settings, threadSnapshotPagination
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
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(providers, forKey: .providers)
        try container.encodeIfPresent(settings, forKey: .settings)
        try container.encodeIfPresent(
            threadSnapshotPagination,
            forKey: .threadSnapshotPagination
        )
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
        default:
            self = .unrelated(type: type)
        }
    }
}
