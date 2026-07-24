import AppKit
import SwiftUI

/// Pure presentation rules for the nested subagent pane ("inner thread"): the
/// drill-down the chat pane pushes when a subagent row is opened. Text lives
/// here (not in the view) so navigation, result promotion, and steering copy
/// are unit-testable without a host window.
enum SubagentInnerThread {
    /// The agent's result once it settles: the completion summary the fold
    /// stores in `latestProgress`, falling back to the failure text. Running
    /// agents have no result yet.
    static func resultText(for task: SubagentTaskItem) -> String? {
        guard task.state != .running, task.state != .paused else { return nil }
        if let summary = SubagentTaskPresentation.nonEmpty(task.latestProgress) {
            return summary
        }
        return SubagentTaskPresentation.nonEmpty(task.error)
    }

    /// Result promotion: the agent's result quoted into the parent composer so
    /// the next turn can act on it. Nil while the agent is still working.
    static func promotionText(
        for task: SubagentTaskItem, modelDisplayNames: [String: String]
    ) -> String? {
        guard let result = resultText(for: task) else { return nil }
        let quoted = result
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.isEmpty ? ">" : "> \($0)" }
            .joined(separator: "\n")
        return "Result from the \(quotedTitle(for: task)) agent\(attribution(for: task, modelDisplayNames: modelDisplayNames)):\n\n\(quoted)\n"
    }

    /// Steering prefix. A running Task subagent has no inbound channel of its
    /// own — the SDK only accepts a message for the turn that owns it — so
    /// steering is a message to the parent turn that names the agent, which
    /// the provider delivers as a steer while the turn is still running.
    static func steerPrefill(for task: SubagentTaskItem) -> String {
        "Steer the \(quotedTitle(for: task)) agent (task \(task.taskId)): "
    }

    /// Header state line: "Running · 2m 5s", "Completed · 41s".
    static func stateLine(for task: SubagentTaskItem, at now: Date) -> String {
        var parts: [String] = [stateWord(for: task)]
        if let duration = task.duration {
            parts.append(SubagentTaskPresentation.durationText(duration))
        } else if task.state == .running || task.state == .paused {
            parts.append(
                SubagentTaskPresentation.durationText(now.timeIntervalSince(task.startedAt)))
        }
        return parts.joined(separator: " · ")
    }

    static func stateWord(for task: SubagentTaskItem) -> String {
        switch task.state {
        case .running: "Running"
        case .paused: "Paused"
        case .completed: "Completed"
        case .failed: "Failed"
        case .stopped: "Stopped"
        }
    }

    static func isStoppable(_ task: SubagentTaskItem) -> Bool {
        task.state == .running || task.state == .paused
    }

    /// The tail is followed only while there is more work to stream.
    static func followsTail(_ task: SubagentTaskItem) -> Bool {
        task.state == .running
    }

    private static func quotedTitle(for task: SubagentTaskItem) -> String {
        "“\(SubagentTaskPresentation.title(for: task))”"
    }

    /// " (Explore · Sonnet 5, 2m 5s)" — omitted entirely when nothing is known.
    private static func attribution(
        for task: SubagentTaskItem, modelDisplayNames: [String: String]
    ) -> String {
        var parts: [String] = []
        if let badge = SubagentTaskPresentation.identityBadge(
            for: task, modelDisplayNames: modelDisplayNames)
        {
            parts.append(badge)
        }
        if let duration = task.duration {
            parts.append(SubagentTaskPresentation.durationText(duration))
        }
        return parts.isEmpty ? "" : " (\(parts.joined(separator: ", ")))"
    }
}

/// The nested inner thread: a subagent's own transcript, opened in place of the
/// parent chat pane. Progress entries read as the agent's turn-by-turn work;
/// the footer carries the controls that only make sense here (stop, steer the
/// parent turn about this agent, promote the result into the parent composer).
@MainActor
struct SubagentInnerThreadView: View {
    let model: AppModel
    let threadID: String
    let task: SubagentTaskItem
    let parentTitle: String

    /// Follow the tail while the agent streams; a manual toggle so a user
    /// reading older progress is never yanked back down.
    @UIState private var isFollowingTail = true
    @UIState private var scrollPhase: ScrollPhase = .idle

