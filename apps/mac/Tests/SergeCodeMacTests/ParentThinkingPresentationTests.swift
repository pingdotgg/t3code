import Foundation
import Testing

@testable import SergeCodeMac

@Suite("ParentThinkingPresentation")
@MainActor
struct ParentThinkingPresentationTests {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    @Test("shows thinking while running with no tools or stream")
    func showsWhenQuietlyRunning() {
        let items: [TimelineItem] = [
            .userMessage(id: "u1", text: "hello", at: now)
        ]
        #expect(
            ParentThinkingPresentation.shouldShow(
                threadStatus: .running, isStalled: false, items: items))
    }

    @Test("hides when a tool is running")
    func hidesWhenToolRunning() {
        let items: [TimelineItem] = [
            .toolEvent(
                id: "t1", name: "Bash", detail: "ls", kind: .command,
                status: .running, at: now, output: nil, outputIsError: false)
        ]
        #expect(
            !ParentThinkingPresentation.shouldShow(
                threadStatus: .running, isStalled: false, items: items))
    }

    @Test("hides when an assistant message is streaming")
    func hidesWhenStreaming() {
        let items: [TimelineItem] = [
            .assistantMessage(id: "a1", markdown: "", isStreaming: true, at: now)
        ]
        #expect(
            !ParentThinkingPresentation.shouldShow(
                threadStatus: .running, isStalled: false, items: items))
    }

    @Test("hides during waiting, approval, stall, and background-only work")
    func hidesForOtherProjectedStatuses() {
        let items: [TimelineItem] = [
            .userMessage(id: "u1", text: "hello", at: now)
        ]
        #expect(
            !ParentThinkingPresentation.shouldShow(
                threadStatus: .waiting, isStalled: false, items: items))
        #expect(
            !ParentThinkingPresentation.shouldShow(
                threadStatus: .waitingApproval, isStalled: false, items: items))
        #expect(
            !ParentThinkingPresentation.shouldShow(
                threadStatus: .running, isStalled: true, items: items))
        #expect(
            !ParentThinkingPresentation.shouldShow(
                threadStatus: .backgroundWork, isStalled: false, items: items))
        #expect(
            !ParentThinkingPresentation.shouldShow(
                threadStatus: .idle, isStalled: false, items: items))
    }

    @Test("hides when visible reasoning text is present")
    func hidesWhenReasoningVisible() {
        let items: [TimelineItem] = [
            .reasoning(id: "r1", text: "Considering approach", at: now)
        ]
        #expect(
            !ParentThinkingPresentation.shouldShow(
                threadStatus: .running, isStalled: false, items: items))
    }
}
