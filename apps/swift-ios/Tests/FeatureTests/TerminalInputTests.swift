import Testing
import UIKit
@testable import T3Code

@MainActor
struct TerminalInputTests {
    @Test func pasteNormalizesLineBreaksAndKeepsTextAndTabs() {
        #expect(TerminalInputEncoder.paste("") == "")
        #expect(TerminalInputEncoder.paste("git status\t🔧") == "git status\t🔧")
        #expect(TerminalInputEncoder.paste("one\ntwo\r\nthree\rfour\n\n") == "one\rtwo\rthree\rfour\r\r")
    }

    @Test func pasteReplacesControlsAndBracketedPasteMarkers() {
        let text = "safe\u{1B}[201~\u{00}\u{08}\u{0B}\u{0C}\u{0E}\u{1F}\u{7F}\tend"
        #expect(TerminalInputEncoder.paste(text) == "safe [201~       \tend")
    }

    @Test func chunksFitTheWireLimit() {
        let limit = TerminalInputEncoder.maximumWriteLength
        #expect(TerminalInputEncoder.chunks("").isEmpty)
        #expect(TerminalInputEncoder.chunks("ls") == ["ls"])
        #expect(TerminalInputEncoder.chunks(String(repeating: "x", count: limit)).count == 1)

        let data = String(repeating: "y", count: limit * 2 + 5)
        let chunks = TerminalInputEncoder.chunks(data)
        #expect(chunks.map { $0.utf16.count } == [limit, limit, 5])
        #expect(chunks.joined() == data)
    }

    @Test func chunksKeepSurrogatePairsWhole() {
        let limit = TerminalInputEncoder.maximumWriteLength
        let data = String(repeating: "z", count: limit - 1) + "😀tail"
        let chunks = TerminalInputEncoder.chunks(data)
        #expect(chunks.map { $0.utf16.count } == [limit - 1, 6])
        #expect(chunks.last == "😀tail")
        #expect(chunks.joined() == data)
    }

    @Test func oneLongGraphemeCannotExceedTheWireLimit() {
        let limit = TerminalInputEncoder.maximumWriteLength
        let data = "a" + String(repeating: "\u{0301}", count: limit)
        #expect(data.count == 1)
        let chunks = TerminalInputEncoder.chunks(data)
        #expect(chunks.map { $0.utf16.count } == [limit, 1])
        #expect(chunks.joined() == data)
    }

    @Test func toolbarPasteChordUsesTheReportedHostOS() {
        for os in ["windows", "linux", "unknown"] {
            let host = TerminalHostPlatform(os: os)
            #expect(TerminalInputEncoder.modified("v", modifier: .control, hostPlatform: host) == .paste)
            #expect(TerminalInputEncoder.modified("V", modifier: .control, hostPlatform: host) == .paste)
            #expect(TerminalInputEncoder.modified("v", modifier: .command, hostPlatform: host) == .write("\u{1B}v"))
        }
        let mac = TerminalHostPlatform(os: "darwin")
        #expect(mac == .mac)
        #expect(TerminalHostPlatform(os: nil) == .unknown)
        #expect(TerminalHostPlatform(os: "My MacBook") == .unknown)
        #expect(TerminalInputEncoder.modified("v", modifier: .command, hostPlatform: mac) == .paste)
        #expect(TerminalInputEncoder.modified("v", modifier: .control, hostPlatform: mac) == .write("\u{16}"))
        #expect(TerminalInputEncoder.modified("C", modifier: .control, hostPlatform: mac) == .write("\u{03}"))
        #expect(TerminalInputEncoder.modified("[A", modifier: .command, hostPlatform: mac) == .write("\u{1B}[A"))
    }

