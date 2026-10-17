import Foundation
import XCTest
@testable import T3Code

final class OrchestrationV2ProjectionTests: XCTestCase {
    func testUnknownItemsAreSkippedInSnapshotsAndHistoryWithoutLosingCursors() throws {
        let known = V2Fixture.assistant("answer", ordinal: 2)
        // No known base fields are needed on an unknown variant.
        let unknown: JSONValue = .object(["type": .string("future_item")])
        let state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [unknown, known]))
        XCTAssertEqual(state.projection.turnItems.map(\.id), ["answer"])
        XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["answer"])
        XCTAssertEqual(state.normalizedSnapshot().thread.messages.first?.text, "Answer")
        for rows in [[V2Fixture.row(unknown)], [V2Fixture.row(unknown), V2Fixture.row(known)]] {
            let page = try JSONValue.object([
                "snapshotSequence": .number(12), "items": .array(rows),
                "nextCursor": .string("older"), "hasMoreHistory": .bool(true),
            ]).decode(OrchestrationV2ThreadHistoryPage.self)
            XCTAssertEqual(page.items.count, rows.count - 1)
            XCTAssertEqual(page.nextCursor, "older")
            XCTAssertTrue(page.hasMoreHistory)
            XCTAssertEqual(page.snapshotSequence, 12)
        }
    }

    func testAllUnknownHistoryPageAdvancesHistoryCursorButNotLiveSequence() throws {
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.patch(V2Fixture.snapshot(), [
            "historyCursor": .string("cursor"), "hasMoreHistory": .bool(true),
        ]))
        let page: JSONValue = .object([
            "snapshotSequence": .number(9),
            "items": .array([.object(["item": .object(["type": .string("future_item")])])]),
            "nextCursor": .string("older"), "hasMoreHistory": .bool(true),
        ])
        XCTAssertTrue(try state.appendHistory(page, beforeCursor: "cursor"))
        XCTAssertEqual(state.historyCursor, "older")
        XCTAssertTrue(state.hasMoreHistory)
        XCTAssertEqual(state.snapshotSequence, 10)
        XCTAssertTrue(state.projection.visibleTurnItems.isEmpty)
        let final = V2Fixture.patch(page, ["nextCursor": .null, "hasMoreHistory": .bool(false)])
        XCTAssertTrue(try state.appendHistory(final, beforeCursor: "older"))
        XCTAssertNil(state.historyCursor)
        XCTAssertFalse(state.hasMoreHistory)
    }

    func testMalformedKnownItemsAndDiscriminatorsFailEveryArrayBoundary() throws {
        let malformed = V2Fixture.patch(V2Fixture.assistant("bad", ordinal: 1), ["text": .number(2)])
        for item in [malformed, .object([:]), .object(["type": .null]), .object(["type": .number(4)])] {
            for key in ["turnItems", "visibleTurnItems"] {
                let rows = key == "turnItems" ? [item] : [V2Fixture.row(item)]
                XCTAssertThrowsError(try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: [key: .array(rows)])))
            }
            XCTAssertThrowsError(try JSONValue.object([
                "snapshotSequence": .number(10), "items": .array([V2Fixture.row(item)]),
                "nextCursor": .null, "hasMoreHistory": .bool(false),
            ]).decode(OrchestrationV2ThreadHistoryPage.self))
        }
    }

    func testUnknownLiveItemConsumesSequenceAndLaterKnownItemStillApplies() throws {
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot())
        let result = state.apply([
            V2Fixture.event("turn-item.updated", payload: .object(["type": .string("future_item")]), sequence: 11),
            V2Fixture.event("turn-item.updated", payload: V2Fixture.assistant("answer", ordinal: 1), sequence: 12),
        ])
        XCTAssertFalse(result.refreshRequired)
        XCTAssertEqual(state.snapshotSequence, 12)
        XCTAssertEqual(state.projection.turnItems.map(\.id), ["answer"])
        for bad in [V2Fixture.patch(V2Fixture.assistant("bad", ordinal: 2), ["text": .null]),
                    .object([:]), .object(["type": .number(1)])] {
            XCTAssertTrue(state.apply([V2Fixture.event("turn-item.updated", payload: bad, sequence: 13)]).refreshRequired)
            XCTAssertEqual(state.snapshotSequence, 12)
        }
        let unknown = V2Fixture.event("turn-item.updated", payload: .object(["type": .string("future_item")]), sequence: 13)
        let wrongThread = V2Fixture.patch(unknown, ["event": V2Fixture.patch(unknown["event"] ?? .null, ["threadId": .string("other")])])
        XCTAssertTrue(state.apply([wrongThread]).refreshRequired)
        XCTAssertEqual(state.snapshotSequence, 12)
        var badEnvelope = try XCTUnwrap(unknown["event"]).v2Object
        badEnvelope.removeValue(forKey: "id")
        XCTAssertTrue(state.apply([V2Fixture.patch(unknown, ["event": .object(badEnvelope)])]).refreshRequired)
        XCTAssertEqual(state.snapshotSequence, 12)
    }

    func testSecretRequestsDecodeAndUpdateWithoutRuntimeRequests() throws {
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [V2Fixture.assistant("answer", ordinal: 1)]))
        for (index, status) in ["pending", "saved", "declined", "cancelled"].enumerated() {
            let secret = V2Fixture.item("secret", type: "secret_request", ordinal: 2, fields: [
                "label": .string("API key"), "reason": .string("Authenticate the service"),
                "placeholder": .string("Paste key"), "secretStatus": .string(status),
            ])
            let snapshot = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [secret]))
            guard case let .secretRequest(request) = snapshot.projection.turnItems.first?.content else {
                return XCTFail("Expected typed secret metadata")
            }
            XCTAssertEqual(request.status.rawValue, status)
            XCTAssertEqual(request.label, "API key")
            XCTAssertFalse(state.apply([V2Fixture.event("turn-item.updated", payload: secret, sequence: 11 + index)]).refreshRequired)
            let activity = try XCTUnwrap(state.normalizedSnapshot().thread.activities.first { $0.kind == "secret.request" })
            XCTAssertEqual(activity.v2Item?["secretStatus"], .string(status))
            XCTAssertEqual(activity.v2Timeline?.sourceThreadID, "thread")
            XCTAssertEqual(activity.v2Timeline?.itemID, "secret")
            XCTAssertEqual(state.normalizedSnapshot().thread.messages.first?.text, "Answer")
        }
        let bad = V2Fixture.item("bad", type: "secret_request", ordinal: 3, fields: [
            "label": .string("API key"), "reason": .string("Required"), "secretStatus": .string("unknown"),
        ])
        XCTAssertThrowsError(try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [bad])))
    }

    func testInheritedAndSyntheticSecretRowsRetainSourceIdentityAndStatus() throws {
        let secret = V2Fixture.item("secret", type: "secret_request", ordinal: 1, fields: [
            "threadId": .string("parent"), "label": .string("API key"),
            "reason": .string("Connect"), "secretStatus": .string("pending"),
        ])
        for visibility in ["inherited", "synthetic"] {
            let snapshot = V2Fixture.snapshot(fields: ["visibleTurnItems": .array([V2Fixture.row(secret, visibility: visibility)])])
            let activity = try XCTUnwrap(OrchestrationV2ThreadState(snapshot: snapshot).normalizedSnapshot().thread.activities.first)
            XCTAssertEqual(activity.kind, "secret.request")
            XCTAssertEqual(activity.v2Timeline?.sourceThreadID, "parent")
            XCTAssertEqual(activity.v2Timeline?.itemID, "secret")
            XCTAssertEqual(activity.v2Timeline?.visibility, visibility)
            XCTAssertEqual(activity.v2Item?["secretStatus"], .string("pending"))
        }
    }

    func testRealContractFixturesMatchClientRuntimeProjectionAndHistory() throws {
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.load("v2-thread-bounded-snapshot"))
        let frames = try XCTUnwrap(try V2Fixture.load("v2-thread-stream-events").v2Array)
        let result = state.apply(frames)
        XCTAssertFalse(result.refreshRequired)
        XCTAssertTrue(result.synchronized)
        let expected = try V2Fixture.load("v2-thread-after-events-snapshot")
        XCTAssertEqual(state.projection.raw, expected["projection"])
        XCTAssertEqual(state.snapshotSequence, expected["snapshotSequence"]?.v2Int)
        XCTAssertEqual(state.latestLocalTurnOrdinal, expected["latestLocalTurnOrdinal"]?.v2Int)
        let cursor = try XCTUnwrap(state.historyCursor)
        XCTAssertTrue(try state.appendHistory(V2Fixture.load("v2-thread-older-history"), beforeCursor: cursor))
        let withHistory = try V2Fixture.load("v2-thread-with-history-snapshot")
        XCTAssertEqual(state.projection.raw, withHistory["projection"])
        XCTAssertEqual(state.snapshotSequence, withHistory["snapshotSequence"]?.v2Int)
        XCTAssertNil(state.historyCursor)
        XCTAssertFalse(state.hasMoreHistory)
    }

    func testSocketSnapshotUsesSameTypedDecoderAsBoundedHTTP() throws {
        let state = try OrchestrationV2ThreadState(snapshot: V2Fixture.load("v2-thread-stream-snapshot"))
        let http = try OrchestrationV2ThreadState(snapshot: V2Fixture.load("v2-thread-bounded-snapshot"))
        XCTAssertEqual(state.projection, http.projection)
        XCTAssertEqual(state.normalizedSnapshot(), http.normalizedSnapshot())
    }

    func testUnknownEventsAdvanceCursorAndMalformedKnownEventsRequestRefresh() throws {
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot())
        let result = state.apply([
            V2Fixture.event("future.event", payload: .null, sequence: 11),
            V2Fixture.event("run.updated", payload: .object(["id": .string("broken")]), sequence: 12),
            V2Fixture.event("future.event", payload: .null, sequence: 13),
        ])
        XCTAssertTrue(result.refreshRequired)
        XCTAssertEqual(state.snapshotSequence, 11)
        XCTAssertTrue(state.projection.runs.isEmpty)
        XCTAssertFalse(result.changed)
    }

    func testBatchReplaysOnlyNewCommittedItemsAndKeepsStableDisplayIDs() throws {
        let first = V2Fixture.assistant("answer", ordinal: 1, text: "Hello")
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [first]))
        let id = try XCTUnwrap(state.normalizedSnapshot().thread.messages.first?.id)
        let result = state.apply([
            V2Fixture.event("turn-item.updated", payload: V2Fixture.patch(first, ["text": .string("ignored")]), sequence: 10),
            V2Fixture.event("turn-item.updated", payload: V2Fixture.patch(first, ["text": .string("Hello, ")]), sequence: 11),
            V2Fixture.event("turn-item.updated", payload: V2Fixture.patch(first, ["text": .string("Hello, world")]), sequence: 12),
            .object(["kind": .string("synchronized")]),
        ])
        XCTAssertFalse(result.refreshRequired)
        XCTAssertTrue(result.synchronized)
        XCTAssertFalse(result.requiresTimelineRebuild)
        XCTAssertEqual(result.changedItemIDs, ["answer"])
        XCTAssertEqual(state.normalizedSnapshot().thread.messages.first?.id, id)
        XCTAssertEqual(state.normalizedSnapshot().thread.messages.first?.text, "Hello, world")
        XCTAssertEqual(state.projection.visibleTurnItems.count, 1)
        XCTAssertEqual(state.projection.raw["turnItems"]?.v2Array?.first?["text"], .string("Hello, world"))
    }

    func testVisibilityMatchesRollbackCancelledQueueAndSupersededInterruptRules() throws {
        let answer = V2Fixture.assistant("answer", ordinal: 1)
        let queued = V2Fixture.user("queued", ordinal: 2, intent: "queued_turn", runID: "queue")
        let stop = V2Fixture.item("stop", type: "run_interrupt_result", ordinal: 3, fields: ["message": .string("Interrupted")])
        let runs = [V2Fixture.run(), V2Fixture.run("queue", status: "cancelled", ordinal: 2)]
        let attempt = V2Fixture.attempt(status: "superseded")
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [answer, queued, stop], fields: ["runs": .array(runs), "attempts": .array([attempt])]))
        XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["answer"])
        let request = V2Fixture.item("request", type: "run_interrupt_request", ordinal: 4, fields: ["message": .string("Stop")])
        _ = state.apply([V2Fixture.event("turn-item.updated", payload: request, sequence: 11),
                         V2Fixture.event("turn-item.updated", payload: stop, sequence: 12)])
        XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["answer", "stop", "request"])
        _ = state.apply([V2Fixture.event("run.updated", payload: V2Fixture.run(status: "rolled_back"), sequence: 13)])
        XCTAssertTrue(state.projection.visibleTurnItems.isEmpty)
        XCTAssertTrue(state.normalizedSnapshot().thread.messages.isEmpty)
    }

    func testFailedAttemptsKeepTheirOutputAndInheritedRowsSurviveLocalRollback() throws {
        let local = V2Fixture.assistant("local", ordinal: 1)
        let inherited = V2Fixture.patch(V2Fixture.assistant("inherited", ordinal: 1), ["threadId": .string("parent")])
        var snapshot = V2Fixture.snapshot(items: [local], fields: ["runs": .array([V2Fixture.run(status: "failed")]), "attempts": .array([V2Fixture.attempt(status: "failed")])])
        snapshot = V2Fixture.projectionPatch(snapshot, ["visibleTurnItems": .array([V2Fixture.row(inherited, visibility: "inherited"), V2Fixture.row(local, position: 1)])])
        var state = try OrchestrationV2ThreadState(snapshot: snapshot)
        XCTAssertEqual(state.normalizedSnapshot().thread.messages.count, 2)
        _ = state.apply([V2Fixture.event("run.updated", payload: V2Fixture.run(status: "rolled_back"), sequence: 11)])
        XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["inherited"])
        XCTAssertEqual(state.normalizedSnapshot().thread.messages.first?.streaming, false)
    }

    func testBoundedInheritedOnlySnapshotRejectsOldLocalUpdatesAndAdvancesWatermark() throws {
        let inherited = V2Fixture.patch(V2Fixture.assistant("parent-item", ordinal: 1), ["threadId": .string("parent")])
        var snapshot = V2Fixture.snapshot(fields: ["visibleTurnItems": .array([V2Fixture.row(inherited, visibility: "inherited")])])
        snapshot = V2Fixture.patch(snapshot, ["historyCursor": .string("older"), "hasMoreHistory": .bool(true), "latestLocalTurnOrdinal": .number(50)])
        var state = try OrchestrationV2ThreadState(snapshot: snapshot)
        let old = state.apply([V2Fixture.event("turn-item.updated", payload: V2Fixture.assistant("old", ordinal: 40), sequence: 11)])
        XCTAssertFalse(old.changed)
        XCTAssertEqual(state.snapshotSequence, 11)
        XCTAssertTrue(state.projection.turnItems.isEmpty)
        _ = state.apply([V2Fixture.event("turn-item.updated", payload: V2Fixture.assistant("new", ordinal: 51), sequence: 12)])
        XCTAssertEqual(state.latestLocalTurnOrdinal, 51)
        XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["parent-item", "new"])
    }

    func testHistoryMergePreservesLiveRowsDoesNotAdvanceStreamCursorAndRejectsOldCursor() throws {
        let live = V2Fixture.assistant("live", ordinal: 3, text: "Live")
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.patch(V2Fixture.snapshot(items: [live]), ["historyCursor": .string("older"), "hasMoreHistory": .bool(true), "latestLocalTurnOrdinal": .number(3)]))
        let older = V2Fixture.assistant("older", ordinal: 1, text: "Older")
        let staleLive = V2Fixture.patch(live, ["text": .string("Stale")])
        let page: JSONValue = .object(["snapshotSequence": .number(999), "items": .array([V2Fixture.row(older), V2Fixture.row(staleLive)]), "nextCursor": .null, "hasMoreHistory": .bool(false)])
        XCTAssertFalse(try state.appendHistory(page, beforeCursor: "wrong"))
        XCTAssertTrue(try state.appendHistory(page, beforeCursor: "older"))
        XCTAssertEqual(state.snapshotSequence, 10)
        XCTAssertEqual(state.normalizedSnapshot().thread.messages.map(\.text), ["Older", "Live"])
        XCTAssertNil(state.historyCursor)
        XCTAssertFalse(state.hasMoreHistory)
        // Fully expanded history restores append-on-miss, even below the watermark.
        _ = state.apply([V2Fixture.event("turn-item.updated", payload: V2Fixture.assistant("middle", ordinal: 2), sequence: 11)])
        XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["older", "middle", "live"])
    }

    func testHistoryCannotResurrectRolledBackRowsAndRetainedInterruptDependencyUsesCurrentCopy() throws {
        let old = V2Fixture.assistant("old", ordinal: 1)
        let interrupt = V2Fixture.item("stop", type: "run_interrupt_request", ordinal: 2, fields: ["message": .string("Current stop")])
        let snapshot = V2Fixture.patch(V2Fixture.snapshot(fields: ["runs": .array([V2Fixture.run()]), "turnItems": .array([interrupt])]), ["historyCursor": .string("older"), "hasMoreHistory": .bool(true)])
        var state = try OrchestrationV2ThreadState(snapshot: snapshot)
        let page: JSONValue = .object(["snapshotSequence": .number(10), "items": .array([V2Fixture.row(old), V2Fixture.row(interrupt)]), "nextCursor": .null, "hasMoreHistory": .bool(false)])
        _ = state.apply([V2Fixture.event("run.updated", payload: V2Fixture.run(status: "rolled_back"), sequence: 11)])
        XCTAssertTrue(try state.appendHistory(page, beforeCursor: "older"))
        XCTAssertTrue(state.projection.visibleTurnItems.isEmpty)
        var active = try OrchestrationV2ThreadState(snapshot: snapshot)
        XCTAssertTrue(try active.appendHistory(page, beforeCursor: "older"))
        XCTAssertEqual(active.projection.visibleTurnItems.map(\.sourceItemId), ["old", "stop"])
    }

    func testProviderTurnTerminalUpdateRetainsUsageAndSessionDetachRemovesOnlyTarget() throws {
        let turn = V2Fixture.providerTurn(usage: .object(["usedTokens": .number(123), "updatedAt": .string(V2Fixture.now)]))
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: ["providerTurns": .array([turn]), "providerSessions": .array([V2Fixture.session("one"), V2Fixture.session("two")])]))
        let result = state.apply([
            V2Fixture.event("provider-turn.updated", payload: V2Fixture.providerTurn(status: "completed"), sequence: 11),
            V2Fixture.event("provider-session.detached", payload: .object(["providerSessionId": .string("one"), "detachedAt": .string(V2Fixture.now)]), sequence: 12),
        ])
        XCTAssertFalse(result.refreshRequired)
        XCTAssertEqual(state.projection.providerTurns.first?.tokenUsage?.usedTokens, 123)
        XCTAssertEqual(state.projection.providerSessions.map(\.id), ["two"])
        XCTAssertEqual(state.projection.raw["providerTurns"]?.v2Array?.first?["tokenUsage"]?["usedTokens"], .number(123))
    }

    func testMismatchedThreadAndStaleSnapshotDoNotReplaceState() throws {
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot())
        let event = V2Fixture.patch(V2Fixture.event("run.updated", payload: V2Fixture.run(), sequence: 11), ["event": .object(["id": .string("e"), "type": .string("run.updated"), "threadId": .string("other"), "occurredAt": .string(V2Fixture.now), "payload": V2Fixture.run()])])
        XCTAssertTrue(state.apply([event]).refreshRequired)
        XCTAssertEqual(state.snapshotSequence, 10)
        let stale = V2Fixture.patch(V2Fixture.snapshot(items: [V2Fixture.assistant("stale", ordinal: 1)]), ["kind": .string("snapshot"), "snapshotSequence": .number(9)])
        XCTAssertFalse(state.apply([stale]).changed)
        XCTAssertTrue(state.projection.visibleTurnItems.isEmpty)
    }
}

