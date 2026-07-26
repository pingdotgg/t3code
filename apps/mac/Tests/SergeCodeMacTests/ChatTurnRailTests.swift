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
