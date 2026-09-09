import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Chronological tool activity")
struct NativeTranscriptTimelineTests {
    private func text(_ id: String, at time: Double) -> FeatureMessage {
        FeatureMessage(id: id, role: .assistant, text: id, createdAt: Date(timeIntervalSince1970: time))
    }

    private func activity(
        _ id: String, call: String? = "a", at time: Double,
        kind: String = "tool.updated", turn: String = "turn", sequence: Int? = nil
    ) -> OrchestrationActivity {
        var payload: [String: JSONValue] = ["title": .string(id)]
        if let call { payload["toolCallId"] = .string(call) }
        return OrchestrationActivity(
            id: id, tone: "info", kind: kind, summary: id, payload: .object(payload),
            turnId: turn, sequence: sequence,
            createdAt: Date(timeIntervalSince1970: time).ISO8601Format()
        )
    }

    @Test func questionAnswersSurviveSnapshotAndLiveTimelineMapping() {
        let answer = OrchestrationActivity(
            id: "answer", tone: "info", kind: "user-input.answer-submitted",
            summary: "Answer submitted", payload: .object([
                "answers": .object(["q": .string("Blue")]),
                "questionTextById": .object(["q": .string("Choose a color")]),
                "attachmentsByQuestionId": .object([:]),
            ]), turnId: "turn", sequence: 2,
            createdAt: Date(timeIntervalSince1970: 2).ISO8601Format()
        )
        let snapshot = NativeTranscriptTimeline(messages: [], activities: [answer], sessionIsLive: false)
        var live = NativeTranscriptTimeline()
        live.append(answer)
        #expect(snapshot.messages.map(\.id) == ["question-answer:answer:q"])
        #expect(live.messages.map(\.id) == snapshot.messages.map(\.id))
        #expect(live.messages.first?.text == "Choose a color\n\nBlue")
        #expect(live.changedIDs.contains("question-answer:answer:q"))
    }

    @Test func adjacentSameCallCoalescesAtActualLatestTime() {
        var timeline = NativeTranscriptTimeline()
        timeline.append(activity("start", at: 1, kind: "tool.started"))
        timeline.append(activity("progress", at: 2))
        #expect(timeline.messages.count == 1)
        #expect(timeline.messages[0].id == "work-log-start")
        #expect(timeline.messages[0].createdAt == Date(timeIntervalSince1970: 2))
        #expect(timeline.messages[0].activeWorkLabel == "progress")
        timeline.append(activity("end", at: 3, kind: "tool.completed"))
        #expect(timeline.messages.count == 1)
        #expect(timeline.messages[0].toolName == "end")
        #expect(timeline.messages[0].activeWorkLabel == nil)
    }

