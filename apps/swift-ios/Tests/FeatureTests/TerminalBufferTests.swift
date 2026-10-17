import Foundation
import Testing
@testable import T3Code

struct TerminalBufferTests {
    private static let limit = NativeFeatureClient.terminalBufferLimit

    private static func capped(_ buffer: String) -> String {
        NativeFeatureClient.cappedTerminalBuffer(buffer)
    }

    /// A buffer just over the cap, built from whole lines.
    private static func overLimitBuffer() -> String {
        var lines = [String]()
        var size = 0
        var index = 0
        while size <= limit {
            let line = "line \(index) " + String(repeating: "x", count: 60) + "\n"
            lines.append(line)
            size += line.utf8.count
            index += 1
        }
        return lines.joined()
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

    @Test func trimLeavesRoomForLaterOutputToAppend() {
        let previous = Self.capped(Self.overLimitBuffer())
        #expect(previous.utf8.count <= NativeFeatureClient.terminalBufferTrimTarget)
        #expect(previous.hasPrefix("line "))

        // Output after a trim grows the buffer without trimming the head again,
        // so the view gets a cheap append instead of a full reset.
        let output = String(repeating: "fresh output after the trim\n", count: 40)
        let next = Self.capped(previous + output)
        let delta = TerminalBufferDelta.compute(previous: Self.applied(previous), next: next)
        #expect(delta == .append(Data(output.utf8)))
    }

    @Test func trimSnapsToCharacterAndLineBoundaries() {
        let buffer = String(repeating: "héllo 🔧 wörld\n", count: Self.limit / 10)
        let capped = Self.capped(buffer)
        #expect(capped.utf8.count <= NativeFeatureClient.terminalBufferTrimTarget)
        #expect(capped.hasPrefix("héllo 🔧 wörld\n"))
        #expect(buffer.hasSuffix(capped))
    }

    @Test func repeatedOutputAfterTrimmingDoesNotDuplicateHistory() {
        let previous = String(repeating: "old line\n", count: 20_000)
        let keptBytes = 5_096
        let next = String(previous.suffix(keptBytes)) + "new\n"
        let delta = TerminalBufferDelta.compute(previous: Self.applied(previous), next: next)
        #expect(delta == .replace(Data(next.utf8)))
    }

    @Test func changedPrefixWithTheSameLongSuffixReplaces() {
        let suffix = String(repeating: "shared output\n", count: 1_000)
        let next = "new session\n" + suffix
        let delta = TerminalBufferDelta.compute(previous: Self.applied("old session\n" + suffix), next: next)
        #expect(delta == .replace(Data(next.utf8)))
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
