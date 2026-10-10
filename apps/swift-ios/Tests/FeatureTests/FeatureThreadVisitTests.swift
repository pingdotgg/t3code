import Foundation
import Testing
@testable import T3Code

@Suite("Visible thread visits")
struct FeatureThreadVisitTests {
    private let now = Date(timeIntervalSince1970: 10_000)

    private func thread() -> FeatureThread {
        FeatureThread(id: "computer:thread", projectID: "project", environmentID: "computer", title: "Task",
                      updatedAt: now, rawUpdatedAt: now.ISO8601Format(),
                      inboxFacts: .init(orchestrationVersion: 2, lastVisitedAtIsPresent: true))
    }

    @Test
    func absentTrackingAndAlreadyVisitedWatermarksDoNotSend() {
        let tracker = FeatureThreadVisitTracker()
        var value = thread()
        value.inboxFacts?.lastVisitedAtIsPresent = false
        #expect(tracker.nextVisit(for: .init(thread: value), at: now) == nil)
        value.inboxFacts?.lastVisitedAtIsPresent = true
        value.inboxFacts?.lastVisitedAt = now.ISO8601Format()
        #expect(tracker.nextVisit(for: .init(thread: value), at: now) == nil)
        value.inboxFacts?.lastVisitedAt = nil
        #expect(tracker.nextVisit(for: .init(thread: value), at: now)?.dispatchAt == now)
        value.inboxFacts?.orchestrationVersion = nil
        #expect(tracker.nextVisit(for: .init(thread: value), at: now) == nil)
    }

    @Test
    func cachedThreadsWithoutTheRawWatermarkWaitForTheServer() {
        let tracker = FeatureThreadVisitTracker()
        var value = thread()
        for raw in [nil, "invalid"] as [String?] {
            value.rawUpdatedAt = raw
            #expect(tracker.nextVisit(for: .init(thread: value), at: now) == nil)
        }
    }

    @Test
    func streamingUsesTheNewestWatermarkAtTheOriginalTrailingDeadline() throws {
        var tracker = FeatureThreadVisitTracker()
        var value = thread()
        let first = try #require(tracker.nextVisit(for: .init(thread: value), at: now))
        tracker.recordDispatched(first, at: now)
        #expect(tracker.nextVisit(for: .init(thread: value), at: now.addingTimeInterval(1)) == nil)
        value.updatedAt = now.addingTimeInterval(1)
        value.rawUpdatedAt = value.updatedAt.ISO8601Format()
        let second = try #require(tracker.nextVisit(for: .init(thread: value), at: now.addingTimeInterval(1)))
        #expect(second.dispatchAt == now.addingTimeInterval(10))
        value.updatedAt = now.addingTimeInterval(8)
        value.rawUpdatedAt = value.updatedAt.ISO8601Format()
        let newest = try #require(tracker.nextVisit(for: .init(thread: value), at: now.addingTimeInterval(8)))
        #expect(newest.dispatchAt == second.dispatchAt)
        #expect(newest.observation.updatedAt == value.rawUpdatedAt)
        tracker.recordDispatched(newest, at: newest.dispatchAt)
        #expect(tracker.nextVisit(for: .init(thread: value), at: now.addingTimeInterval(11)) == nil)
    }

    @Test
    func completionAndSwitchingEnvironmentBypassStreamingThrottle() throws {
        var tracker = FeatureThreadVisitTracker()
        var value = thread()
        let first = try #require(tracker.nextVisit(for: .init(thread: value), at: now))
        tracker.recordDispatched(first, at: now)
        value.updatedAt = now.addingTimeInterval(1)
        value.rawUpdatedAt = value.updatedAt.ISO8601Format()
        value.inboxFacts?.latestRunCompletedAt = value.updatedAt
        let completion = try #require(tracker.nextVisit(for: .init(thread: value), at: value.updatedAt))
        #expect(completion.dispatchAt == value.updatedAt)
        tracker.recordDispatched(completion, at: value.updatedAt)
        value.inboxFacts?.latestRunCompletedAt = nil
        value.environmentID = "other"
        #expect(tracker.nextVisit(for: .init(thread: value), at: value.updatedAt)?.dispatchAt == value.updatedAt)
    }

    @Test @MainActor
    func failedVisitCanRetryTheSameWatermarkAfterReconnect() async {
        let recorder = VisitRecorder()
        recorder.failsNextVisit = true
        let coordinator = FeatureThreadVisitCoordinator()
        let observation = FeatureThreadVisitObservation(thread: thread())
        await coordinator.visit(observation, using: recorder)
        await coordinator.visit(observation, using: recorder)
        await coordinator.visit(observation, using: recorder)
        #expect(recorder.visits.count == 2)
    }

    @Test @MainActor
    func cancellingTheViewTaskDoesNotForgetAnAcceptedVisit() async {
        let recorder = SuspendedVisitRecorder()
        let coordinator = FeatureThreadVisitCoordinator()
        let observation = FeatureThreadVisitObservation(thread: thread())
        var accepted = recorder.accepted.makeAsyncIterator()
        let task = Task { await coordinator.visit(observation, using: recorder) }
        _ = await accepted.next()
        task.cancel()
        recorder.finish()
        await task.value

        await coordinator.visit(observation, using: recorder)
        #expect(recorder.visitCount == 1)
    }

    @Test @MainActor
    func coordinatorUsesTheObservedWatermarkAndDeduplicatesBeforeTheServerEcho() async {
        let recorder = VisitRecorder()
        let coordinator = FeatureThreadVisitCoordinator()
        let observation = FeatureThreadVisitObservation(thread: thread())
        await coordinator.visit(observation, using: recorder)
        await coordinator.visit(observation, using: recorder)
        #expect(recorder.visits.count == 1)
        #expect(recorder.visits.first?.threadID == "computer:thread")
        #expect(recorder.visits.first?.visitedAt == thread().rawUpdatedAt)
    }
}

@MainActor
private final class SuspendedVisitRecorder: FeatureThreadVisiting {
    let accepted: AsyncStream<Void>
    private let acceptance: AsyncStream<Void>.Continuation
    private var reply: CheckedContinuation<Void, Never>?
    private(set) var visitCount = 0

    init() {
        (accepted, acceptance) = AsyncStream<Void>.makeStream()
    }

    func visitThread(threadID: String, visitedAt: String) async throws {
        visitCount += 1
        guard visitCount == 1 else { return }
        await withCheckedContinuation { continuation in
            reply = continuation
            acceptance.yield(())
        }
        try Task.checkCancellation()
    }

    func finish() {
        reply?.resume()
        reply = nil
        acceptance.finish()
    }
}

@MainActor
private final class VisitRecorder: FeatureThreadVisiting {
    var visits: [(threadID: String, visitedAt: String)] = []
    var failsNextVisit = false

    func visitThread(threadID: String, visitedAt: String) async throws {
        visits.append((threadID, visitedAt))
        if failsNextVisit {
            failsNextVisit = false
            throw URLError(.notConnectedToInternet)
        }
    }
}
