import Foundation
import Testing
@testable import T3Code

@Suite("Platform feedback")
struct PlatformFeedbackTests {
    @Test
    func initialSnapshotDoesNotEmitSignals() {
        let current = [thread(id: "one", state: .waitingForApproval)]

        #expect(PlatformThreadTransitionClassifier.signals(previous: nil, current: current).isEmpty)
    }

    @Test
    func classifiesAttentionFailureAndCompletionTransitions() {
        let previous: [String: FeatureThreadState] = [
            "approval": .working,
            "failure": .working,
            "complete": .working,
            "idle-complete": .idle,
        ]
        let current = [
            thread(id: "approval", state: .waitingForApproval),
            thread(id: "failure", state: .failed),
            thread(id: "complete", state: .completed),
            thread(id: "idle-complete", state: .completed),
        ]

        let signals = PlatformThreadTransitionClassifier.signals(previous: previous, current: current)

        #expect(signals.map(\.thread.id) == ["approval", "failure", "complete"])
        #expect(signals.map(\.kind) == [.warning, .error, .success])
    }

    @Test
    func notificationPayloadSupportsURLAndServerFields() {
        let routeFromURL = PlatformNotificationPayload.route(from: [
            "deep_link": "t3code://threads/environment/thread",
        ])
        let routeFromFields = PlatformNotificationPayload.route(from: [
            "environmentId": "environment",
            "threadId": "thread",
        ])

        #expect(routeFromURL == .thread(environmentID: "environment", threadID: "thread"))
        #expect(routeFromFields == .thread(environmentID: "environment", threadID: "thread"))
    }

    @Test
    func recentThreadStoreSortsLimitsAndSkipsArchived() throws {
        let suiteName = "PlatformFeedbackTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = PlatformRecentThreadStore(defaults: defaults, key: "recent")
        var threads = (0 ..< 14).map { index in
            thread(
                id: "thread-\(index)",
                state: .idle,
                updatedAt: Date(timeIntervalSince1970: TimeInterval(index))
            )
        }
        threads[13].isArchived = true

        store.update(from: threads)
        let records = store.records()

        #expect(records.count == 12)
        #expect(records.first?.id == "thread-12")
        #expect(!records.contains { $0.id == "thread-13" })
    }

    private func thread(
        id: String,
        state: FeatureThreadState,
        updatedAt: Date = .now
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            wireID: "wire-\(id)",
            projectID: "project",
            environmentID: "environment",
            title: "Thread \(id)",
            updatedAt: updatedAt,
            state: state
        )
    }
}
