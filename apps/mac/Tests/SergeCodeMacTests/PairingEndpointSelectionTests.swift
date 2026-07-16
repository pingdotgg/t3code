import Foundation
import T3Kit
import Testing

@testable import SergeCodeMac

@Suite("PairingEndpointSelection")
struct PairingEndpointSelectionTests {
    private static func endpoint(
        id: String,
        kind: String,
        httpBaseUrl: String,
        status: String = "available",
        isDefault: Bool? = nil
    ) -> AdvertisedEndpoint {
        AdvertisedEndpoint(
            id: id,
            label: id,
            provider: AdvertisedEndpointProvider(
                id: id, label: id, kind: kind, isAddon: false),
            httpBaseUrl: httpBaseUrl,
            wsBaseUrl: httpBaseUrl
                .replacingOccurrences(of: "https:", with: "wss:")
                .replacingOccurrences(of: "http:", with: "ws:"),
            reachability: kind == "private-network" ? "private-network" : "lan",
            source: "server",
            status: status,
            isDefault: isDefault)
    }

    @Test("picks the default private-network endpoint the server lists first")
    func picksTailnetDefault() {
        let endpoints = [
            Self.endpoint(
                id: "tailscale-serve", kind: "private-network",
                httpBaseUrl: "https://serges-mac.tail1234.ts.net/", isDefault: true),
            Self.endpoint(id: "direct", kind: "core", httpBaseUrl: "http://192.168.1.42:3773/"),
        ]

        let selected = PairingEndpointSelection.preferredTailnetEndpoint(endpoints)
        #expect(selected?.id == "tailscale-serve")
    }

    @Test("returns nil when only the direct endpoint is advertised")
    func directOnlyMeansNoTailnet() {
        let endpoints = [
            Self.endpoint(id: "direct", kind: "core", httpBaseUrl: "http://192.168.1.42:3773/")
        ]

        #expect(PairingEndpointSelection.preferredTailnetEndpoint(endpoints) == nil)
    }

    @Test("returns nil for absent or empty endpoint lists (pre-serve boot, older servers)")
    func toleratesMissingEndpoints() {
        #expect(PairingEndpointSelection.preferredTailnetEndpoint(nil) == nil)
        #expect(PairingEndpointSelection.preferredTailnetEndpoint([]) == nil)
    }

    @Test("ignores a private-network endpoint that is not default or not available")
    func requiresDefaultAndAvailable() {
        let notDefault = [
            Self.endpoint(
                id: "tailscale-serve", kind: "private-network",
                httpBaseUrl: "https://serges-mac.tail1234.ts.net/")
        ]
        #expect(PairingEndpointSelection.preferredTailnetEndpoint(notDefault) == nil)

        let unavailable = [
            Self.endpoint(
                id: "tailscale-serve", kind: "private-network",
                httpBaseUrl: "https://serges-mac.tail1234.ts.net/",
                status: "unavailable", isDefault: true)
        ]
        #expect(PairingEndpointSelection.preferredTailnetEndpoint(unavailable) == nil)
    }

    @Test("builds the /pair fragment-token URL from a normalized https base")
    func buildsTailnetPairingURL() {
        let url = PairingEndpointSelection.pairingURL(
            httpBaseUrl: "https://serges-mac.tail1234.ts.net/", credential: "CODE1234")

        #expect(url?.absoluteString == "https://serges-mac.tail1234.ts.net/pair#token=CODE1234")
    }

    @Test("preserves an explicit port and tolerates a base without a trailing slash")
    func preservesPortAndSlashlessBase() {
        let url = PairingEndpointSelection.pairingURL(
            httpBaseUrl: "http://192.168.1.42:3773", credential: "CODE1234")

        #expect(url?.absoluteString == "http://192.168.1.42:3773/pair#token=CODE1234")
    }

    @Test("rejects a base URL without a host")
    func rejectsHostlessBase() {
        #expect(PairingEndpointSelection.pairingURL(httpBaseUrl: "not a url", credential: "C") == nil)
        #expect(PairingEndpointSelection.pairingURL(httpBaseUrl: "/relative", credential: "C") == nil)
    }

    @Test("round trips through PairingTarget.parse the way a scanning client will")
    func roundTripsThroughPairingTarget() throws {
        let url = try #require(
            PairingEndpointSelection.pairingURL(
                httpBaseUrl: "https://serges-mac.tail1234.ts.net/", credential: "CODE1234"))

        let target = try PairingTarget.parse(pairingURL: url.absoluteString)
        #expect(target.credential == "CODE1234")
        #expect(target.httpBaseURL.absoluteString == "https://serges-mac.tail1234.ts.net/")
        #expect(target.wsBaseURL.absoluteString == "wss://serges-mac.tail1234.ts.net/")
    }
}
