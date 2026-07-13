import SwiftUI
import T3Kit

private enum TranscriptMetrics {
    static let cardRadius: CGFloat = 10
    static let cardPadH: CGFloat = 10
    static let cardPadV: CGFloat = 7
    static let nestedRadius: CGFloat = 6
    static let railWidth: CGFloat = 2.5
    static let iconColumn: CGFloat = 16
}

private struct TranscriptCardModifier: ViewModifier {
    let fill: AnyShapeStyle
    let showRail: Bool
    let railColor: Color

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, TranscriptMetrics.cardPadH)
            .padding(.vertical, TranscriptMetrics.cardPadV)
            .background(
                fill,
                in: RoundedRectangle(cornerRadius: TranscriptMetrics.cardRadius)
            )
            .overlay(
                RoundedRectangle(cornerRadius: TranscriptMetrics.cardRadius)
                    .strokeBorder(
                        Color(nsColor: .separatorColor).opacity(0.45),
                        lineWidth: 0.5)
            )
            .overlay(alignment: .leading) {
                if showRail {
                    Capsule()
                        .fill(railColor)
                        .frame(width: TranscriptMetrics.railWidth)
                        .padding(.vertical, 4)
                }
            }
    }
}

private extension View {
    func transcriptCard<S: ShapeStyle>(
        fill: S,
        showRail: Bool = false,
        railColor: Color = .accentColor
    ) -> some View {
        modifier(
            TranscriptCardModifier(
                fill: AnyShapeStyle(fill),
                showRail: showRail,
                railColor: railColor))
    }
}

// TranscriptPill lives in SubagentTaskComponents.swift — shared with the
// agents panel so both surfaces render identical capsule tags.

/// Dispatches a single `TimelineDisplayItem` to its row view.
struct ChatTimelineRowView: View {
    let item: TimelineDisplayItem
    let threadID: String
    let model: AppModel

    /// Project cwd for path shortening in tool rows; plain String? so child
    /// views never need AppModel.
    private var projectRoot: String? {
        guard let thread = model.threads.first(where: { $0.id == threadID }) else { return nil }
        return model.projects.first { $0.id == thread.projectID }?.path
    }

    var body: some View {
        switch item {
        case .single(let item):
            singleRow(item)
        case .toolGroup(_, let items, let summary):
            ToolGroupRow(
                items: items, summary: summary,
                threadStatus: model.selectedThread?.status,
                projectRoot: projectRoot)
        case .daySeparator(_, let label):
            SessionSeparatorRow(label: label)
        }
    }

    @ViewBuilder
    private func singleRow(_ item: TimelineItem) -> some View {
        switch item {
        case .userMessage(let id, let text, let at):
            UserMessageBubble(
                messageID: id, text: text, threadID: threadID, model: model, at: at)
        case .assistantMessage(let id, let markdown, let isStreaming, let at):
            AssistantMarkdownView(
                markdown: markdown, isStreaming: isStreaming, threadID: threadID,
                messageID: id, model: model, at: at, showsRoleChrome: true)
        case .toolEvent(_, let name, let detail, let kind, let status, let at, let output, let outputIsError):
            ToolEventRow(
                name: name, detail: detail, kind: kind, status: status,
                output: output, outputIsError: outputIsError,
                threadStatus: model.selectedThread?.status, at: at,
                projectRoot: projectRoot)
        case .subagentTask(let task):
            SubagentTaskRow(
                task: task,
                threadHealth: model.threads.first { $0.id == threadID }?.health,
                modelDisplayNames: model.modelDisplayNames,
                stopError: model.subagentStopErrors[task.taskId],
                onStopAgent: {
                    Task { await model.stopSubagentTask(taskId: task.taskId) }
                },
                onStopTurn: {
                    Task { await model.cancelCurrentTurn() }
                },
                onClearStopError: {
                    model.clearSubagentStopError(taskId: task.taskId)
                }
            )
        case .approval(let request):
            ApprovalCard(request: request) { approve in
                Task { await model.respond(to: request, approve: approve) }
            }
        case .userInput(let request):
            UserInputCard(request: request) { answers in
                Task { await model.respond(to: request, answers: answers) }
            }
        case .usageLimit(let notice):
            UsageLimitCard(
                notice: notice,
                state: model.usageLimitActions[notice.id] ?? .idle,
                switchModels: switchModels(for: notice)
            ) {
                model.waitForUsageLimitReset(notice)
            } onSwitch: { option in
                Task { await model.switchModelAfterUsageLimit(notice, to: option) }
            } onDismiss: {
                model.dismissUsageLimit(notice)
            }
        case .plan(let plan):
            PlanCard(plan: plan, model: model) {
                Task { await model.implementPlan(plan) }
            }
        case .checkpoint(let checkpoint):
            CheckpointRow(checkpoint: checkpoint, model: model)
        case .notice(_, let text, _):
            NoticeRow(text: text)
        case .reasoning(_, let text, _):
            ReasoningRow(text: text)
        case .sessionExit(_, let summary, let stderrTail, _):
            SessionExitRow(summary: summary, stderrTail: stderrTail)
        }
    }