    @Test func textAndOtherCallsCloseRowsAndLateCompletionAppends() {
        var timeline = NativeTranscriptTimeline()
        timeline.append(text("text1", at: 1))
        timeline.append(activity("startA", at: 2))
        timeline.append(text("text2", at: 3))
        let prefix = timeline.messages
        timeline.append(activity("updateA", at: 4))
        timeline.append(activity("startB", call: "b", at: 5))
        let earlier = timeline.messages
        timeline.append(activity("lateA", at: 6, kind: "tool.completed"))
        #expect(Array(timeline.messages.prefix(3)) == prefix)
        #expect(Array(timeline.messages.prefix(4)) == Array(earlier.prefix(4)))
        #expect(timeline.messages.map(\.id) == [
            "text1", "work-log-startA", "text2", "work-log-updateA", "work-log-startB", "work-log-lateA",
        ])
        #expect(timeline.messages.allSatisfy { $0.activeWorkLabel == nil })
        #expect(timeline.messages.last?.createdAt == Date(timeIntervalSince1970: 6))
    }

    @Test func fullSnapshotMatchesIncrementalChronology() {
        let first = text("text1", at: 1)
        let second = text("text2", at: 3)
        let activities = [activity("start", at: 2), activity("update", at: 4),
                          activity("more", at: 5), activity("other", call: "b", at: 6)]
        let snapshot = NativeTranscriptTimeline(messages: [first, second], activities: activities, sessionIsLive: true)
        var live = NativeTranscriptTimeline()
        live.append(first)
        live.append(activities[0])
        live.append(second)
        for item in activities.dropFirst() { live.append(item) }
        #expect(snapshot.messages == live.messages)
        live.append(activities[0])
        #expect(snapshot.messages == live.messages)
    }

    @Test func missingCallIdentityAndDifferentTurnsNeverCoalesce() {
        var timeline = NativeTranscriptTimeline()
        timeline.append(activity("no-id-1", call: nil, at: 1))
        timeline.append(activity("no-id-2", call: nil, at: 2))
        timeline.append(activity("a1", at: 3))
        timeline.append(activity("a2", at: 4, turn: "other"))
        #expect(timeline.messages.count == 4)
    }

    @Test func noticesSeparateCallsAndInactiveSnapshotHasNoLiveLabels() {
        let events = [activity("start", at: 1), activity("warning", at: 2, kind: "runtime.warning"),
                      activity("update", at: 3)]
        let timeline = NativeTranscriptTimeline(messages: [], activities: events, sessionIsLive: false)
        #expect(timeline.messages.map(\.role) == [.tool, .system, .tool])
        #expect(timeline.messages.allSatisfy { $0.activeWorkLabel == nil })
        #expect(timeline.messages.map(\.createdAt) == [1.0, 2.0, 3.0].map(Date.init(timeIntervalSince1970:)))
    }

    @Test func snapshotTiesAreExplicitlyDeterministicAndLiveTiesKeepArrivalOrder() {
        let message = text("text", at: 1)
        let first = activity("first", at: 1, sequence: 10)
        let second = activity("second", call: "b", at: 1, sequence: 11)
        let snapshot = NativeTranscriptTimeline(messages: [message], activities: [second, first], sessionIsLive: true)
        #expect(snapshot.messages.map(\.id) == ["text", "work-log-first", "work-log-second"])
        var live = NativeTranscriptTimeline()
        live.append(first)
        live.append(message)
        live.append(second)
        #expect(live.messages.map(\.id) == ["work-log-first", "text", "work-log-second"])
    }

    @Test func mixedLiveBatchRetainsBoundariesBetweenRepeatedMessageUpdates() {
        let message = OrchestrationMessage(id: "text", role: "assistant", text: "hello", attachments: nil,
            turnId: "turn", streaming: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
        let tool = activity("tool", at: 1)
        var batch = NativeDetailRenderMutations()
        batch.formUnion(.message(message))
        batch.formUnion(.message(message))
        batch.formUnion(.activity(tool))
        batch.formUnion(.message(message))
        #expect(batch.ordered == [.message(message), .activity(tool), .message(message)])
    }

    @Test func receiptGateScopesSelectionAndLimitsOnlySameSecondPublication() {
        var gate = NativeThreadReceiptGate()
        #expect(gate.receive(threadID: "other", selectedThreadID: "selected", generation: 1,
                             now: Date(timeIntervalSince1970: 1), source: .detailEvent) == nil)
        #expect(gate.receive(threadID: "selected", selectedThreadID: "selected", generation: 1,
                             now: Date(timeIntervalSince1970: 1), source: .detailEvent) != nil)
        #expect(gate.receive(threadID: "selected", selectedThreadID: "selected", generation: 1,
                             now: Date(timeIntervalSince1970: 1.9), source: .detailEvent) == nil)
        #expect(gate.receive(threadID: "selected", selectedThreadID: "selected", generation: 2,
                             now: Date(timeIntervalSince1970: 1.9), source: .detailSnapshot) != nil)
        #expect(gate.receive(threadID: "selected", selectedThreadID: "selected", generation: 2,
                             now: Date(timeIntervalSince1970: 1.9), source: .detailEvent) != nil)
        #expect(gate.receive(threadID: "selected", selectedThreadID: "selected", generation: 2,
                             now: Date(timeIntervalSince1970: 2), source: .shellThreadUpdate) != nil)
    }
}
