import Foundation

public enum OrchestrationProtocolVersion: Int, Codable, Sendable {
    case v2 = 2
}

public enum OrchestrationProtocolError: LocalizedError, Equatable, Sendable {
    case unsupportedServerVersion(Int)
    case hostUpdateRequired

    public var errorDescription: String? {
        switch self {
        case let .unsupportedServerVersion(version):
            "This server uses orchestration protocol V\(version), which this app does not support. Update the app to connect."
        case .hostUpdateRequired:
            "This host uses an older orchestration protocol. Update T3 Code on the host to connect."
        }
    }
}

/// Validate a fresh descriptor before sending credentials to the host.
public struct OrchestrationProtocolSelection: Equatable, Sendable {
    public let version: OrchestrationProtocolVersion

    public init(descriptor: EnvironmentDescriptor) throws {
        guard let advertisedVersion = descriptor.orchestrationProtocolVersion,
              advertisedVersion >= OrchestrationProtocolVersion.v2.rawValue else {
            throw OrchestrationProtocolError.hostUpdateRequired
        }
        guard advertisedVersion == OrchestrationProtocolVersion.v2.rawValue else {
            throw OrchestrationProtocolError.unsupportedServerVersion(advertisedVersion)
        }
        version = .v2
    }
}
