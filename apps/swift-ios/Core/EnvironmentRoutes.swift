import Foundation

/// A route owns a credential or borrows one from an explicitly paired route.
/// Environment identity remains the key for all project and thread caches.
public struct EnvironmentRoute: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var httpBaseURL: URL
    public var webSocketBaseURL: URL
    public let kind: EnvironmentKind
    public let credentialOwnerID: String
    public let isLearned: Bool
    public var endpointKind: EnvironmentDirectEndpoint.Kind?

    public init(
        id: String, httpBaseURL: URL, webSocketBaseURL: URL,
        kind: EnvironmentKind, credentialOwnerID: String, isLearned: Bool = false,
        endpointKind: EnvironmentDirectEndpoint.Kind? = nil
    ) {
        self.id = id
        self.httpBaseURL = httpBaseURL
        self.webSocketBaseURL = webSocketBaseURL
        self.kind = kind
        self.credentialOwnerID = credentialOwnerID
        self.isLearned = isLearned
        self.endpointKind = endpointKind
    }

    public var label: String {
        if id == "relay" { return "T3 Connect" }
        switch endpointKind {
        case .lan: return "Local network"
        case .tailnet: return "Tailscale"
        case nil: return httpBaseURL.host ?? "Direct"
        }
    }

    // New routes get a useful default position. Existing entries never move
    // during discovery, so user order continues to win on later refreshes.
    var insertionRank: Int {
        if id == "relay" { return 5 }
        if kind == .local { return 0 }
        switch endpointKind {
        case .lan: return 1
        case .tailnet: return 2
        case nil: break
        }
        let host = httpBaseURL.host?.lowercased() ?? ""
        let octets = host.split(separator: ".").compactMap { Int($0) }
        if host == "localhost" || host == "127.0.0.1" || host == "[::1]" { return 0 }
        if host.hasSuffix(".local") || (octets.count == 4 &&
            (octets[0] == 10 || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 172 && (16...31).contains(octets[1])))) { return 1 }
        if host.hasSuffix(".ts.net") || (octets.count == 4 && octets[0] == 100 && (64...127).contains(octets[1])) { return 2 }
        return 3
    }

    public var normalizedOrigin: String? { Self.normalizedOrigin(httpBaseURL) }

    public static func normalizedOrigin(_ url: URL) -> String? {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil else { return nil }
        parts.scheme = scheme
        parts.host = host
        if (scheme == "http" && parts.port == 80) || (scheme == "https" && parts.port == 443) {
            parts.port = nil
        }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        return parts.url?.absoluteString
    }
}

public struct EnvironmentDirectEndpoint: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case lan, tailnet }
    public let kind: Kind
    public let httpBaseUrl: String

    public init(kind: Kind, httpBaseUrl: String) {
        self.kind = kind
        self.httpBaseUrl = httpBaseUrl
    }

    /// Hints are never credentials. Reject loopback and malformed hints before
    /// descriptor verification; a valid hint still has to prove its identity.
    public var httpBaseURL: URL? {
        guard let url = URL(string: httpBaseUrl),
              let origin = EnvironmentRoute.normalizedOrigin(url),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              let host = parts.host?.lowercased(),
              host != "localhost", !host.hasSuffix(".localhost"),
              host != "::1", host != "[::1]", host != "0.0.0.0",
              host != "::", host != "[::]", !host.hasPrefix("127."),
              !host.hasPrefix("::ffff:127."), !host.hasPrefix("[::ffff:127.") else { return nil }
        return URL(string: origin + "/")
    }
}

public enum EnvironmentRouteError: LocalizedError, Equatable, Sendable {
    case missingEnvironment
    case missingRoute
    case identityMismatch
    case invalidOrder
    case learnedRoute
    case lastRoute
    case changedEnvironment
    case noAvailableRoute

    public var errorDescription: String? {
        switch self {
        case .missingEnvironment: "This environment is no longer saved."
        case .missingRoute: "This route is no longer saved."
        case .identityMismatch: "This address belongs to a different environment."
        case .invalidOrder: "The route list changed. Open it again and retry."
        case .learnedRoute: "Automatically found routes are managed by the server."
        case .lastRoute: "Remove the environment to remove its last route."
        case .changedEnvironment: "The connection changed. Please retry."
        case .noAvailableRoute: "No saved route could connect to this environment."
        }
    }
}

extension Environment {
    public var selectedRoute: EnvironmentRoute {
        routes.first(where: { $0.id == activeRouteID }) ?? routes.first ?? legacyRoute
    }

