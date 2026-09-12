import Foundation

enum PlatformRoute: Codable, Hashable, Identifiable, Sendable {
    #if DEBUG
    static let nativeScheme = "t3code-swiftui-dev"
    #else
    static let nativeScheme = "t3code-swiftui"
    #endif

    case connection(endpoint: String, token: String?)
    case environment(id: String)
    case project(environmentID: String?, projectID: String)
    case thread(environmentID: String?, threadID: String)
    case newTask(environmentID: String?, projectID: String?)

    var id: String {
        switch self {
        case let .connection(endpoint, token):
            "connection:\(endpoint):\(token ?? "")"
        case let .environment(id):
            "environment:\(id)"
        case let .project(environmentID, projectID):
            "project:\(environmentID ?? ""):\(projectID)"
        case let .thread(environmentID, threadID):
            "thread:\(environmentID ?? ""):\(threadID)"
        case let .newTask(environmentID, projectID):
            "new-task:\(environmentID ?? ""):\(projectID ?? "")"
        }
    }

    var url: URL? {
        var components = URLComponents()
        components.scheme = Self.nativeScheme

        switch self {
        case let .connection(endpoint, token):
            components.host = "connect"
            components.queryItems = [URLQueryItem(name: "endpoint", value: endpoint)]
            if let token {
                components.queryItems?.append(URLQueryItem(name: "token", value: token))
            }
        case let .environment(id):
            components.host = "environments"
            components.queryItems = [URLQueryItem(name: "environment", value: id)]
        case let .project(environmentID, projectID):
            components.host = "projects"
            components.queryItems = [
                environmentID.map { URLQueryItem(name: "environment", value: $0) },
                URLQueryItem(name: "project", value: projectID),
            ].compactMap { $0 }
        case let .thread(environmentID, threadID):
            components.host = "threads"
            components.queryItems = [
                environmentID.map { URLQueryItem(name: "environment", value: $0) },
                URLQueryItem(name: "thread", value: threadID),
            ].compactMap { $0 }
        case let .newTask(environmentID, projectID):
            components.host = "new-task"
            components.queryItems = [
                environmentID.map { URLQueryItem(name: "environment", value: $0) },
                projectID.map { URLQueryItem(name: "project", value: $0) },
            ].compactMap { $0 }
        }
        return components.url
    }
}

enum PlatformDeepLinkError: LocalizedError, Equatable {
    case unsupportedURL
    case missingIdentifier
    case invalidIdentifier

    var errorDescription: String? {
        switch self {
        case .unsupportedURL:
            "That T3 Code link is not supported."
        case .missingIdentifier:
            "That T3 Code link is missing its destination."
        case .invalidIdentifier:
            "That T3 Code link contains an invalid destination."
        }
    }
}

enum PlatformDeepLinkParser {
    private static let trustedWebHosts: Set<String> = [
        "app.t3.codes",
        "t3.codes",
        "www.t3.codes",
    ]

    static func parse(_ url: URL) throws -> PlatformRoute {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased()
        else {
            throw PlatformDeepLinkError.unsupportedURL
        }

        let query = queryValues(components.queryItems ?? [])
        if ["t3", "t3code", "t3code-swiftui", "t3code-swiftui-dev"].contains(scheme) {
            let segments = customSchemeSegments(components)
            if isConnectionRoute(segments: segments, query: query) {
                return try connectionRoute(url)
            }
            return try navigationRoute(segments: segments, query: query)
        }

        guard ["http", "https"].contains(scheme) else {
            throw PlatformDeepLinkError.unsupportedURL
        }

        guard let host = components.host?.lowercased(), trustedWebHosts.contains(host) else {
            throw PlatformDeepLinkError.unsupportedURL
        }

        let segments = pathSegments(components.percentEncodedPath)
        if isConnectionRoute(segments: segments, query: query) {
            return try connectionRoute(url)
        }

        if let explicit = try? navigationRoute(segments: segments, query: query) {
            return explicit
        }

        // Web thread routes use /:environmentID/:threadID.
        if segments.count >= 2 {
            return .thread(
                environmentID: try validatedIdentifier(segments[0]),
                threadID: try validatedIdentifier(segments[1])
            )
        }
        throw PlatformDeepLinkError.unsupportedURL
    }

