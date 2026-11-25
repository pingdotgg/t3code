import DesignKit
import SwiftUI

struct WorkGroupCard: View {
    let group: FfiWorkGroupTiming
    let entries: [FfiTimelineEntry]
    @Environment(\.connTheme) private var theme
    @State private var expanded = false

    private var title: String {
        if group.hasActive {
            return group.durationLabel.map { "Working (\($0))…" } ?? "Working…"
        }
        if let label = group.durationLabel, !label.isEmpty {
            return "Worked for \(label)"
        }
        let count = entries.count
        return count == 1 ? "1 step" : "\(count) steps"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(Kit.Motion.fast) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Text(title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(theme.mutedForeground)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.mutedForeground)
                    Spacer()
                }
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: Kit.Space.s) {
                    ForEach(entries, id: \.entryId) { entry in
                        switch entry {
                        case let .thinking(_, text, streaming, _, _):
                            ThinkingRow(text: text, streaming: streaming)
                        case let .tool(_, kind, title, detail, status, _, _, durationMs):
                            ToolRow(kind: kind, title: title, detail: detail, status: status, durationMs: durationMs)
                        default:
                            EmptyView()
                        }
                    }
                }
                .padding(.bottom, 4)
            }

            Divider()
                .overlay(theme.border.opacity(0.6))
        }
        .accessibilityIdentifier("thread.workGroup.\(group.id)")
    }
}

struct TimelineEntryRow: View {
    let threadId: String
    let entry: FfiTimelineEntry
    @Bindable var store: CoreStore
    let detail: FfiFeedDetail?
    let interactive: Bool
    let onOpenThread: (String, String?) -> Void
    let onTemplate: (String) -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        switch detail {
        case let .html(attachment, title, height):
            ThreadEmbed(store: store, thread: threadId, item: entry.entryId, attachment: attachment, title: title, height: CGFloat(height), mcp: false)
        case let .mcp(sourceThread, attachment, title):
            ThreadEmbed(store: store, thread: sourceThread, item: entry.entryId, attachment: attachment, title: title, height: 260, mcp: true)
        case let .task(task):
            TaskReceiptCard(task: task)
        default:
            entryView
        }
    }

    @ViewBuilder private var entryView: some View {
        switch entry {
        case let .user(_, text, date, agent, steer, _, files):
            ThreadMessage(text: text, date: date, agent: agent, badge: steer ? "Steer" : nil, files: files,
                          detail: detail, store: store, onOpenThread: onOpenThread)
        case let .queuedUser(_, _, _, text, date, agent, files):
            ThreadMessage(text: text, date: date, agent: agent, badge: "Queued", files: files,
                          detail: detail, store: store, onOpenThread: onOpenThread)
        case let .assistant(_, markdown, streaming, timestamp, _, status):
            VStack(alignment: .leading, spacing: 4) {
                MarkdownView(source: markdown, onTemplate: onTemplate)
                if streaming { KitStatusIcon(.working, size: 12, label: "Streaming") }
                else {
                    HStack {
                        if status == .failed { Label("Response interrupted", systemImage: "exclamationmark.circle").font(.caption) }
                        MessageFooter(text: markdown, timestamp: timestamp)
                    }
                }
            }

        case let .thinking(_, text, streaming, _, _):
            ThinkingRow(text: text, streaming: streaming)

        case let .tool(_, kind, title, detail, status, _, _, durationMs):
            ToolRow(kind: kind, title: title, detail: detail, status: status, durationMs: durationMs)

        case let .approval(_, _, title, detail):
            // The pending approval itself sits above the composer (`PendingApprovalCard`); the
            // feed keeps a work row for it, like Conn mobile's "Approval requested".
            // Mobile draws this row with a static `lock` icon (`thread-work-log.tsx:159,411`);
            // no spinner, so a waiting approval never repaints.
            ApprovalWorkRow(title: title, detail: detail)

        case let .userInputRequest(_, _, _, _, _, pending, answers, _, _):
            QuestionRow(pending: pending, answers: answers)

        case let .secretRequest(id, label, reason, url, placeholder, _, status, pending, _):
            SecretRequestCard(
                threadId: threadId,
                turnItemId: id,
                label: label,
                reason: reason,
                url: url,
                placeholder: placeholder,
                status: status,
                pending: pending,
                interactive: interactive,
                store: store
            )

        case let .proposedPlan(_, _, title, markdown, display, _, _, streaming, _, _):
            ProposedPlanCard(title: title, markdown: markdown, display: display, streaming: streaming)
        case let .subagent(_, child, title, role, status, label, _, summary, remoteLabel, _, started, ended):
            let metadata = subagentMetadata
            ThreadCard {
                ProviderIcon(driver: metadata.provider, size: 14).overlay(alignment: .bottomTrailing) {
                    Circle().fill(status == .completed ? theme.success : status == .failed ? theme.destructive : theme.warning)
                        .frame(width: 6, height: 6)
                }
                let elapsed = threadElapsed(started, ended)
                Text([metadata.model ?? role, metadata.effort, elapsed == nil ? label : nil, remoteLabel]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")).lineLimit(2)
                Spacer(minLength: 0)
                if let elapsed { Text(elapsed).monospacedDigit().fixedSize() }
                if let destination = metadata.thread ?? child {
                    Button { onOpenThread(destination, metadata.environment) } label: {
                        Image(systemName: "arrow.up.right").padding(6)
                    }.accessibilityLabel("Open " + title)
                }
            } content: { AgentSummary(title: title, text: summary ?? "") }
        case let .turnCheckpoint(_, _, ordinal, fileCount, additions, deletions, files):
            TurnCheckpointCard(fileCount: Int(fileCount), additions: additions, deletions: deletions, files: files,
                               ordinal: ordinal, threadId: threadId, store: store)

        case let .notice(_, text, isError):
            KitNotice(text, icon: isError ? .warning : .info, tone: isError ? .error : .info)

        case let .other(_, label):
            KitBadge(label)
        }
    }
    private var subagentMetadata: (provider: String?, model: String?, effort: String?, environment: String?, thread: String?) {
        if case let .subagent(provider, model, effort, environment, thread) = detail {
            return (provider, model, effort, environment, thread)
        }
        return (nil, nil, nil, nil, nil)
    }

}

