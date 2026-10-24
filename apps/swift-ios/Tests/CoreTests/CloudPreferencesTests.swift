import Foundation
import XCTest
@testable import T3Code

@MainActor
final class CloudPreferencesTests: XCTestCase {
    func testWebhookUpdateReadsCurrentActivityAndUsesDestinationCredential() async throws {
        let remote = environment("remote")
        let local = environment("local")
        let credentials = InMemoryCredentialStore(credentials: [
            remote.id: .init(accessToken: "remote-token"), local.id: .init(accessToken: "local-token"),
        ])
        let transport = CloudPreferenceTransport()
        let client = T3Client(environment: remote, credentialStore: credentials, httpTransport: transport)
        let state = try await client.setHoldWebhooksWhileOffline(true)
        XCTAssertEqual(state.holdWebhooksWhileOffline, true)
        let requests = await transport.requests
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/connect/link-state", "/api/connect/preferences"])
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "POST"])
        XCTAssertTrue(requests.allSatisfy { $0.url?.host == "remote.example" })
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer remote-token" })
        let payload = try JSONDecoder.t3.decode(JSONValue.self, from: XCTUnwrap(requests.last?.httpBody))
        XCTAssertEqual(payload, .object(["publishAgentActivity": .bool(true), "holdWebhooksWhileOffline": .bool(true)]))
    }

    func testOlderServerCannotBeMutatedAndActivityOnlyPatchOmitsHold() async throws {
        let host = environment("remote")
        let transport = CloudPreferenceTransport(supportsHold: false)
        let client = T3Client(environment: host,
            credentialStore: InMemoryCredentialStore(credentials: [host.id: .init(accessToken: "token")]),
            httpTransport: transport)
        do {
            _ = try await client.setHoldWebhooksWhileOffline(true)
            XCTFail("Older server accepted a hold preference mutation")
        } catch is EnvironmentCloudPreferencesError { }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
        let patch = try JSONValue.encode(EnvironmentCloudPreferences(publishAgentActivity: false))
        XCTAssertEqual(patch, .object(["publishAgentActivity": .bool(false)]))
    }

    func testManagedCloudPreferencesUseExistingDPoPTransport() async throws {
        let host = environment("relay", kind: .managedDPoP)
        let credential = EnvironmentCredential.managedDPoP(accessToken: "managed-token",
            expiresAt: .now.addingTimeInterval(3600), scopes: ["relay:write"],
            environmentID: host.id, proofKeyThumbprint: "key")
        let transport = CloudPreferenceTransport()
        let client = T3Client(environment: host,
            credentialStore: InMemoryCredentialStore(credentials: [host.id: credential]),
            httpTransport: transport, managedAuthorization: CloudPreferenceAuthorizer())
        _ = try await client.setHoldWebhooksWhileOffline(true)
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0.url?.host == "relay.example" })
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "DPoP") == "request-proof" })
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "DPoP managed-token" })
    }

    private func environment(_ id: String, kind: EnvironmentKind = .bearer) -> Environment {
        .init(id: id, label: id, httpBaseURL: URL(string: "https://\(id).example")!,
              webSocketBaseURL: URL(string: "wss://\(id).example")!, kind: kind)
    }
}

private actor CloudPreferenceTransport: HTTPTransport {
    let supportsHold: Bool
    var requests: [URLRequest] = []
    init(supportsHold: Bool = true) { self.supportsHold = supportsHold }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        var fields: [String: JSONValue] = ["linked": .bool(true), "cloudUserId": .null,
            "relayUrl": .null, "relayIssuer": .null, "publishAgentActivity": .bool(true)]
        if supportsHold { fields["holdWebhooksWhileOffline"] = .bool(request.httpMethod == "POST") }
        return (try JSONEncoder.t3.encode(JSONValue.object(fields)),
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private struct CloudPreferenceAuthorizer: ManagedEnvironmentAuthorizing {
    func credentialRequiresRefresh(_ credential: EnvironmentCredential, environment: Environment) async throws -> Bool { false }
    func authorize(_ request: URLRequest, environment: Environment, credential: EnvironmentCredential) async throws -> URLRequest {
        var request = request
        request.setValue("DPoP \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("request-proof", forHTTPHeaderField: "DPoP")
        return request
    }
    func refreshCredential(for environment: Environment, replacing credential: EnvironmentCredential?) async throws -> EnvironmentCredential {
        throw HTTPError.unauthenticatedSession
    }
}
