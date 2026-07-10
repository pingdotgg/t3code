import Foundation
import Testing

@testable import SergeCodeMac

// hasLoadedTimeline must only flip on a full history snapshot. A streamed
// append for a not-yet-selected thread must not suppress loadTimelineIfNeeded.

@Suite("AppModel timeline load gate")
@MainActor
struct AppModelTimelineLoadTests {
    @Test("timelineAppended before selection does not suppress history fetch")
    func appendDoesNotSuppressHistoryFetch() async throws {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let threadID = "thread-1"

        let seeded = try await backend.timeline(threadID: threadID)
        #expect(seeded.count > 1, "MockBackend seeds multi-item history for thread-1")

        // Startup stream event before the thread is selected (reproduces the
        // MockBackend subagent demo hazard).
        model.enqueue(
            .timelineAppended(
                threadID: threadID,
                item: .userMessage(
                    id: "early-append", text: "streamed only", at: Date())))
        model.flushPendingEvents()

        #expect(model.threadState(threadID)?.hasLoadedTimeline == false)
        #expect((model.threadState(threadID)?.timeline.count ?? 0) == 1)

        await model.loadTimelineIfNeeded(threadID: threadID)

        let loaded = model.threadState(threadID)?.timeline ?? []
        #expect(model.threadState(threadID)?.hasLoadedTimeline == true)
        #expect(loaded.count > 1, "full seeded history must be fetched")
        #expect(loaded.count == seeded.count)
    }

    @Test("timelineReset still marks history loaded")
    func resetMarksHistoryLoaded() {
        let model = AppModel(backend: MockBackend())
        model.enqueue(
            .timelineReset(
                threadID: "t1",
                items: [
                    .userMessage(id: "u1", text: "hi", at: Date()),
                    .assistantMessage(
                        id: "a1", markdown: "yo", isStreaming: false, at: Date()),
                ]))
        model.flushPendingEvents()

        #expect(model.threadState("t1")?.hasLoadedTimeline == true)
        #expect((model.threadState("t1")?.timeline.count ?? 0) == 2)
    }
}
