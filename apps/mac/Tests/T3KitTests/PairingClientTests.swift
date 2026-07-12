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
