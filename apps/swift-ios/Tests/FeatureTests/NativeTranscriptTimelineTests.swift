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

    @Test func textClosesGroupsButDistinctCallsAndLateCompletionShareTheNextGroup() {
        var timeline = NativeTranscriptTimeline()
        timeline.append(text("text1", at: 1))
        timeline.append(activity("startA", at: 2))
        timeline.append(text("text2", at: 3))
        let prefix = timeline.messages
        timeline.append(activity("updateA", at: 4))
        timeline.append(activity("startB", call: "b", at: 5))
        timeline.append(activity("lateA", at: 6, kind: "tool.completed"))
        #expect(Array(timeline.messages.prefix(3)) == prefix)
        #expect(timeline.messages.map(\.id) == [
            "text1", "work-log-startA", "text2", "work-log-updateA",
        ])
        #expect(timeline.messages.last?.activeWorkLabel == "startB")
        #expect(timeline.messages.last?.toolName == "2 tool calls")
        #expect(timeline.messages.last?.text.contains("startB") == true)
        #expect(timeline.messages.last?.text.contains("lateA") == true)
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

    @Test func missingCallIdentityStillGroupsButDifferentTurnsSeparate() {
        var timeline = NativeTranscriptTimeline()
        timeline.append(activity("no-id-1", call: nil, at: 1))
        timeline.append(activity("no-id-2", call: nil, at: 2))
        timeline.append(activity("a1", at: 3))
        timeline.append(activity("a2", at: 4, turn: "other"))
        #expect(timeline.messages.count == 2)
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
        #expect(snapshot.messages.map(\.id) == ["text", "work-log-first"])
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

    @Test func backwardsTimestampsKeepMaximumAgeAndNeverCrossText() {
        var timeline = NativeTranscriptTimeline()
        timeline.append(activity("first", at: 10))
        timeline.append(activity("backwards", call: "b", at: 5))
        #expect(timeline.messages.count == 1)
        #expect(timeline.messages[0].createdAt == Date(timeIntervalSince1970: 10))
        timeline.append(text("boundary", at: 11))
        timeline.append(activity("late", at: 4))
        #expect(timeline.messages.map(\.id) == ["work-log-first", "boundary", "work-log-late"])
        #expect(timeline.messages.last?.createdAt == Date(timeIntervalSince1970: 4))
    }

    @Test func olderPageRebuildKeepsLoadedGroupsAndReplayIsIdempotent() {
        let boundary = text("boundary", at: 3)
        let old = activity("old", at: 1)
        let recent = [activity("first", at: 4), activity("second", call: "b", at: 5)]
        let loaded = NativeTranscriptTimeline(messages: [boundary], activities: recent, sessionIsLive: true)
        var paged = NativeTranscriptTimeline(messages: [text("older", at: 0), boundary],
            activities: [old] + recent, sessionIsLive: true)
        #expect(Array(paged.messages.suffix(2)) == loaded.messages)
        for item in [old] + recent { paged.append(item) }
        #expect(Array(paged.messages.suffix(2)) == loaded.messages)
    }

    @Test func relativeToolAgeAdvancesAtUnitBoundariesAndClampsFutureEvents() {
        let date = Date(timeIntervalSince1970: 100)
        for (seconds, expected) in [(-20.0, "just now"), (0, "just now"), (9, "just now"),
                                    (20, "20s ago"), (60, "1m ago"), (120, "2m ago"),
                                    (3600, "1h ago"), (86400, "1d ago")] {
            #expect(NativeToolRelativeAge.text(since: date, now: date.addingTimeInterval(seconds)) == expected)
            #expect(NativeToolRelativeAge.nextChange(since: date, now: date.addingTimeInterval(seconds))!
                > date.addingTimeInterval(seconds))
        }
        #expect(NativeToolRelativeAge.nextChange(since: date, now: date.addingTimeInterval(120))
            == date.addingTimeInterval(180))
    }

    @Test func historyAndLocalFeedbackNeverResortObservedToolBoundaries() {
        let current = [text("first-tool", at: 10), text("boundary", at: 11), text("late-tool", at: 4)]
        let paged = NativeTranscriptOrder.prependHistory([text("older", at: 0), current[0]], to: current)
        #expect(paged.map(\.id) == ["older", "first-tool", "boundary", "late-tool"])
        let withFeedback = NativeTranscriptOrder.insertingFeedback([text("feedback", at: 8)], into: paged)
        #expect(withFeedback.filter { $0.id != "feedback" } == paged)
    }

    @Test func unknownTimestampHasNoInventedAgeOrClockTick() {
        #expect(NativeToolRelativeAge.text(since: .distantPast, now: .now) == "—")
        #expect(NativeToolRelativeAge.nextChange(since: .distantPast, now: .now) == nil)
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
