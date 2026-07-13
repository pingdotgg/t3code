import Foundation

/// Shared URLSession request execution. Callers supply their error taxonomy so
/// transport, response, and HTTP-status semantics remain local to each client.
internal enum HTTPClient {
    static func perform(
        _ request: URLRequest,
        urlSession: URLSession,
        // Raw `Error`, not a pre-stringified detail: callers that need to
        // classify the failure (e.g. PairingClient distinguishing a macOS
        // Local Network privacy denial from a genuine offline/unreachable
        // error) need the original URLError/NSError, not its description.
        mapTransportError: @Sendable (String, Error) -> any Error,
        mapNonHTTPResponse: @Sendable (String) -> any Error,
        mapHTTPStatus: @Sendable (String, Int, String) -> any Error
    ) async throws -> Data {
        let endpoint = request.url?.absoluteString ?? "<unknown>"
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw mapTransportError(endpoint, error)
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
