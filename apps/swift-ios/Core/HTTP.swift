import Foundation

public protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
    func upload(for request: URLRequest, fromFile fileURL: URL) async throws
        -> (Data, HTTPURLResponse)
}

public extension HTTPTransport {
    /// Test transports can keep recording URLRequest bodies without providing
    /// a second transport implementation. Production overrides this method.
    func upload(for request: URLRequest, fromFile fileURL: URL) async throws
        -> (Data, HTTPURLResponse)
    {
        var request = request
        request.httpBody = try Data(contentsOf: fileURL)
        return try await data(for: request)
    }
}

/// The Core transport deliberately knows nothing about Clerk or the relay.
/// A managed-environment adapter supplies request-bound DPoP proofs and can
/// reacquire a bound access token when the current one expires or is rejected.
public protocol ManagedEnvironmentAuthorizing: Sendable {
    func credentialRequiresRefresh(
        _ credential: EnvironmentCredential,
        environment: Environment
    ) async throws -> Bool

    func authorize(
        _ request: URLRequest,
        environment: Environment,
        credential: EnvironmentCredential
    ) async throws -> URLRequest

    func refreshCredential(
        for environment: Environment,
        replacing credential: EnvironmentCredential
    ) async throws -> EnvironmentCredential
}

public struct URLSessionHTTPTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.httpAdditionalHeaders = [
                "Accept-Encoding": HTTPRequestPolicy.acceptEncoding,
            ]
            self.session = URLSession(configuration: configuration)
        }
    }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        // URLSession transparently decodes gzip responses before returning
        // their body. Applying the policy here is a final guard for requests
        // constructed outside EnvironmentAPI.
        let (data, response) = try await session.data(for: HTTPRequestPolicy.prepare(request))
        guard let httpResponse = response as? HTTPURLResponse else {
            throw HTTPError.invalidResponse
        }
        return (data, httpResponse)
    }

    public func upload(for request: URLRequest, fromFile fileURL: URL) async throws
        -> (Data, HTTPURLResponse)
    {
        let (data, response) = try await session.upload(
            for: HTTPRequestPolicy.prepare(request),
            fromFile: fileURL
        )
        guard let httpResponse = response as? HTTPURLResponse else {
            throw HTTPError.invalidResponse
        }
        return (data, httpResponse)
    }
}

/// Shared wire-level defaults for HTTP requests.
///
/// Foundation's URL loading system transparently decompresses gzip response
/// bodies. The explicit offer matters because T3 only compresses JSON when the
/// client advertises support.
public enum HTTPRequestPolicy {
    public static let acceptEncoding = "gzip"

    public static func prepare(_ request: URLRequest) -> URLRequest {
        var prepared = request
        if prepared.value(forHTTPHeaderField: "Accept-Encoding") == nil {
            prepared.setValue(acceptEncoding, forHTTPHeaderField: "Accept-Encoding")
        }
        if prepared.value(forHTTPHeaderField: "Accept") == nil {
            prepared.setValue("application/json", forHTTPHeaderField: "Accept")
        }
        return prepared
    }
}

public enum HTTPError: LocalizedError, Sendable {
    case invalidResponse
    case status(Int, message: String, traceID: String?)
    case missingCredential
    case incompatibleCredential
    case managedAuthorizationUnavailable
    case unauthenticatedSession

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "The server returned an invalid response."
        case let .status(status, message, traceID):
            traceID.map { "\(message) (trace \($0))" } ?? "\(message) (HTTP \(status))"
        case .missingCredential:
            "This environment has no saved credential."
        case .incompatibleCredential:
            "This environment's saved authentication method is invalid. Connect it again."
        case .managedAuthorizationUnavailable:
            "This build cannot authorize a managed T3 Connect environment."
        case .unauthenticatedSession:
            "The environment rejected the session authorization."
        }
    }
}

struct T3ConnectNetworkError: LocalizedError, Sendable {
    static let hint =
        "Your DNS or firewall may be blocking T3 Connect. Try another network, such as a phone hotspot."

