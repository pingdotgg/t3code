import Foundation
import Testing
@testable import T3Code

struct TerminalBufferTests {
    private static let limit = 512 * 1024

    /// Mirrors the client's cap: keep the last `limit` bytes, then drop up to
    /// and including the next newline so the head is a whole line.
    private static func capped(_ buffer: String) -> String {
        let utf8 = buffer.utf8
        guard utf8.count > limit else { return buffer }
        var tail = Data(utf8.suffix(limit))
        if let newline = tail.firstIndex(of: UInt8(ascii: "\n")) {
            tail = tail[tail.index(after: newline)...]
        }
        return String(decoding: tail, as: UTF8.self)
    }

    private static func applied(_ buffer: String) -> TerminalBufferDelta.Applied {
        TerminalBufferDelta.Applied(buffer: buffer)
    }

    @Test func firstBufferAppendsEverything() {
        let delta = TerminalBufferDelta.compute(previous: .init(), next: "$ ls\r\n")
        #expect(delta == .append(Data("$ ls\r\n".utf8)))
    }

    @Test func prefixExtensionAppendsOnlyTheTail() {
        let previous = "line one\r\nline two\r\n"
        let delta = TerminalBufferDelta.compute(
            previous: Self.applied(previous),
            next: previous + "line three\r\n"
        )
        #expect(delta == .append(Data("line three\r\n".utf8)))
    }

    @Test func unchangedBufferAppendsNothing() {
        let previous = "unchanged\r\n"
        let delta = TerminalBufferDelta.compute(previous: Self.applied(previous), next: previous)
        #expect(delta == .append(Data()))
    }

    @Test func multibyteContentSlicesOnByteOffsets() {
        let previous = "héllo 🔧\r\n"
        let delta = TerminalBufferDelta.compute(
            previous: Self.applied(previous),
            next: previous + "wörld 🚀\r\n"
        )
        #expect(delta == .append(Data("wörld 🚀\r\n".utf8)))
    }

    @Test func headTrimmedBufferAppendsOnlyTheNewTail() {
        // A buffer already at the cap. The next output event pushes it over,
        // and the client trims the head instead of growing.
        var lines = [String]()
        var size = 0
        var index = 0
        while size <= Self.limit {
            let line = "line \(index) " + String(repeating: "x", count: 60) + "\n"
            lines.append(line)
            size += line.utf8.count
            index += 1
        }
        let previous = Self.capped(lines.joined())
        #expect(previous.utf8.count <= Self.limit)

        // Larger than the slack the line trim left, so this event forces a trim.
        let output = String(repeating: "fresh output after the trim\n", count: 10)
        let next = Self.capped(previous + output)
        #expect(previous.utf8.count + output.utf8.count > Self.limit)
        #expect(!next.hasPrefix(previous))

        let delta = TerminalBufferDelta.compute(previous: Self.applied(previous), next: next)
        #expect(delta == .append(Data(output.utf8)))
    }

    @Test func largeTrimStillFindsTheAnchor() {
        let previous = String(repeating: "old line\n", count: 20_000)
        let keptBytes = TerminalBufferDelta.anchorLength + 1_000
        let next = String(previous.suffix(keptBytes)) + "new\n"
        let delta = TerminalBufferDelta.compute(previous: Self.applied(previous), next: next)
        #expect(delta == .append(Data("new\n".utf8)))
    }

    @Test func unrelatedBufferReplaces() {
        let previous = String(repeating: "the old session\n", count: 500)
        let next = String(repeating: "a different session\n", count: 500)
        let delta = TerminalBufferDelta.compute(previous: Self.applied(previous), next: next)
        #expect(delta == .replace(Data(next.utf8)))
    }

    @Test func emptyBufferReplacesWithNothing() {
        let delta = TerminalBufferDelta.compute(previous: Self.applied("$ ls\r\nfoo\r\n"), next: "")
        #expect(delta == .replace(Data()))
    }

    @Test func appliedStateTracksAppendsAndReplaces() {
        var applied = TerminalBufferDelta.Applied()
        var buffer = ""
        for index in 0..<300 {
            let chunk = "chunk \(index) " + String(repeating: "y", count: 40) + "\r\n"
            let next = buffer + chunk
            let delta = TerminalBufferDelta.compute(previous: applied, next: next)
            #expect(delta == .append(Data(chunk.utf8)))
            applied.apply(delta)
            buffer = next
        }
        #expect(applied == Self.applied(buffer))

        let replaced = "reset\r\n"
        let delta = TerminalBufferDelta.compute(previous: applied, next: replaced)
        #expect(delta == .replace(Data(replaced.utf8)))
        applied.apply(delta)
        #expect(applied == Self.applied(replaced))
    }
}