/// Wire-shaped fixtures follow orchestrationV2.ts, without adapter-only fields.
/// Helpers live in this owned test file so presentation tests use the same contract.
enum V2Fixture {
    static func load(_ name: String) throws -> JSONValue {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/Wire/\(name).json")
        return try JSONDecoder.t3.decode(JSONValue.self, from: Data(contentsOf: url))
    }

    static let now = "2026-09-01T12:00:00.000Z"
    static func patch(_ value: JSONValue, _ fields: [String: JSONValue]) -> JSONValue {
        .object(value.v2Object.merging(fields, uniquingKeysWith: { _, next in next }))
    }
    static func projectionPatch(_ snapshot: JSONValue, _ fields: [String: JSONValue]) -> JSONValue {
        patch(snapshot, ["projection": patch(snapshot["projection"] ?? .null, fields)])
    }
    static var thread: JSONValue {
        .object([
            "id": .string("thread"), "projectId": .string("project"), "title": .string("Thread"),
            "providerInstanceId": .string("codex"), "modelSelection": .object(["instanceId": .string("codex"), "model": .string("gpt-5.4")]),
            "runtimeMode": .string("full-access"), "interactionMode": .string("default"),
            "branch": .null, "worktreePath": .null, "activeProviderThreadId": .null,
            "lineage": .object(["parentThreadId": .null, "relationshipToParent": .null, "rootThreadId": .string("thread")]),
            "forkedFrom": .null, "createdBy": .string("user"), "creationSource": .string("mobile"),
            "createdAt": .string(now), "updatedAt": .string(now), "archivedAt": .null,
            "settledOverride": .null, "settledAt": .null, "lastVisitedAt": .null, "deletedAt": .null,
        ])
    }
    static func watchedPullRequest(_ number: Int = 1, source: String = "manual") -> JSONValue {
        .object([
            "host": .string("github.com"), "repository": .string("example/repo"), "number": .number(Double(number)),
            "url": .string("https://github.com/example/repo/pull/\(number)"), "source": .string(source),
            "linkedAt": .string(now), "snapshot": .null, "stack": .null,
            "watch": .object([
                "startedAt": .string(now), "headSha": .null, "failedChecks": .array([]), "passed": .bool(false),
                "remarksThrough": .string(now), "remarkIds": .array([]), "conflicting": .bool(false), "wakes": .number(0),
            ]),
        ])
    }
    static func snapshot(items: [JSONValue] = [], fields: [String: JSONValue] = [:]) -> JSONValue {
        var projection: [String: JSONValue] = ["thread": thread, "updatedAt": .string(now)]
        for key in ["runs", "attempts", "nodes", "subagents", "providerSessions", "providerThreads", "providerTurns", "runtimeRequests", "messages", "plans", "checkpointScopes", "checkpoints", "contextHandoffs", "contextTransfers"] { projection[key] = .array([]) }
        projection["turnItems"] = .array(items)
        projection["visibleTurnItems"] = .array(items.enumerated().map { row($0.element, position: $0.offset) })
        return .object(["snapshotSequence": .number(10), "projection": .object(projection.merging(fields, uniquingKeysWith: { _, next in next }))])
    }
    static func row(_ item: JSONValue, visibility: String = "local", position: Int = 0) -> JSONValue {
        .object(["position": .number(Double(position)), "visibility": .string(visibility), "sourceThreadId": item["threadId"] ?? .null, "sourceItemId": item["id"] ?? .null, "item": item])
    }
    static func item(_ id: String, type: String, ordinal: Int, fields: [String: JSONValue] = [:]) -> JSONValue {
        patch(.object([
            "id": .string(id), "type": .string(type), "threadId": .string("thread"), "runId": .string("run"), "nodeId": .string("root"),
            "providerThreadId": .null, "providerTurnId": .null, "nativeItemRef": .null, "parentItemId": .null,
            "ordinal": .number(Double(ordinal)), "status": .string("running"), "title": .null,
            "startedAt": .string(now), "completedAt": .null, "updatedAt": .string(now),
        ]), fields)
    }
    static func assistant(_ id: String, ordinal: Int, text: String = "Answer") -> JSONValue {
        item(id, type: "assistant_message", ordinal: ordinal, fields: ["messageId": .string("message-\(id)"), "text": .string(text), "streaming": .bool(true)])
    }
    static func user(_ id: String, ordinal: Int, intent: String = "turn_start", runID: String = "run") -> JSONValue {
        item(id, type: "user_message", ordinal: ordinal, fields: ["messageId": .string("message-\(id)"), "inputIntent": .string(intent), "text": .string("Question"), "attachments": .array([]), "createdBy": .string("user"), "creationSource": .string("mobile"), "runId": .string(runID)])
    }
    static func run(_ id: String = "run", status: String = "running", ordinal: Int = 1) -> JSONValue {
        .object(["id": .string(id), "threadId": .string("thread"), "ordinal": .number(Double(ordinal)), "providerInstanceId": .string("codex"),
                 "modelSelection": thread["modelSelection"] ?? .null, "providerThreadId": .string("provider-thread"), "userMessageId": .string("message-\(id)"),
                 "rootNodeId": .string("root"), "activeAttemptId": .string("attempt"), "status": .string(status), "requestedAt": .string(now),
                 "startedAt": status == "queued" ? .null : .string(now), "completedAt": .null, "checkpointId": .null, "contextHandoffId": .null])
    }
    static func attempt(status: String) -> JSONValue {
        .object(["id": .string("attempt"), "runId": .string("run"), "attemptOrdinal": .number(1), "rootNodeId": .string("root"),
                 "providerInstanceId": .string("codex"), "providerThreadId": .string("provider-thread"), "providerTurnId": .null,
                 "reason": .string("initial"), "status": .string(status), "startedAt": .string(now), "completedAt": .null])
    }
    static func event(_ type: String, payload: JSONValue, sequence: Int) -> JSONValue {
        .object(["kind": .string("event"), "sequence": .number(Double(sequence)), "event": .object([
            "id": .string("event-\(sequence)"), "threadId": .string("thread"), "type": .string(type), "occurredAt": .string(now), "payload": payload,
        ])])
    }
    static func request(_ id: String, kind: String = "command", status: String = "pending", response: String = "live") -> JSONValue {
        var capability: [String: JSONValue] = ["type": .string(response)]
        if response == "live" { capability["providerSessionId"] = .string("session") }
        if response == "not_resumable" { capability["reason"] = .string("Session stopped") }
        return .object(["id": .string(id), "nodeId": .string("root"), "providerTurnId": .null, "nativeRequestRef": .null,
                        "kind": .string(kind), "status": .string(status), "responseCapability": .object(capability),
                        "createdAt": .string(now), "resolvedAt": status == "pending" ? .null : .string(now)])
    }
    static func providerTurn(status: String = "running", usage: JSONValue? = nil) -> JSONValue {
        var fields: [String: JSONValue] = ["id": .string("provider-turn"), "providerThreadId": .string("provider-thread"), "nodeId": .string("root"), "runAttemptId": .string("attempt"), "nativeTurnRef": .null, "ordinal": .number(1), "status": .string(status), "startedAt": .string(now), "completedAt": .null]
        fields["tokenUsage"] = usage
        return .object(fields)
    }
    static func session(_ id: String) -> JSONValue {
        .object(["id": .string(id), "driver": .string("codex"), "providerInstanceId": .string("codex"), "status": .string("ready"),
                 "cwd": .string("/tmp"), "model": .null, "capabilities": .object([:]), "createdAt": .string(now), "updatedAt": .string(now), "lastError": .null])
    }
}