    private func switchModels(for notice: UsageLimitNotice) -> [ModelOption] {
        let thread = model.threads.first { $0.id == notice.threadID }
        return UsageLimitModelOptions.options(
            available: model.models,
            currentInstanceID: thread?.modelInstanceID,
            currentModelID: thread?.modelID,
            exhaustedProvider: notice.provider)
    }
}

/// Right-aligned solid bubble for the user's own messages, with hover-revealed
/// overlay actions (copy / edit / retry). Edit stages the text in the composer
/// with the message identity so a subsequent send rewinds the thread and
/// replaces this turn; Retry does the same rewind then resends the text
/// verbatim.
private struct UserMessageBubble: View {
    let messageID: String
    let text: String
    let threadID: String
    let model: AppModel
    let at: Date?

    @UIState private var isHovering = false
    /// Local double-click guard: `canResend` flips only after the thread's
    /// status round-trips to `.running`, which is async.
    @UIState private var isResending = false
    @Environment(\.openSelectText) private var openSelectText

    /// Resending mid-turn would interleave with the running agent; the
    /// composer's send path has the same gate.
    private var canResend: Bool {
        model.connection == .ready && model.selectedThread?.status != .running && !isResending
    }

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 2) {
                AssistantMarkdownView(
                    markdown: text,
                    isStreaming: false,
                    threadID: threadID,
                    model: model,
                    style: .userBubble)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        LinearGradient(
                            colors: [Color.accentColor, Color.accentColor.opacity(0.92)],
                            startPoint: .top,
                            endPoint: .bottom),
                        in: RoundedRectangle(cornerRadius: 16))
                    .foregroundStyle(.white)
                    .overlay(alignment: .topTrailing) {
                        MessageActionChip {
                            CopyActionButton(text: text)
                            MessageActionButton(
                                systemImage: "pencil", help: "Edit in composer and resend",
                                disabled: !canResend
                            ) {
                                model.stageComposerText(text, editedMessageID: messageID)
                            }
                            MessageActionButton(
                                systemImage: "arrow.clockwise", help: "Send this message again",
                                disabled: !canResend
                            ) {
                                resend()
                            }
                        }
                        .opacity(isHovering ? 1 : 0)
                        .allowsHitTesting(isHovering)
                        .accessibilityHidden(!isHovering)
                        .padding(3)
                    }
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                    .contextMenu {
                        Button("Copy") { Pasteboard.copy(text) }
                        Button("Edit in Composer") {
                            model.stageComposerText(text, editedMessageID: messageID)
                        }
                        .disabled(!canResend)
                        Button("Retry") { resend() }
                            .disabled(!canResend)
                        if let openSelectText {
                            Divider()
                            Button("Select Text…") { openSelectText() }
                        }
                    }

                if let at, isHovering {
                    TranscriptTimestamp(date: at)
                        .transition(.opacity)
                }
            }
            // Hover and context menu live on the bubble cluster, not the full
            // row — the spacer's empty area shouldn't reveal actions.
            .onHover { isHovering = $0 }
            .animation(Motion.fade, value: isHovering)
        }
    }

    private func resend() {
        guard canResend else { return }
        isResending = true
        let threadID = model.selectedThreadID
        Task {
            await model.send(
                text: text,
                replacingMessageID: messageID,
                replacingMessageThreadID: threadID)
            isResending = false
        }
    }
}

