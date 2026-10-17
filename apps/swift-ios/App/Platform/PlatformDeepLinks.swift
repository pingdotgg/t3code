import Foundation

public struct PlatformLinkedPrompt: Codable, Hashable, Sendable {
    public let text: String
    public let hiddenCharacters: Int

    enum DraftAction: Equatable { case fill, keep, ask }

    func draftAction(currentText: String) -> DraftAction {
        if currentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .fill }
        return currentText == text ? .keep : .ask
    }

    func applying(to draft: FeatureComposerDraft, replaceExisting: Bool = false) -> FeatureComposerDraft? {
        guard replaceExisting || draftAction(currentText: draft.text) != .ask else { return nil }
        var result = draft
        result.text = text
        return result
    }

    /// Keep local edits and all non-text fields. Reopening the same link does not add it twice.
    func appending(to draft: FeatureComposerDraft) -> FeatureComposerDraft {
        var result = draft
        guard draft.text != text, !draft.text.hasSuffix("\n" + text) else { return result }
        result.text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? text : draft.text + "\n\n" + text
        return result
    }

    func notice(modelUnavailable: Bool = false, pullRequestUnavailable: Int? = nil) -> String {
        var lines = [hiddenCharacters > 0
            ? "This prompt had hidden characters, it may be malicious. They were removed. Read it before you send."
            : "This prompt came from a link. Read it before you send."]
        if modelUnavailable { lines.append("The requested model is not available, so your default is used.") }
        if let number = pullRequestUnavailable {
            lines.append("Pull request #\(number) could not be loaded, so this task starts from your default branch.")
        }
        return lines.joined(separator: "\n\n")
    }
}

public struct PlatformPromptRepository: Codable, Hashable, Sendable {
    let owner: String
    let name: String
    var fullName: String { "\(owner)/\(name)" }
    var key: String { "github.com/\(fullName)".lowercased() }
}

public struct PlatformPromptPullRequest: Codable, Hashable, Sendable {
    let repository: PlatformPromptRepository
    let number: Int
    var url: String { "https://github.com/\(repository.fullName)/pull/\(number)" }
    var key: ThreadPullRequestKey {
        .init(host: "github.com", repository: repository.fullName, number: number)
    }
}

public enum PlatformNewThreadLink: Codable, Hashable, Sendable {
    case new(prompt: PlatformLinkedPrompt, repository: PlatformPromptRepository?, provider: String?, model: String?)
    case pullRequest(PlatformPromptPullRequest, prompt: PlatformLinkedPrompt?)

    var prompt: PlatformLinkedPrompt? {
        switch self {
        case let .new(prompt, _, _, _), let .pullRequest(_, prompt?): prompt
        case .pullRequest(_, nil): nil
        }
    }

    var repository: PlatformPromptRepository? {
        switch self {
        case let .new(_, repository, _, _): repository
        case let .pullRequest(pr, _): pr.repository
        }
    }

    var queryItems: [URLQueryItem] {
        switch self {
        case let .new(prompt, repository, provider, model):
            [URLQueryItem(name: "prompt", value: prompt.text),
             repository.map { URLQueryItem(name: "repo", value: $0.fullName) },
             provider.map { URLQueryItem(name: "provider", value: $0) },
             model.map { URLQueryItem(name: "model", value: $0) }].compactMap { $0 }
        case let .pullRequest(pr, prompt):
            [URLQueryItem(name: "pr", value: "\(pr.repository.fullName)#\(pr.number)"),
             prompt.map { URLQueryItem(name: "prompt", value: $0.text) }].compactMap { $0 }
        }
    }
}

enum PlatformPromptLinkParser {
    static let maximumPromptLength = 8_000

