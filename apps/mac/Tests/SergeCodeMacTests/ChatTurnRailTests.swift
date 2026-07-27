import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Chat turn rail model")
struct ChatTurnRailTests {
    private func date(_ seconds: TimeInterval) -> Date {
        Date(timeIntervalSince1970: seconds)
    }

    @Test("empty timeline yields no turns")
    func emptyTimeline() {
        #expect(ChatTurnRailModel.turns(from: []).isEmpty)
    }

    @Test("only user messages become turns; ids match row ids")
    func onlyUserMessagesBecomeTurns() {
        let displayItems: [TimelineDisplayItem] = [
            .daySeparator(id: "day-separator:u1", label: "Today"),
            .single(.userMessage(id: "u1", text: "first prompt", attachments: [], at: date(1))),
            .single(.assistantMessage(id: "a1", markdown: "reply", isStreaming: false, at: date(2))),
            .toolGroup(
                id: "toolgroup:t1",
                items: [],
                summary: ToolGroupSummary(toolCount: 2, editedFileCount: 1, failedCount: 0)),
            .single(.userMessage(id: "u2", text: "second prompt", attachments: [], at: date(3))),
        ]

        let turns = ChatTurnRailModel.turns(from: displayItems)

        #expect(turns.map(\.id) == ["u1", "u2"])
        #expect(turns.map(\.preview) == ["first prompt", "second prompt"])
    }

    @Test("preview collapses whitespace and newlines into single spaces")
    func previewCollapsesWhitespace() {
        #expect(ChatTurnRailModel.preview(of: "  fix\n\nthe   tests \n") == "fix the tests")
    }

    @Test("preview truncates past the limit with an ellipsis")
    func previewTruncates() {
        let long = String(repeating: "a", count: ChatTurnRailModel.previewLimit + 20)
        let preview = ChatTurnRailModel.preview(of: long)
        #expect(preview.count == ChatTurnRailModel.previewLimit)
        #expect(preview.hasSuffix("…"))

        let exact = String(repeating: "b", count: ChatTurnRailModel.previewLimit)
        #expect(ChatTurnRailModel.preview(of: exact) == exact)
    }

    @Test("whitespace-only text yields an empty preview but still a turn")
    func whitespaceOnlyMessage() {
        let turns = ChatTurnRailModel.turns(from: [
            .single(.userMessage(id: "u1", text: "  \n ", attachments: [], at: date(1)))
        ])
        #expect(turns == [ChatTurnRailModel.Turn(id: "u1", preview: "")])
    }
}

/// The rail is derived inside `ChatTimelineScrollView`'s body, which re-runs
/// on every streaming delta — so the memo is what keeps a long thread from
/// re-collapsing the whitespace in every prompt ~30 times a second.
@Suite("Chat turn rail cache")
@MainActor
struct ChatTurnRailCacheTests {
    private func date(_ seconds: TimeInterval) -> Date {
        Date(timeIntervalSince1970: seconds)
    }

    private var timeline: [TimelineItem] {
        [
            .userMessage(id: "u1", text: "first  prompt", attachments: [], at: date(1)),
            .toolEvent(
                id: "t1", name: "Edit", detail: "Sources/App.swift", kind: .fileChange,
                status: .succeeded, at: date(2), output: nil, outputIsError: false),
            .userMessage(id: "u2", text: "second prompt", attachments: [], at: date(3)),
        ]
    }

    private var displayItems: [TimelineDisplayItem] {
        timeline.map { .single($0) }
    }

    @Test("the same structure version reuses the built rail")
    func reusesByStructureVersion() {
        ChatTurnRailCache.resetForTesting()
        RunTapeCache.resetForTesting()
        defer {
            ChatTurnRailCache.resetForTesting()
            RunTapeCache.resetForTesting()
        }

        let first = ChatTurnRailCache.rail(
            displayItems: displayItems, timeline: timeline,
            threadID: "rail-cache-t1", structureVersion: 3)
        let second = ChatTurnRailCache.rail(
            displayItems: displayItems, timeline: timeline,
            threadID: "rail-cache-t1", structureVersion: 3)

        #expect(first.turns == second.turns)
        #expect(ChatTurnRailCache.buildCount == 1)
        #expect(first.turns.map(\.id) == ["u1", "u2"])
        #expect(first.turns.map(\.preview) == ["first prompt", "second prompt"])
        // Every turn that produced a tape cell is reachable by its row id.
        #expect(first.tape["u1"]?.signal == .edit)
    }

    @Test("a structural bump and an eviction both rebuild")
    func rebuildsOnBumpAndEviction() {
        ChatTurnRailCache.resetForTesting()
        RunTapeCache.resetForTesting()
        defer {
            ChatTurnRailCache.resetForTesting()
            RunTapeCache.resetForTesting()
        }

        _ = ChatTurnRailCache.rail(
            displayItems: displayItems, timeline: timeline,
            threadID: "rail-cache-t2", structureVersion: 1)
        _ = ChatTurnRailCache.rail(
            displayItems: displayItems, timeline: timeline,
            threadID: "rail-cache-t2", structureVersion: 2)
        #expect(ChatTurnRailCache.buildCount == 2)

        ChatTurnRailCache.evict(threadID: "rail-cache-t2")
        _ = ChatTurnRailCache.rail(
            displayItems: displayItems, timeline: timeline,
            threadID: "rail-cache-t2", structureVersion: 2)
        #expect(ChatTurnRailCache.buildCount == 3)
    }
}
