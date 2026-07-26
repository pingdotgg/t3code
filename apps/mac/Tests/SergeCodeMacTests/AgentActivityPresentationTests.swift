import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Live agent activity")
struct AgentActivityPresentationTests {
    private let base = Date(timeIntervalSinceReferenceDate: 1_000)

    private func tool(
        id: String = "t1",
        name: String = "run_command",
        detail: String = "",
        kind: ToolEventKind = .command,
        status: ToolEventStatus = .running,
        offset: TimeInterval = 0
    ) -> TimelineItem {
        .toolEvent(
            id: id, name: name, detail: detail, kind: kind, status: status,
            at: base.addingTimeInterval(offset), output: nil, outputIsError: false)
    }

    private func userMessage(offset: TimeInterval = 0) -> TimelineItem {
        .userMessage(id: "u\(offset)", text: "do the thing", attachments: [],
                     at: base.addingTimeInterval(offset))
    }

    // MARK: - Gate

    @Test("a silent running turn shows the thinking phase")
    func silentTurnThinks() {
        let activity = AgentActivityPresentation.activity(
            threadStatus: .running, isStalled: false, items: [userMessage()])

        #expect(activity?.phase == .thinking)
        #expect(activity?.since == base)
    }

    @Test("a running tool names the tool instead of thinking")
    func runningToolWins() {
        let activity = AgentActivityPresentation.activity(
            threadStatus: .running, isStalled: false,
            items: [userMessage(), tool(kind: .fileRead, offset: 5)])

        guard case .tool(let running)? = activity?.phase else {
            Issue.record("expected a tool phase, got \(String(describing: activity?.phase))")
            return
        }
        #expect(running.kind == .fileRead)
        #expect(activity?.since == base.addingTimeInterval(5))
    }

    @Test("the newest running tool is the one named")
    func newestRunningToolWins() {
        let activity = AgentActivityPresentation.activity(
            threadStatus: .running, isStalled: false,
            items: [
                userMessage(),
                tool(id: "a", kind: .fileRead, offset: 5),
                tool(id: "b", kind: .webSearch, offset: 9),
            ])

        guard case .tool(let running)? = activity?.phase else {
            Issue.record("expected a tool phase")
            return
        }
        #expect(running.id == "b")
    }

    @Test("a finished tool does not hold the dock open")
    func finishedToolFallsBackToThinking() {
        let activity = AgentActivityPresentation.activity(
            threadStatus: .running, isStalled: false,
            items: [userMessage(), tool(status: .succeeded, offset: 5)])

        #expect(activity?.phase == .thinking)
        // Silence is measured from the last thing the transcript said.
        #expect(activity?.since == base.addingTimeInterval(5))
    }

    @Test("a stall outranks every other phase")
    func stalledWins() {
        let activity = AgentActivityPresentation.activity(
            threadStatus: .running, isStalled: true,
            items: [userMessage(), tool(offset: 5)])

        #expect(activity?.phase == .stalled)
    }

