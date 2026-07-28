import Foundation
import Testing
@testable import T3Kit

@Suite("PairingTarget")
struct PairingTargetTests {
    @Test("derives backend urls and token from a fragment pairing url")
    func fragmentToken() throws {
        let target = try PairingTarget.parse(
            pairingURL: "https://remote.example.com/pair#token=pairing-token")

        #expect(target.credential == "pairing-token")
        #expect(target.httpBaseURL.absoluteString == "https://remote.example.com/")
        #expect(target.wsBaseURL.absoluteString == "wss://remote.example.com/")
    }

    @Test("accepts pairing urls that still use a query token")
    func queryToken() throws {
        let target = try PairingTarget.parse(
            pairingURL: "https://remote.example.com/pair?token=pairing-token")

        #expect(target.credential == "pairing-token")
        #expect(target.httpBaseURL.absoluteString == "https://remote.example.com/")
        #expect(target.wsBaseURL.absoluteString == "wss://remote.example.com/")
    }

    @Test("fragment token takes precedence over query token")
    func fragmentWins() throws {
        let target = try PairingTarget.parse(
            pairingURL: "http://remote.example.com:3000/pair?token=query#token=fragment")

        #expect(target.credential == "fragment")
        #expect(target.httpBaseURL.absoluteString == "http://remote.example.com:3000/")
        #expect(target.wsBaseURL.absoluteString == "ws://remote.example.com:3000/")
    }

    @Test("falls back to a query token when the fragment token is empty")
    func emptyFragmentFallsBackToQuery() throws {
        let target = try PairingTarget.parse(
            pairingURL: "https://remote.example.com/pair?token=query#token=")

        #expect(target.credential == "query")
    }

    @Test("preserves ports while stripping path, query, and fragment")
    func preservesPort() throws {
        let target = try PairingTarget.parse(
            pairingURL: "https://remote.example.com:44342/some/path?ignored=yes#token=code")

        #expect(target.httpBaseURL.absoluteString == "https://remote.example.com:44342/")
        #expect(target.wsBaseURL.absoluteString == "wss://remote.example.com:44342/")
    }

    @Test("normalizes websocket input to matching HTTP and WebSocket schemes")
    func normalizesWebSocketInput() throws {
        let target = try PairingTarget.parse(
            pairingURL: "ws://remote.example.com:3000/pair#token=code")

        #expect(target.httpBaseURL.absoluteString == "http://remote.example.com:3000/")
        #expect(target.wsBaseURL.absoluteString == "ws://remote.example.com:3000/")
    }

    @Test("rejects a pairing url without a token")
    func missingToken() {
        do {
            _ = try PairingTarget.parse(pairingURL: "https://remote.example.com/pair")
            Issue.record("expected a missing-token error")
        } catch let error as PairingClientError {
            guard case .missingToken(let host) = error else {
                Issue.record("expected missingToken, got \(error)")
                return
            }
            #expect(host == "remote.example.com")
        } catch {
            Issue.record("expected PairingClientError, got \(error)")
        }
    }

    @Test("rejects invalid and unsupported pairing urls")
    func invalidURL() {
        do {
            _ = try PairingTarget.parse(pairingURL: "not a url")
            Issue.record("expected an invalid-url error")
        } catch let error as PairingClientError {
            guard case .invalidURL = error else {
                Issue.record("expected invalidURL, got \(error)")
                return
            }
        } catch {
            Issue.record("expected PairingClientError, got \(error)")
        }

        do {
            _ = try PairingTarget.parse(pairingURL: "ftp://remote.example.com/pair#token=code")
            Issue.record("expected an unsupported-scheme error")
        } catch let error as PairingClientError {
            guard case .unsupportedScheme(let scheme) = error else {
                Issue.record("expected unsupportedScheme, got \(error)")
                return
            }
            #expect(scheme == "ftp:")
        } catch {
            Issue.record("expected PairingClientError, got \(error)")
        }
    }
}

@Suite("EnvironmentDescriptor decoding")
struct EnvironmentDescriptorDecodingTests {
    @Test("decodes a descriptor without advertisedEndpoints (older servers / pre-serve boot)")
    func decodesWithoutAdvertisedEndpoints() throws {
        let json = """
            {"environmentId":"env-1","label":"Serge's Mac","platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1.2.3","capabilities":{"repositoryIdentity":true}}
            """
        let descriptor = try JSONDecoder().decode(
            EnvironmentDescriptor.self, from: Data(json.utf8))

        #expect(descriptor.environmentId == "env-1")
        #expect(descriptor.advertisedEndpoints == nil)
    }

