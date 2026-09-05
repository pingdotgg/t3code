import ActivityKit
import Foundation
import WidgetKit

extension Notification.Name {
    static let platformLiveActivityChanged = Notification.Name(
        "T3PlatformLiveActivityChanged"
    )
}

enum PlatformAgentAwarenessProjection {
    static let terminalVisibilityWindow: TimeInterval = 15 * 60
    static let maximumRows = 5
    static let minimumPersistenceInterval: TimeInterval = 30

    static func aggregate(
        snapshot: FeatureSnapshot,
        now: Date = .now
    ) -> T3RelayAgentActivityAggregateState {
        // Defensive against duplicate project IDs in aggregate snapshots; this
        // runs on every snapshot revision, so it must never trap.
        let projects = snapshot.projects.reduce(into: [String: FeatureProject]()) {
            $0[$1.id] = $0[$1.id] ?? $1
        }
        let eligible = snapshot.threads.filter { thread in
            guard !thread.isArchived else { return false }
            if isActive(thread.state) { return true }
            guard thread.state == .completed || thread.state == .failed else { return false }
            return now.timeIntervalSince(thread.updatedAt) < terminalVisibilityWindow
        }
        let rows = eligible.compactMap { thread -> T3RelayAgentActivityAggregateRow? in
            guard let project = projects[thread.projectID] else { return nil }
            let environmentID = thread.environmentID ?? project.environmentID
            let threadID = thread.wireID ?? thread.id
            let phase = phase(for: thread.state)
            return T3RelayAgentActivityAggregateRow(
                environmentId: environmentID,
                threadId: threadID,
                projectTitle: project.name,
                threadTitle: thread.title,
                modelTitle: modelTitle(
                    for: thread,
                    environmentID: environmentID,
                    snapshot: snapshot
                ),
                phase: phase,
                status: status(for: thread.state),
                updatedAt: thread.updatedAt.ISO8601Format(),
                deepLink: PlatformRoute.thread(
                    environmentID: environmentID,
                    threadID: threadID
                ).url?.absoluteString ?? "/"
            )
        }
        .sorted { left, right in
            let leftPriority = priority(left.phase)
            let rightPriority = priority(right.phase)
            if leftPriority != rightPriority { return leftPriority < rightPriority }
            return left.updatedAt > right.updatedAt
        }
        let visibleRows = Array(rows.prefix(maximumRows))
        let activeCount = eligible.count { isActive($0.state) }
        let attentionCount = eligible.count {
            $0.state == .waitingForApproval || $0.state == .waitingForInput
        }
        let subtitle: String
        if attentionCount > 0 {
            subtitle = attentionCount == 1
                ? "1 task needs attention"
                : "\(attentionCount) tasks need attention"
        } else if activeCount > 0 {
            subtitle = activeCount == 1 ? "1 active task" : "\(activeCount) active tasks"
        } else if visibleRows.contains(where: { $0.phase == .failed }) {
            subtitle = "Agent work failed"
        } else if !visibleRows.isEmpty {
            subtitle = "Agent work completed"
        } else {
            subtitle = "Ready for a task"
        }
        return T3RelayAgentActivityAggregateState(
            title: "T3 Code",
            subtitle: subtitle,
            activeCount: activeCount,
            updatedAt: now.ISO8601Format(),
            activities: visibleRows
        )
    }

    static func widgetSnapshot(
        snapshot: FeatureSnapshot,
        now: Date = .now
    ) -> T3TaskWidgetSnapshot {
        let aggregate = aggregate(snapshot: snapshot, now: now)
        return T3TaskWidgetSnapshot(
            updatedAt: aggregate.updatedAt,
            tasks: aggregate.activities
        )
    }

    static func nextTerminalExpiry(
        snapshot: FeatureSnapshot,
        now: Date = .now
    ) -> Date? {
        snapshot.threads.lazy
            .filter {
                !$0.isArchived && ($0.state == .completed || $0.state == .failed)
            }
            .map { $0.updatedAt.addingTimeInterval(terminalVisibilityWindow) }
            .filter { $0 > now }
            .min()
    }

    private static func isActive(_ state: FeatureThreadState) -> Bool {
        switch state {
        case .queued, .working, .monitoring, .waitingForApproval, .waitingForInput:
            true
        case .idle, .failed, .completed:
            false
        }
    }

    private static func phase(for state: FeatureThreadState) -> T3AgentActivityPhase {
        switch state {
        case .queued: .starting
        case .working: .running
        case .monitoring: .running
        case .waitingForApproval: .waitingForApproval
        case .waitingForInput: .waitingForInput
        case .failed: .failed
        case .completed: .completed
        case .idle: .stale
        }
    }

