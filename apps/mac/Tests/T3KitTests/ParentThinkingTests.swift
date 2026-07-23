import Foundation
import Testing

@testable import T3Kit

@Suite("ParentThinking")
struct ParentThinkingTests {
    private var active: ParentThinkingSignals {
        ParentThinkingSignals(sessionStatus: "running", latestTurnState: "running")
    }

    @Test("shows while the parent turn is running with no other visible activity")
    func showsWhenQuietlyRunning() {
        #expect(ParentThinking.shouldShow(active))
        #expect(
            ParentThinking.shouldShow(
                ParentThinkingSignals(sessionStatus: "starting", latestTurnState: nil)))
        #expect(
            ParentThinking.shouldShow(
                ParentThinkingSignals(sessionStatus: nil, latestTurnState: "running")))
    }

    @Test("hides when streamed assistant text or a streaming message is active")
    func hidesWhenStreaming() {
        var withText = active
        withText.hasStreamingAssistantText = true
        #expect(!ParentThinking.shouldShow(withText))

        var withStream = active
        withStream.hasActiveStreamingAssistant = true
        #expect(!ParentThinking.shouldShow(withStream))
    }

    @Test("hides during tool execution")
    func hidesDuringTools() {
        var signals = active
        signals.hasActiveToolActivity = true
        #expect(!ParentThinking.shouldShow(signals))
    }

    @Test("hides during waiting, approvals, and stalls")
    func hidesDuringOtherStates() {
        var waiting = active
        waiting.sessionStatus = "waiting"
        #expect(!ParentThinking.shouldShow(waiting))

        var approval = active
        approval.hasPendingApproval = true
        #expect(!ParentThinking.shouldShow(approval))

        var input = active
        input.hasPendingUserInput = true
        #expect(!ParentThinking.shouldShow(input))

        var stalled = active
        stalled.isStalled = true
        #expect(!ParentThinking.shouldShow(stalled))
    }

    @Test("hides on completion, cancellation, and failure")
    func hidesOnTerminal() {
        #expect(
            !ParentThinking.shouldShow(
                ParentThinkingSignals(sessionStatus: "idle", latestTurnState: "completed")))
        #expect(
            !ParentThinking.shouldShow(
                ParentThinkingSignals(
                    sessionStatus: "interrupted", latestTurnState: "interrupted")))
        #expect(
            !ParentThinking.shouldShow(
                ParentThinkingSignals(sessionStatus: "error", latestTurnState: "error")))
        #expect(
            !ParentThinking.shouldShow(
                ParentThinkingSignals(sessionStatus: "stopped", latestTurnState: "completed")))
    }

    @Test("hides when visible reasoning text already narrates the work")
    func hidesWhenReasoningVisible() {
        var signals = active
        signals.hasVisibleReasoningText = true
        #expect(!ParentThinking.shouldShow(signals))
    }

    @Test("stays off when the session is quiescent")
    func staysOffWhenQuiescent() {
        #expect(
            !ParentThinking.shouldShow(
                ParentThinkingSignals(sessionStatus: "ready", latestTurnState: nil)))
        #expect(
            !ParentThinking.shouldShow(
                ParentThinkingSignals(sessionStatus: nil, latestTurnState: nil)))
    }
}
