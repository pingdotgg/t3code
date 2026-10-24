import Foundation
import Testing
@testable import T3Code

@Suite("Command output terminal frames")
struct CommandOutputStateTests {
    @Test func splitEscapeAndCarriageReturnContinueAcrossAppends() throws {
        var state = CommandOutputState()
        state.apply(try frame("replace", "install\n12%\u{1B}[3"))
        #expect(state.text == "install\n12%")
        state.apply(try frame("append", "2m\r100%\u{1B}[0m\n"))
        #expect(state.text == "install\n100%\n")
        #expect(state.spans.contains { $0.text == "100%" && $0.style.foreground == .indexed(2) })
        #expect(state.running)
    }

    @Test func replacementDiscardsStaleTextPendingEscapesAndTruncation() throws {
        var state = CommandOutputState()
        state.apply(try frame("replace", "old\u{1B}[3", truncated: true))
        state.apply(try frame("replace", "fresh\n", running: false))
        #expect(state.text == "fresh\n")
        #expect(!state.running)
        #expect(!state.truncated)
    }

    @Test func resumeCursorAndSavedPositionRewriteTheSameRows() throws {
        var state = CommandOutputState()
        // This is the server resume shape: rendered lines, saved cursor, then live cursor.
        state.apply(try frame("replace", "one\ntwo\nthree\u{1B}[2A\u{1B}[2G\u{1B}7\u{1B}[2B\u{1B}[6G"))
        state.apply(try frame("append", "!\u{1B}8X\u{1B}[K"))
        #expect(state.text == "oX\ntwo\nthree!")
    }

    @Test func redrawErasesAndBackspaceDoNotExposeControlBytes() throws {
        var state = CommandOutputState()
        state.apply(try frame("replace", "download 12%\nwaiting\u{1B}[1A\r\u{1B}[2Kdone\u{1B}[1B\r\u{1B}[2Kokay?\u{8}!"))
        #expect(state.text == "done\nokay!")
        state.apply(try frame("append", "\u{1B}[2Jclean"))
        #expect(state.text == "clean")
    }

    @Test func hiddenStringEscapesStayHiddenAcrossChunksAndOverlongPayloads() throws {
        var state = CommandOutputState()
        state.apply(try frame("replace", "before\u{1B}]0;" + String(repeating: "hidden", count: 100)))
        #expect(state.text == "before")
        state.apply(try frame("append", "still hidden\u{1B}\\after\u{7}"))
        #expect(state.text == "beforeafter")
    }

    @Test func outputAndCursorPaddingStayBoundedWithoutSplittingASurrogate() throws {
        var state = CommandOutputState(limit: 64)
        state.apply(try frame("replace", String(repeating: "😀", count: 100) + "\nlast\n", truncated: true))
        #expect(state.text.utf16.count <= 64)
        #expect(!state.text.contains("\u{FFFD}"))
        #expect(state.text.hasSuffix("last\n"))
        state.apply(try frame("append", "\u{1B}[999999C!"))
        #expect(state.text.utf16.count <= 64)
        #expect(state.text.hasSuffix("!"))
        #expect(state.truncated)
    }

    @Test func extendedStylesResetWithoutChangingPlainText() throws {
        var state = CommandOutputState()
        state.apply(try frame("replace", "\u{1B}[1;3;4;38;2;12;34;56mRGB\u{1B}[0m plain"))
        #expect(state.text == "RGB plain")
        let colored = try #require(state.spans.first)
        #expect(colored.style.foreground == .rgb(12, 34, 56))
        #expect(colored.style.bold && colored.style.italic && colored.style.underline)
        #expect(state.spans.last?.style == CommandOutputStyle())
    }

    @Test func chunkBoundariesDoNotChangeOrdinaryRedrawResults() throws {
        let text = "first\n\u{1B}[32mprogress 0%\rprogress 100%\u{1B}[0m\n\u{1B}]title\u{7}done"
        var whole = CommandOutputState()
        whole.apply(try frame("replace", text))
        var split = CommandOutputState()
        split.apply(try frame("replace", ""))
        for character in text { split.apply(try frame("append", String(character))) }
        #expect(split.text == whole.text)
        #expect(split.spans == whole.spans)
    }

    @Test func unknownFrameKindsFailDecodingInsteadOfAppending() {
        #expect(throws: DecodingError.self) { try frame("reset", "invalid") }
    }

    private func frame(_ kind: String, _ text: String, truncated: Bool = false, running: Bool = true) throws -> CommandOutputFrame {
        try JSONValue.object([
            "kind": .string(kind), "text": .string(text), "truncated": .bool(truncated), "running": .bool(running),
        ]).decode(CommandOutputFrame.self)
    }
}
