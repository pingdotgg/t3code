import Foundation

/// Keeps only the small part of subagent state that mobile displays. The
/// server-provided `agentKind` is authoritative; legacy unmarked tasks remain
/// ordinary work-log entries.
struct FeatureActiveSubagentTracker {
    private enum Status: String {
        case pending
        case running
        case waiting
        case idle
        case completed
        case failed
        case cancelled
        case interrupted

        var isActive: Bool {
            self == .pending || self == .running || self == .waiting
        }

        var isTerminal: Bool {
            self == .completed || self == .failed || self == .cancelled || self == .interrupted
        }
    }

    private var statuses: [String: Status] = [:]

    var activeCount: Int {
        statuses.values.count(where: \.isActive)
    }

    mutating func reset(with activities: [OrchestrationActivity]) {
        statuses.removeAll(keepingCapacity: true)
        for activity in activities {
            apply(activity)
        }
    }

    mutating func apply(_ activity: OrchestrationActivity) {
        guard activity.kind == "task.started"
                || activity.kind == "task.progress"
                || activity.kind == "task.updated"
                || activity.kind == "task.completed",
              let taskID = activity.payload["taskId"]?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !taskID.isEmpty else {
            return
        }

        let isKnownAgent = statuses[taskID] != nil
        let isExplicitAgent = activity.payload["agentKind"]?.stringValue == "agent"
        guard isKnownAgent || isExplicitAgent else { return }

        switch activity.kind {
        case "task.started":
            if let current = statuses[taskID], current.isTerminal {
                return
            }
            statuses[taskID] = .running

        case "task.progress":
            if let status = status(from: activity.payload["status"]) {
                statuses[taskID] = status
            } else if statuses[taskID] != .idle,
                      statuses[taskID]?.isTerminal != true {
                statuses[taskID] = .running
            }

        case "task.updated":
            statuses[taskID] = status(from: activity.payload["status"])
                ?? statuses[taskID]
                ?? .pending

        case "task.completed":
            guard statuses[taskID]?.isTerminal != true else { return }
            statuses[taskID] = switch activity.payload["status"]?.stringValue {
            case "failed": .failed
            case "stopped": .interrupted
            default: .completed
            }

        default:
            break
        }
    }

    private func status(from value: JSONValue?) -> Status? {
        guard let rawValue = value?.stringValue else { return nil }
        return Status(rawValue: rawValue)
    }
}
