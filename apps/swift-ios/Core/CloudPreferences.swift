import Foundation

public struct EnvironmentCloudLinkState: Codable, Equatable, Sendable {
    public let linked: Bool
    public let cloudUserId: String?
    public let relayUrl: String?
    public let relayIssuer: String?
    public let managedTunnelActive: Bool?
    public let publishAgentActivity: Bool
    public let holdWebhooksWhileOffline: Bool?
}

public struct EnvironmentCloudPreferences: Encodable, Equatable, Sendable {
    public let publishAgentActivity: Bool
    /// Omit when changing activity alone. A missing response field means the server is too old.
    public var holdWebhooksWhileOffline: Bool? = nil
}

public enum EnvironmentCloudPreferencesError: LocalizedError {
    case unsupported
    public var errorDescription: String? { "Update this environment to configure offline webhook delivery." }
}
