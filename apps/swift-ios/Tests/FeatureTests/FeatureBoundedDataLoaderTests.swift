import Foundation
import Testing
@testable import T3Code

@Suite("Bounded workspace image downloads")
struct FeatureBoundedDataLoaderTests {
    @Test
    func returnsDataWithinTheLimit() async throws {
        let output = try await FeatureBoundedDataLoader.data(
            from: try #require(URL(string: "https://example.test/small")),
            maximumBytes: 8,
            configuration: Self.configuration
        )
        #expect(output.0 == Data("small".utf8))
    }

    @Test
    func stopsWhenIncrementalDataExceedsTheLimit() async throws {
        await #expect(throws: FeatureBoundedDataLoaderError.tooLarge) {
            try await FeatureBoundedDataLoader.data(
                from: try #require(URL(string: "https://example.test/large")),
                maximumBytes: 8,
                configuration: Self.configuration
            )
        }
    }

    private static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BoundedDataURLProtocol.self]
        return configuration
    }
}

private final class BoundedDataURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let payload = request.url?.path == "/small"
            ? Data("small".utf8)
            : Data("larger-than-eight".utf8)
        let response = URLResponse(
            url: request.url!,
            mimeType: "application/octet-stream",
            expectedContentLength: -1,
            textEncodingName: nil
        )
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let midpoint = payload.count / 2
        client?.urlProtocol(self, didLoad: payload[..<midpoint])
        client?.urlProtocol(self, didLoad: payload[midpoint...])
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
