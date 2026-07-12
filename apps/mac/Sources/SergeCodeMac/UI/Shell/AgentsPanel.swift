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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "person.2")
                    .foregroundStyle(.tint)
                Text("Agents")
                    .font(.headline)
                Spacer(minLength: 12)
                Text("\(model.subagentTaskAggregator.runningCount) running")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 10)

            Divider()

            if model.subagentTaskAggregator.threadGroups.isEmpty {
                Text("No agents running")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 18)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(model.subagentTaskAggregator.threadGroups) { group in
                            VStack(alignment: .leading, spacing: 6) {
                                threadHeader(group)
                                ForEach(group.entries) { entry in
                                    AgentsPanelTaskRow(
                                        entry: entry,
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
        let stalled = SubagentTaskPresentation.isStalled(task: entry.task, at: now)
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
                        if entry.task.state == .running {
                            stopButton
                        }
                        SubagentTaskDurationLabel(task: entry.task)
                    }

                    SubagentTaskIdentityBadge(
                        task: entry.task, modelDisplayNames: modelDisplayNames)
                    SubagentTaskHealthTags(task: entry.task, now: now)

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
