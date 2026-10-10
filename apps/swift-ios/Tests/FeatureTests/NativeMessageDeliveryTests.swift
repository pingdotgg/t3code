import Foundation
import Testing
import XCTest
@testable import T3Code

@MainActor
@Suite("Native follow-up delivery")
struct NativeMessageDeliveryTests {
    @Test
    func visitCommandPreservesTheExactFractionalShellWatermark() async throws {
        let rawTimestamp = "2026-10-04T12:00:00.123Z"
        let snapshot = try V2Fixture.load("v2-shell-snapshot")
        let shells = try #require(snapshot["threads"]?.v2Array)
        let shell = V2Fixture.patch(try #require(shells.first), [
            "updatedAt": .string(rawTimestamp), "status": .string("completed"),
            "lastVisitedAt": .string("2026-10-04T12:00:00.122Z"),
            "latestRunCompletedAt": .string(rawTimestamp),
        ])
        let fixture = try await DeliveryFixture.make(
            shellSnapshot: V2Fixture.patch(snapshot, ["threads": .array([shell])])
        )
        defer { fixture.removeFiles() }
        do {
            let initial = try await fixture.client.initialSnapshot()
            var thread = try #require(initial.threads.first)
            #expect(thread.rawUpdatedAt == rawTimestamp)
            #expect(thread.hasUnseenCompletion)
            await FeatureThreadVisitCoordinator().visit(.init(thread: thread), using: fixture.client)
            let commands = await fixture.connection.commands
            let visit = try #require(commands.first { $0["type"] == .string("thread.visit") })
            #expect(visit["threadId"] == shell["id"])
            #expect(visit["visitedAt"] == .string(rawTimestamp))
            thread.inboxFacts?.lastVisitedAt = visit["visitedAt"]?.stringValue
            #expect(!thread.hasUnseenCompletion)
            #expect(FeatureThreadVisitTracker().nextVisit(for: .init(thread: thread), at: .now) == nil)
            await fixture.client.disconnect()
        } catch {
            await fixture.client.disconnect()
            throw error
        }
    }

    @Test
    func serverResolvedFollowUpKeepsTheExistingPermissionMode() async throws {
        let fixture = try await DeliveryFixture.make(serverResolvedCommandContext: true)
        defer { fixture.removeFiles() }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try #require(initial.threads.first)
        try await fixture.client.sendMessage(
            threadID: thread.id, text: "Keep this session", selection: nil,
            runtimeMode: .approvalRequired, attachments: [],
            identity: .init(threadID: "thread-v2"), delivery: .queue
        )
        let commands = await fixture.connection.commands
        #expect(commands.map { $0["type"] } == [.string("message.dispatch")])
        await fixture.client.disconnect()
    }

    @Test(arguments: [false, true])
    func explicitInteractionModeReachesV2ThroughTheFeatureClient(serverResolved: Bool) async throws {
        let fixture = try await DeliveryFixture.make(serverResolvedCommandContext: serverResolved)
        defer { fixture.removeFiles() }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try #require(initial.threads.first)
        let client: any FeatureClient = fixture.client
        let identity = FeatureSubmissionIdentity(threadID: "thread-v2")
        try await client.sendMessage(
            threadID: thread.id, text: "Plan the change", selection: nil,
            runtimeMode: .approvalRequired, interactionMode: .plan,
            attachments: [], identity: identity, context: nil, delivery: .queue
        )
        let commands = await fixture.connection.commands
        let modeCommand = try #require(commands.first { $0["type"] == .string("thread.interaction-mode.set") })
        #expect(modeCommand["interactionMode"] == .string("plan"))
        #expect(modeCommand["commandId"] == .string("\(identity.commandID):interaction-mode"))
        #expect(commands.last?["type"] == .string("message.dispatch"))
        await fixture.client.disconnect()
    }

    @Test
    func failedToolUpdateKeepsItsFailureAndClearsActiveWork() async throws {
        var snapshot = try V2Fixture.load("v2-thread-bounded-snapshot").v2Object
        var projection = try #require(snapshot["projection"]).v2Object
        let original = try #require(projection["turnItems"]?.v2Array?.first { $0["type"] == .string("command_execution") })
        let earlier = V2Fixture.patch(original, [
            "id": .string("earlier-tool"), "ordinal": .number(1), "status": .string("completed"),
            "output": .string("Earlier command finished"), "startedAt": .string("2026-08-07T12:00:00.000Z"),
        ])
        let running = V2Fixture.patch(original, [
            "ordinal": .number(2), "status": .string("running"), "completedAt": .null,
            "output": .string(""), "exitCode": .null,
            "startedAt": .string("2026-08-07T12:00:01.000Z"),
            "updatedAt": .string("2026-08-07T12:00:01.000Z"),
        ])
        let row = try #require(projection["visibleTurnItems"]?.v2Array?.first { $0["sourceItemId"] == original["id"] })
        projection["turnItems"] = .array([earlier, running])
        projection["visibleTurnItems"] = .array([
            V2Fixture.patch(row, ["position": .number(0), "sourceItemId": .string("earlier-tool"), "item": earlier]),
            V2Fixture.patch(row, ["position": .number(1), "item": running]),
        ])
        projection["runtimeRequests"] = .array([])
        projection["plans"] = .array([])
        snapshot["projection"] = .object(projection)
        let fixture = try await DeliveryFixture.make(snapshot: .object(snapshot))
        defer { fixture.removeFiles() }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try #require(initial.threads.first)
        var events = fixture.client.events().makeAsyncIterator()
        let before = try await fixture.client.loadThread(id: thread.id, fresh: true)
        #expect(before.messages.count == 1)
        #expect(before.messages.first?.activeWorkLabel == "Read contracts")
        _ = try await fixture.nextSynchronizedDetail(&events, threadID: thread.id)
        let failed = V2Fixture.patch(running, [
            "status": .string("failed"), "output": .string("native tool failed"), "exitCode": .number(1),
            "updatedAt": .string("2026-08-07T12:01:00.000Z"), "completedAt": .string("2026-08-07T12:01:00.000Z"),
        ])
        try await fixture.connection.publishThreadEvents([.object([
            "kind": .string("event"), "sequence": .number(101),
            "event": .object(["id": .string("native-tool-failed"), "threadId": .string("thread-v2"),
                              "occurredAt": .string("2026-08-07T12:01:00.000Z"), "type": .string("turn-item.updated"), "payload": failed]),
        ])])
        let update = try await fixture.nextSynchronizedDetail(&events, threadID: thread.id)
        await fixture.client.disconnect()

        // A failure splits the adjacent work group, requiring a full detail update.
        #expect(update.delta == nil)
        #expect(update.detail.messages.count == 2)
        #expect(update.detail.messages.allSatisfy { $0.activeWorkLabel == nil })
        let work = update.detail.messages.flatMap { $0.v2WorkItems ?? [] }
        #expect(work.map(\.source.itemID) == ["earlier-tool", "item-v2-tool"])
        let earlierWork = try #require(work.first)
        let failedWork = try #require(work.last)
        #expect(failedWork.source.status == "failed")
        #expect(FeatureV2ItemDetail.indicatesFailure(failedWork.raw))
        #expect(FeatureV2ItemDetail.output(failedWork.raw) == "native tool failed")
        #expect(FeatureV2ItemDetail.output(earlierWork.raw) == "Earlier command finished")
    }

    @Test
    func answeredQuestionSnapshotIncludesItsAnswerAndImage() async throws {
        var snapshot = try V2Fixture.load("v2-thread-bounded-snapshot").v2Object
        var projection = try #require(snapshot["projection"]).v2Object
        let answer: JSONValue = .object([
            "requestId": .string("request-v2-input"),
            "answers": .object(["scope": .string("Native answer")]),
            "questionTextById": .object(["scope": .string("Which scope?")]),
            "attachmentsByQuestionId": .object(["scope": .array([.object([
                "type": .string("image"), "id": .string("answer-image"), "name": .string("answer.png"),
                "mimeType": .string("image/png"), "sizeBytes": .number(2),
            ])])]),
        ])
        let items = try #require(projection["turnItems"]?.v2Array).map { item in
            item["type"] == .string("user_input_request")
                ? V2Fixture.patch(item, ["status": .string("completed"), "questionAnswer": answer]) : item
        }
        projection["turnItems"] = .array(items)
        projection["visibleTurnItems"] = .array(try #require(projection["visibleTurnItems"]?.v2Array).map { row in
            guard let item = items.first(where: { $0["id"] == row["sourceItemId"] }) else { return row }
            return V2Fixture.patch(row, ["item": item])
        })
        projection["runtimeRequests"] = .array(try #require(projection["runtimeRequests"]?.v2Array).map { request in
            request["kind"] == .string("user_input")
                ? V2Fixture.patch(request, ["status": .string("resolved"), "answers": answer["answers"]!]) : request
        })
        snapshot["projection"] = .object(projection)
        let fixture = try await DeliveryFixture.make(snapshot: .object(snapshot))
        defer { fixture.removeFiles() }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try #require(initial.threads.first)
        let detail = try await fixture.client.loadThread(id: thread.id, fresh: true)
        await fixture.client.disconnect()

        // RN keeps answers and their attachments in the question's expanded history.
        let question = try #require(detail.messages.flatMap { $0.v2WorkItems ?? [] }
            .first { $0.source.itemID == "item-v2-input" })
        #expect(question.raw["questionAnswer"] == answer)
        #expect(detail.userInputs.isEmpty)
        let rendered = FeatureV2ItemDetail.answers(question.raw, source: question.source)
        #expect(rendered.map(\.text) == ["Which scope?\n\nNative answer"])
        #expect(rendered.flatMap(\.attachments).map(\.id) == ["answer-image"])
    }

    @Test
    func liveToolCompletionReplacesTheNativeWorkLogRecord() async throws {
        var snapshot = try V2Fixture.load("v2-thread-bounded-snapshot").v2Object
        var projection = try #require(snapshot["projection"]).v2Object
        let original = try #require(projection["turnItems"]?.v2Array?.first { $0["type"] == .string("command_execution") })
        let running = V2Fixture.patch(original, [
            "status": .string("running"), "completedAt": .null, "output": .string(""), "exitCode": .null,
        ])
        projection["turnItems"] = .array(try #require(projection["turnItems"]?.v2Array).map {
            $0["id"] == running["id"] ? running : $0
        })
        projection["visibleTurnItems"] = .array(try #require(projection["visibleTurnItems"]?.v2Array).map {
            $0["sourceItemId"] == running["id"] ? V2Fixture.patch($0, ["item": running]) : $0
        })
        snapshot["projection"] = .object(projection)
        let fixture = try await DeliveryFixture.make(snapshot: .object(snapshot))
        defer { fixture.removeFiles() }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try #require(initial.threads.first)
        var events = fixture.client.events().makeAsyncIterator()
        let before = try await fixture.client.loadThread(id: thread.id, fresh: true)
        let originalWork = try #require(before.messages.first { $0.v2WorkItems?.contains { $0.source.itemID == "item-v2-tool" } == true })
        #expect(originalWork.activeWorkLabel == "Read contracts")
        _ = try await fixture.nextSynchronizedDetail(&events, threadID: thread.id)
        let finished = V2Fixture.patch(running, [
            "status": .string("completed"), "output": .string("native tool finished"), "exitCode": .number(0),
            "updatedAt": .string("2026-08-07T12:01:00.000Z"), "completedAt": .string("2026-08-07T12:01:00.000Z"),
        ])
        let event: JSONValue = .object([
            "kind": .string("event"), "sequence": .number(101),
            "event": .object(["id": .string("native-tool-done"), "threadId": .string("thread-v2"),
                              "occurredAt": .string("2026-08-07T12:01:00.000Z"), "type": .string("turn-item.updated"), "payload": finished]),
        ])
        try await fixture.connection.publishThreadEvents([event])
        let update = try await fixture.nextSynchronizedDetail(&events, threadID: thread.id)
        await fixture.client.disconnect()

        let work = try #require(update.detail.messages.first { $0.id == originalWork.id })
        #expect(work.activeWorkLabel == nil)
        #expect(work.v2WorkItems?.map(\.source.itemID) == ["item-v2-reasoning", "item-v2-tool"])
        let completed = try #require(work.v2WorkItems?.last)
        #expect(completed.source.status == "completed")
        #expect(FeatureV2ItemDetail.output(completed.raw) == "native tool finished")
        #expect(!FeatureV2ItemDetail.indicatesFailure(completed.raw))
        #expect(update.detail.messages.map(\.id) == before.messages.map(\.id))
        let delta = try #require(update.delta)
        #expect(delta.changedMessages == [work])
        #expect(delta.appendedMessageIDs.isEmpty)
    }

    @Test(arguments: FeatureMessageDelivery.allCases)
    func explicitDeliveryReachesV2Dispatch(_ delivery: FeatureMessageDelivery) async throws {
        let fixture = try await DeliveryFixture.make()
        defer { fixture.removeFiles() }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try #require(initial.threads.first)
        let identity = FeatureSubmissionIdentity(threadID: "thread-v2")

        try await fixture.client.sendMessage(
            threadID: thread.id, text: "Follow up", selection: nil, runtimeMode: .approvalRequired,
            attachments: [], identity: identity, delivery: delivery
        )

        let commands = await fixture.connection.commands
        let command = try #require(commands.last { $0["type"] == .string("message.dispatch") })
        let expectedMode = switch delivery {
        case .auto, .steer: "steer_active"
        case .queue: "queue_after_active"
        case .restart: "restart_active"
        }
        #expect(command["dispatchMode"]?["type"] == .string(expectedMode))
        #expect(command["dispatchMode"]?["targetRunId"] == (delivery == .queue ? nil : .string("run-v2-active")))
        #expect(command["messageId"] == .string(identity.messageID))
        #expect(command["commandId"] == .string(identity.commandID))
        await fixture.client.disconnect()
    }

    @Test(arguments: [false, true])
    func lostReplyOnlyRecoversAnAuthoritativeQueuedMessage(committed: Bool) async throws {
        let fixture = try await DeliveryFixture.make(failDispatch: true)
        defer { fixture.removeFiles() }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try #require(initial.threads.first)
        let identity = FeatureSubmissionIdentity(
            threadID: "thread-v2", messageID: committed ? "message-v2-queued" : "uncommitted-message"
        )
        do {
            try await fixture.client.sendMessage(
                threadID: thread.id, text: "Follow up", selection: nil, runtimeMode: .approvalRequired,
                attachments: [], identity: identity, delivery: .queue
            )
            #expect(committed, "A failed dispatch without a matching server message must remain pending")
        } catch {
            #expect(!committed, "An accepted V2 queue message must recover a lost reply: \(error)")
        }
        let commands = await fixture.connection.commands.filter { $0["type"] == .string("message.dispatch") }
        #expect(commands.count == 1)
        #expect(commands.first?["messageId"] == .string(identity.messageID))
        let detail = try await fixture.client.loadThread(id: thread.id, fresh: true)
        #expect(!detail.messages.contains { $0.id == "message-v2-queued" })
        #expect(detail.execution?.queuedEntries.contains { $0.messageID == "message-v2-queued" } == true)
        await fixture.client.disconnect()
    }

    @Test
    func v1SendKeepsItsOriginalWireCommand() async throws {
        let fixture = try await DeliveryFixture.make(version: 1)
        defer { fixture.removeFiles() }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try #require(initial.threads.first)
        let identity = FeatureSubmissionIdentity(threadID: "thread-fixture", createdAt: Date(timeIntervalSince1970: 42))
        try await fixture.client.sendMessage(
            threadID: thread.id, text: "Legacy follow up", selection: nil, runtimeMode: .fullAccess,
            attachments: [], identity: identity
        )
        let command = try #require(await fixture.connection.commands.last)
        let expected = try OrchestrationCommands.sendTurn(
            threadID: identity.threadID, text: "Legacy follow up", runtimeMode: .fullAccess,
            commandID: identity.commandID, messageID: identity.messageID,
            createdAt: "1970-01-01T00:00:42.000Z"
        )
        #expect(command == expected)
        #expect(command["dispatchMode"] == nil)
        await fixture.client.disconnect()
    }
}