    private static let tailAnchor = "subagent-inner-thread-tail"

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            transcript
            Divider()
            footer
        }
        .background(.background)
        .onExitCommand { model.closeSubagent() }
        .onChange(of: task.taskId) { _, _ in
            isFollowingTail = true
        }
        .onChange(of: task.state) { _, _ in
            model.clearSubagentStopError(taskId: task.taskId)
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button {
                    model.closeSubagent()
                } label: {
                    Label(parentTitle, systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                        .font(.callout)
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
                .help("Back to \(parentTitle)")
                .accessibilityLabel("Back to \(parentTitle)")

                Spacer(minLength: 12)

                if SubagentInnerThread.isStoppable(task) {
                    Button(role: .destructive) {
                        Task { await model.stopSubagentTask(taskId: task.taskId, threadID: threadID) }
                    } label: {
                        Label("Stop agent", systemImage: "stop.circle")
                    }
                    .help("Stop this agent (the parent turn keeps running)")
                }
            }

            HStack(alignment: .top, spacing: 9) {
                SubagentTaskStatusIcon(task: task)
                    .frame(width: TranscriptMetrics.iconColumn, height: 16)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 5) {
                    Text(SubagentTaskPresentation.title(for: task))
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        SubagentTaskIdentityBadge(
                            task: task, modelDisplayNames: model.modelDisplayNames)
                        // Only an unsettled agent needs a live clock; settled
                        // rows must not hold a 1Hz timer subscription open.
                        if task.duration == nil {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                stateLine(at: context.date)
                            }
                        } else {
                            stateLine(at: task.startedAt)
                        }
                    }
                    SubagentTaskHealthTags(task: task, now: Date())
                }
            }

            if let stopError = SubagentTaskPresentation.nonEmpty(
                model.subagentStopErrors[task.taskId])
            {
                Text(stopError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func stateLine(at now: Date) -> some View {
        Text(SubagentInnerThread.stateLine(for: task, at: now))
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
    }

    // MARK: - Transcript

    @ViewBuilder
    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if task.progressLog.isEmpty {
                        Text(
                            task.state == .running
                                ? "No progress reported yet."
                                : "This agent reported no progress updates.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .padding(.top, 8)
                    }
                    ForEach(Array(task.progressLog.enumerated()), id: \.offset) { index, entry in
                        SubagentProgressEntryRow(
                            entry: entry,
                            startedAt: task.startedAt,
                            isLatest: index == task.progressLog.count - 1
                                && task.state == .running)
                            // Subagent progress lines are agent-driven output —
                            // exactly the "agent logs" case SER-144 calls out.
                            .entrance(.row, index: index)
                    }
                    if let result = SubagentInnerThread.resultText(for: task) {
                        resultCard(result)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.tailAnchor)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // Same pin rule as ChatTimelineScrollView: only user-driven
            // phases may change follow state. Content growth alone must not
            // re-pin someone reading older progress.
            .onScrollPhaseChange { _, newPhase in
                scrollPhase = newPhase
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                ChatTimelineScrollPolicy.isNearBottom(
                    contentOffsetY: geometry.contentOffset.y,
                    containerHeight: geometry.containerSize.height,
                    contentHeight: geometry.contentSize.height)
            } action: { _, nearBottom in
                isFollowingTail = ChatTimelineScrollPolicy.pinAfterScrollPhase(
                    isUserScrolling: isUserScrolling,
                    isNearBottom: nearBottom,
                    currentlyPinned: isFollowingTail)
            }
            .onChange(of: task.progressLog.count) { _, _ in
                guard isFollowingTail, SubagentInnerThread.followsTail(task) else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
                }
            }
            .onChange(of: task.state) { _, _ in
                // Settling lands the result card: keep the tail in view for it.
                guard isFollowingTail else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
                }
            }
            .onAppear {
                proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
            }
        }
    }

    private var isUserScrolling: Bool {
        switch scrollPhase {
        case .tracking, .interacting, .decelerating: true
        default: false
        }
    }

    @ViewBuilder
    private func resultCard(_ result: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Result")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(result)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            SubagentTaskPresentation.backgroundTint(for: task, stalled: false),
            in: RoundedRectangle(cornerRadius: TranscriptMetrics.nestedRadius))
        .padding(.top, 6)
    }

    // MARK: - Footer

    @ViewBuilder
    private var footer: some View {
        HStack(spacing: 10) {
            if SubagentInnerThread.followsTail(task) {
                Toggle(isOn: $isFollowingTail) {
                    Label("Follow", systemImage: "arrow.down.to.line")
                }
                .toggleStyle(.button)
                .help("Keep the newest progress in view")
            }

            Spacer(minLength: 8)

            if SubagentInnerThread.isStoppable(task) {
                Button {
                    model.stageComposerTextAppending(SubagentInnerThread.steerPrefill(for: task))
                    model.closeSubagent()
                } label: {
                    Label("Steer…", systemImage: "arrow.triangle.turn.up.right.diamond")
                }
                .help(
                    "Draft a message to the parent turn about this agent — a running agent has no inbox of its own"
                )
            }

            if let result = SubagentInnerThread.resultText(for: task) {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(result, forType: .string)
                } label: {
                    Label("Copy result", systemImage: "doc.on.doc")
                }
                .help("Copy this agent's result")

                Button {
                    guard
                        let promotion = SubagentInnerThread.promotionText(
                            for: task, modelDisplayNames: model.modelDisplayNames)
                    else { return }
                    model.stageComposerTextAppending(promotion)
                    model.closeSubagent()
                } label: {
                    Label("Promote result", systemImage: "arrow.up.doc")
                }
                .buttonStyle(.borderedProminent)
                .help("Quote this agent's result into the composer")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

/// One progress update in the inner thread: elapsed offset, the tool that
/// produced it, and the agent's own summary line.
@MainActor
private struct SubagentProgressEntryRow: View {
    let entry: SubagentTaskProgressEntry
    let startedAt: Date
    let isLatest: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(offsetText)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 44, alignment: .trailing)
            VStack(alignment: .leading, spacing: 3) {
                if let tool = SubagentTaskPresentation.nonEmpty(entry.toolName) {
                    TranscriptPill(tool, tint: .secondary, fill: AnyShapeStyle(.quaternary))
                }
                Text(entry.text)
                    .font(.callout)
                    .foregroundStyle(isLatest ? .primary : .secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    private var offsetText: String {
        let seconds = max(0, Int(entry.at.timeIntervalSince(startedAt)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
