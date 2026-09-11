import Foundation
import Testing
import UIKit
@testable import T3Code

@Suite("Markdown selection copy") @MainActor
struct MarkdownSelectionCopyTests {
    private func prose(_ source: String) throws -> NSAttributedString {
        let document = try #require(MarkdownRenderCache.shared.documentImmediately(for: MarkdownContentRevision(source)))
        return MarkdownContinuousSelection.attributedText(blocks: document.blocks)
    }

    private func copy(_ text: NSAttributedString, selecting substring: String? = nil) throws -> String {
        let range = substring.map { (text.string as NSString).range(of: $0) }
            ?? NSRange(location: 0, length: text.length)
        return try #require(MarkdownSelectionCopy.markdown(in: text, range: range))
    }

    @Test func partialFormattingRemainsBalanced() throws {
        let text = try prose("Before **bold _and italic_ ending** after.")
        #expect(try copy(text, selecting: "old and italic en") == "**old *and italic* en**")
        #expect(try copy(text, selecting: "and ital") == "***and ital***")
        #expect(try copy(text, selecting: " ending") == " **ending**")
    }

    @Test func linksAndLiteralMarkdownStayPortable() throws {
        let text = try prose(#"Open [documentation](https://example.com/docs?q=hello) and \*literal\*."#)
        #expect(try copy(text, selecting: "document") == "[document](<https://example.com/docs?q=hello>)")
        #expect(try copy(text, selecting: "*literal*") == #"\*literal\*"#)
        let marker = try prose(#"\- this is prose"#)
        #expect(try copy(marker) == #"\- this is prose"#)
    }

    @Test func selectionAcrossHeadingAndListsContainsOnlySelectedText() throws {
        let text = try prose("""
        ## Heading

        First paragraph.

        - One item
          - Nested item
        - Last item

        Final paragraph.
        """)
        #expect(try copy(text) == "## Heading\n\nFirst paragraph.\n\n- One item\n  - Nested item\n- Last item\n\nFinal paragraph.")
        #expect(try copy(text, selecting: "Nested") == "  - Nested")
    }

    @Test func inlineCodeUsesSafeDelimiters() throws {
        let text = try prose("Use `` a`b `` and ~~old~~.")
        #expect(try copy(text, selecting: "a`b") == "``a`b``")
        #expect(try copy(text, selecting: "old") == "~~old~~")
        #expect(MarkdownSelectionCopy.fencedCode("print(\"```\")", language: "swift") == "````swift\nprint(\"```\")\n````")
    }

    @Test func selectedCodeAndProseUseMarkdownOnTheClipboard() throws {
        let text = NSMutableAttributedString(attributedString: try prose("Before **bold**."))
        text.append(NSAttributedString(string: "\n"))
        let code = NSMutableAttributedString(string: "let first = 1\nlet second = 2", attributes: [
            .markdownCopyBlock: MarkdownCopyBlock(.code(language: "swift")),
        ])
        text.append(code)
        text.append(NSAttributedString(string: "\n"))
        text.append(try prose("After _italic_."))
        let view = MarkdownSelectionTextView(frame: .zero, textContainer: nil)
        view.attributedText = text
        let start = (text.string as NSString).range(of: "bold").location
        let end = NSMaxRange((text.string as NSString).range(of: "After"))
        view.selectedRange = NSRange(location: start, length: end - start)
        view.copy(nil)
        #expect(UIPasteboard.general.string == "**bold**.\n\n```swift\nlet first = 1\nlet second = 2\n```\n\nAfter")
        #expect(try copy(code, selecting: "second") == "```swift\nsecond\n```")
    }

    @Test func integratedCodeCardsCopyThroughTheirHeaders() throws {
        let text = try prose("""
        Before **bold**.

        ```swift
        let first = 1
        let second = 2
        ```

        After *italic*.
        """)
        #expect(try copy(text) == "Before **bold**.\n\n```swift\nlet first = 1\nlet second = 2\n```\n\nAfter *italic*.")
        #expect(try copy(text, selecting: "first") == "```swift\nfirst\n```")
        let view = MarkdownSelectionTextView(frame: .zero, textContainer: nil)
        view.isScrollEnabled = false
        view.attributedText = text
        view.frame = CGRect(x: 0, y: 0, width: 320, height: 800)
        view.layoutIfNeeded()
        #expect(view.sizeThatFits(CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude)).height < 800)
    }

    @Test func intrawordEmphasisAndHeadingLikeTextRemainMarkdown() throws {
        #expect(try copy(prose("alpha*beta*gamma")) == "alpha*beta*gamma")
        #expect(try copy(prose("\\## literal heading")) == "\\## literal heading")
        #expect(try copy(prose(#"\---"#)) == #"\---"#)
    }

    @Test func multiBlockListCopyRetainsParagraphsHeadingsAndCode() throws {
        let source = """
        - first

          second paragraph

          ## Heading

          ```swift
          let value = 1
          print(value)
          ```
        """
        let text = try prose(source)
        #expect(try copy(text) == source)
        let copied = try copy(text)
        let document = try #require(MarkdownRenderCache.shared.documentImmediately(for: MarkdownContentRevision(copied)))
        guard case let .unorderedList(items) = document.blocks.first else {
            Issue.record("Copied content should remain a list")
            return
        }
        #expect(document.blocks.count == 1)
        #expect(items.count == 1)
        #expect(items[0].blocks.count == 4)
        #expect(try copy(text, selecting: "second paragraph") == "  second paragraph")
    }

    @Test func orderedListContinuationUsesMarkerWidthAtEachLevel() throws {
        let source = """
        10. Parent

            another paragraph
            - Nested

              nested continuation

              ```swift
              value()
              ```
        11. Last
        """
        #expect(try copy(prose(source)) == source)
    }

    @Test func emptyCodeCardSurvivesRenderingAndCopy() throws {
        let source = "Before\n\n```swift\n```\n\nAfter"
        let text = try prose(source)
        var cardRange: NSRange?
        text.enumerateAttribute(.markdownCodeCard, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            if let card = value as? MarkdownCodeCard {
                #expect(card.code.isEmpty)
                #expect(card.language == "swift")
                cardRange = range
            }
        }
        #expect(try #require(cardRange).length > 0)
        #expect(try copy(text) == "Before\n\n```swift\n\n```\n\nAfter")
        let view = MarkdownSelectionTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 500), textContainer: nil)
        view.attributedText = text
        view.layoutIfNeeded()
        let header = try #require(view.subviews.first { $0.subviews.contains { ($0 as? UIButton)?.accessibilityLabel == "Copy code block" } })
        #expect(header.frame.height == MarkdownCodeCard.headerHeight)
        #expect(header.frame.width > 0)
    }

    @Test func unicodeAndEmptySelectionsAreHandled() throws {
        let text = try prose("Hello **café 👩🏽‍💻 日本語** goodbye.")
        #expect(try copy(text, selecting: "👩🏽‍💻 日本") == "**👩🏽‍💻 日本**")
        #expect(MarkdownSelectionCopy.markdown(in: text, range: NSRange(location: 0, length: 0)) == nil)
        #expect(MarkdownSelectionCopy.markdown(in: text, range: NSRange(location: text.length, length: 1)) == nil)
    }
}
