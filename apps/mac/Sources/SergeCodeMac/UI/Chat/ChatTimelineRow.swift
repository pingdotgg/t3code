import SwiftUI
import T3Kit

/// Dispatches a single `TimelineDisplayItem` to its row view.
struct ChatTimelineRowView: View {
    let item: TimelineDisplayItem
    let threadID: String
    let model: AppModel

    var body: some View {
        switch item {
        case .single(let item):
            singleRow(item)
        case .toolGroup(_, let items, let summary):
            ToolGroupRow(items: items, summary: summary, threadStatus: model.selectedThread?.status)
        }
    }

    @ViewBuilder
    private func singleRow(_ item: TimelineItem) -> some View {
        switch item {
        case .userMessage(let id, let text, _):
            UserMessageBubble(messageID: id, text: text, model: model)
        case .assistantMessage(_, let markdown, let isStreaming, _):
            AssistantMarkdownView(
                markdown: markdown, isStreaming: isStreaming, threadID: threadID, model: model)
        case .toolEvent(_, let name, let detail, let kind, let status, _, let output, let outputIsError):
            ToolEventRow(
                name: name, detail: detail, kind: kind, status: status,
                output: output, outputIsError: outputIsError,
                threadStatus: model.selectedThread?.status)
        case .subagentTask(let task):
            SubagentTaskRow(
                task: task,
                onStopAgent: {
                    Task { await model.stopSubagentTask(taskId: task.taskId) }
                },
                onStopTurn: {
                    Task { await model.cancelCurrentTurn() }
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
    let model: AppModel

    @UIState private var isHovering = false
    /// Local double-click guard: `canResend` flips only after the thread's
    /// status round-trips to `.running`, which is async.
    @UIState private var isResending = false

    /// Resending mid-turn would interleave with the running agent; the
    /// composer's send path has the same gate.
    private var canResend: Bool {
        model.connection == .ready && model.selectedThread?.status != .running && !isResending
    }

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 16))
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
                // Hover and context menu live on the bubble, not the full
                // row — the spacer's empty area shouldn't reveal actions.
                .onHover { isHovering = $0 }
                .animation(Motion.fade, value: isHovering)
                .contextMenu {
                    Button("Copy") { Pasteboard.copy(text) }
                    Button("Edit in Composer") {
                        model.stageComposerText(text, editedMessageID: messageID)
                    }
                    .disabled(!canResend)
                    Button("Retry") { resend() }
                        .disabled(!canResend)
                }
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
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
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
        case .toolEvent(_, let name, let detail, let kind, let status, _, let output, let outputIsError):
            ToolEventRow(
                name: name, detail: detail, kind: kind, status: status,
                output: output, outputIsError: outputIsError,
                threadStatus: threadStatus)
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

    @UIState private var isExpanded = false

    /// Memoized: SwiftUI rebuilds every visible row's view value on each
    /// timeline mutation, and re-running JSONSerialization per row per frame
    /// would tax long streaming timelines.
    private var parsed: ParsedToolDetail {
        ToolDetailParseCache.parsed(detail: detail, itemType: kind.wireItemType)
    }

    private enum DisplayState {
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

    private var preview: String? {
        let line: String? =
            switch parsed {
            case .command(let command): command
            case .fileChange(let path, _): path
            case .plain(let text): text
            }
        guard let first = line?.split(separator: "\n", omittingEmptySubsequences: true).first
        else { return nil }
        let trimmed = first.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : trimmed
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(Motion.snap) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    statusIcon
                    Image(systemName: kind.symbolName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                    Text(name)
                        .font(.callout.weight(.medium))
                        .layoutPriority(1)
                    if let preview {
                        Text(preview)
                            .font(.system(.caption, design: kind == .command ? .monospaced : .default))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
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
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
        .animation(Motion.ambient, value: displayState)
    }

    @ViewBuilder
    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !detail.isEmpty {
                switch parsed {
                case .command(let command):
                    monospacedBody(command, foreground: .primary)
                case .fileChange(let path, let edits):
                    FileChangeDiffView(path: path, edits: edits)
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
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
    }

    /// One `Image` whose name/tint swap rides `.contentTransition` — the
    /// running → done flip morphs instead of hard-swapping glyphs.
    private var statusIcon: some View {
        Image(systemName: iconName)
            .symbolEffect(.pulse, isActive: displayState == .running)
            .foregroundStyle(iconTint)
            .contentTransition(.symbolEffect(.replace))
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
    /// No progress for this long marks a running task as stalled.
    private static let stalledThreshold: TimeInterval = 3 * 60

    let task: SubagentTaskItem
    let onStopAgent: () -> Void
    let onStopTurn: () -> Void

    @UIState private var isExpanded = false
    @UIState private var isHovering = false
    @UIState private var showStopTurnConfirm = false

    private var hasExpandableContent: Bool {
        !task.progressLog.isEmpty
            || task.error != nil
            || task.lastToolName != nil
            || task.usageSummary != nil
    }

    private func isStalled(at currentNow: Date) -> Bool {
        guard task.state == .running else { return false }
        return currentNow.timeIntervalSince(task.lastActivityAt) > Self.stalledThreshold
    }

    var body: some View {
        // TimelineView owns the 1Hz tick only while the task is running;
        // terminal rows never attach a live timer subscription.
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
        let stalled = isStalled(at: currentNow)
        VStack(alignment: .leading, spacing: 4) {
            Button {
                guard hasExpandableContent else { return }
                withAnimation(Motion.snap) { isExpanded.toggle() }
            } label: {
                HStack(alignment: .top, spacing: 9) {
                    statusIcon(stalled: stalled)
                        .frame(width: 16, height: 16)
                        .padding(.top, 1)

                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            Image(systemName: "person.2")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(width: 14)
                            Text(title)
                                .font(.callout.weight(.medium))
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 8)
                            if task.state == .running, isHovering {
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

                        if let identityBadge {
                            Text(identityBadge)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }

                        healthTags(now: currentNow)

                        if let subtitle {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
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
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(backgroundTint(stalled: stalled), in: RoundedRectangle(cornerRadius: 10))
        .animation(Motion.ambient, value: task.state)
        .onHover { isHovering = $0 }
        .contextMenu {
            if task.state == .running {
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
        if task.state == .running {
            Text(task.startedAt, style: .timer)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        } else if let duration = task.duration {
            Text(Self.format(duration: duration))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func healthTags(now currentNow: Date) -> some View {
        if task.state == .running {
            let stalled = isStalled(at: currentNow)
            HStack(spacing: 6) {
                Text(lastActivityLabel(at: currentNow))
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
        } else if task.isBackgrounded {
            Text("background")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(.secondary.opacity(0.12), in: Capsule())
        }
    }

    @ViewBuilder
    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let lastTool = nonEmpty(task.lastToolName) {
                metaLine(label: "Last tool", value: lastTool)
            }
            if let usage = nonEmpty(task.usageSummary) {
                metaLine(label: "Usage", value: usage)
            }
            if let error = nonEmpty(task.error) {
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
        let visible = log.suffix(Self.maxVisibleLogEntries)
        VStack(alignment: .leading, spacing: 4) {
            if hidden > 0 {
                Text("… \(hidden) earlier update\(hidden == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            ForEach(Array(visible.enumerated()), id: \.offset) { index, entry in
                let isNewest =
                    task.state == .running
                    && index == visible.count - 1
                    && hidden + index == log.count - 1
                progressLogLine(entry, emphasize: isNewest)
            }
        }
    }

    private func progressLogLine(_ entry: SubagentTaskProgressEntry, emphasize: Bool)
        -> some View
    {
        HStack(alignment: .top, spacing: 6) {
            Text(Self.relativeOffset(from: task.startedAt, to: entry.at))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 36, alignment: .trailing)
            if let tool = entry.toolName?.trimmingCharacters(in: .whitespacesAndNewlines),
                !tool.isEmpty
            {
                Text(tool)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.secondary.opacity(0.12), in: Capsule())
            }
            Text(entry.text)
                .font(.caption)
                .foregroundStyle(emphasize ? .primary : .secondary)
                .lineLimit(2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var title: String {
        task.description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? task.description!
            : "Subagent task"
    }

    /// Compact identity badge: "Explore · sonnet-5" or "workflow · opus-4.8".
    private var identityBadge: String? {
        var parts: [String] = []
        if let workflow = nonEmpty(task.workflowName) {
            parts.append(workflow)
        } else if let subagent = nonEmpty(task.subagentType) {
            parts.append(subagent)
        } else if let type = nonEmpty(task.taskType) {
            parts.append(type.replacingOccurrences(of: "-", with: " "))
        }
        if let model = nonEmpty(task.model) {
            parts.append(shortModelName(model))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func lastActivityLabel(at currentNow: Date) -> String {
        let seconds = max(0, Int(currentNow.timeIntervalSince(task.lastActivityAt)))
        if seconds < 5 { return "last activity just now" }
        if seconds < 60 { return "last activity \(seconds)s ago" }
        let minutes = seconds / 60
        if minutes < 60 { return "last activity \(minutes)m ago" }
        return "last activity \(minutes / 60)h ago"
    }

    private var subtitle: String? {
        // Completed/failed/stopped: prefer completion summary via latestProgress.
        if task.state != .running {
            if let progress = task.latestProgress?.trimmingCharacters(in: .whitespacesAndNewlines),
                !progress.isEmpty
            {
                return progress
            }
            switch task.state {
            case .running: return nil
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

    private func statusIcon(stalled: Bool) -> some View {
        Image(systemName: iconName(stalled: stalled))
            .symbolEffect(.pulse, isActive: task.state == .running && !stalled)
            .foregroundStyle(iconTint(stalled: stalled))
            .contentTransition(.symbolEffect(.replace))
    }

    private func iconName(stalled: Bool) -> String {
        switch task.state {
        case .running: stalled ? "exclamationmark.circle" : "circle.dotted"
        case .completed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .stopped: "stop.circle.fill"
        }
    }

    private func iconTint(stalled: Bool) -> Color {
        switch task.state {
        case .running: stalled ? .orange : .secondary
        case .completed: .green
        case .failed: .red
        case .stopped: .secondary
        }
    }

    private func backgroundTint(stalled: Bool) -> Color {
        switch task.state {
        case .running: stalled ? Color.orange.opacity(0.08) : Color.accentColor.opacity(0.08)
        case .completed: Color.green.opacity(0.08)
        case .failed: Color.red.opacity(0.08)
        case .stopped: Color.secondary.opacity(0.08)
        }
    }

    private func shortModelName(_ model: String) -> String {
        // Prefer a readable short id when the wire form is a long Claude slug.
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("claude-") {
            return String(trimmed.dropFirst("claude-".count))
        }
        return trimmed
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    private static func relativeOffset(from start: Date, to date: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(start)))
        let minutes = seconds / 60
        let rem = seconds % 60
        return String(format: "%d:%02d", minutes, rem)
    }

    private static func format(duration: TimeInterval) -> String {
        if duration < 1 { return "<1s" }
        if duration < 60 { return "\(Int(duration.rounded()))s" }
        let minutes = Int(duration) / 60
        let seconds = Int(duration) % 60
        return seconds == 0 ? "\(minutes)m" : "\(minutes)m \(seconds)s"
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
    let edits: [ToolFileEdit]

    private static let maxLines = 60

    private struct Line: Identifiable {
        enum Kind { case removed, added, separator }
        let id: Int
        let kind: Kind
        let text: String
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
                Text(path)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
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

            ForEach(visible) { line in
                diffLine(line)
            }

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
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator, lineWidth: 1))
    }

    @ViewBuilder
    private func diffLine(_ line: Line) -> some View {
        switch line.kind {
        case .separator:
            Text(line.text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 8)
                .padding(.vertical, 1)
        case .removed, .added:
            Text((line.kind == .added ? "+ " : "- ") + line.text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.horizontal, 8)
                .padding(.vertical, 1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    line.kind == .added ? Color.green.opacity(0.12) : Color.red.opacity(0.12))
        }
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
            Text(text)
                .font(.callout)
                .italic()
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .contentTransition(.opacity)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 4)
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
