import AppKit
import SwiftUI
import T3Kit

/// Shared transcript card geometry — also used by the subagent inner thread.
enum TranscriptMetrics {
    static let cardRadius: CGFloat = 12
    static let cardPadH: CGFloat = 12
    static let cardPadV: CGFloat = 10
    static let nestedRadius: CGFloat = 6
    static let railWidth: CGFloat = 2.5
    /// Leading activity-chip size. Deliberately large — the activity stream
    /// should be glanceable, not zoomed-out small text.
    static let iconColumn: CGFloat = 28
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

extension View {
    func transcriptCard<S: ShapeStyle>(
        fill: S,
        showRail: Bool = false,
        railColor: Color = AlpineTheme.accent
    ) -> some View {
        modifier(
            TranscriptCardModifier(
                fill: AnyShapeStyle(fill),
                showRail: showRail,
                railColor: railColor))
    }
}

// TranscriptPill lives in SubagentTaskComponents.swift — shared with the
// delegated-task card so both surfaces render identical capsule tags.

/// Everything a timeline row needs from `AppModel` beyond its own item.
///
/// Resolved once per render in `ChatTimelineScrollView` and passed down as a
/// value. Rows used to derive these themselves (`model.threads.first { … }`,
/// `model.selectedThread?.status`, a reversed scan of the thread's timeline),
/// which both cost a linear scan per row and — worse — made every row observe
/// `threads`, `projects`, and `timeline`. While the agent was running, any
/// touch of those (a token count, a status flip, every streaming delta)
/// invalidated the entire visible transcript, which is what made scrolling
/// judder mid-run.
struct TimelineRowContext: Equatable {
    /// Selected thread's status. Tool rows use it to decide that a row stuck
    /// "running" on a settled thread should read as finished.
    var threadStatus: ThreadStatus?
    /// Project cwd, for path shortening in tool rows.
    var projectRoot: String?
    /// The one decision card that currently owns keyboard shortcuts.
    var activeDecisionCardID: String?
    /// Gate for the user-bubble edit/retry affordances.
    var isConnectionReady: Bool

    init(
        threadStatus: ThreadStatus? = nil,
        projectRoot: String? = nil,
        activeDecisionCardID: String? = nil,
        isConnectionReady: Bool = false
    ) {
        self.threadStatus = threadStatus
        self.projectRoot = projectRoot
        self.activeDecisionCardID = activeDecisionCardID
        self.isConnectionReady = isConnectionReady
    }
}

/// Dispatches a single `TimelineDisplayItem` to its row view.
///
/// `Equatable` so SwiftUI can skip the body of rows whose item and context are
/// unchanged. Combined with `TimelineDisplayCache` reusing untouched rows
/// verbatim, a streaming delta re-renders only the row it actually changed.
struct ChatTimelineRowView: View, Equatable {
    let item: TimelineDisplayItem
    let threadID: String
    let context: TimelineRowContext
    let model: AppModel

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        ObjectIdentifier(lhs.model) == ObjectIdentifier(rhs.model)
            && lhs.threadID == rhs.threadID
            && lhs.context == rhs.context
            && lhs.item == rhs.item
    }

    var body: some View {
        switch item {
        case .single(let item):
            singleRow(item)
        case .toolGroup(_, let items, let summary):
            ToolGroupRow(
                items: items, summary: summary,
                threadStatus: context.threadStatus,
                projectRoot: context.projectRoot)
        case .daySeparator(_, let label):
            SessionSeparatorRow(label: label)
        }
    }

