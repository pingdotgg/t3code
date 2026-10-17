import Foundation
import XCTest
@testable import T3Code

@MainActor
final class FeatureV2TimelineTests: XCTestCase {
    func testEqualTimesPreserveInterleavedProjectedOrderAndAllWorkItems() throws {
        let before = command("before", ordinal: 1)
        let answer = V2Fixture.assistant("answer", ordinal: 2)
        let after = (3...52).map { command("tool-\($0)", ordinal: $0) }
        let thread = try snapshot([before, answer] + after)
        let renderer = FeatureV2TimelineRenderer()
        let messages = render(thread, renderer: renderer)
        XCTAssertEqual(messages.count, 3)
        XCTAssertEqual(messages[0].v2WorkItems?.map(\.source.itemID), ["before"])
        XCTAssertEqual(messages[1].id, "message-answer")
        XCTAssertEqual(messages[2].v2WorkItems?.count, 50)
        XCTAssertEqual(messages[2].v2WorkItems?.last?.source.itemID, "tool-52")
    }

    func testInheritedSourceMetadataAndForkMarkerIgnoreTimestampOrder() throws {
        let inherited = V2Fixture.patch(V2Fixture.assistant("source", ordinal: 1), [
            "threadId": .string("origin"), "runId": .string("origin-run"),
            "updatedAt": .string("2027-01-01T00:00:00Z"),
        ])
        let marker = V2Fixture.item("fork", type: "fork", ordinal: 0, fields: [
            "source": .object(["type": .string("run"), "threadId": .string("origin"), "runId": .string("origin-run")]),
            "targetThreadId": .string("thread"),
        ])
        let local = command("local", ordinal: 2)
        let thread = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [marker, local], fields: [
            "visibleTurnItems": .array([V2Fixture.row(inherited, visibility: "inherited"), V2Fixture.row(marker, position: 1), V2Fixture.row(local, position: 2)]),
        ])).normalizedSnapshot().thread
        let messages = render(thread, renderer: FeatureV2TimelineRenderer())
        XCTAssertEqual(messages.map { $0.v2Timeline?.itemID }, ["source", "fork", "local"])
        let source = try XCTUnwrap(messages[0].v2Timeline)
        XCTAssertEqual(source.sourceThreadID, "origin")
        XCTAssertEqual(source.runID, "origin-run")
        XCTAssertEqual(source.visibility, "inherited")
        XCTAssertEqual(source.position, 0)
    }

    func testContentOnlyUpdatesPatchOneRowAndHistoryRebuildsOrder() throws {
        let assistant = V2Fixture.assistant("answer", ordinal: 3)
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.patch(
            V2Fixture.snapshot(items: [command("tool", ordinal: 2), assistant]),
            ["historyCursor": .string("older"), "hasMoreHistory": .bool(true)]
        ))
        let renderer = FeatureV2TimelineRenderer()
        var mappedCount = 0
        func map(_ raw: OrchestrationMessage) -> FeatureMessage {
            mappedCount += 1
            return FeatureMessage(id: raw.id, role: .assistant, text: raw.text)
        }
        _ = renderer.update(thread: state.normalizedSnapshot().thread, changedMessages: nil, changedActivities: nil, mapMessage: map, date: { _ in .distantPast })
        mappedCount = 0
        _ = state.apply([V2Fixture.event("turn-item.updated", payload: V2Fixture.patch(assistant, ["text": .string("Next token")]), sequence: 11)])
        let next = state.normalizedSnapshot().thread
        let patched = renderer.update(thread: next, changedMessages: next.messages, changedActivities: [], mapMessage: map, date: { _ in .distantPast })
        XCTAssertEqual(mappedCount, 1)
        XCTAssertFalse(renderer.rebuilt)
        XCTAssertEqual(renderer.changedMessageIDs, ["message-answer"])
        XCTAssertEqual(patched.last?.text, "Next token")
        let older = V2Fixture.user("older", ordinal: 1)
        XCTAssertTrue(try state.appendHistory(.object([
            "snapshotSequence": .number(11), "items": .array([V2Fixture.row(older)]),
            "nextCursor": .null, "hasMoreHistory": .bool(false),
        ]), beforeCursor: "older"))
        let loaded = state.normalizedSnapshot().thread
        let history = render(loaded, renderer: renderer)
        XCTAssertEqual(history.map { $0.v2Timeline?.itemID }, ["older", "tool", "answer"])
        XCTAssertEqual(history.map { $0.v2Timeline?.position }, [0, 1, 2])
        XCTAssertEqual(history.last?.text, "Next token")
    }

    func testRollbackRemovesRenderedWorkAndCachedGroups() throws {
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(
            items: [command("tool", ordinal: 1), V2Fixture.assistant("answer", ordinal: 2)],
            fields: ["runs": .array([V2Fixture.run()])]
        ))
        let renderer = FeatureV2TimelineRenderer()
        XCTAssertEqual(render(state.normalizedSnapshot().thread, renderer: renderer).count, 2)
        _ = state.apply([V2Fixture.event("run.updated", payload: V2Fixture.run(status: "rolled_back"), sequence: 11)])
        XCTAssertTrue(render(state.normalizedSnapshot().thread, renderer: renderer).isEmpty)
        XCTAssertTrue(renderer.messageIndexByID.isEmpty)
    }

    func testRequestHistorySurvivesResolutionAndFoldsAsyncAnswerDuplicate() throws {
        let answer: JSONValue = .object([
            "requestId": .string("question"), "answers": .object(["choice": .string("Server")]),
            "questionTextById": .object(["choice": .string("Which part?")]),
            "attachmentsByQuestionId": .object([:]),
        ])
        let request = V2Fixture.item("request", type: "user_input_request", ordinal: 1, fields: [
            "requestId": .string("question"), "questions": .array([]), "status": .string("completed"), "questionAnswer": answer,
        ])
        let duplicate = V2Fixture.patch(V2Fixture.user("duplicate", ordinal: 2), ["messageId": .string("async-answer:question")])
        let thread = try snapshot([request, duplicate])
        XCTAssertTrue(thread.messages.isEmpty)
        let rendered = render(thread, renderer: FeatureV2TimelineRenderer())
        XCTAssertEqual(rendered.count, 1)
        XCTAssertEqual(rendered[0].v2WorkItems?.first?.raw["questionAnswer"], answer)
    }

    func testTerminalCompactionSettlesOnlyItsLocalRunWhileSessionIsRunning() throws {
        let user = V2Fixture.patch(V2Fixture.user("compact", ordinal: 1), ["text": .string("/compact")])
        let compaction = V2Fixture.item("compaction", type: "compaction", ordinal: 2, fields: [
            "driver": .null, "status": .string("completed"), "beforeTokenCount": .number(1000), "afterTokenCount": .number(100),
        ])
        let thread = try snapshot([user, compaction])
        var tracker = NativeContextCompactionState()
        let timestamp = try XCTUnwrap(NativeTimestampParser.parse(V2Fixture.now))
        tracker.apply(try XCTUnwrap(thread.messages.first), createdAt: timestamp)
        XCTAssertTrue(tracker.isActive(sessionStatus: "running", latestTurnState: "running", latestTurnRequestedAt: timestamp))
        var unrelated = try XCTUnwrap(thread.activities.first)
        unrelated.v2Timeline?.runID = "other-run"
        tracker.apply(unrelated)
        XCTAssertTrue(tracker.isActive(sessionStatus: "running", latestTurnState: "running", latestTurnRequestedAt: timestamp))
        tracker.apply(try XCTUnwrap(thread.activities.first))
        XCTAssertFalse(tracker.isActive(sessionStatus: "running", latestTurnState: "running", latestTurnRequestedAt: timestamp))
    }

    func testCompletedTurnFoldRestoresOrderAndKeepsFirstAndFinalReplies() throws {
        let thread = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [
            V2Fixture.assistant("first", ordinal: 1), command("tool", ordinal: 2),
            V2Fixture.assistant("middle", ordinal: 3), command("next", ordinal: 4), V2Fixture.assistant("final", ordinal: 5),
        ].map { V2Fixture.patch($0, ["status": .string("completed"), "streaming": .bool(false)]) }, fields: ["runs": .array([V2Fixture.run(status: "completed")])])).normalizedSnapshot().thread
        let messages = render(thread, renderer: FeatureV2TimelineRenderer())
        let folded = FeatureV2TurnFolding.messages(messages, expandedIDs: [])
        XCTAssertEqual(folded.first?.id, "message-first")
        XCTAssertEqual(folded.last?.id, "message-final")
        XCTAssertEqual(folded.count, 3)
        let foldID = try XCTUnwrap(folded[1].v2FoldID)
        let expanded = FeatureV2TurnFolding.messages(messages, expandedIDs: [foldID])
        XCTAssertEqual(expanded.filter { $0.v2FoldID == nil }.map(\.id), messages.map(\.id))
    }

    func testFailedToolBreaksAnAdjacentGroupWithoutMovingOtherRows() throws {
        let first = command("one", ordinal: 1)
        let second = command("two", ordinal: 2)
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [first, second]))
        let renderer = FeatureV2TimelineRenderer()
        XCTAssertEqual(render(state.normalizedSnapshot().thread, renderer: renderer).count, 1)
        _ = state.apply([V2Fixture.event("turn-item.updated", payload: V2Fixture.patch(second, ["exitCode": .number(1)]), sequence: 11)])
        let next = state.normalizedSnapshot().thread
        let messages = renderer.update(thread: next, changedMessages: [], changedActivities: next.activities,
            mapMessage: { FeatureMessage(id: $0.id, role: .assistant, text: $0.text) }, date: { _ in .distantPast })
        XCTAssertTrue(renderer.rebuilt)
        XCTAssertEqual(messages.flatMap { $0.v2WorkItems?.map(\.source.itemID) ?? [] }, ["one", "two"])
        XCTAssertEqual(messages.count, 2)
    }

    func testRecoveryControlsRetainLocalFailureOutsideVisibleHistory() throws {
        let failure = V2Fixture.item("limit", type: "error", ordinal: 1, fields: [
            "status": .string("failed"), "failure": .object([
                "class": .string("usage_limit"), "code": .string("rate_limit"), "message": .string("Limited"),
                "retryable": .bool(true),
                "resetAt": .string("2026-10-05T00:00:00Z"),
            ]),
        ])
        let state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: [
            "runs": .array([V2Fixture.run(status: "failed")]), "turnItems": .array([failure]),
        ]))
        let thread = state.normalizedSnapshot().thread
        XCTAssertTrue(thread.activities.isEmpty)
        XCTAssertEqual(thread.orchestrationV2Control?["recoveryTurnItems"]?.v2Array?.count, 1)
        XCTAssertEqual(FeatureThreadRecovery(thread: thread)?.usageLimit?.runID, "run")
        XCTAssertEqual(thread.orchestrationV2Control?["lifecycle"]?["lastErrorClass"], .string("usage_limit"))
    }

    func testRichRowsBreakWorkGroupsAndRemainVisibleOutsideCompletedTurnFolds() throws {
        let html = V2Fixture.item("html", type: "dynamic_tool", ordinal: 2, fields: [
            "status": .string("completed"), "toolName": .string("mcp__t3_code__html_render"),
            "input": .object([:]), "outputOmitted": .bool(true),
            "output": .object(["htmlRender": .object([
                "attachmentId": .string("page"), "title": .string("Page"), "height": .number(300),
            ])]),
        ])
        let mcp = V2Fixture.item("app", type: "dynamic_tool", ordinal: 4, fields: [
            "status": .string("completed"), "toolName": .string("maps.show"), "input": .object([:]),
            "output": .object(["t3McpApp": .object([
                "attachmentId": .string("app-page"), "server": .string("maps"), "tool": .string("show"),
                "resourceUri": .string("ui://maps/view"),
            ]), "result": .object(["content": .array([])])]),
        ])
        let secret = V2Fixture.item("secret", type: "secret_request", ordinal: 6, fields: [
            "status": .string("completed"), "label": .string("Key"), "reason": .string("Connect"),
            "secretStatus": .string("saved"),
        ])
        let items = [command("before", ordinal: 1), html, command("middle", ordinal: 3), mcp,
                     command("after", ordinal: 5), secret]
        let thread = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: items, fields: [
            "runs": .array([V2Fixture.run(status: "completed")]),
        ])).normalizedSnapshot().thread
        let messages = render(thread, renderer: FeatureV2TimelineRenderer())
        XCTAssertEqual(messages.map { $0.v2Timeline?.itemID }, ["before", "html", "middle", "app", "after", "secret"])
        let folded = FeatureV2TurnFolding.messages(messages, expandedIDs: [])
        XCTAssertEqual(folded.filter { $0.v2FoldID == nil }.map { $0.v2Timeline?.itemID }, ["html", "app", "secret"])
        let expanded = FeatureV2TurnFolding.messages(messages, expandedIDs: Set(folded.compactMap(\.v2FoldID)))
        XCTAssertEqual(expanded.filter { $0.v2FoldID == nil }.map(\.id), messages.map(\.id))
    }

    func testInheritedHTMLRemainsBetweenWorkRowsWithOriginalSource() throws {
        let html = V2Fixture.item("page", type: "dynamic_tool", ordinal: 2, fields: [
            "threadId": .string("origin"), "status": .string("completed"),
            "toolName": .string("mcp__t3_code__html_render"), "input": .object([:]),
            "output": .object(["htmlRender": .object([
                "attachmentId": .string("page"), "title": .string("Page"), "height": .number(300),
            ])]),
        ])
        let before = command("before", ordinal: 1)
        let after = command("after", ordinal: 3)
        let snapshot = V2Fixture.snapshot(items: [before, after], fields: [
            "visibleTurnItems": .array([V2Fixture.row(before), V2Fixture.row(html, visibility: "inherited", position: 1), V2Fixture.row(after, position: 2)]),
        ])
        let thread = try OrchestrationV2ThreadState(snapshot: snapshot).normalizedSnapshot().thread
        let messages = render(thread, renderer: FeatureV2TimelineRenderer())
        XCTAssertEqual(messages.map { $0.v2Timeline?.itemID }, ["before", "page", "after"])
        XCTAssertEqual(messages[1].v2Timeline?.sourceThreadID, "origin")
        XCTAssertEqual(messages[1].v2Timeline?.visibility, "inherited")
        XCTAssertTrue(messages[1].v2WorkItems?.first?.isStandaloneContent == true)
    }

    private func command(_ id: String, ordinal: Int) -> JSONValue {
        V2Fixture.item(id, type: "command_execution", ordinal: ordinal, fields: [
            "input": .string("echo \(id)"), "output": .string(String(repeating: "complete output\n", count: 30)),
            "status": .string("completed"),
        ])
    }

    private func snapshot(_ items: [JSONValue]) throws -> OrchestrationThread {
        try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: items)).normalizedSnapshot().thread
    }

    private func render(_ thread: OrchestrationThread, renderer: FeatureV2TimelineRenderer) -> [FeatureMessage] {
        renderer.update(thread: thread, changedMessages: nil, changedActivities: nil, mapMessage: { raw in
            FeatureMessage(id: raw.id, role: raw.role == "user" ? .user : raw.role == "system" ? .system : .assistant,
                text: raw.text, state: raw.streaming ? .streaming : .complete)
        }, date: { NativeTimestampParser.parse($0) ?? .distantPast })
    }
}
