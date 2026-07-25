import AppKit
import SwiftUI

/// Inline representation of a delegated or provider-native sub-agent task in
/// the chat timeline. The card is the ONLY surface for sub-agent work: there
/// is no drill-in pane, no agents panel, and no sidebar thread. Collapsed it
/// shows status, identity, elapsed time, and the latest activity line; a tap
/// unfolds the progress log and (once settled) the agent's result in place.
@MainActor
struct DelegatedTaskCard: View {
    /// Expanded log shows the tail; older entries are summarized above.
    private static let maxVisibleLogEntries = 30
    /// Compact status/glyph column. Deliberately not `TranscriptMetrics
    /// .iconColumn` — that token tracks the activity stream's larger chips,
    /// while this card keeps its own denser chrome.
    private static let iconColumn: CGFloat = 16

    let task: SubagentTaskItem
    let modelDisplayNames: [String: String]
    /// Transient stop-RPC failure (not part of the provider task payload).
    let stopError: String?
    let onStopAgent: () -> Void
    let onStopTurn: () -> Void
    let onClearStopError: () -> Void

    @UIState private var isExpanded = false
    @UIState private var isHovering = false
    @UIState private var showStopTurnConfirm = false

    private var hasExpandableContent: Bool {
        SubagentTaskPresentation.hasExpandableContent(for: task, stopError: stopError)
    }

    /// The agent's result once it settles: the completion summary the fold
    /// stores in `latestProgress`, falling back to the failure text.
    private var resultText: String? {
        guard task.state != .running, task.state != .paused else { return nil }
        if let summary = SubagentTaskPresentation.nonEmpty(task.latestProgress) {
            return summary
        }
        return SubagentTaskPresentation.nonEmpty(task.error)
    }