    let message: String

    var errorDescription: String? { "\(message) \(Self.hint)" }

    // A failed transport can be an outage or filtering. Keep protocol and
    // authentication errors unchanged because they have a server response.
    static func wrapping(_ error: any Error) -> any Error {
        guard let error = error as? URLError else { return error }
        switch error.code {
        case .timedOut, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
             .networkConnectionLost, .notConnectedToInternet:
            return Self(message: error.localizedDescription)
        default:
            return error
        }
    }
}

enum DPoPFailureReason: Decodable, Equatable, Sendable {
    case timeWindow
    case keyMismatch
    case requestMismatch
    case tokenMismatch
    case replay
    case invalidProof
    case unknown

    init(from decoder: any Decoder) throws {
        switch try decoder.singleValueContainer().decode(String.self) {
        case "time_window": self = .timeWindow
        case "key_mismatch": self = .keyMismatch
        case "request_mismatch": self = .requestMismatch
        case "token_mismatch": self = .tokenMismatch
        case "replay": self = .replay
        case "invalid_proof": self = .invalidProof
        default: self = .unknown
        }
    }
}

enum DPoPFailurePresentation {
    static let clockHint =
        "Hint: Check that automatic date and time is enabled on both devices, then try again."
    static let unknownHint =
        "Hint: Try again. If it still fails, clock skew may be the cause; check that automatic date and time is enabled on both devices."
    static let retryHint = "Hint: Try again. If the problem continues, copy the trace ID."

    static func message(_ message: String, reason: DPoPFailureReason?) -> String {
        let hint = if reason == .timeWindow {
            clockHint
        } else if reason == nil {
            unknownHint
        } else {
            retryHint
        }
        return "\(message) \(hint)"
    }
}

struct EnvironmentErrorBody: Decodable {
    let message: String?
    let reason: String?
    let dpopFailureReason: DPoPFailureReason?
    let traceId: String?
}

