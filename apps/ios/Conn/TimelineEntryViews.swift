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

private struct AgentMessageCard: View {
    let text: String
    @Environment(\.connTheme) private var theme
    @State private var expanded = false

    var body: some View {
        Button {
            withAnimation(Kit.Motion.fast) {
                expanded.toggle()
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("Agent")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    Text("·")
                        .font(.system(size: 12))
                        .foregroundStyle(theme.mutedForeground)
                    Text("Agent message")
                        .font(.system(size: 12))
                        .foregroundStyle(theme.mutedForeground)
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.mutedForeground)
                }
                Text(text)
                    .font(.system(size: 14))
                    .foregroundStyle(theme.mutedForeground)
                    .lineLimit(expanded ? nil : 2)
                    .multilineTextAlignment(.leading)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(theme.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(theme.border.opacity(0.7), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
    }
}

private struct AssistantMessageFooter: View {
    let markdown: String
    let timestamp: String?
    @Environment(\.connTheme) private var theme
    @State private var copied = false

    var body: some View {
        HStack(spacing: 14) {
            Button {
                UIPasteboard.general.string = markdown
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    copied = false
                }
            } label: {
                ConnIcon(copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Copy message")

            Button {
            } label: {
                ConnIcon("arrow.triangle.branch")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Fork from here")

            if let timeLabel = formattedClockTime(from: timestamp) {
                Text(timeLabel)
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(theme.mutedForeground)
            }
            Spacer()
        }
        .padding(.top, 4)
    }

    private func formattedClockTime(from raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        guard let date else { return nil }
        let fmt = DateFormatter()
        fmt.timeStyle = .short
        fmt.dateStyle = .none
        return fmt.string(from: date)
    }
}

struct TimelineEntryRow: View {
    let threadId: String
    let entry: FfiTimelineEntry
    @Bindable var store: CoreStore
    let onOpenThread: (String) -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        switch entry {
        case let .user(_, text, _, createdByAgent, isSteer, _, attachments):
            if createdByAgent {
                AgentMessageCard(text: text)
            } else {
                HStack {
                    Spacer(minLength: 48)
                    VStack(alignment: .trailing, spacing: Kit.Space.xs) {
                        if isSteer {
                            KitBadge("Steer")
                        }
                        Text(text)
                            .font(.kitBody)
                            .foregroundStyle(theme.messageForeground)
                            .textSelection(.enabled)
                            .padding(.horizontal, Kit.Space.xl)
                            .padding(.vertical, Kit.Space.m + 2)
                            .background(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .fill(theme.messageSurface)
                            )
                        if !attachments.isEmpty {
                            KitBadge("\(attachments.count) attachment\(attachments.count == 1 ? "" : "s")")
                        }
                    }
                }
            }

        case let .queuedUser(_, _, _, text, _, _, _):
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: Kit.Space.xs) {
                    KitBadge("Queued")
                    Text(text)
                        .font(.kitBody)
                        .foregroundStyle(theme.mutedForeground)
                        .padding(.horizontal, Kit.Space.l)
                        .padding(.vertical, Kit.Space.m)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(theme.card)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(theme.border, lineWidth: 0.5)
                        )
                }
            }

        case let .assistant(_, markdown, streaming, timestamp, _, _):
            VStack(alignment: .leading, spacing: Kit.Space.xs) {
                MarkdownView(source: markdown)
                if streaming {
                    KitStatusIcon(.working, size: 12, label: "Streaming")
                } else {
                    AssistantMessageFooter(markdown: markdown, timestamp: timestamp)
                }
            }

        case let .thinking(_, text, streaming, _, _):
            ThinkingRow(text: text, streaming: streaming)

        case let .tool(_, kind, title, detail, status, _, _, durationMs):
            ToolRow(kind: kind, title: title, detail: detail, status: status, durationMs: durationMs)

        case let .approval(_, _, title, detail):
            // The pending approval itself sits above the composer (`PendingApprovalCard`); the
            // feed keeps a work row for it, like Conn mobile's "Approval requested".
            ToolRow(kind: "approval", title: title, detail: detail, status: .running, durationMs: nil)

        case let .userInputRequest(_, requestId, title, questions, _, pending, answers, dismissible, _):
            UserInputRequestCard(
                threadId: threadId,
                requestId: requestId,
                title: title,
                questions: questions,
                pending: pending,
                answers: answers,
                dismissible: dismissible,
                store: store
            )

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
                store: store
            )

        case let .proposedPlan(_, _, title, markdown, displayMarkdown, _, _, streaming, _, _):
            ProposedPlanCard(
                title: title.isEmpty ? "Proposed Plan" : title,
                markdown: displayMarkdown.isEmpty ? markdown : displayMarkdown,
                streaming: streaming
            )

        case let .subagent(_, childThreadId, title, role, status, statusLabel, _, summary, _, _, _, _):
            SubagentCard(
                childThreadId: childThreadId,
                title: title,
                role: role,
                status: status,
                statusLabel: statusLabel,
                summary: summary,
                onOpenThread: onOpenThread
            )

        case let .turnCheckpoint(_, _, _, fileCount, additions, deletions, files):
            TurnCheckpointCard(
                fileCount: Int(fileCount),
                additions: additions,
                deletions: deletions,
                files: files
            )

        case let .notice(_, text, isError):
            KitNotice(text, icon: isError ? .warning : .info, tone: isError ? .error : .info)

        case let .other(_, label):
            KitBadge(label)
        }
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
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(detail)
                        .font(.kitMono)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
    }
}