/// A finished burst of tool work, condensed to one disclosure row once the
/// agent has moved on. Expanding reveals the original tool/reasoning rows.
private struct ToolGroupRow: View {
    let items: [TimelineItem]
    let summary: ToolGroupSummary
    let threadStatus: ThreadStatus?
    let projectRoot: String?

    @UIState private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                // Settle, not snap: expanding can reveal dozens of rows, and
                // the quick snap curve makes that layout shift feel violent.
                // Deferred one runloop turn: rapid clicks mid-animation can
                // land while the window is in a layout pass, and a state
                // change that re-vends toolbar items during an in-layout
                // render trips AppKit's layout-feedback-loop guard on
                // macOS 26/27 (crash in _postWindowNeedsUpdateConstraints).
                DispatchQueue.main.async {
                    withAnimation(Motion.settle) { isExpanded.toggle() }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: summary.failedCount > 0
                        ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(summary.failedCount > 0 ? Color.orange : Color.green)
                        .frame(width: TranscriptMetrics.iconColumn)
                    Text(headline)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(items) { item in
                        expandedRow(item)
                    }
                }
                .transition(Motion.unfold)
            }
        }
        .transcriptCard(fill: .quaternary.opacity(0.4))
    }

    private var headline: String {
        var parts = ["Ran \(summary.toolCount) tool\(summary.toolCount == 1 ? "" : "s")"]
        if summary.editedFileCount > 0 {
            parts.append("edited \(summary.editedFileCount) file\(summary.editedFileCount == 1 ? "" : "s")")
        }
        if summary.failedCount > 0 {
            parts.append("\(summary.failedCount) failed")
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func expandedRow(_ item: TimelineItem) -> some View {
        switch item {
        case .toolEvent(_, let name, let detail, let kind, let status, let at, let output, let outputIsError):
            ToolEventRow(
                name: name, detail: detail, kind: kind, status: status,
                output: output, outputIsError: outputIsError,
                threadStatus: threadStatus, at: at,
                projectRoot: projectRoot)
        case .reasoning(_, let text, _):
            ReasoningRow(text: text)
        default:
            // Grouping only ever collects tool/reasoning rows.
            EmptyView()
        }
    }
}

/// Compact, expandable row for a single tool invocation: status + kind
/// glyphs, tool title, an inline one-line preview of what ran (the command,
/// the file path), and a structured disclosure body — a diff for file
/// changes, a command line for shell runs, monospaced text otherwise, plus
/// tool output when the payload carried one.
private struct ToolEventRow: View {
    /// Visible line cap for expanded output; the tail is usually what matters.
    private static let maxVisibleOutputLines = 40

    let name: String
    let detail: String
    let kind: ToolEventKind
    let status: ToolEventStatus
    let output: String?
    let outputIsError: Bool
    let threadStatus: ThreadStatus?
    let at: Date?
    let projectRoot: String?

    @UIState private var isExpanded = false
    @UIState private var isHovering = false

    /// Memoized: SwiftUI rebuilds every visible row's view value on each
    /// timeline mutation, and re-running JSONSerialization per row per frame
    /// would tax long streaming timelines.
    private var parsed: ParsedToolDetail {
        ToolDetailParseCache.parsed(detail: detail, itemType: kind.wireItemType)
    }

    private enum DisplayState: Equatable {
        case running, succeeded, failed
        /// Thread stopped while the row was still "running": the tool is
        /// finished by definition, but its outcome was never reported (the
        /// turn may have completed, errored or been interrupted), so it gets
        /// a neutral done mark rather than claiming success or failure.
        case settled
    }

    /// Providers don't always close every tool's lifecycle (a completion can
    /// arrive uncorrelated, or not at all). Once the thread has settled, a
    /// row still marked running stops pulsing (mirrors the web client's
    /// turn-settled indicator rule).
    private var displayState: DisplayState {
        switch status {
        case .succeeded: return .succeeded
        case .failed: return .failed
        case .running:
            switch threadStatus {
            case .running, .waitingApproval, .backgroundWork, nil: return .running
            case .idle, .archived, .error: return .settled
            }
        }
    }

    private var hasExpandableContent: Bool {
        !detail.isEmpty || !(output?.isEmpty ?? true)
    }

    /// One-line preview text plus optional full path for the tooltip when a
    /// file path was shortened for display.
    private var preview: (text: String, fullPath: String?)? {
        switch parsed {
        case .command(let command):
            guard let first = command.split(separator: "\n", omittingEmptySubsequences: true).first
            else { return nil }
            let trimmed = first.trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? nil : (trimmed, nil)
        case .fileChange(let path, _):
            let trimmed = path.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return nil }
            let short = PathDisplay.short(trimmed, projectRoot: projectRoot)
            return (short, trimmed)
        case .plain(let text):
            guard let first = text.split(separator: "\n", omittingEmptySubsequences: true).first
            else { return nil }
            let trimmed = first.trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? nil : (trimmed, nil)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(Motion.snap) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    statusIcon
                        .frame(width: TranscriptMetrics.iconColumn)
                    Image(systemName: kind.symbolName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: TranscriptMetrics.iconColumn)
                    Text(name)
                        .font(.callout.weight(.medium))
                        .layoutPriority(1)
                    if let preview {
                        previewLabel(preview)
                    }
                    Spacer(minLength: 8)
                    if hasExpandableContent {
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                // Whole-row hit target: without this only the glyphs and text
                // are clickable and the disclosure feels dead.
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasExpandableContent)

            if isExpanded && hasExpandableContent {
                expandedBody
                    .transition(Motion.unfold)
            }
        }
        .transcriptCard(fill: cardFill)
        .overlay(alignment: .topTrailing) {
            if isHovering, let at {
                TranscriptTimestamp(date: at)
                    .padding(.top, 7)
                    .padding(.trailing, hasExpandableContent ? 24 : 10)
            }
        }
        .animation(Motion.ambient, value: displayState)
        .animation(Motion.fade, value: isHovering)
        .onHover { isHovering = $0 }
    }

    private var cardFill: AnyShapeStyle {
        switch displayState {
        case .failed:
            AnyShapeStyle(Color.red.opacity(0.06))
        case .running, .succeeded, .settled:
            AnyShapeStyle(.quaternary.opacity(0.4))
        }
    }

    @ViewBuilder
    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !detail.isEmpty {
                switch parsed {
                case .command(let command):
                    monospacedBody(command, foreground: .primary)
                case .fileChange(let path, let edits):
                    FileChangeDiffView(path: path, projectRoot: projectRoot, edits: edits)
                case .plain(let text):
                    monospacedBody(text, foreground: .secondary)
                }
            }
            if let output, !output.isEmpty {
                outputSection(output)
            }
        }
    }

    @ViewBuilder
    private func previewLabel(_ preview: (text: String, fullPath: String?)) -> some View {
        let label = Text(preview.text)
            .font(.system(
                .caption,
                design: kind == .command || kind == .fileChange ? .monospaced : .default))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        if let fullPath = preview.fullPath {
            label.help(fullPath)
        } else {
            label
        }
    }

    @ViewBuilder
    private func outputSection(_ text: String) -> some View {
        let visible = Self.visibleOutput(text)
        VStack(alignment: .leading, spacing: 4) {
            Text("Output")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let notice = visible.truncationNotice {
                Text(notice)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            monospacedBody(
                visible.text,
                foreground: (displayState == .failed || outputIsError)
                    ? Color.red.opacity(0.85) : .secondary)
        }
    }

    /// Keeps the last N lines — command output tails are usually the signal.
    private static func visibleOutput(_ text: String) -> (text: String, truncationNotice: String?) {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count > maxVisibleOutputLines else {
            return (text, nil)
        }
        let hidden = lines.count - maxVisibleOutputLines
        let tail = lines.suffix(maxVisibleOutputLines).joined(separator: "\n")
        return (
            tail,
            "… earlier output truncated (\(hidden) line\(hidden == 1 ? "" : "s"))"
        )
    }

    private func monospacedBody(_ text: String, foreground: Color) -> some View {
        Text(text)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(foreground)
            .textSelection(.enabled)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(nsColor: .textBackgroundColor),
                in: RoundedRectangle(cornerRadius: TranscriptMetrics.nestedRadius))
    }

    /// One `Image` whose name/tint swap rides `.contentTransition` — the
    /// running → done flip morphs instead of hard-swapping glyphs.
    @ViewBuilder
    private var statusIcon: some View {
        let icon = Image(systemName: iconName)
            .symbolEffect(
                .pulse,
                isActive: displayState == .running && !Motion.reduceMotion)
            .foregroundStyle(iconTint)
            .contentTransition(
                Motion.reduceMotion ? .identity : .symbolEffect(.replace))
        if Motion.reduceMotion {
            icon
        } else {
            icon.symbolEffect(.bounce, value: displayState)
        }
    }

    private var iconName: String {
        switch displayState {
        case .running: "circle.dotted"
        case .succeeded: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .settled: "checkmark.circle"
        }
    }

    private var iconTint: Color {
        switch displayState {
        case .running: .secondary
        case .succeeded: .green
        case .failed: .red
        case .settled: .secondary
        }
    }
}

