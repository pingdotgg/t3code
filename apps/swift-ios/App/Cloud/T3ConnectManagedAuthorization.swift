import Foundation

public struct T3ConnectPreparedEnvironmentConnection: Sendable {
    public let authorization: T3ConnectEnvironmentAccessToken
    public let webSocketURL: URL

    public init(
        authorization: T3ConnectEnvironmentAccessToken,
        webSocketURL: URL
    ) {
        self.authorization = authorization
        self.webSocketURL = webSocketURL
    }
}

/// Converts the relay's short-lived environment bootstrap credential into the
/// DPoP access token and one-time WebSocket ticket understood by a T3 server.
/// The same signer must authorize every later HTTP request for that token.
public actor T3ConnectManagedEnvironmentAuthorizer {
    /// Legacy scope vocabulary. Normal exchanges use the bootstrap grant instead.
    public static let standardScopes = [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "relay:read",
    ]

    private struct AccessTokenResponse: Decodable, Sendable {
        let accessToken: String
        let issuedTokenType: String
        let tokenType: String
        let expiresIn: Double
        let scope: String

        private enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case issuedTokenType = "issued_token_type"
            case tokenType = "token_type"
            case expiresIn = "expires_in"
            case scope
        }
    }

    private struct WebSocketTicketResponse: Decodable, Sendable {
        let ticket: String
        let expiresAt: String
    }

    private let transport: any HTTPTransport
    private let signer: T3ConnectDPoPSigner

    public init(
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        signer: T3ConnectDPoPSigner = T3ConnectDPoPSigner()
    ) {
        self.transport = transport
        self.signer = signer
    }

    public func prepare(
        _ credential: T3ConnectManagedEnvironmentCredential,
        scopes: [String]? = nil,
        clientLabel: String? = nil
    ) async throws -> T3ConnectPreparedEnvironmentConnection {
        let accessToken = try await exchange(
            credential,
            scopes: scopes,
            clientLabel: clientLabel
        )
        let webSocketURL = try await webSocketURL(using: accessToken)
        return T3ConnectPreparedEnvironmentConnection(
            authorization: accessToken,
            webSocketURL: webSocketURL
        )
    }

    public func exchange(
        _ credential: T3ConnectManagedEnvironmentCredential,
        scopes: [String]? = nil,
        clientLabel: String? = nil
    ) async throws -> T3ConnectEnvironmentAccessToken {
        guard let httpBaseURL = credential.endpoint.httpBaseURL else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed environment HTTP URL is invalid."
            )
        }
        let thumbprint = try await signer.thumbprint()
        guard thumbprint == credential.proofKeyThumbprint else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed credential is bound to a different device identity."
            )
        }
        let target = endpoint(httpBaseURL, path: ["oauth", "token"])
        let proof = try await signer.proof(method: "POST", url: target)
        var fields = [
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token": credential.bootstrapCredential,
            "subject_token_type": "urn:t3:params:oauth:token-type:environment-bootstrap",
            "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
            "client_device_type": "mobile",
            "client_os": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        if let scopes { fields["scope"] = scopes.joined(separator: " ") }
        if let clientLabel, !clientLabel.isEmpty {
            fields["client_label"] = clientLabel
        }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.httpBody = Self.formEncoded(fields)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let response = try await send(request, as: AccessTokenResponse.self)
        let grantedScopes = Set(response.scope.split(separator: " ").map(String.init))
        guard response.tokenType == "DPoP",
              response.issuedTokenType
                == "urn:ietf:params:oauth:token-type:access_token",
              response.accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
              response.expiresIn.isFinite,
              response.expiresIn > 0,
              !grantedScopes.isEmpty else {
            throw T3ConnectRelayError.invalidResponse
        }
        return T3ConnectEnvironmentAccessToken(
            environmentID: credential.environmentID,
            label: credential.label,
            endpoint: credential.endpoint,
            accessToken: response.accessToken,
            expiresAt: Date().addingTimeInterval(response.expiresIn),
            scopes: response.scope.split(separator: " ").map(String.init),
            proofKeyThumbprint: thumbprint
        )
    }

    /// Adds a fresh request-bound proof. Call this immediately before sending;
    /// reusing a proof defeats replay protection and is rejected by the server.
    public func authorize(
        _ request: URLRequest,
        using authorization: T3ConnectEnvironmentAccessToken
    ) async throws -> URLRequest {
        guard let url = request.url else { throw T3ConnectDPoPError.invalidURL }
        let proof = try await signer.proof(
            method: request.httpMethod ?? "GET",
            url: url,
            accessToken: authorization.accessToken
        )
        guard proof.thumbprint == authorization.proofKeyThumbprint else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The environment token is bound to a different device identity."
            )
        }
        var authorized = request
        authorized.setValue(
            "DPoP \(authorization.accessToken)",
            forHTTPHeaderField: "Authorization"
        )
        authorized.setValue(proof.value, forHTTPHeaderField: "DPoP")
        return authorized
    }

    public func proofKeyThumbprint() async throws -> String {
        try await signer.thumbprint()
    }

    public func descriptor(at httpBaseURL: URL) async throws -> EnvironmentDescriptor {
        try await send(
            URLRequest(
                url: endpoint(
                    httpBaseURL,
                    path: [".well-known", "t3", "environment"]
                )
            ),
            as: EnvironmentDescriptor.self
        )
    }

    public func webSocketURL(
        using authorization: T3ConnectEnvironmentAccessToken
    ) async throws -> URL {
        guard
            let httpBaseURL = authorization.endpoint.httpBaseURL,
            let webSocketBaseURL = authorization.endpoint.webSocketBaseURL,
            Self.matchesTransport(http: httpBaseURL, webSocket: webSocketBaseURL)
        else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed environment endpoint is invalid."
            )
        }
        let target = endpoint(
            httpBaseURL,
            path: ["api", "auth", "websocket-ticket"]
        )
        var ticketRequest = URLRequest(url: target)
        ticketRequest.httpMethod = "POST"
        ticketRequest = try await authorize(ticketRequest, using: authorization)
        let ticket = try await send(ticketRequest, as: WebSocketTicketResponse.self)
        guard !ticket.ticket.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw T3ConnectRelayError.invalidResponse
        }

        var components = URLComponents(
            url: webSocketBaseURL,
            resolvingAgainstBaseURL: false
        )
        if components?.path.isEmpty == true || components?.path == "/" {
            components?.path = "/ws"
        }
        var queryItems = components?.queryItems ?? []
        queryItems.removeAll { $0.name == "wsTicket" }
        queryItems.append(URLQueryItem(name: "wsTicket", value: ticket.ticket))
        components?.queryItems = queryItems
        guard let url = components?.url else { throw T3ConnectDPoPError.invalidURL }
        return url
    }

    fileprivate static func matchesTransport(http: URL, webSocket: URL) -> Bool {
        let secure = http.scheme?.lowercased() == "https"
            && webSocket.scheme?.lowercased() == "wss"
        let direct = http.scheme?.lowercased() == "http"
            && webSocket.scheme?.lowercased() == "ws"
        let defaultPort = secure ? 443 : 80
        return (secure || direct)
            && http.host != nil
            && http.host?.lowercased() == webSocket.host?.lowercased()
            && (http.port ?? defaultPort) == (webSocket.port ?? defaultPort)
            && http.user == nil && http.password == nil
            && webSocket.user == nil && webSocket.password == nil
    }

    private func endpoint(_ baseURL: URL, path: [String]) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = ""
        components?.query = nil
        components?.fragment = nil
        let origin = components?.url ?? baseURL
        return path.reduce(origin) { partial, component in
            partial.appendingPathComponent(component)
        }
    }

    private func send<Response: Decodable & Sendable>(
        _ request: URLRequest,
        as type: Response.Type
    ) async throws -> Response {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        } catch {
            throw T3ConnectNetworkError.wrapping(error)
        }
        guard (200..<300).contains(response.statusCode) else {
            let body = try? JSONDecoder.t3.decode(EnvironmentErrorBody.self, from: data)
            if response.statusCode == 403, let requiredScope = body?.requiredScope {
                throw EnvironmentPermissionDeniedError(
                    message: body?.message,
                    requiredScope: requiredScope,
                    requiredPermission: body?.requiredPermission,
                    traceID: body?.traceId
                )
            }
            throw T3ConnectRelayError.response(
                status: response.statusCode,
                message: body?.message ?? body?.reason ?? "Environment authorization failed.",
                traceID: body?.traceId
            )
        }
        do {
            return try JSONDecoder.t3.decode(type, from: data)
        } catch {
            throw T3ConnectRelayError.invalidResponse
        }
    }

    private static func formEncoded(_ fields: [String: String]) -> Data {
        var components = URLComponents()
        components.queryItems = fields.keys.sorted().map {
            URLQueryItem(name: $0, value: fields[$0])
        }
        return Data(
            (components.percentEncodedQuery ?? "")
                .replacingOccurrences(of: "+", with: "%2B")
                .utf8
        )
    }
}

