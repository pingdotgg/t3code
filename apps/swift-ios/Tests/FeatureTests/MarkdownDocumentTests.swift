import Foundation
import Testing
import UIKit
@testable import T3Code

@Suite("Chat Markdown")
struct MarkdownDocumentTests {
    @Test
    func separatesHeadingsParagraphsAndListKinds() {
        let document = MarkdownDocument(
            parsing: """
            # Release notes

            Includes **important** details.

            - First
            - [x] Shipped
            - [ ] Follow up

            3. Third
            4. Fourth
            """
        )

        #expect(
            document.blocks == [
                .heading(level: 1, text: "Release notes"),
                .paragraph("Includes **important** details."),
                .unorderedList([
                    MarkdownListItem(task: nil, blocks: [.paragraph("First")]),
                    MarkdownListItem(task: .complete, blocks: [.paragraph("Shipped")]),
                    MarkdownListItem(task: .incomplete, blocks: [.paragraph("Follow up")]),
                ]),
                .orderedList(
                    start: 3,
                    items: [
                        MarkdownListItem(task: nil, blocks: [.paragraph("Third")]),
                        MarkdownListItem(task: nil, blocks: [.paragraph("Fourth")]),
                    ]
                ),
            ]
        )
    }

    @Test
    func preservesNestedStructureInsideQuotesAndLists() {
        let document = MarkdownDocument(
            parsing: """
            > ## Heads up
            > Read this first.
            >
            > - Quoted item

            - Parent
              - Nested child
            """
        )

        guard case let .blockquote(quote) = document.blocks.first else {
            Issue.record("Expected a block quote")
            return
        }
        #expect(
            quote.blocks == [
                .heading(level: 2, text: "Heads up"),
                .paragraph("Read this first."),
                .unorderedList([
                    MarkdownListItem(task: nil, blocks: [.paragraph("Quoted item")]),
                ]),
            ]
        )

        guard case let .unorderedList(items) = document.blocks.last else {
            Issue.record("Expected an unordered list")
            return
        }
        #expect(
            items == [
                MarkdownListItem(
                    task: nil,
                    blocks: [
                        .paragraph("Parent"),
                        .unorderedList([
                            MarkdownListItem(task: nil, blocks: [.paragraph("Nested child")]),
                        ]),
                    ]
                ),
            ]
        )
    }

    @Test
    func parsesTablesWithAlignmentEscapesAndNormalizedRows() {
        let document = MarkdownDocument(
            parsing: """
            | Name | Status | Notes |
            | :--- | :---: | ---: |
            | Parser | Ready | **Fast** |
            | Escaped \\| pipe | ``a|b`` | [Docs](https://example.com) |
            | Short | Row |
            | Extra | cells | stay | ignored |
            """
        )

        #expect(
            document.blocks == [
                .table(
                    MarkdownTable(
                        header: ["Name", "Status", "Notes"],
                        alignments: [.leading, .center, .trailing],
                        rows: [
                            ["Parser", "Ready", "**Fast**"],
                            ["Escaped \\| pipe", "``a|b``", "[Docs](https://example.com)"],
                            ["Short", "Row", ""],
                            ["Extra", "cells", "stay"],
                        ]
                    )
                ),
            ]
        )
    }

    @Test
    func unmatchedBacktickDoesNotHideLaterTableSeparators() {
        let document = MarkdownDocument(
            parsing: """
            Left | Middle | Right
            --- | --- | ---
            x | `y | z
            """
        )

        #expect(
            document.blocks == [
                .table(
                    MarkdownTable(
                        header: ["Left", "Middle", "Right"],
                        alignments: [.natural, .natural, .natural],
                        rows: [["x", "`y", "z"]]
                    )
                ),
            ]
        )
    }

    @Test
    func rejectsTableDelimiterCellsWithFewerThanThreeDashes() {
        let document = MarkdownDocument(
            parsing: """
            Name | Status
            -- | ---
            Parser | Ready
            """
        )

        #expect(
            document.blocks == [
                .paragraph("Name | Status\n-- | ---\nParser | Ready"),
            ]
        )
    }

    @Test
    func rendersTableCellsThroughTheInlineMarkdownCache() throws {
        let source = """
        Label | Value
        --- | ---
        **Build** | `green`
        """
        let revision = MarkdownContentRevision(source)
        let rendered = try #require(
            MarkdownRenderCache.shared.documentImmediately(for: revision)
        )
        guard case let .table(table) = rendered.blocks.first else {
            Issue.record("Expected a rendered table")
            return
        }

        #expect(String(table.header[0].attributedText.characters) == "Label")
        #expect(String(table.rows[0][0].attributedText.characters) == "Build")
        #expect(
            table.rows[0][0].attributedText.runs.contains {
                $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
            }
        )
        #expect(
            table.rows[0][1].attributedText.runs.contains {
                $0.inlinePresentationIntent?.contains(.code) == true
            }
        )
    }

    @Test
    func fencedCodeKeepsLanguageAndContentsLiteral() {
        let document = MarkdownDocument(
            parsing: """
            ```swift
            let value = "**not emphasis**"
              print(value)
            ```
            """
        )

        #expect(
            document.blocks == [
                .codeBlock(
                    language: "swift",
                    code: "let value = \"**not emphasis**\"\n  print(value)"
                ),
            ]
        )
    }

    @Test
    func unclosedFenceConsumesTheRemainingMessage() {
        let document = MarkdownDocument(
            parsing: """
            ~~~console
            pnpm test
            no closing fence
            """
        )

        #expect(
            document.blocks == [
                .codeBlock(language: "console", code: "pnpm test\nno closing fence"),
            ]
        )
    }

    @Test
    func plaintextCodeBlocksWrapByDefault() {
        for language in ["text", "TEXT", "txt", "plaintext", "plain", "md", "markdown"] {
            #expect(MarkdownCodeBlockWrapping.wrapsByDefault(language: language))
        }

        for language in [nil, "swift", "typescript", "console"] {
            #expect(!MarkdownCodeBlockWrapping.wrapsByDefault(language: language))
        }
    }

    @Test
    func parsesSetextHeadingsAndNormalizesWindowsNewlines() {
        let document = MarkdownDocument(parsing: "Heading\r\n=======\r\n\r\nBody")

        #expect(
            document.blocks == [
                .heading(level: 1, text: "Heading"),
                .paragraph("Body"),
            ]
        )
    }

    @Test
    func inlineFormatterRetainsEmphasisCodeAndLinks() {
        let formatted = MarkdownInlineFormatter.format(
            "Use **bold**, *emphasis*, `code`, and [docs](https://example.com)."
        )
        let runs = Array(formatted.runs)

        #expect(String(formatted.characters) == "Use bold, emphasis, code, and docs.")
        #expect(runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        #expect(runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        #expect(runs.contains { $0.link == URL(string: "https://example.com") })
    }

    @Test @MainActor
    func selectableTextAttributesPreserveInlineFormatting() throws {
        let revision = MarkdownContentRevision(
            "Use **bold**, *emphasis*, `code`, ~~removed~~, and [docs](https://example.com)."
        )
        let document = try #require(
            MarkdownRenderCache.shared.documentImmediately(for: revision)
        )
        guard case let .paragraph(inline) = document.blocks.first else {
            Issue.record("Expected a rendered paragraph")
            return
        }

        let attributed = MarkdownSelectableTextAttributes.make(
            from: inline,
            lineSpacing: 4,
            foregroundColor: T3Colors.uiTextSecondary
        )
        let text = attributed.string as NSString
        let boldIndex = try #require(index(of: "bold", in: text))
        let emphasisIndex = try #require(index(of: "emphasis", in: text))
        let codeIndex = try #require(index(of: "code", in: text))
        let removedIndex = try #require(index(of: "removed", in: text))
        let linkIndex = try #require(index(of: "docs", in: text))

        let boldFont = try #require(
            attributed.attribute(.font, at: boldIndex, effectiveRange: nil) as? UIFont
        )
        let emphasisFont = try #require(
            attributed.attribute(.font, at: emphasisIndex, effectiveRange: nil) as? UIFont
        )
        let codeFont = try #require(
            attributed.attribute(.font, at: codeIndex, effectiveRange: nil) as? UIFont
        )
        let paragraphStyle = try #require(
            attributed.attribute(.paragraphStyle, at: 0, effectiveRange: nil)
                as? NSParagraphStyle
        )

        #expect(boldFont.fontDescriptor.symbolicTraits.contains(.traitBold))
        #expect(emphasisFont.fontDescriptor.symbolicTraits.contains(.traitItalic))
        #expect(codeFont.fontDescriptor.symbolicTraits.contains(.traitMonoSpace))
        #expect(
            attributed.attribute(.backgroundColor, at: codeIndex, effectiveRange: nil)
                as? UIColor == T3Colors.uiSurfaceRaised
        )
        #expect(
            attributed.attribute(.strikethroughStyle, at: removedIndex, effectiveRange: nil)
                as? Int == NSUnderlineStyle.single.rawValue
        )
        #expect(
            attributed.attribute(.foregroundColor, at: boldIndex, effectiveRange: nil)
                as? UIColor == T3Colors.uiTextSecondary
        )
        #expect(
            attributed.attribute(.link, at: linkIndex, effectiveRange: nil) as? URL
                == URL(string: "https://example.com")
        )
        #expect(
            attributed.string
                == "Use bold, emphasis, code, removed, and docs."
        )
        #expect(paragraphStyle.lineSpacing == 4)
    }

    @Test @MainActor
    func selectableTextAttributesHonorDynamicTypeSize() throws {
        let document = try #require(
            MarkdownRenderCache.shared.documentImmediately(
                for: MarkdownContentRevision("Readable body text")
            )
        )
        guard case let .paragraph(inline) = document.blocks.first else {
            Issue.record("Expected a rendered paragraph")
            return
        }

        let small = MarkdownSelectableTextAttributes.make(
            from: inline,
            lineSpacing: 4,
            dynamicTypeSize: .small
        )
        let accessibility = MarkdownSelectableTextAttributes.make(
            from: inline,
            lineSpacing: 4,
            dynamicTypeSize: .accessibility1
        )
        let smallFont = try #require(
            small.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
        )
        let accessibilityFont = try #require(
            accessibility.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
        )

        #expect(accessibilityFont.pointSize > smallFont.pointSize)
    }

    @Test @MainActor
    func codeBlocksReuseSelectableInlineRendering() throws {
        let literalCode = "x = arr[i](fn)\na **b** c\nprintf(\\\"a\\\\tb\\\");"
        let cache = MarkdownRenderCache()
        let first = try #require(
            cache.documentImmediately(
                for: MarkdownContentRevision("```swift\n\(literalCode)\n```")
            )
        )
        let second = try #require(
            cache.documentImmediately(
                for: MarkdownContentRevision("Before\n\n```swift\n\(literalCode)\n```")
            )
        )

        guard case let .codeBlock(_, firstCode, firstInline) = first.blocks.first,
            case let .codeBlock(_, secondCode, secondInline) = second.blocks.last
        else {
            Issue.record("Expected rendered code blocks")
            return
        }

        #expect(firstCode == literalCode)
        #expect(secondCode == firstCode)
        #expect(firstInline === secondInline)
        #expect(firstInline.style == .code)

        let attributed = MarkdownSelectableTextAttributes.make(
            from: firstInline,
            lineSpacing: 3
        )
        let font = try #require(
            attributed.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
        )
        #expect(attributed.string == firstCode)
        #expect(font.fontDescriptor.symbolicTraits.contains(.traitMonoSpace))
    }

    @Test
    func restoresSelectionOnlyWhenTextIsExtended() {
        let selection = NSRange(location: 7, length: 5)

        #expect(
            MarkdownSelectionRestoration.range(
                previousText: "Hello, world",
                previousRange: selection,
                newText: "Hello, world!"
            ) == selection
        )
        #expect(
            MarkdownSelectionRestoration.range(
                previousText: "Hello, world",
                previousRange: selection,
                newText: "Different text"
            ) == NSRange(location: 0, length: 0)
        )
        #expect(
            MarkdownSelectionRestoration.range(
                previousText: "Hello, world",
                previousRange: NSRange(location: 7, length: 20),
                newText: "Hello, world!"
            ) == NSRange(location: 0, length: 0)
        )
    }

    private func index(of substring: String, in text: NSString) -> Int? {
        let range = text.range(of: substring)
        return range.location == NSNotFound ? nil : range.location
    }
}
