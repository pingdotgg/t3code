import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Local environment Live Activity link")
struct T3ConnectLocalEnvironmentLinkerTests {
    @Test
    func linksWithHostProofAndAppliesMatchingRelayConfiguration() async throws {
        let transport = LocalLinkTransport()
        let linker = try makeLinker(transport)
        try await linker.link(local(), enabled: true, clerkToken: "account-token",
                              accountID: "account", deviceID: "phone", validateAccount: {})
        let requests = await transport.requests
        #expect(requests.map(\.url?.path) == [
            "/v1/client/environment-link-challenges", "/api/connect/link-proof",
            "/v1/client/environment-links", "/api/connect/relay-config",
        ])
        #expect(requests.map { $0.value(forHTTPHeaderField: "Authorization") } == [
            "Bearer account-token", "Bearer local-token", "Bearer account-token", "Bearer local-token",
        ])
        let bodies = try requests.map { try JSONDecoder.t3.decode(JSONValue.self, from: #require($0.httpBody)) }
        #expect(bodies[0]["liveActivitiesEnabled"] == .bool(true))
        #expect(bodies[0]["notificationsEnabled"] == .bool(true))
        #expect(bodies[0]["managedTunnelsEnabled"] == .bool(true))
        #expect(bodies[1]["challenge"] == .string("challenge"))
        #expect(bodies[1]["endpoint"]?["providerKind"] == .string("cloudflare_tunnel"))
        #expect(bodies[1]["origin"]?["localHttpHost"] == .string("127.0.0.1"))
        #expect(bodies[1]["origin"]?["localHttpPort"] == .number(4443))
        #expect(bodies[2]["proof"] == .string("signed-host-proof"))
        #expect(bodies[2]["deviceId"] == .string("phone"))
        #expect(bodies[3]["cloudUserId"] == .string("account"))
        #expect(bodies[3]["environmentCredential"] == .string("relay-credential"))
        #expect(bodies[3]["endpointRuntime"] == .null)
    }

    @Test(arguments: ["environment", "account", "provider"])
    func rejectsMismatchedRelayIdentityBeforeConfiguringHost(mismatch: String) async throws {
        let transport = LocalLinkTransport(mismatch: mismatch)
        let linker = try makeLinker(transport)
        do {
            try await linker.link(local(), enabled: true, clerkToken: "account-token",
                                  accountID: "account", deviceID: "phone", validateAccount: {})
            Issue.record("Accepted mismatched relay \(mismatch)")
        } catch {}
        let requests = await transport.requests
        #expect(requests.count == 3)
        #expect(!requests.contains { $0.url?.path == "/api/connect/relay-config" })
    }

    @Test
    func accountChangeAfterProofStopsBeforeLink() async throws {
        let transport = LocalLinkTransport()
        let linker = try makeLinker(transport)
        var validations = 0
        do {
            try await linker.link(local(), enabled: true, clerkToken: "account-token",
                                  accountID: "account", deviceID: "phone", validateAccount: {
                validations += 1
                if validations == 3 { throw T3ConnectAuthError.noSession }
            })
            Issue.record("Linked after the account changed")
        } catch {}
        #expect(await transport.requests.count == 2)
    }

    @Test
    func managedAndDisabledConnectionsCannotEnterSetup() throws {
        let saved = try local()
        for kind in [EnvironmentKind.managedDPoP, .local] {
            var environment = saved.environment
            environment.kind = kind
            #expect(throws: (any Error).self) {
                try T3ConnectLocalEnvironment(environment: environment, credential: saved.credential)
            }
        }
        var disabled = saved.environment
        disabled.isEnabled = false
        #expect(throws: (any Error).self) {
            try T3ConnectLocalEnvironment(environment: disabled, credential: saved.credential)
        }
    }

    private func local() throws -> T3ConnectLocalEnvironment {
        try .init(environment: Environment(id: "env", label: "Studio",
                                           httpBaseURL: URL(string: "https://local.example:4443")!,
                                           webSocketBaseURL: URL(string: "wss://local.example:4443")!),
                  credential: .init(accessToken: "local-token"))
    }

    private func makeLinker(_ transport: LocalLinkTransport) throws -> T3ConnectLocalEnvironmentLinker {
        let relayURL = URL(string: "https://relay.example")!
        var key = Data(repeating: 0, count: 32)
        key[31] = 13
        return T3ConnectLocalEnvironmentLinker(
            relay: T3ConnectRelayClient(configuration: .init(clerkPublishableKey: "pk_test", relayHTTPURL: relayURL),
                                         transport: transport, signer: try .init(privateKeyRawRepresentation: key)),
            relayURL: relayURL, transport: transport
        )
    }
}

private actor LocalLinkTransport: HTTPTransport {
    let mismatch: String?
    private(set) var requests: [URLRequest] = []
    init(mismatch: String? = nil) { self.mismatch = mismatch }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let body: String
        switch request.url?.path {
        case "/v1/client/environment-link-challenges":
            body = #"{"challenge":"challenge","expiresAt":"2030-01-01T00:00:00Z"}"#
        case "/api/connect/link-proof":
            body = #""signed-host-proof""#
        case "/v1/client/environment-links":
            body = """
            {"ok":true,"cloudUserId":"\(mismatch == "account" ? "other" : "account")",
             "environmentId":"\(mismatch == "environment" ? "other" : "env")",
             "endpoint":{"httpBaseUrl":"https://managed.example","wsBaseUrl":"wss://managed.example",
                         "providerKind":"\(mismatch == "provider" ? "manual" : "cloudflare_tunnel")"},
             "endpointRuntime":null,"relayIssuer":"https://relay.example",
             "environmentCredential":"relay-credential","cloudMintPublicKey":"public-key"}
            """
        case "/api/connect/relay-config": body = #"{"ok":true,"endpointRuntimeStatus":null}"#
        default: throw HTTPError.invalidResponse
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
                                               httpVersion: nil, headerFields: nil)!)
    }
}
