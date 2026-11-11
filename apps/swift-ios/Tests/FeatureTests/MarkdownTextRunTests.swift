import Foundation
import Testing
@testable import T3Code

@Suite("Markdown text runs")
struct MarkdownTextRunTests {
    private func inline(_ text: String) -> MarkdownRenderedInline {
        MarkdownRenderedInline(attributedText: AttributedString(text), style: .body)
    }

    private func runs(_ segments: [MarkdownBlockSegment]) -> [MarkdownTextRun?] {
        segments.map { if case let .text(run) = $0 { run } else { nil } }
    }

    @Test
    func textBlocksMergeAndOtherBlocksSplitTheRun() {
        let intro = inline("Intro")
        let heading = inline("Heading")
        let item = inline("Item")
        let outro = inline("Outro")
        let segments = MarkdownTextRun.segments([
            .paragraph(intro),
            .heading(level: 2, inline: heading),
            .unorderedList([MarkdownRenderedListItem(task: nil, blocks: [.paragraph(item)])]),
            .codeBlock(language: "swift", code: "let x = 1", inline: inline("let x = 1")),
            .paragraph(outro),
        ], spacing: 12)

        let shape = runs(segments)
        #expect(shape.count == 3)
        #expect(shape[1] == nil)
        #expect(shape[0]?.lines == [
            .init(piece: .paragraph(intro, depth: 0), spacingBefore: 0),
            .init(piece: .heading(level: 2, heading), spacingBefore: 15),
            .init(piece: .listItem(.bullet, item, depth: 0), spacingBefore: 12),
        ])
        #expect(shape[2]?.lines == [.init(piece: .paragraph(outro, depth: 0), spacingBefore: 0)])
    }

    @Test
    func listsKeepTheirMarkersNestingAndItemSpacing() {
        let first = inline("First")
        let detail = inline("Detail")
        let nested = inline("Nested")
        let second = inline("Second")
        let segments = MarkdownTextRun.segments([
            .orderedList(start: 3, items: [
                MarkdownRenderedListItem(task: nil, blocks: [
                    .paragraph(first),
                    .paragraph(detail),
                    .unorderedList([MarkdownRenderedListItem(task: .complete, blocks: [.paragraph(nested)])]),
                ]),
                MarkdownRenderedListItem(task: nil, blocks: [.paragraph(second)]),
            ]),
        ], spacing: 12)

        #expect(runs(segments).first??.lines == [
            .init(piece: .listItem(.number(3), first, depth: 0), spacingBefore: 0),
            .init(piece: .paragraph(detail, depth: 1), spacingBefore: 7),
            .init(piece: .listItem(.task(.complete), nested, depth: 1), spacingBefore: 7),
            .init(piece: .listItem(.number(4), second, depth: 0), spacingBefore: 8),
        ])
    }

    @Test
    func listsWithNonTextContentStayTheirOwnView() {
        let segments = MarkdownTextRun.segments([
            .unorderedList([MarkdownRenderedListItem(task: nil, blocks: [
                .paragraph(inline("Run this")),
                .codeBlock(language: nil, code: "ls", inline: inline("ls")),
            ])]),
        ], spacing: 12)

        #expect(runs(segments) == [nil])
    }

    @Test
    func longRunsSplitSoStreamingRerendersABoundedAmount() {
        let paragraphs = (0..<(MarkdownTextRun.maximumLines + 5)).map { MarkdownRenderedBlock.paragraph(inline("P\($0)")) }
        let shape = runs(MarkdownTextRun.segments(paragraphs, spacing: 12))
        #expect(shape.map { $0?.lines.count } == [MarkdownTextRun.maximumLines, 5])
    }
}
