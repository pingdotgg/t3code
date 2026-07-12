import Foundation

/// Stable identity for one backend-hosting device.
public struct DeviceID: Hashable, Sendable, Codable, RawRepresentable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let local = DeviceID(rawValue: "local")
}

/// Selection identity across the local backend and any remote backends.
public struct ThreadSelection: Hashable, Sendable {
    public var deviceID: DeviceID
    public var threadID: String

    public init(deviceID: DeviceID, threadID: String) {
        self.deviceID = deviceID
        self.threadID = threadID
    }
}

/// Display and capability metadata for one backend session.
public struct BackendCapabilities: Sendable {
    public var opensLocalEditor: Bool
    public var canBrowseLocalFolders: Bool
    public var hostsMobilePairing: Bool

    public init(
        opensLocalEditor: Bool,
        canBrowseLocalFolders: Bool,
        hostsMobilePairing: Bool
    ) {
        self.opensLocalEditor = opensLocalEditor
        self.canBrowseLocalFolders = canBrowseLocalFolders
        self.hostsMobilePairing = hostsMobilePairing
    }

    public static let local = BackendCapabilities(
        opensLocalEditor: true,
        canBrowseLocalFolders: true,
        hostsMobilePairing: true)

    public static let remote = BackendCapabilities(
        opensLocalEditor: false,
        canBrowseLocalFolders: false,
        hostsMobilePairing: false)
}

/// Display-only descriptor for a remote device session.
///
/// The connection core's persisted remote-device model maps onto this
/// descriptor during the later integration phase.
public struct RemoteDeviceDescriptor: Sendable, Identifiable, Equatable {
    public let id: DeviceID
    public var name: String
    public var host: String
    public var port: Int?
    public var sessionExpiresAt: Date?

    public init(
        id: DeviceID,
        name: String,
        host: String,
        port: Int? = nil,
        sessionExpiresAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.host = host
        self.port = port
        self.sessionExpiresAt = sessionExpiresAt
    }
}
