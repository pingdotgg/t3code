// AuthClient — HTTP auth bootstrap for the t3 server sidecar's
// desktop-managed-local auth policy (wire-protocol.md §1.2,
// ARCHITECTURE.md "Sidecar contract").
//
// Flow (mirrors `packages/client-runtime/src/authorization/remote.ts` and
// `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts`):
//   1. POST /oauth/token  — RFC 8693 token-exchange grant, trading the
//      sidecar's one-shot `desktopBootstrapToken` for a bearer access token
//      (`AuthAccessTokenResult`, `packages/contracts/src/environmentHttp.ts:187-194`).
//   2. POST /api/auth/websocket-ticket — mint a short-lived, per-connection
//      `wsTicket` (`AuthWebSocketTicketResult`, `:196-200`), authenticated
//      with `Authorization: Bearer <access-token>`.
//   3. Build the final socket URL: wsBaseURL with path forced to `/ws` and
//      `?wsTicket=<ticket>` appended. Call this fresh on every (re)connect —
//      tickets are short-lived and not resumable (§risk4, §risk8).

import Foundation

/// Configuration required to bootstrap an authenticated WebSocket connection
/// to a locally-spawned t3 server sidecar (§1.2).
public struct AuthConfig: Sendable {
    /// e.g. `http://127.0.0.1:3773` — base for the local auth HTTP API.
    public let httpBaseURL: URL
    /// e.g. `ws://127.0.0.1:3773` — path is forced to `/ws` by `AuthClient`.
    public let wsBaseURL: URL
    /// One-shot bootstrap credential handed to the sidecar over stdin
    /// (SidecarKit's `DesktopBackendBootstrap.desktopBootstrapToken`).
    public let desktopBootstrapToken: String

    public init(httpBaseURL: URL, wsBaseURL: URL, desktopBootstrapToken: String) {
        self.httpBaseURL = httpBaseURL
        self.wsBaseURL = wsBaseURL
        self.desktopBootstrapToken = desktopBootstrapToken
    }
}

/// Result of `POST /api/auth/websocket-ticket` (`AuthWebSocketTicketResult`,
/// §1.2).
public struct WsTicket: Sendable {
    public let ticket: String
    /// ISO-8601 UTC string (§5.1 — `Schema.DateTimeUtc` encodes to a string
    /// on the wire, not a numeric epoch).
    public let expiresAt: String

    public init(ticket: String, expiresAt: String) {
        self.ticket = ticket
        self.expiresAt = expiresAt
    }
}

