import Foundation
import Testing
@testable import T3Code

@Suite("Chat Markdown")
struct MarkdownDocumentTests {
    @Test
    func parsesStandaloneImagesWithoutChangingMixedProse() {
        let document = MarkdownDocument(
            parsing: """
            Before

            ![Simulator preview](./artifacts/demo.png "Latest run")

            See ![small preview](inline.png) above.
            """
        )

        #expect(document.blocks == [
            .paragraph("Before"),
            .image(MarkdownImageReference(
                source: "./artifacts/demo.png",
                alt: "Simulator preview"
            )),
            .paragraph("See ![small preview](inline.png) above."),
        ])
    }

    @Test
    func keepsMultilineAndMalformedImageParagraphsAsText() {
        #expect(
            MarkdownDocument(parsing: "![Preview](demo.png)\ncontinues here").blocks == [
                .paragraph("![Preview](demo.png)\ncontinues here"),
            ]
        )
        #expect(
            MarkdownDocument(parsing: "![Preview](demo.png invalid-title)").blocks == [
                .paragraph("![Preview](demo.png invalid-title)"),
            ]
        )
    }

    @Test
    func parsesEscapesAndAllCommonMarkImageTitleDelimiters() {
        #expect(
            MarkdownDocument(parsing: #"![a\](b](images/demo.png)"#).blocks == [
                .image(MarkdownImageReference(source: "images/demo.png", alt: "a](b")),
            ]
        )
        #expect(
            MarkdownDocument(parsing: #"![Plot](plot\).png)"#).blocks == [
                .image(MarkdownImageReference(source: "plot).png", alt: "Plot")),
            ]
        )
        #expect(
            MarkdownDocument(parsing: "![Diagram](diagram.png (Architecture))").blocks == [
                .image(MarkdownImageReference(source: "diagram.png", alt: "Diagram")),
            ]
        )
    }

    @Test
    func preservesStandaloneImagesInsideListsAndQuotes() {
        let document = MarkdownDocument(
            parsing: """
            - ![List preview](images/list.png)

            > ![Quoted preview](images/quote.png)
            """
        )

        guard case let .unorderedList(items) = document.blocks.first else {
            Issue.record("Expected image in a list")
            return
        }
        #expect(items.first?.blocks == [
            .image(MarkdownImageReference(source: "images/list.png", alt: "List preview")),
        ])

        guard case let .blockquote(quote) = document.blocks.last else {
            Issue.record("Expected image in a quote")
            return
        }
        #expect(quote.blocks == [
            .image(MarkdownImageReference(source: "images/quote.png", alt: "Quoted preview")),
        ])
    }

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
    func recycledMarkdownLinkRelayUsesItsLatestHandler() throws {
        let relay = MarkdownLinkActionRelay()
        let url = try #require(URL(string: "Sources/App.swift"))
        var firstHandlerCount = 0
        var currentHandlerCount = 0

        relay.handler = { _ in firstHandlerCount += 1 }
        relay.handler = { _ in currentHandlerCount += 1 }
        relay.open(url)

        #expect(firstHandlerCount == 0)
        #expect(currentHandlerCount == 1)
    }
}
