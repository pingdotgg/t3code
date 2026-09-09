import Foundation
import Observation
import XCTest
@testable import T3Code

@MainActor
final class NativeRetryIdentityTests: XCTestCase {
    func testOlderToolPageNeverInheritsCurrentSessionLiveness() async throws {
        var capture = try JSONSerialization.jsonObject(with: JSONEncoder.t3.encode(
            NativeStopProjectionFixtures.snapshot("approval"))) as! [String: Any]
        var before = capture["before"] as! [String: Any]
        var detail = before["detail"] as! [String: Any]
        let sequence = detail["snapshotSequence"] as! Int
        var thread = detail["thread"] as! [String: Any]
        func tool(_ id: String, turn: String, at time: String) -> [String: Any] {
            ["id": id, "tone": "info", "kind": "tool.started", "summary": id,
             "payload": ["toolCallId": id, "title": id], "turnId": turn, "createdAt": time]
        }
        thread["messages"] = [["id": "new-text", "role": "assistant", "text": "Current turn",
            "turnId": "outcome-proof-A", "streaming": false,
            "createdAt": "2026-01-01T00:00:03Z", "updatedAt": "2026-01-01T00:00:03Z"]]
        thread["activities"] = [tool("new-tool", turn: "outcome-proof-A", at: "2026-01-01T00:00:04Z")]
        detail["thread"] = thread
        detail["page"] = ["beforeCursor": "older", "hasMore": true, "snapshotSequence": sequence, "threadSequence": sequence]
        before["detail"] = detail
        capture["before"] = before
        var older = before
        thread["messages"] = []
        thread["activities"] = [tool("old-tool", turn: "old-turn", at: "2026-01-01T00:00:01Z")]
        detail["thread"] = thread
        detail["page"] = ["hasMore": false, "snapshotSequence": sequence, "threadSequence": sequence]
        older["detail"] = detail
        capture["older"] = older
        let fixture = try await AcceptedSendFixture.make(captured:
            JSONDecoder.t3.decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: capture)), supportsPagination: true)
        addTeardownBlock { await fixture.cleanUp() }
        XCTAssertEqual(fixture.model.details[fixture.threadID]?.page?.hasMore, true)
        await fixture.transport.useCapturedPhase("older")
        let result = try await fixture.client.loadEarlierThreadTurns(id: fixture.threadID)
        let rows = try XCTUnwrap(result?.messages)
        XCTAssertEqual(rows.map(\.id), ["work-log-old-tool", "new-text", "work-log-new-tool"])
        XCTAssertNil(rows.first?.activeWorkLabel)
        XCTAssertEqual(rows.last?.activeWorkLabel, "new-tool")
    }

    func testToolUpdatesContinueAfterInterveningText() async throws {
        let base = try NativeStopProjectionFixtures.snapshot("approval")
        var capture = try JSONSerialization.jsonObject(with: JSONEncoder.t3.encode(base)) as! [String: Any]
        let times = ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:03.000Z"]
        let activities: [[String: Any]] = [0, 2].map { index in
            ["id": "call-event-\(index)", "tone": "info", "kind": "tool.updated",
             "summary": "Read \(index)", "payload": ["toolCallId": "call-a", "title": "Read \(index)"],
             "turnId": "outcome-proof-A", "sequence": index + 10, "createdAt": times[index]]
        }
        let message: [String: Any] = ["id": "between", "role": "assistant", "text": "Checking the result",
            "turnId": "outcome-proof-A", "streaming": false, "createdAt": times[1], "updatedAt": times[1]]
        var phase = capture["before"] as! [String: Any]
        var detail = phase["detail"] as! [String: Any]
        var thread = detail["thread"] as! [String: Any]
        thread["messages"] = [message]
        thread["activities"] = activities
        detail["thread"] = thread
        phase["detail"] = detail
        capture["before"] = phase
        let fixture = try await AcceptedSendFixture.make(captured:
            JSONDecoder.t3.decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: capture)))
        addTeardownBlock { await fixture.cleanUp() }
        let rows = try XCTUnwrap(fixture.model.details[fixture.threadID]?.messages)
        XCTAssertEqual(rows.map(\.role), [.tool, .assistant, .tool])
        XCTAssertEqual(rows.filter { $0.role == .tool }.map(\.createdAt),
                       [NativeTimestampParser.parse(times[0])!, NativeTimestampParser.parse(times[2])!])
        XCTAssertEqual(rows.last?.activeWorkLabel, "Read 2")
        XCTAssertNil(rows.first?.activeWorkLabel)
    }

    func testCapturedStopProjectionsRetainFeedbackUntilInactiveSession() async throws {
        for scenario in ["approval", "approval-starting", "input", "background-ready-null", "active-running-null"] {
            let fixture = try await AcceptedSendFixture.make(
                captured: NativeStopProjectionFixtures.snapshot(scenario)
            )
            addTeardownBlock { await fixture.cleanUp() }
            let expectedPhase: FeatureStopPhase = scenario == "background-ready-null"
                ? .unconfirmed : .awaitingOutcome
            var reads = fixture.transport.heldReads.makeAsyncIterator()
            await fixture.transport.holdFollowups()
            await fixture.model.cancelTurn(threadID: fixture.threadID)
            XCTAssertEqual(fixture.model.stopPhase(threadID: fixture.threadID), expectedPhase, scenario)
            let next = await reads.next()
            let held = try XCTUnwrap(next)
            XCTAssertEqual(held.path, "/api/orchestration/shell")
            await fixture.transport.useCapturedPhase("requestHeld")
            await fixture.transport.release(held.id)
            await CapturedStopProjectionReceipt(model: fixture.model, threadID: fixture.threadID).wait()
            XCTAssertEqual(fixture.model.stopPhase(threadID: fixture.threadID), expectedPhase, scenario)
            await fixture.transport.allowFollowups()
            await fixture.transport.useCapturedPhase("afterAcknowledged")
            _ = await fixture.model.detail(for: fixture.threadID, force: true, fresh: true)
            XCTAssertEqual(fixture.model.stopPhase(threadID: fixture.threadID), expectedPhase, scenario)
            await fixture.transport.useCapturedPhase("afterTerminal")
            _ = await fixture.model.detail(for: fixture.threadID, force: true, fresh: true)
            XCTAssertEqual(fixture.model.stopPhase(threadID: fixture.threadID),
                           scenario == "background-ready-null" ? .unconfirmed : nil, scenario)
        }
    }

    func testCapturedInputStopFailureMapsToTranscript() async throws {
        let fixture = try await AcceptedSendFixture.make(
            captured: NativeStopProjectionFixtures.snapshot("input-failure")
        )
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        await fixture.model.cancelTurn(threadID: fixture.threadID)
        let next = await reads.next()
        let held = try XCTUnwrap(next)
        await fixture.transport.useCapturedPhase("requestHeld")
        await fixture.transport.release(held.id)
        await CapturedStopProjectionReceipt(model: fixture.model, threadID: fixture.threadID).wait()
        XCTAssertEqual(fixture.model.stopPhase(threadID: fixture.threadID), .awaitingOutcome)
        await fixture.transport.allowFollowups()
        await fixture.transport.useCapturedPhase("afterFailure")
        _ = await fixture.model.detail(for: fixture.threadID, force: true, fresh: true)
        XCTAssertTrue(fixture.model.details[fixture.threadID]?.messages.contains {
            $0.toolName == "provider.turn.interrupt.failed" && $0.role == .system
        } == true)
        XCTAssertNil(fixture.model.errorMessage)
    }


    func testExpectedStopTurnMismatchDoesNotDispatch() async throws {
        let fixture = try await AcceptedSendFixture.make(turnID: "current-turn")
        addTeardownBlock { await fixture.cleanUp() }
        do {
            try await fixture.client.cancelTurn(threadID: fixture.threadID, expectedTurnID: "older-turn")
            XCTFail("Mismatched turn must be refused before dispatch")
        } catch is FeatureStopTurnChangedError {}
        let commands = await fixture.socket.commands
        XCTAssertTrue(commands.isEmpty)
        XCTAssertEqual(fixture.model.snapshot.threads.first?.latestTurnID, "current-turn")
        XCTAssertEqual(fixture.model.details[fixture.threadID]?.thread.latestTurnID, "current-turn")
        XCTAssertEqual(fixture.model.details[fixture.threadID]?.thread.latestTurnState, "running")
    }

    func testExpectedStopTurnPayloadAndAckDoNotWaitForRefresh() async throws {
        let fixture = try await AcceptedSendFixture.make(turnID: "current-turn")
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        try await fixture.client.cancelTurn(threadID: fixture.threadID, expectedTurnID: "current-turn")
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(commands.first?["turnId"]?.stringValue, "current-turn")
        let read = await reads.next()
        XCTAssertEqual(read?.path, "/api/orchestration/shell")
        await fixture.transport.failFollowups()
    }

    func testStopStatusWaitsForHTTPWithoutDispatching() async throws {
        let fixture = try await AcceptedSendFixture.make(turnID: "current-turn")
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        let status = Task { try await fixture.client.stopStatus(threadID: fixture.threadID) }
        let nextRead = await reads.next()
        let read = try XCTUnwrap(nextRead)
        XCTAssertEqual(read.path, "/api/orchestration/shell")
        let commands = await fixture.socket.commands
        XCTAssertTrue(commands.isEmpty)
        await fixture.transport.release(read.id)
        let thread = try await status.value
        XCTAssertEqual(thread.latestTurnID, "current-turn")
        XCTAssertEqual(thread.latestTurnState, "running")
        await fixture.transport.failFollowups()
    }

    func testLateStopAcknowledgementCannotCancelReplacementGenerationRefresh() async throws {
        let fixture = try await AcceptedSendFixture.make(includePeer: true)
        addTeardownBlock { await fixture.cleanUp() }
        var acknowledgements = fixture.socket.heldInterrupts.makeAsyncIterator()
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        await fixture.socket.holdInterruptAcknowledgements()
        let stopping = Task { try await fixture.client.cancelTurn(threadID: fixture.threadID) }
        addTeardownBlock {
            await fixture.socket.releaseInterruptAcknowledgements()
            _ = await stopping.result
        }
        guard await acknowledgements.next() != nil else { throw CancellationError() }

        _ = try await fixture.runtime.activate(id: "accepted-peer")
        _ = try await fixture.client.initialSnapshot()
        await fixture.transport.holdFollowups(includeShell: false)
        try await fixture.client.sendMessage(threadID: fixture.threadID, text: "Replacement generation", selection: nil)
        let replacementRead = await reads.next()
        let replacement = try XCTUnwrap(replacementRead)
        XCTAssertTrue(replacement.path.hasPrefix("/api/orchestration/threads/"))

        await fixture.socket.releaseInterruptAcknowledgements()
        try await stopping.value
        let marker = "Replacement generation published its uniquely held response"
        XCTAssertNotEqual(fixture.model.details[fixture.threadID]?.messages.last?.text, marker)
        await fixture.transport.release(replacement.id, detailMessage: marker)
        try await AcceptedSendDetailReceipt(
            model: fixture.model, threadID: fixture.threadID, expectedMessage: marker
        ).wait()
        XCTAssertEqual(fixture.model.details[fixture.threadID]?.messages.last?.text, marker)
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.map { $0["type"]?.stringValue }, ["thread.turn.interrupt", "thread.turn.start"])
    }

    func testRejectedStopPropagatesRemoteError() async throws {
        let fixture = try await AcceptedSendFixture.make()
        addTeardownBlock { await fixture.cleanUp() }
        await fixture.transport.holdFollowups()
        let before = await fixture.transport.snapshotReadCount
        await fixture.socket.rejectInterruptAcknowledgements()
        do {
            try await fixture.client.cancelTurn(threadID: fixture.threadID)
            XCTFail("Rejected interrupt must remain a command error")
        } catch let error as RPCError {
            guard case .remote("Stop rejected by fixture") = error else { throw error }
        }
        // These counters cover the command-return boundary only; they are
        // not a proof that no mistakenly queued future task could read later.
        let after = await fixture.transport.snapshotReadCount
        let pending = await fixture.transport.heldCount
        XCTAssertEqual(after, before)
        XCTAssertEqual(pending, 0)
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(commands.first?["type"]?.stringValue, "thread.turn.interrupt")
    }

    func testStopDuringHeldSendDetailPreservesDetailAndShellRecovery() async throws {
        let fixture = try await AcceptedSendFixture.make()
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        var cancellations = fixture.transport.cancellations.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        try await fixture.client.sendMessage(threadID: fixture.threadID, text: "Send before Stop", selection: nil)
        let firstRead = await reads.next()
        let detail = try XCTUnwrap(firstRead)
        XCTAssertTrue(detail.path.hasPrefix("/api/orchestration/threads/"))
        try await fixture.client.cancelTurn(threadID: fixture.threadID)
        let count = await fixture.transport.heldCount
        XCTAssertEqual(count, 1)
        let detailStillPending = await fixture.transport.isPending(detail.id)
        XCTAssertTrue(detailStillPending)
        await fixture.transport.release(detail.id)
        let nextRead = await reads.next()
        let shell = try XCTUnwrap(nextRead)
        XCTAssertEqual(shell.path, "/api/orchestration/shell")
        await fixture.transport.release(shell.id)
        let trailingRead = await reads.next()
        let trailing = try XCTUnwrap(trailingRead)
        XCTAssertEqual(trailing.path, "/api/orchestration/shell", "Stop requests shell repair without discarding or repeating the send detail repair")
        await fixture.client.disconnect()
        let cancelled = await cancellations.next()
        XCTAssertEqual(cancelled, trailing.id)
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.count, 2)
    }

    func testAcceptedStopCompletesBeforeOptionalShellReadFinishes() async throws {
        let fixture = try await AcceptedSendFixture.make()
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        let completed = expectation(description: "Accepted Stop completes without snapshot reads")
        let stopping = Task {
            await fixture.model.cancelTurn(threadID: fixture.threadID)
            completed.fulfill()
        }
        let read = await reads.next()
        XCTAssertEqual(read?.path, "/api/orchestration/shell")
        await fulfillment(of: [completed], timeout: 2)
        XCTAssertFalse(fixture.model.isPerformingAction)

        await fixture.transport.failFollowups()
        await stopping.value
        XCTAssertNil(fixture.model.errorMessage)
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(commands.first?["type"]?.stringValue, "thread.turn.interrupt")
    }

    func testSendDuringStopRefreshRetainsItsDetailRefresh() async throws {
        let fixture = try await AcceptedSendFixture.make()
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        var cancellations = fixture.transport.cancellations.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        try await fixture.client.cancelTurn(threadID: fixture.threadID)
        let shellRead = await reads.next()
        let shell = try XCTUnwrap(shellRead)
        XCTAssertEqual(shell.path, "/api/orchestration/shell")

        try await fixture.client.sendMessage(threadID: fixture.threadID, text: "After Stop", selection: nil)
        let heldCount = await fixture.transport.heldCount
        XCTAssertEqual(heldCount, 1)
        await fixture.transport.release(shell.id)
        let detailRead = await reads.next()
        let detail = try XCTUnwrap(detailRead)
        XCTAssertTrue(detail.path.hasPrefix("/api/orchestration/threads/"))

        await fixture.client.disconnect()
        let cancelledID = await cancellations.next()
        XCTAssertEqual(cancelledID, detail.id)
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.count, 2)
    }

    func testDisconnectCancelsStopRefreshWithoutAnotherInterrupt() async throws {
        let fixture = try await AcceptedSendFixture.make()
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        var cancellations = fixture.transport.cancellations.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        try await fixture.client.cancelTurn(threadID: fixture.threadID)
        let read = await reads.next()
        let held = try XCTUnwrap(read)
        await fixture.client.disconnect()
        let cancelledID = await cancellations.next()
        XCTAssertEqual(cancelledID, held.id)
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.count, 1)
        let pending = await fixture.transport.heldCount
        XCTAssertEqual(pending, 0)
    }

    func testAcceptedSendCompletesOutboxBeforeOptionalReadsFinish() async throws {
        let fixture = try await AcceptedSendFixture.make()
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        let completed = expectation(description: "Accepted send completes without snapshot reads")
        let sending = Task {
            let sent = await fixture.model.sendMessage(threadID: fixture.threadID, text: "Accepted now", selection: nil)
            completed.fulfill()
            return sent
        }
        _ = await reads.next()
        await fulfillment(of: [completed], timeout: 2)
        let queued = try await fixture.outbox.submissions()
        XCTAssertTrue(queued.isEmpty, "Acknowledgement must retire the outbox while optional reads are held.")
        XCTAssertFalse(fixture.model.isPerformingAction)

        await fixture.transport.failFollowups()
        let sent = await sending.value
        XCTAssertTrue(sent, "Optional read failures cannot turn acceptance into a failed send.")
        XCTAssertNil(fixture.model.errorMessage)
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(fixture.model.details[fixture.threadID]?.messages.last?.state, .complete)
        await fixture.client.disconnect()
    }

    func testAcceptedSendRefreshesCoalesceAndCancelWhenThreadCloses() async throws {
        let fixture = try await AcceptedSendFixture.make()
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        var cancellations = fixture.transport.cancellations.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        try await fixture.client.sendMessage(threadID: fixture.threadID, text: "First", selection: nil)
        let firstRead = await reads.next()
        let first = try XCTUnwrap(firstRead)
        XCTAssertTrue(first.path.hasPrefix("/api/orchestration/threads/"))
        try await fixture.client.sendMessage(threadID: fixture.threadID, text: "Second", selection: nil)
        let heldCount = await fixture.transport.heldCount
        XCTAssertEqual(heldCount, 1, "A second acceptance must coalesce behind the current read.")

        await fixture.transport.release(first.id)
        let shellRead = await reads.next()
        let shell = try XCTUnwrap(shellRead)
        XCTAssertEqual(shell.path, "/api/orchestration/shell")
        await fixture.transport.release(shell.id)
        let trailingRead = await reads.next()
        let trailing = try XCTUnwrap(trailingRead)
        XCTAssertTrue(trailing.path.hasPrefix("/api/orchestration/threads/"))
        fixture.client.releaseThread(id: fixture.threadID)
        let cancelledID = await cancellations.next()
        XCTAssertEqual(cancelledID, trailing.id)
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.count, 2, "Read reconciliation must never redispatch a command.")
        await fixture.transport.failFollowups()
        await fixture.client.disconnect()
    }

    func testDisconnectCancelsAcceptedSendRefreshWithoutAnotherCommand() async throws {
        let fixture = try await AcceptedSendFixture.make()
        addTeardownBlock { await fixture.cleanUp() }
        var reads = fixture.transport.heldReads.makeAsyncIterator()
        var cancellations = fixture.transport.cancellations.makeAsyncIterator()
        await fixture.transport.holdFollowups()
        try await fixture.client.sendMessage(threadID: fixture.threadID, text: "Accepted before disconnect", selection: nil)
        let heldRead = await reads.next()
        let held = try XCTUnwrap(heldRead)
        await fixture.client.disconnect()
        let cancelledID = await cancellations.next()
        XCTAssertEqual(cancelledID, held.id)
        let commands = await fixture.socket.commands
        XCTAssertEqual(commands.count, 1)
        let pending = await fixture.transport.heldCount
        XCTAssertEqual(pending, 0)
    }

    func testSavedSettingsSurviveAConnectionRepublish() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-settings-republish-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let environment = Environment(
            id: "environment-settings-republish",
            label: "Settings republish",
            httpBaseURL: URL(string: "https://settings-republish.example")!,
            webSocketBaseURL: URL(string: "wss://settings-republish.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)
        let transport = ConcurrentBootstrapHTTPTransport(shell: retryShellSnapshot())
        let connection = ConcurrentBootstrapWebSocketConnection()
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [environment.id: EnvironmentCredential(accessToken: "token")]
            ),
            httpTransport: transport,
            webSocketConnector: ConcurrentBootstrapWebSocketConnector(connection: connection)
        )
        let settingsSuite = "t3-native-settings-republish-\(UUID().uuidString)"
        let settingsStore = UserDefaults(suiteName: settingsSuite)!
        defer { settingsStore.removePersistentDomain(forName: settingsSuite) }
        let client = NativeFeatureClient(runtime: runtime, settingsStore: settingsStore)
        let seed = try await client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: client.events())
        defer { recorder.stop() }
        let initial = try await recorder.wait { !$0.projects.isEmpty && !$0.threads.isEmpty }
        await connection.waitUntilConnected()
        var updated = initial.settings
        updated.textSize = FeatureTextSizeAdjustment(steps: 2)
        updated.codeSize = FeatureTextSizeAdjustment(steps: -1)
        try await client.saveSettings(updated)
        await connection.failReceive()
        let snapshot = try await recorder.wait {
            $0.connection.state == .reconnecting && $0.settings.textSize.steps == 2
        }
        XCTAssertEqual(snapshot.settings.textSize.steps, 2)
        XCTAssertEqual(snapshot.settings.codeSize.steps, -1)
        await client.disconnect()
    }

    func testConcurrentBootstrapRetriesKeepIndependentStableIdentities() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-concurrent-retry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let environment = Environment(
            id: "environment-concurrent-retry",
            label: "Concurrent retry",
            httpBaseURL: URL(string: "https://concurrent-retry.example")!,
            webSocketBaseURL: URL(string: "wss://concurrent-retry.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)
        let transport = ConcurrentBootstrapHTTPTransport(shell: retryShellSnapshot())
        let connection = ConcurrentBootstrapWebSocketConnection()
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [environment.id: EnvironmentCredential(accessToken: "token")]
            ),
            httpTransport: transport,
            webSocketConnector: ConcurrentBootstrapWebSocketConnector(connection: connection)
        )
        let client = NativeFeatureClient(
            runtime: runtime,
            settingsStore: UserDefaults(
                suiteName: "t3-native-concurrent-retry-\(UUID().uuidString)"
            )!
        )
        let seed = try await client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: client.events())
        defer { recorder.stop() }
        _ = try await recorder.wait { !$0.projects.isEmpty && !$0.threads.isEmpty }
        await connection.waitUntilConnected()
        await transport.rejectShellReads()

        async let firstAttempt = failedBootstrap(client: client, prompt: "First task")
        async let secondAttempt = failedBootstrap(client: client, prompt: "Second task")
        _ = await (firstAttempt, secondAttempt)
        await connection.waitUntilDispatchCount(2)

        await failedBootstrap(client: client, prompt: "First task")
        await failedBootstrap(client: client, prompt: "Second task")

        let commands = await connection.dispatchCommands()
        XCTAssertEqual(commands.count, 4)
        for prompt in ["First task", "Second task"] {
            let matching = commands.filter {
                $0["message"]?["text"]?.stringValue == prompt
            }
            XCTAssertEqual(matching.count, 2, "Expected an initial attempt and one retry.")
            XCTAssertEqual(matching.first?["threadId"], matching.last?["threadId"])
            XCTAssertEqual(matching.first?["commandId"], matching.last?["commandId"])
            XCTAssertEqual(
                matching.first?["message"]?["messageId"],
                matching.last?["message"]?["messageId"]
            )
        }
        await client.disconnect()
    }

    func testTurnRetriesStayStableAndConfirmedBootstrapFailureResetsIdentity() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-retry-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let environment = Environment(
            id: "environment-retry",
            label: "Retry",
            httpBaseURL: URL(string: "https://retry.example")!,
            webSocketBaseURL: URL(string: "wss://retry.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)

        let connection = AmbiguousDispatchWebSocketConnection()
        let transport = RetryIdentityHTTPTransport(shell: retryShellSnapshot())
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    environment.id: EnvironmentCredential(accessToken: "token"),
                ]
            ),
            httpTransport: transport,
            webSocketConnector: RetryIdentityWebSocketConnector(connection: connection)
        )
        let settings = UserDefaults(
            suiteName: "t3-native-retry-\(UUID().uuidString)"
        )!
        let client = NativeFeatureClient(runtime: runtime, settingsStore: settings)
        let seed = try await client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: client.events())
        defer { recorder.stop() }
        let initial = try await recorder.wait { !$0.projects.isEmpty && !$0.threads.isEmpty }
        XCTAssertEqual(initial.threads.first?.runtimeMode, .approvalRequired)
        XCTAssertEqual(initial.threads.first?.interactionMode, .standard)
        await connection.waitUntilConnected()

        let turnIdentity = FeatureSubmissionIdentity(
            threadID: "thread-existing",
            commandID: "persisted-turn-command",
            messageID: "persisted-turn-message",
            createdAt: Date(timeIntervalSince1970: 1_750_000_000)
        )
        for _ in 0..<2 {
            do {
                try await client.sendMessage(
                    threadID: "thread-existing",
                    text: "Retry without duplicating",
                    selection: nil,
                    attachments: [],
                    identity: turnIdentity
                )
                XCTFail("The synthetic dispatch should fail ambiguously.")
            } catch {}
        }

        for _ in 0..<2 {
            do {
                _ = try await client.createThreadAndSend(
                    projectID: "project-1",
                    prompt: "Create exactly one task",
                    selection: FeatureSelection(providerID: "codex", modelID: "gpt-5.4"),
                    runtimeMode: .autoAcceptEdits,
                    interactionMode: .plan,
                    attachments: []
                )
                XCTFail("The synthetic bootstrap should fail ambiguously.")
            } catch {}
        }

        let commands = await connection.dispatchCommands()
            + transport.dispatchCommands()
        XCTAssertEqual(commands.count, 4)
        let turnCommands = commands.filter {
            $0["message"]?["text"]?.stringValue == "Retry without duplicating"
        }
        XCTAssertEqual(turnCommands.count, 2)
        let initialTurn = try XCTUnwrap(turnCommands.first)
        let retriedTurn = try XCTUnwrap(turnCommands.dropFirst().first)
        assertStableIdentity(initialTurn, retriedTurn, includesThreadID: false)
        XCTAssertEqual(initialTurn["commandId"]?.stringValue, turnIdentity.commandID)
        XCTAssertEqual(
            initialTurn["message"]?["messageId"]?.stringValue,
            turnIdentity.messageID
        )
        let bootstrapCommands = commands.filter {
            $0["message"]?["text"]?.stringValue == "Create exactly one task"
        }
        XCTAssertEqual(bootstrapCommands.count, 2)
        let initialBootstrap = try XCTUnwrap(bootstrapCommands.first)
        let retriedBootstrap = try XCTUnwrap(bootstrapCommands.dropFirst().first)
        XCTAssertNotEqual(initialBootstrap["commandId"], retriedBootstrap["commandId"])
        XCTAssertNotEqual(
            initialBootstrap["message"]?["messageId"],
            retriedBootstrap["message"]?["messageId"]
        )
        XCTAssertNotEqual(initialBootstrap["threadId"], retriedBootstrap["threadId"])
        for command in turnCommands {
            XCTAssertEqual(command["runtimeMode"]?.stringValue, "approval-required")
            XCTAssertEqual(command["interactionMode"]?.stringValue, "default")
        }
        for command in bootstrapCommands {
            XCTAssertEqual(command["runtimeMode"]?.stringValue, "auto-accept-edits")
            XCTAssertEqual(command["interactionMode"]?.stringValue, "default")
        }
        await client.disconnect()
    }

    func testPartialBootstrapRecoversBySendingOnlyTheStableFinalTurn() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-partial-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let environment = Environment(
            id: "environment-partial",
            label: "Partial",
            httpBaseURL: URL(string: "https://partial.example")!,
            webSocketBaseURL: URL(string: "wss://partial.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)

        let connection = PartialBootstrapWebSocketConnection()
        let transport = PartialBootstrapHTTPTransport(shell: retryShellSnapshot())
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    environment.id: EnvironmentCredential(accessToken: "token"),
                ]
            ),
            httpTransport: transport,
            webSocketConnector: PartialBootstrapWebSocketConnector(connection: connection)
        )
        let settings = UserDefaults(
            suiteName: "t3-native-partial-\(UUID().uuidString)"
        )!
        let client = NativeFeatureClient(runtime: runtime, settingsStore: settings)
        let seed = try await client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: client.events())
        defer { recorder.stop() }
        _ = try await recorder.wait { !$0.projects.isEmpty && !$0.threads.isEmpty }
        await connection.waitUntilConnected()

        let identity = FeatureSubmissionIdentity(
            threadID: "persisted-bootstrap-thread",
            commandID: "persisted-bootstrap-command",
            messageID: "persisted-bootstrap-message",
            createdAt: Date(timeIntervalSince1970: 1_750_000_000)
        )
        let created = try await client.createThreadAndSend(
            projectID: "project-1",
            prompt: "Recover the first turn",
            selection: FeatureSelection(providerID: "codex", modelID: "gpt-5.4"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            workspaceMode: .local,
            branch: nil,
            worktreePath: nil,
            startFromOrigin: false,
            attachments: [],
            identity: identity
        )

        let commands = await connection.dispatchCommands()
            + transport.dispatchCommands()
        XCTAssertEqual(commands.count, 2)
        let bootstrap = try XCTUnwrap(commands.first { $0["bootstrap"] != nil })
        let finalTurn = try XCTUnwrap(commands.first { $0["bootstrap"] == nil })
        assertStableIdentity(bootstrap, finalTurn, includesThreadID: true)
        XCTAssertEqual(bootstrap["threadId"]?.stringValue, identity.threadID)
        XCTAssertEqual(bootstrap["commandId"]?.stringValue, identity.commandID)
        XCTAssertEqual(
            bootstrap["message"]?["messageId"]?.stringValue,
            identity.messageID
        )
        let wireID = try XCTUnwrap(bootstrap["threadId"]?.stringValue)
        XCTAssertEqual(created.wireID, wireID)
        XCTAssertEqual(
            created.id,
            FeatureScopedID.thread(environmentID: environment.id, wireID: wireID)
        )
        await client.disconnect()
    }

    private func assertStableIdentity(
        _ first: JSONValue,
        _ second: JSONValue,
        includesThreadID: Bool
    ) {
        XCTAssertEqual(first["commandId"], second["commandId"])
        XCTAssertEqual(first["message"]?["messageId"], second["message"]?["messageId"])
        XCTAssertEqual(first["createdAt"], second["createdAt"])
        if includesThreadID {
            XCTAssertEqual(first["threadId"], second["threadId"])
        }
    }

    private func failedBootstrap(client: NativeFeatureClient, prompt: String) async {
        do {
            _ = try await client.createThreadAndSend(
                projectID: "project-1",
                prompt: prompt,
                selection: FeatureSelection(providerID: "codex", modelID: "gpt-5.4"),
                runtimeMode: .fullAccess,
                interactionMode: .standard,
                attachments: []
            )
            XCTFail("The synthetic dispatch should fail ambiguously.")
        } catch {}
    }
}

