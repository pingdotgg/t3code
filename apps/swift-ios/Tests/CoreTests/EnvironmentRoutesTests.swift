import Foundation
import Testing
@testable import T3Code

@Suite("Environment routes")
@MainActor
struct EnvironmentRoutesTests {
    @Test func legacyCatalogRetainsCredentialAndPreferences() async throws {
        let folder = routeTestDirectory()
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("environments.json")
        let legacy = """
        {"version":1,"activeEnvironmentID":"one","environments":[{
          "id":"one","label":"My computer","httpBaseURL":"https://one.example/",
          "webSocketBaseURL":"wss://one.example/ws","kind":"bearer","isEnabled":false,
          "orchestrationProtocolPreference":"v2"
        }]}
        """
        try Data(legacy.utf8).write(to: url)
        let store = EnvironmentStore(fileURL: url)
        let credential = EnvironmentCredential(accessToken: "legacy-secret")
        let credentials = InMemoryCredentialStore(credentials: ["one": credential])
        let saved = try #require(try await store.load().first)
        #expect(saved.routes.count == 1)
        #expect(saved.credentialID == "one")
        #expect(!saved.isEnabled)
        #expect(saved.orchestrationProtocolPreference == .v2)
        #expect(saved.label == "My computer")
        #expect(try await credentials.credential(for: saved.credentialID) == credential)
        try await store.upsert(saved)
        let restarted = EnvironmentStore(fileURL: url)
        #expect(try await restarted.load() == [saved])
        #expect(try await restarted.activeEnvironmentID() == "one")
        let document = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        #expect(document["version"] == .number(2))
    }

    @Test func pairingSecondOriginPreservesBothCredentialOwnersAndLocalMetadata() async throws {
        let folder = routeTestDirectory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = EnvironmentStore(fileURL: folder.appendingPathComponent("environments.json"))
        let credentials = InMemoryCredentialStore()
        let transport = RouteTestHTTP()
        let pairing = PairingService(transport: transport, environmentStore: store, credentialStore: credentials)
        var first = try await pairing.pair(url: "https://first.example/#token=first")
        first.label = "Custom name"
        first.isEnabled = false
        first.orchestrationProtocolPreference = .v1
        try await store.upsert(first)
        let second = try await pairing.pair(url: "https://second.example/#token=second", expectedEnvironmentID: "one")
        #expect(second.routes.count == 2)
        #expect(second.routes.first == first.selectedRoute)
        #expect(second.credentialID != first.credentialID)
        #expect(second.label == "Custom name")
        #expect(!second.isEnabled)
        #expect(second.orchestrationProtocolPreference == .v1)
        #expect(try await credentials.credential(for: first.credentialID)?.accessToken == "first.example-token")
        #expect(try await credentials.credential(for: second.credentialID)?.accessToken == "second.example-token")
        let repaired = try await pairing.pair(url: "https://second.example/#token=again", expectedEnvironmentID: "one")
        #expect(repaired.routes.count == 2)
        #expect(repaired.credentialID == second.credentialID)
    }

