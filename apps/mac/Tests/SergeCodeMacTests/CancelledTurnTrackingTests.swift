import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

// A cancelled run settles to `idle` exactly like a completed one, so the
// model records *which* turn the user stopped. `ChatScreen` reads this to
// keep the completion haptic honest (see `ThreadStatusHaptics`).

@Suite("Cancelled turn tracking")
@MainActor
struct CancelledTurnTrackingTests {
    private func makeThread(id: String, startedAt: Date?) -> ChatThread {
        var thread = ChatThread(
            id: id, projectID: "proj-1", title: "Thread \(id)", provider: .claude,
            status: .running, updatedAt: Date(), sessionStatus: "running")
        thread.latestTurnStartedAt = startedAt
        return thread
    }

    @Test("cancelling records the running turn, and only that turn stays silent")
    func recordsTheCancelledTurn() async throws {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let startedAt = Date(timeIntervalSince1970: 1_000)
        let running = makeThread(id: "t-1", startedAt: startedAt)
        await backend.insertThreads([running])
        await model.refreshAll()
        model.selectedThreadID = running.id

        #expect(!model.isCancellationPending(for: running))

        await model.cancelCurrentTurn()

        // The stopped turn is marked...
        #expect(model.isCancellationPending(for: running))
        // ...and a later turn on the same thread is not: a newer start stamp
        // expires the record without any explicit cleanup.
        let nextTurn = makeThread(id: "t-1", startedAt: startedAt.addingTimeInterval(60))
        #expect(!model.isCancellationPending(for: nextTurn))
        // Other threads are untouched.
        #expect(!model.isCancellationPending(for: makeThread(id: "t-2", startedAt: startedAt)))
    }

    @Test("a cancelled run settling reports nothing, an ordinary one reports success")
    func policyUsesTheRecord() async throws {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let running = makeThread(id: "t-1", startedAt: Date(timeIntervalSince1970: 2_000))
        await backend.insertThreads([running])
        await model.refreshAll()
        model.selectedThreadID = running.id
        await model.cancelCurrentTurn()

        var settled = running
        settled.status = .idle

        let cancelled = ThreadStatusSnapshot(
            threadID: settled.id, status: settled.status,
            cancellationPending: model.isCancellationPending(for: settled))
        let before = ThreadStatusSnapshot(threadID: running.id, status: .running)
        #expect(ThreadStatusHaptics.event(from: before, to: cancelled) == nil)

        // Same settle on a thread nobody stopped.
        let untouched = makeThread(id: "t-other", startedAt: Date(timeIntervalSince1970: 2_000))
        let completed = ThreadStatusSnapshot(
            threadID: untouched.id, status: .idle,
            cancellationPending: model.isCancellationPending(for: untouched))
        #expect(
            ThreadStatusHaptics.event(
                from: ThreadStatusSnapshot(threadID: untouched.id, status: .running),
                to: completed) == .success)
    }
}
