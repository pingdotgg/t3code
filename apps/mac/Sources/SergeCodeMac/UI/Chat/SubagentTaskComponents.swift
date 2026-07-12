import SwiftUI

/// Resolves a model slug to its server-catalog display name, falling back to
/// a compact readable form of the slug for models the catalog doesn't know.
func displayModelName(slug: String, catalog: [String: String]) -> String {
    let trimmed = slug.trimmingCharacters(in: .whitespacesAndNewlines)
    if let displayName = catalog[trimmed]?.trimmingCharacters(in: .whitespacesAndNewlines),
        !displayName.isEmpty
    {
        return displayName
    }
    return shortModelName(trimmed)
}

private func shortModelName(_ model: String) -> String {
    // Prefer a readable short id when the wire form is a long Claude slug.
    if model.hasPrefix("claude-") {
        return String(model.dropFirst("claude-".count))
    }
    return model
}

/// Shared presentation rules for subagent task rows. Keeping these in one
/// place makes the timeline row and the cross-thread agents panel agree on
/// identity, timing, stalled state, and status colors.
enum SubagentTaskPresentation {
    static let stalledThreshold: TimeInterval = 3 * 60

    static func isStalled(task: SubagentTaskItem, at now: Date) -> Bool {
        guard task.state == .running else { return false }
        return now.timeIntervalSince(task.lastActivityAt) > stalledThreshold
    }

    static func title(for task: SubagentTaskItem) -> String {
        task.description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? task.description!
            : "Subagent task"
    }

    /// Compact identity badge: "Explore · Sonnet 5" or "workflow · Opus 4.8".
    /// Model names resolve through the server catalog when it knows the slug.
    static func identityBadge(
        for task: SubagentTaskItem, modelDisplayNames: [String: String]
    ) -> String? {
        var parts: [String] = []
        if let workflow = nonEmpty(task.workflowName) {
            parts.append(workflow)
        } else if let subagent = nonEmpty(task.subagentType) {
            parts.append(subagent)
        } else if let type = nonEmpty(task.taskType) {
            parts.append(type.replacingOccurrences(of: "-", with: " "))
        }
        if let model = nonEmpty(task.model) {
            parts.append(displayModelName(slug: model, catalog: modelDisplayNames))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func lastActivityLabel(task: SubagentTaskItem, at now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(task.lastActivityAt)))
        if seconds < 5 { return "last activity just now" }
        if seconds < 60 { return "last activity \(seconds)s ago" }
        let minutes = seconds / 60
        if minutes < 60 { return "last activity \(minutes)m ago" }
        return "last activity \(minutes / 60)h ago"
    }

    static func subtitle(for task: SubagentTaskItem) -> String? {
        // Terminal (and paused): prefer completion/latest summary when present.
        if task.state != .running {
            if let progress = task.latestProgress?.trimmingCharacters(in: .whitespacesAndNewlines),
                !progress.isEmpty
            {
                return progress
            }
            switch task.state {
            case .running: return nil
            case .paused: return "Paused"
            case .completed: return "Completed"
            case .failed: return "Failed"
            case .stopped: return "Stopped"
            }
        }

        // Running: latest log entry as "tool · summary", else "Working...".
        if let last = task.progressLog.last {
            if let tool = last.toolName?.trimmingCharacters(in: .whitespacesAndNewlines),
                !tool.isEmpty
            {
                return "\(tool) · \(last.text)"
            }
            return last.text
        }
        if let progress = task.latestProgress?.trimmingCharacters(in: .whitespacesAndNewlines),
            !progress.isEmpty
        {
            return progress
        }
        return "Working..."
    }

    static func backgroundTint(for task: SubagentTaskItem, stalled: Bool) -> Color {
        switch task.state {
        case .running: stalled ? Color.orange.opacity(0.08) : Color.accentColor.opacity(0.08)
        case .paused: Color.secondary.opacity(0.08)
        case .completed: Color.green.opacity(0.08)
        case .failed: Color.red.opacity(0.08)
        case .stopped: Color.secondary.opacity(0.08)
        }
    }

    static func durationText(_ duration: TimeInterval) -> String {
        if duration < 1 { return "<1s" }
        if duration < 60 { return "\(Int(duration.rounded()))s" }
        let minutes = Int(duration) / 60
        let seconds = Int(duration) % 60
        return seconds == 0 ? "\(minutes)m" : "\(minutes)m \(seconds)s"
    }

    static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty
        else { return nil }
        return trimmed
    }
}

@MainActor
struct SubagentTaskStatusIcon: View {
    let task: SubagentTaskItem
    let stalled: Bool
    let isLive: Bool

    init(task: SubagentTaskItem, stalled: Bool, isLive: Bool = true) {
        self.task = task
        self.stalled = stalled
        self.isLive = isLive
    }

    var body: some View {
        Image(systemName: iconName)
            .symbolEffect(
                .pulse,
                isActive: task.state == .running
                    && !stalled
                    && isLive
                    && !Motion.reduceMotion)
            .foregroundStyle(iconTint)
            .contentTransition(.symbolEffect(.replace))
    }

    private var iconName: String {
        switch task.state {
        case .running: stalled ? "exclamationmark.circle" : "circle.dotted"
        case .paused: "pause.circle.fill"
        case .completed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .stopped: "stop.circle.fill"
        }
    }

    private var iconTint: Color {
        switch task.state {
        case .running: stalled ? .orange : .secondary
        case .paused: .secondary
        case .completed: .green
        case .failed: .red
        case .stopped: .secondary
        }
    }
}

@MainActor
struct SubagentTaskDurationLabel: View {
    let task: SubagentTaskItem

    @ViewBuilder
    var body: some View {
        if task.state == .running {
            Text(task.startedAt, style: .timer)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        } else if let duration = task.duration {
            Text(SubagentTaskPresentation.durationText(duration))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }
}

@MainActor
struct SubagentTaskIdentityBadge: View {
    let task: SubagentTaskItem
    let modelDisplayNames: [String: String]

    @ViewBuilder
    var body: some View {
        if let identityBadge = SubagentTaskPresentation.identityBadge(
            for: task, modelDisplayNames: modelDisplayNames)
        {
            Text(identityBadge)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

@MainActor
struct SubagentTaskHealthTags: View {
    let task: SubagentTaskItem
    let now: Date

    @ViewBuilder
    var body: some View {
        if task.state == .running {
            let stalled = SubagentTaskPresentation.isStalled(task: task, at: now)
            HStack(spacing: 6) {
                Text(SubagentTaskPresentation.lastActivityLabel(task: task, at: now))
                    .font(.caption2)
                    .foregroundStyle(stalled ? Color.orange : Color.secondary)
                if stalled {
                    Text("stalled")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color.orange.opacity(0.14), in: Capsule())
                }
                if task.isBackgrounded {
                    Text("background")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(.secondary.opacity(0.12), in: Capsule())
                }
            }
        } else if task.state == .paused {
            HStack(spacing: 6) {
                Text("paused")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(.secondary.opacity(0.12), in: Capsule())
                if task.isBackgrounded {
                    Text("background")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(.secondary.opacity(0.12), in: Capsule())
                }
            }
        } else if task.isBackgrounded {
            Text("background")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(.secondary.opacity(0.12), in: Capsule())
        }
    }
}
