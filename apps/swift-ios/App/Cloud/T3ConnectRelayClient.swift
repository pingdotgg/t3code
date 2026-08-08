import Foundation

public enum T3ConnectRelayError: LocalizedError, Sendable {
    case invalidConfiguration(String)
    case invalidResponse
    case response(status: Int, message: String, traceID: String?)
    case unexpectedScope(requested: [String], granted: String)
    case environmentMismatch

    public var errorDescription: String? {
        switch self {
        case let .invalidConfiguration(message):
            message
        case .invalidResponse:
            "T3 Connect returned an invalid response."
        case let .response(status, message, traceID):
            traceID.map { "\(message) (trace \($0))" } ?? "\(message) (HTTP \(status))"
        case let .unexpectedScope(requested, granted):
            "T3 Connect granted \(granted) instead of \(requested.joined(separator: " "))."
        case .environmentMismatch:
            "T3 Connect returned credentials for a different environment."
        }
    }
}

public actor T3ConnectRelayClient {
    private struct CachedToken: Sendable {
        let accessToken: String
        let expiresAt: Date
        let scopes: [T3ConnectRelayScope]
        let thumbprint: String
    }

    private struct EnvironmentList: Decodable, Sendable {
        let environments: [T3ConnectRelayEnvironment]
    }

    private struct DeviceList: Decodable, Sendable {
        let devices: [T3ConnectRelayDevice]
    }

    private struct ConnectResponse: Decodable, Sendable {
        let environmentId: String
        let endpoint: T3ConnectManagedEndpoint
        let credential: String
        let expiresAt: String
    }

    private struct OKResponse: Decodable, Sendable {
        let ok: Bool
    }

    private struct RelayErrorBody: Decodable, Sendable {
        let message: String?
        let reason: String?
        let code: String?
        let traceId: String?
    }

    private let configuration: T3ConnectConfiguration
    private let transport: any HTTPTransport
    private let signer: T3ConnectDPoPSigner
    private var cachedTokens: [String: CachedToken] = [:]

    public init(
        configuration: T3ConnectConfiguration,
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        signer: T3ConnectDPoPSigner = T3ConnectDPoPSigner()
    ) {
        self.configuration = configuration
        self.transport = transport
        self.signer = signer
    }

    public func listEnvironments(clerkToken: String) async throws
        -> [T3ConnectRelayEnvironment]
    {
        var request = request(path: ["v1", "environments"], method: "GET")
        request.setValue("Bearer \(clerkToken)", forHTTPHeaderField: "Authorization")
        return try await send(request, as: EnvironmentList.self).environments
    }

    public func listDevices(clerkToken: String) async throws -> [T3ConnectRelayDevice] {
        var request = request(path: ["v1", "client", "devices"], method: "GET")
        request.setValue("Bearer \(clerkToken)", forHTTPHeaderField: "Authorization")
        return try await send(request, as: DeviceList.self).devices
    }

    public func createEnvironmentLinkChallenge(
        clerkToken: String,
        request payload: T3ConnectEnvironmentLinkChallengeRequest
    ) async throws -> T3ConnectEnvironmentLinkChallenge {
        var request = try jsonRequest(
            path: ["v1", "client", "environment-link-challenges"],
            method: "POST",
            payload: payload
        )
        request.setValue("Bearer \(clerkToken)", forHTTPHeaderField: "Authorization")
        return try await send(request, as: T3ConnectEnvironmentLinkChallenge.self)
    }

    public func linkEnvironment(
        clerkToken: String,
        request payload: T3ConnectEnvironmentLinkRequest
    ) async throws -> T3ConnectEnvironmentLinkResponse {
        var request = try jsonRequest(
            path: ["v1", "client", "environment-links"],
            method: "POST",
            payload: payload
        )
        request.setValue("Bearer \(clerkToken)", forHTTPHeaderField: "Authorization")
        return try await send(request, as: T3ConnectEnvironmentLinkResponse.self)
    }

    public func unlinkEnvironment(environmentID: String, clerkToken: String) async throws {
        var request = request(
            path: ["v1", "client", "environment-links", environmentID],
            method: "DELETE"
        )
        request.setValue("Bearer \(clerkToken)", forHTTPHeaderField: "Authorization")
        try requireOK(try await send(request, as: OKResponse.self))
    }

    public func status(
        for environment: T3ConnectRelayEnvironment,
        clerkToken: String
    ) async throws -> T3ConnectRelayEnvironmentStatus {
        let path = ["v1", "environments", environment.environmentId, "status"]
        let result: T3ConnectRelayEnvironmentStatus = try await sendDPoP(
            path: path,
            method: "POST",
            body: nil,
            clerkToken: clerkToken,
            scopes: [.environmentStatus]
        )
        guard
            result.environmentId == environment.environmentId,
            result.endpoint == environment.endpoint,
            result.descriptor?.environmentId == nil
                || result.descriptor?.environmentId == environment.environmentId
        else { throw T3ConnectRelayError.environmentMismatch }
        return result
    }

    public func connect(
        to environment: T3ConnectRelayEnvironment,
        clerkToken: String,
        deviceID: String? = nil
    ) async throws -> T3ConnectManagedEnvironmentCredential {
        let thumbprint = try await signer.thumbprint()
        let payload = ConnectRequest(
            deviceId: deviceID,
            clientProofKeyThumbprint: thumbprint
        )
        let body = try JSONEncoder.t3.encode(payload)
        let response: ConnectResponse = try await sendDPoP(
            path: ["v1", "environments", environment.environmentId, "connect"],
            method: "POST",
            body: body,
            clerkToken: clerkToken,
            scopes: [.environmentConnect]
        )
        guard
            response.environmentId == environment.environmentId,
            response.endpoint == environment.endpoint
        else { throw T3ConnectRelayError.environmentMismatch }
        guard !response.credential.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !response.expiresAt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw T3ConnectRelayError.invalidResponse
        }
        return T3ConnectManagedEnvironmentCredential(
            environmentID: response.environmentId,
            label: environment.label,
            endpoint: response.endpoint,
            bootstrapCredential: response.credential,
            bootstrapExpiresAt: response.expiresAt,
            proofKeyThumbprint: thumbprint
        )
    }

    public func registerDevice(
        _ registration: T3ConnectDeviceRegistration,
        clerkToken: String
    ) async throws {
        guard registration.iosMajorVersion >= 18 else {
            throw T3ConnectRelayError.invalidConfiguration(
                "T3 Connect device registration requires iOS 18 or newer."
            )
        }
        let body = try JSONEncoder.t3.encode(registration)
        let response: OKResponse = try await sendDPoP(
            path: ["v1", "mobile", "devices"],
            method: "POST",
            body: body,
            clerkToken: clerkToken,
            scopes: [.mobileRegistration]
        )
        try requireOK(response)
    }

    public func registerLiveActivity(
        _ registration: T3ConnectLiveActivityRegistration,
        clerkToken: String
    ) async throws {
        let body = try JSONEncoder.t3.encode(registration)
        let response: OKResponse = try await sendDPoP(
            path: ["v1", "mobile", "live-activities"],
            method: "POST",
            body: body,
            clerkToken: clerkToken,
            scopes: [.mobileRegistration]
        )
        try requireOK(response)
    }

    public func unregisterDevice(deviceID: String, clerkToken: String) async throws {
        let response: OKResponse = try await sendDPoP(
            path: ["v1", "mobile", "devices", deviceID],
            method: "DELETE",
            body: nil,
            clerkToken: clerkToken,
            scopes: [.mobileRegistration]
        )
        try requireOK(response)
    }

    public func clearTokenCache() {
        cachedTokens.removeAll()
    }

    private func sendDPoP<Response: Decodable & Sendable>(
        path: [String],
        method: String,
        body: Data?,
        clerkToken: String,
        scopes: [T3ConnectRelayScope]
    ) async throws -> Response {
        let target = endpoint(path)
        let authorization = try await authorize(
            clerkToken: clerkToken,
            scopes: scopes,
            method: method,
            url: target
        )
        var request = URLRequest(url: target)
        request.httpMethod = method
        request.httpBody = body
        request.setValue(
            "DPoP \(authorization.accessToken)",
            forHTTPHeaderField: "Authorization"
        )
        request.setValue(authorization.proof, forHTTPHeaderField: "DPoP")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do {
            return try await send(request, as: Response.self)
        } catch let error as T3ConnectRelayError where error.isRejectedAuthorization {
            cachedTokens.removeValue(forKey: tokenCacheKey(scopes, clerkToken: clerkToken))
            let refreshed = try await authorize(
                clerkToken: clerkToken,
                scopes: scopes,
                method: method,
                url: target
            )
            request.setValue("DPoP \(refreshed.accessToken)", forHTTPHeaderField: "Authorization")
            request.setValue(refreshed.proof, forHTTPHeaderField: "DPoP")
            return try await send(request, as: Response.self)
        }
    }

    private func authorize(
        clerkToken: String,
        scopes: [T3ConnectRelayScope],
        method: String,
        url: URL
    ) async throws -> (accessToken: String, proof: String) {
        let thumbprint = try await signer.thumbprint()
        let cacheKey = tokenCacheKey(scopes, clerkToken: clerkToken)
        let token: CachedToken
        if let cached = cachedTokens[cacheKey],
           cached.thumbprint == thumbprint,
           cached.expiresAt.timeIntervalSinceNow > 5
        {
            token = cached
        } else {
            token = try await exchangeRelayAccessToken(
                clerkToken: clerkToken,
                scopes: scopes,
                thumbprint: thumbprint
            )
            cachedTokens[cacheKey] = token
        }
        let proof = try await signer.proof(
            method: method,
            url: url,
            accessToken: token.accessToken
        )
        return (token.accessToken, proof.value)
    }

    private func exchangeRelayAccessToken(
        clerkToken: String,
        scopes: [T3ConnectRelayScope],
        thumbprint: String
    ) async throws -> CachedToken {
        let target = endpoint(["v1", "client", "dpop-token"])
        let proof = try await signer.proof(method: "POST", url: target)
        let requestedScopes = scopes.map(\.rawValue).sorted()
        let fields = [
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token": clerkToken,
            "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
            "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
            "resource": configuration.relayHTTPURL.absoluteString,
            "scope": requestedScopes.joined(separator: " "),
            "client_id": "t3-mobile",
        ]
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.httpBody = Self.formEncoded(fields)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let response = try await send(request, as: T3ConnectRelayAccessToken.self)
        let granted = Set(response.scope.split(separator: " ").map(String.init))
        guard granted == Set(requestedScopes) else {
            throw T3ConnectRelayError.unexpectedScope(
                requested: requestedScopes,
                granted: response.scope
            )
        }
        guard !response.accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              response.issuedTokenType
                == "urn:ietf:params:oauth:token-type:access_token",
              response.tokenType == "DPoP",
              response.expiresIn > 0 else {
            throw T3ConnectRelayError.invalidResponse
        }
        return CachedToken(
            accessToken: response.accessToken,
            expiresAt: Date().addingTimeInterval(TimeInterval(response.expiresIn)),
            scopes: scopes,
            thumbprint: thumbprint
        )
    }

    private func request(path: [String], method: String) -> URLRequest {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = method
        return request
    }

    private func jsonRequest<Payload: Encodable>(
        path: [String],
        method: String,
        payload: Payload
    ) throws -> URLRequest {
        var request = request(path: path, method: method)
        request.httpBody = try JSONEncoder.t3.encode(payload)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func endpoint(_ path: [String]) -> URL {
        var components = URLComponents(
            url: configuration.relayHTTPURL,
            resolvingAgainstBaseURL: false
        )
        components?.path = ""
        components?.query = nil
        components?.fragment = nil
        let origin = components?.url ?? configuration.relayHTTPURL
        return path.reduce(origin) { partial, component in
            partial.appendingPathComponent(component)
        }
    }

    private func requireOK(_ response: OKResponse) throws {
        guard response.ok else { throw T3ConnectRelayError.invalidResponse }
    }

    private func send<Response: Decodable & Sendable>(
        _ request: URLRequest,
        as type: Response.Type
    ) async throws -> Response {
        let (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        guard (200..<300).contains(response.statusCode) else {
            let body = try? JSONDecoder.t3.decode(RelayErrorBody.self, from: data)
            throw T3ConnectRelayError.response(
                status: response.statusCode,
                message: body?.message ?? body?.reason ?? body?.code ?? "T3 Connect request failed.",
                traceID: body?.traceId
            )
        }
        do {
            return try JSONDecoder.t3.decode(type, from: data)
        } catch {
            throw T3ConnectRelayError.invalidResponse
        }
    }

    private func tokenCacheKey(
        _ scopes: [T3ConnectRelayScope],
        clerkToken: String
    ) -> String {
        let account = Self.clerkSubject(clerkToken)
            ?? T3ConnectDPoPSigner.accessTokenHash(clerkToken)
        return "\(account)|\(scopes.map(\.rawValue).sorted().joined(separator: " "))"
    }

    /// JWT claims are used only as a cache partition, never as authentication.
    /// If Clerk changes token shape, the opaque token hash remains safe.
    private static func clerkSubject(_ token: String) -> String? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let claims = try? JSONDecoder().decode(ClerkCacheClaims.self, from: data),
              claims.sub.isEmpty == false else { return nil }
        return claims.sub
    }

    private static func formEncoded(_ fields: [String: String]) -> Data {
        var components = URLComponents()
        components.queryItems = fields.keys.sorted().map {
            URLQueryItem(name: $0, value: fields[$0])
        }
        return Data((components.percentEncodedQuery ?? "").utf8)
    }

    private struct ConnectRequest: Encodable {
        let deviceId: String?
        let clientProofKeyThumbprint: String
    }

    private struct ClerkCacheClaims: Decodable {
        let sub: String
    }
}

private extension T3ConnectRelayError {
    var isRejectedAuthorization: Bool {
        guard case let .response(status, _, _) = self else { return false }
        return status == 401
    }
}
