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
    case threadDestination(environmentID: String?, threadID: String, destination: FeatureThreadDestination)
    case newTask(environmentID: String?, projectID: String?)
    case usageLimits

    var id: String {
        switch self {
        case .usageLimits:
            "usage-limits"
        case let .connection(endpoint, token):
            "connection:\(endpoint):\(token ?? "")"
        case let .environment(id):
            "environment:\(id)"
        case let .project(environmentID, projectID):
            "project:\(environmentID ?? ""):\(projectID)"
        case let .thread(environmentID, threadID):
            "thread:\(environmentID ?? ""):\(threadID)"
        case let .threadDestination(environmentID, threadID, destination):
            "thread:\(environmentID ?? ""):\(threadID):\(destination)"
        case let .newTask(environmentID, projectID):
            "new-task:\(environmentID ?? ""):\(projectID ?? "")"
        }
    }

    var url: URL? {
        var components = URLComponents()
        components.scheme = Self.nativeScheme

        switch self {
        case .usageLimits:
            components.host = "usage"
            components.path = "/limits"
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
        case let .threadDestination(environmentID, threadID, destination):
            components.host = "threads"
            components.path = destination.routePath
            components.queryItems = [
                environmentID.map { URLQueryItem(name: "environment", value: $0) },
                URLQueryItem(name: "thread", value: threadID),
            ].compactMap { $0 } + destination.routeQuery
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

    /// These links belong to the app even when their destination is unavailable.
    static func isThreadLink(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "t3-thread"
    }

    static func parse(_ url: URL) throws -> PlatformRoute {
        if isThreadLink(url) {
            return try threadLinkRoute(url.absoluteString)
        }
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

        let routeHeads = ["usage", "thread", "threads", "project", "projects", "environment",
                          "environments", "server", "servers", "new", "new-task", "compose"]
        if routeHeads.contains(segments.first?.lowercased() ?? "") || query["thread"] != nil {
            return try navigationRoute(segments: segments, query: query)
        }

        // Web thread routes use /:environmentID/:threadID.
        if segments.count >= 2 {
            return try threadRoute(
                environmentID: validatedIdentifier(segments[0]),
                threadID: validatedIdentifier(segments[1]),
                suffix: Array(segments.dropFirst(2)), query: query
            )
        }
        throw PlatformDeepLinkError.unsupportedURL
    }

    static func parse(_ value: String) throws -> PlatformRoute {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        // Parse before Foundation can repair malformed percent escapes in a URL.
        if value.lowercased().hasPrefix("t3-thread:") {
            return try threadLinkRoute(value)
        }
        guard let url = URL(string: value) else {
            throw PlatformDeepLinkError.unsupportedURL
        }
        return try parse(url)
    }

    /// New agent links resolve inside the environment that owns the message.
    /// Prefer the literal ID: delegated task IDs can contain percent escapes.
    static func threadLinkRoute(_ url: URL, environmentID: String, in snapshot: FeatureSnapshot) throws -> PlatformRoute {
        let value = url.absoluteString
        let prefix = "t3-thread://v1/"
        guard value.hasPrefix(prefix), !value.contains("?"), !value.contains("#") else {
            throw PlatformDeepLinkError.unsupportedURL
        }
        let id = String(value.dropFirst(prefix.count))
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              id.utf8.count <= 1_024,
              id.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            throw PlatformDeepLinkError.invalidIdentifier
        }
        if PlatformRouteResolver.thread(in: snapshot, environmentID: environmentID, id: id) != nil {
            return .thread(environmentID: environmentID, threadID: id)
        }
        if let decoded = id.removingPercentEncoding, decoded != id,
           PlatformRouteResolver.thread(in: snapshot, environmentID: environmentID, id: decoded) != nil {
            return .thread(environmentID: environmentID, threadID: decoded)
        }
        // Keep links from older servers usable when they name a known environment.
        if case let .thread(legacyEnvironment?, legacyID) = try? threadLinkRoute(value),
           snapshot.environments.contains(where: { $0.id == legacyEnvironment }) {
            return .thread(environmentID: legacyEnvironment, threadID: legacyID)
        }
        return .thread(environmentID: environmentID, threadID: id)
    }

    private static func threadLinkRoute(_ value: String) throws -> PlatformRoute {
        let prefix = "t3-thread://v1/"
        guard value.hasPrefix(prefix), !value.contains("?"), !value.contains("#") else {
            throw PlatformDeepLinkError.unsupportedURL
        }
        let segments = value.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false)
        if segments.count == 1, let segment = segments.first {
            let id = String(segment)
            guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, id.utf8.count <= 1_024,
                  id.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
                throw PlatformDeepLinkError.invalidIdentifier
            }
            return .thread(environmentID: nil, threadID: id)
        }
        guard segments.count == 2 else { throw PlatformDeepLinkError.invalidIdentifier }
        let ids = try segments.map { segment in
            guard let id = String(segment).removingPercentEncoding,
                  !id.isEmpty,
                  id.utf8.count <= 1_024,
                  id.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
                throw PlatformDeepLinkError.invalidIdentifier
            }
            return id
        }
        return .thread(environmentID: ids[0], threadID: ids[1])
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
        case "usage" where tail == ["limits"]:
            return .usageLimits
        case "thread", "threads":
            let values = try routeIdentifiers(
                tail: tail,
                queryEnvironment: queryEnvironment,
                queryDestination: queryThread
            )
            let consumed = queryThread != nil ? 0 : (queryEnvironment != nil ? 1 : (tail.count >= 2 ? 2 : 1))
            return try threadRoute(
                environmentID: values.environmentID, threadID: values.destinationID,
                suffix: Array(tail.dropFirst(consumed)), query: query
            )
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

    private static func threadRoute(
        environmentID: String?, threadID: String, suffix: [String], query: [String: String]
    ) throws -> PlatformRoute {
        guard let head = suffix.first else {
            return .thread(environmentID: environmentID, threadID: threadID)
        }
        let destination: FeatureThreadDestination
        switch head {
        case "files":
            let rawPath = suffix.count > 1 ? suffix.dropFirst().joined(separator: "/") : query["path"]
            let path = try rawPath.map(validatedFilePath)
            let line: Int?
            if let raw = query["line"] {
                guard let value = Int(raw), value > 0 else { throw PlatformDeepLinkError.invalidIdentifier }
                line = value
            } else { line = nil }
            destination = .files(path: path, line: line)
        case "terminal" where suffix.count == 1:
            destination = .terminal(sessionID: try (query["session"] ?? query["sessionid"] ?? query["terminalid"]).map(validatedIdentifier))
        case "review" where suffix.count == 1: destination = .review
        case "devices" where suffix.count == 1: destination = .devices
        case "browser" where suffix.count == 1:
            destination = .browser(tabID: try query["tab"].map(validatedIdentifier))
        case "git" where suffix.count == 1: destination = .git
        case "git" where suffix == ["git", "commit"]: destination = .gitCommit
        case "git" where suffix == ["git", "branches"]: destination = .gitBranches
        default: throw PlatformDeepLinkError.unsupportedURL
        }
        return .threadDestination(environmentID: environmentID, threadID: threadID, destination: destination)
    }

    private static func validatedFilePath(_ raw: String) throws -> String {
        guard !raw.isEmpty, raw.utf8.count <= 16_384, !raw.hasPrefix("/"),
              !raw.contains("\\"), raw.range(of: #"^[A-Za-z]:"#, options: .regularExpression) == nil,
              raw.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
              raw.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({
                  !$0.isEmpty && $0 != "." && $0 != ".."
              }) else { throw PlatformDeepLinkError.invalidIdentifier }
        return raw
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
        if let queryEnvironment, let destination = tail.first {
            return (try validatedIdentifier(queryEnvironment), try validatedIdentifier(destination))
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
}

private extension FeatureThreadDestination {
    var routePath: String {
        switch self {
        case .files: "/files"
        case .terminal: "/terminal"
        case .review: "/review"
        case .devices: "/devices"
        case .browser: "/browser"
        case .git: "/git"
        case .gitCommit: "/git/commit"
        case .gitBranches: "/git/branches"
        }
    }

    var routeQuery: [URLQueryItem] {
        switch self {
        case let .files(path, line):
            [path.map { URLQueryItem(name: "path", value: $0) },
             line.map { URLQueryItem(name: "line", value: String($0)) }].compactMap { $0 }
        case let .browser(tabID):
            tabID.map { [URLQueryItem(name: "tab", value: $0)] } ?? []
        case let .terminal(sessionID):
            sessionID.map { [URLQueryItem(name: "session", value: $0)] } ?? []
        default: []
        }
    }
}