    public var credentialID: String { selectedRoute.credentialOwnerID }
    public var credentialOwnerIDs: Set<String> { Set(routes.map(\.credentialOwnerID)) }
    public var hasManagedRoutes: Bool { routes.contains { $0.kind == .managedDPoP } }

    var legacyRoute: EnvironmentRoute {
        EnvironmentRoute(
            id: kind == .managedDPoP ? "relay" : "direct",
            httpBaseURL: httpBaseURL, webSocketBaseURL: webSocketBaseURL,
            kind: kind, credentialOwnerID: id
        )
    }

    /// Call only with a route from this catalog. URL consumers use this same
    /// selected value for sockets, HTTP, assets, terminals, and devices.
    public func selectingRoute(_ route: EnvironmentRoute) -> Environment {
        var result = self
        result.activeRouteID = route.id
        result.httpBaseURL = route.httpBaseURL
        result.webSocketBaseURL = route.webSocketBaseURL
        result.kind = route.kind
        return result
    }

    public func mergingRoute(_ route: EnvironmentRoute, select: Bool = false) -> Environment {
        var result = self
        if let index = result.routes.firstIndex(where: { $0.id == route.id }) {
            result.routes[index] = route
        } else if let index = result.routes.firstIndex(where: {
            $0.normalizedOrigin != nil && $0.normalizedOrigin == route.normalizedOrigin && $0.isLearned
        }) {
            result.routes[index] = route
        } else {
            let index = result.routes.firstIndex { $0.insertionRank > route.insertionRank } ?? result.routes.endIndex
            result.routes.insert(route, at: index)
        }
        if select || !result.routes.contains(where: { $0.id == result.activeRouteID }) {
            return result.selectingRoute(route)
        }
        return result.selectingRoute(result.selectedRoute)
    }

    /// Only invoke after an authenticated connection supplied these hints.
    /// Existing order wins; new hints use network priority. nil means no field.
    public func mergingDiscoveredEndpoints(
        _ endpoints: [EnvironmentDirectEndpoint]?, credentialOwnerID: String
    ) -> Environment {
        guard let endpoints,
              let owner = routes.first(where: { !$0.isLearned && $0.credentialOwnerID == credentialOwnerID }),
              owner.kind != .local else { return self }
        var origins = Set<String>()
        let valid = endpoints.compactMap { hint -> (EnvironmentDirectEndpoint, URL, String)? in
            guard let url = hint.httpBaseURL,
                  let origin = EnvironmentRoute.normalizedOrigin(url),
                  origins.insert(origin).inserted else { return nil }
            return (hint, url, origin)
        }
        let advertised = Set(valid.map { $0.2 })
        var result = self
        // Discovery is environment-wide. Independent manual pairings survive.
        result.routes.removeAll { $0.isLearned && !advertised.contains($0.normalizedOrigin ?? "") }
        for (hint, url, origin) in valid {
            if result.routes.contains(where: { $0.normalizedOrigin == origin }) { continue }
            var websocket = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            websocket.scheme = url.scheme == "https" ? "wss" : "ws"
            websocket.path = "/ws"
            guard let webSocketURL = websocket.url else { continue }
            let route = EnvironmentRoute(
                id: "learned:\(origin)", httpBaseURL: url, webSocketBaseURL: webSocketURL,
                kind: owner.kind, credentialOwnerID: owner.credentialOwnerID,
                isLearned: true, endpointKind: hint.kind
            )
            let index = result.routes.firstIndex { $0.insertionRank > route.insertionRank } ?? result.routes.endIndex
            result.routes.insert(route, at: index)
        }
        return result.selectingRoute(result.selectedRoute)
    }

    public func removingRoute(id routeID: String) throws -> Environment {
        guard let route = routes.first(where: { $0.id == routeID }) else { throw EnvironmentRouteError.missingRoute }
        guard !route.isLearned else { throw EnvironmentRouteError.learnedRoute }
        var result = self
        result.routes.removeAll { $0.id == routeID || ($0.isLearned && $0.credentialOwnerID == route.credentialOwnerID) }
        guard let fallback = result.routes.first else { throw EnvironmentRouteError.lastRoute }
        return result.selectingRoute(result.routes.first(where: { $0.id == activeRouteID }) ?? fallback)
    }

    public func removingManagedRoutes() -> Environment? {
        var result = self
        result.routes.removeAll { $0.kind == .managedDPoP }
        guard let fallback = result.routes.first else { return nil }
        return result.selectingRoute(result.routes.first(where: { $0.id == activeRouteID }) ?? fallback)
    }
}
