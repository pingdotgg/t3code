import Foundation

/// Shared URLSession request execution. Callers supply their error taxonomy so
/// transport, response, and HTTP-status semantics remain local to each client.
internal enum HTTPClient {
    static func perform(
        _ request: URLRequest,
        urlSession: URLSession,
        mapTransportError: @Sendable (String, String) -> any Error,
        mapNonHTTPResponse: @Sendable (String) -> any Error,
        mapHTTPStatus: @Sendable (String, Int, String) -> any Error
    ) async throws -> Data {
        let endpoint = request.url?.absoluteString ?? "<unknown>"
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw mapTransportError(endpoint, String(describing: error))
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw mapNonHTTPResponse(endpoint)
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw mapHTTPStatus(
                endpoint,
                httpResponse.statusCode,
                String(data: data, encoding: .utf8) ?? "<non-utf8 body>")
        }
        return data
    }
}