private struct ConcurrentBootstrapWebSocketConnector: WebSocketConnecting {
    let connection: ConcurrentBootstrapWebSocketConnection

    func connect(to _: URL) -> any WebSocketConnection {
        connection
    }
}

private actor ConcurrentBootstrapWebSocketConnection: WebSocketConnection {
    private var commands: [JSONValue] = []
    private var initialFailures: [CheckedContinuation<Void, Error>] = []
    private var dispatchWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var didConnect = false
    private var connectionWaiters: [CheckedContinuation<Void, Never>] = []
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var shouldFailNextReceive = false

    func send(_ data: Data) async throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if !didConnect {
            didConnect = true
            connectionWaiters.forEach { $0.resume() }
            connectionWaiters.removeAll()
        }
        if request["tag"]?.stringValue == RPCMethod.serverGetConfig.rawValue
            || request["tag"]?.stringValue == RPCMethod.subscribeServerConfig.rawValue,
           let response = try retryConfigResponse(for: request) {
            enqueue(response)
            return
        }
        guard request["tag"]?.stringValue == RPCMethod.dispatchCommand.rawValue,
              let payload = request["payload"] else {
            return
        }
        commands.append(payload)
        let ready = dispatchWaiters.filter { commands.count >= $0.0 }
        dispatchWaiters.removeAll { commands.count >= $0.0 }
        ready.forEach { $0.1.resume() }
        guard commands.count <= 2 else {
            throw URLError(.networkConnectionLost)
        }
        return try await withCheckedThrowingContinuation { continuation in
            initialFailures.append(continuation)
            guard initialFailures.count == 2 else { return }
            let failures = initialFailures
            initialFailures.removeAll()
            failures.forEach { $0.resume(throwing: URLError(.networkConnectionLost)) }
        }
    }

    func receive() async throws -> Data {
        if shouldFailNextReceive {
            shouldFailNextReceive = false
            throw URLError(.networkConnectionLost)
        }
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    func failReceive() {
        let error = URLError(.networkConnectionLost)
        if let receiver {
            self.receiver = nil
            receiver.resume(throwing: error)
        } else {
            shouldFailNextReceive = true
        }
    }

    func waitUntilConnected() async {
        guard !didConnect else { return }
        await withCheckedContinuation { continuation in
            connectionWaiters.append(continuation)
        }
    }

    func waitUntilDispatchCount(_ count: Int) async {
        guard commands.count < count else { return }
        await withCheckedContinuation { continuation in
            dispatchWaiters.append((count, continuation))
        }
    }

    func dispatchCommands() -> [JSONValue] {
        commands
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }
}