/// Exchanges the sidecar's one-shot bootstrap token for a bearer access
/// token, then mints short-lived per-connection WebSocket tickets, over the
/// sidecar's local HTTP auth API (desktop-managed-local policy, §1.2). No
/// Clerk/pairing/DPoP in v1 (ARCHITECTURE.md).
public actor AuthClient {
    private let config: AuthConfig
    private let urlSession: URLSession
    private var cachedAccessToken: String?

    public init(config: AuthConfig, urlSession: URLSession = .shared) {
        self.config = config
        self.urlSession = urlSession
    }

    /// Exchanges the desktop bootstrap token for a bearer access token via
    /// `POST /oauth/token` (RFC 8693 token-exchange grant). The result is
    /// cached for the lifetime of this client, matching the reference
    /// desktop client's behavior (`DesktopLocalEnvironmentAuth.ts`), since a
    /// sidecar process hands out exactly one bootstrap token per launch.
    public func acquireAccessToken() async throws -> String {
        if let cachedAccessToken {
            return cachedAccessToken
        }

        let url = config.httpBaseURL.appendingPathComponent("oauth/token")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // `AuthTokenExchangeRequest` is `HttpApiSchema.asFormUrlEncoded()`
        // (packages/contracts/src/auth.ts:183), so the server decodes this
        // body as `application/x-www-form-urlencoded`, not JSON.
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        // AuthTokenExchangeRequest (packages/contracts/src/environmentHttp.ts:175-183).
        let bodyFields: [(String, String)] = [
            ("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"),
            ("subject_token", config.desktopBootstrapToken),
            ("subject_token_type", "urn:t3:params:oauth:token-type:environment-bootstrap"),
            ("requested_token_type", "urn:ietf:params:oauth:token-type:access_token"),
            ("client_label", "SergeCode"),
            ("client_device_type", "desktop"),
        ]
        var comps = URLComponents()
        comps.queryItems = bodyFields.map { URLQueryItem(name: $0.0, value: $0.1) }
        request.httpBody = comps.percentEncodedQuery?.data(using: .utf8)

        let data = try await perform(request)

        struct TokenResponse: Decodable {
            let access_token: String
        }
        let decoded: TokenResponse
        do {
            decoded = try JSONDecoder().decode(TokenResponse.self, from: data)
        } catch {
            throw T3Error.auth("Failed to decode /oauth/token response: \(error)")
        }

        cachedAccessToken = decoded.access_token
        return decoded.access_token
    }

    /// Mints a fresh, short-lived WebSocket ticket via
    /// `POST /api/auth/websocket-ticket`. Must be called again on every
    /// reconnect — tickets are not reusable across sockets (§risk8).
    public func mintWebSocketTicket(accessToken: String) async throws -> WsTicket {
        let url = config.httpBaseURL.appendingPathComponent("api/auth/websocket-ticket")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let data = try await perform(request)

        struct TicketResponse: Decodable {
            let ticket: String
            let expiresAt: String
        }
        do {
            let decoded = try JSONDecoder().decode(TicketResponse.self, from: data)
            return WsTicket(ticket: decoded.ticket, expiresAt: decoded.expiresAt)
        } catch {
            throw T3Error.auth("Failed to decode /api/auth/websocket-ticket response: \(error)")
        }
    }

    /// Convenience: acquire an access token, mint a fresh ticket, and build
    /// the final `ws://…/ws?wsTicket=…` socket URL. Call this fresh on every
    /// (re)connect attempt — there is no resume token, so a reconnect always
    /// means a brand-new ticket (§4.3, §risk4, §risk8).
    ///
    /// If ticket minting fails while using a cached access token, the cache
    /// is cleared and the exchange is retried once with a fresh token, in
    /// case the cached token expired (`AuthAccessTokenResult.expires_in`).
    public func makeSocketURL() async throws -> URL {
        let accessToken = try await acquireAccessToken()
        do {
            let ticket = try await mintWebSocketTicket(accessToken: accessToken)
            return try socketURL(ticket: ticket)
        } catch T3Error.auth {
            cachedAccessToken = nil
            let refreshedToken = try await acquireAccessToken()
            let ticket = try await mintWebSocketTicket(accessToken: refreshedToken)
            return try socketURL(ticket: ticket)
        }
    }

    private func socketURL(ticket: WsTicket) throws -> URL {
        guard var components = URLComponents(url: config.wsBaseURL, resolvingAgainstBaseURL: false) else {
            throw T3Error.auth("Invalid wsBaseURL: \(config.wsBaseURL.absoluteString)")
        }
        components.path = "/ws"
        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: "wsTicket", value: ticket.ticket))
        components.queryItems = queryItems

        guard let url = components.url else {
            throw T3Error.auth("Failed to construct socket URL from \(config.wsBaseURL.absoluteString)")
        }
        return url
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let requestURL = request.url?.absoluteString ?? "<unknown>"
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw T3Error.auth("HTTP request to \(requestURL) failed: \(error)")
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw T3Error.auth("Non-HTTP response from \(requestURL)")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let bodyText = String(data: data, encoding: .utf8) ?? "<non-utf8 body>"
            throw T3Error.auth("HTTP \(httpResponse.statusCode) from \(requestURL): \(bodyText)")
        }
        return data
    }
}
