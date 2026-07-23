import Foundation
import Testing

@testable import SergeCodeMac

/// Keyboard shortcuts on approval / user-input / plan / usage-limit cards belong
/// to exactly one card — the most recent still-actionable one — so a keystroke
/// can never resolve a card buried in the scrollback.
@Suite("Active decision card")
struct ActiveDecisionCardTests {
    private let date = Date(timeIntervalSince1970: 1)

    private func approval(_ id: String) -> TimelineItem {
        .approval(
            ApprovalRequest(
                id: id, threadID: "t1", kind: .command, title: "Run", detail: "ls",
                createdAt: date))
    }

    private func plan(_ id: String, isImplemented: Bool) -> TimelineItem {
        .plan(
            ProposedPlan(
                id: id, threadID: "t1", markdown: "# plan", isImplemented: isImplemented,
                createdAt: date))
    }

    @Test("no actionable card")
    func noneWhenTimelineHasNoCards() {
        let items: [TimelineItem] = [
            .userMessage(id: "user-1", text: "hi", attachments: [], at: date),
            .assistantMessage(id: "assistant-1", markdown: "hey", isStreaming: false, at: date),
        ]
        #expect(items.activeDecisionCardID == nil)
    }

    @Test("the newest card wins, older ones lose their shortcuts")
    func newestCardWins() {
        let items: [TimelineItem] = [
            approval("approval-old"),
            .assistantMessage(id: "assistant-1", markdown: "…", isStreaming: false, at: date),
            approval("approval-new"),
        ]
        #expect(items.activeDecisionCardID == "approval-new")
    }

    @Test("the nearest actionable card wins across kinds")
    func nearestActionableCardAcrossKinds() {
        let items: [TimelineItem] = [
            approval("approval-1"),
            plan("plan-1", isImplemented: false),
        ]
        #expect(items.activeDecisionCardID == "plan-1")
    }

    @Test("an implemented plan is not actionable and does not shadow an older card")
    func implementedPlanIsTransparent() {
        let items: [TimelineItem] = [
            approval("approval-1"),
            plan("plan-1", isImplemented: true),
        ]
        #expect(items.activeDecisionCardID == "approval-1")
    }

    @Test("trailing non-card rows do not shadow the active card")
    func trailingRowsAreSkipped() {
        let items: [TimelineItem] = [
            approval("approval-1"),
            .reasoning(id: "reasoning-1", text: "thinking", at: date),
            .notice(id: "notice-1", text: "note", at: date),
        ]
        #expect(items.activeDecisionCardID == "approval-1")
    }
}