struct ThinkingRow: View {
    let text: String
    let streaming: Bool

    var body: some View {
        KitCollapsibleCard(
            streaming ? "Thinking…" : "Thought",
            status: streaming ? .working : .ok,
            expandable: !text.isEmpty
        ) {
            Text(text)
                .font(.kitDetail)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }
}

struct ToolRow: View {
    let kind: String
    let title: String
    let detail: String?
    let status: FfiItemStatus
    let durationMs: UInt64?

    private var mappedStatus: KitStatusIcon.Status {
        switch status {
        case .running: .working
        case .completed: .ok
        case .failed: .error
        }
    }

    private var durationLabel: String? {
        guard let ms = durationMs, ms > 0 else { return nil }
        if ms < 1000 { return "\(ms)ms" }
        return String(format: "%.1fs", Double(ms) / 1000.0)
    }

    var body: some View {
        let hasDetail = !(detail?.isEmpty ?? true)
        KitCollapsibleCard(
            title.isEmpty ? kind : title,
            status: mappedStatus,
            statusLabel: kind,
            trailingText: durationLabel,
            expandable: hasDetail
        ) {
            if let detail, !detail.isEmpty {
                if kind == "file_change" && detail.contains("\n") {
                    CodeCard(code: detail, language: "diff")
                } else { ScrollView(.horizontal, showsIndicators: true) {
                    Text(detail)
                        .font(.kitMono)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } }
            }
        }
    }
}

/// "Approval requested" in the feed, with mobile's static lock icon.
private struct ApprovalWorkRow: View {
    let title: String
    let detail: String?
    @Environment(\.connTheme) private var theme