    @Test("a settled thread shows nothing")
    func settledShowsNothing() {
        for status in [ThreadStatus.idle, .settled, .done, .error, .archived, .readyToMerge] {
            #expect(
                AgentActivityPresentation.activity(
                    threadStatus: status, isStalled: false,
                    items: [userMessage(), tool(offset: 5)]) == nil,
                "\(status) should not host the activity dock")
        }
    }

    @Test("a pending decision hands the tail back to its card")
    func pendingDecisionShowsNothing() {
        let approval = TimelineItem.approval(
            ApprovalRequest(
                id: "a1", threadID: "t", kind: .command, title: "Run command",
                detail: "ls /tmp", createdAt: base))

        #expect(
            AgentActivityPresentation.activity(
                threadStatus: .waitingApproval, isStalled: false,
                items: [userMessage(), approval]) == nil)
        // Even mid-run: the card is the content, and it is waiting on a person.
        #expect(
            AgentActivityPresentation.activity(
                threadStatus: .running, isStalled: false,
                items: [userMessage(), approval]) == nil)
    }

    @Test("streaming assistant prose suppresses the dock")
    func streamingProseShowsNothing() {
        let streaming = TimelineItem.assistantMessage(
            id: "a", markdown: "Here is what I found", isStreaming: true,
            at: base.addingTimeInterval(3))

        #expect(
            AgentActivityPresentation.activity(
                threadStatus: .running, isStalled: false,
                items: [userMessage(), streaming]) == nil)
    }

    @Test("nil thread status shows nothing")
    func unknownStatusShowsNothing() {
        #expect(
            AgentActivityPresentation.activity(
                threadStatus: nil, isStalled: false, items: [userMessage()]) == nil)
    }

    // MARK: - Turn scoping

    @Test("the tool tape is scoped to the current turn and bounded")
    func tapeScopedToTurn() {
        var items: [TimelineItem] = [userMessage(offset: 0)]
        items.append(tool(id: "old", kind: .webSearch, status: .succeeded, offset: 1))
        items.append(userMessage(offset: 2))
        for index in 0..<8 {
            items.append(
                tool(
                    id: "n\(index)", kind: .fileRead, status: .succeeded,
                    offset: 3 + Double(index)))
        }

        let scan = TimelineActivityScan.scan(items: items)
        #expect(scan.turnToolCount == 8)
        #expect(scan.recentToolKinds.count == TimelineActivityScan.recentToolTapeLength)
        // The pre-turn web search must not leak into the new turn's tape.
        #expect(!scan.recentToolKinds.contains(.webSearch))
    }

    @Test("out-of-order deltas do not rewind the silence clock")
    func lastItemAtTakesTheMaximum() {
        let items: [TimelineItem] = [
            userMessage(offset: 0),
            tool(id: "late", status: .succeeded, offset: 30),
            tool(id: "early", status: .succeeded, offset: 10),
        ]

        #expect(TimelineActivityScan.scan(items: items).lastItemAt == base.addingTimeInterval(30))
    }

    // MARK: - Copy

    @Test("the thinking label escalates as the silence stretches")
    func thinkingLabelEscalates() {
        #expect(AgentActivityPresentation.thinkingLabel(elapsed: 0) == "Thinking")
        #expect(AgentActivityPresentation.thinkingLabel(elapsed: 19) == "Thinking")
        #expect(AgentActivityPresentation.thinkingLabel(elapsed: 21) == "Still thinking")
        #expect(AgentActivityPresentation.thinkingLabel(elapsed: 90) == "Thinking it through")
        #expect(AgentActivityPresentation.thinkingLabel(elapsed: 600) == "Deep in thought")
    }

    @Test("tool labels name the subject when there is one")
    func toolLabelsNameTheSubject() {
        #expect(
            AgentActivityPresentation.toolLabel(
                kind: .command, name: "run", subject: "swift build") == "Running swift build")
        #expect(
            AgentActivityPresentation.toolLabel(
                kind: .fileChange, name: "edit", subject: "Motion.swift")
                == "Editing Motion.swift")
        #expect(
            AgentActivityPresentation.toolLabel(kind: .fileRead, name: "read", subject: nil)
                == "Reading files")
        #expect(
            AgentActivityPresentation.toolLabel(kind: .computerUse, name: "", subject: "ignored")
                == "Driving the computer")
    }

    @Test("an unnamed tool never renders an empty label")
    func unnamedToolFallsBack() {
        #expect(
            AgentActivityPresentation.toolLabel(kind: .mcpCall, name: "   ", subject: nil)
                == "Calling a tool")
        #expect(
            AgentActivityPresentation.toolLabel(kind: .other, name: "", subject: nil)
                == "Running a tool")
    }

    @Test("subjects are clipped to one bounded line")
    func subjectsAreClipped() {
        let long = String(repeating: "x", count: 200)
        let clipped = AgentActivityPresentation.clip(long)
        #expect(clipped?.count == AgentActivityPresentation.maxSubjectLength)
        #expect(clipped?.hasSuffix("…") == true)

        #expect(AgentActivityPresentation.clip("first\nsecond") == "first")
        #expect(AgentActivityPresentation.clip("   ") == nil)
        #expect(AgentActivityPresentation.clip(nil) == nil)
    }

    @Test("every phase has a glyph and a screen-reader label")
    func phasesAreFullyPresentable() {
        let running = TimelineActivityScan.RunningTool(
            id: "t", name: "grep", detail: "", kind: .command, startedAt: base)
        for phase in [AgentActivityPhase.thinking, .stalled, .tool(running)] {
            #expect(!AgentActivityPresentation.symbolName(for: phase).isEmpty)
            #expect(
                !AgentActivityPresentation
                    .accessibilityLabel(phase: phase, subject: nil).isEmpty)
        }
    }
}
