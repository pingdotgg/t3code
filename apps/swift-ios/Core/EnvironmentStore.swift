import Foundation

public enum SavedConnectionEditError: LocalizedError, Equatable {
    case unsupportedConnection
    case emptyLabel
    case identityMismatch
    case changedConnection

    public var errorDescription: String? {
        switch self {
        case .unsupportedConnection: "Only saved direct bearer connections can be edited."
        case .emptyLabel: "Enter a connection name."
        case .identityMismatch: "That address belongs to a different environment. Add it as a new connection."
        case .changedConnection: "This connection changed while saving. Open it again and retry."
        }
    }
}

extension EnvironmentStore {
    /// A label is local metadata. Keep the saved endpoints and descriptor unchanged.
    @discardableResult
    public func renameSavedConnection(expected: Environment, label: String) throws -> Environment {
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { throw SavedConnectionEditError.emptyLabel }
        var current = try savedConnection(matching: expected)
        current.label = label
        try upsert(current)
        return current
    }

    /// Changes only editable fields after the new host identity has been checked.
    /// Keep concurrent enable/protocol changes and never restore a removed record.
    @discardableResult
    public func editSavedConnection(
        expected: Environment, label: String, httpBaseURL: URL,
        webSocketBaseURL: URL, descriptor: EnvironmentDescriptor
    ) throws -> Environment {
        guard expected.kind == .bearer else { throw SavedConnectionEditError.unsupportedConnection }
        guard descriptor.environmentId == expected.id else { throw SavedConnectionEditError.identityMismatch }
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { throw SavedConnectionEditError.emptyLabel }
        var current = try savedConnection(matching: expected)
        current.label = label
        var route = current.selectedRoute
        guard !route.isLearned else { throw SavedConnectionEditError.unsupportedConnection }
        route.httpBaseURL = httpBaseURL
        route.webSocketBaseURL = webSocketBaseURL
        current = current.mergingRoute(route, select: true)
        current.descriptor = descriptor
        try upsert(current)
        return current
    }

    private func savedConnection(matching expected: Environment) throws -> Environment {
        guard expected.kind == .bearer else { throw SavedConnectionEditError.unsupportedConnection }
        guard let current = try load().first(where: { $0.id == expected.id }),
              current.kind == expected.kind, current.httpBaseURL == expected.httpBaseURL,
              current.webSocketBaseURL == expected.webSocketBaseURL, current.label == expected.label,
              current.activeRouteID == expected.activeRouteID, current.credentialID == expected.credentialID else {
            throw SavedConnectionEditError.changedConnection
        }
        return current
    }
}

extension Environment {
    func hasSameConnectionEndpoint(httpBaseURL: URL, webSocketBaseURL: URL) -> Bool {
        Self.normalizedConnectionURL(self.httpBaseURL) == Self.normalizedConnectionURL(httpBaseURL)
            && Self.normalizedConnectionURL(self.webSocketBaseURL) == Self.normalizedConnectionURL(webSocketBaseURL)
    }

    private static func normalizedConnectionURL(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        if components.path.isEmpty { components.path = "/" }
        if ((components.scheme == "https" || components.scheme == "wss") && components.port == 443)
            || ((components.scheme == "http" || components.scheme == "ws") && components.port == 80) {
            components.port = nil
        }
        return components.url
    }
}

extension EnvironmentStore {
    /// Merge on this actor so pairing never replaces routes or preferences
    /// saved while the one-time credential exchange was in progress.
    @discardableResult
    public func savePairedRoute(
        _ route: EnvironmentRoute, descriptor: EnvironmentDescriptor,
        expected: Environment?
    ) throws -> Environment {
        let current = try load().first { $0.id == descriptor.environmentId }
        if expected != nil && current == nil { throw EnvironmentRouteError.changedEnvironment }
        var environment = current ?? Environment(
            id: descriptor.environmentId, label: descriptor.label,
            httpBaseURL: route.httpBaseURL, webSocketBaseURL: route.webSocketBaseURL,
            kind: route.kind, descriptor: descriptor, routes: [route]
        )
        environment.descriptor = descriptor
        environment = environment.mergingRoute(route, select: true)
        try upsert(environment)
        return environment
    }

    @discardableResult
    public func selectRoute(environmentID: String, route: EnvironmentRoute) throws -> Environment {
        guard let current = try load().first(where: { $0.id == environmentID }) else {
            throw EnvironmentRouteError.missingEnvironment
        }
        guard current.routes.contains(route), current.isEnabled else {
            throw EnvironmentRouteError.changedEnvironment
        }
        let updated = current.selectingRoute(route)
        try upsert(updated)
        return updated
    }

    @discardableResult
    public func reorderRoutes(environmentID: String, routeIDs: [String]) throws -> Environment {
        guard var current = try load().first(where: { $0.id == environmentID }) else {
            throw EnvironmentRouteError.missingEnvironment
        }
        guard routeIDs.count == current.routes.count,
              Set(routeIDs) == Set(current.routes.map(\.id)) else { throw EnvironmentRouteError.invalidOrder }
        let byID = Dictionary(uniqueKeysWithValues: current.routes.map { ($0.id, $0) })
        current.routes = routeIDs.compactMap { byID[$0] }
        try upsert(current)
        return current
    }

    @discardableResult
    public func removeRoute(environmentID: String, routeID: String) throws -> Environment {
        guard let current = try load().first(where: { $0.id == environmentID }) else {
            throw EnvironmentRouteError.missingEnvironment
        }
        let updated = try current.removingRoute(id: routeID)
        try upsert(updated)
        return updated
    }

    /// The caller must have obtained hints from a verified, authenticated route.
    @discardableResult
    public func mergeDiscoveredEndpoints(
        environmentID: String, endpoints: [EnvironmentDirectEndpoint]?, verifiedRoute: EnvironmentRoute
    ) throws -> Environment {
        guard let current = try load().first(where: { $0.id == environmentID }) else {
            throw EnvironmentRouteError.missingEnvironment
        }
        guard current.routes.contains(verifiedRoute) else { throw EnvironmentRouteError.changedEnvironment }
        let updated = current.mergingDiscoveredEndpoints(endpoints, credentialOwnerID: verifiedRoute.credentialOwnerID)
        if updated != current { try upsert(updated) }
        return updated
    }

    /// Drop only cloud access. Independent pairings retain their cache identity.
    @discardableResult
    public func removeManagedRoutes() throws -> [Environment] {
        let previous = try load()
        let updated = previous.compactMap { $0.removingManagedRoutes() }
        try save(updated)
        if let active = try activeEnvironmentID(), !updated.contains(where: { $0.id == active }) {
            try setActiveEnvironment(id: updated.first(where: \.isEnabled)?.id)
        }
        return updated
    }
}
