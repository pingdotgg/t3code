import AppKit
import SwiftUI

/// Presentation rules for a backgrounded shell command's transcript row.
///
/// A background command is not delegated work, so it deliberately shares
/// nothing with the sub-agent card beyond card geometry: no model/effort
/// identity badge, no "Working…" agent chatter, no person glyph. What matters
/// is the shell language — what is running, how long it has been running, and
/// the tail of what it printed.
enum BackgroundCommandPresentation {
    /// Visible tail of the streamed output while collapsed.
    static let collapsedOutputLines = 6
    /// Visible tail once expanded; background jobs can print a lot.
    static let expandedOutputLines = 40

    static func title(for task: SubagentTaskItem) -> String {
        SubagentTaskPresentation.nonEmpty(task.description) ?? "Background command"
    }

    /// Streamed process output, oldest first. The provider slices the output
    /// file into progress chunks, so the log entries concatenate back into the
    /// process's own text.
    static func output(for task: SubagentTaskItem) -> String? {
        let chunks = task.progressLog.compactMap { SubagentTaskPresentation.nonEmpty($0.text) }
        guard !chunks.isEmpty else { return nil }
        return chunks.joined(separator: "\n")
    }

    /// Keeps the last `limit` lines — a running job's tail is the signal —
    /// plus a count of what was dropped.
    static func outputTail(_ text: String, limit: Int) -> (text: String, hiddenLines: Int) {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count > limit else { return (text, 0) }
        return (lines.suffix(limit).joined(separator: "\n"), lines.count - limit)
    }

    /// One-line state summary under the title. Running rows say how long the
    /// job has been quiet rather than pretending to narrate it.
    static func statusLine(for task: SubagentTaskItem, at now: Date) -> String {
        switch task.state {
        case .running:
            return "Running in background · \(SubagentTaskPresentation.lastActivityLabel(task: task, at: now))"
        case .paused:
            return "Paused"
        case .completed:
            return "Finished"
        case .failed:
            return SubagentTaskPresentation.nonEmpty(task.error) ?? "Failed"
        case .stopped:
            return "Stopped"
        }
    }

    static func tint(for task: SubagentTaskItem) -> Color {
        switch task.state {
        case .running, .paused: AlpineTheme.sky
        case .completed: AlpineTheme.meadow
        case .failed: .red
        case .stopped: .secondary
        }
    }
}

/// Transcript row for a command the agent detached with `run_in_background`.
///
/// Foreground commands never reach this view: their tool row already tells the
/// whole story, and a second card would duplicate it. A backgrounded command
/// is different — its tool row settles the instant the process is detached, so
/// this card is the only place its lifetime and streamed output are visible.
@MainActor
struct BackgroundCommandCard: View {
    let task: SubagentTaskItem
    /// Transient stop-RPC failure (not part of the provider task payload).
    let stopError: String?
    let onStop: () -> Void
    let onClearStopError: () -> Void

    @UIState private var isExpanded = false
    @UIState private var isHovering = false

    private var output: String? { BackgroundCommandPresentation.output(for: task) }

    private var hasExpandableContent: Bool {
        output != nil || SubagentTaskPresentation.nonEmpty(task.error) != nil
    }

    var body: some View {
        // The 1Hz tick only runs while the process does; a finished job's row
        // never attaches a timer.
        Group {
            if task.state == .running {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    card(now: context.date)
                }
            } else {
                card(now: Date())
            }
        }
    }

    @ViewBuilder
    private func card(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                Button {
                    guard hasExpandableContent else { return }
                    withDeferredDisclosureAnimation { isExpanded.toggle() }
                } label: {
                    header(now: now)
                }
                .buttonStyle(.plain)
                .disabled(!hasExpandableContent)

                if task.state == .running || task.state == .paused {
                    // Always present so hover never re-measures the live row.
                    stopButton
                        .opacity(isHovering ? 1 : 0)
                        .allowsHitTesting(isHovering)
                        .accessibilityHidden(!isHovering)
                }
            }

            if let stopError = SubagentTaskPresentation.nonEmpty(stopError) {
                Text(stopError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let output {
                outputBlock(output)
            }
        }
        .transcriptCard(
            fill: BackgroundCommandPresentation.tint(for: task).opacity(0.08),
            showRail: true,
            railColor: BackgroundCommandPresentation.tint(for: task))
        .shimmerBorder(
            color: AlpineTheme.sky,
            isActive: task.state == .running,
            cornerRadius: TranscriptMetrics.cardRadius)
        .animation(Motion.ambient, value: task.state)
        .animation(Motion.feedback, value: isHovering)
        .onChange(of: task.state) { _, _ in onClearStopError() }
        .onHover { isHovering = $0 }
        .contextMenu {
            if let output {
                Button("Copy output") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(output, forType: .string)
                }
            }
            if task.state == .running || task.state == .paused {
                Button("Stop command", role: .destructive, action: onStop)
            }
        }
    }

    @ViewBuilder
    private func header(now: Date) -> some View {
        HStack(alignment: .top, spacing: 10) {
            ActivityIconChip(style: ToolEventKind.command.activityStyle)
                .pulseGlow(isActive: task.state == .running)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(BackgroundCommandPresentation.title(for: task))
                        .font(SurgeTypography.toolTitle)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    TranscriptPill(
                        "background",
                        tint: AlpineTheme.sky,
                        fill: AnyShapeStyle(AlpineTheme.sky.opacity(0.14)))
                    Spacer(minLength: 8)
                    SubagentTaskDurationLabel(task: task)
                    if hasExpandableContent {
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                Text(BackgroundCommandPresentation.statusLine(for: task, at: now))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var stopButton: some View {
        Button(action: onStop) {
            Image(systemName: "stop.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help("Stop command")
        .accessibilityLabel("Stop command")
    }

    @ViewBuilder
    private func outputBlock(_ output: String) -> some View {
        let tail = BackgroundCommandPresentation.outputTail(
            output,
            limit: isExpanded
                ? BackgroundCommandPresentation.expandedOutputLines
                : BackgroundCommandPresentation.collapsedOutputLines)
        VStack(alignment: .leading, spacing: 4) {
            if tail.hiddenLines > 0 {
                Text("… \(tail.hiddenLines) earlier line\(tail.hiddenLines == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Text(tail.text)
                .font(SurgeTypography.toolPayload)
                .foregroundStyle(task.state == .failed ? Color.red.opacity(0.85) : .secondary)
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    Color(nsColor: .textBackgroundColor),
                    in: RoundedRectangle(cornerRadius: TranscriptMetrics.nestedRadius))
        }
        .padding(.leading, TranscriptMetrics.iconColumn + 10)
    }
}
