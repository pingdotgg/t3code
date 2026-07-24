import AppKit
import SwiftUI

/// Dedicated pull-request discussion surface. It keeps remote review feedback
/// separate from SergeCode's local diff review while preserving direct links
/// back to the canonical GitHub conversation.
struct PullRequestReviewView: View {
    let model: AppModel
    let threadID: String
    let reference: String

    @Environment(\.dismiss) private var dismiss
    @UIState private var snapshot: PullRequestReviewSnapshot?
    @UIState private var isLoading = true
    @UIState private var errorMessage: String?

    private var unresolvedThreads: [PullRequestReviewThread] {
        snapshot?.threads.filter { !$0.isResolved && !$0.isOutdated } ?? []
    }

    private var otherThreads: [PullRequestReviewThread] {
        snapshot?.threads.filter { $0.isResolved || $0.isOutdated } ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .frame(minWidth: 680, idealWidth: 760, minHeight: 560, idealHeight: 700)
        .task(id: reference) { await load() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(snapshot.map { "PR #\($0.number) comments" } ?? "PR comments")
                    .font(.headline)
                if let snapshot {
                    Text("\(snapshot.unresolvedThreadCount) unresolved · \(snapshot.threads.count + snapshot.conversation.count) discussions")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button {
                Task { await load() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .disabled(isLoading)
            if let url = snapshot.flatMap({ URL(string: $0.url) }) {
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Label("Open PR", systemImage: "arrow.up.right")
                }
            }
            Button("Done") { dismiss() }
                .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 12))
        .padding(8)
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && snapshot == nil {
            VStack(spacing: 12) {
                ProgressView()
                Text("Loading review comments…")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage, snapshot == nil {
            ContentUnavailableView(
                "Couldn’t load PR comments", systemImage: "exclamationmark.bubble",
                description: Text(errorMessage))
        } else if let snapshot {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if snapshot.truncated {
                        Label(
                            "This is a partial snapshot. Open the pull request for the complete discussion.",
                            systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .foregroundStyle(.orange)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                    }
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.callout)
                            .foregroundStyle(.red)
                    }
                    if snapshot.threads.isEmpty && snapshot.conversation.isEmpty {
                        ContentUnavailableView(
                            "No review comments", systemImage: "bubble.left",
                            description: Text(
                                "No conversation comments, review summaries, or inline threads have been left on this pull request."))
                            .frame(maxWidth: .infinity, minHeight: 320)
                    }
                    if !unresolvedThreads.isEmpty {
                        sectionHeader("Unresolved threads", count: unresolvedThreads.count)
                        ForEach(Array(unresolvedThreads.enumerated()), id: \.element.id) {
                            index, thread in
                            PullRequestThreadCard(
                                thread: thread,
                                model: model,
                                threadID: threadID)
                                .entrance(.row, index: index)
                        }
                    }
                    if !snapshot.conversation.isEmpty {
                        sectionHeader("Conversation & reviews", count: snapshot.conversation.count)
                        ForEach(Array(snapshot.conversation.enumerated()), id: \.element.id) {
                            index, comment in
                            PullRequestCommentCard(
                                comment: comment,
                                model: model,
                                threadID: threadID)
                                .entrance(.row, index: index)
                        }
                    }
                    if !otherThreads.isEmpty {
                        sectionHeader("Resolved & outdated", count: otherThreads.count)
                        ForEach(Array(otherThreads.enumerated()), id: \.element.id) {
                            index, thread in
                            PullRequestThreadCard(
                                thread: thread,
                                model: model,
                                threadID: threadID)
                                .entrance(.row, index: index)
                        }
                    }
                }
                .padding(18)
            }
        }
    }

    private func sectionHeader(_ title: String, count: Int) -> some View {
        HStack {
            Text(title).font(.headline)
            Spacer()
            Text("\(count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(.top, 4)
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let loaded = try await model.pullRequestReview(
                threadID: threadID, reference: reference)
            guard !Task.isCancelled else { return }
            snapshot = loaded
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = String(describing: error)
        }
        isLoading = false
    }
}

private struct PullRequestThreadCard: View {
    let thread: PullRequestReviewThread
    let model: AppModel
    let threadID: String

    private var line: Int? { thread.line ?? thread.originalLine }
    private var status: String {
        if thread.isResolved { return "Resolved" }
        if thread.isOutdated { return "Outdated" }
        return "Unresolved"
    }

    private var statusColor: Color {
        if thread.isResolved { return .green }
        if thread.isOutdated { return .secondary }
        return .orange
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: thread.isResolved ? "checkmark.circle.fill" : "text.bubble.fill")
                    .foregroundStyle(statusColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(thread.path + (line.map { ":\($0)" } ?? ""))
                        .font(.system(.callout, design: .monospaced).weight(.semibold))
                        .textSelection(.enabled)
                    Text(status)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(statusColor)
                }
            }
            ForEach(Array(thread.comments.enumerated()), id: \.element.id) { index, comment in
                if index > 0 { Divider() }
                PullRequestCommentBody(comment: comment, model: model, threadID: threadID)
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct PullRequestCommentCard: View {
    let comment: PullRequestReviewComment
    let model: AppModel
    let threadID: String

    var body: some View {
        PullRequestCommentBody(comment: comment, model: model, threadID: threadID)
            .padding(14)
            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct PullRequestCommentBody: View {
    let comment: PullRequestReviewComment
    let model: AppModel
    let threadID: String

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Text("@\(comment.author.login)")
                    .font(.callout.weight(.semibold))
                if comment.author.isBot {
                    Text("BOT")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.purple)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.purple.opacity(0.12), in: Capsule())
                }
                if let state = comment.reviewState {
                    Text(state.replacingOccurrences(of: "_", with: " "))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(comment.createdAt, format: .relative(presentation: .named))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            AssistantMarkdownView(
                markdown: renderableGitHubCommentMarkdown(comment.body),
                isStreaming: false,
                threadID: threadID,
                messageID:
                    "github-comment-\(comment.id)-\(comment.updatedAt.timeIntervalSinceReferenceDate)",
                model: model)
            if let url = URL(string: comment.url) {
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Label("Open on GitHub", systemImage: "arrow.up.right")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.link)
            }
        }
    }
}
