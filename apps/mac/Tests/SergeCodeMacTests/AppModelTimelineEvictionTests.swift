import Foundation
import Testing

@testable import SergeCodeMac

// Timeline subscription LRU: pure evictionCandidates policy plus the
// AppModel selection path that retains stale ThreadState for evicted threads.

@Suite("AppModel timeline eviction", .serialized)
@MainActor
struct AppModelTimelineEvictionTests {
    private func makeModel() -> AppModel {
        AppModel(backend: MockBackend())
    }

    private func resetCaches() {
        TimelineDisplayCache.resetForTesting()
        StreamingMarkdownCache.resetForTesting()
    }

    private func settlePrune() async {
        for _ in 0..<3 { await Task.yield() }
    }

    private func seedTimeline(_ model: AppModel, threadID: String, itemCount: Int = 1) {
        let items: [TimelineItem] = (0..<itemCount).map { index in
            .userMessage(
                id: "\(threadID)-u\(index)",
                text: "seed \(index)",
                at: Date(timeIntervalSince1970: Double(index)))
        }
        model.enqueue(.timelineReset(threadID: threadID, items: items))
        model.flushPendingEvents()
        // timelineReset sets hasLoadedTimeline via applyBatch; mirror the
        // post-load gate so prune can prove the reset-to-false path.
        #expect(model.threadState(threadID)?.hasLoadedTimeline == true)
        #expect((model.threadState(threadID)?.timeline.count ?? 0) == itemCount)
    }

    // MARK: - Pure function

    @Test("evictionCandidates keeps selected + keep-1 others, evicts oldest")
    func keepsWindowEvictsOldest() {
        // recent is MRU-first: t0 selected, t1..t3 recent, t4..t5 oldest.
        let recent = ["t0", "t1", "t2", "t3", "t4", "t5"]
        let evicted = AppModel.evictionCandidates(recent: recent, keep: 4)
        #expect(evicted == ["t4", "t5"])
        #expect(!evicted.contains("t0"))
    }

    @Test("evictionCandidates returns empty under the keep limit")
    func noEvictionUnderLimit() {
        #expect(AppModel.evictionCandidates(recent: ["a", "b", "c"], keep: 4).isEmpty)
        #expect(AppModel.evictionCandidates(recent: ["a", "b", "c", "d"], keep: 4).isEmpty)
        #expect(AppModel.evictionCandidates(recent: [], keep: 4).isEmpty)
    }

    @Test("evictionCandidates never includes the selected (front) id when keep >= 1")
    func selectedNeverEvicted() {
        let recent = ["selected", "r1", "r2", "r3", "r4", "r5", "r6"]
        let evicted = AppModel.evictionCandidates(recent: recent, keep: 4)
        #expect(!evicted.contains("selected"))
        #expect(evicted == ["r4", "r5", "r6"])
        // keep 1: only selected stays.
        #expect(AppModel.evictionCandidates(recent: recent, keep: 1) == Array(recent.dropFirst()))
    }

    // MARK: - AppModel selection path

    @Test("selecting across 6 threads retains stale timeline on the two oldest")
    func selectionPrunesOldestThreadStates() async {
        let model = makeModel()
        let ids = (0..<6).map { "thread-\($0)" }

        // Seed a loaded timeline for every thread before selection churn.
        for id in ids {
            seedTimeline(model, threadID: id)
        }

        // Select in order thread-0 … thread-5. After the sixth selection,
        // keep = 4 holds [5, 4, 3, 2]; 1 and 0 are evicted.
        for id in ids {
            model.selectedThreadID = id
        }

        // Allow closeTimeline Tasks from prune to settle (MockBackend no-op).
        await settlePrune()

        #expect(model.selectedThreadID == "thread-5")

        for kept in ["thread-5", "thread-4", "thread-3", "thread-2"] {
            let state = model.threadState(kept)
            #expect(state?.hasLoadedTimeline == true, "expected \(kept) retained")
            #expect((state?.timeline.count ?? 0) == 1, "expected \(kept) timeline retained")
        }

        for evicted in ["thread-1", "thread-0"] {
            let state = model.threadState(evicted)
            #expect(state?.hasLoadedTimeline == false, "expected \(evicted) hasLoadedTimeline false")
            #expect((state?.timeline.count ?? 0) == 1, "expected \(evicted) stale timeline retained")
        }
    }