private struct SubagentTaskRow: View {
    /// Expanded log shows the tail; older entries are summarized above.
    private static let maxVisibleLogEntries = 30

    let task: SubagentTaskItem
    /// Server liveness for the owning thread; wins over the client heuristic.
    var threadHealth: ThreadHealth?
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
        !task.progressLog.isEmpty
            || task.error != nil
            || stopError != nil
            || task.lastToolName != nil
            || task.usageSummary != nil
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
        let stalled = SubagentTaskPresentation.isStalled(
            task: task, at: currentNow, threadHealth: threadHealth)
        VStack(alignment: .leading, spacing: 4) {
            Button {
                guard hasExpandableContent else { return }
                withAnimation(Motion.snap) { isExpanded.toggle() }
            } label: {
                HStack(alignment: .top, spacing: 9) {
                    statusIcon(stalled: stalled)
                        .frame(width: TranscriptMetrics.iconColumn, height: 16)
                        .padding(.top, 1)

                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            Image(systemName: "person.2")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(width: TranscriptMetrics.iconColumn)
                            Text(title)
                                .font(.callout.weight(.medium))
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 8)
                            if task.state == .running || task.state == .paused, isHovering {
                                stopAgentButton
                            }
                            durationLabel
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
                            task: task, now: currentNow, threadHealth: threadHealth)

                        if let subtitle = SubagentTaskPresentation.subtitle(for: task) {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
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

            if isExpanded && hasExpandableContent {
                expandedBody
                    .transition(Motion.unfold)
            }
        }
        .transcriptCard(
            fill: SubagentTaskPresentation.backgroundTint(for: task, stalled: stalled),
            showRail: true,
            railColor: SubagentTaskPresentation.railColor(for: task, stalled: stalled))
        .animation(Motion.ambient, value: task.state)
        .onChange(of: task.state) { _, _ in
            onClearStopError()
        }
        .onHover { isHovering = $0 }
        .contextMenu {
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
    private var durationLabel: some View {
        SubagentTaskDurationLabel(task: task)
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
            if let error = SubagentTaskPresentation.nonEmpty(task.error) {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !task.progressLog.isEmpty {
                progressLogBody
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

    private var title: String { SubagentTaskPresentation.title(for: task) }

    @ViewBuilder
    private func statusIcon(stalled: Bool) -> some View {
        SubagentTaskStatusIcon(task: task, stalled: stalled)
    }
}

extension ToolEventKind {
    fileprivate var symbolName: String {
        switch self {
        case .command: "terminal"
        case .fileChange: "square.and.pencil"
        case .fileRead: "eye"
        case .webSearch: "globe"
        case .mcpCall: "wrench.adjustable"
        case .subagent: "person.2"
        case .imageView: "photo"
        case .other: "hammer"
        }
    }

    /// Round-trip back to the wire item type for `ParsedToolDetail`'s hint.
    fileprivate var wireItemType: String? {
        switch self {
        case .command: "command_execution"
        case .fileChange: "file_change"
        case .fileRead: "file_read"
        case .webSearch: "web_search"
        case .mcpCall: "mcp_tool_call"
        case .subagent: "collab_agent_tool_call"
        case .imageView: "image_view"
        case .other: nil
        }
    }
}

/// Inline diff body for a file-change tool row: file path header with +/-
/// counts, then the edit's old lines (red) and new lines (green). Long diffs
/// are capped — the Diff inspector remains the full view.
private struct FileChangeDiffView: View {
    let path: String
    let projectRoot: String?
    let edits: [ToolFileEdit]

    private static let maxLines = 60

    private struct Line: Identifiable {
        enum Kind { case removed, added, separator }
        let id: Int
        let kind: Kind
        let text: String

        var textLine: (kind: FileChangeDiffText.Kind, text: String) {
            switch kind {
            case .removed: (.removed, text)
            case .added: (.added, text)
            case .separator: (.separator, text)
            }
        }
    }

    private var displayPath: String {
        PathDisplay.short(path, projectRoot: projectRoot)
    }

    private var lines: [Line] {
        var result: [Line] = []
        var id = 0
        func push(_ kind: Line.Kind, _ text: String) {
            result.append(Line(id: id, kind: kind, text: text))
            id += 1
        }
        for (index, edit) in edits.enumerated() {
            if index > 0 { push(.separator, "···") }
            if !edit.oldText.isEmpty {
                for line in edit.oldText.split(separator: "\n", omittingEmptySubsequences: false) {
                    push(.removed, String(line))
                }
            }
            if !edit.newText.isEmpty {
                for line in edit.newText.split(separator: "\n", omittingEmptySubsequences: false) {
                    push(.added, String(line))
                }
            }
        }
        return result
    }

    var body: some View {
        let all = lines
        let visible = Array(all.prefix(Self.maxLines))
        let hidden = all.count - visible.count
        let additions = all.filter { $0.kind == .added }.count
        let deletions = all.filter { $0.kind == .removed }.count

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(displayPath)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(path)
                Spacer(minLength: 4)
                if additions > 0 {
                    Text("+\(additions)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.green)
                }
                if deletions > 0 {
                    Text("-\(deletions)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.red)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.secondary.opacity(0.12))

            // One Text so drag-selection spans every visible line (SwiftUI
            // selection is scoped per Text view). Line tints ride attribute
            // runs rather than full-width row backgrounds.
            Text(FileChangeDiffText.attributedBody(visible.map(\.textLine)))
                .textSelection(.enabled)
                .font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)

            if hidden > 0 {
                Text("… \(hidden) more line\(hidden == 1 ? "" : "s")")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: TranscriptMetrics.nestedRadius))
        .overlay(
            RoundedRectangle(cornerRadius: TranscriptMetrics.nestedRadius)
                .strokeBorder(.separator, lineWidth: 1))
    }
}

/// Pure attributed-string builder for inline file-change diffs. Kept free of
/// SwiftUI view state so selection can be unit-tested without a host window.
enum FileChangeDiffText {
    enum Kind { case removed, added, separator }

    static func attributedBody(_ lines: [(kind: Kind, text: String)]) -> AttributedString {
        var result = AttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 {
                result.append(AttributedString("\n"))
            }
            result.append(attributedLine(line.kind, text: line.text))
        }
        return result
    }

    private static func attributedLine(_ kind: Kind, text: String) -> AttributedString {
        switch kind {
        case .separator:
            var piece = AttributedString(text)
            piece.font = .system(.caption, design: .monospaced)
            piece.foregroundColor = Color.secondary.opacity(0.55)
            return piece
        case .removed:
            var piece = AttributedString("- " + text)
            piece.font = .system(.caption, design: .monospaced)
            piece.backgroundColor = Color.red.opacity(0.12)
            return piece
        case .added:
            var piece = AttributedString("+ " + text)
            piece.font = .system(.caption, design: .monospaced)
            piece.backgroundColor = Color.green.opacity(0.12)
            return piece
        }
    }
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

/// Quiet transcript marker for a calendar-day or long same-day pause.
private struct SessionSeparatorRow: View {
    let label: String

    var body: some View {
        HStack(spacing: 10) {
            Rectangle()
                .fill(.separator)
                .frame(maxWidth: .infinity)
                .frame(height: 1)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .layoutPriority(1)
            Rectangle()
                .fill(.separator)
                .frame(maxWidth: .infinity)
                .frame(height: 1)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// Subtle divider row marking a restorable checkpoint.
private struct CheckpointRow: View {
    let checkpoint: Checkpoint
    let model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            VStack { Divider() }
            Label(checkpoint.label, systemImage: "clock.arrow.circlepath")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .layoutPriority(1)
            Button("Restore") {
                Task { await model.restoreCheckpoint(checkpoint) }
            }
            .font(.caption)
            .buttonStyle(.plain)
            .foregroundStyle(.tint)
            VStack { Divider() }
        }
        .padding(.vertical, 4)
    }
}

/// The agent's current thought: dimmed italic line whose text is replaced in
/// place as task progress streams (the row id is stable per task), so one
/// row narrates the work instead of a stack of stale updates.
private struct ReasoningRow: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "sparkles")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(width: TranscriptMetrics.iconColumn)
            Text(text)
                .font(.callout)
                .italic()
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .contentTransition(.opacity)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, TranscriptMetrics.cardPadH)
        .animation(Motion.ambient, value: text)
    }
}

/// Centered secondary-text system notice.
private struct NoticeRow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, alignment: .center)
    }
}