@MainActor
private struct DeliveryFixture {
    let client: NativeFeatureClient
    let connection: DeliveryWebSocketConnection
    let directory: URL
    let defaults: UserDefaults
    let defaultsSuite: String

    static func make(version: Int = 2, failDispatch: Bool = false, snapshot: JSONValue? = nil,
                     shellSnapshot: JSONValue? = nil,
                     serverResolvedCommandContext: Bool = false) async throws -> Self {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let environment = Environment(
            id: "delivery", label: "Delivery", httpBaseURL: URL(string: "https://delivery.example")!,
            webSocketBaseURL: URL(string: "wss://delivery.example/ws")!
        )
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)
        let connection = DeliveryWebSocketConnection(failDispatch: failDispatch)
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: [environment.id: .init(accessToken: "fixture-token")]),
            httpTransport: try DeliveryHTTPTransport(environment: environment, version: version, snapshot: snapshot,
                                                      shellSnapshot: shellSnapshot,
                                                      serverResolvedCommandContext: serverResolvedCommandContext),
            webSocketConnector: DeliveryWebSocketConnector(connection: connection)
        )
        let suite = "t3-message-delivery-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return Self(
            client: NativeFeatureClient(
                runtime: runtime, settingsStore: defaults,
                fallbackPollingInitialDelay: .seconds(60), aggregateRefreshInterval: .seconds(60)
            ),
            connection: connection, directory: directory, defaults: defaults, defaultsSuite: suite
        )
    }

    func removeFiles() {
        try? FileManager.default.removeItem(at: directory)
        defaults.removePersistentDomain(forName: defaultsSuite)
    }

    /// The live marker follows the applied detail, independent of the content being asserted.
    func nextSynchronizedDetail(
        _ events: inout AsyncStream<FeatureEvent>.Iterator, threadID: String
    ) async throws -> (detail: FeatureThreadDetail, delta: FeatureDetailDelta?) {
        var latest: FeatureThreadDetail?
        var delta: FeatureDetailDelta?
        while let event = await events.next() {
            switch event {
            case let .detail(detail) where detail.thread.id == threadID:
                latest = detail
                delta = nil
            case let .detailDelta(detail, change) where detail.thread.id == threadID:
                latest = detail
                delta = change
            case .threadSync(threadID, .live):
                guard let latest else {
                    await client.disconnect()
                    throw RPCError.protocolViolation("Synchronization completed without publishing a detail")
                }
                return (latest, delta)
            case let .threadSync(id, .failed(message)) where id == threadID:
                await client.disconnect()
                throw RPCError.protocolViolation(message)
            case .threadSync(threadID, .reconnecting):
                await client.disconnect()
                throw RPCError.protocolViolation("The fixture thread disconnected before synchronization")
            default: continue
            }
        }
        await client.disconnect()
        throw RPCError.protocolViolation("The fixture event stream ended before synchronization")
    }
}

