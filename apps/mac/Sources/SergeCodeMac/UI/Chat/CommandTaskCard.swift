import AppKit
import SwiftUI

/// Presentation rules for a shell command's transcript row.
///
/// A command is not delegated work, so it deliberately shares nothing with the
/// sub-agent card beyond card geometry: no model/effort identity badge, no
/// "Working…" agent chatter, no person glyph. What matters is the shell
/// language — what is running, how long it has been running, and the tail of
/// what it printed.
///
/// Backgrounded-ness is a property of the task, not of the card: every label
/// here reads `task.isBackgrounded` rather than assuming it, so a command row
/// that reaches the transcript without the detach flag (an older snapshot, a
/// provider that never sends one) is not mislabelled as detached.
enum CommandTaskPresentation {
    /// Visible tail of the streamed output while collapsed.
    static let collapsedOutputLines = 6
    /// Visible tail once expanded; background jobs can print a lot.
    static let expandedOutputLines = 40

    static func title(for task: SubagentTaskItem) -> String {
        SubagentTaskPresentation.nonEmpty(task.description)
            ?? (task.isBackgrounded ? "Background command" : "Command")
    }

    /// Streamed process output, oldest first.
    ///
    /// The provider slices the output file by size, not by line, so the chunks
    /// concatenate — a separator here would invent a line break wherever a
    /// slice landed mid-line, in the visible tail and in Copy output alike.
    static func output(for task: SubagentTaskItem) -> String? {
        let chunks = task.progressLog.compactMap { SubagentTaskPresentation.nonEmpty($0.text) }
        guard !chunks.isEmpty else { return nil }
        return chunks.joined()
    }

    /// Keeps the last `limit` lines — a running job's tail is the signal —
    /// plus a count of what was dropped.
    static func outputTail(_ text: String, limit: Int) -> (text: String, hiddenLines: Int) {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count > limit else { return (text, 0) }
        return (lines.suffix(limit).joined(separator: "\n"), lines.count - limit)
    }

    /// One-line state summary under the title. Running rows say how long the
    /// job has been quiet rather than pretending to narrate it, and only claim
    /// "in background" when the task actually detached.
    static func statusLine(for task: SubagentTaskItem, at now: Date) -> String {
        switch task.state {
        case .running:
            let lead = task.isBackgrounded ? "Running in background" : "Running"
            return "\(lead) · \(SubagentTaskPresentation.lastActivityLabel(task: task, at: now))"
        case .paused:
            return "Paused"
        case .completed:
            return "Finished"
        case .failed:
            // The failure text itself is rendered in full under the header;
            // repeating it here would truncate it to one line.
            return "Failed"
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

/// Transcript row for a command task — in practice, one the agent detached
/// with `run_in_background`.
///
/// A foreground command normally never reaches this view: its tool row already
/// tells the whole story, so `T3SubagentTaskItem.producesTimelineRow` drops the
/// task row entirely. A backgrounded command is different — its tool row
/// settles the instant the process detaches, so this card is the only place
/// its lifetime and streamed output are visible. Should a command row arrive
/// without the detach flag anyway, it still renders as shell work (never as a
/// sub-agent), just without the background labelling it hasn't earned.
@MainActor
struct CommandTaskCard: View {
    let task: SubagentTaskItem
    /// Transient stop-RPC failure (not part of the provider task payload).
    let stopError: String?
    let onStop: () -> Void
    let onClearStopError: () -> Void

    @UIState private var isExpanded = false
    @UIState private var isHovering = false

    private var output: String? { CommandTaskPresentation.output(for: task) }

    /// Only streamed output is hidden behind the disclosure — the error and
    /// stop-failure texts are always on the card, so counting them here would
    /// offer a chevron that expands nothing.
    private var hasExpandableContent: Bool {
        output != nil
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

            // Failure text in full: a command's error is often several lines
            // of shell output, and the status line above it is one line.
            if let error = SubagentTaskPresentation.nonEmpty(task.error) {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, TranscriptMetrics.iconColumn + 10)
            }

            if let stopError = SubagentTaskPresentation.nonEmpty(stopError) {
                Text(stopError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, TranscriptMetrics.iconColumn + 10)
            }

            if let output {
                outputBlock(output)
            }
        }
        .transcriptCard(
            fill: CommandTaskPresentation.tint(for: task).opacity(0.08),
            showRail: true,
            railColor: CommandTaskPresentation.tint(for: task))
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
                    Text(CommandTaskPresentation.title(for: task))
                        .font(SurgeTypography.toolTitle)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if task.isBackgrounded {
                        TranscriptPill(
                            "background",
                            tint: AlpineTheme.sky,
                            fill: AnyShapeStyle(AlpineTheme.sky.opacity(0.14)))
                    }
                    Spacer(minLength: 8)
                    SubagentTaskDurationLabel(task: task)
                    if hasExpandableContent {
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                Text(CommandTaskPresentation.statusLine(for: task, at: now))
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
        let tail = CommandTaskPresentation.outputTail(
            output,
            limit: isExpanded
                ? CommandTaskPresentation.expandedOutputLines
                : CommandTaskPresentation.collapsedOutputLines)
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