private actor ConcurrentBootstrapHTTPTransport: HTTPTransport {
    private let shellData: Data
    private var acceptsShellReads = true

    init(shell: OrchestrationShellSnapshot) {
        shellData = try! JSONEncoder.t3.encode(shell)
    }

    func rejectShellReads() {
        acceptsShellReads = false
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        switch request.url?.path {
        case "/api/orchestration/shell" where acceptsShellReads:
            (shellData, retryHTTPResponse(request))
        case "/api/auth/websocket-ticket":
            (
                Data(
                    "{\"ticket\":\"ticket\",\"expiresAt\":\"2026-08-01T12:05:00.000Z\"}".utf8
                ),
                retryHTTPResponse(request)
            )
        default:
            throw URLError(.networkConnectionLost)
        }
    }
}

private func retryShellSnapshot() -> OrchestrationShellSnapshot {
    let timestamp = "2026-07-30T12:00:00.000Z"
    let model = ModelSelection(instanceId: "codex", model: "gpt-5.4")
    return OrchestrationShellSnapshot(
        snapshotSequence: 1,
        projects: [
            OrchestrationProject(
                id: "project-1",
                title: "T3 Code",
                workspaceRoot: "/work/t3",
                repositoryIdentity: nil,
                defaultModelSelection: model,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: nil
            ),
        ],
        threads: [
            OrchestrationThreadShell(
                id: "thread-existing",
                projectId: "project-1",
                title: "Existing",
                modelSelection: model,
                runtimeMode: .approvalRequired,
                interactionMode: .plan,
                branch: nil,
                worktreePath: nil,
                latestTurn: nil,
                createdAt: timestamp,
                updatedAt: timestamp,
                archivedAt: nil,
                settledOverride: nil,
                settledAt: nil,
                snoozedUntil: nil,
                snoozedAt: nil,
                pinnedAt: nil,
                session: nil,
                latestUserMessageAt: nil,
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                hasActionableProposedPlan: false,
                backgroundLiveness: nil
            ),
        ],
        updatedAt: timestamp
    )
}