private struct DeliveryHTTPTransport: HTTPTransport {
    let environment: Environment
    let version: Int
    let shell: Data
    let detail: Data
    let serverResolvedCommandContext: Bool

    init(environment: Environment, version: Int, snapshot: JSONValue? = nil,
         shellSnapshot: JSONValue? = nil,
         serverResolvedCommandContext: Bool = false) throws {
        self.environment = environment
        self.version = version
        self.serverResolvedCommandContext = serverResolvedCommandContext
        let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Fixtures/Wire")
        if let shellSnapshot { shell = try JSONEncoder.t3.encode(shellSnapshot) }
        else {
            shell = try Data(contentsOf: fixtures.appendingPathComponent(
                version == 2 ? "v2-shell-snapshot.json" : "shell-snapshot.json"
            ))
        }
        if let snapshot { detail = try JSONEncoder.t3.encode(snapshot) }
        else {
            detail = try Data(contentsOf: fixtures.appendingPathComponent(
                version == 2 ? "v2-thread-bounded-snapshot.json" : "thread-detail-snapshot.json"
            ))
        }
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = try XCTUnwrap(request.url)
        let data: Data
        switch url.path {
        case "/api/auth/session":
            data = try JSONEncoder.t3.encode(AuthSessionState(
                authenticated: true, scopes: ["orchestration:read", "orchestration:operate"],
                sessionMethod: "bearer-access-token", permissions: ["orchestration:read", "orchestration:operate"],
                auth: .init(serverUpdateScope: "environment:maintain")
            ))
        case "/.well-known/t3/environment":
            data = try JSONEncoder.t3.encode(JSONValue.object([
                "environmentId": .string(environment.id), "label": .string(environment.label),
                "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
                "serverVersion": .string("fixture"), "capabilities": .object([
                    "serverResolvedCommandContext": .bool(serverResolvedCommandContext),
                ]),
                "orchestrationProtocolVersion": .number(Double(version)),
            ]))
        case "/api/orchestration/shell": data = shell
        case "/api/orchestration/threads/thread-v2/bounded", "/api/orchestration/threads/thread-fixture": data = detail
        case "/api/auth/websocket-ticket":
            data = Data(#"{"ticket":"fixture-ticket","expiresAt":"2099-01-01T00:00:00.000Z"}"#.utf8)
        default: throw URLError(.unsupportedURL)
        }
        return (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }
}

private struct DeliveryWebSocketConnector: WebSocketConnecting {
    let connection: DeliveryWebSocketConnection
    func connect(to _: URL) -> any WebSocketConnection { connection }
}

private actor DeliveryWebSocketConnection: WebSocketConnection {
    private(set) var commands: [JSONValue] = []
    private let failDispatch: Bool
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?
    private var threadRequestID: JSONValue?

    init(failDispatch: Bool) { self.failDispatch = failDispatch }

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard let id = request["id"], let tag = request["tag"]?.stringValue else { return }
        let value: JSONValue
        switch tag {
        case RPCMethod.subscribeThread.rawValue:
            threadRequestID = id
            try publishThreadEvents([.object(["kind": .string("synchronized")])])
            return
        case RPCMethod.dispatchCommand.rawValue:
            commands.append(try XCTUnwrap(request["payload"]))
            if failDispatch { throw URLError(.networkConnectionLost) }
            value = .object(["sequence": .number(101)])
        case RPCMethod.serverGetConfig.rawValue:
            value = .object(["providers": .array([]), "threadResumeCompletionMarker": .bool(true)])
        case RPCMethod.subscribeServerConfig.rawValue:
            try enqueue(.object([
                "_tag": .string("Chunk"), "requestId": id,
                "values": .array([.object([
                    "type": .string("snapshot"), "config": .object([
                        "providers": .array([]), "threadResumeCompletionMarker": .bool(true),
                    ]),
                ])]),
            ]))
            return
        default: return
        }
        try enqueue(.object([
            "_tag": .string("Exit"), "requestId": id,
            "exit": .object(["_tag": .string("Success"), "value": value]),
        ]))
    }

    func receive() async throws -> Data {
        if !responses.isEmpty { return responses.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func publishThreadEvents(_ events: [JSONValue]) throws {
        let id = try XCTUnwrap(threadRequestID)
        try enqueue(.object(["_tag": .string("Chunk"), "requestId": id, "values": .array(events)]))
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    private func enqueue(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            responses.append(data)
        }
    }
}