    @Test func wrongEnvironmentDoesNotConsumePairingCode() async throws {
        let folder = routeTestDirectory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let transport = RouteTestHTTP(identities: ["wrong.example": "other"])
        let pairing = PairingService(transport: transport,
                                     environmentStore: EnvironmentStore(fileURL: folder.appendingPathComponent("env.json")),
                                     credentialStore: InMemoryCredentialStore())
        await #expect(throws: EnvironmentRouteError.identityMismatch) {
            try await pairing.pair(url: "https://wrong.example/#token=one-time", expectedEnvironmentID: "one")
        }
        #expect(await transport.requests.map { $0.url?.path } == ["/.well-known/t3/environment"])
    }

    @Test func discoveryPreservesOrderAndManualRoutesButPrunesStaleLearnedRoutes() throws {
        let manual = routeFixture()
        let first = manual.mergingDiscoveredEndpoints([
            .init(kind: .lan, httpBaseUrl: "http://192.168.1.2:3000/"),
            .init(kind: .tailnet, httpBaseUrl: "https://TAIL.example:443/"),
            .init(kind: .tailnet, httpBaseUrl: "https://tail.example"),
            .init(kind: .lan, httpBaseUrl: "http://127.0.0.1:3000/"),
            .init(kind: .lan, httpBaseUrl: "http://[::1]/"),
            .init(kind: .lan, httpBaseUrl: "http://localhost/"),
        ], credentialOwnerID: manual.credentialID)
        #expect(first.routes.count == 3)
        #expect(first.mergingDiscoveredEndpoints(nil, credentialOwnerID: manual.credentialID) == first)
        var reordered = first
        let tailnet = try #require(first.routes.first { $0.endpointKind == .tailnet })
        let lan = try #require(first.routes.first { $0.endpointKind == .lan })
        reordered.routes = [tailnet, manual.selectedRoute, lan]
        let second = reordered.mergingDiscoveredEndpoints([
            .init(kind: .tailnet, httpBaseUrl: "https://tail.example/"),
            .init(kind: .lan, httpBaseUrl: "http://192.168.1.3:3000/"),
        ], credentialOwnerID: manual.credentialID)
        #expect(second.routes.map(\.httpBaseURL.host) == ["192.168.1.3", "tail.example", "first.example"])
        #expect(second.routes[1].id == tailnet.id)
        let empty = second.mergingDiscoveredEndpoints([], credentialOwnerID: manual.credentialID)
        #expect(empty.routes == manual.routes)
        #expect(empty.id == manual.id)
    }

    @Test func removalDropsDependentsAndSignoutKeepsIndependentPairing() async throws {
        let folder = routeTestDirectory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let paired = routeFixture()
        let relay = EnvironmentRoute(id: "relay", httpBaseURL: URL(string: "https://relay.example/")!,
                                     webSocketBaseURL: URL(string: "wss://relay.example/ws")!,
                                     kind: .managedDPoP, credentialOwnerID: "cloud-key")
        let mixed = paired.mergingRoute(relay, select: true).mergingDiscoveredEndpoints([
            .init(kind: .lan, httpBaseUrl: "http://192.168.1.5/")
        ], credentialOwnerID: "cloud-key")
        #expect(try mixed.removingRoute(id: "relay") == paired)
        #expect(throws: EnvironmentRouteError.lastRoute) { try paired.removingRoute(id: paired.selectedRoute.id) }
        let store = EnvironmentStore(fileURL: folder.appendingPathComponent("env.json"))
        try await store.upsert(mixed)
        let credentials = InMemoryCredentialStore(credentials: [
            paired.credentialID: .init(accessToken: "independent"), "cloud-key": .init(accessToken: "cloud"),
        ])
        let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: credentials)
        #expect(try await runtime.removeManagedRoutes() == [paired])
        #expect(try await credentials.credential(for: paired.credentialID)?.accessToken == "independent")
        #expect(try await credentials.credential(for: "cloud-key") == nil)
    }

    @Test func identityMismatchAndTimeoutFallBackBeforeAuthentication() async throws {
        let transport = RouteTestHTTP(identities: ["wrong.example": "other"], failures: ["timeout.example"])
        let resolver = EnvironmentRouteResolver(transport: transport)
        let fixture = routeFixture(hosts: ["wrong.example", "timeout.example", "good.example"])
        let attempts = RouteAuthenticationAttempts()
        let resolved = try await resolver.connect(environment: fixture) { environment in
            await attempts.record(environment.selectedRoute.id)
            return environment.httpBaseURL.host!
        }
        #expect(resolved.connection == "good.example")
        #expect(resolved.environment.id == fixture.id)
        #expect(resolved.environment.httpBaseURL.host == "good.example")
        #expect(resolved.environment.webSocketBaseURL.host == "good.example")
        #expect(await attempts.ids == [fixture.routes[2].id])
        #expect(await transport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil })
    }

    @Test func promotionRetainsFallbackOnAuthFailureAndRespectsCooldown() async throws {
        let resolver = EnvironmentRouteResolver(transport: RouteTestHTTP())
        let fixture = routeFixture(hosts: ["first.example", "fallback.example"])
        let fallback = fixture.selectingRoute(fixture.routes[1])
        let attempts = RouteAuthenticationAttempts()
        let start = Date(timeIntervalSince1970: 1_000)
        let rejected: ResolvedEnvironmentRoute<String>? = try await resolver.promote(environment: fallback, now: start) { environment in
            await attempts.record(environment.selectedRoute.id)
            throw HTTPError.status(403, message: "Not permitted", traceID: nil)
        }
        #expect(rejected == nil)
        let cooling = try await resolver.promote(environment: fallback, now: start.addingTimeInterval(61), forceCheck: true) { environment in
            await attempts.record(environment.selectedRoute.id)
            return environment.id
        }
        #expect(cooling == nil)
        #expect(await attempts.ids.count == 1)
        let promoted = try await resolver.promote(environment: fallback, now: start.addingTimeInterval(301)) { $0.id }
        #expect(promoted?.environment.activeRouteID == fixture.routes[0].id)
        #expect(fallback.activeRouteID == fixture.routes[1].id)
    }

    @Test func wrappedNetworkFailureOutranksBlockedRoute() async throws {
        let resolver = EnvironmentRouteResolver(transport: RouteTestHTTP())
        let environment = routeFixture(hosts: ["first.example", "second.example"])
        do {
            let _: ResolvedEnvironmentRoute<String> = try await resolver.connect(environment: environment) { candidate in
                if candidate.httpBaseURL.host == "first.example" { throw HTTPError.missingCredential }
                throw T3ConnectNetworkError(message: "Offline")
            }
            Issue.record("Expected failure")
        } catch { #expect(error is T3ConnectNetworkError) }
    }

    @Test func passiveFallbackUsesSelectedHTTPAndDoesNotOpenSocket() async throws {
        let folder = routeTestDirectory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let fixture = routeFixture(hosts: ["timeout.example", "good.example"])
        let store = EnvironmentStore(fileURL: folder.appendingPathComponent("env.json"))
        try await store.upsert(fixture)
        let credentials = InMemoryCredentialStore(credentials: ["key-0": .init(accessToken: "bad"), "key-1": .init(accessToken: "good")])
        let http = RouteTestHTTP(failures: ["timeout.example"])
        let socket = RouteUnusedSocketConnector()
        let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: credentials, httpTransport: http, webSocketConnector: socket)
        let resolved = try await runtime.resolveClient(for: fixture, connectSocket: false)
        let selectedEnvironment = await resolved.environment
        #expect(selectedEnvironment.httpBaseURL.host == "good.example")
        #expect(selectedEnvironment.credentialID == "key-1")
        #expect(await socket.attempts == 0)
        #expect(try await runtime.selectedEnvironment(id: fixture.id)?.activeRouteID == fixture.routes[1].id)
        let sessionRequest = await http.requests.first { $0.url?.path == "/api/auth/session" }
        #expect(sessionRequest?.url?.host == "good.example")
        #expect(sessionRequest?.value(forHTTPHeaderField: "Authorization") == "Bearer good")
    }
}

func routeTestDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("t3-routes-\(UUID().uuidString)", isDirectory: true)
}

func routeDescriptor(_ id: String = "one") throws -> EnvironmentDescriptor {
    try JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: Data("""
    {"environmentId":"\(id)","label":"Computer","platform":{"os":"darwin","arch":"arm64"},
     "serverVersion":"1.0.0","capabilities":{"repositoryIdentity":true}}
    """.utf8))
}

func routeFixture(hosts: [String] = ["first.example"]) -> Environment {
    let routes = hosts.enumerated().map { index, host in
        EnvironmentRoute(id: "route-\(index)", httpBaseURL: URL(string: "https://\(host)/")!,
                         webSocketBaseURL: URL(string: "wss://\(host)/ws")!, kind: .bearer, credentialOwnerID: "key-\(index)")
    }
    return Environment(id: "one", label: "Computer", httpBaseURL: routes[0].httpBaseURL,
                       webSocketBaseURL: routes[0].webSocketBaseURL, descriptor: try! routeDescriptor(), routes: routes)
}

private actor RouteAuthenticationAttempts {
    var ids: [String] = []
    func record(_ id: String) { ids.append(id) }
}

actor RouteTestHTTP: HTTPTransport {
    var requests: [URLRequest] = []
    let identities: [String: String]
    let failures: Set<String>
    init(identities: [String: String] = [:], failures: Set<String> = []) {
        self.identities = identities
        self.failures = failures
    }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let url = request.url!
        if failures.contains(url.host ?? "") { throw URLError(.timedOut) }
        let body: Data
        switch url.path {
        case "/.well-known/t3/environment": body = try JSONEncoder.t3.encode(routeDescriptor(identities[url.host ?? ""] ?? "one"))
        case "/oauth/token": body = Data("""
            {"access_token":"\(url.host!)-token","issued_token_type":"urn:ietf:params:oauth:token-type:access_token",
             "token_type":"Bearer","expires_in":3600,"scope":"orchestration:read"}
            """.utf8)
        case "/api/auth/session": body = Data("{\"authenticated\":true,\"permissions\":[\"orchestration:read\"]}".utf8)
        default: throw RPCError.remote("Unexpected route test request")
        }
        return (body, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private actor RouteUnusedSocketConnector: WebSocketConnecting {
    var attempts = 0
    func connect(to url: URL) async throws -> any WebSocketConnection {
        attempts += 1
        throw RPCError.connectionUnavailable
    }
}
