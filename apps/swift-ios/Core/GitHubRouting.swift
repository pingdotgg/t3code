import Foundation

public enum GitHubRoutingPermission: String, Codable, CaseIterable, Sendable {
    case off
    case read
    case readWrite = "read-write"

    public var label: String {
        switch self {
        case .off: "Off"
        case .read: "Read"
        case .readWrite: "Read and write"
        }
    }
}

/// Permission belongs to the saved endpoint, not an identity advertised by a server.
public struct GitHubRoutingGrant: Codable, Equatable, Sendable {
    public let environmentID: String
    public let connectionKey: String
    public let permission: GitHubRoutingPermission

    public static func connectionKey(_ environment: Environment) -> String? {
        let http = environment.httpBaseURL
        let ws = environment.webSocketBaseURL
        guard ["http", "https"].contains(http.scheme ?? ""), ["ws", "wss"].contains(ws.scheme ?? ""),
              http.host != nil, ws.host != nil, http.user == nil, http.password == nil,
              ws.user == nil, ws.password == nil else { return nil }
        return [environment.kind.rawValue, environment.id,
                http.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                ws.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))]
            .joined(separator: "\u{0}")
    }

    public static func permission(for environment: Environment, grants: [Self]) -> GitHubRoutingPermission {
        guard let key = connectionKey(environment) else { return .off }
        return grants.first { $0.environmentID == environment.id && $0.connectionKey == key }?.permission ?? .off
    }

    public static func allowed(origin: Environment, destination: Environment, grants: [Self], write: Bool) -> Bool {
        guard origin.isEnabled, destination.isEnabled, origin.id != destination.id else { return false }
        let source = permission(for: origin, grants: grants)
        let target = permission(for: destination, grants: grants)
        return write ? source == .readWrite && target == .readWrite : source != .off && target != .off
    }
}
