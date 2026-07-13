import Foundation
import Testing

@testable import T3Kit

@Suite("Thread health projection (session.health)")
struct ThreadHealthProjectionTests {
    private func healthActivity(
        id: String, state: String, at: String, lastActivityAt: String,
        stalledForMs: Int? = nil, sequence: Int? = nil
    ) -> OrchestrationThreadActivity {
        var payload: [String: JSONValue] = [
            "state": .string(state),
            "lastActivityAt": .string(lastActivityAt),
        ]
        if let stalledForMs {
            payload["stalledForMs"] = .int(stalledForMs)
        }
        return OrchestrationThreadActivity(
            id: id, tone: state == "stalled" ? .error : .info, kind: ActivityKind.sessionHealth,
            summary: "health", payload: .object(payload), sequence: sequence, createdAt: at)
    }

    @Test func noHealthActivitiesProjectNil() {
        let unrelated = OrchestrationThreadActivity(
            id: "a", tone: .info, kind: ActivityKind.taskStarted, summary: "s",
            payload: .object([:]), createdAt: "2026-07-04T10:00:00.000Z")
        #expect(ThreadHealthProjection.project(from: [unrelated]) == nil)
    }

    @Test func stalledActivityProjectsStalledWithOnset() {
        let stalled = healthActivity(
            id: "h1", state: "stalled", at: "2026-07-04T10:02:00.000Z",
            lastActivityAt: "2026-07-04T10:00:00.000Z", stalledForMs: 120_000)
        let health = ThreadHealthProjection.project(from: [stalled])
        #expect(health?.stalled == true)
        #expect(health?.lastActivityAt == WireDate.parse("2026-07-04T10:00:00.000Z"))
        #expect(health?.stalledSince == WireDate.parse("2026-07-04T10:00:00.000Z"))
    }

    @Test func newestTransitionWins() {
        let stalled = healthActivity(
            id: "h1", state: "stalled", at: "2026-07-04T10:02:00.000Z",
            lastActivityAt: "2026-07-04T10:00:00.000Z", sequence: 1)
        let recovered = healthActivity(
            id: "h2", state: "active", at: "2026-07-04T10:03:00.000Z",
            lastActivityAt: "2026-07-04T10:03:00.000Z", sequence: 2)
        // Out-of-order input still resolves to the newest by (createdAt, sequence).
        let health = ThreadHealthProjection.project(from: [recovered, stalled])
        #expect(health?.stalled == false)
        #expect(health?.stalledSince == nil)
    }

    @Test func sequenceBreaksSameTimestampTies() {
        let stalled = healthActivity(
            id: "h1", state: "stalled", at: "2026-07-04T10:02:00.000Z",
            lastActivityAt: "2026-07-04T10:00:00.000Z", sequence: 5)
        let recovered = healthActivity(
            id: "h2", state: "active", at: "2026-07-04T10:02:00.000Z",
            lastActivityAt: "2026-07-04T10:02:00.000Z", sequence: 6)
        let health = ThreadHealthProjection.project(from: [stalled, recovered])
        #expect(health?.stalled == false)
    }

    @Test func applyFoldsNewestAndIgnoresOlder() {
        let stalled = healthActivity(
            id: "h1", state: "stalled", at: "2026-07-04T10:02:00.000Z",
            lastActivityAt: "2026-07-04T10:00:00.000Z", sequence: 1)
        let recovered = healthActivity(
            id: "h2", state: "active", at: "2026-07-04T10:03:00.000Z",
            lastActivityAt: "2026-07-04T10:03:00.000Z", sequence: 2)

        var folded = ThreadHealthProjection.apply(stalled, onto: nil, priorSortKey: nil)
        #expect(folded.health?.stalled == true)
        folded = ThreadHealthProjection.apply(
            recovered, onto: folded.health, priorSortKey: folded.sortKey)
        #expect(folded.health?.stalled == false)
        // A stale re-delivery of the older stalled event must not regress state.
        let stale = ThreadHealthProjection.apply(
            stalled, onto: folded.health, priorSortKey: folded.sortKey)
        #expect(stale.health?.stalled == false)
    }

    @Test func malformedPayloadIsIgnored() {
        let broken = OrchestrationThreadActivity(
            id: "h1", tone: .error, kind: ActivityKind.sessionHealth, summary: "s",
            payload: .object(["state": .int(1)]), createdAt: "2026-07-04T10:00:00.000Z")
        #expect(ThreadHealthProjection.project(from: [broken]) == nil)
    }

    @Test func sessionExitedPayloadDecodes() {
        let activity = OrchestrationThreadActivity(
            id: "e1", tone: .error, kind: ActivityKind.sessionExited, summary: "exited",
            payload: .object([
                "stderrTail": .string("panic: boom\n"),
                "reason": .string("process exited with code 1"),
                "recoverable": .bool(false),
            ]),
            createdAt: "2026-07-04T10:00:00.000Z")
        let payload = activity.decodePayload(SessionExitedActivityPayload.self)
        #expect(payload?.stderrTail == "panic: boom\n")
        #expect(payload?.reason == "process exited with code 1")
        #expect(payload?.recoverable == false)
    }
}