    var body: some View {
        // TimelineView owns the 1Hz tick only while the task is running;
        // paused/terminal rows never attach a live timer subscription.
        Group {
            if task.state == .running {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    rowChrome(now: context.date)
                }
            } else {
                rowChrome(now: Date())
            }
        }
    }

    @ViewBuilder
    private func rowChrome(now currentNow: Date) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 9) {
                Button {
                    guard hasExpandableContent else { return }
                    withAnimation(Motion.structure) { isExpanded.toggle() }
                } label: {
                    HStack(alignment: .top, spacing: 9) {
                        SubagentTaskStatusIcon(task: task)
                            .frame(width: Self.iconColumn, height: 16)
                            .padding(.top, 1)

                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 7) {
                                Image(systemName: task.entityKind == .command ? "terminal" : "person.2")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .frame(width: Self.iconColumn)
                                Text(title)
                                    .font(.callout.weight(.medium))
                                    .lineLimit(2)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 8)
                                SubagentTaskDurationLabel(task: task)
                                if hasExpandableContent {
                                    Image(systemName: "chevron.right")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                                }
                            }

                            SubagentTaskIdentityBadge(
                                task: task, modelDisplayNames: modelDisplayNames)

                            SubagentTaskHealthTags(
                                task: task, now: currentNow)

                            if let subtitle = SubagentTaskPresentation.subtitle(for: task) {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                    .fixedSize(horizontal: false, vertical: true)
                                    // Subtitle → result swap on settle crossfades
                                    // under the card's ambient state animation.
                                    .contentTransition(
                                        Motion.reduceMotion ? .identity : .opacity)
                            }

                            // Always visible — stop failures must not require expand.
                            if let stopError = SubagentTaskPresentation.nonEmpty(stopError) {
                                Text(stopError)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!hasExpandableContent)

                if task.state == .running || task.state == .paused {
                    // Always present so hover never re-measures the live
                    // row; the reveal is opacity-only (messageActions in
                    // ChatTimelineRow uses the same pattern).
                    stopAgentButton
                        .opacity(isHovering ? 1 : 0)
                        .allowsHitTesting(isHovering)
                        .accessibilityHidden(!isHovering)
                }
            }

            if isExpanded && hasExpandableContent {
                expandedBody
                    .transition(Motion.unfold)
            }
        }
        .transcriptCard(
            fill: SubagentTaskPresentation.backgroundTint(for: task, stalled: false),
            showRail: true,
            railColor: SubagentTaskPresentation.railColor(for: task, stalled: false))
        .animation(Motion.ambient, value: task.state)
        .onChange(of: task.state) { _, _ in
            onClearStopError()
        }
        .onHover { isHovering = $0 }
        // The hover-revealed stop control above reserves its space and only
        // fades, so hovering never re-measures the row.
        .animation(Motion.feedback, value: isHovering)
        .contextMenu {
            if let result = resultText {
                Button("Copy result") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(result, forType: .string)
                }
            }
            if task.state == .running || task.state == .paused {
                Button("Stop agent", role: .destructive) {
                    onStopAgent()
                }
                Button("Stop turn…", role: .destructive) {
                    showStopTurnConfirm = true
                }
            }
        }
        .confirmationDialog(
            "Stop turn?",
            isPresented: $showStopTurnConfirm,
            titleVisibility: .visible
        ) {
            Button("Stop turn", role: .destructive) {
                onStopTurn()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Stopping interrupts the whole turn, including all running agents — not just this one."
            )
        }
    }

    @ViewBuilder
    private var stopAgentButton: some View {
        Button {
            onStopAgent()
        } label: {
            Image(systemName: "stop.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help("Stop agent")
        .accessibilityLabel("Stop agent")
    }

    @ViewBuilder
    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let lastTool = SubagentTaskPresentation.nonEmpty(task.lastToolName) {
                metaLine(label: "Last tool", value: lastTool)
            }
            if let usage = SubagentTaskPresentation.nonEmpty(task.usageSummary) {
                metaLine(label: "Usage", value: usage)
            }
            if !task.progressLog.isEmpty {
                progressLogBody
            }
            if let result = resultText {
                resultBlock(result)
            } else if let error = SubagentTaskPresentation.nonEmpty(task.error) {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.leading, 25)
        .padding(.top, 2)
    }

    private func metaLine(label: String, value: String) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .lineLimit(2)
        }
    }

    @ViewBuilder
    private var progressLogBody: some View {
        let log = task.progressLog
        let hidden = max(0, log.count - Self.maxVisibleLogEntries)
        let visible = Array(log.suffix(Self.maxVisibleLogEntries))
        VStack(alignment: .leading, spacing: 4) {
            if hidden > 0 {
                Text("… \(hidden) earlier update\(hidden == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            // One Text so drag-selection spans the whole visible log.
            Text(
                SubagentProgressLogText.attributedBody(
                    entries: visible,
                    startedAt: task.startedAt,
                    emphasizeLast: task.state == .running)
            )
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func resultBlock(_ result: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Result")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(result)
                .font(.caption)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            SubagentTaskPresentation.backgroundTint(for: task, stalled: false),
            in: RoundedRectangle(cornerRadius: TranscriptMetrics.nestedRadius))
        .padding(.top, 4)
    }

    private var title: String { SubagentTaskPresentation.title(for: task) }
}

/// Pure builder for the subagent progress log: one attributed string so the
/// whole tail can be drag-selected.
enum SubagentProgressLogText {
    static func attributedBody(
        entries: [SubagentTaskProgressEntry],
        startedAt: Date,
        emphasizeLast: Bool
    ) -> AttributedString {
        var result = AttributedString()
        for (index, entry) in entries.enumerated() {
            if index > 0 {
                result.append(AttributedString("\n"))
            }
            let emphasize = emphasizeLast && index == entries.count - 1
            result.append(attributedEntry(entry, startedAt: startedAt, emphasize: emphasize))
        }
        return result
    }

    private static func attributedEntry(
        _ entry: SubagentTaskProgressEntry,
        startedAt: Date,
        emphasize: Bool
    ) -> AttributedString {
        var line = AttributedString()

        var offset = AttributedString(relativeOffset(from: startedAt, to: entry.at))
        offset.font = .caption2.monospacedDigit()
        offset.foregroundColor = .secondary
        line.append(offset)

        if let tool = entry.toolName?.trimmingCharacters(in: .whitespacesAndNewlines),
            !tool.isEmpty
        {
            var toolRun = AttributedString("  \(tool)")
            toolRun.font = .caption2.weight(.medium)
            toolRun.foregroundColor = .secondary
            line.append(toolRun)
        }

        var body = AttributedString("  \(entry.text)")
        body.font = .caption
        body.foregroundColor = emphasize ? .primary : .secondary
        line.append(body)
        return line
    }

    private static func relativeOffset(from start: Date, to date: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(start)))
        let minutes = seconds / 60
        let rem = seconds % 60
        return String(format: "%d:%02d", minutes, rem)
    }
}