    static func newThread(_ query: [String: String]) throws -> PlatformNewThreadLink {
        let linkedPrompt = try prompt(query["prompt"])
        if let value = query["pr"] {
            guard let pr = pullRequest(value) else {
                throw PlatformDeepLinkError.invalidPrompt("This link names a pull request T3 Code cannot read.")
            }
            return .pullRequest(pr, prompt: linkedPrompt)
        }
        guard let linkedPrompt else { throw PlatformDeepLinkError.invalidPrompt("This link has no prompt.") }
        let parsedRepository = query["repo"].flatMap(repository)
        if query["repo"] != nil, parsedRepository == nil {
            throw PlatformDeepLinkError.invalidPrompt("This link names a repository T3 Code cannot read.")
        }
        func optional(_ key: String) -> String? {
            guard let value = query[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
            return value
        }
        return .new(prompt: linkedPrompt, repository: parsedRepository,
                    provider: optional("provider")?.lowercased(), model: optional("model"))
    }

    static func prompt(_ raw: String?) throws -> PlatformLinkedPrompt? {
        guard let raw else { return nil }
        // JavaScript counts UTF-16 units, including both halves of supplementary characters.
        guard raw.utf16.count <= maximumPromptLength else {
            throw PlatformDeepLinkError.invalidPrompt("This prompt is longer than 8,000 characters, so T3 Code did not open it.")
        }
        let value = sanitize(raw)
        if value.text.isEmpty, value.hiddenCharacters > 0 {
            throw PlatformDeepLinkError.invalidPrompt("This prompt had only hidden characters, so it may be malicious. T3 Code did not open it.")
        }
        return value.text.isEmpty ? nil : value
    }

    static func sanitize(_ raw: String) -> PlatformLinkedPrompt {
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{2028}", with: "\n")
            .replacingOccurrences(of: "\u{2029}", with: "\n")
        var removed = 0
        let visible = Array(normalized.unicodeScalars).filter { scalar in
            let hidden = hiddenRanges.contains { $0.contains(scalar.value) }
            if hidden { removed += 1 }
            return !hidden
        }
        let scalars = visible.enumerated().compactMap { index, scalar -> Unicode.Scalar? in
            guard scalar.value == 0x200D else { return scalar }
            if index > 0, index + 1 < visible.count,
               isEmojiPart(visible[index - 1].value), isEmojiPart(visible[index + 1].value) { return scalar }
            removed += 1
            return nil
        }
        return PlatformLinkedPrompt(text: String(String.UnicodeScalarView(scalars))
            .trimmingCharacters(in: .whitespacesAndNewlines), hiddenCharacters: removed)
    }

    static func repository(_ value: String) -> PlatformPromptRepository? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = captures(#"(?i)^https?://(?:www\.)?github\.com/([^/?#]+)/([^/?#]+)/?$"#, value)
                ?? captures(#"^([^/\s]+)/([^/\s]+)$"#, value) else { return nil }
        return repository(owner: parts[0], name: parts[1])
    }

    static func pullRequest(_ value: String) -> PlatformPromptPullRequest? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = captures(#"(?i)^https?://(?:www\.)?github\.com/([^/?#]+)/([^/?#]+)/pull/([0-9]+)(?:[/?#].*)?$"#, value)
                ?? captures(#"^([^/\s#]+)/([^/\s#]+)(?:/|#)([0-9]+)$"#, value),
              let repository = repository(owner: parts[0], name: parts[1]),
              let number = Int(parts[2]), number > 0, number <= 9_007_199_254_740_991 else { return nil }
        return PlatformPromptPullRequest(repository: repository, number: number)
    }

    private static func repository(owner: String, name: String) -> PlatformPromptRepository? {
        let name = name.replacingOccurrences(of: #"(?i)\.git$"#, with: "", options: .regularExpression)
        guard owner.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$"#, options: .regularExpression) != nil,
              name.range(of: #"^[A-Za-z0-9._-]{1,100}$"#, options: .regularExpression) != nil,
              name.contains(where: { $0 != "." }) else { return nil }
        return PlatformPromptRepository(owner: owner, name: name)
    }

    private static func captures(_ pattern: String, _ value: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) else { return nil }
        return (1..<match.numberOfRanges).compactMap { index in
            Range(match.range(at: index), in: value).map { String(value[$0]) }
        }
    }

    private static func isEmojiPart(_ value: UInt32) -> Bool {
        (0x1F000...0x1FAFF).contains(value) || (0x2190...0x2BFF).contains(value) || value == 0xFE0F
    }

    private static let hiddenRanges: [ClosedRange<UInt32>] = [
        0x0000...0x0008, 0x000B...0x000C, 0x000E...0x001F, 0x007F...0x009F,
        0x00AD...0x00AD, 0x034F...0x034F, 0x061C...0x061C, 0x115F...0x1160,
        0x17B4...0x17B5, 0x180B...0x180F, 0x200B...0x200C, 0x200E...0x200F,
        0x202A...0x202E, 0x2060...0x206F, 0x3164...0x3164, 0xFE00...0xFE0D,
        0xFEFF...0xFEFF, 0xFFA0...0xFFA0, 0xFFF0...0xFFFB, 0x1BCA0...0x1BCA3,
        0x1D173...0x1D17A, 0xE0000...0xE0FFF,
    ]
}

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
    case newPrompt(environmentID: String?, projectID: String?, link: PlatformNewThreadLink)
    case threadPrompt(environmentID: String?, threadID: String, prompt: PlatformLinkedPrompt)
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
        case .newPrompt, .threadPrompt:
            "prompt:\(url?.absoluteString ?? "")"
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
        case let .newPrompt(environmentID, projectID, link):
            components.host = "new"
            components.queryItems = [
                environmentID.map { URLQueryItem(name: "environment", value: $0) },
                projectID.map { URLQueryItem(name: "project", value: $0) },
            ].compactMap { $0 } + link.queryItems
        case let .threadPrompt(environmentID, threadID, prompt):
            components.host = "threads"
            components.queryItems = [
                environmentID.map { URLQueryItem(name: "environment", value: $0) },
                URLQueryItem(name: "thread", value: threadID),
                URLQueryItem(name: "prompt", value: prompt.text),
            ].compactMap { $0 }
        }
        // Form query parsing treats a literal plus as a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }
}

enum PlatformDeepLinkError: LocalizedError, Equatable {
    case unsupportedURL
    case missingIdentifier
    case invalidIdentifier
    case invalidPrompt(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedURL:
            "That T3 Code link is not supported."
        case .missingIdentifier:
            "That T3 Code link is missing its destination."
        case .invalidIdentifier:
            "That T3 Code link contains an invalid destination."
        case let .invalidPrompt(message):
            message
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
        let promptQuery = promptQueryValues(components)
        let hasPromptParameters = ["prompt", "repo", "pr", "provider", "model"].contains { promptQuery[$0] != nil }
        if hasPromptParameters {
            guard components.user == nil, components.password == nil,
                  components.port == nil || (scheme == "https" && components.port == 443) else {
                throw PlatformDeepLinkError.unsupportedURL
            }
            if ["http", "https"].contains(scheme) {
                guard scheme == "https", components.host?.lowercased() == "app.t3.codes" else {
                    throw PlatformDeepLinkError.unsupportedURL
                }
            }
        }
        if ["t3", "t3code", "t3code-dev", "t3code-swiftui", "t3code-swiftui-dev"].contains(scheme) {
            let segments = customSchemeSegments(components)
            if isConnectionRoute(segments: segments, query: query),
               !isPromptNavigation(segments, query: promptQuery) {
                return try connectionRoute(url)
            }
            return try navigationRoute(segments: segments, query: query, promptQuery: promptQuery)
        }

        guard ["http", "https"].contains(scheme) else {
            throw PlatformDeepLinkError.unsupportedURL
        }

        guard let host = components.host?.lowercased(), trustedWebHosts.contains(host) else {
            throw PlatformDeepLinkError.unsupportedURL
        }

        let segments = pathSegments(components.percentEncodedPath)
        if isConnectionRoute(segments: segments, query: query),
           !isPromptNavigation(segments, query: promptQuery) {
            return try connectionRoute(url)
        }

        let routeHeads = ["usage", "thread", "threads", "project", "projects", "environment",
                          "environments", "server", "servers", "new", "new-task", "compose"]
        if routeHeads.contains(segments.first?.lowercased() ?? "") || query["thread"] != nil {
            return try navigationRoute(segments: segments, query: query, promptQuery: promptQuery)
        }

        // Web thread routes use /:environmentID/:threadID.
        if segments.count >= 2 {
            return try threadRoute(
                environmentID: validatedIdentifier(segments[0]),
                threadID: validatedIdentifier(segments[1]),
                suffix: Array(segments.dropFirst(2)), query: query, promptQuery: promptQuery
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
        query: [String: String],
        promptQuery: [String: String]
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
                suffix: Array(tail.dropFirst(consumed)), query: query, promptQuery: promptQuery
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
            if isPromptNavigation(segments, query: promptQuery) {
                guard tail.isEmpty else { throw PlatformDeepLinkError.unsupportedURL }
                return .newPrompt(
                    environmentID: try queryEnvironment.map(validatedIdentifier),
                    projectID: try queryProject.map(validatedIdentifier),
                    link: try PlatformPromptLinkParser.newThread(promptQuery)
                )
            }
            return .newTask(
                environmentID: try queryEnvironment.map(validatedIdentifier),
                projectID: try queryProject.map(validatedIdentifier)
            )
        default:
            if let queryThread {
                return try threadRoute(
                    environmentID: queryEnvironment.map(validatedIdentifier),
                    threadID: validatedIdentifier(queryThread),
                    suffix: [], query: query, promptQuery: promptQuery
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
        environmentID: String?, threadID: String, suffix: [String], query: [String: String],
        promptQuery: [String: String]
    ) throws -> PlatformRoute {
        guard let head = suffix.first else {
            if let prompt = try PlatformPromptLinkParser.prompt(promptQuery["prompt"]) {
                return .threadPrompt(environmentID: environmentID, threadID: threadID, prompt: prompt)
            }
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

    private static func isPromptNavigation(_ segments: [String], query: [String: String]) -> Bool {
        guard let head = segments.first?.lowercased(), ["new", "new-task", "compose", "thread", "threads"].contains(head) else {
            return false
        }
        return ["prompt", "repo", "pr", "provider", "model"].contains { query[$0] != nil }
    }

    private static func promptQueryValues(_ components: URLComponents) -> [String: String] {
        (components.percentEncodedQuery ?? "").split(separator: "&").reduce(into: [:]) { result, pair in
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            func decode(_ value: Substring) -> String {
                let value = value.replacingOccurrences(of: "+", with: " ")
                return value.removingPercentEncoding ?? value
            }
            let name = decode(parts[0])
            // URLSearchParams and React Navigation use the first value, including an empty value.
            if result[name] == nil { result[name] = parts.count == 2 ? decode(parts[1]) : "" }
        }
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
