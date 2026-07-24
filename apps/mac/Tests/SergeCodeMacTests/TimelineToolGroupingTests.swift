import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Timeline tool grouping")
@MainActor
struct TimelineToolGroupingTests {
    private let baseDate = Date(timeIntervalSince1970: 1_700_000_000)

    private func tool(
        id: String,
        status: ToolEventStatus = .succeeded,
        kind: ToolEventKind = .command,
        detail: String = "ls",
        offset: TimeInterval
    ) -> TimelineItem {
        .toolEvent(
            id: id,
            name: "Bash",
            detail: detail,
            kind: kind,
            status: status,
            at: baseDate.addingTimeInterval(offset),
            output: nil,
            outputIsError: false)
    }

    private func tools(
        count: Int,
        lastStatus: ToolEventStatus = .succeeded,
        idPrefix: String = "tool"
    ) -> [TimelineItem] {
        (0..<count).map { index in
            let isLast = index == count - 1
            return tool(
                id: "\(idPrefix)-\(index + 1)",
                status: isLast ? lastStatus : .succeeded,
                offset: TimeInterval(index))
        }
    }

    @Test("short trailing live run stays expanded")
    func shortTrailingLiveRunStaysExpanded() {
        let items = tools(count: TimelineToolGrouping.liveAutoCollapseToolThreshold - 1)
        let display = items.groupedForDisplay(includeSeparators: false)

        #expect(display.count == items.count)
        #expect(display.allSatisfy {
            if case .single = $0 { return true }
            return false
        })
    }

    @Test("long finished trailing run collapses mid-turn")
    func longFinishedTrailingRunCollapses() {
        let items = tools(count: TimelineToolGrouping.liveAutoCollapseToolThreshold)
        let display = items.groupedForDisplay(includeSeparators: false)

        #expect(display.count == 1)
        guard case .toolGroup(_, let groupItems, let summary) = display[0] else {
            Issue.record("expected a mid-turn tool group, got \(display)")
            return
        }
        #expect(groupItems.map(\.id) == items.map(\.id))
        #expect(summary.toolCount == TimelineToolGrouping.liveAutoCollapseToolThreshold)
        #expect(summary.failedCount == 0)
    }

    @Test("long live run peels the running tool after the summary")
    func longLiveRunKeepsRunningToolVisible() {
        let items = tools(
            count: TimelineToolGrouping.liveAutoCollapseToolThreshold,
            lastStatus: .running)
        let display = items.groupedForDisplay(includeSeparators: false)

        #expect(display.count == 2)
        guard case .toolGroup(_, let groupItems, let summary) = display[0] else {
            Issue.record("expected collapsed finished prefix, got \(display)")
            return
        }
        #expect(summary.toolCount == TimelineToolGrouping.liveAutoCollapseToolThreshold - 1)
        #expect(groupItems.map(\.id) == items.dropLast().map(\.id))

        guard case .single(let tail) = display[1],
            case .toolEvent(let id, _, _, _, let status, _, _, _) = tail
        else {
            Issue.record("expected running tool as trailing single, got \(display[1])")
            return
        }
        #expect(id == items.last?.id)
        #expect(status == .running)
    }

    @Test("long live run peels trailing reasoning with the running tool")
    func longLiveRunPeelsTrailingReasoning() {
        var items = tools(
            count: TimelineToolGrouping.liveAutoCollapseToolThreshold,
            lastStatus: .running)
        items.append(
            .reasoning(
                id: "reason-tail",
                text: "checking results",
                at: baseDate.addingTimeInterval(100)))
        let display = items.groupedForDisplay(includeSeparators: false)

        #expect(display.count == 3)
        guard case .toolGroup(_, _, let summary) = display[0] else {
            Issue.record("expected tool group first, got \(display)")
            return
        }
        #expect(summary.toolCount == TimelineToolGrouping.liveAutoCollapseToolThreshold - 1)

        guard case .single(let running) = display[1],
            case .toolEvent(_, _, _, _, .running, _, _, _) = running
        else {
            Issue.record("expected running tool second, got \(display[1])")
            return
        }
        guard case .single(let reasoning) = display[2],
            case .reasoning(let id, _, _) = reasoning
        else {
            Issue.record("expected reasoning third, got \(display[2])")
            return
        }
        #expect(id == "reason-tail")
    }

    @Test("closed short run still collapses when the agent continues")
    func closedShortRunStillCollapses() {
        var items = tools(count: 2)
        items.append(
            .assistantMessage(
                id: "assistant-1",
                markdown: "done",
                isStreaming: false,
                at: baseDate.addingTimeInterval(10)))
        let display = items.groupedForDisplay(includeSeparators: false)

        #expect(display.count == 2)
        guard case .toolGroup(_, _, let summary) = display[0] else {
            Issue.record("expected closed tool group, got \(display)")
            return
        }
        #expect(summary.toolCount == 2)
        guard case .single(let assistant) = display[1],
            case .assistantMessage = assistant
        else {
            Issue.record("expected assistant after group, got \(display[1])")
            return
        }
    }

    @Test("edited file count is summarized for mid-turn groups")
    func editedFileCountInLiveGroup() {
        let items: [TimelineItem] = (0..<TimelineToolGrouping.liveAutoCollapseToolThreshold).map {
            index in
            let path = "src/File\(index % 3).swift"
            return tool(
                id: "edit-\(index + 1)",
                kind: .fileChange,
                detail: #"Edit: {"file_path": "\#(path)", "old_string": "a", "new_string": "b"}"#,
                offset: TimeInterval(index))
        }
        let display = items.groupedForDisplay(includeSeparators: false)

        guard case .toolGroup(_, _, let summary) = display[0] else {
            Issue.record("expected tool group, got \(display)")
            return
        }
        #expect(summary.toolCount == TimelineToolGrouping.liveAutoCollapseToolThreshold)
        #expect(summary.editedFileCount == 3)
    }

    @Test("settled thread collapses a long trailing run even with stuck running status")
    func settledThreadCollapsesStuckRunning() {
        let items = tools(
            count: TimelineToolGrouping.liveAutoCollapseToolThreshold,
            lastStatus: .running)
        let display = items.groupedForDisplay(threadIsSettled: true, includeSeparators: false)

        #expect(display.count == 1)
        guard case .toolGroup(_, _, let summary) = display[0] else {
            Issue.record("expected full collapse when settled, got \(display)")
            return
        }
        #expect(summary.toolCount == TimelineToolGrouping.liveAutoCollapseToolThreshold)
    }
}
