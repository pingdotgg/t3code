import SwiftUI

/// Toolbar chrome for the cross-thread task monitor. Like
/// `ConnectionStatusPill`, this deliberately has no background of its own:
/// the macOS toolbar supplies the glass container.
@MainActor
struct AgentsToolbarPill: View {
    let count: Int

    @UIState private var isPulsing = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(.green)
                .frame(width: 6, height: 6)
                .scaleEffect(isPulsing ? 1.25 : 1)
                .animation(
                    isPulsing
                        ? Motion.ambient.repeatForever(autoreverses: true)
                        : Motion.ambient,
                    value: isPulsing)
            Text("\(count) agent\(count == 1 ? "" : "s")")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 4)
        .fixedSize()
        .animation(Motion.ambient, value: count)
        .onAppear { updatePulse() }
        .onChange(of: count) { _, _ in updatePulse() }
    }

    private func updatePulse() {
        isPulsing = count > 0 && !Motion.reduceMotion
    }
}

@MainActor
struct AgentsPanel: View {
    let model: AppModel
    let onSelectThread: (String) -> Void

    /// Sibling agent threads (MCP `agent_*` toolkit spawns, any provider):
    /// ordinary threads titled `Agent: <name>` whose session is still working.
    /// A stalled turn still counts as running here. Excludes the terminal
    /// idle/archived/error states so the roster stays a live-work view.
    private var siblingAgents: [ChatThread] {
        model.threads
            .filter { thread in
                Self.isSiblingAgentThread(thread) && Self.isWorking(thread)
            }
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    private var runningCount: Int {
        model.subagentTaskAggregator.runningCount + siblingAgents.count
    }

    private var isEmpty: Bool {
        model.subagentTaskAggregator.threadGroups.isEmpty && siblingAgents.isEmpty
    }

    private func threadHealth(for threadID: String) -> ThreadHealth? {
        model.threads.first { $0.id == threadID }?.health
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "person.2")
                    .foregroundStyle(.tint)
                Text("Agents")
                    .font(.headline)
                Spacer(minLength: 12)
                Text("\(runningCount) running")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 10)

            Divider()

