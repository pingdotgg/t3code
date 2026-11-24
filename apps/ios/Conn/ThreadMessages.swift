import DesignKit
import SwiftUI

struct AgentSummary: View {
    let title: String
    let text: String
    @State private var expanded = false
    @Environment(\.connTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if text.isEmpty { Text(title).font(.headline) }
            else {
                Button { expanded.toggle() } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(title).font(.system(size: 14, weight: .medium))
                            Spacer()
                            Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption)
                        }
                        if !expanded {
                            Text(text.replacingOccurrences(of: "\n", with: " "))
                                .font(.system(size: 13)).foregroundStyle(theme.mutedForeground).lineLimit(2)
                        }
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if expanded { MarkdownView(source: text, muted: true) }
            }
        }.padding(11)
    }
}

struct MessageFooter: View {
    let text: String
    let timestamp: String?
    @Environment(\.connTheme) private var theme
    var body: some View {
        HStack(spacing: 4) {
            if !text.isEmpty { CopyTextButton(label: "Copy message", text: text) }
            if let date = threadDate(timestamp) { Text(date, style: .time).font(.caption.monospacedDigit()) }
        }.font(.system(size: 13)).foregroundStyle(theme.mutedForeground)
    }
}

struct ThreadMessage: View {
    let text: String
    let date: String?
    let agent: Bool
    let badge: String?
    let files: [FfiAttachment]
    let detail: FfiFeedDetail?
    let store: CoreStore
    let onOpenThread: (String, String?) -> Void
    @Environment(\.connTheme) private var theme

    private var metadata: (sender: String?, thread: String?, environment: String?, reviews: [FfiReviewExcerpt]) {
        guard case let .message(sender, thread, env, reviews) = detail else { return (nil, nil, nil, []) }
        let localName = env == nil || env == store.environmentId ? store.shell?.threads.first(where: { $0.id == thread })?.title : nil
        return (sender ?? localName, thread, env, reviews)
    }

    private var displayText: String {
        var result = text
        for review in metadata.reviews {
            let id = NSRegularExpression.escapedPattern(for: review.contextId)
            let reference = #"\[[^\]]*\]\(t3-context://v1/review-comment/"# + id + #"\)"#
            result = result.replacingOccurrences(of: reference, with: "", options: .regularExpression)
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        if agent {
            ThreadCard {
                Label("Agent", systemImage: "person.crop.square")
                if let badge { Text(badge) }
                Spacer()
                if let id = metadata.thread {
                    Button { onOpenThread(id, metadata.environment) } label: { Image(systemName: "arrow.up.right").padding(6) }
                        .accessibilityLabel("Open sender thread")
                }
            } content: {
                VStack(alignment: .leading, spacing: 3) {
                    AgentSummary(title: metadata.sender ?? "Message", text: text)
                    if !files.isEmpty { ThreadAttachments(files: files, store: store) }
                }
            }
        } else {
            VStack(alignment: .trailing, spacing: 2) {
                if let badge { KitBadge(badge) }
                VStack(alignment: .leading, spacing: 3) {
                    if !displayText.isEmpty {
                        MarkdownView(source: displayText, fillsWidth: !files.isEmpty || !metadata.reviews.isEmpty).fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 13).padding(.vertical, 7)
                    }
                    ForEach(metadata.reviews, id: \.contextId) { review in
                        if !review.text.isEmpty { Text(review.text).textSelection(.enabled).padding(.horizontal, 11) }
                        CodeCard(code: review.diff, language: "diff", title: [review.filePath, review.rangeLabel].filter { !$0.isEmpty }.joined(separator: " · "))
                    }
                    if !files.isEmpty { ThreadAttachments(files: files, store: store) }
                }
                .padding(3)
                .background(theme.messageSurface, in: .rect(cornerRadius: 14))
                MessageFooter(text: text, timestamp: date)
            }
            .padding(.leading, 48)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

struct TaskReceiptCard: View {
    let task: FfiTaskSummary
    @Environment(\.colorScheme) private var appearance
    @Environment(\.connTheme) private var theme

    var body: some View {
        let row = taskReceiptRow(task: task, nowMs: Int64(Date.now.timeIntervalSince1970 * 1000))
        ThreadCard {
            Image(systemName: "checklist")
                .overlay(alignment: .topTrailing) { StatusBadgeDot(dot: row.dot).offset(x: 4, y: -4) }
            Text(row.detail).lineLimit(2)
            Spacer(minLength: 0)
            if let pr = row.pullRequest, let url = URL(string: pr.url), ["https", "http"].contains(url.scheme) {
                Link(destination: url) {
                    Label("#\(pr.number)", systemImage: pr.state == .merged ? "arrow.triangle.merge" : "arrow.triangle.pull")
                }
                .foregroundStyle(pr.state == .merged ? AdaptiveColor.violet600400.color(appearance) :
                    pr.state == .closed ? theme.destructive : AdaptiveColor.emerald700300.color(appearance))
            }
        } content: {
            Text(row.title).font(.system(size: 14, weight: .medium)).padding(11)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.accessibilityLabel)
    }
}

struct ProposedPlanCard: View {
    let title: String
    let markdown: String
    let display: String
    let streaming: Bool
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        ThreadCard {
            Label("Proposed plan", systemImage: "checklist")
            if streaming { KitStatusIcon(.working, size: 12, label: "Streaming") }
            Spacer()
            CopyTextButton(label: "Copy plan", text: markdown)
            Button { saving = true } label: { Image(systemName: "square.and.arrow.down").padding(6) }
                .accessibilityLabel("Save plan")
        } content: {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline)
                MarkdownView(source: display)
                if let error { Text(error).font(.caption) }
            }.padding(11)
        }
        .fileExporter(isPresented: $saving, document: MarkdownDocument(text: markdown),
                      contentType: MarkdownDocument.readableContentTypes[0], defaultFilename: "plan.md") { result in
            if case let .failure(failure) = result { error = failure.localizedDescription }
        }
    }
}
