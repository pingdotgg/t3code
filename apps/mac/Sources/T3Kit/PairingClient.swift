import Foundation

public enum PairingClientError: Error, LocalizedError, Sendable {
    case invalidURL(String)
    case unsupportedScheme(String)
    case missingToken(host: String)
    case httpStatus(endpoint: String, statusCode: Int, body: String)
    case nonHTTPResponse(endpoint: String)
    case network(endpoint: String, detail: String)
    case decoding(endpoint: String, detail: String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let value):
            return "Pairing URL is invalid: \(value)"
        case .unsupportedScheme(let scheme):
            return "Pairing URL uses unsupported scheme '\(scheme)'."
        case .missingToken(let host):
            return "Pairing URL for \(host) is missing its token."
        case .httpStatus(let endpoint, let statusCode, let body):
            return "HTTP \(statusCode) from \(endpoint): \(body)"
        case .nonHTTPResponse(let endpoint):
            return "Non-HTTP response from \(endpoint)."
        case .network(let endpoint, let detail):
            return "Could not reach \(endpoint): \(detail)"
        case .decoding(let endpoint, let detail):
            return "Failed to decode \(endpoint) response: \(detail)"
        }
    }
}

public struct PairingTarget: Sendable, Equatable {
    public let credential: String
    public let httpBaseURL: URL
    public let wsBaseURL: URL

    public init(credential: String, httpBaseURL: URL, wsBaseURL: URL) {
        self.credential = credential
        self.httpBaseURL = httpBaseURL
        self.wsBaseURL = wsBaseURL
    }

    public static func parse(pairingURL: String) throws -> PairingTarget {
        let trimmed = pairingURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else {
            throw PairingClientError.invalidURL(pairingURL)
        }

        guard let host = url.host, !host.isEmpty else {
            throw PairingClientError.invalidURL(pairingURL)
        }
        guard let scheme = url.scheme?.lowercased() else {
            throw PairingClientError.invalidURL(pairingURL)
        }
        guard ["http", "https", "ws", "wss"].contains(scheme) else {
            throw PairingClientError.unsupportedScheme("\(scheme):")
        }

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw PairingClientError.invalidURL(pairingURL)
        }
        let queryCredential = components.queryItems?.first(where: { $0.name == "token" })?.value
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : $0 }
        let credential = token(from: components.fragment) ?? queryCredential
        guard let credential, !credential.isEmpty else {
            throw PairingClientError.missingToken(host: host)
        }

        var base = components
        base.path = "/"
        base.query = nil
        base.fragment = nil

        var http = base
        switch scheme {
        case "ws":
            http.scheme = "http"
        case "wss":
            http.scheme = "https"
        default:
            break
        }

        var ws = base
        switch scheme {
        case "http":
            ws.scheme = "ws"
        case "https":
            ws.scheme = "wss"
        default:
            break
        }

        guard let httpBaseURL = http.url, let wsBaseURL = ws.url else {
            throw PairingClientError.invalidURL(pairingURL)
        }
        return PairingTarget(
            credential: credential,
            httpBaseURL: httpBaseURL,
            wsBaseURL: wsBaseURL)
    }

    private static func token(from fragment: String?) -> String? {
        guard let fragment, !fragment.isEmpty,
            let fragmentURL = URL(string: "http://pairing.invalid/?\(fragment)"),
            let items = URLComponents(url: fragmentURL, resolvingAgainstBaseURL: false)?.queryItems
        else {
            return nil
        }
        return items.first(where: { $0.name == "token" })?.value
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }
}

public struct EnvironmentPlatform: Sendable, Decodable, Equatable {
    public let os: String
    public let arch: String
}

public struct EnvironmentDescriptor: Sendable, Decodable, Equatable {
    public let environmentId: String
    public let label: String
    public let platform: EnvironmentPlatform
    public let serverVersion: String
}

public struct PairingRedemption: Sendable {
    public let descriptor: EnvironmentDescriptor
    public let accessToken: String
    public let expiresIn: Int

    public init(descriptor: EnvironmentDescriptor, accessToken: String, expiresIn: Int) {
        self.descriptor = descriptor
        self.accessToken = accessToken
        self.expiresIn = expiresIn
    }
}

public struct RemoteSessionState: Sendable, Decodable, Equatable {
    public let authenticated: Bool
    public let expiresAt: String?
}

public enum PairingClient {
    public static func fetchDescriptor(
        httpBaseURL: URL,
        urlSession: URLSession = .shared
    ) async throws -> EnvironmentDescriptor {
        let endpoint = httpBaseURL.appendingPathComponent(".well-known/t3/environment")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data = try await perform(request, urlSession: urlSession)
        return try decode(EnvironmentDescriptor.self, from: data, endpoint: endpoint)
    }

    public static func redeem(
        target: PairingTarget,
        clientLabel: String,
        urlSession: URLSession = .shared
    ) async throws -> PairingRedemption {
        // A descriptor request is unauthenticated. Do it first so a bad or
        // unreachable target cannot consume the single-use pairing code.
        let descriptor = try await fetchDescriptor(
            httpBaseURL: target.httpBaseURL, urlSession: urlSession)

        let endpoint = target.httpBaseURL.appendingPathComponent("oauth/token")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = AuthTokenExchangeFormEncoder.encode(
            subjectToken: target.credential, clientLabel: clientLabel)

        let data = try await perform(request, urlSession: urlSession)
        struct TokenResponse: Decodable {
            let access_token: String
            let expires_in: Int
        }
        let token = try decode(TokenResponse.self, from: data, endpoint: endpoint)
        return PairingRedemption(
            descriptor: descriptor,
            accessToken: token.access_token,
            expiresIn: token.expires_in)
    }

    public static func sessionState(
        httpBaseURL: URL,
        accessToken: String,
        urlSession: URLSession = .shared
    ) async throws -> RemoteSessionState {
        let endpoint = httpBaseURL.appendingPathComponent("api/auth/session")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data = try await perform(request, urlSession: urlSession)
        return try decode(RemoteSessionState.self, from: data, endpoint: endpoint)
    }

    private static func perform(
        _ request: URLRequest,
        urlSession: URLSession
    ) async throws -> Data {
        try await HTTPClient.perform(
            request,
            urlSession: urlSession,
            mapTransportError: { endpoint, detail in
                PairingClientError.network(endpoint: endpoint, detail: detail)
            },
            mapNonHTTPResponse: { endpoint in
                PairingClientError.nonHTTPResponse(endpoint: endpoint)
            },
            mapHTTPStatus: { endpoint, statusCode, body in
                PairingClientError.httpStatus(
                    endpoint: endpoint, statusCode: statusCode, body: body)
            })
    }

    private static func decode<Value: Decodable>(
        _ type: Value.Type,
        from data: Data,
        endpoint: URL
    ) throws -> Value {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw PairingClientError.decoding(endpoint: endpoint.absoluteString, detail: String(describing: error))
        }
    }
}