            if isEmpty {
                Text("No agents running")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 18)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if !siblingAgents.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                sectionHeader("Delegated agents", systemImage: "square.stack.3d.up")
                                ForEach(siblingAgents) { thread in
                                    AgentsPanelSiblingRow(thread: thread) {
                                        onSelectThread(thread.id)
                                    }
                                }
                            }
                        }
                        ForEach(model.subagentTaskAggregator.threadGroups) { group in
                            VStack(alignment: .leading, spacing: 6) {
                                threadHeader(group)
                                ForEach(group.entries) { entry in
                                    AgentsPanelTaskRow(
                                        entry: entry,
                                        threadHealth: threadHealth(for: entry.threadID),
                                        modelDisplayNames: model.modelDisplayNames,
                                        stopError: model.subagentStopErrors[entry.task.taskId],
                                        onStop: {
                                            Task {
                                                await model.stopSubagentTask(
                                                    taskId: entry.task.taskId,
                                                    threadID: entry.threadID)
                                            }
                                        },
                                        onClearStopError: {
                                            model.clearSubagentStopError(taskId: entry.task.taskId)
                                        })
                                }
                            }
                        }
                    }
                    .padding(.top, 12)
                    .padding(.bottom, 2)
                }
            }
        }
        .padding(14)
        .frame(minWidth: 380, idealWidth: 420, maxWidth: 480, maxHeight: 620)
    }

    /// The MCP `agent_*` toolkit titles spawned threads `Agent: <name>` "for
    /// easy identification in the UI" (agents/tools.ts) — there is no persisted
    /// parent/child marker on the wire, so that convention is the client signal.
    static func isSiblingAgentThread(_ thread: ChatThread) -> Bool {
        // No wire parent/child marker exists, so the exact tool-written title prefix is required.
        thread.title.trimmingCharacters(in: .whitespaces).hasPrefix("Agent: ")
    }

    /// A sibling agent is "working" while its turn runs (or is stalled — a
    /// stalled turn is still an in-flight turn, just gone quiet).
    static func isWorking(_ thread: ChatThread) -> Bool {
        if thread.isStalled { return true }
        switch thread.status {
        case .running, .backgroundWork, .waitingApproval: return true
        case .idle, .error, .archived: return false
        }
    }

    private func sectionHeader(_ title: String, systemImage: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
        }
    }

    private func threadHeader(_ group: SubagentTaskAggregator.ThreadGroup) -> some View {
        Button {
            onSelectThread(group.threadID)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.turn.down.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(group.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open \(group.title)")
        .accessibilityLabel("Open thread \(group.title)")
    }
}

@MainActor
private struct AgentsPanelTaskRow: View {
    let entry: SubagentTaskAggregator.Entry
    /// Server liveness for the owning thread; wins over the client heuristic.
    let threadHealth: ThreadHealth?
    let modelDisplayNames: [String: String]
    let stopError: String?
    let onStop: () -> Void
    let onClearStopError: () -> Void

    var body: some View {
        Group {
            if entry.task.state == .running {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    rowChrome(now: context.date)
                }
            } else {
                rowChrome(now: Date())
            }
        }
    }

    @ViewBuilder
    private func rowChrome(now: Date) -> some View {
        let stalled = SubagentTaskPresentation.isStalled(
            task: entry.task, at: now, threadHealth: threadHealth)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 9) {
                SubagentTaskStatusIcon(
                    task: entry.task, stalled: stalled, isLive: entry.isLive)
                    .frame(width: 16, height: 16)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 7) {
                        Image(systemName: "person.2")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 14)
                        Text(SubagentTaskPresentation.title(for: entry.task))
                            .font(.callout.weight(.medium))
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        // Match the timeline row: paused agents are stoppable
                        // too, and the panel is the only stop affordance for
                        // non-selected threads.
                        if entry.task.state == .running || entry.task.state == .paused {
                            stopButton
                        }
                        SubagentTaskDurationLabel(task: entry.task)
                    }

                    SubagentTaskIdentityBadge(
                        task: entry.task, modelDisplayNames: modelDisplayNames)
                    SubagentTaskHealthTags(
                        task: entry.task, now: now, threadHealth: threadHealth)

                    if !entry.isLive {
                        Text("Not live — open thread to refresh")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    if let subtitle = SubagentTaskPresentation.subtitle(for: entry.task) {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let stopError = SubagentTaskPresentation.nonEmpty(stopError) {
                        Text(stopError)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            SubagentTaskPresentation.backgroundTint(for: entry.task, stalled: stalled),
            in: RoundedRectangle(cornerRadius: 10))
        .opacity(entry.isLive ? 1 : 0.58)
        .animation(Motion.ambient, value: entry.task.state)
        .onChange(of: entry.task.state) { _, _ in
            onClearStopError()
        }
    }

    private var stopButton: some View {
        Button {
            onStop()
        } label: {
            Image(systemName: "stop.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help("Stop agent")
        .accessibilityLabel("Stop agent")
    }
}

/// A delegated sibling-agent thread (any provider) spawned via the MCP
/// `agent_*` toolkit. Driven entirely by ordinary thread/session state:
/// provider, live status, last-activity time, and the server stalled badge.
@MainActor
private struct AgentsPanelSiblingRow: View {
    let thread: ChatThread
    let onSelect: () -> Void

    var body: some View {
        Group {
            if thread.status == .running || thread.isStalled {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    rowChrome(now: context.date)
                }
            } else {
                rowChrome(now: Date())
            }
        }
    }

    @ViewBuilder
    private func rowChrome(now: Date) -> some View {
        let stalled = thread.isStalled
        Button(action: onSelect) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: stalled ? "exclamationmark.circle" : "circle.dotted")
                    .symbolEffect(
                        .pulse, isActive: thread.status == .running && !stalled
                            && !Motion.reduceMotion)
                    .foregroundStyle(stalled ? .orange : .secondary)
                    .frame(width: 16, height: 16)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 7) {
                        Text(agentName)
                            .font(.callout.weight(.medium))
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    TranscriptPill(
                        "\(thread.provider.displayName) · \(statusText)",
                        tint: .secondary,
                        fill: AnyShapeStyle(.quaternary))
                    HStack(spacing: 6) {
                        Text(activityLabel(now: now, stalled: stalled))
                            .font(.caption2)
                            .foregroundStyle(stalled ? Color.orange : Color.secondary)
                        if stalled {
                            TranscriptPill(
                                "stalled", tint: .orange,
                                fill: AnyShapeStyle(Color.orange.opacity(0.14)))
                        }
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            (stalled ? Color.orange.opacity(0.08) : Color.accentColor.opacity(0.08)),
            in: RoundedRectangle(cornerRadius: 10))
        .help("Open \(thread.title)")
        .accessibilityLabel("Open agent \(agentName)")
    }

    /// The spawn name without the `Agent: ` prefix; falls back to the title.
    private var agentName: String {
        let trimmed = thread.title.trimmingCharacters(in: .whitespaces)
        if let range = trimmed.range(
            of: "^Agent:\\s*", options: [.regularExpression, .caseInsensitive])
        {
            let name = String(trimmed[range.upperBound...])
            return name.isEmpty ? trimmed : name
        }
        return trimmed.isEmpty ? "Agent" : trimmed
    }

    private var statusText: String {
        if thread.isStalled { return "stalled" }
        switch thread.status {
        case .running: return "running"
        case .backgroundWork: return "background work"
        case .waitingApproval: return "waiting for approval"
        case .idle: return "idle"
        case .error: return "error"
        case .archived: return "archived"
        }
    }

    private func activityLabel(now: Date, stalled: Bool) -> String {
        if stalled, let since = thread.health?.stalledSince {
            return SubagentTaskPresentation.stalledForLabel(since: since, at: now)
        }
        let reference = thread.health?.lastActivityAt ?? thread.updatedAt
        let seconds = max(0, Int(now.timeIntervalSince(reference)))
        if seconds < 5 { return "last activity just now" }
        if seconds < 60 { return "last activity \(seconds)s ago" }
        let minutes = seconds / 60
        if minutes < 60 { return "last activity \(minutes)m ago" }
        return "last activity \(minutes / 60)h ago"
    }
}
