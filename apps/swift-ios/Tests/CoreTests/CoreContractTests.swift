import XCTest
@testable import T3Code

@MainActor
final class CoreContractTests: XCTestCase {
    func testJSONValueRoundTripsLargeIntegersWithoutDoubleRounding() throws {
        let signedData = Data("9007199254740993".utf8)
        let signed = try JSONDecoder.t3.decode(JSONValue.self, from: signedData)
        XCTAssertEqual(signed, .integer(9_007_199_254_740_993))
        XCTAssertEqual(try JSONEncoder.t3.encode(signed), signedData)

        let unsignedData = Data("18446744073709551615".utf8)
        let unsigned = try JSONDecoder.t3.decode(JSONValue.self, from: unsignedData)
        XCTAssertEqual(unsigned, .unsignedInteger(UInt64.max))
        XCTAssertEqual(try JSONEncoder.t3.encode(unsigned), unsignedData)
    }

    func testDirectAndHostedPairingURLsResolveLikeExistingClients() throws {
        let direct = try PairingURL.resolve("https://studio.example/pair#token=secret")
        XCTAssertEqual(direct.credential, "secret")
        XCTAssertEqual(direct.httpBaseURL.absoluteString, "https://studio.example/")
        XCTAssertEqual(direct.webSocketBaseURL.absoluteString, "wss://studio.example/")

        let hosted = try PairingURL.resolve(
            "https://app.t3.codes/pair?host=https%3A%2F%2Fremote.example#token=hosted-secret"
        )
        XCTAssertEqual(hosted.credential, "hosted-secret")
        XCTAssertEqual(hosted.httpBaseURL.absoluteString, "https://remote.example/")
        XCTAssertEqual(hosted.webSocketBaseURL.absoluteString, "wss://remote.example/")
    }

    func testShellSnapshotDecodesCurrentWireShape() throws {
        let data = Data(
            """
            {
              "snapshotSequence": 7,
              "projects": [{
                "id": "project-1",
                "title": "T3 Code",
                "workspaceRoot": "/work/t3",
                "defaultModelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5.6-sol"
                },
                "scripts": [],
                "createdAt": "2026-07-30T12:00:00.000Z",
                "updatedAt": "2026-07-30T12:00:00.000Z"
              }],
              "threads": [],
              "updatedAt": "2026-07-30T12:00:00.000Z"
            }
            """.utf8
        )

        let snapshot = try JSONDecoder.t3.decode(OrchestrationShellSnapshot.self, from: data)
        XCTAssertEqual(snapshot.snapshotSequence, 7)
        XCTAssertEqual(snapshot.projects.first?.defaultModelSelection?.instanceId, "codex")
        XCTAssertNil(snapshot.projects.first?.deletedAt)
    }

    func testThreadPageMetadataDecodesCurrentWireShape() throws {
        let page = try JSONDecoder.t3.decode(
            OrchestrationThreadDetailPage.self,
            from: Data(
                #"{"beforeCursor":"opaque-cursor","hasMore":true,"snapshotSequence":42,"threadSequence":39}"#.utf8
            )
        )

        XCTAssertEqual(page.beforeCursor, "opaque-cursor")
        XCTAssertTrue(page.hasMore)
        XCTAssertEqual(page.snapshotSequence, 42)
        XCTAssertEqual(page.threadSequence, 39)
    }