    private static func status(for state: FeatureThreadState) -> String {
        switch state {
        case .queued: "Starting"
        case .working: "Working"
        case .monitoring: "Monitoring"
        case .waitingForApproval: "Approval"
        case .waitingForInput: "Input"
        case .failed: "Failed"
        case .completed: "Done"
        case .idle: "Idle"
        }
    }

    private static func priority(_ phase: T3AgentActivityPhase) -> Int {
        switch phase {
        case .waitingForApproval, .waitingForInput: 0
        case .failed: 1
        case .starting, .running: 2
        case .completed, .stale: 3
        }
    }

    private static func modelTitle(
        for thread: FeatureThread,
        environmentID: String,
        snapshot: FeatureSnapshot
    ) -> String {
        let providers = snapshot.providersByEnvironment?[environmentID] ?? []
        let provider = thread.providerID.flatMap { providerID in
            providers.first { $0.id == providerID }
        }
        if let modelID = thread.modelID,
           let model = provider?.models.first(where: { $0.id == modelID })
        {
            return model.name
        }
        return thread.modelID ?? provider?.name ?? thread.providerName ?? ""
    }
}

@MainActor
final class PlatformAgentAwarenessCoordinator {
    static let shared = PlatformAgentAwarenessCoordinator()

    private let updateLiveActivity: @MainActor (
        T3RelayAgentActivityAggregateState,
        Bool,
        Date
    ) async throws -> Void
    private let endLiveActivities: @MainActor () async -> Void

    private struct Signature: Equatable {
        let activeCount: Int
        let subtitle: String
        let rows: [T3RelayAgentActivityAggregateRow]
        let enabled: Bool
    }

    private struct Synchronization {
        let signature: Signature
        let aggregate: T3RelayAgentActivityAggregateState
        let enabled: Bool
        let now: Date
    }

    private var activityUpdateTask: Task<Void, Never>?
    private var widgetUpdateTask: Task<Void, Never>?
    private var terminalExpiryTask: Task<Void, Never>?
    private var lastSignature: Signature?
    private var inFlightSignature: Signature?
    private var synchronizationGeneration = 0
    private var widgetGeneration = 0
    private var terminalExpiryGeneration = 0

    init(
        updateLiveActivity: @escaping @MainActor (
            T3RelayAgentActivityAggregateState,
            Bool,
            Date
        ) async throws -> Void = { aggregate, enabled, now in
            try await PlatformAgentAwarenessCoordinator.synchronizeLiveActivity(
                aggregate: aggregate,
                enabled: enabled,
                now: now
            )
        },
        endLiveActivities: @escaping @MainActor () async -> Void = {
            await PlatformAgentAwarenessCoordinator.endAllLiveActivities()
        }
    ) {
        self.updateLiveActivity = updateLiveActivity
        self.endLiveActivities = endLiveActivities
    }

    func synchronize(snapshot: FeatureSnapshot, liveActivitiesEnabled: Bool) {
        let now = Date.now
        scheduleTerminalExpiry(
            snapshot: snapshot,
            liveActivitiesEnabled: liveActivitiesEnabled,
            now: now
        )
        let aggregate = PlatformAgentAwarenessProjection.aggregate(
            snapshot: snapshot,
            now: now
        )
        let signature = Signature(
            activeCount: aggregate.activeCount,
            subtitle: aggregate.subtitle,
            // `updatedAt` advances throughout a turn without changing visible
            // state. Bucket it so long work still refreshes ActivityKit's stale
            // date without writing widget state for every shell delta.
            rows: aggregate.activities.map { row in
                var row = row
                let bucket = floor(
                    now.timeIntervalSince1970 / PlatformAgentAwarenessProjection.minimumPersistenceInterval
                ) * PlatformAgentAwarenessProjection.minimumPersistenceInterval
                row.updatedAt = Date(timeIntervalSince1970: bucket).ISO8601Format()
                return row
            },
            enabled: liveActivitiesEnabled
        )
        let synchronization = Synchronization(
            signature: signature,
            aggregate: aggregate,
            enabled: liveActivitiesEnabled,
            now: now
        )
        if signature == lastSignature {
            if inFlightSignature != nil {
                activityUpdateTask?.cancel()
                synchronizationGeneration &+= 1
                inFlightSignature = nil
                activityUpdateTask = nil
            }
            return
        }
        guard signature != inFlightSignature else { return }

        let widgetSnapshot = T3TaskWidgetSnapshot(
            updatedAt: aggregate.updatedAt,
            tasks: aggregate.activities
        )
        scheduleWidgetUpdate(widgetSnapshot)

        schedule(synchronization)
    }