    // The exact wire shape apps/server/src/advertisedEndpoints.ts serves:
    // tailscale entry first (the only one with isDefault), direct entry
    // always present, URLs normalized with a trailing slash. The
    // `compatibility` is decoded so endpoint adoption can reject transports
    // that a future server marks incompatible with this native client.
    @Test("decodes the server's advertised-endpoints wire shape")
    func decodesAdvertisedEndpoints() throws {
        let json = """
            {"environmentId":"env-1","label":"Serge's Mac","platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1.2.3","capabilities":{"repositoryIdentity":false},"advertisedEndpoints":[{"id":"tailscale-serve","label":"Tailscale","provider":{"id":"tailscale","label":"Tailscale","kind":"private-network","isAddon":false},"httpBaseUrl":"https://serges-mac.tail1234.ts.net/","wsBaseUrl":"wss://serges-mac.tail1234.ts.net/","reachability":"private-network","compatibility":{"hostedHttpsApp":"unknown","desktopApp":"compatible"},"source":"server","status":"available","isDefault":true},{"id":"direct","label":"Direct","provider":{"id":"direct","label":"Direct","kind":"core","isAddon":false},"httpBaseUrl":"http://192.168.1.42:3773/","wsBaseUrl":"ws://192.168.1.42:3773/","reachability":"lan","compatibility":{"hostedHttpsApp":"mixed-content-blocked","desktopApp":"compatible"},"source":"server","status":"available"}]}
            """
        let descriptor = try JSONDecoder().decode(
            EnvironmentDescriptor.self, from: Data(json.utf8))

        let endpoints = try #require(descriptor.advertisedEndpoints)
        #expect(endpoints.count == 2)

        let tailscale = try #require(endpoints.first)
        #expect(tailscale.id == "tailscale-serve")
        #expect(tailscale.provider.kind == "private-network")
        #expect(tailscale.httpBaseUrl == "https://serges-mac.tail1234.ts.net/")
        #expect(tailscale.wsBaseUrl == "wss://serges-mac.tail1234.ts.net/")
        #expect(tailscale.isDefault == true)
        #expect(tailscale.status == "available")
        #expect(tailscale.compatibility?.desktopApp == "compatible")

        let direct = try #require(endpoints.last)
        #expect(direct.id == "direct")
        #expect(direct.provider.kind == "core")
        #expect(direct.reachability == "lan")
        #expect(direct.isDefault == nil)
    }
}

private final class FailingPairingURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        client?.urlProtocol(
            self,
            didFailWithError: URLError(.cannotConnectToHost))
    }

    override func stopLoading() {}
}

@Suite("PairingClient HTTP errors")
struct PairingClientHTTPErrorTests {
    @Test("surfaces transport failures as network errors")
    func networkFailure() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FailingPairingURLProtocol.self]
        let session = URLSession(configuration: configuration)

        do {
            _ = try await PairingClient.fetchDescriptor(
                httpBaseURL: URL(string: "http://remote.invalid")!,
                urlSession: session)
            Issue.record("expected a network error")
        } catch let error as PairingClientError {
            guard case .network(let endpoint, let detail) = error else {
                Issue.record("expected network, got \(error)")
                return
            }
            #expect(endpoint.contains("remote.invalid"))
            #expect(detail.contains("NSURLErrorDomain"))
        } catch {
            Issue.record("expected PairingClientError, got \(error)")
        }
    }

    /// The reported failure: a Tailscale MagicDNS name whose :443 is owned by
    /// another web server. Pairing used to render that server's HTML error
    /// page verbatim, which says nothing about what to do next.
    @Test("reports a foreign host as not running SergeCode")
    func foreignHost() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ForeignHostURLProtocol.self]
        let session = URLSession(configuration: configuration)

        do {
            _ = try await PairingClient.fetchDescriptor(
                httpBaseURL: URL(string: "https://m1-dev.tailb5ff83.ts.net")!,
                urlSession: session)
            Issue.record("expected a notEnvironmentEndpoint error")
        } catch let error as PairingClientError {
            guard case .notEnvironmentEndpoint(let host, let statusCode) = error else {
                Issue.record("expected notEnvironmentEndpoint, got \(error)")
                return
            }
            #expect(host == "m1-dev.tailb5ff83.ts.net")
            #expect(statusCode == 404)
            let description = error.errorDescription ?? ""
            #expect(description.contains("m1-dev.tailb5ff83.ts.net"))
            #expect(description.contains("not running SergeCode"))
            #expect(!description.contains("<html>"))
        } catch {
            Issue.record("expected PairingClientError, got \(error)")
        }
    }

    @Test("reports a 200 that is not a descriptor as not running SergeCode")
    func foreignHostAnswering200() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ForeignHostOKURLProtocol.self]
        let session = URLSession(configuration: configuration)

        do {
            _ = try await PairingClient.fetchDescriptor(
                httpBaseURL: URL(string: "https://m1-dev.tailb5ff83.ts.net")!,
                urlSession: session)
            Issue.record("expected a notEnvironmentEndpoint error")
        } catch let error as PairingClientError {
            guard case .notEnvironmentEndpoint(let host, let statusCode) = error else {
                Issue.record("expected notEnvironmentEndpoint, got \(error)")
                return
            }
            #expect(host == "m1-dev.tailb5ff83.ts.net")
            #expect(statusCode == nil)
        } catch {
            Issue.record("expected PairingClientError, got \(error)")
        }
    }

    @Test("collapses an HTML error body to one short line")
    func summarizesHtmlBodies() {
        let body = """
            <html>
            <head><title>404 Not Found</title></head>
            <body>
            <center><h1>404 Not Found</h1></center>
            <hr><center>nginx/1.27.5</center>
            </body>
            </html>
            """

        let summary = PairingClientError.summarize(body)
        #expect(summary == "404 Not Found 404 Not Found nginx/1.27.5")
        #expect(PairingClientError.summarize(String(repeating: "a", count: 500)).count == 121)
    }
}

private final class ForeignHostURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 404, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/html"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("<html>404 Not Found</html>".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ForeignHostOKURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/html"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("<html>hello</html>".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