private struct UserInputRequestCard: View {
    let threadId: String
    let requestId: String
    let title: String?
    let questions: [FfiUserInputQuestion]
    let pending: Bool
    let answers: [FfiUserInputAnswer]
    let dismissible: Bool
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @State private var selections: [String: Set<String>] = [:]
    @State private var customText: [String: String] = [:]
    @State private var submitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: Kit.Space.m) {
            HStack(spacing: Kit.Space.s) {
                KitStatusIcon(pending ? .warning : .ok, size: 15, label: "Question")
                Text(title ?? "Question")
                    .font(.kitLabel.weight(.semibold))
                    .foregroundStyle(theme.cardForeground)
                Spacer()
            }

            if pending {
                ForEach(questions, id: \.id) { q in
                    VStack(alignment: .leading, spacing: Kit.Space.s) {
                        if !q.header.isEmpty {
                            Text(q.header)
                                .font(.kitDetail.weight(.semibold))
                                .foregroundStyle(theme.mutedForeground)
                        }
                        Text(q.question)
                            .font(.kitBody)
                            .foregroundStyle(theme.cardForeground)

                        ForEach(q.options, id: \.value) { opt in
                            let selected = selections[q.id]?.contains(opt.value) == true
                            Button {
                                toggle(option: opt.value, for: q)
                            } label: {
                                HStack(alignment: .top, spacing: Kit.Space.s) {
                                    Image(systemName: selected
                                        ? (q.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                                        : (q.multiSelect ? "square" : "circle"))
                                        .foregroundStyle(selected ? theme.primary : theme.mutedForeground)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(opt.label)
                                            .font(.kitDetail.weight(.medium))
                                            .foregroundStyle(theme.cardForeground)
                                        if !opt.description.isEmpty {
                                            Text(opt.description)
                                                .font(.kitDetail)
                                                .foregroundStyle(theme.mutedForeground)
                                        }
                                    }
                                    Spacer()
                                }
                                .padding(Kit.Space.s)
                                .background(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .fill(selected ? theme.accent.opacity(0.2) : theme.secondary.opacity(0.4))
                                )
                            }
                            .buttonStyle(.plain)
                        }

                        if q.allowCustomAnswer {
                            TextField(
                                "Other answer…",
                                text: Binding(
                                    get: { customText[q.id] ?? "" },
                                    set: { customText[q.id] = $0 }
                                )
                            )
                            .textFieldStyle(.roundedBorder)
                            .font(.kitDetail)
                        }
                    }
                }

                HStack(spacing: Kit.Space.s) {
                    Button("Submit") {
                        submit()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting)

                    if dismissible {
                        Button("Dismiss") {
                            submitting = true
                            Task {
                                await store.dismissUserInput(threadId: threadId, requestId: requestId)
                                submitting = false
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(submitting)
                    }
                }
            } else {
                ForEach(answers, id: \.questionId) { ans in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ans.question)
                            .font(.kitDetail)
                            .foregroundStyle(theme.mutedForeground)
                        Text(ans.answer)
                            .font(.kitDetail.weight(.medium))
                            .foregroundStyle(theme.cardForeground)
                    }
                }
            }
        }
        .padding(Kit.Space.l)
        .background(
            RoundedRectangle(cornerRadius: Kit.Radius.group, style: .continuous)
                .fill(theme.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Kit.Radius.group, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 0.5)
        )
    }

    private func toggle(option: String, for question: FfiUserInputQuestion) {
        var current = selections[question.id] ?? []
        if question.multiSelect {
            if current.contains(option) {
                current.remove(option)
            } else {
                current.insert(option)
            }
        } else {
            current = [option]
        }
        selections[question.id] = current
    }

    private func submit() {
        submitting = true
        var submissions: [FfiUserInputSubmission] = []
        for q in questions {
            let custom = (customText[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let chosen = Array(selections[q.id] ?? [])
            if q.multiSelect {
                var all = chosen
                if !custom.isEmpty { all.append(custom) }
                submissions.append(FfiUserInputSubmission(questionId: q.id, value: .multi(values: all)))
            } else {
                let val = !custom.isEmpty ? custom : (chosen.first ?? q.options.first?.value ?? "")
                submissions.append(FfiUserInputSubmission(questionId: q.id, value: .single(value: val)))
            }
        }
        Task {
            await store.respondUserInput(threadId: threadId, requestId: requestId, answers: submissions)
            submitting = false
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
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @State private var secret = ""
    @State private var submitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: Kit.Space.m) {
            HStack(spacing: Kit.Space.s) {
                Image(systemName: "key.fill")
                    .foregroundStyle(pending ? theme.warning : theme.mutedForeground)
                Text(label.isEmpty ? "Secret Request" : label)
                    .font(.kitLabel.weight(.semibold))
                    .foregroundStyle(theme.cardForeground)
                Spacer()
                if !pending {
                    KitBadge(statusLabel)
                }
            }

            if !reason.isEmpty {
                Text(reason)
                    .font(.kitDetail)
                    .foregroundStyle(theme.mutedForeground)
            }

            if pending {
                SecureField(placeholder ?? "Enter secret…", text: $secret)
                    .textFieldStyle(.roundedBorder)
                    .font(.kitBody)

                HStack(spacing: Kit.Space.s) {
                    Button("Save") {
                        submitting = true
                        let value = secret
                        Task {
                            await store.answerSecretRequest(threadId: threadId, turnItemId: turnItemId, secret: value)
                            secret = ""
                            submitting = false
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || submitting)

                    Button("Decline", role: .destructive) {
                        submitting = true
                        Task {
                            await store.answerSecretRequest(threadId: threadId, turnItemId: turnItemId, secret: nil)
                            submitting = false
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(submitting)
                }
            }
        }
        .padding(Kit.Space.l)
        .background(
            RoundedRectangle(cornerRadius: Kit.Radius.group, style: .continuous)
                .fill(theme.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Kit.Radius.group, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 0.5)
        )
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

private struct ProposedPlanCard: View {
    let title: String
    let markdown: String
    let streaming: Bool

    var body: some View {
        KitCollapsibleCard(
            title,
            status: streaming ? .working : .ok,
            trailingText: "Plan"
        ) {
            MarkdownView(source: markdown)
        }
    }
}

private struct SubagentCard: View {
    let childThreadId: String?
    let title: String
    let role: String
    let status: FfiTurnItemStatus
    let statusLabel: String
    let summary: String?
    let onOpenThread: (String) -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        Button {
            if let childThreadId {
                onOpenThread(childThreadId)
            }
        } label: {
            HStack(spacing: Kit.Space.m) {
                KitStatusIcon(mappedStatus, size: 15, label: statusLabel)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title.isEmpty ? role : title)
                        .font(.kitDetail.weight(.semibold))
                        .foregroundStyle(theme.cardForeground)
                        .lineLimit(1)
                    if let summary, !summary.isEmpty {
                        Text(summary)
                            .font(.kitDetail)
                            .foregroundStyle(theme.mutedForeground)
                            .lineLimit(2)
                    } else if !role.isEmpty {
                        Text(role)
                            .font(.kitDetail)
                            .foregroundStyle(theme.mutedForeground)
                    }
                }
                Spacer()
                KitBadge(statusLabel)
                if childThreadId != nil {
                    KitIconImage(.chevronRight, size: 11)
                        .foregroundStyle(theme.mutedForeground)
                }
            }
            .padding(Kit.Space.l)
            .background(
                RoundedRectangle(cornerRadius: Kit.Radius.group, style: .continuous)
                    .fill(theme.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Kit.Radius.group, style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(childThreadId == nil)
    }

    private var mappedStatus: KitStatusIcon.Status {
        switch status {
        case .running: .working
        case .completed: .ok
        case .failed: .error
        case .idle, .pending, .waiting: .pending
        case .cancelled, .interrupted: .warning
        }
    }
}

private struct TurnCheckpointCard: View {
    let fileCount: Int
    let additions: Int64
    let deletions: Int64
    let files: [FfiTurnCheckpointFile]
    @Environment(\.connTheme) private var theme

    var body: some View {
        KitCollapsibleCard(
            "\(fileCount) file\(fileCount == 1 ? "" : "s") changed",
            icon: .branch,
            trailingText: "+\(additions) -\(deletions)",
            expandable: !files.isEmpty
        ) {
            VStack(alignment: .leading, spacing: Kit.Space.xs) {
                ForEach(files, id: \.path) { file in
                    HStack(spacing: Kit.Space.s) {
                        Text(file.path)
                            .font(.kitMono)
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Text("+\(file.additions)")
                            .font(.kitDetail.monospaced())
                            .foregroundStyle(theme.diffAdded)
                        Text("-\(file.deletions)")
                            .font(.kitDetail.monospaced())
                            .foregroundStyle(theme.diffRemoved)
                    }
                }
            }
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