    func testServerConfigAdvertisesThreadSnapshotPagination() throws {
        let config = try JSONDecoder.t3.decode(
            ServerConfigSnapshot.self,
            from: Data(#"{"providers":[],"threadSnapshotPagination":true}"#.utf8)
        )

        XCTAssertEqual(config.threadSnapshotPagination, true)
    }

    func testCommandBuildersMatchOrchestrationContract() throws {
        let model = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        let command = try OrchestrationCommands.createThread(
            threadID: "thread-1",
            projectID: "project-1",
            title: "Native rebuild",
            model: model,
            runtimeMode: .fullAccess,
            commandID: "command-1",
            createdAt: "2026-07-30T12:00:00.000Z"
        )

        XCTAssertEqual(command["type"]?.stringValue, "thread.create")
        XCTAssertEqual(command["threadId"]?.stringValue, "thread-1")
        XCTAssertEqual(command["modelSelection"]?["instanceId"]?.stringValue, "codex")
        XCTAssertEqual(command["runtimeMode"]?.stringValue, "full-access")

        let pin = OrchestrationCommands.pin(
            threadID: "thread-1",
            pinned: true,
            commandID: "command-pin"
        )
        XCTAssertEqual(pin["type"]?.stringValue, "thread.pin")
        XCTAssertEqual(pin["threadId"]?.stringValue, "thread-1")

        let unpin = OrchestrationCommands.pin(
            threadID: "thread-1",
            pinned: false,
            commandID: "command-unpin"
        )
        XCTAssertEqual(unpin["type"]?.stringValue, "thread.unpin")
    }

    func testFirstSendCommandCarriesCanonicalBootstrapMetadata() throws {
        let model = ModelSelection(instanceId: "codex", model: "gpt-5.4")
        let command = try OrchestrationCommands.createThreadAndSend(
            threadID: "thread-first-send",
            projectID: "project-1",
            title: "Build the native app",
            text: "Build the native app",
            model: model,
            runtimeMode: .fullAccess,
            commandID: "command-first-send",
            messageID: "message-first-send",
            createdAt: "2026-07-30T12:00:00.000Z"
        )

        XCTAssertEqual(command["type"]?.stringValue, "thread.turn.start")
        XCTAssertEqual(command["titleSeed"]?.stringValue, "Build the native app")
        XCTAssertEqual(command["modelSelection"]?["model"]?.stringValue, "gpt-5.4")
        XCTAssertEqual(
            command["bootstrap"]?["createThread"]?["projectId"]?.stringValue,
            "project-1"
        )
        XCTAssertEqual(
            command["bootstrap"]?["createThread"]?["modelSelection"]?["instanceId"]?.stringValue,
            "codex"
        )
    }

    func testFirstSendCanPrepareAWorktreeBeforeDispatchingTheTurn() throws {
        let command = try OrchestrationCommands.createThreadAndSend(
            threadID: "thread-worktree",
            projectID: "project-1",
            title: "Build in isolation",
            text: "Build in isolation",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            branch: "main",
            worktreePreparation: ThreadWorktreePreparation(
                projectCwd: "/work/t3",
                baseBranch: "main",
                branch: "t3code/deadbeef",
                startFromOrigin: true
            )
        )

        XCTAssertEqual(
            command["bootstrap"]?["prepareWorktree"]?["projectCwd"]?.stringValue,
            "/work/t3"
        )
        XCTAssertEqual(
            command["bootstrap"]?["prepareWorktree"]?["baseBranch"]?.stringValue,
            "main"
        )
        XCTAssertEqual(
            command["bootstrap"]?["prepareWorktree"]?["branch"]?.stringValue,
            "t3code/deadbeef"
        )
        XCTAssertEqual(
            command["bootstrap"]?["prepareWorktree"]?["startFromOrigin"],
            .bool(true)
        )
        XCTAssertEqual(command["bootstrap"]?["runSetupScript"], .bool(true))
    }

    func testEnvironmentStorePersistsSelectionAndClearsRemovedActiveEnvironment() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swift-core-\(UUID().uuidString)", isDirectory: true)
        let file = directory.appendingPathComponent("environments.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = EnvironmentStore(fileURL: file)
        let first = Environment(
            id: "one",
            label: "One",
            httpBaseURL: URL(string: "https://one.example")!,
            webSocketBaseURL: URL(string: "wss://one.example")!
        )
        let second = Environment(
            id: "two",
            label: "Two",
            httpBaseURL: URL(string: "https://two.example")!,
            webSocketBaseURL: URL(string: "wss://two.example")!
        )

        try await store.save([first, second])
        try await store.setActiveEnvironment(id: second.id)
        let selected = try await store.activeEnvironmentID()
        XCTAssertEqual(selected, second.id)

        let remaining = try await store.remove(id: second.id)
        let fallback = try await store.activeEnvironmentID()
        XCTAssertEqual(remaining.map(\.id), [first.id])
        XCTAssertEqual(fallback, first.id)
    }

    func testRuntimeReplacesCachedClientWhenSavedEndpointChanges() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swift-runtime-\(UUID().uuidString)", isDirectory: true)
        let file = directory.appendingPathComponent("environments.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = EnvironmentStore(fileURL: file)
        let first = Environment(
            id: "same-server",
            label: "Studio",
            httpBaseURL: URL(string: "http://192.168.1.10:3773")!,
            webSocketBaseURL: URL(string: "ws://192.168.1.10:3773")!
        )
        let moved = Environment(
            id: "same-server",
            label: "Studio",
            httpBaseURL: URL(string: "http://192.168.1.20:4773")!,
            webSocketBaseURL: URL(string: "ws://192.168.1.20:4773")!
        )
        try await store.save([first])
        try await store.setActiveEnvironment(id: first.id)
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore()
        )

        let firstClientValue = try await runtime.activeClient()
        let firstClient = try XCTUnwrap(firstClientValue)
        try await store.upsert(moved)
        let movedClientValue = try await runtime.activeClient()
        let movedClient = try XCTUnwrap(movedClientValue)
        let movedEnvironment = await movedClient.environment

        XCTAssertFalse(firstClient === movedClient)
        XCTAssertEqual(movedEnvironment.httpBaseURL, moved.httpBaseURL)
        XCTAssertEqual(movedEnvironment.webSocketBaseURL, moved.webSocketBaseURL)
    }

