import Foundation
import T3MobileProtocol

struct MobileHTTPClient: Sendable {
    private let urlSession: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private let timeoutInterval: TimeInterval

    init(
        urlSession: URLSession = .shared,
        decoder: JSONDecoder = JSONDecoder(),
        encoder: JSONEncoder = JSONEncoder(),
        timeoutInterval: TimeInterval = 15
    ) {
        self.urlSession = urlSession
        self.decoder = decoder
        self.encoder = encoder
        self.timeoutInterval = timeoutInterval
    }

    func descriptor(baseURL: URL) async throws -> MobileDescriptorResult {
        try await get(endpoint: "/mobile/v1", baseURL: baseURL)
    }

    func bootstrapBearer(baseURL: URL, credential: String) async throws -> MobileAuthBearerBootstrapResult {
        try await post(
            endpoint: "/mobile/v1/auth/bootstrap/bearer",
            baseURL: baseURL,
            bearerToken: nil,
            body: MobileBearerBootstrapInput(credential: credential)
        )
    }

    func session(baseURL: URL, bearerToken: String) async throws -> MobileAuthSessionResult {
        try await get(
            endpoint: "/mobile/v1/auth/session",
            baseURL: baseURL,
            bearerToken: bearerToken
        )
    }

    func webSocketToken(baseURL: URL, bearerToken: String) async throws -> MobileAuthWebSocketTokenResult {
        try await post(
            endpoint: "/mobile/v1/auth/ws-token",
            baseURL: baseURL,
            bearerToken: bearerToken,
            body: EmptyPayload()
        )
    }

    private func get<Response: Decodable>(
        endpoint: String,
        baseURL: URL,
        bearerToken: String? = nil
    ) async throws -> Response {
        let url = try absoluteURL(endpoint: endpoint, baseURL: baseURL)
        var request = URLRequest(url: url, timeoutInterval: timeoutInterval)
        request.httpMethod = "GET"
        applyHeaders(to: &request, bearerToken: bearerToken)
        return try await send(request)
    }

    private func post<RequestBody: Encodable, Response: Decodable>(
        endpoint: String,
        baseURL: URL,
        bearerToken: String?,
        body: RequestBody
    ) async throws -> Response {
        let url = try absoluteURL(endpoint: endpoint, baseURL: baseURL)
        var request = URLRequest(url: url, timeoutInterval: timeoutInterval)
        request.httpMethod = "POST"
        applyHeaders(to: &request, bearerToken: bearerToken)
        request.httpBody = try encoder.encode(body)
        return try await send(request)
    }

    private func applyHeaders(to request: inout URLRequest, bearerToken: String?) {
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "authorization")
        }
    }

    private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw MobileSyncError.unexpectedMessage("Mobile server did not return an HTTP response.")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw MobileSyncError.httpStatus(httpResponse.statusCode)
        }
        return try decoder.decode(Response.self, from: data)
    }

    private func absoluteURL(endpoint: String, baseURL: URL) throws -> URL {
        if let url = URL(string: endpoint), url.scheme != nil {
            return url
        }
        guard let url = URL(string: endpoint, relativeTo: baseURL)?.absoluteURL else {
            throw MobileSyncError.invalidEndpoint(endpoint)
        }
        return url
    }
}
