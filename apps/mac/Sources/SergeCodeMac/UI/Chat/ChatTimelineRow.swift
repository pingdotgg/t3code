import SwiftUI

/// Dispatches a single `TimelineItem` to its row view.
struct ChatTimelineRowView: View {
    let item: TimelineItem
    let model: AppModel

    var body: some View {
        switch item {
        case .userMessage(_, let text, _):
            UserMessageBubble(text: text)
        case .assistantMessage(_, let markdown, let isStreaming, _):
            AssistantMarkdownView(markdown: markdown, isStreaming: isStreaming)
        case .toolEvent(_, let name, let detail, let status, _):
            ToolEventRow(name: name, detail: detail, status: status)
        case .approval(let request):
            ApprovalCard(request: request) { approve in
                Task { await model.respond(to: request, approve: approve) }
            }
        case .checkpoint(let checkpoint):
            CheckpointRow(checkpoint: checkpoint, model: model)
        case .notice(_, let text, _):
            NoticeRow(text: text)
        }
    }
}

/// Right-aligned solid bubble for the user's own messages.
private struct UserMessageBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 16))
                .foregroundStyle(.white)
        }
    }
}

/// Compact, expandable row for a single tool invocation.
private struct ToolEventRow: View {
    let name: String
    let detail: String
    let status: ToolEventStatus

    @UIState private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    statusIcon
                    Text(name)
                        .font(.callout)
                    Spacer()
                    if !detail.isEmpty {
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(detail.isEmpty)

            if isExpanded && !detail.isEmpty {
                Text(detail)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch status {
        case .running:
            Image(systemName: "circle.dotted")
                .symbolEffect(.pulse)
                .foregroundStyle(.secondary)
        case .succeeded:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
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
