import Foundation
import Testing
@testable import T3Code

@Suite("Server browser stream access")
struct ServerBrowserAccessTests {
    @Test func retainsRelayOriginWithoutStoredCredentialsOrHostSelectors() throws {
        let access = try ServerBrowserAccess.ticketed(
            environmentURL: URL(string: "https://user:secret@relay.example:8443/old?token=secret#fragment")!,
            ticket: "short-lived & ticket"
        )
        #expect(access.httpBase == "https://relay.example:8443/api/preview-stream")
        #expect(access.wsBase == "wss://relay.example:8443/api/preview-stream")
        #expect(access.query == ["wsTicket": "short-lived & ticket"])
        #expect(!access.credentials)
    }

    @Test func managedRelayTicketsRefreshThroughDPoP() async throws {
        let environment = Environment(id: "one", label: "Relay", httpBaseURL: URL(string: "https://relay.example")!,
                                      webSocketBaseURL: URL(string: "wss://relay.example")!, kind: .managedDPoP)
        let credential = EnvironmentCredential.managedDPoP(
            accessToken: "old-token", expiresAt: .now.addingTimeInterval(3600), scopes: ["orchestration:read"],
            environmentID: "one", proofKeyThumbprint: "key"
        )
        let credentials = InMemoryCredentialStore(credentials: ["one": credential])
        let transport = BrowserTicketTransport(rejectFirst: true)
        let authorization = BrowserManagedAuthorization()
        let client = T3Client(environment: environment, credentialStore: credentials, httpTransport: transport,
                              managedAuthorization: authorization)
        let access = try await client.serverBrowserAccess()
        let requests = await transport.requests
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.url?.host == "relay.example" })
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "DPoP") == "bound-proof" })
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "DPoP refreshed-token")
        #expect(access.wsBase == "wss://relay.example/api/preview-stream")
        let json = String(decoding: try JSONEncoder().encode(access), as: UTF8.self)
        #expect(!json.contains("refreshed-token"))
        #expect(!json.contains("bound-proof"))
    }

    @Test func everyConnectionGetsAnEnvironmentAPITicket() async throws {
        let environment = Environment(id: "one", label: "One", httpBaseURL: URL(string: "http://host.example:3773")!,
                                      webSocketBaseURL: URL(string: "ws://host.example:3773")!, kind: .bearer)
        let credentials = InMemoryCredentialStore(credentials: ["one": EnvironmentCredential(accessToken: "private-bearer")])
        let transport = BrowserTicketTransport()
        let client = T3Client(environment: environment, credentialStore: credentials, httpTransport: transport)
        let first = try await client.serverBrowserAccess()
        let second = try await client.serverBrowserAccess()
        let requests = await transport.requests
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.url?.path == "/api/auth/websocket-ticket" && $0.httpMethod == "POST" })
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer private-bearer" })
        #expect(first.query["wsTicket"] != second.query["wsTicket"])
        #expect(second.wsBase == "ws://host.example:3773/api/preview-stream")
        #expect(!String(decoding: try JSONEncoder().encode(second), as: UTF8.self).contains("private-bearer"))
    }
}

private actor BrowserTicketTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let rejectFirst: Bool
    init(rejectFirst: Bool = false) { self.rejectFirst = rejectFirst }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let rejected = rejectFirst && requests.count == 1
        let body = rejected ? #"{"reason":"invalid_credential"}"# : "{\"ticket\":\"ticket-\(requests.count)\",\"expiresAt\":\"2026-10-07T12:05:00Z\"}"
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: rejected ? 401 : 200, httpVersion: nil, headerFields: nil)!)
    }
}

private actor BrowserManagedAuthorization: ManagedEnvironmentAuthorizing {
    func credentialRequiresRefresh(_ credential: EnvironmentCredential, environment: Environment) async throws -> Bool { false }
    func authorize(_ request: URLRequest, environment: Environment, credential: EnvironmentCredential) async throws -> URLRequest {
        var request = request
        request.setValue("DPoP \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("bound-proof", forHTTPHeaderField: "DPoP")
        return request
    }
    func refreshCredential(for environment: Environment, replacing credential: EnvironmentCredential?) async throws -> EnvironmentCredential {
        .managedDPoP(accessToken: "refreshed-token", expiresAt: .now.addingTimeInterval(3600),
                     scopes: ["orchestration:read"], environmentID: environment.id, proofKeyThumbprint: "key")
    }
}
