import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

// A merged/closed PR observed via `.vcsStatusChanged` must persist a
// server-side settle (fire-and-forget `settleThread`) so the thread stays
// settled across relaunches — but never over a user's explicit pin or a
// thread that is already settled.

@Suite("Merged-PR settle persistence")
@MainActor
struct ClosedPrSettleTests {
    private func makeThread(id: String, settledOverride: String? = nil) -> ChatThread {
        ChatThread(
            id: id, projectID: "proj-1", title: "Thread \(id)", provider: .claudex,
            status: .idle, updatedAt: Date(),
            settledOverride: settledOverride,
            sessionStatus: "idle")
    }

    private func prStatus(_ state: PullRequestState) -> VcsStatus {
        VcsStatus(
            isRepo: true, branch: "feat/merged-pr", isDefaultBranch: false,
            changedFileCount: 0, insertions: 0, deletions: 0,
            aheadCount: 0, behindCount: 0, hasUpstream: true,
            prNumber: 1, prTitle: "Native mac app",
            prURL: "https://github.com/SergeSerb2/SergeCode/pull/1",
            prState: state)
    }

    private func waitForSettles(
        _ backend: MockBackend, count: Int
    ) async -> [String] {
        var recorded: [String] = []
        for _ in 0..<200 {
            recorded = await backend.recordedSettleThreadIDs()
            if recorded.count >= count { break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return recorded
    }

    @Test("merged PR status settles an eligible thread exactly once")
    func mergedStatusSettlesEligibleThreadOnce() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let thread = makeThread(id: "t-merged")
        model.enqueue(.threadUpserted(thread))
        model.flushPendingEvents()

        model.enqueue(.vcsStatusChanged(threadID: thread.id, status: prStatus(.merged)))
        model.flushPendingEvents()

        let recorded = await waitForSettles(backend, count: 1)
        #expect(recorded == [thread.id])

        // Simulate the server echo (the settle persisted as an override) and
        // another VCS event for the same PR: no second settle may dispatch.
        var settledThread = thread
        settledThread.status = .settled
        settledThread.settledOverride = "settled"
        settledThread.settledAt = Date()
        model.enqueue(.threadUpserted(settledThread))
        model.enqueue(.vcsStatusChanged(threadID: thread.id, status: prStatus(.merged)))
        model.flushPendingEvents()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(await backend.recordedSettleThreadIDs() == [thread.id])
    }

    @Test("a thread upsert with cached merged PR state settles once the session is idle")
    func upsertWithCachedMergedStatusSettles() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        var thread = makeThread(id: "t-cached")
        thread.sessionStatus = "running"
        thread.status = .running
        model.enqueue(.threadUpserted(thread))
        model.enqueue(.vcsStatusChanged(threadID: thread.id, status: prStatus(.closed)))
        model.flushPendingEvents()
        try? await Task.sleep(for: .milliseconds(50))
        // Running session: canSettle blocks the dispatch.
        #expect(await backend.recordedSettleThreadIDs().isEmpty)

        // The session finishing arrives as an upsert, not a VCS event.
        thread.sessionStatus = "idle"
        thread.status = .idle
        model.enqueue(.threadUpserted(thread))
        model.flushPendingEvents()

        let recorded = await waitForSettles(backend, count: 1)
        #expect(recorded == [thread.id])
    }

    @Test("user-pinned or already-settled threads are never auto-settled")
    func pinnedOrSettledThreadsAreNotSettled() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let pinnedActive = makeThread(id: "t-pinned-active", settledOverride: "active")
        let alreadySettled = makeThread(id: "t-already-settled", settledOverride: "settled")
        model.enqueue(.threadUpserted(pinnedActive))
        model.enqueue(.threadUpserted(alreadySettled))
        model.flushPendingEvents()

        model.enqueue(.vcsStatusChanged(threadID: pinnedActive.id, status: prStatus(.merged)))
        model.enqueue(.vcsStatusChanged(threadID: alreadySettled.id, status: prStatus(.closed)))
        model.flushPendingEvents()
        try? await Task.sleep(for: .milliseconds(100))

        #expect(await backend.recordedSettleThreadIDs().isEmpty)
    }
}
