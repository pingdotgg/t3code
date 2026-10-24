import Foundation

public enum T3ConnectRelayError: LocalizedError, Sendable {
    case invalidConfiguration(String)
    case invalidResponse
    case response(status: Int, message: String, traceID: String?)
    case unexpectedResponse(status: Int, traceID: String?)
    case connectionNotAuthorized(reason: String?, traceID: String?)
    case unexpectedScope(requested: [String], granted: String)
    case environmentMismatch

    /// Tunnel allocation can change on the host without any change to the
    /// client's credentials. Let the existing connection loop retry it.
    public var isTransient: Bool {
        switch self {
        case let .connectionNotAuthorized(reason, _):
            reason == "managed_endpoint_allocation_not_ready"
        case .unexpectedResponse:
            true
        case let .response(status, _, _):
            status >= 500 || status == 408 || status == 429
        default:
            false
        }
    }

    public var errorDescription: String? {
        switch self {
        case let .invalidConfiguration(message):
            return message
        case .invalidResponse:
            return "T3 Connect returned an invalid response."
        case let .response(status, message, traceID):
            return traceID.map { "\(message) (trace \($0))" } ?? "\(message) (HTTP \(status))"
        case let .unexpectedResponse(status, traceID):
            let message = T3ConnectRelayErrorPresentation.unexpectedResponseMessage(status: status)
            return traceID.map { "\(message) (trace \($0))" } ?? message
        case let .connectionNotAuthorized(reason, traceID):
            let message = T3ConnectRelayErrorPresentation.connectionNotAuthorizedMessage(reason: reason)
            return traceID.map { "\(message) (trace \($0))" } ?? message
        case let .unexpectedScope(requested, granted):
            return "T3 Connect granted \(granted) instead of \(requested.joined(separator: " "))."
        case .environmentMismatch:
            return "T3 Connect returned credentials for a different environment."
        }
    }
}

struct T3ConnectRelayErrorBody: Decodable, Sendable {
    let message: String?
    let reason: String?
    let code: String?
    let dpopFailureReason: DPoPFailureReason?
    let maxTunnels: Int?
    let traceId: String?
}

enum T3ConnectRelayErrorPresentation {
    static let gatewayTimeoutMessage =
        "Relay timed out before it finished the request (HTTP 504). Try again in a few minutes. If it keeps failing, copy the trace ID when you report it."

    static func unexpectedResponseMessage(status: Int) -> String {
        status == 504 ? gatewayTimeoutMessage : "Relay returned an unexpected HTTP \(status)."
    }

    static func traceID(from response: HTTPURLResponse) -> String? {
        guard let traceparent = response.value(forHTTPHeaderField: "traceparent"),
              traceparent.range(
                  of: #"\A[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\z"#,
                  options: [.regularExpression, .caseInsensitive]
              ) != nil else { return nil }
        return String(traceparent.split(separator: "-")[1])
    }

    static func connectionNotAuthorizedMessage(reason: String?) -> String {
        if reason == "managed_endpoint_allocation_not_ready" {
            return "The environment's T3 Connect tunnel is still being set up."
        }
        if reason == "environment_link_not_found" {
            return "Relay has no active link for this environment. The environment server may not have re-established its link yet."
        }
        if let reason {
            return "Relay rejected the environment connection request (\(reason))."
        }
        return "Relay rejected the environment connection request."
    }

    static func message(
        for error: T3ConnectRelayErrorBody,
        requestUsesDPoP: Bool
    ) -> String {
        switch error.code {
        case "auth_invalid":
            switch error.reason {
            case "missing_bearer", "invalid_bearer":
                return "Relay rejected the cloud session token."
            case "invalid_dpop" where requestUsesDPoP:
                return DPoPFailurePresentation.message(
                    "Relay rejected the DPoP proof.",
                    reason: error.dpopFailureReason
                )
            case "not_authorized":
                return "Relay rejected the authenticated request."
            default:
                break
            }
        case "environment_link_proof_expired":
            return "Relay rejected an expired environment link proof."
        case "environment_link_proof_invalid":
            if let reason = error.reason {
                return "Relay rejected the environment link proof (\(reason))."
            }
        case "environment_connect_not_authorized":
            return connectionNotAuthorizedMessage(reason: error.reason)
        case "environment_endpoint_unavailable":
            if let reason = error.reason {
                return "Relay could not reach the environment endpoint (\(reason))."
            }
        case "environment_endpoint_timed_out":
            return "Relay timed out while contacting the environment endpoint."
        case "environment_link_failed":
            if let reason = error.reason {
                return "Relay could not link the environment (\(reason))."
            }
        case "environment_link_unavailable":
            if let reason = error.reason {
                return "Relay cannot provision the managed endpoint (\(reason))."
            }
        case "environment_link_limit_exceeded":
            if let maxTunnels = error.maxTunnels {
                return "Relay refused the link: this account already has its maximum of \(maxTunnels) managed tunnels. Unlink an environment to free one up."
            }
            return "Relay refused the link because this account has reached its managed tunnel limit. Unlink an environment to free one up."
        case "agent_activity_publish_proof_expired":
            return "Relay rejected an expired agent activity publish proof."
        case "agent_activity_publish_proof_invalid":
            if let reason = error.reason {
                return "Relay rejected the agent activity publish proof (\(reason))."
            }
        case "internal_error":
            if let reason = error.reason {
                return "Relay encountered an internal error (\(reason))."
            }
        default:
            break
        }
        return error.message ?? error.reason ?? error.code ?? "T3 Connect request failed."
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
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        } catch {
            throw T3ConnectNetworkError.wrapping(error)
        }
        guard (200..<300).contains(response.statusCode) else {
            let body = try? JSONDecoder.t3.decode(T3ConnectRelayErrorBody.self, from: data)
            guard let body, let code = body.code, Self.protectedErrorCodes.contains(code) else {
                throw T3ConnectRelayError.unexpectedResponse(
                    status: response.statusCode,
                    traceID: T3ConnectRelayErrorPresentation.traceID(from: response)
                )
            }
            if code == "environment_connect_not_authorized" {
                throw T3ConnectRelayError.connectionNotAuthorized(reason: body.reason, traceID: body.traceId)
            }
            throw T3ConnectRelayError.response(
                status: response.statusCode,
                message: T3ConnectRelayErrorPresentation.message(
                    for: body,
                    requestUsesDPoP: request.value(forHTTPHeaderField: "DPoP") != nil
                ),
                traceID: body.traceId
            )
        }
        do {
            return try JSONDecoder.t3.decode(type, from: data)
        } catch {
            throw T3ConnectRelayError.invalidResponse
        }
    }

    private static let protectedErrorCodes: Set<String> = [
        "auth_invalid", "environment_link_proof_expired", "environment_link_proof_invalid",
        "environment_connect_not_authorized", "environment_endpoint_unavailable",
        "environment_endpoint_timed_out", "environment_link_failed", "environment_link_unavailable",
        "environment_link_limit_exceeded", "agent_activity_publish_proof_expired",
        "agent_activity_publish_proof_invalid", "internal_error",
    ]

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
        return Data(
            (components.percentEncodedQuery ?? "")
                .replacingOccurrences(of: "+", with: "%2B")
                .utf8
        )
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
        switch self {
        case let .response(status, _, _), let .unexpectedResponse(status, _):
            status == 401
        default:
            false
        }
    }
}