private actor RetryIdentityHTTPTransport: HTTPTransport {
    private let shellData: Data
    private var commands: [JSONValue] = []

    init(shell: OrchestrationShellSnapshot) {
        shellData = try! JSONEncoder.t3.encode(shell)
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        if path == "/api/orchestration/shell" {
            return (shellData, retryHTTPResponse(request))
        }
        if path == "/api/auth/websocket-ticket" {
            return (
                Data(
                    """
                    {
                      "ticket": "ticket",
                      "expiresAt": "2026-07-30T12:05:00.000Z"
                    }
                    """.utf8
                ),
                retryHTTPResponse(request)
            )
        }
        if path.hasPrefix("/api/orchestration/threads/") {
            throw URLError(.networkConnectionLost)
        }
        if path == "/api/orchestration/dispatch" {
            commands.append(try retryDispatchCommand(from: request))
            throw URLError(.networkConnectionLost)
        }
        throw URLError(.unsupportedURL)
    }

    func dispatchCommands() -> [JSONValue] {
        commands
    }
}

private struct RetryIdentityWebSocketConnector: WebSocketConnecting {
    let connection: AmbiguousDispatchWebSocketConnection

    func connect(to _: URL) async throws -> any WebSocketConnection {
        connection
    }
}

private actor PartialBootstrapHTTPTransport: HTTPTransport {
    private let shellData: Data
    private var commands: [JSONValue] = []

    init(shell: OrchestrationShellSnapshot) {
        shellData = try! JSONEncoder.t3.encode(shell)
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        if path == "/api/orchestration/shell" {
            return (shellData, retryHTTPResponse(request))
        }
        if path == "/api/auth/websocket-ticket" {
            return (
                Data(
                    """
                    {
                      "ticket": "ticket",
                      "expiresAt": "2026-07-30T12:05:00.000Z"
                    }
                    """.utf8
                ),
                retryHTTPResponse(request)
            )
        }
        if path.hasPrefix("/api/orchestration/threads/") {
            let threadID = request.url?.lastPathComponent.removingPercentEncoding ?? "thread"
            let snapshot = retryEmptyThreadDetail(id: threadID)
            return (try JSONEncoder.t3.encode(snapshot), retryHTTPResponse(request))
        }
        if path == "/api/orchestration/dispatch" {
            commands.append(try retryDispatchCommand(from: request))
            return (
                Data("{\"sequence\":42}".utf8),
                retryHTTPResponse(request)
            )
        }
        throw URLError(.unsupportedURL)
    }

    func dispatchCommands() -> [JSONValue] {
        commands
    }
}

