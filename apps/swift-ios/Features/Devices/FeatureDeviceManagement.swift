import Foundation

public enum FeatureDeviceType: String, Sendable, Equatable, Codable {
    case desktop
    case mobile
    case tablet
    case bot
    case unknown

    var displayName: String {
        switch self {
        case .desktop: "Desktop"
        case .mobile: "Phone"
        case .tablet: "Tablet"
        case .bot: "Automation"
        case .unknown: "Device"
        }
    }

    var systemImage: String {
        switch self {
        case .desktop: "desktopcomputer"
        case .mobile: "iphone"
        case .tablet: "ipad"
        case .bot: "gearshape.2"
        case .unknown: "network"
        }
    }
}

public struct FeatureDeviceSession: Identifiable, Sendable, Equatable, Codable {
    public var id: String { sessionID }

    public let sessionID: String
    public var label: String?
    public var deviceType: FeatureDeviceType
    public var operatingSystem: String?
    public var browser: String?
    public var ipAddress: String?
    public var issuedAt: Date
    public var expiresAt: Date
    public var lastConnectedAt: Date?
    public var isConnected: Bool
    public var isCurrent: Bool

    public init(
        sessionID: String,
        label: String? = nil,
        deviceType: FeatureDeviceType = .unknown,
        operatingSystem: String? = nil,
        browser: String? = nil,
        ipAddress: String? = nil,
        issuedAt: Date,
        expiresAt: Date,
        lastConnectedAt: Date? = nil,
        isConnected: Bool = false,
        isCurrent: Bool = false
    ) {
        self.sessionID = sessionID
        self.label = label
        self.deviceType = deviceType
        self.operatingSystem = operatingSystem
        self.browser = browser
        self.ipAddress = ipAddress
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.lastConnectedAt = lastConnectedAt
        self.isConnected = isConnected
        self.isCurrent = isCurrent
    }

    var displayName: String {
        let value = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !value.isEmpty {
            return value
        }
        return isCurrent ? "This device" : deviceType.displayName
    }

    var platformDescription: String {
        [operatingSystem, browser]
            .compactMap { value in
                let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            }
            .joined(separator: " · ")
    }

    var lastSeenAt: Date {
        lastConnectedAt ?? issuedAt
    }

    static func sortedForDisplay(_ sessions: [Self]) -> [Self] {
        sessions.sorted { left, right in
            if left.isCurrent != right.isCurrent {
                return left.isCurrent
            }
            if left.isConnected != right.isConnected {
                return left.isConnected
            }
            return left.lastSeenAt > right.lastSeenAt
        }
    }
}

/// The app adapter can opt into access management without making it a requirement
/// for environments that do not grant the access:read/access:write scopes.
@MainActor
public protocol FeatureDeviceManaging: AnyObject {
    func loadDeviceSessions() async throws -> [FeatureDeviceSession]
    func revokeDeviceSession(id: String) async throws
    func revokeOtherDeviceSessions() async throws
}

@MainActor
final class EmptyFeatureDeviceManager: FeatureDeviceManaging {
    static let shared = EmptyFeatureDeviceManager()

    private init() {}

    func loadDeviceSessions() async throws -> [FeatureDeviceSession] {
        []
    }

    func revokeDeviceSession(id: String) async throws {}
    func revokeOtherDeviceSessions() async throws {}
}

enum DeviceManagementErrorCopy {
    static func message(for error: Error) -> String {
        let value = error.localizedDescription.lowercased()
        if value.contains("scope") || value.contains("403") || value.contains("forbidden")
            || value.contains("permission") {
            return "This connection does not have permission to manage devices."
        }
        if value.contains("offline") || value.contains("network")
            || value.contains("not connected") || value.contains("timed out") {
            return "Device access could not be updated. Check your connection and try again."
        }
        return "Device access could not be updated. Try again in a moment."
    }
}
