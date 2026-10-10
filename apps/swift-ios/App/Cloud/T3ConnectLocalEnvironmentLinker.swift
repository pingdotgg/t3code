import Foundation

struct T3ConnectLocalEnvironment: Sendable {
    let environment: Environment
    let credential: EnvironmentCredential

    init(environment: Environment, credential: EnvironmentCredential) throws {
        guard environment.kind == .bearer, environment.isEnabled,
              credential.authorizationMethod == .bearer, !credential.accessToken.isEmpty else {
            throw T3ConnectRelayError.invalidConfiguration(
                "Choose an enabled, locally paired bearer connection for Live Activity setup."
            )
        }
        self.environment = environment
        self.credential = credential
    }
}

/// Uses the saved host credential only for the two local, authenticated steps.
/// Relay credentials never replace the saved bearer credential.
@MainActor
struct T3ConnectLocalEnvironmentLinker {
    let relay: T3ConnectRelayClient
    let relayURL: URL
    let transport: any HTTPTransport

    func link(
        _ local: T3ConnectLocalEnvironment, enabled: Bool, clerkToken: String,
        accountID: String, deviceID: String, validateAccount: @MainActor () throws -> Void
    ) async throws {
        try validateAccount()
        let challenge = try await relay.createEnvironmentLinkChallenge(
            clerkToken: clerkToken,
            request: .init(notificationsEnabled: true, liveActivitiesEnabled: enabled)
        )
        try validateAccount()
        let environment = local.environment
        let proof: String = try await post(
            path: "api/connect/link-proof", local: local,
            payload: LinkProofRequest(
                challenge: challenge.challenge, relayIssuer: relayURL.absoluteString,
                endpoint: .init(httpBaseUrl: environment.httpBaseURL.absoluteString,
                                wsBaseUrl: environment.webSocketBaseURL.absoluteString,
                                providerKind: .cloudflareTunnel),
                origin: .init(localHttpHost: "127.0.0.1", localHttpPort: environment.httpBaseURL.port
                              ?? (environment.httpBaseURL.scheme == "https" ? 443 : 80))
            )
        )
        try validateAccount()
        let linked = try await relay.linkEnvironment(
            clerkToken: clerkToken,
            request: .init(deviceID: deviceID, proof: proof, notificationsEnabled: true,
                           liveActivitiesEnabled: enabled)
        )
        try validateAccount()
        guard linked.ok, linked.environmentId == environment.id,
              linked.cloudUserId == accountID,
              linked.endpoint.providerKind == .cloudflareTunnel,
              linked.endpointRuntime?.providerKind == nil
                || linked.endpointRuntime?.providerKind == .cloudflareTunnel else {
            throw T3ConnectRelayError.environmentMismatch
        }
        let configured: OKResponse = try await post(
            path: "api/connect/relay-config", local: local,
            payload: RelayConfigRequest(relayUrl: relayURL.absoluteString, link: linked)
        )
        try validateAccount()
        guard configured.ok else { throw HTTPError.invalidResponse }
    }

    private func post<Payload: Encodable, Response: Decodable>(
        path: String, local: T3ConnectLocalEnvironment, payload: Payload
    ) async throws -> Response {
        var request = URLRequest(url: local.environment.httpBaseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(local.credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder.t3.encode(payload)
        let (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        guard (200..<300).contains(response.statusCode) else {
            let error = try? JSONDecoder.t3.decode(EnvironmentErrorBody.self, from: data)
            throw HTTPError.status(response.statusCode,
                                   message: error?.message ?? "The environment could not complete Live Activity setup.",
                                   traceID: response.value(forHTTPHeaderField: "x-trace-id"))
        }
        return try JSONDecoder.t3.decode(Response.self, from: data)
    }

    private struct LinkProofRequest: Encodable {
        struct Origin: Encodable {
            let localHttpHost: String
            let localHttpPort: Int
        }
        let challenge: String
        let relayIssuer: String
        let endpoint: T3ConnectManagedEndpoint
        let origin: Origin
    }

    private struct RelayConfigRequest: Encodable {
        let relayUrl: String
        let relayIssuer: String
        let cloudUserId: String
        let environmentCredential: String
        let cloudMintPublicKey: String
        let endpointRuntime: T3ConnectManagedEndpointRuntime?

        init(relayUrl: String, link: T3ConnectEnvironmentLinkResponse) {
            self.relayUrl = relayUrl
            relayIssuer = link.relayIssuer
            cloudUserId = link.cloudUserId
            environmentCredential = link.environmentCredential
            cloudMintPublicKey = link.cloudMintPublicKey
            endpointRuntime = link.endpointRuntime
        }

        // The host schema requires endpointRuntime, including null.
        func encode(to encoder: any Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(relayUrl, forKey: .relayUrl)
            try values.encode(relayIssuer, forKey: .relayIssuer)
            try values.encode(cloudUserId, forKey: .cloudUserId)
            try values.encode(environmentCredential, forKey: .environmentCredential)
            try values.encode(cloudMintPublicKey, forKey: .cloudMintPublicKey)
            try values.encode(endpointRuntime, forKey: .endpointRuntime)
        }
        private enum CodingKeys: String, CodingKey {
            case relayUrl, relayIssuer, cloudUserId, environmentCredential, cloudMintPublicKey, endpointRuntime
        }
    }

    private struct OKResponse: Decodable { let ok: Bool }
}