    @Test("eviction retains display cache but drops streaming markdown cache")
    func evictionRetainsDisplayCacheAndEvictsStreamingMarkdown() async {
        resetCaches()
        defer { resetCaches() }

        let model = makeModel()
        let ids = (0..<6).map { "thread-\($0)" }
        for id in ids { seedTimeline(model, threadID: id) }

        let retainedID = "thread-0"
        let retainedState = model.threadState(retainedID)!
        _ = TimelineDisplayCache.grouped(
            items: retainedState.timeline,
            threadID: retainedID,
            version: retainedState.timelineVersion,
            structureVersion: retainedState.structureVersion,
            threadIsSettled: false)
        _ = StreamingMarkdownCache.blocks(
            threadID: retainedID, messageID: "streaming", markdown: "initial")
        #expect(TimelineDisplayCache.fullPassCount == 1)
        #expect(StreamingMarkdownCache.resetCount == 0)

        for id in ids { model.selectedThreadID = id }
        await settlePrune()

        let state = model.threadState(retainedID)!
        #expect(state.hasLoadedTimeline == false)
        #expect(state.timeline.count == 1)

        _ = TimelineDisplayCache.grouped(
            items: state.timeline,
            threadID: retainedID,
            version: state.timelineVersion,
            structureVersion: state.structureVersion,
            threadIsSettled: false)
        #expect(TimelineDisplayCache.fullPassCount == 1)

        _ = StreamingMarkdownCache.blocks(
            threadID: retainedID, messageID: "streaming", markdown: "replacement")
        #expect(StreamingMarkdownCache.resetCount == 0)
    }

    @Test("eviction trims a 600-item timeline to its newest 500 items")
    func evictionTrimsRetainedTimeline() async {
        let model = makeModel()
        let ids = (0..<6).map { "thread-\($0)" }
        seedTimeline(model, threadID: ids[0], itemCount: 600)
        for id in ids.dropFirst() { seedTimeline(model, threadID: id) }

        for id in ids { model.selectedThreadID = id }
        await settlePrune()

        let state = model.threadState(ids[0])!
        #expect(state.hasLoadedTimeline == false)
        #expect(state.timeline.count == AppModel.maxRetainedTimelineItems)
        #expect(state.timeline.first?.id == ids[0] + "-u100")
        #expect(state.timeline.last?.id == ids[0] + "-u599")
    }

    @Test("reselecting an evicted thread refetches and replaces stale items")
    func reselectRefetchesAndReplacesStaleSnapshot() async throws {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let ids = (1...5).map { "thread-\($0)" }
        let stale = TimelineItem.userMessage(
            id: "stale", text: "retained while refetching", at: Date(timeIntervalSince1970: 1))
        model.enqueue(.timelineReset(threadID: ids[0], items: [stale]))
        model.flushPendingEvents()
        for id in ids.dropFirst() { seedTimeline(model, threadID: id) }

        for id in ids { model.selectedThreadID = id }
        await settlePrune()

        #expect(model.threadState(ids[0])?.hasLoadedTimeline == false)
        #expect(model.threadState(ids[0])?.timeline.map(\.id) == ["stale"])

        let fresh = try await backend.timeline(threadID: ids[0])
        await model.loadTimelineIfNeeded(threadID: ids[0])

        let state = model.threadState(ids[0])!
        #expect(state.hasLoadedTimeline == true)
        #expect(state.isLoadingTimeline == false)
        #expect(state.timeline.map(\.id) == fresh.map(\.id))
        #expect(state.timeline.map(\.id) != ["stale"])
    }
}
