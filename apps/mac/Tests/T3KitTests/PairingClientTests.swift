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
    // `compatibility` object is intentionally not modeled and must be
    // ignored, not rejected.
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
}