    /// Account sign-out invalidates the cached account-scoped projection before
    /// removing its activity. Only a later snapshot may publish new content.
    func resetAndResynchronizeLiveActivity() {
        activityUpdateTask?.cancel()
        terminalExpiryTask?.cancel()
        terminalExpiryGeneration &+= 1
        terminalExpiryTask = nil
        synchronizationGeneration &+= 1
        let generation = synchronizationGeneration
        lastSignature = nil
        inFlightSignature = nil
        scheduleWidgetUpdate(.empty)
        activityUpdateTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await endLiveActivities()
            guard synchronizationGeneration == generation else { return }
            activityUpdateTask = nil
        }
    }

    private func schedule(_ synchronization: Synchronization) {
        activityUpdateTask?.cancel()
        synchronizationGeneration &+= 1
        let generation = synchronizationGeneration
        inFlightSignature = synchronization.signature
        activityUpdateTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await updateLiveActivity(
                    synchronization.aggregate,
                    synchronization.enabled,
                    synchronization.now
                )
                try Task.checkCancellation()
                guard synchronizationGeneration == generation,
                      inFlightSignature == synchronization.signature else { return }
                lastSignature = synchronization.signature
                inFlightSignature = nil
                activityUpdateTask = nil
            } catch {
                guard synchronizationGeneration == generation,
                      inFlightSignature == synchronization.signature else { return }
                // Keep the completed signature unchanged so the next identical
                // snapshot retries a failed or cancelled ActivityKit operation.
                inFlightSignature = nil
                activityUpdateTask = nil
            }
        }
    }

    private func scheduleWidgetUpdate(_ snapshot: T3TaskWidgetSnapshot) {
        widgetUpdateTask?.cancel()
        widgetGeneration &+= 1
        let generation = widgetGeneration
        widgetUpdateTask = Task { @MainActor [weak self] in
            let saved = await PlatformWidgetSnapshotWriter.shared.save(
                snapshot,
                generation: generation
            )
            guard let self, saved, widgetGeneration == generation else { return }
            WidgetCenter.shared.reloadTimelines(ofKind: "T3RecentTasksWidget")
            widgetUpdateTask = nil
        }
    }

    private func scheduleTerminalExpiry(
        snapshot: FeatureSnapshot,
        liveActivitiesEnabled: Bool,
        now: Date
    ) {
        terminalExpiryTask?.cancel()
        terminalExpiryGeneration &+= 1
        let generation = terminalExpiryGeneration
        guard let expiry = PlatformAgentAwarenessProjection.nextTerminalExpiry(
            snapshot: snapshot,
            now: now
        ) else {
            terminalExpiryTask = nil
            return
        }
        let delay = max(0, expiry.timeIntervalSince(now))
        terminalExpiryTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
            guard let self,
                  terminalExpiryGeneration == generation else { return }
            terminalExpiryTask = nil
            synchronize(
                snapshot: snapshot,
                liveActivitiesEnabled: liveActivitiesEnabled
            )
        }
    }

    private static func synchronizeLiveActivity(
        aggregate: T3RelayAgentActivityAggregateState,
        enabled: Bool,
        now: Date
    ) async throws {
        try Task.checkCancellation()
        let activities = Activity<LiveActivityAttributes>.activities

        guard enabled, ActivityAuthorizationInfo().areActivitiesEnabled else {
            for activity in activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            try Task.checkCancellation()
            notifyActivityChanged()
            return
        }

        let state = try LiveActivityAttributes.ContentState(aggregate: aggregate)
        let content = ActivityContent(
            state: state,
            staleDate: now.addingTimeInterval(10 * 60)
        )

        if aggregate.activeCount == 0 {
            for activity in activities {
                await activity.end(
                    content,
                    dismissalPolicy: .after(now.addingTimeInterval(5 * 60))
                )
            }
            try Task.checkCancellation()
            notifyActivityChanged()
            return
        }

        if let primary = activities.first {
            await primary.update(content)
            for duplicate in activities.dropFirst() {
                await duplicate.end(nil, dismissalPolicy: .immediate)
            }
        } else {
            _ = try Activity.request(
                attributes: LiveActivityAttributes(),
                content: content,
                pushType: .token
            )
        }
        try Task.checkCancellation()
        notifyActivityChanged()
    }

    private static func endAllLiveActivities() async {
        for activity in Activity<LiveActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        notifyActivityChanged()
    }

    private static func notifyActivityChanged() {
        NotificationCenter.default.post(name: .platformLiveActivityChanged, object: nil)
    }
}

private actor PlatformWidgetSnapshotWriter {
    static let shared = PlatformWidgetSnapshotWriter()

    private var latestGeneration = 0

    func save(_ snapshot: T3TaskWidgetSnapshot, generation: Int) -> Bool {
        guard generation >= latestGeneration else { return false }
        latestGeneration = generation
        do {
            try T3TaskWidgetSnapshotStore.save(snapshot)
            return true
        } catch {
            return false
        }
    }
}
