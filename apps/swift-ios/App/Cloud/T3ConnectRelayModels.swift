import Foundation

public enum T3ConnectRelayScope: String, Codable, CaseIterable, Sendable {
    case environmentConnect = "environment:connect"
    case environmentStatus = "environment:status"
    case mobileRegistration = "mobile:registration"
}

public enum T3ConnectManagedEndpointProvider: String, Codable, Sendable {
    case manual
    case cloudflareTunnel = "cloudflare_tunnel"
    case t3Relay = "t3_relay"
}

public struct T3ConnectManagedEndpoint: Codable, Equatable, Sendable {
    public let httpBaseUrl: String
    public let wsBaseUrl: String
    public let providerKind: T3ConnectManagedEndpointProvider

    public var httpBaseURL: URL? { URL(string: httpBaseUrl) }
    public var webSocketBaseURL: URL? { URL(string: wsBaseUrl) }
}

public struct T3ConnectRelayEnvironment: Codable, Identifiable, Equatable, Sendable {
    public var id: String { environmentId }

    public let environmentId: String
    public let label: String
    public let endpoint: T3ConnectManagedEndpoint
    public let linkedAt: String
}

public struct T3ConnectRelayEnvironmentStatus: Codable, Equatable, Sendable {
    public enum Value: String, Codable, Sendable {
        case online
        case offline
    }

    public let environmentId: String
    public let endpoint: T3ConnectManagedEndpoint
    public let status: Value
    public let checkedAt: String
    public let descriptor: EnvironmentDescriptor?
    public let error: String?
    public let traceId: String?
}

public struct T3ConnectManagedEnvironmentCredential: Codable, Equatable, Sendable {
    public let environmentID: String
    public let label: String
    public let endpoint: T3ConnectManagedEndpoint
    public let bootstrapCredential: String
    public let bootstrapExpiresAt: String
    public let proofKeyThumbprint: String
}

public struct T3ConnectEnvironmentLinkChallengeRequest: Codable, Equatable, Sendable {
    public let notificationsEnabled: Bool
    public let liveActivitiesEnabled: Bool
    public let managedTunnelsEnabled: Bool

    public init(
        notificationsEnabled: Bool,
        liveActivitiesEnabled: Bool,
        managedTunnelsEnabled: Bool = true
    ) {
        self.notificationsEnabled = notificationsEnabled
        self.liveActivitiesEnabled = liveActivitiesEnabled
        self.managedTunnelsEnabled = managedTunnelsEnabled
    }
}

public struct T3ConnectEnvironmentLinkChallenge: Codable, Equatable, Sendable {
    public let challenge: String
    public let expiresAt: String
}

public struct T3ConnectEnvironmentLinkRequest: Codable, Equatable, Sendable {
    public let deviceId: String?
    public let proof: String
    public let notificationsEnabled: Bool
    public let liveActivitiesEnabled: Bool
    public let managedTunnelsEnabled: Bool

    public init(
        deviceID: String? = nil,
        proof: String,
        notificationsEnabled: Bool,
        liveActivitiesEnabled: Bool,
        managedTunnelsEnabled: Bool = true
    ) {
        deviceId = deviceID
        self.proof = proof
        self.notificationsEnabled = notificationsEnabled
        self.liveActivitiesEnabled = liveActivitiesEnabled
        self.managedTunnelsEnabled = managedTunnelsEnabled
    }
}

public struct T3ConnectManagedEndpointRuntime: Codable, Equatable, Sendable {
    public let providerKind: T3ConnectManagedEndpointProvider
    public let connectorToken: String
    public let tunnelId: String?
    public let tunnelName: String?
}

public struct T3ConnectEnvironmentLinkResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let cloudUserId: String
    public let environmentId: String
    public let endpoint: T3ConnectManagedEndpoint
    public let endpointRuntime: T3ConnectManagedEndpointRuntime?
    public let relayIssuer: String
    public let environmentCredential: String
    public let cloudMintPublicKey: String
}