private struct PartialBootstrapWebSocketConnector: WebSocketConnecting {
    let connection: PartialBootstrapWebSocketConnection

    func connect(to _: URL) async throws -> any WebSocketConnection {
        connection
    }
}

private actor AmbiguousDispatchWebSocketConnection: WebSocketConnection {
    private var commands: [JSONValue] = []
    private var queuedResponses: [Data] = []
    private var didConnect = false
    private var connectionWaiters: [CheckedContinuation<Void, Never>] = []
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if !didConnect {
            didConnect = true
            connectionWaiters.forEach { $0.resume() }
            connectionWaiters.removeAll()
        }
        if request["tag"]?.stringValue == RPCMethod.serverGetConfig.rawValue
            || request["tag"]?.stringValue == RPCMethod.subscribeServerConfig.rawValue,
           let response = try retryConfigResponse(for: request) {
            enqueue(response)
            return
        }
        if request["tag"]?.stringValue == RPCMethod.dispatchCommand.rawValue,
           let payload = request["payload"] {
            commands.append(payload)
            throw URLError(.networkConnectionLost)
        }
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    func waitUntilConnected() async {
        guard !didConnect else { return }
        await withCheckedContinuation { continuation in
            connectionWaiters.append(continuation)
        }
    }

    func dispatchCommands() -> [JSONValue] {
        commands
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }
}

