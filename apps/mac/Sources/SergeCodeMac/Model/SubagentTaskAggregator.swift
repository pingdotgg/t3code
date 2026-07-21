import Foundation
import Observation

/// Cross-thread projection of the task state that LiveBackend folds from
/// subagent lifecycle activities. AppModel updates it from timeline snapshots
/// and task upserts, while the live set mirrors the timeline subscription LRU.
@Observable
@MainActor
final class SubagentTaskAggregator {
    struct Entry: Identifiable, Equatable {
        let threadID: String
        let threadTitle: String
        let task: SubagentTaskItem
        let isLive: Bool

        var id: String {
            "\(threadID):\(task.taskId)"
        }
    }

    struct ThreadGroup: Identifiable {
        let threadID: String
        let title: String
        let entries: [Entry]

        var id: String { threadID }
    }

    private var tasksByThread: [String: [SubagentTaskItem]] = [:]
    private var threadTitles: [String: String] = [:]
    private var liveThreadIDs: Set<String> = []

    var entries: [Entry] {
        tasksByThread.keys
            .sorted { title(for: $0).localizedStandardCompare(title(for: $1)) == .orderedAscending }
            .flatMap { threadID in
                let title = title(for: threadID)
                return (tasksByThread[threadID] ?? [])
                    .filter { $0.entityKind == .subagent }
                    .map { task in
                        Entry(
                            threadID: threadID,
                            threadTitle: title,
                            task: task,
                            isLive: liveThreadIDs.contains(threadID))
                    }
            }
    }

    /// Only running tasks on currently live timeline subscriptions count here.
    var runningCount: Int {
        entries.reduce(into: 0) { count, entry in
            if entry.isLive && entry.task.state == .running {
                count += 1
            }
        }
    }

    var threadGroups: [ThreadGroup] {
        let allEntries = entries
        let grouped = Dictionary(grouping: allEntries, by: \.threadID)
        return grouped.keys
            .sorted {
                title(for: $0).localizedStandardCompare(title(for: $1)) == .orderedAscending
            }
            .map { threadID in
                ThreadGroup(
                    threadID: threadID,
                    title: title(for: threadID),
                    entries: grouped[threadID] ?? [])
            }
    }

    /// One task by identity. Backs the inner-thread pane, which re-reads the
    /// task on every progress event rather than holding a stale copy.
    func task(taskId: String, threadID: String) -> SubagentTaskItem? {
        tasksByThread[threadID]?.first { $0.taskId == taskId }
    }

    func updateThread(_ thread: ChatThread) {
        let title = thread.title.isEmpty ? "Untitled thread" : thread.title
        guard threadTitles[thread.id] != title else { return }
        threadTitles[thread.id] = title
    }

    /// Replaces the task fold for an authoritative timeline snapshot.
    func replaceTasks(_ tasks: [SubagentTaskItem], for threadID: String) {
        guard tasksByThread[threadID] != tasks else { return }
        tasksByThread[threadID] = tasks
    }

    /// Applies a single task row update without disturbing frozen rows from a
    /// pruned thread whose AppModel display timeline has been cleared.
    func upsert(_ task: SubagentTaskItem, for threadID: String) {
        var tasks = tasksByThread[threadID] ?? []
        if let index = tasks.firstIndex(where: { $0.taskId == task.taskId }) {
            guard tasks[index] != task else { return }
            tasks[index] = task
        } else {
            tasks.append(task)
        }
        tasksByThread[threadID] = tasks
    }

    func setLive(_ isLive: Bool, for threadID: String) {
        if isLive {
            guard liveThreadIDs.insert(threadID).inserted else { return }
        } else {
            guard liveThreadIDs.remove(threadID) != nil else { return }
        }
    }

    func remove(threadID: String) {
        tasksByThread[threadID] = nil
        threadTitles[threadID] = nil
        liveThreadIDs.remove(threadID)
    }

    private func title(for threadID: String) -> String {
        threadTitles[threadID] ?? "Untitled thread"
    }
}