    @Test func hardwareCommandVPastesOnEveryHost() {
        for host in [TerminalHostPlatform.mac, .linux, .windows, .unknown] {
            #expect(TerminalHardwareKeyEncoder.sequence(input: "v", modifiers: .command, hostPlatform: host) == "paste")
            #expect(TerminalHardwareKeyEncoder.sequence(input: "c", modifiers: .command, hostPlatform: host) == "copy")
            #expect(
                TerminalHardwareKeyEncoder.sequence(input: "v", modifiers: .control, hostPlatform: host)
                    == (host == .mac ? "\u{16}" : "paste")
            )
        }
        #expect(TerminalHardwareKeyEncoder.sequence(input: "\t", modifiers: .shift, hostPlatform: .mac) == "\u{1B}[Z")
    }

    @Test func queuedKeysWaitForEveryPasteChunk() async throws {
        let session = TerminalInputSession()
        let target = makeTarget()
        session.attach(to: target)
        let writer = TerminalWriteProbe()
        let paste = try #require(session.enqueue(
            String(repeating: "a", count: TerminalInputEncoder.maximumWriteLength) + "tail\n",
            target: target,
            isPaste: true,
            write: writer.write
        ))
        await writer.waitForFirstWrite()
        let key = try #require(session.enqueue("\u{03}", target: target, write: writer.write))
        session.updateTarget(target)
        writer.finishFirstWrite()

        #expect(await paste.value)
        #expect(await key.value)
        #expect(writer.writes.map { $0.utf16.count } == [65_536, 5, 1])
        #expect(Array(writer.writes.suffix(2)) == ["tail\r", "\u{03}"])
        #expect(writer.maximumActiveWrites == 1)
    }

    @Test func pendingKeysShareOneWriteAndStopAtPasteBoundaries() async throws {
        let session = TerminalInputSession()
        let target = makeTarget()
        session.attach(to: target)
        let writer = TerminalWriteProbe()
        let first = try #require(session.enqueue("a", target: target, write: writer.write))
        await writer.waitForFirstWrite()

        for key in ["b", "c", "d"] {
            #expect(session.enqueue(key, target: target, write: writer.write) != nil)
        }
        let paste = try #require(session.enqueue("paste\n", target: target, isPaste: true, write: writer.write))
        #expect(session.enqueue("e", target: target, write: writer.write) != nil)
        let last = try #require(session.enqueue("f", target: target, write: writer.write))
        writer.finishFirstWrite()

        #expect(await first.value)
        #expect(await paste.value)
        #expect(await last.value)
        #expect(writer.writes == ["a", "bcd", "paste\r", "ef"])
        #expect(writer.maximumActiveWrites == 1)
    }

    @Test func newerPasteDropsTheUnsentPartOfAnOlderPaste() async throws {
        let session = TerminalInputSession()
        let target = makeTarget()
        session.attach(to: target)
        let writer = TerminalWriteProbe()
        let older = try #require(session.enqueue(
            String(repeating: "a", count: TerminalInputEncoder.maximumWriteLength + 1),
            target: target,
            isPaste: true,
            write: writer.write
        ))
        await writer.waitForFirstWrite()
        let newer = try #require(session.enqueue("newer", target: target, isPaste: true, write: writer.write))
        writer.finishFirstWrite()

        #expect(await older.value == false)
        #expect(await newer.value)
        #expect(writer.writes.map { $0.utf16.count } == [65_536, 5])
        #expect(writer.writes.last == "newer")
        #expect(writer.maximumActiveWrites == 1)
    }

    @Test func sessionChangesDropUnsentInput() async throws {
        for change in ["restart", "terminal", "thread", "stop", "dismiss"] {
            let session = TerminalInputSession()
            let original = makeTarget()
            session.attach(to: original)
            let writer = TerminalWriteProbe()
            let paste = try #require(session.enqueue(
                String(repeating: "a", count: TerminalInputEncoder.maximumWriteLength + 1),
                target: original,
                isPaste: true,
                write: writer.write
            ))
            await writer.waitForFirstWrite()
            let staleKey = try #require(session.enqueue("stale", target: original, write: writer.write))

            let next: TerminalInputSession.Target
            switch change {
            case "restart": next = makeTarget(lifecycleVersion: 1)
            case "terminal": next = makeTarget(terminalID: "term-2")
            case "thread": next = makeTarget(threadID: "other-thread")
            case "stop":
                session.updateTarget(nil)
                next = original
            default:
                session.detach()
                session.updateTarget(original)
                #expect(session.enqueue("hidden", target: original, write: writer.write) == nil)
                session.attach(to: original)
                next = original
            }
            session.updateTarget(next)
            let fresh = try #require(session.enqueue("fresh", target: next, write: writer.write))
            writer.finishFirstWrite()

            #expect(await paste.value == false)
            #expect(await staleKey.value == false)
            #expect(await fresh.value)
            #expect(writer.writes.map { $0.utf16.count } == [65_536, 5])
            #expect(writer.writes.last == "fresh")
        }
    }

    @Test func failedWriteStopsThePasteWithoutRetrying() async throws {
        let session = TerminalInputSession()
        let target = makeTarget()
        session.attach(to: target)
        let writer = TerminalWriteProbe()
        let paste = try #require(session.enqueue(
            String(repeating: "a", count: TerminalInputEncoder.maximumWriteLength + 1),
            target: target,
            isPaste: true,
            write: writer.write
        ))
        await writer.waitForFirstWrite()
        writer.finishFirstWrite(accepted: false)
        #expect(await paste.value == false)
        #expect(writer.writes.count == 1)

        let next = try #require(session.enqueue("next", target: target, isPaste: true, write: writer.write))
        #expect(await next.value)
        #expect(writer.writes.map { $0.utf16.count } == [65_536, 4])
        #expect(writer.writes.last == "next")
    }

    private func makeTarget(
        threadID: String = "thread",
        terminalID: String = "default",
        lifecycleVersion: Int = 0
    ) -> TerminalInputSession.Target {
        .init(threadID: threadID, terminalID: terminalID, lifecycleVersion: lifecycleVersion)
    }
}

@MainActor
private final class TerminalWriteProbe {
    private(set) var writes = [String]()
    private(set) var maximumActiveWrites = 0
    private var activeWrites = 0
    private var firstWrite: CheckedContinuation<Bool, Never>?
    private var firstWriteStarted: CheckedContinuation<Void, Never>?

    func write(_ data: String) async -> Bool {
        writes.append(data)
        activeWrites += 1
        maximumActiveWrites = max(maximumActiveWrites, activeWrites)
        defer { activeWrites -= 1 }
        guard writes.count == 1 else { return true }
        return await withCheckedContinuation { continuation in
            firstWrite = continuation
            firstWriteStarted?.resume()
            firstWriteStarted = nil
        }
    }

    func waitForFirstWrite() async {
        guard writes.isEmpty else { return }
        await withCheckedContinuation { firstWriteStarted = $0 }
    }

    func finishFirstWrite(accepted: Bool = true) {
        firstWrite?.resume(returning: accepted)
        firstWrite = nil
    }
}