public actor EnvironmentAPI {
    private static let managedRefreshMargin: TimeInterval = 60

    private let transport: any HTTPTransport
    private let credentials: any CredentialStore
    private let managedAuthorization: (any ManagedEnvironmentAuthorizing)?

    public init(
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        credentials: any CredentialStore,
        managedAuthorization: (any ManagedEnvironmentAuthorizing)? = nil
    ) {
        self.transport = transport
        self.credentials = credentials
        self.managedAuthorization = managedAuthorization
    }

    public func descriptor(at httpBaseURL: URL) async throws -> EnvironmentDescriptor {
        try await send(
            URLRequest(url: endpoint(httpBaseURL, path: "/.well-known/t3/environment")),
            as: EnvironmentDescriptor.self
        )
    }

    public func shellSnapshot(
        for environment: Environment,
        timeoutInterval: TimeInterval? = nil
    ) async throws
        -> OrchestrationShellSnapshot
    {
        try await authorized(
            environment: environment,
            path: "/api/orchestration/shell",
            method: "GET",
            timeoutInterval: timeoutInterval,
            as: OrchestrationShellSnapshot.self
        )
    }

    public func readModel(for environment: Environment) async throws -> OrchestrationReadModel {
        try await authorized(
            environment: environment,
            path: "/api/orchestration/snapshot",
            method: "GET",
            as: OrchestrationReadModel.self
        )
    }

    public func threadSnapshot(
        id: String,
        environment: Environment,
        turnLimit: Int? = nil,
        beforeCursor: String? = nil,
        timeoutInterval: TimeInterval? = nil
    ) async throws -> OrchestrationThreadDetailSnapshot {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        var queryItems: [URLQueryItem] = []
        if let turnLimit {
            queryItems.append(URLQueryItem(name: "turnLimit", value: String(turnLimit)))
        }
        if let beforeCursor {
            queryItems.append(URLQueryItem(name: "beforeCursor", value: beforeCursor))
        }
        return try await authorized(
            environment: environment,
            path: "/api/orchestration/threads/\(encodedID)",
            queryItems: queryItems,
            method: "GET",
            timeoutInterval: timeoutInterval,
            as: OrchestrationThreadDetailSnapshot.self
        )
    }

    public func dispatch(
        _ command: JSONValue,
        environment: Environment
    ) async throws -> DispatchResult {
        try await authorized(
            environment: environment,
            path: "/api/orchestration/dispatch",
            method: "POST",
            body: JSONEncoder.t3.encode(command),
            as: DispatchResult.self
        )
    }

    public func pullRequestDiff(
        _ input: PullRequestDiffInput,
        environment: Environment
    ) async throws -> PullRequestDiffResult {
        try await authorized(
            environment: environment,
            path: "/api/pull-requests/diff",
            method: "POST",
            body: JSONEncoder.t3.encode(input),
            timeoutInterval: 60,
            as: PullRequestDiffResult.self
        )
    }

    /// Upload URLs carry their own short-lived signature and do not need the
    /// environment's bearer token or DPoP authorization headers.
    public func uploadAttachment(
        _ data: Data,
        mimeType: String,
        to url: URL
    ) async throws {
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(String(data.count), forHTTPHeaderField: "Content-Length")

        let (responseData, response) = try await transport.data(
            for: HTTPRequestPolicy.prepare(request)
        )
        guard (200...299).contains(response.statusCode) else {
            let detail = String(data: responseData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw HTTPError.status(
                response.statusCode,
                message: detail.flatMap { $0.isEmpty ? nil : $0 } ?? "Image upload failed.",
                traceID: nil
            )
        }
    }

    /// Production uses URLSession's file upload API so large attachments never
    /// become one in-memory Data value.
    public func uploadAttachment(
        fileURL: URL,
        byteCount: Int,
        mimeType: String,
        to url: URL
    ) async throws {
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(String(byteCount), forHTTPHeaderField: "Content-Length")

        let (responseData, response) = try await transport.upload(
            for: HTTPRequestPolicy.prepare(request),
            fromFile: fileURL
        )
        guard (200...299).contains(response.statusCode) else {
            let detail = String(data: responseData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw HTTPError.status(
                response.statusCode,
                message: detail.flatMap { $0.isEmpty ? nil : $0 } ?? "File upload failed.",
                traceID: nil
            )
        }
    }

    public func webSocketTicket(for environment: Environment) async throws -> WebSocketTicket {
        try await authorized(
            environment: environment,
            path: "/api/auth/websocket-ticket",
            method: "POST",
            as: WebSocketTicket.self
        )
    }

    public func session(for environment: Environment) async throws -> AuthSessionState {
        try await authorized(
            environment: environment,
            path: "/api/auth/session",
            method: "GET",
            isUnauthorizedResponse: { !$0.authenticated },
            as: AuthSessionState.self
        )
    }

    public func clientSessions(for environment: Environment) async throws
        -> [AuthClientSession]
    {
        try await authorized(
            environment: environment,
            path: "/api/auth/clients",
            method: "GET",
            as: [AuthClientSession].self
        )
    }

    public func revokeClientSession(
        id: String,
        environment: Environment
    ) async throws -> AuthClientSessionRevokeResult {
        try await authorized(
            environment: environment,
            path: "/api/auth/clients/revoke",
            method: "POST",
            body: JSONEncoder.t3.encode(["sessionId": id]),
            as: AuthClientSessionRevokeResult.self
        )
    }

    public func revokeOtherClientSessions(
        for environment: Environment
    ) async throws -> AuthOtherClientSessionsRevokeResult {
        try await authorized(
            environment: environment,
            path: "/api/auth/clients/revoke-others",
            method: "POST",
            as: AuthOtherClientSessionsRevokeResult.self
        )
    }

    private func authorized<Result: Decodable & Sendable>(
        environment: Environment,
        path: String,
        queryItems: [URLQueryItem] = [],
        method: String,
        body: Data? = nil,
        timeoutInterval: TimeInterval? = nil,
        isUnauthorizedResponse: (@Sendable (Result) -> Bool)? = nil,
        as type: Result.Type
    ) async throws -> Result {
        guard let credential = try await credentials.credential(for: environment.id) else {
            throw HTTPError.missingCredential
        }

        switch environment.kind {
        case .bearer, .local:
            guard credential.authorizationMethod == .bearer else {
                throw HTTPError.incompatibleCredential
            }
            var request = makeRequest(
                environment: environment,
                path: path,
                queryItems: queryItems,
                method: method,
                body: body
            )
            if let timeoutInterval {
                request.timeoutInterval = timeoutInterval
            }
            request.setValue(
                "Bearer \(credential.accessToken)",
                forHTTPHeaderField: "Authorization"
            )
            return try await send(request, as: type)

        case .managedDPoP:
            guard credential.authorizationMethod == .dpop,
                  credential.managedEnvironmentID == environment.id else {
                throw HTTPError.incompatibleCredential
            }
            guard let managedAuthorization else {
                throw HTTPError.managedAuthorizationUnavailable
            }

            var current = credential
            let bindingRequiresRefresh = try await managedAuthorization
                .credentialRequiresRefresh(current, environment: environment)
            if current.expiresAt?.timeIntervalSinceNow ?? 0 <= Self.managedRefreshMargin
                || bindingRequiresRefresh {
                current = try await refreshManagedCredential(
                    current,
                    environment: environment,
                    using: managedAuthorization
                )
            }
            var request = try await managedAuthorization.authorize(
                makeRequest(
                    environment: environment,
                    path: path,
                    queryItems: queryItems,
                    method: method,
                    body: body
                ),
                environment: environment,
                credential: current
            )
            if let timeoutInterval {
                request.timeoutInterval = timeoutInterval
            }
            do {
                return try await send(
                    request,
                    isManagedRequest: true,
                    isUnauthorizedResponse: isUnauthorizedResponse,
                    as: type
                )
            } catch let error as HTTPError where error.isRejectedAuthorization {
                if let saved = try await newestUsableManagedCredential(
                    replacing: current,
                    environment: environment,
                    using: managedAuthorization
                ) {
                    current = saved
                } else {
                    current = try await refreshManagedCredential(
                        current,
                        environment: environment,
                        using: managedAuthorization
                    )
                }
                var retry = try await managedAuthorization.authorize(
                    makeRequest(
                        environment: environment,
                        path: path,
                        queryItems: queryItems,
                        method: method,
                        body: body
                    ),
                    environment: environment,
                    credential: current
                )
                if let timeoutInterval {
                    retry.timeoutInterval = timeoutInterval
                }
                return try await send(
                    retry,
                    isManagedRequest: true,
                    isUnauthorizedResponse: isUnauthorizedResponse,
                    as: type
                )
            }
        }
    }

    private func makeRequest(
        environment: Environment,
        path: String,
        queryItems: [URLQueryItem],
        method: String,
        body: Data?
    ) -> URLRequest {
        var request = URLRequest(
            url: endpoint(environment.httpBaseURL, path: path, queryItems: queryItems)
        )
        request.httpMethod = method
        request.httpBody = body
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func refreshManagedCredential(
        _ credential: EnvironmentCredential,
        environment: Environment,
        using managedAuthorization: any ManagedEnvironmentAuthorizing
    ) async throws -> EnvironmentCredential {
        if let current = try await newestUsableManagedCredential(
            replacing: credential,
            environment: environment,
            using: managedAuthorization
        ) {
            return current
        }
        let refreshed = try await managedAuthorization.refreshCredential(
            for: environment,
            replacing: credential
        )
        guard refreshed.authorizationMethod == .dpop,
              refreshed.managedEnvironmentID == environment.id,
              refreshed.proofKeyThumbprint?.isEmpty == false else {
            throw HTTPError.incompatibleCredential
        }
        guard try await credentials.replaceCredential(
            refreshed,
            ifMatching: credential,
            for: environment.id
        ) else {
            if let current = try await newestUsableManagedCredential(
                replacing: credential,
                environment: environment,
                using: managedAuthorization
            ) {
                return current
            }
            throw HTTPError.missingCredential
        }
        return refreshed
    }

    private func newestUsableManagedCredential(
        replacing credential: EnvironmentCredential,
        environment: Environment,
        using managedAuthorization: any ManagedEnvironmentAuthorizing
    ) async throws -> EnvironmentCredential? {
        guard let saved = try await credentials.credential(for: environment.id),
              saved != credential,
              saved.authorizationMethod == .dpop,
              saved.managedEnvironmentID == environment.id,
              saved.proofKeyThumbprint?.isEmpty == false,
              saved.expiresAt?.timeIntervalSinceNow ?? 0 > Self.managedRefreshMargin else {
            return nil
        }
        let requiresRefresh = try await managedAuthorization.credentialRequiresRefresh(
            saved,
            environment: environment
        )
        guard !requiresRefresh else { return nil }
        return saved
    }

    private func send<Result: Decodable & Sendable>(
        _ request: URLRequest,
        isManagedRequest: Bool = false,
        isUnauthorizedResponse: (@Sendable (Result) -> Bool)? = nil,
        as type: Result.Type
    ) async throws -> Result {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        } catch {
            throw isManagedRequest ? T3ConnectNetworkError.wrapping(error) : error
        }
        guard (200..<300).contains(response.statusCode) else {
            let body = try? JSONDecoder.t3.decode(EnvironmentErrorBody.self, from: data)
            let message: String
            if response.statusCode == 401,
               request.value(forHTTPHeaderField: "DPoP") != nil,
               body?.reason == "invalid_credential"
            {
                message = DPoPFailurePresentation.message(
                    "The environment credential is invalid.",
                    reason: body?.dpopFailureReason
                )
            } else {
                message = body?.message ?? body?.reason ?? "Environment request failed."
            }
            throw HTTPError.status(
                response.statusCode,
                message: message,
                traceID: body?.traceId
            )
        }
        let result = try JSONDecoder.t3.decode(type, from: data)
        if isUnauthorizedResponse?(result) == true {
            throw HTTPError.unauthenticatedSession
        }
        return result
    }
}

private extension HTTPError {
    var isRejectedAuthorization: Bool {
        switch self {
        case .unauthenticatedSession: return true
        case let .status(status, _, _): return status == 401
        default: return false
        }
    }
}

public struct DispatchResult: Codable, Equatable, Sendable {
    public let sequence: Int
}

public struct WebSocketTicket: Codable, Equatable, Sendable {
    public let ticket: String
    public let expiresAt: String
}

public struct AuthSessionState: Codable, Equatable, Sendable {
    public let authenticated: Bool
    public let scopes: [String]?
    public let sessionMethod: String?
    public let expiresAt: String?
}

public struct AuthClientMetadata: Codable, Equatable, Sendable {
    public let label: String?
    public let ipAddress: String?
    public let userAgent: String?
    public let deviceType: String
    public let os: String?
    public let browser: String?
}

public struct AuthClientSession: Codable, Identifiable, Equatable, Sendable {
    public var id: String { sessionId }

    public let sessionId: String
    public let subject: String
    public let scopes: [String]
    public let method: String
    public let client: AuthClientMetadata
    public let issuedAt: String
    public let expiresAt: String
    public let lastConnectedAt: String?
    public let connected: Bool
    public let current: Bool
}

public struct AuthClientSessionRevokeResult: Codable, Equatable, Sendable {
    public let revoked: Bool
}

public struct AuthOtherClientSessionsRevokeResult: Codable, Equatable, Sendable {
    public let revokedCount: Int
}

func endpoint(_ baseURL: URL, path: String, queryItems: [URLQueryItem] = []) -> URL {
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    components.path = path
    components.queryItems = queryItems.isEmpty ? nil : queryItems
    components.fragment = nil
    return components.url!
}