/// Error-styled row for a provider process that died leaving stderr. The tail
/// is hidden behind a collapsed "Show process output" disclosure and rendered
/// monospaced, scrollable, and copyable when expanded (`session.exited`).
private struct SessionExitRow: View {
    let summary: String
    let stderrTail: String

    @UIState private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                // Deferred one runloop turn — see ToolGroupRow: a state change
                // that re-vends toolbar items mid-layout trips AppKit's
                // layout-feedback guard on macOS 26/27.
                DispatchQueue.main.async {
                    withAnimation(Motion.settle) { isExpanded.toggle() }
                }
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.octagon.fill")
                        .foregroundStyle(.red)
                        .frame(width: TranscriptMetrics.iconColumn)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(summary)
                            .font(.callout)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(isExpanded ? "Hide process output" : "Show process output")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                stderrDisclosure
                    .transition(Motion.unfold)
            }
        }
        .transcriptCard(fill: Color.red.opacity(0.08), showRail: true, railColor: .red)
    }

    private var stderrDisclosure: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Process output")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                CopyActionButton(text: stderrTail)
            }
            ScrollView {
                Text(stderrTail)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 220)
            .background(
                Color.primary.opacity(0.06),
                in: RoundedRectangle(cornerRadius: 8))
        }
    }
}
