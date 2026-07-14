import Foundation
import Testing
@testable import T3Kit

@Suite("LocalNetworkDenial")
struct LocalNetworkDenialTests {
    @Test("matches -1009 wrapping an NWError whose description mentions the denial")
    func matchesWrappedNWErrorText() {
        let underlying = NSError(
            domain: "NWErrorDomain",
            code: -65572,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "nw_path_evaluator_evaluate [C1] Local network prohibited"
            ])
        let urlError = NSError(
            domain: NSURLErrorDomain,
            code: URLError.notConnectedToInternet.rawValue,
            userInfo: [NSUnderlyingErrorKey: underlying])

        #expect(LocalNetworkDenial.matches(urlError, url: URL(string: "http://192.168.1.42:4096/")))
    }

    @Test("matches -1004 when the underlying error chain mentions the denial")
    func matchesCannotConnectWithNWErrorText() {
        let underlying = NSError(
            domain: "NWErrorDomain",
            code: -65572,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "nw_path_evaluator_evaluate [C1] Local network prohibited"
            ])
        let urlError = NSError(
            domain: NSURLErrorDomain,
            code: URLError.cannotConnectToHost.rawValue,
            userInfo: [NSUnderlyingErrorKey: underlying])

        #expect(LocalNetworkDenial.matches(urlError, url: URL(string: "http://192.168.1.42:4096/")))
    }

    @Test("does not match -1004 to a private host without the prohibited marker (connection refused)")
    func doesNotMatchCannotConnectViaHostHeuristic() {
        // The everyday failure: the peer Mac is on the LAN but its server
        // isn't running. Must not be reported as a TCC denial.
        let urlError = NSError(
            domain: NSURLErrorDomain, code: URLError.cannotConnectToHost.rawValue)

        #expect(!LocalNetworkDenial.matches(urlError, url: URL(string: "http://192.168.1.42:4096/")))
        #expect(!LocalNetworkDenial.matches(urlError, url: URL(string: "http://my-mac.local/")))
    }

    @Test("matches -1009 against a private IPv4 host even without the NWError text")
    func matchesPrivateHostHeuristic() {
        let urlError = NSError(
            domain: NSURLErrorDomain, code: URLError.notConnectedToInternet.rawValue)

        #expect(LocalNetworkDenial.matches(urlError, url: URL(string: "http://10.0.0.5:4096/")))
        #expect(LocalNetworkDenial.matches(urlError, url: URL(string: "http://172.20.3.1/")))
        #expect(LocalNetworkDenial.matches(urlError, url: URL(string: "http://192.168.0.9/")))
        #expect(LocalNetworkDenial.matches(urlError, url: URL(string: "http://my-mac.local/")))
    }

    @Test("does not match a genuine offline error against a public host")
    func doesNotMatchPublicHost() {
        let urlError = NSError(
            domain: NSURLErrorDomain, code: URLError.notConnectedToInternet.rawValue)

        #expect(!LocalNetworkDenial.matches(urlError, url: URL(string: "https://example.com/")))
    }

    @Test("does not match unrelated URLError codes")
    func doesNotMatchUnrelatedCode() {
        let urlError = NSError(domain: NSURLErrorDomain, code: URLError.timedOut.rawValue)

        #expect(!LocalNetworkDenial.matches(urlError, url: URL(string: "http://192.168.1.1/")))
    }

    @Test("does not match errors outside NSURLErrorDomain")
    func doesNotMatchOtherDomains() {
        let error = NSError(domain: "SomeOtherDomain", code: -1009)

        #expect(!LocalNetworkDenial.matches(error, url: URL(string: "http://192.168.1.1/")))
    }
}
