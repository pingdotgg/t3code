import Foundation

public struct ProviderSetupCapabilities: Codable, Equatable, Hashable, Sendable {
    public let canAuthenticate: Bool
    public let canInstall: Bool
}

public struct ProviderAuthState: Codable, Equatable, Sendable {
    public let instanceId: String
    public let phase: String
    public let flowId: String?
    public let authorizationUrl: String?
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
    case completeSignIn(flowID: String, callbackURL: String)
    case cancelSignIn(flowID: String)
    case signOut
    case install
    case cancelInstall(operationID: String)
    case remove

    var method: String {
        switch self {
        case .signIn: "provider.auth.start"
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
        if instanceID == "antigravity" {
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
