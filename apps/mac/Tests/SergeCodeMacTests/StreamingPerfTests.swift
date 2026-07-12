import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Streaming performance")
@MainActor
struct StreamingPerfTests {
    @Test("keeps a large streamed assistant message coherent")
    func largeAssistantStream() {
        MarkdownBlockCache.resetForTesting()
        let model = AppModel(backend: MockBackend())
        // Keep each delta exactly 1 KiB, but word-space the fixture so the
        // file-link detector sees realistic prose rather than one pathological
        // unbroken token.
        let chunk = String(repeating: "word ", count: 204) + "word"
        var accumulated = ""
        let clock = ContinuousClock()
        let startedAt = clock.now

        for _ in 0..<200 {
            model.enqueue(
                .assistantDelta(threadID: "perf-thread", messageID: "perf-message", delta: chunk))
            model.flushPendingEvents()
            accumulated += chunk
            _ = MarkdownBlockCache.document(for: accumulated)
        }

        let elapsed = startedAt.duration(to: clock.now).components
        let elapsedMilliseconds = Double(elapsed.seconds) * 1_000
            + Double(elapsed.attoseconds) / 1_000_000_000_000_000
        let wallLine = String(
            format: "StreamingPerfTests wall_ms=%.3f bytes=%d\n",
            elapsedMilliseconds, accumulated.utf8.count)
        FileHandle.standardError.write(Data(wallLine.utf8))

        let items = model.threadState("perf-thread")?.timeline ?? []
        #expect(accumulated == String(repeating: chunk, count: 200))
        #expect(items.count == 1)
        guard case .assistantMessage(_, let markdown, _, _) = items.first else {
            Issue.record("expected one assistant timeline item, got \(items)")
            return
        }
        #expect(markdown == accumulated)
    }
}