private actor PartialBootstrapWebSocketConnection: WebSocketConnection {
    private var commands: [JSONValue] = []
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var didConnect = false
    private var connectionWaiters: [CheckedContinuation<Void, Never>] = []

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if !didConnect {
            didConnect = true
            connectionWaiters.forEach { $0.resume() }
            connectionWaiters.removeAll()
        }
        guard request["tag"]?.stringValue == RPCMethod.dispatchCommand.rawValue,
              let payload = request["payload"] else {
            if request["tag"]?.stringValue == RPCMethod.serverGetConfig.rawValue
                || request["tag"]?.stringValue == RPCMethod.subscribeServerConfig.rawValue,
               let response = try retryConfigResponse(for: request) {
                enqueue(response)
            }
            return
        }
        commands.append(payload)
        if payload["bootstrap"] != nil {
            throw URLError(.networkConnectionLost)
        }
        guard case let .number(requestID) = request["id"] else { return }
        let response = JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(requestID),
            "exit": .object([
                "_tag": .string("Success"),
                "value": .object(["sequence": .number(42)]),
            ]),
        ])
        enqueue(try JSONEncoder.t3.encode(response))
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    func waitUntilConnected() async {
        guard !didConnect else { return }
        await withCheckedContinuation { continuation in
            connectionWaiters.append(continuation)
        }
    }

    func dispatchCommands() -> [JSONValue] {
        commands
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }
}

private func retryConfigResponse(for request: JSONValue, supportsPagination: Bool = false) throws -> Data? {
    guard case let .number(requestID)? = request["id"] else { return nil }
    let config = JSONValue.object(["providers": .array([]), "threadSnapshotPagination": .bool(supportsPagination)])
    if request["tag"]?.stringValue == RPCMethod.subscribeServerConfig.rawValue {
        return try JSONEncoder.t3.encode(
            JSONValue.object([
                "_tag": .string("Chunk"),
                "requestId": .number(requestID),
                "values": .array([.object([
                    "type": .string("snapshot"),
                    "config": config,
                ])]),
            ])
        )
    }
    return try JSONEncoder.t3.encode(
        JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(requestID),
            "exit": .object([
                "_tag": .string("Success"),
                "value": config,
            ]),
        ])
    )
}

private func retryEmptyThreadDetail(id: String) -> OrchestrationThreadDetailSnapshot {
    let timestamp = "2026-07-30T12:00:00.000Z"
    return OrchestrationThreadDetailSnapshot(
        snapshotSequence: 2,
        thread: OrchestrationThread(
            id: id,
            projectId: "project-1",
            title: "Recover the first turn",
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            branch: nil,
            worktreePath: nil,
            latestTurn: nil,
            createdAt: timestamp,
            updatedAt: timestamp,
            archivedAt: nil,
            settledOverride: nil,
            settledAt: nil,
            snoozedUntil: nil,
            snoozedAt: nil,
            pinnedAt: nil,
            deletedAt: nil,
            messages: [],
            activities: [],
            checkpoints: [],
            session: nil
        )
    )
}

private func retryHTTPResponse(_ request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
    )!
}

