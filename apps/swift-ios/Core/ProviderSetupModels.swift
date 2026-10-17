import Foundation

public struct ProviderVersionAdvisory: Codable, Equatable, Hashable, Sendable {
    public let status: String
    public let currentVersion: String?
    public let latestVersion: String?
    public let canUpdate: Bool?
    public let message: String?
}
public struct ProviderCompatibilityAdvisory: Codable, Equatable, Hashable, Sendable {
    public let status: String
    public let latestVersionStatus: String?
    public let message: String?
    public let recommendedVersion: String?
}
public struct ProviderUpdateState: Codable, Equatable, Hashable, Sendable {
    public let status: String
    public let message: String?
    public var isRunning: Bool { status == "running" || status == "queued" }
}

public struct ProviderSetupCapabilities: Codable, Equatable, Hashable, Sendable {
    public let canAuthenticate: Bool
    public let canInstall: Bool
    public var documentationUrl: String? = nil
}

/// Installed registry agents discover their auth methods through the auth stream.
public enum ProviderAccountDiscovery {
    public static func isSupported(driver: String, installed: Bool?, setup: ProviderSetupCapabilities?) -> Bool {
        setup?.canAuthenticate == true || (driver == "acpRegistry" && installed == true)
    }

    public static func isDiscovering(driver: String, auth: ProviderAuthState?) -> Bool {
        driver == "acpRegistry" && auth?.methods == nil && auth?.isActive != true
    }

    public static func needsExternalSetup(driver: String, setup: ProviderSetupCapabilities?, auth: ProviderAuthState?) -> Bool {
        setup?.canAuthenticate == false || (driver == "acpRegistry" && auth?.methods?.isEmpty == true)
    }
}

public struct ProviderAuthMethod: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let type: String
    public let accountEmail: String?
}

public struct ProviderAuthInteraction: Codable, Equatable, Sendable {
    public struct Field: Codable, Identifiable, Equatable, Sendable {
        public let name: String
        public let label: String
        public let secret: Bool
        public var id: String { name }
    }
    public let type: String
    public let id: String
    public let url: String?
    public let requiresConsent: Bool?
    public let acceptsCallback: Bool?
    public let userCode: String?
    public let output: String?
    public let fields: [Field]?
}

public struct ProviderAuthState: Codable, Equatable, Sendable {
    public let instanceId: String
    public let phase: String
    public let flowId: String?
    public let authorizationUrl: String?
    public var methods: [ProviderAuthMethod]? = nil
    public var interaction: ProviderAuthInteraction? = nil
    public var credentialOwner: String? = nil
    public let expiresAt: String?
    public let message: String?

    public var isActive: Bool { ["starting", "waiting", "verifying"].contains(phase) }
}

public struct ProviderInstallState: Codable, Equatable, Sendable {
    public let driver: String
    public let operationId: String?
    public let phase: String
    public let downloadedBytes: Int64
    public let totalBytes: Int64?
    public let version: String?
    public let installedVersion: String?
    public let canRemove: Bool
    public let message: String?

    public var isActive: Bool { ["downloading", "extracting", "verifying"].contains(phase) }
}

public enum ProviderSetupEvent: Sendable {
    case auth(ProviderAuthState)
    case install(ProviderInstallState)
}

public enum ProviderSetupAction: Sendable {
    case signIn
    case signInMethod(String)
    case respond(flowID: String, interactionID: String, response: JSONValue)
    case completeSignIn(flowID: String, callbackURL: String)
    case cancelSignIn(flowID: String)
    case signOut
    case install
    case cancelInstall(operationID: String)
    case remove

    var method: String {
        switch self {
        case .signIn, .signInMethod: "provider.auth.start"
        case .respond: "provider.auth.respond"
        case .completeSignIn: "provider.auth.complete"
        case .cancelSignIn: "provider.auth.cancel"
        case .signOut: "provider.auth.logout"
        case .install: "provider.install.start"
        case .cancelInstall: "provider.install.cancel"
        case .remove: "provider.install.remove"
        }
    }

    func payload(instanceID: String) -> JSONValue {
        var fields: [String: JSONValue] = ["instanceId": .string(instanceID)]
        switch self {
        case .signIn:
            fields["callbackMode"] = .string("client")
        case let .signInMethod(methodID):
            fields["methodId"] = .string(methodID)
            fields["callbackMode"] = .string("client")
        case let .respond(flowID, interactionID, response):
            fields["flowId"] = .string(flowID)
            fields["interactionId"] = .string(interactionID)
            fields["response"] = response
        case let .completeSignIn(flowID, callbackURL):
            fields["flowId"] = .string(flowID)
            fields["callbackUrl"] = .string(callbackURL)
        case let .cancelSignIn(flowID): fields["flowId"] = .string(flowID)
        case let .cancelInstall(operationID): fields["operationId"] = .string(operationID)
        default: break
        }
        return .object(fields)
    }
}

enum ProviderSettingsPatch {
    static func enabled(settings: JSONValue, instanceID: String, driver: String, enabled: Bool) -> JSONValue {
        var instances: [String: JSONValue] = if case let .object(values) = settings["providerInstances"] { values } else { [:] }
        var instance: [String: JSONValue] = if case let .object(values) = instances[instanceID] { values } else { ["driver": .string(driver)] }
        var config: [String: JSONValue] = if case let .object(values) = instance["config"] ?? settings["providers"]?[driver] { values } else { [:] }
        config["enabled"] = nil
        instance["config"] = .object(config)
        instance["enabled"] = .bool(enabled)
        instances[instanceID] = .object(instance)
        var patch: [String: JSONValue] = ["providerInstances": .object(instances)]
        if instanceID == "antigravity", settings["providers"] != nil {
            // The explicit instance now owns these settings. Clear the legacy copy.
            patch["providers"] = .object(["antigravity": .object([
                "enabled": .bool(false), "authMethod": .string("oauth-personal"),
                "apiKey": .string(""), "gcpProject": .string(""), "gcpLocation": .string(""),
                "binaryPath": .string(""), "customModels": .array([]),
            ])])
        }
        return .object(patch)
    }
}
