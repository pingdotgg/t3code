import Foundation
import Testing

@testable import SergeCodeMac

@Suite("IntralineDiff")
struct IntralineDiffTests {
    @Test("tokenizes words and separators")
    func tokenizeBasic() {
        // Non-word runs (spaces + punctuation) stay as a single separator token.
        let tokens = IntralineDiff.tokenize("foo_bar = 1")
        #expect(tokens == ["foo_bar", " = ", "1"])
        #expect(tokens.joined() == "foo_bar = 1")
    }

    @Test("tokenizes unicode identifiers")
    func tokenizeUnicode() {
        let tokens = IntralineDiff.tokenize("café = ☕")
        #expect(tokens.contains("café"))
        #expect(tokens.contains("☕") || tokens.joined().contains("☕"))
    }

    @Test("identical lines produce no changed spans")
    func identicalNoChange() {
        let pair = IntralineDiff.diffTokens(old: "let x = 1", new: "let x = 1")
        #expect(pair.deletion.allSatisfy { !$0.isChanged })
        #expect(pair.addition.allSatisfy { !$0.isChanged })
    }

    @Test("single token change is highlighted")
    func singleTokenChange() {
        let pair = IntralineDiff.diffTokens(old: "Color.red", new: "Color.orange")
        let changedDel = pair.deletion.filter(\.isChanged).map(\.text)
        let changedAdd = pair.addition.filter(\.isChanged).map(\.text)
        #expect(changedDel == ["red"])
        #expect(changedAdd == ["orange"])
        #expect(pair.deletion.filter { !$0.isChanged }.map(\.text).joined() == "Color.")
    }

    @Test("empty lines pair cleanly")
    func emptyLines() {
        let pair = IntralineDiff.diffTokens(old: "", new: "")
        #expect(pair.deletion.isEmpty)
        #expect(pair.addition.isEmpty)

        let onlyNew = IntralineDiff.diffTokens(old: "", new: "hello")
        #expect(onlyNew.addition.contains { $0.isChanged })
    }

    @Test("long lines fall back to whole-line spans")
    func longLinesFallBackToWholeLineSpans() {
        let old = String(repeating: "a", count: 10_000)
        let new = String(repeating: "b", count: 10_000)

        let pair = IntralineDiff.diffTokens(old: old, new: new)

        #expect(pair.deletion == [IntralineSpan(text: old, isChanged: true)])
        #expect(pair.addition == [IntralineSpan(text: new, isChanged: true)])
    }

    @Test("pairs equal-length deletion/addition runs")
    func equalRunPairing() {
        let lines = [
            DiffLine(kind: .context, text: "keep", oldNumber: 1, newNumber: 1),
            DiffLine(kind: .deletion, text: "oldA", oldNumber: 2, newNumber: nil),
            DiffLine(kind: .deletion, text: "oldB", oldNumber: 3, newNumber: nil),
            DiffLine(kind: .addition, text: "newA", oldNumber: nil, newNumber: 2),
            DiffLine(kind: .addition, text: "newB", oldNumber: nil, newNumber: 3),
            DiffLine(kind: .context, text: "end", oldNumber: 4, newNumber: 4),
        ]
        let map = IntralineDiff.pairHunkLines(lines)
        #expect(map[1] != nil)
        #expect(map[2] != nil)
        #expect(map[3] != nil)
        #expect(map[4] != nil)
        #expect(map[0] == nil)  // context unpaired
        #expect(map[5] == nil)
    }

    @Test("unequal run lengths still pair positionally")
    func unequalRunLengths() {
        let lines = [
            DiffLine(kind: .deletion, text: "a = 1", oldNumber: 1, newNumber: nil),
            DiffLine(kind: .deletion, text: "b = 2", oldNumber: 2, newNumber: nil),
            DiffLine(kind: .addition, text: "a = 9", oldNumber: nil, newNumber: 1),
        ]
        let map = IntralineDiff.pairHunkLines(lines)
        #expect(map[0] != nil)
        #expect(map[1] != nil)  // unpaired-length del still gets a span list
        #expect(map[2] != nil)
        let changed = map[0]?.filter(\.isChanged).map(\.text) ?? []
        #expect(changed == ["1"])
    }

    @Test("unpaired deletion run gets no entry")
    func unpairedDeletion() {
        let lines = [
            DiffLine(kind: .context, text: "x", oldNumber: 1, newNumber: 1),
            DiffLine(kind: .deletion, text: "gone", oldNumber: 2, newNumber: nil),
            DiffLine(kind: .context, text: "y", oldNumber: 3, newNumber: 2),
        ]
        let map = IntralineDiff.pairHunkLines(lines)
        #expect(map.isEmpty)
    }

    @Test("unpaired addition run gets no entry")
    func unpairedAddition() {
        let lines = [
            DiffLine(kind: .addition, text: "fresh", oldNumber: nil, newNumber: 1),
        ]
        let map = IntralineDiff.pairHunkLines(lines)
        #expect(map.isEmpty)
    }
}