private func retryDispatchCommand(from request: URLRequest) throws -> JSONValue {
    guard let body = request.httpBody else {
        throw URLError(.cannotDecodeContentData)
    }
    return try JSONDecoder.t3.decode(JSONValue.self, from: body)
}

@MainActor
private struct AcceptedSendFixture {
    let modelTask: Task<Void, Never>
    let directory: URL
    let threadID: String
    let settingsName: String
    let client: NativeFeatureClient
    let model: FeatureRootModel
    let outbox: FeatureOutboxStore
    let transport: AcceptedSendHTTPTransport
    let socket: AcceptedSendSocket
    let runtime: EnvironmentRuntime

    static func make(
        includePeer: Bool = false, turnID: String? = nil, captured: JSONValue? = nil, supportsPagination: Bool = false
    ) async throws -> Self {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-accepted-send-\(UUID().uuidString)")
        let environment = Environment(
            id: "accepted-send", label: "Accepted send",
            httpBaseURL: URL(string: "https://accepted-send.example")!,
            webSocketBaseURL: URL(string: "wss://accepted-send.example")!
        )
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let peer = Environment(
            id: "accepted-peer", label: "Accepted peer",
            httpBaseURL: URL(string: "https://accepted-peer.example")!,
            webSocketBaseURL: URL(string: "wss://accepted-peer.example")!
        )
        try await store.save(includePeer ? [environment, peer] : [environment])
        try await store.setActiveEnvironment(id: environment.id)
        let transport = AcceptedSendHTTPTransport(turnID: turnID, captured: captured)
        let socket = AcceptedSendSocket(supportsPagination: supportsPagination)
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: [
                environment.id: EnvironmentCredential(accessToken: "fixture-token"),
                peer.id: EnvironmentCredential(accessToken: "fixture-peer-token"),
            ]),
            httpTransport: transport,
            webSocketConnector: AcceptedSendConnector(socket: socket, peer: AcceptedSendSocket())
        )
        let settingsName = "t3-accepted-send-\(UUID().uuidString)"
        let configurationReady = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        defer { configurationReady.continuation.finish() }
        let client = NativeFeatureClient(
            runtime: runtime, settingsStore: UserDefaults(suiteName: settingsName)!,
            fallbackPollingInitialDelay: .seconds(3600), aggregateRefreshInterval: .seconds(3600),
            aggregateIdleRefreshInterval: .seconds(3600),
            aggregateRefreshReceipt: { receipt in
                if case .configurationApplied(environmentID: environment.id) = receipt {
                    configurationReady.continuation.yield(())
                    configurationReady.continuation.finish()
                }
            }
        )
        let outbox = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let model = FeatureRootModel(client: client, outboxStore: outbox)
        let modelTask = Task { await model.start() }
        do {
            let wireID = captured?["threadId"]?.stringValue ?? "thread-existing"
            try await AcceptedSendRootReadiness(model: model, wireID: wireID).wait()
            if supportsPagination {
                var readiness = configurationReady.stream.makeAsyncIterator()
                guard let _ = await readiness.next() else { throw CancellationError() }
            }
            let threadID = FeatureScopedID.thread(environmentID: environment.id, wireID: wireID)
            _ = await model.detail(for: threadID)
            return Self(modelTask: modelTask, directory: directory, threadID: threadID,
                        settingsName: settingsName, client: client, model: model,
                        outbox: outbox, transport: transport, socket: socket, runtime: runtime)
        } catch {
            modelTask.cancel()
            await client.disconnect()
            await modelTask.value
            UserDefaults.standard.removePersistentDomain(forName: settingsName)
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    func cleanUp() async {
        modelTask.cancel()
        await client.disconnect()
        await modelTask.value
        UserDefaults.standard.removePersistentDomain(forName: settingsName)
        try? FileManager.default.removeItem(at: directory)
    }
}

@MainActor
private final class AcceptedSendRootReadiness {
    private let model: FeatureRootModel
    private let wireID: String
    private var continuation: CheckedContinuation<Void, Error>?

    init(model: FeatureRootModel, wireID: String = "thread-existing") {
        self.model = model
        self.wireID = wireID
    }

    func wait() async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()); return }
                self.continuation = continuation
                observe()
            }
        } onCancel: {
            Task { @MainActor in self.finish(CancellationError()) }
        }
    }

    private func observe() {
        guard continuation != nil else { return }
        let ready = withObservationTracking {
            !model.isLoading
                && model.snapshot.projects.contains { $0.id == FeatureScopedID.project(environmentID: "accepted-send", wireID: "project-1") }
                && model.snapshot.threads.contains { $0.id == FeatureScopedID.thread(environmentID: "accepted-send", wireID: wireID) }
                && model.snapshot.environments.first(where: { $0.id == "accepted-send" })?.connectionState == .connected
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.observe() }
        }
        if ready { finish(nil) }
    }

    private func finish(_ error: Error?) {
        guard let pending = continuation else { return }
        continuation = nil
        if let error { pending.resume(throwing: error) } else { pending.resume() }
    }
}

@MainActor
private final class AcceptedSendDetailReceipt {
    private let model: FeatureRootModel
    private let threadID: String
    private let expectedMessage: String
    private var continuation: CheckedContinuation<Void, Error>?

    init(model: FeatureRootModel, threadID: String, expectedMessage: String) {
        self.model = model
        self.threadID = threadID
        self.expectedMessage = expectedMessage
    }

    func wait() async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()); return }
                self.continuation = continuation
                observe()
            }
        } onCancel: {
            Task { @MainActor in self.finish(CancellationError()) }
        }
    }

    private func observe() {
        guard continuation != nil else { return }
        let ready = withObservationTracking {
            model.details[threadID]?.messages.last?.text == expectedMessage
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.observe() }
        }
        if ready { finish(nil) }
    }

    private func finish(_ error: Error?) {
        guard let pending = continuation else { return }
        continuation = nil
        if let error { pending.resume(throwing: error) } else { pending.resume() }
    }
}