    @ViewBuilder
    private func singleRow(_ item: TimelineItem) -> some View {
        switch item {
        case .userMessage(let id, let text, let attachments, let at):
            UserMessageBubble(
                messageID: id, text: text, attachments: attachments, threadID: threadID,
                model: model, at: at,
                canSend: context.isConnectionReady && context.threadStatus != .running)
        case .assistantMessage(let id, let markdown, let isStreaming, let at):
            AssistantMarkdownView(
                markdown: markdown, isStreaming: isStreaming, threadID: threadID,
                messageID: id, model: model, at: at, showsRoleChrome: true)
        case .toolEvent(_, let name, let detail, let kind, let status, let at, let output, let outputIsError):
            ToolEventRow(
                name: name, detail: detail, kind: kind, status: status,
                output: output, outputIsError: outputIsError,
                threadStatus: context.threadStatus, at: at,
                projectRoot: context.projectRoot)
        case .subagentTask(let task):
            DelegatedTaskCard(
                task: task,
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
            ApprovalCard(request: request, isActive: isActiveDecisionCard(request.id)) { approve in
                Task { await model.respond(to: request, approve: approve) }
            }
        case .userInput(let request):
            UserInputCard(request: request, isActive: isActiveDecisionCard(request.id)) { answers in
                Task { await model.respond(to: request, answers: answers) }
            }
        case .usageLimit(let notice):
            UsageLimitCard(
                notice: notice,
                state: model.usageLimitActions[notice.id] ?? .idle,
                switchModels: switchModels(for: notice),
                isActive: isActiveDecisionCard(notice.id)
            ) {
                model.waitForUsageLimitReset(notice)
            } onSwitch: { option in
                Task { await model.switchModelAfterUsageLimit(notice, to: option) }
            } onDismiss: {
                model.dismissUsageLimit(notice)
            }
        case .plan(let plan):
            PlanCard(plan: plan, model: model, isActive: isActiveDecisionCard(plan.id)) {
                Task { await model.implementPlan(plan) }
            }
        case .checkpoint(let checkpoint):
            CheckpointRow(checkpoint: checkpoint, model: model)
        case .notice(_, let text, _):
            NoticeRow(text: text)
        case .compaction(let notice):
            CompactionRow(notice: notice) {
                Task { await model.startNewThread(afterFailedCompaction: notice) }
            }
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

    /// Only the single most-recent actionable card owns the keyboard shortcuts
    /// (`Array<TimelineItem>.activeDecisionCardID` picks it); a scrollback full
    /// of historical cards must never let a keystroke resolve the wrong one.
    private func isActiveDecisionCard(_ id: String) -> Bool {
        context.activeDecisionCardID == id
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
    let attachments: [MessageAttachment]
    let threadID: String
    let model: AppModel
    let at: Date?
    /// Backend is ready and the thread is not mid-turn. Passed in rather than
    /// read off `model` so this row does not observe `threads` — see
    /// `TimelineRowContext`.
    let canSend: Bool

    @UIState private var isHovering = false
    @UIState private var isExpanded = false
    /// Local double-click guard: `canResend` flips only after the thread's
    /// status round-trips to `.running`, which is async.
    @UIState private var isResending = false
    @UIState private var previewAttachment: MessageAttachment?
    @Environment(\.openSelectText) private var openSelectText

    /// Resending mid-turn would interleave with the running agent; the
    /// composer's send path has the same gate.
    private var canResend: Bool {
        canSend && !isResending
    }

    private var isLarge: Bool { text.count > 12_000 }
    private var visibleText: String {
        guard isLarge, !isExpanded else { return text }
        return String(text.prefix(1_600)) + "\n\n…"
    }

    private var hasText: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 6) {
                if !attachments.isEmpty {
                    VStack(alignment: .trailing, spacing: 6) {
                        ForEach(attachments) { attachment in
                            ChatAttachmentThumbnail(
                                attachment: attachment,
                                model: model,
                                onOpen: { previewAttachment = attachment })
                        }
                    }
                }

                if hasText {
                    AssistantMarkdownView(
                        markdown: visibleText,
                        isStreaming: false,
                        threadID: threadID,
                        model: model,
                        style: .userBubble)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            AlpineTheme.userBubbleFill,
                            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.card))
                        .foregroundStyle(.primary)
                        .overlay(alignment: .topTrailing) {
                            messageActions
                        }
                        .overlay(
                            RoundedRectangle(cornerRadius: AlpineTheme.Corners.card)
                                .strokeBorder(AlpineTheme.userBubbleStroke, lineWidth: 1))
                        .overlay(alignment: .bottomLeading) {
                            if isLarge {
                                Button(isExpanded ? "Show Less" : "Show More") {
                                    withDeferredAnimation(Motion.structure) {
                                        isExpanded.toggle()
                                    }
                                }
                                .buttonStyle(.plain)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(AlpineTheme.accent)
                                .padding(.leading, 14)
                                .padding(.bottom, 5)
                            }
                        }
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
                } else if !attachments.isEmpty {
                    // Attachment-only messages still need edit/retry affordances.
                    messageActions
                        .padding(3)
                }

            }
            // Timestamp lives in a non-layout overlay: inserting it into the
            // VStack above would re-measure every sibling row on each hover.
            .overlay(alignment: .bottomTrailing) {
                if let at, isHovering {
                    TranscriptTimestamp(date: at)
                        .transition(.opacity)
                        .offset(y: 15)
                }
            }
            // Hover and context menu live on the bubble cluster, not the full
            // row — the spacer's empty area shouldn't reveal actions.
            .onHover { isHovering = $0 }
            .animation(Motion.feedback, value: isHovering)
            .sheet(item: $previewAttachment) { attachment in
                ChatAttachmentPreviewSheet(attachment: attachment, model: model)
            }
        }
    }

    @ViewBuilder
    private var messageActions: some View {
        MessageActionChip {
            if hasText {
                CopyActionButton(text: text)
            }
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

// MARK: - Attachment thumbnails

private enum AttachmentImagePhase: Equatable {
    case loading
    case loaded
    case failed
}

private struct ChatAttachmentThumbnail: View {
    let attachment: MessageAttachment
    let model: AppModel
    let onOpen: () -> Void

    @UIState private var phase: AttachmentImagePhase = .loading
    @UIState private var image: NSImage?
    @UIState private var reloadToken = 0

    var body: some View {
        Button(action: onOpen) {
            ZStack {
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
                    .fill(AlpineTheme.userBubbleFill)
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFill()
                        .transition(.opacity)
                }
                if phase == .loading {
                    ProgressView()
                        .controlSize(.small)
                } else if phase == .failed {
                    VStack(spacing: 4) {
                        Image(systemName: "photo")
                            .font(.title3)
                        Text("Unavailable")
                            .font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .frame(width: 220, height: 160)
            .clipShape(RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous))
            .overlay(alignment: .bottom) {
                HStack {
                    Text(attachment.name)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(formatAttachmentSize(attachment.sizeBytes))
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.black.opacity(0.55))
            }
            .overlay(
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
                    .strokeBorder(AlpineTheme.userBubbleStroke, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(phase != .loaded)
        .accessibilityLabel(
            "\(attachment.name), \(formatAttachmentSize(attachment.sizeBytes)) image. Opens a full-size preview."
        )
        .task(id: "\(attachment.id)-\(reloadToken)") {
            await load()
        }
        .contextMenu {
            if phase == .failed {
                Button("Retry") { reloadToken += 1 }
            }
        }
    }

    private func load() async {
        phase = .loading
        image = nil
        do {
            let url = try await model.attachmentImageURL(id: attachment.id)
            let loaded = try await loadNSImage(from: url)
            // Crossfade the spinner into the decoded image; the ZStack frame
            // is fixed, so this stays a render-only opacity change.
            withAnimation(Motion.reveal) {
                image = loaded
                phase = .loaded
            }
        } catch {
            withAnimation(Motion.reveal) {
                phase = .failed
            }
        }
    }
}

private struct ChatAttachmentPreviewSheet: View {
    let attachment: MessageAttachment
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @UIState private var phase: AttachmentImagePhase = .loading
    @UIState private var image: NSImage?

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.name)
                        .font(.headline)
                    Text(formatAttachmentSize(attachment.sizeBytes))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.black.opacity(0.06))
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                if phase == .loading {
                    ProgressView()
                } else if phase == .failed {
                    ContentUnavailableView(
                        "Image unavailable",
                        systemImage: "photo",
                        description: Text("Couldn’t load \(attachment.name)"))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(16)
        .frame(minWidth: 480, minHeight: 360)
        .task(id: attachment.id) {
            phase = .loading
            image = nil
            do {
                let url = try await model.attachmentImageURL(id: attachment.id)
                image = try await loadNSImage(from: url)
                phase = .loaded
            } catch {
                phase = .failed
            }
        }
    }
}

private func formatAttachmentSize(_ sizeBytes: Int) -> String {
    if sizeBytes < 1024 { return "\(sizeBytes) B" }
    let units = ["KB", "MB", "GB"]
    var value = Double(sizeBytes)
    var unitIndex = -1
    while value >= 1024, unitIndex < units.count - 1 {
        value /= 1024
        unitIndex += 1
    }
    if value >= 10 || value.rounded() == value {
        return "\(Int(value.rounded())) \(units[unitIndex])"
    }
    return String(format: "%.1f %@", value, units[unitIndex])
}

private func loadNSImage(from url: URL) async throws -> NSImage {
    if url.scheme == "data" {
        let absolute = url.absoluteString
        guard let marker = absolute.range(of: "base64,"),
            let data = Data(base64Encoded: String(absolute[marker.upperBound...])),
            let image = NSImage(data: data)
        else {
            throw URLError(.cannotDecodeContentData)
        }
        return image
    }
    let (data, response) = try await URLSession.shared.data(from: url)
    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
        throw URLError(.badServerResponse)
    }
    guard let image = NSImage(data: data) else {
        throw URLError(.cannotDecodeContentData)
    }
    return image
}

/// A finished burst of tool work, condensed to one disclosure row once the
/// agent has moved on. The collapsed row leads with a fanned stack of the
/// burst's tool-kind chips; expanding reveals the original tool/reasoning rows.
private struct ToolGroupRow: View {
    /// Kinds fanned out on the collapsed row; more than this reads as noise.
    private static let maxFannedChips = 5

    let items: [TimelineItem]
    let summary: ToolGroupSummary
    let threadStatus: ThreadStatus?
    let projectRoot: String?

    @UIState private var isExpanded = false

    /// Distinct tool kinds in the burst, in first-appearance order.
    private var fannedKinds: [ToolEventKind] {
        var kinds: [ToolEventKind] = []
        for item in items {
            guard case .toolEvent(_, _, _, let kind, _, _, _, _) = item,
                  !kinds.contains(kind)
            else { continue }
            kinds.append(kind)
            if kinds.count == Self.maxFannedChips { break }
        }
        return kinds
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                // Settle, not snap: expanding can reveal dozens of rows, and
                // the quick snap curve makes that layout shift feel violent.
                withDeferredAnimation(Motion.structure) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 10) {
                    chipFan
                    Text(headline)
                        .font(SurgeTypography.toolTitle)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if summary.failedCount > 0 {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.callout)
                            .foregroundStyle(Color.orange)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(items) { item in
                        expandedRow(item)
                    }
                }
                .transition(Motion.unfold)
            }
        }
        .transcriptCard(fill: .quaternary.opacity(0.4))
    }

    /// Overlapping chips with alternating tilt, popping in with a clamped
    /// stagger (`.control` entrances are delay-only, so this stays cheap).
    private var chipFan: some View {
        HStack(spacing: -6) {
            ForEach(Array(fannedKinds.enumerated()), id: \.offset) { index, kind in
                ActivityIconChip(style: kind.activityStyle, size: 24)
                    .rotationEffect(.degrees(index.isMultiple(of: 2) ? -6 : 6))
                    .zIndex(Double(index))
                    .entrance(.control, index: index)
            }
        }
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
            case .running, .waiting, .waitingApproval, .waitingInput, .backgroundWork, nil:
                return .running
            case .idle, .archived, .error, .settled: return .settled
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
        VStack(alignment: .leading, spacing: 6) {
            Button {
                // Settle, not snap, and deferred like ToolGroupRow: the
                // disclosure can reveal dozens of output lines.
                withDeferredAnimation(Motion.structure) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 10) {
                    ActivityIconChip(style: kind.activityStyle)
                        .pulseGlow(isActive: displayState == .running)
                        .overlay(alignment: .bottomTrailing) {
                            statusBadge
                        }
                        .successRipple(
                            fire: displayState == .succeeded,
                            cornerRadius: TranscriptMetrics.iconColumn * 0.32)
                    Text(name)
                        .font(SurgeTypography.toolTitle)
                        .layoutPriority(1)
                    if let preview {
                        previewLabel(preview)
                    }
                    Spacer(minLength: 8)
                    if hasExpandableContent {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
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
        .shimmerBorder(
            color: kind.activityStyle.tint,
            isActive: displayState == .running,
            cornerRadius: TranscriptMetrics.cardRadius)
        .overlay(alignment: .topTrailing) {
            if isHovering, let at {
                TranscriptTimestamp(date: at)
                    .padding(.top, 9)
                    .padding(.trailing, hasExpandableContent ? 28 : 12)
            }
        }
        .animation(Motion.ambient, value: displayState)
        .animation(Motion.feedback, value: isHovering)
        .onHover { isHovering = $0 }
    }

    private var cardFill: AnyShapeStyle {
        switch displayState {
        case .failed:
            AnyShapeStyle(Color.red.opacity(0.08))
        case .running:
            AnyShapeStyle(kind.activityStyle.tint.opacity(0.08))
        case .succeeded, .settled:
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
            .font(kind == .command || kind == .fileChange
                ? SurgeTypography.toolPayload
                : .callout)
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
                .font(.callout.weight(.medium))
                .foregroundStyle(.secondary)
            if let notice = visible.truncationNotice {
                Text(notice)
                    .font(.caption)
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
            .font(SurgeTypography.toolPayload)
            .foregroundStyle(foreground)
            .textSelection(.enabled)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(nsColor: .textBackgroundColor),
                in: RoundedRectangle(cornerRadius: TranscriptMetrics.nestedRadius))
    }

    /// Status badge pinned to the chip's bottom-trailing corner. One `Image`
    /// whose name/tint swap rides `.contentTransition` — the running → done
    /// flip morphs instead of hard-swapping glyphs; the running badge pulses
    /// and a success bounces once (both dropped under Reduce Motion).
    @ViewBuilder
    private var statusBadge: some View {
        let badge = Image(systemName: iconName)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(iconTint)
            .contentTransition(
                Motion.reduceMotion ? .identity : .symbolEffect(.replace))
        if Motion.reduceMotion {
            badge
        } else if displayState == .running {
            badge.symbolEffect(.pulse)
        } else {
            badge.symbolEffect(.bounce, value: displayState == .succeeded)
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
        case .succeeded: AlpineTheme.statusSuccess
        case .failed: .red
        case .settled: .secondary
        }
    }
}

extension ToolEventKind {
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
        case .skill, .computerUse, .other: nil
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
                    .font(SurgeTypography.toolPayload)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(path)
                Spacer(minLength: 4)
                if additions > 0 {
                    Text("+\(additions)")
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.green)
                }
                if deletions > 0 {
                    Text("-\(deletions)")
                        .font(.callout.monospacedDigit())
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
                .font(SurgeTypography.toolPayload)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)

            if hidden > 0 {
                Text("… \(hidden) more line\(hidden == 1 ? "" : "s")")
                    .font(SurgeTypography.toolPayload)
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
            piece.font = SurgeTypography.toolPayload
            piece.foregroundColor = Color.secondary.opacity(0.55)
            return piece
        case .removed:
            var piece = AttributedString("- " + text)
            piece.font = SurgeTypography.toolPayload
            piece.backgroundColor = Color.red.opacity(0.12)
            return piece
        case .added:
            var piece = AttributedString("+ " + text)
            piece.font = SurgeTypography.toolPayload
            piece.backgroundColor = Color.green.opacity(0.12)
            return piece
        }
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

/// The agent's current thought: dimmed italic block whose text is replaced in
/// place as task progress streams (the row id is stable per task), so one
/// row narrates the work instead of a stack of stale updates. Long thinking
/// clamps to a four-line preview behind a Show More/Show Less toggle so a
/// verbose chain never floods the transcript — and no part of the thought is
/// ever hidden without a way to reveal it in full.
private struct ReasoningRow: View {
    /// Heuristic for "long" thinking; short thoughts always render in full,
    /// with no toggle chrome.
    private static let expandableCharThreshold = 420

    let text: String

    @UIState private var isExpanded = false

    private var isExpandable: Bool {
        text.count > Self.expandableCharThreshold
            || text.filter(\.isNewline).count > 4
    }

    private var showsPreview: Bool {
        isExpandable && !isExpanded
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            ActivityIconChip(
                style: ToolActivityStyle(symbolName: "sparkles", tint: AlpineTheme.lavender),
                size: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(text)
                    .font(SurgeTypography.agentStatus)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(showsPreview ? 4 : nil)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if isExpandable {
                    Button(isExpanded ? "Show Less" : "Show More") {
                        withDeferredAnimation(Motion.structure) {
                            isExpanded.toggle()
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.tint)
                }
            }
        }
        .padding(.leading, TranscriptMetrics.cardPadH)
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
                withDeferredAnimation(Motion.structure) {
                    isExpanded.toggle()
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
                    .font(SurgeTypography.toolPayload)
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


/// Context-compaction lifecycle row. In progress it is a centered system
/// notice with a live indicator so a long compaction never reads as stalled;
/// completed it is the same notice plus the token delta; failed/canceled it
/// becomes a diagnostic card with a "Start New Thread" recovery action (the
/// compacted transcript can no longer be trusted to continue). The started
/// and terminal states share the row id, so one replaces the other in place.
private struct CompactionRow: View {
    let notice: CompactionNotice
    let onStartNewThread: () -> Void

    var body: some View {
        // Started and terminal states share the row id, so the swap is a
        // crossfade here rather than an in-place teleport.
        Group {
            switch notice.status {
            case .started:
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text(notice.summary)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .transition(Motion.unfold)
            case .completed:
                Text(completedLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .transition(Motion.unfold)
            case .failed, .canceled:
                failureCard
                    .transition(Motion.materialize)
            }
        }
        .animation(Motion.reveal, value: notice.status)
    }

    private var completedLine: String {
        guard let before = notice.usedTokensBefore, let after = notice.usedTokensAfter else {
            return notice.summary
        }
        return
            "\(notice.summary) · \(Self.compactTokenCount(before)) → \(Self.compactTokenCount(after)) tokens"
    }

    private var failureTint: Color {
        notice.status == .failed ? .red : AlpineTheme.clay
    }

    private var failureCard: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: notice.status == .failed ? "exclamationmark.triangle.fill" : "xmark.circle")
                .foregroundStyle(failureTint)
                .frame(width: TranscriptMetrics.iconColumn)
            VStack(alignment: .leading, spacing: 2) {
                Text(notice.summary)
                    .font(.callout)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = notice.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            Button("Start New Thread") {
                onStartNewThread()
            }
            .buttonStyle(.glass)
            .controlSize(.small)
        }
        .transcriptCard(fill: failureTint.opacity(0.08), showRail: true, railColor: failureTint)
    }

    /// Compact token counts in the style the composer context meter deals in:
    /// "800", "9.5k", "128k".
    private static func compactTokenCount(_ value: Int) -> String {
        switch value {
        case ..<1_000:
            return value.formatted()
        case ..<10_000:
            return (Double(value) / 1_000).formatted(.number.precision(.fractionLength(1))) + "k"
        default:
            return Int((Double(value) / 1_000).rounded()).formatted() + "k"
        }
    }
}
