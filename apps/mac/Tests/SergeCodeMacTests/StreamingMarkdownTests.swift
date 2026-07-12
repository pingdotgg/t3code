import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Streaming markdown")
@MainActor
struct StreamingMarkdownTests {
    @Test("scanner tracks backtick and tilde fences across chunks")
    func scannerFences() {
        let beforeFence = "before\n\n"
        var scanner = MarkdownSafeSplitScanner()
        scanner.consume(beforeFence.utf8)
        #expect(scanner.lastSafeBoundary == 0)

        scanner.consume("```swift\n\ninside\n\n".utf8)
        #expect(scanner.lastSafeBoundary == beforeFence.utf8.count)

        scanner.consume("````\n\nnext\n".utf8)
        let afterBacktickFence = (beforeFence + "```swift\n\ninside\n\n````\n\n").utf8.count
        #expect(scanner.lastSafeBoundary == afterBacktickFence)

        let tildePrefix = "intro\n\n"
        var tildeScanner = MarkdownSafeSplitScanner()
        tildeScanner.consume((tildePrefix + "   ~~~~swift\nbody\n").utf8)
        #expect(tildeScanner.lastSafeBoundary == tildePrefix.utf8.count)
        tildeScanner.consume("   ~~~~~ \t\n\nnext\n".utf8)
        let afterTildeFence =
            (tildePrefix + "   ~~~~swift\nbody\n   ~~~~~ \t\n\n").utf8.count
        #expect(tildeScanner.lastSafeBoundary == afterTildeFence)
    }

    @Test("blank lines inside an unterminated fence never become boundaries")
    func scannerUnterminatedFence() {
        let markdown = "before\n\n```swift\n\ninside\n\nthen more\n\nheading\n"
        var scanner = MarkdownSafeSplitScanner()
        scanner.consume(markdown.utf8)

        #expect(scanner.lastSafeBoundary == "before\n\n".utf8.count)
    }

    @Test("scanner blocks list markers and indented continuations")
    func scannerContinuationGuards() {
        let blockedLines = ["1. ordered\n", "- bullet\n", "    code\n", "\tcode\n"]
        for line in blockedLines {
            var scanner = MarkdownSafeSplitScanner()
            scanner.consume(("before\n\n" + line).utf8)
            #expect(scanner.lastSafeBoundary == 0)
        }
    }

    @Test("scanner confirms headings, paragraphs, and quotes")
    func scannerIndependentBlocks() {
        for nextLine in ["# heading\n", "paragraph\n", "> quote\n"] {
            var scanner = MarkdownSafeSplitScanner()
            scanner.consume(("before\n\n" + nextLine).utf8)
            #expect(scanner.lastSafeBoundary == "before\n\n".utf8.count)
        }
    }

    @Test("incremental blocks equal a full parse after every UTF-8-safe flush")
    func equivalenceProperty() {
        let fixtures = [
            """
            First paragraph with café and an emoji 🙂.

            Second paragraph with **strong** and ~~deleted~~ text.

            ### A heading

            The final paragraph.
            """,
            """
            - parent
              - child
                - leaf

            After the nested list.
            """,
            """
            1. first item

            2. second item

            3. third item

            Conclusion after the loose ordered list.
            """,
            """
            Before the fences.

            ~~~swift
            let one = 1

            let two = 2
            ~~~

            Between the fences.

            ```text
            a

            b
            ```

            After the fences.
            """,
            """
            | Name | Count | Notes |
            | :--- | ---: | :---: |
            | one | 1 | first |
            | two | 2 | second |

            After the table.
            """,
            """
            > first paragraph
            >
            > second paragraph

            Outside the quote.

            > - nested
            > - quoted list

            End of the document.
            """,
        ]

        for (index, fixture) in fixtures.enumerated() {
            StreamingMarkdownCache.resetForTesting()
            MarkdownBlockCache.resetForTesting()
            stream(fixture, threadID: "equivalence-thread-\(index)", messageID: "message") {
                StreamingMarkdownCache.blocks(
                    threadID: "equivalence-thread-\(index)",
                    messageID: "message",
                    markdown: $0)
            } assertFullParse: { prefix, actual in
                #expect(actual == MarkdownBlockCache.document(for: prefix).blocks)
            }
        }
    }

    @Test("tail parsing remains bounded for a large deterministic stream")
    func complexityInvariant() {
        var paragraphs: [String] = []
        var byteCount = 0
        while byteCount < 200_000 {
            let paragraph =
                "Paragraph \(paragraphs.count) contains stable prose and enough words to "
                + "make the streaming tail measurable.\n\n"
            paragraphs.append(paragraph)
            byteCount += paragraph.utf8.count
        }
        let markdown = paragraphs.joined()
        let sourceBytes = Array(markdown.utf8)

        StreamingMarkdownCache.resetForTesting()
        MarkdownBlockCache.resetForTesting()

        var prefix = ""
        var offset = 0
        while offset < sourceBytes.count {
            let end = min(offset + 1_024, sourceBytes.count)
            prefix += String(decoding: sourceBytes[offset..<end], as: UTF8.self)
            _ = StreamingMarkdownCache.blocks(
                threadID: "complexity-thread", messageID: "large", markdown: prefix)
            offset = end
        }

        #expect(StreamingMarkdownCache.resetCount == 0)
        #expect(StreamingMarkdownCache.tailBytesParsedTotal < 8 * sourceBytes.count)
        #expect(StreamingMarkdownCache.segmentParseCount > 10)
    }

    @Test("a non-append update resets the session and reparses correctly")
    func resetPath() {
        StreamingMarkdownCache.resetForTesting()
        MarkdownBlockCache.resetForTesting()

        let initial = "stable paragraph\n\n" + String(repeating: "streaming tail ", count: 20)
        _ = StreamingMarkdownCache.blocks(
            threadID: "reset-thread", messageID: "reset-message", markdown: initial)

        let mutated = "replacement heading\n\nnew paragraph"
        let actual = StreamingMarkdownCache.blocks(
            threadID: "reset-thread", messageID: "reset-message", markdown: mutated)

        #expect(actual == MarkdownBlockCache.document(for: mutated).blocks)
        #expect(StreamingMarkdownCache.resetCount == 1)
    }

    private func stream(
        _ markdown: String,
        threadID: String,
        messageID: String,
        receive: (String) -> [MarkdownBlock],
        assertFullParse: (String, [MarkdownBlock]) -> Void
    ) {
        var random = SeededChunkGenerator(state: 0xC0D3_0004)
        let scalars = Array(markdown.unicodeScalars)
        var scalarIndex = 0
        var prefix = ""

        while scalarIndex < scalars.count {
            let targetBytes = random.nextChunkSize()
            var chunkBytes = 0
            repeat {
                let scalarText = String(scalars[scalarIndex])
                let scalarByteCount = scalarText.utf8.count
                if chunkBytes > 0, chunkBytes + scalarByteCount > targetBytes {
                    break
                }
                prefix.append(contentsOf: scalarText)
                chunkBytes += scalarByteCount
                scalarIndex += 1
            } while scalarIndex < scalars.count

            let actual = receive(prefix)
            assertFullParse(prefix, actual)
        }

        _ = threadID
        _ = messageID
    }

    private struct SeededChunkGenerator {
        var state: UInt64

        mutating func nextChunkSize() -> Int {
            state = state &* 2_862_933_555_777_941_757 &+ 3_037_000_493
            return Int(state % 97) + 1
        }
    }
}
