import Foundation
import XCTest
@testable import T3Code

@MainActor
final class CloudLinkRevocationTests: XCTestCase {
    func testRevocationOverridesStaleHostLinkAndTunnelFlags() throws {
        let state = try decodeState(linkRevoked: true)
        XCTAssertEqual(state.linkRevoked, true)
        XCTAssertTrue(state.linked)
        XCTAssertEqual(state.managedTunnelActive, true)
        XCTAssertFalse(state.isLinked)
        XCTAssertFalse(state.isManagedTunnelActive)
        XCTAssertTrue(state.publishAgentActivity)
        XCTAssertEqual(state.holdWebhooksWhileOffline, true)
    }

    func testMissingAndFalseRevocationRetainOlderHostBehavior() throws {
        for flag in [nil, false] as [Bool?] {
            let state = try decodeState(linkRevoked: flag)
            XCTAssertEqual(state.linkRevoked, flag)
            XCTAssertTrue(state.isLinked)
            XCTAssertTrue(state.isManagedTunnelActive)
        }
        let legacy = try JSONDecoder.t3.decode(EnvironmentCloudLinkState.self, from: Data("""
        {"linked":true,"publishAgentActivity":false}
        """.utf8))
        XCTAssertNil(legacy.linkRevoked)
        XCTAssertTrue(legacy.isLinked)
        XCTAssertTrue(legacy.isManagedTunnelActive)

        let publishOnly = EnvironmentCloudLinkState(
            linked: true, cloudUserId: nil, relayUrl: nil, relayIssuer: nil,
            managedTunnelActive: false, publishAgentActivity: true, holdWebhooksWhileOffline: false
        )
        XCTAssertTrue(publishOnly.isLinked)
        XCTAssertFalse(publishOnly.isManagedTunnelActive)
    }

    func testAuthenticatedHostReadRetainsIndependentMixedRouteCredentials() async throws {
        let paired = Environment(
            id: "host", label: "Host", httpBaseURL: URL(string: "https://paired.example")!,
            webSocketBaseURL: URL(string: "wss://paired.example/ws")!
        )
        let relay = EnvironmentRoute(
            id: "relay", httpBaseURL: URL(string: "https://relay.example")!,
            webSocketBaseURL: URL(string: "wss://relay.example/ws")!,
            kind: .managedDPoP, credentialOwnerID: "relay-key"
        )
        let mixed = paired.mergingRoute(relay, select: false)
        let credentials = InMemoryCredentialStore(credentials: [
            paired.credentialID: .init(accessToken: "paired-token"),
            relay.credentialOwnerID: .init(accessToken: "relay-token"),
        ])
        let transport = RevokedCloudLinkTransport()
        let api = EnvironmentAPI(transport: transport, credentials: credentials)

        let state = try await api.cloudLinkState(for: mixed)

        XCTAssertEqual(state.linkRevoked, true)
        XCTAssertFalse(state.isLinked)
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url?.host, "paired.example")
        XCTAssertEqual(request.url?.path, "/api/connect/link-state")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        let pairedCredential = try await credentials.credential(for: paired.credentialID)
        let relayCredential = try await credentials.credential(for: relay.credentialOwnerID)
        XCTAssertEqual(pairedCredential?.accessToken, "paired-token")
        XCTAssertEqual(relayCredential?.accessToken, "relay-token")
    }

    func testExecutionTimeRereadPreventsPostAfterRevocationOrUnlink() async throws {
        for latest in [(linked: true, revoked: true), (linked: false, revoked: false)] {
            let environment = Environment(
                id: "host", label: "Host", httpBaseURL: URL(string: "https://paired.example")!,
                webSocketBaseURL: URL(string: "wss://paired.example/ws")!
            )
            let transport = ChangingCloudLinkTransport(linked: latest.linked, revoked: latest.revoked)
            let client = T3Client(
                environment: environment,
                credentialStore: InMemoryCredentialStore(credentials: [
                    environment.credentialID: .init(accessToken: "paired-token"),
                ]),
                httpTransport: transport
            )
            let initial = try await client.cloudLinkState()
            XCTAssertTrue(initial.isLinked)
            XCTAssertEqual(initial.holdWebhooksWhileOffline, false)

            do {
                _ = try await client.setHoldWebhooksWhileOffline(true)
                XCTFail("A newly revoked or unlinked host accepted a webhook preference change")
            } catch EnvironmentCloudPreferencesError.notLinked { }

            let requests = await transport.requests
            XCTAssertEqual(requests.map(\.httpMethod), ["GET", "GET"])
            XCTAssertEqual(requests.map { $0.url?.path }, [
                "/api/connect/link-state", "/api/connect/link-state",
            ])
        }
    }

    private func decodeState(linkRevoked: Bool?) throws -> EnvironmentCloudLinkState {
        var fields: [String: JSONValue] = [
            "linked": .bool(true), "managedTunnelActive": .bool(true),
            "publishAgentActivity": .bool(true), "holdWebhooksWhileOffline": .bool(true),
        ]
        if let linkRevoked { fields["linkRevoked"] = .bool(linkRevoked) }
        return try JSONDecoder.t3.decode(
            EnvironmentCloudLinkState.self, from: JSONEncoder.t3.encode(JSONValue.object(fields))
        )
    }
}

private actor RevokedCloudLinkTransport: HTTPTransport {
    var requests: [URLRequest] = []

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let data = Data("""
        {"linked":true,"managedTunnelActive":true,"publishAgentActivity":true,"linkRevoked":true}
        """.utf8)
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private actor ChangingCloudLinkTransport: HTTPTransport {
    let linked: Bool
    let revoked: Bool
    var requests: [URLRequest] = []

    init(linked: Bool, revoked: Bool) {
        self.linked = linked
        self.revoked = revoked
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let initialRead = requests.isEmpty
        requests.append(request)
        let state = EnvironmentCloudLinkState(
            linked: initialRead || linked, cloudUserId: nil, relayUrl: nil, relayIssuer: nil,
            managedTunnelActive: true, publishAgentActivity: true, holdWebhooksWhileOffline: false,
            linkRevoked: initialRead ? false : revoked
        )
        return (try JSONEncoder.t3.encode(state),
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
