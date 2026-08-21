import Foundation
import Testing
@testable import T3Code

@Suite("Agent awareness projection")
struct PlatformAgentAwarenessTests {
    @Test
    func settingsDefaultToSystemAppearanceAndRoundTripLightMode() throws {
        #expect(FeatureSettings().appearance == .system)

        var settings = FeatureSettings()
        settings.appearance = .light
        let roundTrip = try JSONDecoder.t3.decode(
            FeatureSettings.self,
            from: JSONEncoder.t3.encode(settings)
        )

        #expect(roundTrip.appearance == .light)
    }

    @Test
    func legacySettingsEnableLiveActivitiesWithoutResettingOtherPreferences() throws {
        let legacy = Data(
            #"{"appearance":"system","hapticsEnabled":false,"notificationsEnabled":false}"#.utf8
        )
        let decoded = try JSONDecoder.t3.decode(FeatureSettings.self, from: legacy)

        #expect(decoded.appearance == .system)
        #expect(!decoded.hapticsEnabled)
        #expect(!decoded.notificationsEnabled)
        #expect(decoded.liveActivitiesEnabled)

        var disabled = decoded
        disabled.liveActivitiesEnabled = false
        let roundTrip = try JSONDecoder.t3.decode(
            FeatureSettings.self,
            from: JSONEncoder.t3.encode(disabled)
        )
        #expect(!roundTrip.liveActivitiesEnabled)
    }

    @Test
    func ranksAttentionThenFailuresThenWorkAndDropsOldTerminalRows() throws {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let project = FeatureProject(
            id: "project",
            wireID: "project-wire",
            environmentID: "environment",
            name: "t3code",
            path: "/repo"
        )
        let snapshot = FeatureSnapshot(
            projects: [project],
            threads: [
                Self.thread(
                    id: "working",
                    state: .working,
                    updatedAt: now.addingTimeInterval(-10)
                ),
                Self.thread(
                    id: "approval",
                    state: .waitingForApproval,
                    updatedAt: now.addingTimeInterval(-5)
                ),
                Self.thread(
                    id: "failure",
                    state: .failed,
                    updatedAt: now.addingTimeInterval(-20)
                ),
                Self.thread(
                    id: "old-complete",
                    state: .completed,
                    updatedAt: now.addingTimeInterval(-3_600)
                ),
            ],
            providersByEnvironment: [
                "environment": [
                    FeatureProvider(
                        id: "claude",
                        name: "Claude",
                        models: [FeatureModel(id: "claude-opus-5", name: "Opus 5")]
                    ),
                ],
            ]
        )

        let aggregate = PlatformAgentAwarenessProjection.aggregate(
            snapshot: snapshot,
            now: now
        )

        #expect(aggregate.activeCount == 2)
        #expect(aggregate.subtitle == "1 task needs attention")
        #expect(aggregate.activities.map(\.threadId) == ["approval", "failure", "working"])
        #expect(aggregate.activities.first?.modelTitle == "Opus 5")
        #expect(
            aggregate.activities.first?.nativeDeepLinkURL?.scheme
                == PlatformRoute.nativeScheme
        )
    }

    @Test
    func widgetSnapshotUsesTheSameBoundedRowsAsTheLiveActivity() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let project = FeatureProject(
            id: "project",
            environmentID: "environment",
            name: "t3code",
            path: "/repo"
        )
        let threads = (0..<8).map { index in
            Self.thread(
                id: "thread-\(index)",
                state: .working,
                updatedAt: now.addingTimeInterval(TimeInterval(-index))
            )
        }
        let snapshot = FeatureSnapshot(projects: [project], threads: threads)

        let aggregate = PlatformAgentAwarenessProjection.aggregate(
            snapshot: snapshot,
            now: now
        )
        let widget = PlatformAgentAwarenessProjection.widgetSnapshot(
            snapshot: snapshot,
            now: now
        )

        #expect(aggregate.activities.count == PlatformAgentAwarenessProjection.maximumRows)
        #expect(widget.tasks == aggregate.activities)
        #expect(widget.updatedAt == aggregate.updatedAt)
    }

    @Test
    func terminalRowsExposeTheirExpiryAndDisappearAtTheBoundary() throws {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let updatedAt = now.addingTimeInterval(-60)
        let expiry = updatedAt.addingTimeInterval(
            PlatformAgentAwarenessProjection.terminalVisibilityWindow
        )
        let project = FeatureProject(
            id: "project",
            environmentID: "environment",
            name: "t3code",
            path: "/repo"
        )
        let snapshot = FeatureSnapshot(
            projects: [project],
            threads: [Self.thread(id: "done", state: .completed, updatedAt: updatedAt)]
        )

        #expect(
            PlatformAgentAwarenessProjection.nextTerminalExpiry(
                snapshot: snapshot,
                now: now
            ) == expiry
        )
        #expect(
            PlatformAgentAwarenessProjection.aggregate(
                snapshot: snapshot,
                now: expiry.addingTimeInterval(-0.001)
            ).activities.count == 1
        )
        #expect(
            PlatformAgentAwarenessProjection.aggregate(
                snapshot: snapshot,
                now: expiry
            ).activities.isEmpty
        )
    }

    @Test
    @MainActor
    func signOutEndsActivitiesWithoutRepublishingTheCachedProjection() async {
        let recorder = PlatformAgentAwarenessOperationRecorder()
        let coordinator = PlatformAgentAwarenessCoordinator(
            updateLiveActivity: { _, _, _ in
                recorder.recordUpdate()
            },
            endLiveActivities: {
                recorder.recordEnd()
            }
        )

        coordinator.synchronize(snapshot: FeatureSnapshot(), liveActivitiesEnabled: true)
        await recorder.waitForUpdateCount(1)

        coordinator.resetAndResynchronizeLiveActivity()
        await recorder.waitForEndCount(1)
        await Task.yield()

        #expect(recorder.updateCount == 1)
        #expect(recorder.endCount == 1)
    }

    @Test
    @MainActor
    func latestSnapshotCancelsAnInFlightReversionToOlderState() async {
        let recorder = GatedPlatformAgentAwarenessRecorder()
        let coordinator = PlatformAgentAwarenessCoordinator(
            updateLiveActivity: { _, _, _ in
                await recorder.recordUpdate()
            },
            endLiveActivities: {}
        )
        let ready = FeatureSnapshot()
        let project = FeatureProject(
            id: "project",
            environmentID: "environment",
            name: "t3code",
            path: "/repo"
        )
        let working = FeatureSnapshot(
            projects: [project],
            threads: [Self.thread(id: "working", state: .working, updatedAt: .now)]
        )

        coordinator.synchronize(snapshot: ready, liveActivitiesEnabled: true)
        await recorder.waitForUpdateCount(1)
        await Task.yield()

        coordinator.synchronize(snapshot: working, liveActivitiesEnabled: true)
        await recorder.waitForUpdateCount(2)
        coordinator.synchronize(snapshot: ready, liveActivitiesEnabled: true)
        recorder.releaseSecondUpdate()
        await Task.yield()
        await Task.yield()

        coordinator.synchronize(snapshot: ready, liveActivitiesEnabled: true)
        await Task.yield()
        #expect(recorder.updateCount == 2)
    }

    private static func thread(
        id: String,
        state: FeatureThreadState,
        updatedAt: Date
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            wireID: id,
            projectID: "project",
            environmentID: "environment",
            title: "Task \(id)",
            updatedAt: updatedAt,
            state: state,
            providerID: "claude",
            modelID: "claude-opus-5"
        )
    }
}