private actor AcceptedSendHTTPTransport: HTTPTransport {
    struct HeldRead: Sendable {
        let id: UUID
        let path: String
    }
    nonisolated let heldReads: AsyncStream<HeldRead>
    nonisolated let cancellations: AsyncStream<UUID>
    private let reads: AsyncStream<HeldRead>.Continuation
    private let cancelled: AsyncStream<UUID>.Continuation
    private(set) var snapshotReadCount = 0
    private var holdsShell = true
    private var holds = false
    private var fails = false
    private var pending: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var detailMessages: [UUID: String] = [:]

    private let captured: JSONValue?
    private var capturedPhase = "before"

    func useCapturedPhase(_ phase: String) { capturedPhase = phase }
    func allowFollowups() { holds = false }

    private let turnID: String?

    init(turnID: String? = nil, captured: JSONValue? = nil) {
        self.captured = captured
        self.turnID = turnID
        (heldReads, reads) = AsyncStream.makeStream()
        (cancellations, cancelled) = AsyncStream.makeStream()
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        if path == "/api/auth/websocket-ticket" {
            return (Data(#"{"ticket":"fixture-ticket","expiresAt":"2026-09-07T12:05:00Z"}"#.utf8), retryHTTPResponse(request))
        }
        guard path == "/api/orchestration/shell" || path.hasPrefix("/api/orchestration/threads/") else {
            throw URLError(.unsupportedURL)
        }
        snapshotReadCount += 1
        if fails { throw URLError(.networkConnectionLost) }
        var heldID: UUID?
        if holds && (holdsShell || path != "/api/orchestration/shell") {
            let id = UUID()
            heldID = id
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    if Task.isCancelled { continuation.resume(throwing: CancellationError()); return }
                    pending[id] = continuation
                    reads.yield(HeldRead(id: id, path: path))
                }
            } onCancel: {
                Task { await self.cancel(id) }
            }
        }
        if let captured {
            let key = path == "/api/orchestration/shell" ? "shell" : "detail"
            guard let snapshot = captured[capturedPhase]?[key] else { throw HTTPError.invalidResponse }
            return (try JSONEncoder.t3.encode(snapshot), retryHTTPResponse(request))
        }
        let data: Data
        if path == "/api/orchestration/shell" {
            data = try JSONEncoder.t3.encode(retryShellSnapshot())
        } else {
            let snapshot = retryEmptyThreadDetail(id: request.url!.lastPathComponent)
            if let heldID, let text = detailMessages.removeValue(forKey: heldID) {
                var thread = try JSONValue.encode(snapshot.thread).decode([String: JSONValue].self)
                thread["messages"] = .array([.object([
                    "id": .string("replacement-generation-message"), "role": .string("assistant"),
                    "text": .string(text), "turnId": .null, "streaming": .bool(false),
                    "attachments": .array([]), "createdAt": .string("2026-07-30T12:00:00.000Z"),
                    "updatedAt": .string("2026-07-30T12:00:00.000Z"),
                ])])
                data = try JSONEncoder.t3.encode(OrchestrationThreadDetailSnapshot(
                    snapshotSequence: 99,
                    thread: try JSONValue.object(thread).decode(OrchestrationThread.self)
                ))
            } else { data = try JSONEncoder.t3.encode(snapshot) }
        }
        if let turnID {
            var root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            let latest: [String: Any] = ["turnId": turnID, "state": "running", "requestedAt": "2026-07-30T12:00:00.000Z"]
            if var threads = root["threads"] as? [[String: Any]] {
                for index in threads.indices { threads[index]["latestTurn"] = latest }
                root["threads"] = threads
            }
            if var thread = root["thread"] as? [String: Any] {
                thread["latestTurn"] = latest
                root["thread"] = thread
            }
            return (try JSONSerialization.data(withJSONObject: root), retryHTTPResponse(request))
        }
        return (data, retryHTTPResponse(request))
    }

    var heldCount: Int { pending.count }

    func isPending(_ id: UUID) -> Bool { pending[id] != nil }

    func holdFollowups(includeShell: Bool = true) { holds = true; holdsShell = includeShell }

    func release(_ id: UUID, detailMessage: String? = nil) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        if let detailMessage { detailMessages[id] = detailMessage }
        continuation.resume()
    }

    func failFollowups() {
        fails = true
        holds = false
        let waiting = pending.values
        pending.removeAll()
        waiting.forEach { $0.resume(throwing: URLError(.networkConnectionLost)) }
    }

    private func cancel(_ id: UUID) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(throwing: CancellationError())
        cancelled.yield(id)
    }
}

private struct AcceptedSendConnector: WebSocketConnecting {
    let socket: AcceptedSendSocket
    let peer: AcceptedSendSocket
    func connect(to url: URL) -> any WebSocketConnection {
        url.host == "accepted-peer.example" ? peer : socket
    }
}

private actor AcceptedSendSocket: WebSocketConnection {
    nonisolated let heldInterrupts: AsyncStream<Void>
    private let interruptReceipts: AsyncStream<Void>.Continuation
    private var holdsInterrupts = false
    private var rejectsInterrupts = false
    private var pendingInterruptResponses: [Data] = []

    private let supportsPagination: Bool
    init(supportsPagination: Bool = false) {
        self.supportsPagination = supportsPagination
        (heldInterrupts, interruptReceipts) = AsyncStream.makeStream()
    }
    func holdInterruptAcknowledgements() { holdsInterrupts = true }
    func rejectInterruptAcknowledgements() { rejectsInterrupts = true }
    func releaseInterruptAcknowledgements() {
        holdsInterrupts = false
        let responses = pendingInterruptResponses
        pendingInterruptResponses.removeAll()
        responses.forEach { enqueue($0) }
    }
    private(set) var commands: [JSONValue] = []
    private var queued: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var receiverID: UUID?

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        let tag = request["tag"]?.stringValue
        if tag == RPCMethod.serverGetConfig.rawValue || tag == RPCMethod.subscribeServerConfig.rawValue,
           let response = try retryConfigResponse(for: request, supportsPagination: supportsPagination) {
            enqueue(response)
        } else if tag == RPCMethod.dispatchCommand.rawValue, let payload = request["payload"] {
            commands.append(payload)
            let isInterrupt = payload["type"]?.stringValue == "thread.turn.interrupt"
            let exit: JSONValue = isInterrupt && rejectsInterrupts
                ? .object(["_tag": .string("Failure"), "cause": .array([
                    .object(["_tag": .string("Fail"), "error": .object(["message": .string("Stop rejected by fixture")])]),
                ])])
                : .object(["_tag": .string("Success"), "value": .object(["sequence": .number(2)])])
            let response = try JSONEncoder.t3.encode(JSONValue.object([
                "_tag": .string("Exit"), "requestId": request["id"]!, "exit": exit,
            ]))
            if isInterrupt && holdsInterrupts {
                pendingInterruptResponses.append(response)
                interruptReceipts.yield(())
            } else { enqueue(response) }
        }
    }

    func receive() async throws -> Data {
        if !queued.isEmpty { return queued.removeFirst() }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                // This fixture reuses its socket across connector generations.
                receiver?.resume(throwing: CancellationError())
                receiver = continuation
                receiverID = id
            }
        } onCancel: {
            Task { await self.cancelReceive(id) }
        }
    }

    private func cancelReceive(_ id: UUID) {
        guard receiverID == id else { return }
        receiver?.resume(throwing: CancellationError())
        receiver = nil
        receiverID = nil
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
        receiverID = nil
    }

    private func enqueue(_ data: Data) {
        if let receiver { self.receiver = nil; receiverID = nil; receiver.resume(returning: data) }
        else { queued.append(data) }
    }
}

@MainActor
private final class CapturedStopProjectionReceipt {
    let model: FeatureRootModel
    let threadID: String
    private var continuation: CheckedContinuation<Void, Never>?

    init(model: FeatureRootModel, threadID: String) {
        self.model = model
        self.threadID = threadID
    }

    func wait() async {
        await withCheckedContinuation { continuation = $0; observe() }
    }

    private func observe() {
        guard continuation != nil else { return }
        let ready = withObservationTracking {
            model.snapshot.threads.first { $0.id == threadID }?.latestTurnState == "interrupted"
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.observe() }
        }
        if ready { continuation?.resume(); continuation = nil }
    }
}