/// Adapts the T3 Connect token lifecycle to Core's environment transport.
/// Refresh work is coalesced per environment because shell, detail, and socket
/// reconnect requests can all discover expiration at the same time.
public actor T3ConnectRuntimeAuthorization: ManagedEnvironmentAuthorizing {
    public typealias BootstrapProvider = @Sendable (String) async throws
        -> T3ConnectManagedEnvironmentCredential

    private struct InFlightRefresh: Sendable {
        let id: UUID
        let task: Task<EnvironmentCredential, Error>
    }

    private let authorizer: T3ConnectManagedEnvironmentAuthorizer
    private let bootstrapProvider: BootstrapProvider
    private var refreshTasks: [String: InFlightRefresh] = [:]

    @MainActor
    public init(controller: T3ConnectController) {
        authorizer = controller.managedAuthorizer
        bootstrapProvider = { environmentID in
            try await controller.credential(forEnvironmentID: environmentID)
        }
    }

    public init(
        authorizer: T3ConnectManagedEnvironmentAuthorizer,
        bootstrapProvider: @escaping BootstrapProvider
    ) {
        self.authorizer = authorizer
        self.bootstrapProvider = bootstrapProvider
    }

    public func credentialRequiresRefresh(
        _ credential: EnvironmentCredential,
        environment: Environment
    ) async throws -> Bool {
        _ = try Self.authorization(environment: environment, credential: credential)
        return try await authorizer.proofKeyThumbprint() != credential.proofKeyThumbprint
    }

    public func authorize(
        _ request: URLRequest,
        environment: Environment,
        credential: EnvironmentCredential
    ) async throws -> URLRequest {
        let authorization = try Self.authorization(
            environment: environment,
            credential: credential
        )
        return try await authorizer.authorize(request, using: authorization)
    }

    public func refreshCredential(
        for environment: Environment,
        replacing credential: EnvironmentCredential?
    ) async throws -> EnvironmentCredential {
        guard environment.kind == .managedDPoP,
              Self.managedEndpoint(for: environment) != nil else {
            throw HTTPError.incompatibleCredential
        }
        if let refresh = refreshTasks[environment.id] {
            return try await refresh.task.value
        }

        let authorizer = self.authorizer
        let bootstrapProvider = self.bootstrapProvider
        let task = Task<EnvironmentCredential, Error> {
            let bootstrap = try await bootstrapProvider(environment.id)
            try Self.validate(
                bootstrap: bootstrap,
                environment: environment
            )
            guard let httpBaseURL = bootstrap.endpoint.httpBaseURL else {
                throw T3ConnectRelayError.environmentMismatch
            }
            let descriptor = try await authorizer.descriptor(at: httpBaseURL)
            guard descriptor.environmentId == environment.id else {
                throw T3ConnectRelayError.environmentMismatch
            }
            let authorization = try await authorizer.exchange(bootstrap)
            return try Self.credential(
                authorization: authorization,
                environment: environment
            )
        }
        let refreshID = UUID()
        refreshTasks[environment.id] = InFlightRefresh(id: refreshID, task: task)
        do {
            let credential = try await task.value
            finishRefresh(environmentID: environment.id, id: refreshID)
            return credential
        } catch {
            finishRefresh(environmentID: environment.id, id: refreshID)
            throw error
        }
    }

    private func finishRefresh(environmentID: String, id: UUID) {
        guard refreshTasks[environmentID]?.id == id else { return }
        refreshTasks.removeValue(forKey: environmentID)
    }

    private static func authorization(
        environment: Environment,
        credential: EnvironmentCredential
    ) throws -> T3ConnectEnvironmentAccessToken {
        guard environment.kind == .managedDPoP,
              credential.authorizationMethod == .dpop,
              credential.managedEnvironmentID == environment.id,
              let expiresAt = credential.expiresAt,
              let proofKeyThumbprint = credential.proofKeyThumbprint,
              let endpoint = managedEndpoint(for: environment) else {
            throw HTTPError.incompatibleCredential
        }
        return T3ConnectEnvironmentAccessToken(
            environmentID: environment.id,
            label: environment.label,
            endpoint: endpoint,
            accessToken: credential.accessToken,
            expiresAt: expiresAt,
            scopes: credential.scopes,
            proofKeyThumbprint: proofKeyThumbprint
        )
    }

    private static func credential(
        authorization: T3ConnectEnvironmentAccessToken,
        environment: Environment
    ) throws -> EnvironmentCredential {
        guard authorization.environmentID == environment.id,
              authorization.proofKeyThumbprint.isEmpty == false else {
            throw T3ConnectRelayError.environmentMismatch
        }
        return .managedDPoP(
            accessToken: authorization.accessToken,
            expiresAt: authorization.expiresAt,
            scopes: authorization.scopes,
            environmentID: authorization.environmentID,
            proofKeyThumbprint: authorization.proofKeyThumbprint
        )
    }

    private static func validate(
        bootstrap: T3ConnectManagedEnvironmentCredential,
        environment: Environment
    ) throws {
        // Bootstrap comes from the signed-in relay account. Its endpoint can
        // differ from the selected direct route, whose descriptor the resolver
        // verifies before any credential is sent. Refresh never changes that route.
        guard bootstrap.environmentID == environment.id,
              bootstrap.proofKeyThumbprint.isEmpty == false,
              let http = bootstrap.endpoint.httpBaseURL,
              let socket = bootstrap.endpoint.webSocketBaseURL,
              http.scheme?.lowercased() == "https",
              T3ConnectManagedEnvironmentAuthorizer.matchesTransport(http: http, webSocket: socket) else {
            throw T3ConnectRelayError.environmentMismatch
        }
    }

    private static func managedEndpoint(
        for environment: Environment
    ) -> T3ConnectManagedEndpoint? {
        guard T3ConnectManagedEnvironmentAuthorizer.matchesTransport(
            http: environment.httpBaseURL, webSocket: environment.webSocketBaseURL
        ) else { return nil }
        return T3ConnectManagedEndpoint(
            httpBaseUrl: environment.httpBaseURL.absoluteString,
            wsBaseUrl: environment.webSocketBaseURL.absoluteString,
            providerKind: .t3Relay
        )
    }
}