    static func parse(_ value: String) throws -> PlatformRoute {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw PlatformDeepLinkError.unsupportedURL
        }
        return try parse(url)
    }

    private static func navigationRoute(
        segments: [String],
        query: [String: String]
    ) throws -> PlatformRoute {
        let head = segments.first?.lowercased() ?? ""
        let tail = Array(segments.dropFirst())
        let queryEnvironment = query["environment"] ?? query["environmentid"] ?? query["env"]
        let queryProject = query["project"] ?? query["projectid"]
        let queryThread = query["thread"] ?? query["threadid"]

        switch head {
        case "thread", "threads":
            let values = try routeIdentifiers(
                tail: tail,
                queryEnvironment: queryEnvironment,
                queryDestination: queryThread
            )
            return .thread(environmentID: values.environmentID, threadID: values.destinationID)
        case "project", "projects":
            let values = try routeIdentifiers(
                tail: tail,
                queryEnvironment: queryEnvironment,
                queryDestination: queryProject
            )
            return .project(environmentID: values.environmentID, projectID: values.destinationID)
        case "environment", "environments", "server", "servers":
            guard let rawID = tail.first ?? queryEnvironment else {
                throw PlatformDeepLinkError.missingIdentifier
            }
            return .environment(id: try validatedIdentifier(rawID))
        case "new", "new-task", "compose":
            return .newTask(
                environmentID: try queryEnvironment.map(validatedIdentifier),
                projectID: try queryProject.map(validatedIdentifier)
            )
        default:
            if let queryThread {
                return .thread(
                    environmentID: try queryEnvironment.map(validatedIdentifier),
                    threadID: try validatedIdentifier(queryThread)
                )
            }
            if let queryProject {
                return .project(
                    environmentID: try queryEnvironment.map(validatedIdentifier),
                    projectID: try validatedIdentifier(queryProject)
                )
            }
            throw PlatformDeepLinkError.unsupportedURL
        }
    }

    private static func routeIdentifiers(
        tail: [String],
        queryEnvironment: String?,
        queryDestination: String?
    ) throws -> (environmentID: String?, destinationID: String) {
        if let queryDestination {
            return (
                try queryEnvironment.map(validatedIdentifier),
                try validatedIdentifier(queryDestination)
            )
        }
        if tail.count >= 2 {
            return (
                try validatedIdentifier(tail[0]),
                try validatedIdentifier(tail[1])
            )
        }
        guard let destination = tail.first else {
            throw PlatformDeepLinkError.missingIdentifier
        }
        return (try queryEnvironment.map(validatedIdentifier), try validatedIdentifier(destination))
    }

    private static func connectionRoute(_ url: URL) throws -> PlatformRoute {
        do {
            let details = try ConnectionDetailsParser.parse(url.absoluteString)
            return .connection(endpoint: details.endpoint, token: details.pairingCode)
        } catch {
            throw PlatformDeepLinkError.unsupportedURL
        }
    }

    private static func isConnectionRoute(
        segments: [String],
        query: [String: String]
    ) -> Bool {
        let head = segments.first?.lowercased()
        return ["connect", "pair", "pairing"].contains(head)
            || query["pairingurl"] != nil
            || query["pairing_url"] != nil
            || query["endpoint"] != nil
            || query["server"] != nil
            || query["host"] != nil
    }

    private static func customSchemeSegments(_ components: URLComponents) -> [String] {
        var result: [String] = []
        if let host = components.host, !host.isEmpty {
            result.append(host)
        }
        result.append(contentsOf: pathSegments(components.percentEncodedPath))
        return result
    }

    private static func pathSegments(_ percentEncodedPath: String) -> [String] {
        percentEncodedPath
            .split(separator: "/", omittingEmptySubsequences: true)
            .map { String($0).removingPercentEncoding ?? String($0) }
    }

    private static func queryValues(_ items: [URLQueryItem]) -> [String: String] {
        items.reduce(into: [:]) { result, item in
            guard let value = item.value, !value.isEmpty else { return }
            result[item.name.lowercased()] = value
        }
    }

    private static func validatedIdentifier(_ rawValue: String) throws -> String {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw PlatformDeepLinkError.missingIdentifier }
        guard value.utf8.count <= 1_024,
              value != ".",
              value != "..",
              value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else {
            throw PlatformDeepLinkError.invalidIdentifier
        }
        return value
    }
}

/// One-shot storage bridges app intents and notification launches to the live scene.
final class PlatformRouteMailbox: @unchecked Sendable {
    static let shared = PlatformRouteMailbox()

    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()

    init(defaults: UserDefaults = .standard, key: String = "swift-ios.pending-platform-route.v1") {
        self.defaults = defaults
        self.key = key
    }

    func put(_ route: PlatformRoute) {
        lock.withLock {
            defaults.set(try? JSONEncoder().encode(route), forKey: key)
        }
    }

    func take() -> PlatformRoute? {
        lock.withLock {
            guard let data = defaults.data(forKey: key) else { return nil }
            defaults.removeObject(forKey: key)
            return try? JSONDecoder().decode(PlatformRoute.self, from: data)
        }
    }

    func peek() -> PlatformRoute? {
        lock.withLock {
            guard let data = defaults.data(forKey: key) else { return nil }
            return try? JSONDecoder().decode(PlatformRoute.self, from: data)
        }
    }
}
