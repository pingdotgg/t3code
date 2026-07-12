import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Markdown content")
@MainActor
struct MarkdownContentTests {
    @Test("parses GFM tables, alignment, and missing cells")
    func tables() throws {
        let blocks = parseMarkdownBlocks(
            """
            | Name | Count | Notes |
            | :--- | ---: | :---: |
            | one |
            | two | 2 | **ok** |
            """)

        guard case .table(let table) = try #require(blocks.first) else {
            Issue.record("expected a table block")
            return
        }
        #expect(table.header.map(text) == ["Name", "Count", "Notes"])
        #expect(table.rows.count == 2)
        #expect(table.rows.allSatisfy { $0.count == 3 })
        #expect(table.rows[0].map(text) == ["one", "", ""])
        #expect(table.rows[1].map(text) == ["two", "2", "ok"])
        #expect(table.columnAlignments == [.leading, .trailing, .center])
    }

    @Test("parses checked and unchecked task items")
    func taskLists() throws {
        let blocks = parseMarkdownBlocks("- [ ] todo\n- [x] done\n- [X] also done")
        #expect(blocks.count == 3)

        guard case .taskItem(indent: 0, checked: false, text: let first) = blocks[0],
            case .taskItem(indent: 0, checked: true, text: let second) = blocks[1],
            case .taskItem(indent: 0, checked: true, text: let third) = blocks[2]
        else {
            Issue.record("expected three task blocks")
            return
        }
        #expect(text(first) == "todo")
        #expect(text(second) == "done")
        #expect(text(third) == "also done")
    }

    @Test("preserves arbitrary nested list depth")
    func nestedLists() {
        let blocks = parseMarkdownBlocks(
            """
            - level one
              - level two
                - level three
            """)
        let items = blocks.compactMap { block -> (Int, String)? in
            switch block {
            case .bulletItem(let indent, let value): return (indent, text(value))
            default: return nil
            }
        }
        #expect(items.map(\.0) == [0, 1, 2])
        #expect(items.map(\.1) == ["level one", "level two", "level three"])
    }

    @Test("preserves list-item child order around nested blocks")
    func listItemChildOrder() throws {
        let blocks = parseMarkdownBlocks(
            """
            - parent

              - nested

              trailing paragraph
            """)

        guard blocks.count == 3,
            case .bulletItem(indent: 0, text: let parent) = blocks[0],
            case .bulletItem(indent: 1, text: let nested) = blocks[1],
            case .paragraph(let trailing) = blocks[2]
        else {
            Issue.record("expected parent item, nested item, then trailing paragraph")
            return
        }
        #expect(text(parent) == "parent")
        #expect(text(nested) == "nested")
        #expect(text(trailing) == "trailing paragraph")
    }

    @Test("keeps a block quote and nested list inside a list item")
    func listItemBlockQuote() throws {
        let blocks = parseMarkdownBlocks(
            """
            - parent

                > quoted
                >
                > - nested
            """)

        guard blocks.count == 2,
            case .quote(let paragraphs) = blocks[1]
        else {
            Issue.record("expected a quote block after the parent item")
            return
        }
        #expect(paragraphs.map(text) == ["quoted", "• nested"])
    }

    @Test("keeps code blocks and trailing paragraphs after the list item")
    func listItemCodeBlockOrder() throws {
        let blocks = parseMarkdownBlocks(
            "- parent\n\n    ```swift\n    let answer = 42\n    ```\n\n    trailing paragraph")

        guard blocks.count == 3,
            case .bulletItem(indent: 0, text: let parent) = blocks[0],
            case .codeBlock(language: "swift", code: "let answer = 42") = blocks[1],
            case .paragraph(let trailing) = blocks[2]
        else {
            Issue.record("expected parent item, code block, then trailing paragraph")
            return
        }
        #expect(text(parent) == "parent")
        #expect(text(trailing) == "trailing paragraph")
    }

    @Test("keeps unsupported block text after the list item")
    func listItemUnsupportedBlockOrder() throws {
        let blocks = parseMarkdownBlocks(
            "- parent\n\n    <div>\n    preserved child\n    </div>")

        guard blocks.count == 2,
            case .bulletItem(indent: 0, text: let parent) = blocks[0],
            case .paragraph(let fallback) = blocks[1]
        else {
            Issue.record("expected unsupported block text after the parent item")
            return
        }
        #expect(text(parent) == "parent")
        #expect(text(fallback).contains("preserved child"))
    }

    @Test("renders strikethrough as an attributed run")
    func strikethrough() throws {
        let blocks = parseMarkdownBlocks("this is ~~obsolete~~ text")
        guard case .paragraph(let value) = try #require(blocks.first) else {
            Issue.record("expected a paragraph")
            return
        }
        #expect(value.runs.contains { $0.strikethroughStyle != nil })
        #expect(text(value) == "this is obsolete text")
    }

    @Test("walks inline code and links directly")
    func inlineCodeAndLinks() throws {
        let value = inlineAttributed("use `src/Foo.swift:12` and [docs](https://example.com/docs)")
        #expect(value.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        #expect(value.runs.contains { $0.link?.absoluteString == "https://example.com/docs" })
        #expect(value.runs.contains { $0.link?.scheme == "sergecode-file" })
        #expect(text(value) == "use src/Foo.swift:12 and docs")
    }

    @Test("linkifies file paths in parsed paragraph IR")
    func parsedParagraphFileLink() throws {
        let blocks = parseMarkdownBlocks("Open apps/mac/Sources/Foo.swift:10")
        guard case .paragraph(let paragraph) = try #require(blocks.first) else {
            Issue.record("expected a paragraph")
            return
        }

        let parsedTarget = paragraph.runs.compactMap { $0.link.flatMap(parseFileLinkURL) }.first
        #expect(parsedTarget == FileLinkTarget(path: "apps/mac/Sources/Foo.swift", line: 10))

        let serialized = attributedMarkdownProse(blocks)
        let serializedTarget = serialized.runs.compactMap { $0.link.flatMap(parseFileLinkURL) }.first
        #expect(serializedTarget == parsedTarget)
    }

    @Test("parses fenced code and keeps its language")
    func fencedCode() throws {
        let blocks = parseMarkdownBlocks("before\n\n```swift\nlet answer = 42\n```")
        guard blocks.count > 1,
            case .codeBlock(language: let language, code: let code) = blocks[1]
        else {
            Issue.record("expected a fenced code block")
            return
        }
        #expect(language == "swift")
        #expect(code == "let answer = 42")
    }

    @Test("accepts an unterminated streaming code fence")
    func unterminatedFence() {
        let blocks = parseMarkdownBlocks("before\n\n```swift\nlet answer = 42")
        #expect(blocks.contains {
            if case .codeBlock(language: "swift", code: "let answer = 42") = $0 { return true }
            return false
        })
    }

    @Test("keeps each quote paragraph as a separate entry")
    func quoteParagraphs() throws {
        let blocks = parseMarkdownBlocks("> first paragraph\n>\n> second paragraph")
        guard case .quote(let paragraphs) = try #require(blocks.first) else {
            Issue.record("expected a quote block")
            return
        }
        #expect(paragraphs.map(text) == ["first paragraph", "second paragraph"])
    }

    @Test("preserves list markers and task glyphs inside block quotes")
    func quotedListMarkers() throws {
        let unordered = parseMarkdownBlocks("> - one\n> - two")
        let ordered = parseMarkdownBlocks("> 1. a\n> 2. b")
        let task = parseMarkdownBlocks("> - [ ] pending\n> - [x] done")

        guard case .quote(let unorderedParagraphs) = try #require(unordered.first),
            case .quote(let orderedParagraphs) = try #require(ordered.first),
            case .quote(let taskParagraphs) = try #require(task.first)
        else {
            Issue.record("expected quote blocks for list marker fixtures")
            return
        }
        #expect(unorderedParagraphs.map(text) == ["• one", "• two"])
        #expect(orderedParagraphs.map(text) == ["1. a", "2. b"])
        #expect(taskParagraphs.map(text) == ["☐ pending", "☑ done"])
        #expect(unorderedParagraphs.first?.runs.first?.foregroundColor != nil)
    }

    @Test("indents nested quote lists and preserves list source order")
    func quotedNestedListStructure() throws {
        let blocks = parseMarkdownBlocks(
            "> - outer\n>   - inner\n>     1. deep\n> - final")

        guard case .quote(let paragraphs) = try #require(blocks.first) else {
            Issue.record("expected a quote block for nested list fixture")
            return
        }
        #expect(paragraphs.map(text) == [
            "• outer", "  • inner", "    1. deep", "• final",
        ])
    }

    @Test("parses heading levels one through six")
    func headingLevels() {
        let markdown = (1...6).map { level in
            "\(String(repeating: "#", count: level)) heading \(level)"
        }.joined(separator: "\n\n")
        let levels = parseMarkdownBlocks(markdown).compactMap { block -> Int? in
            if case .heading(let level, _) = block { return level }
            return nil
        }
        #expect(levels == [1, 2, 3, 4, 5, 6])
    }

    @Test("parses thematic rules as rule blocks")
    func rules() {
        let blocks = parseMarkdownBlocks("---\n\n***\n\n___")
        #expect(blocks.count == 3)
        #expect(blocks.allSatisfy {
            if case .rule = $0 { return true }
            return false
        })
    }

    @Test("parses a mixed GFM document into the extended IR")
    func mixedDocument() {
        let blocks = parseMarkdownBlocks(
            """
            # Title

            A paragraph with **strong** and ~~deleted~~ text.

            > quoted

            - [x] task
              - nested

            | A | B |
            | --- | --- |
            | 1 | 2 |

            ```json
            {"ok": true}
            ```

            ---
            """)

        enum Kind: Equatable {
            case heading
            case paragraph
            case quote
            case taskItem
            case bulletItem
            case table
            case codeBlock
            case rule
        }
        let kinds = blocks.map { block -> Kind in
            switch block {
            case .heading: return .heading
            case .paragraph: return .paragraph
            case .quote: return .quote
            case .taskItem: return .taskItem
            case .bulletItem: return .bulletItem
            case .table: return .table
            case .codeBlock: return .codeBlock
            case .rule: return .rule
            case .orderedItem: Issue.record("unexpected ordered item"); return .paragraph
            }
        }
        #expect(kinds == [
            .heading, .paragraph, .quote, .taskItem, .bulletItem, .table, .codeBlock, .rule,
        ])
    }

    @Test("serializes table rows with tabs for Select Text")
    func selectableTableSerialization() {
        let value = attributedMarkdownDocument(
            "| A | B |\n| --- | --- |\n| 1 | 2 |")
        #expect(text(value) == "A\tB\n1\t2")
    }

    @Test("reuses stable top-level blocks while the tail streams")
    func blockCacheReusesStableBlocks() {
        MarkdownBlockCache.resetForTesting()
        _ = MarkdownBlockCache.document(for: "stable paragraph\n\nstreaming tail")
        let firstPass = MarkdownBlockCache.statistics
        _ = MarkdownBlockCache.document(for: "stable paragraph\n\nstreaming tail updated")
        let secondPass = MarkdownBlockCache.statistics

        #expect(firstPass.hits == 0)
        #expect(firstPass.misses == 2)
        #expect(secondPass.hits == 1)
        #expect(secondPass.misses == 3)
        #expect(secondPass.entryCount == 3)
    }

    @Test("bypasses cache for blocks without source keys")
    func cacheBypassesMissingSourceKeys() {
        let cache = MarkdownBlockCacheStore()
        let fallbackKey = "\u{0}0"
        let firstDocument = [MarkdownBlock.paragraph(AttributedString("document A"))]
        let secondDocument = [MarkdownBlock.paragraph(AttributedString("document B"))]

        // Simulate the old collision slot belonging to a different document.
        cache.insert(firstDocument, for: fallbackKey)
        let missesBefore = cache.misses

        #expect(cache.value(for: nil) == nil)
        cache.insert(secondDocument, for: nil)
        #expect(cache.value(for: fallbackKey) == firstDocument)
        #expect(cache.misses == missesBefore)
    }

    private func text(_ value: AttributedString) -> String {
        String(value.characters)
    }
}