    var body: some View {
        KitCollapsibleCard(
            title.isEmpty ? "Approval requested" : title,
            expandable: !(detail?.isEmpty ?? true),
            leading: {
                ConnIcon("lock")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
            },
            trailing: { EmptyView() }
        ) {
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.kitMono)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

/// A question's feed row, like Conn mobile's "Input requested" work row: it expands to the
/// answers (`QuestionAnswerHistory`). The open question has no row; the panel above the
/// composer asks it.
private struct QuestionRow: View {
    let pending: Bool
    let answers: [FfiUserInputAnswer]
    @Environment(\.connTheme) private var theme

    var body: some View {
        KitCollapsibleCard(
            "Input requested",
            status: pending ? .working : .ok,
            statusLabel: "question",
            trailingText: nil,
            expandable: !answers.isEmpty
        ) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(answers, id: \.questionId) { answer in
                    VStack(alignment: .leading, spacing: 4) {
                        if !answer.question.isEmpty {
                            Text(answer.question)
                                .font(.system(size: 14))
                                .foregroundStyle(theme.mutedForeground)
                        }
                        if !answer.answer.isEmpty {
                            Text(answer.answer)
                                .font(.system(size: 14))
                                .foregroundStyle(theme.mutedForeground)
                                .padding(.leading, 12)
                        }
                    }
                }
            }
            .textSelection(.enabled)
        }
    }
}

private struct SecretRequestCard: View {
    let threadId: String
    let turnItemId: String
    let label: String
    let reason: String
    let url: String?
    let placeholder: String?
    let status: FfiSecretRequestStatus
    let pending: Bool
    let interactive: Bool
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @State private var secret = ""
    @State private var submitting = false

    var body: some View {
        ThreadCard {
            Label("Secret request", systemImage: "key")
            Spacer()
            if pending && interactive {
                let canSave = !secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !submitting
                HStack(spacing: 6) {
                    Button("Decline", role: .destructive) { answer(nil) }
                        .foregroundStyle(theme.destructive)
                        .disabled(submitting)
                    Button { answer(secret) } label: {
                        Text("Save")
                            .foregroundStyle(canSave ? theme.primaryForeground : theme.mutedForeground)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 24)
                            .background(canSave ? theme.primary : theme.card.mix(with: theme.foreground, by: 0.14),
                                        in: Capsule())
                    }
                    .disabled(!canSave)
                }
                .buttonStyle(.plain)
            } else { Text(statusLabel) }
        } content: {
            VStack(alignment: .leading, spacing: 8) {
                if !label.isEmpty { Text(label).font(.system(size: 14, weight: .medium)) }
                if !reason.isEmpty { Text(reason).font(.kitDetail).foregroundStyle(theme.mutedForeground) }
                if pending && interactive {
                    if let url, let source = URL(string: url), source.scheme == "https" {
                        Link("Open secret provider", destination: source)
                    }
                    SecureField(placeholder ?? "Enter secret…", text: $secret)
                        .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never)
                        .autocorrectionDisabled().privacySensitive()
                        .disabled(submitting)
                }
            }.padding(11)
        }
        .onDisappear { secret = "" }
    }

    private func answer(_ value: String?) {
        guard pending && interactive && !submitting else { return }
        submitting = true
        secret = ""
        Task {
            await store.answerSecretRequest(threadId: threadId, turnItemId: turnItemId, secret: value)
            submitting = false
        }
    }

    private var statusLabel: String {
        switch status {
        case .pending: "Pending"
        case .saved: "Saved"
        case .declined: "Declined"
        case .cancelled: "Cancelled"
        }
    }
}

extension FfiTimelineEntry {
    var entryId: String {
        switch self {
        case let .user(id, _, _, _, _, _, _): id
        case let .queuedUser(id, _, _, _, _, _, _): id
        case let .assistant(id, _, _, _, _, _): id
        case let .thinking(id, _, _, _, _): id
        case let .tool(id, _, _, _, _, _, _, _): id
        case let .approval(id, _, _, _): id
        case let .userInputRequest(id, _, _, _, _, _, _, _, _): id
        case let .secretRequest(id, _, _, _, _, _, _, _, _): id
        case let .proposedPlan(id, _, _, _, _, _, _, _, _, _): id
        case let .subagent(id, _, _, _, _, _, _, _, _, _, _, _): id
        case let .turnCheckpoint(id, _, _, _, _, _, _): id
        case let .notice(id, _, _): id
        case let .other(id, _): id
        }
    }
}
