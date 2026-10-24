import Foundation
import XCTest
@testable import T3Code

final class OrchestrationV2PartialRunOutputTests: XCTestCase {
    func testQueuedRunOutputSurvivesNewerSteerWatermark() throws {
        let steer = V2Fixture.user("steer", ordinal: 3_000_001, intent: "steer", runID: "steer-run")
        var state = try partialState(items: [steer], runs: [
            V2Fixture.run("queued-run", status: "queued", ordinal: 2),
            V2Fixture.run("steer-run", status: "completed", ordinal: 3),
        ])
        let user = V2Fixture.user("queued-user", ordinal: 2_000_001, runID: "queued-run")
        let reply = V2Fixture.patch(V2Fixture.assistant("queued-reply", ordinal: 2_000_002), [
            "runId": .string("queued-run"),
        ])
        let result = state.apply([
            V2Fixture.event("turn-item.updated", payload: user, sequence: 11),
            V2Fixture.event("run.updated", payload: V2Fixture.run("queued-run", status: "running", ordinal: 2), sequence: 12),
            V2Fixture.event("turn-item.updated", payload: reply, sequence: 13),
            V2Fixture.event("run.updated", payload: V2Fixture.run("queued-run", status: "completed", ordinal: 2), sequence: 14),
        ])

        XCTAssertFalse(result.refreshRequired)
        XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["queued-user", "queued-reply", "steer"])
        XCTAssertTrue(state.projection.turnItems.contains { $0.id == "queued-reply" })
        XCTAssertEqual(state.latestLocalTurnOrdinal, 3_000_003)
    }

    func testUnfinishedRunsKeepFirstOutputBelowWindow() throws {
        for status in ["preparing", "queued", "starting", "running", "waiting"] {
            let steer = V2Fixture.user("steer", ordinal: 3_000_001, runID: "steer-run")
            var state = try partialState(items: [steer], runs: [V2Fixture.run(status: status)])
            let result = state.apply([
                V2Fixture.event("turn-item.updated", payload: V2Fixture.assistant("reply", ordinal: 2_000_003), sequence: 11),
            ])

            XCTAssertFalse(result.refreshRequired, status)
            XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["reply", "steer"], status)
        }
    }

    func testFinishedRunKeepsMissingOutputAfterVisibleItem() throws {
        let first = V2Fixture.assistant("first", ordinal: 3_000_001)
        let later = V2Fixture.assistant("later", ordinal: 3_000_003)
        var state = try partialState(items: [first, later], runs: [V2Fixture.run(status: "completed")])
        let result = state.apply([
            V2Fixture.event("turn-item.updated", payload: V2Fixture.assistant("middle", ordinal: 3_000_002), sequence: 11),
        ])

        XCTAssertFalse(result.refreshRequired)
        XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["first", "middle", "later"])
    }

    func testFinishedRunDoesNotPullOlderUnloadedItemsIntoWindow() throws {
        let visible = V2Fixture.assistant("visible", ordinal: 3_000_003)
        let runIDs: [JSONValue] = [.string("run"), .string("other-run"), .null]
        for runID in runIDs {
            var state = try partialState(items: [visible], runs: [
                V2Fixture.run(status: "completed"), V2Fixture.run("other-run", status: "failed"),
            ])
            let old = V2Fixture.patch(V2Fixture.assistant("old", ordinal: 3_000_002), ["runId": runID])
            let result = state.apply([V2Fixture.event("turn-item.updated", payload: old, sequence: 11)])

            XCTAssertFalse(result.changed)
            XCTAssertFalse(result.refreshRequired)
            XCTAssertEqual(state.snapshotSequence, 11)
            XCTAssertEqual(state.projection.visibleTurnItems.map(\.sourceItemId), ["visible"])
            XCTAssertFalse(state.projection.turnItems.contains { $0.id == "old" })
        }
    }

    private func partialState(items: [JSONValue], runs: [JSONValue]) throws -> OrchestrationV2ThreadState {
        try OrchestrationV2ThreadState(snapshot: V2Fixture.patch(
            V2Fixture.snapshot(items: items, fields: ["runs": .array(runs)]),
            ["historyCursor": .string("older"), "hasMoreHistory": .bool(true), "latestLocalTurnOrdinal": .number(3_000_003)]
        ))
    }
}
