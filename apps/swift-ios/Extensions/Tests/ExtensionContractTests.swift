import Foundation
import XCTest
@testable import T3Code

final class ExtensionContractTests: XCTestCase {
    func testStaleActivityKeepsOutcomesButStopsClaimingLiveWork() {
        let rows = [T3AgentActivityPhase.running, .waitingForApproval, .completed, .failed].enumerated().map { index, phase in
            T3RelayAgentActivityAggregateRow(environmentId: "env", threadId: "\(index)",
                projectTitle: "Project", threadTitle: "Task", modelTitle: "Model",
                phase: phase, status: phase.rawValue, updatedAt: "2026-10-01T12:00:00Z", deepLink: "/")
        }
        let aggregate = T3RelayAgentActivityAggregateState(title: "T3", subtitle: "2 active", activeCount: 2,
            updatedAt: "2026-10-01T12:00:00Z", activities: rows)
        XCTAssertEqual(aggregate.presented(isStale: false), aggregate)
        let stale = aggregate.presented(isStale: true)
        XCTAssertEqual(stale.activeCount, 0)
        XCTAssertEqual(stale.activities.map(\.phase), [.stale, .stale, .completed, .failed])
        XCTAssertEqual(stale.activities[0].status, "Out of date")
    }

    func testLiveActivityDecodesTheRelayAPNSEnvelope() throws {
        let props = #"{"title":"T3 Code","subtitle":"2 active agents, 1 needs attention","activeCount":2,"updatedAt":"2026-08-01T12:00:00.000Z","activities":[{"environmentId":"env-1","threadId":"thread-working","projectTitle":"t3code","threadTitle":"Build the native app","modelTitle":"GPT-5.6 Sol","phase":"running","status":"Working","updatedAt":"2026-08-01T12:00:00.000Z","deepLink":"/env-1/thread-working"},{"environmentId":"env-2","threadId":"thread-approval","projectTitle":"uploadthing","threadTitle":"Ship upload recovery","modelTitle":"Claude Opus 5","phase":"waiting_for_approval","status":"Approval","updatedAt":"2026-08-01T11:59:00.000Z","deepLink":"/env-2/thread-approval"}]}"#
        let state = LiveActivityAttributes.ContentState(
            name: "AgentActivity",
            props: props
        )

        let aggregate = try XCTUnwrap(state.aggregate)
        XCTAssertEqual(aggregate.activeCount, 2)
        XCTAssertEqual(aggregate.activities.count, 2)
        XCTAssertEqual(aggregate.attentionFirstActivities.first?.threadId, "thread-approval")
        XCTAssertEqual(
            aggregate.attentionFirstActivities.first?.nativeDeepLinkURL?.absoluteString,
            "\(T3SharedContainer.urlScheme)://threads?environment=env-2&thread=thread-approval"
        )
    }

    func testLocalLiveActivityStatePreservesTheExactNameAndPropsKeys() throws {
        let aggregate = T3RelayAgentActivityAggregateState(
            title: "T3 Code",
            subtitle: "1 active agent",
            activeCount: 1,
            updatedAt: "2026-08-01T12:00:00.000Z",
            activities: []
        )
        let state = try LiveActivityAttributes.ContentState(aggregate: aggregate)
        let encoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any]
        )

        XCTAssertEqual(Set(encoded.keys), Set(["name", "props"]))
        XCTAssertEqual(encoded["name"] as? String, "AgentActivity")
        XCTAssertEqual(state.aggregate, aggregate)
    }

    func testUnexpectedActivityNamesNeverDecodeAsAgentState() {
        let state = LiveActivityAttributes.ContentState(name: "Other", props: "{}")
        XCTAssertNil(state.aggregate)
    }
}
