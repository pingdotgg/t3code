import Foundation

@MainActor
public protocol FeatureThreadVisiting {
    func visitThread(threadID: String, visitedAt: String) async throws
}

/// Use as a visible thread's task identity. Transcript-only changes need no extra visit.
public struct FeatureThreadVisitObservation: Hashable, Sendable {
    public let threadID: String
    public let environmentID: String?
    public let updatedAt: String?
    public let lastVisitedAt: String?
    public let completedAt: Date?
    public let isSupported: Bool

    public init(thread: FeatureThread) {
        threadID = thread.id
        environmentID = thread.environmentID
        updatedAt = thread.rawUpdatedAt
        lastVisitedAt = thread.inboxFacts?.lastVisitedAt
        completedAt = thread.inboxFacts?.latestRunCompletedAt
        isSupported = thread.supportsVisitTracking
    }
}

/// RN's visit policy: immediate on open/completion, newest streaming watermark after ten seconds.
struct FeatureThreadVisitTracker {
    struct Visit: Equatable {
        let observation: FeatureThreadVisitObservation
        let dispatchAt: Date
    }

    private var lastDispatched: FeatureThreadVisitObservation?
    private var lastDispatchAt: Date?

    func nextVisit(for observation: FeatureThreadVisitObservation, at now: Date) -> Visit? {
        guard observation.isSupported,
              let updatedAt = FeatureThreadLifecyclePolicy.date(observation.updatedAt) else { return nil }
        let visitedAt = FeatureThreadLifecyclePolicy.date(observation.lastVisitedAt)
        if let visitedAt, visitedAt >= updatedAt { return nil }
        let sameThread = lastDispatched?.threadID == observation.threadID
            && lastDispatched?.environmentID == observation.environmentID
        if sameThread, lastDispatched?.updatedAt == observation.updatedAt { return nil }
        let unseenCompletion = observation.completedAt.map { completedAt in
            visitedAt.map { completedAt > $0 } ?? true
        } ?? false
        let dispatchAt: Date
        if sameThread, !unseenCompletion, let lastDispatchAt {
            dispatchAt = max(now, lastDispatchAt.addingTimeInterval(10))
        } else {
            dispatchAt = now
        }
        return Visit(observation: observation, dispatchAt: dispatchAt)
    }

    mutating func recordDispatched(_ visit: Visit, at now: Date) {
        lastDispatched = visit.observation
        lastDispatchAt = now
    }

    mutating func recordFailure(_ visit: Visit) {
        // An older cancelled request must not clear a newer successful visit.
        if lastDispatched == visit.observation {
            lastDispatched = nil
        }
    }
}

/// Keep one coordinator per visible-thread owner. Cancel its task when hidden,
/// backgrounded, or when the observation changes, so only the newest watermark is sent.
@MainActor
public final class FeatureThreadVisitCoordinator {
    private var tracker = FeatureThreadVisitTracker()

    public init() {}

    public func visit(_ observation: FeatureThreadVisitObservation, using client: any FeatureThreadVisiting) async {
        guard let updatedAt = observation.updatedAt,
              let visit = tracker.nextVisit(for: observation, at: .now) else { return }
        do {
            let delay = visit.dispatchAt.timeIntervalSinceNow
            if delay > 0 { try await Task.sleep(for: .seconds(delay)) }
            try Task.checkCancellation()
            tracker.recordDispatched(visit, at: .now)
            // A new shell watermark cancels this view task while an accepted command
            // can still be in flight. Keep its real result so cancellation cannot
            // clear the ten-second throttle after the server stored the visit.
            let dispatch = Task {
                try await client.visitThread(threadID: observation.threadID, visitedAt: updatedAt)
            }
            try await dispatch.value
        } catch {
            tracker.recordFailure(visit)
            // Visits are passive read state. Connection failures must not interrupt the conversation.
        }
    }
}
