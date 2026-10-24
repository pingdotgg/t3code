import Foundation
import Observation

/// Task IDs are local to an environment, including on hosts copied from the same database.
public struct FeatureScheduledTaskTarget: Hashable, Sendable, Identifiable {
    public let environmentID: String
    public let taskID: String
    public var id: Self { self }

    public init(environmentID: String, taskID: String) {
        self.environmentID = environmentID
        self.taskID = taskID
    }
}

public struct FeatureScheduledTaskSnapshot: Sendable {
    public let tasks: [ScheduledTask]
    public let receivesLiveUpdates: Bool
}

/// Optional service capability; it does not depend on the selected orchestration version.
@MainActor
public protocol FeatureScheduledTaskManaging: AnyObject {
    func listScheduledTasks(environmentID: String) async throws -> [ScheduledTask]
    func scheduledTaskUpdates(environmentID: String) -> AsyncThrowingStream<FeatureScheduledTaskSnapshot, Error>
    /// Input project and thread IDs belong to this environment and use their raw server values.
    func upsertScheduledTask(environmentID: String, input: ScheduledTaskUpsertInput) async throws -> ScheduledTask
    func setScheduledTaskEnabled(_ target: FeatureScheduledTaskTarget, enabled: Bool) async throws -> ScheduledTask
    func runScheduledTaskNow(_ target: FeatureScheduledTaskTarget) async throws -> ScheduledTask
    func rotateScheduledTaskWebhookToken(_ target: FeatureScheduledTaskTarget) async throws -> ScheduledTask
    func deleteScheduledTask(_ target: FeatureScheduledTaskTarget) async throws
}

public enum FeatureScheduledTaskError: LocalizedError, Equatable {
    case unsupported
    case invalidDraft(String)

    public var errorDescription: String? {
        switch self {
        case .unsupported: "This environment does not support scheduled tasks. Update its server to use them."
        case let .invalidDraft(message): message
        }
    }

    static func isUnsupportedRPC(_ error: any Error, method: String) -> Bool {
        guard let message = (error as? RPCError)?.remoteMessage else { return false }
        let text = message.lowercased()
        return text.contains(method.lowercased()) && (
            text.contains("unsupported method") || text.contains("unknown rpc")
                || text.contains("unknown request") || text.contains("method not found")
                || text.contains("unknown method")
        )
    }
}

/// One list owns one environment. Replacing the view cannot redirect an in-flight action.
@MainActor
@Observable
final class FeatureScheduledTaskListModel {
    let environmentID: String
    private let client: any FeatureScheduledTaskManaging
    private var streamGeneration = UUID()
    private var snapshotRevision = 0
    private(set) var tasks: [ScheduledTask]?
    private(set) var pendingIDs: Set<String> = []
    private(set) var receivesLiveUpdates = true
    private(set) var isUnsupported = false
    private(set) var loadError: String?
    var actionError: String?

    init(environmentID: String, client: any FeatureScheduledTaskManaging) {
        self.environmentID = environmentID
        self.client = client
    }

    func observe() async {
        guard !Task.isCancelled else { return }
        let generation = UUID()
        streamGeneration = generation
        loadError = nil
        isUnsupported = false
        do {
            for try await snapshot in client.scheduledTaskUpdates(environmentID: environmentID) {
                try Task.checkCancellation()
                guard streamGeneration == generation else { return }
                tasks = snapshot.tasks
                receivesLiveUpdates = snapshot.receivesLiveUpdates
                snapshotRevision += 1
                loadError = nil
            }
            if !Task.isCancelled, streamGeneration == generation { receivesLiveUpdates = false }
        } catch {
            guard !Task.isCancelled, streamGeneration == generation else { return }
            recordLoadError(error)
        }
    }

    func refresh() async {
        let revision = snapshotRevision
        do {
            let result = try await client.listScheduledTasks(environmentID: environmentID)
            try Task.checkCancellation()
            // A live update received while this request was running is newer than its snapshot.
            if snapshotRevision == revision { tasks = result; snapshotRevision += 1 }
            loadError = nil
            isUnsupported = false
        } catch {
            guard !Task.isCancelled, snapshotRevision == revision else { return }
            recordLoadError(error)
        }
    }

    func setEnabled(_ task: ScheduledTask, enabled: Bool) async {
        await mutate(task.id) {
            _ = try await self.client.setScheduledTaskEnabled(self.target(task.id), enabled: enabled)
        }
    }

    func runNow(_ task: ScheduledTask) async {
        guard !task.schedule.isWebhook, task.lastRunStatus != .running else { return }
        await mutate(task.id) { _ = try await self.client.runScheduledTaskNow(self.target(task.id)) }
    }

    func task(id: String) -> ScheduledTask? { tasks?.first { $0.id == id } }

    func rotateWebhookToken(_ task: ScheduledTask) async {
        guard task.schedule.isWebhook else { return }
        await mutate(task.id) {
            let revision = self.snapshotRevision
            let updated = try await self.client.rotateScheduledTaskWebhookToken(self.target(task.id))
            // A stream update or deletion received during rotation takes precedence.
            if self.snapshotRevision == revision,
               let index = self.tasks?.firstIndex(where: { $0.id == task.id }) {
                self.tasks?[index] = updated
                self.snapshotRevision += 1
            }
        }
    }

    func delete(_ task: ScheduledTask) async {
        await mutate(task.id) { try await self.client.deleteScheduledTask(self.target(task.id)) }
    }

    private func target(_ id: String) -> FeatureScheduledTaskTarget {
        .init(environmentID: environmentID, taskID: id)
    }

    private func mutate(_ id: String, action: () async throws -> Void) async {
        guard pendingIDs.insert(id).inserted else { return }
        defer { pendingIDs.remove(id) }
        do {
            try await action()
            await refresh()
        } catch {
            guard !Task.isCancelled else { return }
            actionError = error.localizedDescription
        }
    }

    private func recordLoadError(_ error: any Error) {
        isUnsupported = (error as? FeatureScheduledTaskError) == .unsupported
        receivesLiveUpdates = false
        loadError = error.localizedDescription
    }
}
