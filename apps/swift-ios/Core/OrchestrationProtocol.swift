import Foundation

public enum OrchestrationProtocolPreference: String, Codable, CaseIterable, Sendable {
    case auto
    case v1
    case v2
}

public enum OrchestrationProtocolVersion: Int, Codable, Sendable {
    case v1 = 1
    case v2 = 2
}

public enum OrchestrationProtocolError: LocalizedError, Equatable, Sendable {
    case unsupportedServerVersion(Int)
    case preferenceMismatch(
        preference: OrchestrationProtocolPreference,
        serverVersion: OrchestrationProtocolVersion
    )

    public var errorDescription: String? {
        switch self {
        case let .unsupportedServerVersion(version):
            "This server uses orchestration protocol V\(version), which this app does not support. Update the app to connect."
        case let .preferenceMismatch(preference, serverVersion):
            "This connection is set to \(preference.rawValue.uppercased()), but the server uses orchestration protocol V\(serverVersion.rawValue). Select Auto or V\(serverVersion.rawValue) in connection settings."
        }
    }
}

/// Resolve from a fresh descriptor before each connection, including reconnects.
/// Discovery failures must propagate to the caller; only a successfully decoded
/// descriptor without a version identifies a server from before negotiation.
public struct OrchestrationProtocolSelection: Equatable, Sendable {
    public let version: OrchestrationProtocolVersion
    public let requiresStateReset: Bool

    public init(
        descriptor: EnvironmentDescriptor,
        preference: OrchestrationProtocolPreference = .auto,
        previousVersion: OrchestrationProtocolVersion? = nil
    ) throws {
        let advertisedVersion = descriptor.orchestrationProtocolVersion ?? 1
        guard let version = OrchestrationProtocolVersion(rawValue: advertisedVersion) else {
            throw OrchestrationProtocolError.unsupportedServerVersion(advertisedVersion)
        }
        let requiredVersion: OrchestrationProtocolVersion? = switch preference {
        case .auto: nil
        case .v1: .v1
        case .v2: .v2
        }
        if let requiredVersion, requiredVersion != version {
            throw OrchestrationProtocolError.preferenceMismatch(
                preference: preference,
                serverVersion: version
            )
        }
        self.version = version
        requiresStateReset = previousVersion.map { $0 != version } ?? false
    }
}
