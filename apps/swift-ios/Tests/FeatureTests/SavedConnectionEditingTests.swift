import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Saved connection editing")
struct SavedConnectionEditingTests {
    @Test(arguments: [OrchestrationProtocolPreference.v1, .v2])
    func renameWhileOfflineKeepsTheCachedClientAndStoredConnection(
        preference: OrchestrationProtocolPreference
    ) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        var original = environment()
        original.orchestrationProtocolPreference = preference
        original.descriptor = try JSONDecoder.t3.decode(
            EnvironmentDescriptor.self, from: ConnectionEditTransport.descriptor(original.id)
        )
        try await store.save([original])
        try await store.setActiveEnvironment(id: original.id)
        let transport = ConnectionEditTransport(environmentID: original.id, offline: true)
        let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: InMemoryCredentialStore(),
                                         httpTransport: transport)
        let existing = await runtime.client(for: original)
        let client = NativeFeatureClient(runtime: runtime)

        let result = try await client.editSavedConnection(
            environmentID: original.id, label: "  Offline studio  ", endpoint: "wss://OLD.example:443/"
        )

        #expect(result == .updatedLabel)
        var expected = original
        expected.label = "Offline studio"
        let updated = try #require(try await store.load().first)
        #expect(updated == expected)
        #expect(try await runtime.activeClient() === existing)
        #expect(await runtime.client(for: updated) === existing)
        #expect(await transport.requests.isEmpty)
        #expect(try await store.activeEnvironmentID() == original.id)
    }

    @Test
    func renamePublishesTheSavedLabelWithoutReloadingAnOfflineComputer() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        var original = environment()
        original.isEnabled = false
        try await store.save([original])
        let transport = ConnectionEditTransport(environmentID: original.id, offline: true)
        let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: InMemoryCredentialStore(),
                                         httpTransport: transport)
        let client = NativeFeatureClient(runtime: runtime)
        _ = try await client.initialSnapshot()
        var events = client.events().makeAsyncIterator()

        try await client.editSavedConnection(environmentID: original.id, label: "Office", endpoint: "https://old.example")

        let event = try #require(await events.next())
        guard case let .snapshot(snapshot) = event else {
            Issue.record("Expected the renamed catalog snapshot")
            return
        }
        #expect(snapshot.environments.first?.name == "Office")
        #expect(snapshot.environments.first?.isEnabled == false)
        #expect(await transport.requests.isEmpty)
    }

    @Test
    func editNormalizesEndpointAndKeepsIdentityCredentialAndPreferences() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        var original = environment()
        original.isEnabled = false
        original.orchestrationProtocolPreference = .v1
        try await store.save([original])
        try await store.setActiveEnvironment(id: original.id)
        let credential = EnvironmentCredential(accessToken: "saved-secret")
        let credentials = InMemoryCredentialStore(credentials: [original.id: credential])
        let transport = ConnectionEditTransport(environmentID: original.id)
        let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: credentials,
                                         httpTransport: transport)
        let client = NativeFeatureClient(runtime: runtime)

        let result = try await client.editSavedConnection(environmentID: original.id, label: "  Studio  ",
                                                         endpoint: "wss://new.example:8443/ignored?token=ignored")
        #expect(result == .updatedEndpoint)
        let updated = try #require(try await store.load().first)
        #expect(updated.id == original.id)
        #expect(updated.label == "Studio")
        #expect(updated.httpBaseURL.absoluteString == "https://new.example:8443/")
        #expect(updated.webSocketBaseURL.absoluteString == "wss://new.example:8443/")
        #expect(!updated.isEnabled)
        #expect(updated.orchestrationProtocolPreference == .v1)
        #expect(try await store.activeEnvironmentID() == original.id)
        #expect(await credentials.credential(for: original.id) == credential)
        let requests = await transport.requests
        #expect(requests.count == 1)
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil)
        #expect(requests[0].url?.path == "/.well-known/t3/environment")
    }

    @Test
    func differentEnvironmentCannotReplaceTheSavedConnection() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let original = environment()
        try await store.save([original])
        let credentials = InMemoryCredentialStore(credentials: [original.id: .init(accessToken: "saved-secret")])
        let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: credentials,
                                         httpTransport: ConnectionEditTransport(environmentID: "other"))
        let client = NativeFeatureClient(runtime: runtime)
        await #expect(throws: SavedConnectionEditError.identityMismatch) {
            try await client.editSavedConnection(environmentID: original.id, label: "Changed",
                                                 endpoint: "https://other.example")
        }
        #expect(try await store.load() == [original])
        #expect(await credentials.credential(for: original.id)?.accessToken == "saved-secret")
    }

    @Test
    func savePreservesConcurrentPreferencesButCannotResurrectRemovedConnection() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let original = environment()
        try await store.save([original])
        try await store.setEnabled(id: original.id, enabled: false)
        try await store.setOrchestrationProtocolPreference(id: original.id, preference: .v2)
        let descriptor = try JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: ConnectionEditTransport.descriptor(original.id))
        let updated = try await store.editSavedConnection(
            expected: original, label: "Renamed", httpBaseURL: original.httpBaseURL,
            webSocketBaseURL: original.webSocketBaseURL, descriptor: descriptor
        )
        #expect(!updated.isEnabled)
        #expect(updated.orchestrationProtocolPreference == .v2)
        try await store.remove(id: original.id)
        await #expect(throws: SavedConnectionEditError.changedConnection) {
            try await store.editSavedConnection(expected: updated, label: "Returned", httpBaseURL: updated.httpBaseURL,
                                                 webSocketBaseURL: updated.webSocketBaseURL, descriptor: descriptor)
        }
        #expect(try await store.load().isEmpty)
    }

    @Test
    func renameKeepsConcurrentPreferencesAndRejectsChangedOrRemovedConnections() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let original = environment()
        try await store.save([original])
        try await store.setEnabled(id: original.id, enabled: false)
        try await store.setOrchestrationProtocolPreference(id: original.id, preference: .v2)
        let renamed = try await store.renameSavedConnection(expected: original, label: "First edit")
        #expect(!renamed.isEnabled)
        #expect(renamed.orchestrationProtocolPreference == .v2)
        await #expect(throws: SavedConnectionEditError.changedConnection) {
            try await store.renameSavedConnection(expected: original, label: "Stale edit")
        }
        var moved = renamed
        moved.webSocketBaseURL = URL(string: "wss://changed.example")!
        try await store.upsert(moved)
        await #expect(throws: SavedConnectionEditError.changedConnection) {
            try await store.renameSavedConnection(expected: renamed, label: "Stale endpoint")
        }
        #expect(try await store.load() == [moved])
        try await store.remove(id: original.id)
        await #expect(throws: SavedConnectionEditError.changedConnection) {
            try await store.renameSavedConnection(expected: moved, label: "Removed")
        }
        #expect(try await store.load().isEmpty)
    }

    @Test
    func endpointComparisonPreservesProtocolAndSocketChanges() {
        let original = environment()
        #expect(original.hasSameConnectionEndpoint(
            httpBaseURL: URL(string: "https://OLD.example:443/")!,
            webSocketBaseURL: URL(string: "wss://old.example/")!
        ))
        #expect(!original.hasSameConnectionEndpoint(
            httpBaseURL: original.httpBaseURL, webSocketBaseURL: URL(string: "ws://old.example")!
        ))
        #expect(!original.hasSameConnectionEndpoint(
            httpBaseURL: URL(string: "http://old.example")!, webSocketBaseURL: original.webSocketBaseURL
        ))
        #expect(!original.hasSameConnectionEndpoint(
            httpBaseURL: original.httpBaseURL, webSocketBaseURL: URL(string: "wss://old.example:8443/")!
        ))
    }

    private func environment() -> Environment {
        Environment(id: "env", label: "Old", httpBaseURL: URL(string: "https://old.example")!,
                    webSocketBaseURL: URL(string: "wss://old.example")!)
    }
}

private actor ConnectionEditTransport: HTTPTransport {
    let environmentID: String
    let offline: Bool
    private(set) var requests: [URLRequest] = []
    init(environmentID: String, offline: Bool = false) {
        self.environmentID = environmentID
        self.offline = offline
    }

    static func descriptor(_ id: String) -> Data {
        Data("""
        {"environmentId":"\(id)","label":"Server","platform":{"os":"darwin","arch":"arm64"},
         "serverVersion":"1.0","capabilities":{"repositoryIdentity":true}}
        """.utf8)
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if offline { throw URLError(.notConnectedToInternet) }
        guard request.url?.path == "/.well-known/t3/environment" else { throw HTTPError.invalidResponse }
        return (Self.descriptor(environmentID), HTTPURLResponse(url: request.url!, statusCode: 200,
                                                               httpVersion: nil, headerFields: nil)!)
    }
}