public struct T3ConnectDevicePreferences: Codable, Equatable, Sendable {
    public let liveActivitiesEnabled: Bool
    public let notificationsEnabled: Bool
    public let notifyOnApproval: Bool
    public let notifyOnInput: Bool
    public let notifyOnCompletion: Bool
    public let notifyOnFailure: Bool

    public init(
        liveActivitiesEnabled: Bool = true,
        notificationsEnabled: Bool = true,
        notifyOnApproval: Bool = true,
        notifyOnInput: Bool = true,
        notifyOnCompletion: Bool = true,
        notifyOnFailure: Bool = true
    ) {
        self.liveActivitiesEnabled = liveActivitiesEnabled
        self.notificationsEnabled = notificationsEnabled
        self.notifyOnApproval = notifyOnApproval
        self.notifyOnInput = notifyOnInput
        self.notifyOnCompletion = notifyOnCompletion
        self.notifyOnFailure = notifyOnFailure
    }
}

public struct T3ConnectDeviceRegistration: Codable, Equatable, Sendable {
    public enum APNSEnvironment: String, Codable, Sendable {
        case sandbox
        case production
    }

    public let deviceId: String
    public let label: String
    public let platform: String
    public let iosMajorVersion: Int
    public let appVersion: String?
    public let bundleId: String?
    public let apsEnvironment: APNSEnvironment?
    public let pushToken: String?
    public let pushToStartToken: String?
    public let preferences: T3ConnectDevicePreferences

    public init(
        deviceID: String,
        label: String,
        iosMajorVersion: Int,
        appVersion: String? = nil,
        bundleID: String? = nil,
        apsEnvironment: APNSEnvironment? = nil,
        pushToken: String? = nil,
        pushToStartToken: String? = nil,
        preferences: T3ConnectDevicePreferences = .init()
    ) {
        deviceId = deviceID
        self.label = label
        platform = "ios"
        self.iosMajorVersion = iosMajorVersion
        self.appVersion = appVersion
        bundleId = bundleID
        self.apsEnvironment = apsEnvironment
        self.pushToken = pushToken
        self.pushToStartToken = pushToStartToken
        self.preferences = preferences
    }
}

public struct T3ConnectLiveActivityRegistration: Codable, Equatable, Sendable {
    public let deviceId: String
    public let activityPushToken: String

    public init(deviceID: String, activityPushToken: String) {
        deviceId = deviceID
        self.activityPushToken = activityPushToken
    }
}

public struct T3ConnectRelayDevice: Codable, Identifiable, Equatable, Sendable {
    public struct Notifications: Codable, Equatable, Sendable {
        public let enabled: Bool
        public let notifyOnApproval: Bool
        public let notifyOnInput: Bool
        public let notifyOnCompletion: Bool
        public let notifyOnFailure: Bool
    }

    public struct LiveActivities: Codable, Equatable, Sendable {
        public let enabled: Bool
    }

    public var id: String { deviceId }

    public let deviceId: String
    public let label: String
    public let platform: String
    public let iosMajorVersion: Int
    public let appVersion: String?
    public let notifications: Notifications
    public let liveActivities: LiveActivities
    public let updatedAt: String
}

public struct T3ConnectRelayAccessToken: Codable, Equatable, Sendable {
    public let accessToken: String
    public let issuedTokenType: String
    public let tokenType: String
    public let expiresIn: Int
    public let scope: String

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case issuedTokenType = "issued_token_type"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case scope
    }
}

public struct T3ConnectEnvironmentAccessToken: Codable, Equatable, Sendable {
    public let environmentID: String
    public let label: String
    public let endpoint: T3ConnectManagedEndpoint
    public let accessToken: String
    public let expiresAt: Date
    public let scopes: [String]
    public let proofKeyThumbprint: String

    public init(
        environmentID: String,
        label: String,
        endpoint: T3ConnectManagedEndpoint,
        accessToken: String,
        expiresAt: Date,
        scopes: [String],
        proofKeyThumbprint: String
    ) {
        self.environmentID = environmentID
        self.label = label
        self.endpoint = endpoint
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.scopes = scopes
        self.proofKeyThumbprint = proofKeyThumbprint
    }
}
