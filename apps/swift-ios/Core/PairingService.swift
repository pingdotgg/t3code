import Foundation

public struct TokenExchangeResult: Decodable, Sendable {
    public let accessToken: String
    public let issuedTokenType: String
    public let tokenType: String
    public let expiresIn: Double
    public let scope: String

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case issuedTokenType = "issued_token_type"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case scope
    }
}

public actor PairingService {
    private let transport: any HTTPTransport
    private let environmentStore: EnvironmentStore
    private let credentialStore: any CredentialStore

    public init(
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        environmentStore: EnvironmentStore,
        credentialStore: any CredentialStore
    ) {
        self.transport = transport
        self.environmentStore = environmentStore
        self.credentialStore = credentialStore
    }

    @discardableResult
    public func pair(
        url pairingURL: String,
        label clientLabel: String? = nil
    ) async throws -> Environment {
        try await pair(target: PairingURL.resolve(pairingURL), clientLabel: clientLabel)
    }

    @discardableResult
    public func pair(
        host: String,
        code: String,
        label clientLabel: String? = nil
    ) async throws -> Environment {
        try await pair(
            target: PairingURL.resolve(host: host, pairingCode: code),
            clientLabel: clientLabel
        )
    }

    private func pair(
        target: PairingTarget,
        clientLabel: String?
    ) async throws -> Environment {
        let api = EnvironmentAPI(transport: transport, credentials: credentialStore)
        let descriptor = try await api.descriptor(at: target.httpBaseURL)
        let access = try await exchange(target: target, clientLabel: clientLabel)
        guard access.tokenType == "Bearer" else {
            throw HTTPError.status(
                400,
                message: "The environment issued an unsupported \(access.tokenType) token.",
                traceID: nil
            )
        }
        let environment = Environment(
            id: descriptor.environmentId,
            label: descriptor.label,
            httpBaseURL: target.httpBaseURL,
            webSocketBaseURL: target.webSocketBaseURL,
            descriptor: descriptor
        )
        let credential = EnvironmentCredential(
            accessToken: access.accessToken,
            expiresAt: Date().addingTimeInterval(access.expiresIn),
            scopes: access.scope.split(separator: " ").map(String.init)
        )
        // Store the secret first. A catalog record must never point at a
        // credential that failed to persist.
        try await credentialStore.setCredential(credential, for: environment.id)
        do {
            try await environmentStore.upsert(environment)
            if try await environmentStore.activeEnvironmentID() == nil {
                try await environmentStore.setActiveEnvironment(id: environment.id)
            }
        } catch {
            try? await credentialStore.removeCredential(for: environment.id)
            throw error
        }
        return environment
    }

    private func exchange(
        target: PairingTarget,
        clientLabel: String?
    ) async throws -> TokenExchangeResult {
        var fields = [
            URLQueryItem(
                name: "grant_type",
                value: "urn:ietf:params:oauth:grant-type:token-exchange"
            ),
            URLQueryItem(name: "subject_token", value: target.credential),
            URLQueryItem(
                name: "subject_token_type",
                value: "urn:t3:params:oauth:token-type:environment-bootstrap"
            ),
            URLQueryItem(
                name: "requested_token_type",
                value: "urn:ietf:params:oauth:token-type:access_token"
            ),
            URLQueryItem(name: "client_device_type", value: "mobile"),
            URLQueryItem(name: "client_os", value: "iOS"),
        ]
        if let clientLabel, !clientLabel.isEmpty {
            fields.append(URLQueryItem(name: "client_label", value: clientLabel))
        }
        var form = URLComponents()
        form.queryItems = fields
        var request = URLRequest(url: endpoint(target.httpBaseURL, path: "/oauth/token"))
        request.httpMethod = "POST"
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        request.setValue(
            "application/x-www-form-urlencoded",
            forHTTPHeaderField: "Content-Type"
        )
        let (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        guard (200..<300).contains(response.statusCode) else {
            let body = try? JSONDecoder.t3.decode(JSONValue.self, from: data)
            throw HTTPError.status(
                response.statusCode,
                message: body?["reason"]?.stringValue ?? "Pairing failed.",
                traceID: body?["traceId"]?.stringValue
            )
        }
        return try JSONDecoder.t3.decode(TokenExchangeResult.self, from: data)
    }
}