    func testRuntimeRemovesCatalogEntryBeforeDestroyingCredential() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swift-removal-\(UUID().uuidString)", isDirectory: true)
        let file = directory.appendingPathComponent("environments.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let environment = Environment(
            id: "removable",
            label: "Removable",
            httpBaseURL: URL(string: "https://remove.example")!,
            webSocketBaseURL: URL(string: "wss://remove.example")!
        )
        let store = EnvironmentStore(fileURL: file)
        try await store.save([environment])
        let credentials = RemovalOrderCredentialStore(
            environmentStore: store,
            environmentID: environment.id,
            credential: EnvironmentCredential(accessToken: "secret")
        )
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: credentials
        )

        try await runtime.remove(id: environment.id)

        let catalogContainedEnvironment = await credentials.catalogContainedEnvironmentOnRemoval
        XCTAssertEqual(catalogContainedEnvironment, false)
        let remaining = try await store.load()
        XCTAssertTrue(remaining.isEmpty)
        let credential = await credentials.credential(for: environment.id)
        XCTAssertNil(credential)
    }
}

private actor RemovalOrderCredentialStore: CredentialStore {
    let environmentStore: EnvironmentStore
    let environmentID: String
    var storedCredential: EnvironmentCredential?
    private(set) var catalogContainedEnvironmentOnRemoval: Bool?

    init(
        environmentStore: EnvironmentStore,
        environmentID: String,
        credential: EnvironmentCredential
    ) {
        self.environmentStore = environmentStore
        self.environmentID = environmentID
        storedCredential = credential
    }

    func credential(for environmentID: String) -> EnvironmentCredential? {
        environmentID == self.environmentID ? storedCredential : nil
    }

    func setCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) {
        guard environmentID == self.environmentID else { return }
        storedCredential = credential
    }

    func removeCredential(for environmentID: String) async throws {
        guard environmentID == self.environmentID else { return }
        catalogContainedEnvironmentOnRemoval = try await environmentStore.load()
            .contains(where: { $0.id == environmentID })
        storedCredential = nil
    }
}
