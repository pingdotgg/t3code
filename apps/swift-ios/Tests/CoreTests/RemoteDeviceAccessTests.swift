import Foundation
import Testing
@testable import T3Code

@Suite("Remote device authorization")
struct RemoteDeviceAccessTests {
    @Test func ticketKeepsEnvironmentOriginAndHostWithoutLeakingOldQuery() throws {
        let access = try RemoteDeviceHubAccess.ticketed(
            environmentURL: URL(string: "https://user:pass@relay.example:8443/old?token=long-lived#fragment")!,
            hubBasePath: "/api/device-hub/", hostID: "mac & phone", ticket: "short-lived & ticket"
        )
        #expect(access.httpBase == "https://relay.example:8443/api/device-hub")
        #expect(access.wsBase == "wss://relay.example:8443/api/device-hub")
        #expect(access.query == ["hostId": "mac & phone", "wsTicket": "short-lived & ticket"])
        #expect(!access.credentials)
    }

    @Test func refusesHubOriginReplacement() {
        for path in ["https://another.example/api/device-hub", "//another.example", "/api/device-hub?token=x"] {
            #expect(throws: RemoteDeviceError.self) {
                try RemoteDeviceHubAccess.ticketed(
                    environmentURL: URL(string: "https://relay.example")!,
                    hubBasePath: path, hostID: "local", ticket: "ticket"
                )
            }
        }
    }

    @Test func directAccessMintsFreshTicketsWithoutOpeningOrchestration() async throws {
        let environment = environment()
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: EnvironmentCredential(accessToken: "private-bearer"),
        ])
        let transport = RemoteDeviceTicketTransport()
        let client = T3Client(environment: environment, credentialStore: credentials, httpTransport: transport)
        let first = try await client.remoteDeviceHubAccess(hostID: "local", hubBasePath: "/api/device-hub")
        let second = try await client.remoteDeviceHubAccess(hostID: "ssh", hubBasePath: "/api/device-hub")
        let requests = await transport.requests
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.url?.path == "/api/auth/websocket-ticket" && $0.httpMethod == "POST" })
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer private-bearer" })
        #expect(first.query["wsTicket"] == "ticket-1")
        #expect(second.query["wsTicket"] == "ticket-2")
        #expect(second.query["hostId"] == "ssh")
        let webViewData = try JSONEncoder().encode(second)
        #expect(!String(decoding: webViewData, as: UTF8.self).contains("private-bearer"))
    }

    @Test func managedAccessUsesDPoPRefreshAndTheManagedOrigin() async throws {
        let environment = environment(kind: .managedDPoP)
        let credential = EnvironmentCredential.managedDPoP(
            accessToken: "old-managed-token", expiresAt: .now.addingTimeInterval(3600),
            scopes: ["orchestration:read", "orchestration:operate"],
            environmentID: environment.id, proofKeyThumbprint: "key"
        )
        let credentials = InMemoryCredentialStore(credentials: [environment.id: credential])
        let transport = RemoteDeviceTicketTransport(rejectFirst: true)
        let authorization = RemoteDeviceManagedAuthorization()
        let client = T3Client(environment: environment, credentialStore: credentials,
                              httpTransport: transport, managedAuthorization: authorization)
        let access = try await client.remoteDeviceHubAccess(hostID: "mac", hubBasePath: "/api/device-hub")
        let requests = await transport.requests
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.url?.host == "relay.example" })
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "DPoP") == "request-bound-proof" })
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == "DPoP old-managed-token")
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "DPoP fresh-managed-token")
        #expect(await authorization.refreshes == 1)
        #expect(access.query == ["hostId": "mac", "wsTicket": "ticket-2"])
        #expect(access.wsBase == "wss://relay.example/api/device-hub")
        let encoded = String(decoding: try JSONEncoder().encode(access), as: UTF8.self)
        #expect(!encoded.contains("managed-token"))
        #expect(!encoded.contains("request-bound-proof"))
    }

    private func environment(kind: EnvironmentKind = .bearer) -> Environment {
        Environment(id: "environment", label: "Studio", httpBaseURL: URL(string: "https://relay.example")!,
                    webSocketBaseURL: URL(string: "wss://relay.example")!, kind: kind)
    }
}

private actor RemoteDeviceTicketTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let rejectFirst: Bool

    init(rejectFirst: Bool = false) { self.rejectFirst = rejectFirst }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let reject = rejectFirst && requests.count == 1
        let body = reject ? #"{"reason":"invalid_credential"}"#
            : "{\"ticket\":\"ticket-\(requests.count)\",\"expiresAt\":\"2026-10-04T12:05:00.000Z\"}"
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: reject ? 401 : 200,
                                               httpVersion: nil, headerFields: nil)!)
    }
}

private actor RemoteDeviceManagedAuthorization: ManagedEnvironmentAuthorizing {
    var refreshes = 0

    func credentialRequiresRefresh(_ credential: EnvironmentCredential, environment: Environment) async throws -> Bool { false }

    func authorize(_ request: URLRequest, environment: Environment, credential: EnvironmentCredential) async throws -> URLRequest {
        var result = request
        result.setValue("DPoP \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        result.setValue("request-bound-proof", forHTTPHeaderField: "DPoP")
        return result
    }

    func refreshCredential(for environment: Environment, replacing credential: EnvironmentCredential?) async throws -> EnvironmentCredential {
        refreshes += 1
        return .managedDPoP(accessToken: "fresh-managed-token", expiresAt: .now.addingTimeInterval(3600),
                            scopes: ["orchestration:read", "orchestration:operate"],
                            environmentID: environment.id, proofKeyThumbprint: "key")
    }
}
