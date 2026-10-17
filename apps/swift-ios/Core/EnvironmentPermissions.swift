import Foundation

/// Presence of the update scope identifies servers with exact permission grants.
public struct EnvironmentAuthMetadata: Codable, Hashable, Sendable {
    public let serverUpdateScope: String?

    public init(serverUpdateScope: String? = nil) {
        self.serverUpdateScope = serverUpdateScope
    }
}

public struct EnvironmentPermissionDeniedError: LocalizedError, Equatable, Sendable {
    public let message: String
    public let requiredScope: String
    public let requiredPermission: String?
    public let traceID: String?

    public init(
        message: String? = nil,
        requiredScope: String,
        requiredPermission: String? = nil,
        traceID: String? = nil
    ) {
        self.message = message ?? "This connection needs the \(requiredPermission ?? requiredScope) permission. Pair again using a new link with that permission."
        self.requiredScope = requiredScope
        self.requiredPermission = requiredPermission
        self.traceID = traceID
    }

    public var errorDescription: String? {
        traceID.map { "\(message) (trace \($0))" } ?? message
    }
}

private let legacyPermissionParents = [
    "filesystem:read": "orchestration:read",
    "diagnostics:read": "orchestration:read",
    "settings:write": "orchestration:operate",
    "providers:manage": "orchestration:operate",
    "environment:maintain": "orchestration:operate",
    "preview:operate": "orchestration:operate",
    "source-control:write": "orchestration:operate",
    "filesystem:write": "orchestration:operate",
    "terminal:read": "terminal:operate",
]

public extension AuthSessionState {
    func grants(_ permission: String, serverAuth: EnvironmentAuthMetadata? = nil) -> Bool {
        guard authenticated else { return false }
        if let permissions { return permissions.contains(permission) }
        if scopes?.contains(permission) == true { return true }
        guard auth?.serverUpdateScope == nil, serverAuth?.serverUpdateScope == nil,
              let parent = legacyPermissionParents[permission] else { return false }
        return scopes?.contains(parent) == true
    }

    /// A current server reports old credentials through its exact permissions field.
    var hasLegacyPermissions: Bool {
        let legacy: Set<String> = [
            "orchestration:read", "orchestration:operate", "terminal:operate", "review:write",
            "access:read", "access:write", "relay:read", "relay:write",
        ]
        guard authenticated, let permissions,
              permissions.allSatisfy(legacy.contains) else { return false }
        return permissions.contains { legacyPermissionParents.values.contains($0) }
    }
}

/// Cache one value per environment. Use a nil session while loading or after a
/// failed refresh so command checks never use grants from an earlier connection.
public struct EnvironmentPermissionState: Codable, Hashable, Sendable {
    public let session: AuthSessionState?
    public let serverAuth: EnvironmentAuthMetadata?

    public init(session: AuthSessionState? = nil, serverAuth: EnvironmentAuthMetadata? = nil) {
        self.session = session
        self.serverAuth = serverAuth
    }

    public func grants(_ permission: String) -> Bool {
        session?.grants(permission, serverAuth: serverAuth) == true
    }

    public var hasLegacyPermissions: Bool { session?.hasLegacyPermissions == true }

    public func require(_ permission: String) throws {
        guard grants(permission) else {
            throw EnvironmentPermissionDeniedError(
                requiredScope: legacyPermissionParents[permission] ?? permission,
                requiredPermission: permission
            )
        }
    }
}

public enum EnvironmentPermissionRequirements {
    public static func settingsPatch(_ patch: [String: JSONValue]) -> [String] {
        let providerKeys: Set<String> = ["providers", "providerInstances", "usageLimitSources"]
        let providers = patch.keys.contains { providerKeys.contains($0) }
        return ["settings:write"] + (providers ? ["providers:manage"] : [])
    }

    public static func asset(resourceKind: String) -> String {
        switch resourceKind {
        case "workspace-file", "media-file", "draft-workspace-file": "filesystem:read"
        default: "orchestration:read"
        }
    }
}