@MainActor
private final class GatedPlatformAgentAwarenessRecorder {
    private(set) var updateCount = 0
    private var secondUpdateContinuation: CheckedContinuation<Void, Never>?
    private var updateWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func recordUpdate() async {
        updateCount += 1
        let ready = updateWaiters.filter { updateCount >= $0.0 }
        updateWaiters.removeAll { updateCount >= $0.0 }
        ready.forEach { $0.1.resume() }
        if updateCount == 2 {
            await withCheckedContinuation { continuation in
                secondUpdateContinuation = continuation
            }
        }
    }

    func waitForUpdateCount(_ count: Int) async {
        guard updateCount < count else { return }
        await withCheckedContinuation { continuation in
            updateWaiters.append((count, continuation))
        }
    }

    func releaseSecondUpdate() {
        secondUpdateContinuation?.resume()
        secondUpdateContinuation = nil
    }
}

@MainActor
private final class PlatformAgentAwarenessOperationRecorder {
    private(set) var updateCount = 0
    private(set) var endCount = 0
    private var updateWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var endWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func recordUpdate() {
        updateCount += 1
        resumeReadyWaiters(&updateWaiters, count: updateCount)
    }

    func recordEnd() {
        endCount += 1
        resumeReadyWaiters(&endWaiters, count: endCount)
    }

    func waitForUpdateCount(_ count: Int) async {
        guard updateCount < count else { return }
        await withCheckedContinuation { continuation in
            updateWaiters.append((count, continuation))
        }
    }

    func waitForEndCount(_ count: Int) async {
        guard endCount < count else { return }
        await withCheckedContinuation { continuation in
            endWaiters.append((count, continuation))
        }
    }

    private func resumeReadyWaiters(
        _ waiters: inout [(Int, CheckedContinuation<Void, Never>)],
        count: Int
    ) {
        let ready = waiters.filter { count >= $0.0 }
        waiters.removeAll { count >= $0.0 }
        ready.forEach { $0.1.resume() }
    }
}
