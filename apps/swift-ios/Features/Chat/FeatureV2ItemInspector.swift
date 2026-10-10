import SwiftUI
import UIKit

@MainActor
public protocol FeatureV2ItemInspecting: AnyObject {
    func inspectV2Item(threadID: String, source: OrchestrationV2TimelineMetadata) async throws -> OrchestrationV2TurnItem?
}

/// Owned by the thread view, so disclosure and fetched output survive cell reuse.
@MainActor
final class FeatureV2TimelineState: ObservableObject {
    struct Key: Hashable {
        var threadID: String
        var sourceThreadID: String
        var itemID: String
        var revision: String
        init(threadID: String, source: OrchestrationV2TimelineMetadata) {
            self.threadID = threadID
            sourceThreadID = source.sourceThreadID
            itemID = source.itemID
            revision = source.detailRevision
        }
    }
    enum DetailState: Equatable {
        case loading
        case loaded(JSONValue)
        case missing
        case failed(String)
    }
    @Published var expandedIDs: Set<String> = []
    @Published private(set) var details: [Key: DetailState] = [:]
    private var tasks: [Key: Task<Void, Never>] = [:]
    private var recency: [Key] = []

    func reset() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        details.removeAll()
        recency.removeAll()
        expandedIDs.removeAll()
    }

    func toggle(_ id: String) {
        if !expandedIDs.insert(id).inserted { expandedIDs.remove(id) }
    }

    func load(_ item: FeatureV2WorkItem, context: FeatureV2ItemInspectionContext, retry: Bool = false) async {
        guard FeatureV2ItemDetail.needsFetch(item.raw) else { return }
        let key = Key(threadID: context.threadID, source: item.source)
        if let task = tasks[key] { await task.value; return }
        if details[key] != nil && !retry { return }
        details[key] = .loading
        let task = Task { @MainActor [weak self] in
            let result: DetailState
            do {
                if let loaded = try await context.client.inspectV2Item(threadID: context.threadID, source: item.source) {
                    guard loaded.id == item.source.itemID, loaded.threadId == item.source.sourceThreadID else {
                        throw RPCError.protocolViolation("The tool result belongs to a different item.")
                    }
                    result = .loaded(loaded.raw)
                } else { result = .missing }
            } catch {
                result = .failed(error.localizedDescription)
            }
            guard !Task.isCancelled, let self else { return }
            details[key] = result
            tasks[key] = nil
            recency.removeAll { $0 == key }
            recency.append(key)
            while recency.count > 64 { details[recency.removeFirst()] = nil }
        }
        tasks[key] = task
        await task.value
    }
}

@MainActor
struct FeatureV2ItemInspectionContext {
    let threadID: String
    let client: any FeatureV2ItemInspecting
    let state: FeatureV2TimelineState
    var toolImages: FeatureToolOutputImageContext? = nil
    var providers: [FeatureProvider] = []
    /// Wire IDs; the parent scopes navigation to this context's environment.
    var onOpenThread: ((String) -> Void)? = nil
    var retryableRunIDs: Set<String> = []
    var onRetryWorkspacePreparation: ((String) -> Void)? = nil
}

struct FeatureV2WorkLogView: View {
    let message: FeatureMessage
    let context: FeatureV2ItemInspectionContext
    let imageContext: MarkdownImageContext?
    let attachmentContext: FeatureAttachmentContext?
    @ObservedObject private var state: FeatureV2TimelineState

    init(message: FeatureMessage, context: FeatureV2ItemInspectionContext,
         imageContext: MarkdownImageContext?, attachmentContext: FeatureAttachmentContext?) {
        self.message = message
        self.context = context
        self.imageContext = imageContext
        self.attachmentContext = attachmentContext
        self.state = context.state
    }

    var body: some View {
        let items = message.v2WorkItems ?? []
        if items.count == 1, let item = items.first {
            FeatureV2ItemInspector(item: item, context: context, imageContext: imageContext, attachmentContext: attachmentContext)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Button { state.toggle(message.id) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: state.expandedIDs.contains(message.id) ? "chevron.down" : "chevron.right")
                        Text(message.activeWorkLabel ?? message.toolName ?? "Work log")
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if state.expandedIDs.contains(message.id) {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(items) { item in
                            FeatureV2ItemInspector(item: item, context: context, imageContext: imageContext, attachmentContext: attachmentContext)
                        }
                    }
                    .padding(.leading, 10)
                }
            }
            .font(T3Typography.tool)
            .foregroundStyle(T3Colors.textSecondary)
        }
    }
}

struct FeatureV2ItemInspector: View {
    let item: FeatureV2WorkItem
    let context: FeatureV2ItemInspectionContext
    let imageContext: MarkdownImageContext?
    let attachmentContext: FeatureAttachmentContext?
    let title: String?
    @ObservedObject private var state: FeatureV2TimelineState

    init(item: FeatureV2WorkItem, context: FeatureV2ItemInspectionContext,
         imageContext: MarkdownImageContext?, attachmentContext: FeatureAttachmentContext?, title: String? = nil) {
        self.item = item
        self.context = context
        self.imageContext = imageContext
        self.attachmentContext = attachmentContext
        self.title = title
        self.state = context.state
    }

    private var expanded: Bool { state.expandedIDs.contains(item.id) }
    private var failure: Bool { item.indicatesFailure }
    private var warning: Bool { failure && item.raw["failure"]?["class"]?.stringValue == "usage_limit" }
    private var color: Color { warning ? T3Colors.warning : failure ? T3Colors.danger : T3Colors.textSecondary }

    var body: some View {
        let presentation = ToolActivityPresentation(payload: item.raw)
        VStack(alignment: .leading, spacing: 6) {
            Button { state.toggle(item.id) } label: {
                HStack(alignment: .top, spacing: 8) {
                    if failure { Image(systemName: "exclamationmark.triangle") }
                    else { FeatureToolActivityIcon(presentation: presentation, context: imageContext) }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(label).lineLimit(expanded || failure ? nil : 2)
                        if let source = presentation?.sourceName { Text(source) }
                        if ["approval_request", "user_input_request"].contains(item.source.itemType) {
                            Text((item.raw["requestStatus"]?.stringValue ?? item.source.status).capitalized)
                            if let decision = item.raw["decision"]?.stringValue { Text(decision.capitalized) }
                        }
                        if item.source.itemType == "error" {
                            Text(item.source.status.capitalized)
                            Text(item.raw["failure"]?["message"]?.stringValue ?? "")
                                .lineLimit(expanded ? nil : 4)
                            if let date = NativeTimestampParser.parse(item.raw["startedAt"]?.stringValue ?? item.source.updatedAt) {
                                Text(date, format: .dateTime.month(.abbreviated).day().hour().minute())
                            }
                            if let reset = item.raw["failure"]?["resetAt"]?.stringValue,
                               let date = NativeTimestampParser.parse(reset) {
                                Text("Resets \(date.formatted(date: .abbreviated, time: .shortened))")
                            }
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                }
                .frame(minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(color)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("v2-item-\(item.id)")

            if item.source.itemType == "handoff" {
                FeatureV2HandoffEndpoints(raw: item.raw, providers: context.providers)
            }
            if let runID = item.source.runID, context.retryableRunIDs.contains(runID),
               item.source.visibility == "local", item.source.status == "failed",
               item.raw["failure"]?["code"]?.stringValue == "workspace_preparation_failed",
               let retry = context.onRetryWorkspacePreparation {
                Button("Retry workspace preparation") { retry(runID) }.buttonStyle(.plain)
            }
            if expanded {
                FeatureV2ExpandedItem(item: item, context: context, imageContext: imageContext, attachmentContext: attachmentContext)
                    .task(id: FeatureV2TimelineState.Key(threadID: context.threadID, source: item.source)) {
                        await state.load(item, context: context)
                    }
            }
        }
        .font(T3Typography.tool)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .transaction { $0.animation = nil; $0.disablesAnimations = true }
    }

    private var label: String {
        if let title { return title }
        if item.source.itemType == "compaction" {
            if ["pending", "running", "waiting"].contains(item.source.status) { return "Compacting context" }
            if item.source.status == "failed" { return "Context compaction failed" }
            if let before = item.raw["beforeTokenCount"]?.v2Int, let after = item.raw["afterTokenCount"]?.v2Int {
                return "Context compacted: \(before.formatted()) → \(after.formatted()) tokens"
            }
            return "Context compacted"
        }
        if item.source.itemType == "reasoning" { return item.source.visibility == "local" && item.source.status == "running" ? "Thinking" : "Thought" }
        if item.source.itemType == "handoff" { return failure ? "Context handoff failed" : "Context handoff" }
        return item.title
    }
}

private struct FeatureV2ExpandedItem: View {
    @SwiftUI.Environment(\.featureThreadPresentationDismissal) private var presentationDismissal
    @State private var presentationID = UUID()
    @State private var fullOutputDidAppear = false
    let item: FeatureV2WorkItem
    let context: FeatureV2ItemInspectionContext
    let imageContext: MarkdownImageContext?
    let attachmentContext: FeatureAttachmentContext?
    @ObservedObject private var state: FeatureV2TimelineState
    @State private var fullText: String?
    @State private var formatted: FeatureV2FormattedItem?

    init(item: FeatureV2WorkItem, context: FeatureV2ItemInspectionContext,
         imageContext: MarkdownImageContext?, attachmentContext: FeatureAttachmentContext?) {
        self.item = item
        self.context = context
        self.imageContext = imageContext
        self.attachmentContext = attachmentContext
        self.state = context.state
    }

    private var detailState: FeatureV2TimelineState.DetailState? {
        state.details[.init(threadID: context.threadID, source: item.source)]
    }
    private var shown: JSONValue {
        if FeatureV2ItemDetail.needsFetch(item.raw), case let .loaded(raw) = detailState { return raw }
        return item.raw
    }
    private var complete: Bool { !FeatureV2ItemDetail.needsFetch(shown) }
    private var outputImages: [FeatureToolOutputImage] { FeatureToolOutputImages.images(shown) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let call = formatted?.call { textBlock(call, label: "Call") }
            if let body = formatted?.body {
                if item.source.itemType == "reasoning" || item.source.itemType == "proposed_plan" {
                    MarkdownMessageView(body, isStreaming: item.source.visibility == "local" && item.source.status == "running", imageContext: imageContext)
                } else { textBlock(body, label: nil) }
            }
            if let output = formatted?.output { textBlock(output, label: "Output") }
            FeatureToolOutputImagesView(images: outputImages, source: item.source, context: context.toolImages)
            if let exit = formatted?.exitLabel { Text(exit).foregroundStyle(T3Colors.danger) }
            if item.raw["responseCapability"]?["type"]?.stringValue == "not_resumable" {
                Text(item.raw["responseCapability"]?["reason"]?.stringValue ?? "This request can no longer receive a response.")
            }
            if !complete {
                switch detailState {
                case nil, .loading: Text("Loading output…")
                case .missing: retryLabel("Output is no longer available.")
                case let .failed(message): retryLabel("Could not load output: \(message)")
                case .loaded: retryLabel("The server still reports omitted content.")
                }
            } else if ["command_execution", "dynamic_tool"].contains(item.source.itemType), formatted != nil, formatted?.output == nil, outputImages.isEmpty {
                Text("No output.")
            }
            if let path = shown["viewedImagePath"]?.stringValue {
                MarkdownMessageView(FeatureWorkLogMedia.markdownSource(for: [path]), imageContext: imageContext)
            }
            ForEach(answerMessages) { answer in
                Text(answer.text).textSelection(.enabled)
                FeatureMessageAttachmentsView(attachments: answer.attachments, context: attachmentContext)
            }
            Button("Copy expanded details") {
                UIPasteboard.general.string = (formatted?.copyText ?? "")
                    + answerMessages.map { "\n\n\($0.text)" }.joined()
            }
            .buttonStyle(.plain)
            .disabled(!complete || formatted == nil)
        }
        .foregroundStyle(T3Colors.textSecondary)
        .textSelection(.enabled)
        .padding(.leading, 10)
        .task(id: shown) {
            formatted = nil
            let raw = shown
            let next = await Task.detached(priority: .userInitiated) { FeatureV2FormattedItem(raw: raw) }.value
            guard !Task.isCancelled else { return }
            formatted = next
        }
        .onChange(of: fullText != nil) { _, presented in
            if presented { presentationDismissal.onPresentationChange(presentationID, true) }
        }
        .onChange(of: presentationDismissal.requestID) { _, id in
            guard id != nil else { return }
            fullText = nil
            if !fullOutputDidAppear {
                presentationDismissal.onPresentationChange(presentationID, false)
            }
        }
        .sheet(isPresented: Binding(get: { fullText != nil }, set: { if !$0 { fullText = nil } }), onDismiss: {
            fullOutputDidAppear = false
            presentationDismissal.onPresentationChange(presentationID, false)
        }) {
            if let fullText {
                NavigationStack {
                    FeatureV2NativeOutputText(text: fullText)
                        .navigationTitle("Full output")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) { Button("Done") { self.fullText = nil } }
                            ToolbarItem(placement: .topBarTrailing) { Button("Copy") { UIPasteboard.general.string = fullText } }
                        }
                }
                .preferredColorScheme(.dark)
                .onAppear { fullOutputDidAppear = true }
            }
        }
    }

    @ViewBuilder private func textBlock(_ text: String, label: String?) -> some View {
        if let label { Text(label).foregroundStyle(T3Colors.textPrimary) }
        let excerpt = text.prefix(12_000)
        Text(String(excerpt))
            .font(T3Typography.tool).textSelection(.enabled).t3CodeTextSize()
        if excerpt.endIndex != text.endIndex {
            Button("Open full output") { fullText = text }
                .buttonStyle(.plain)
        }
    }

    private func retryLabel(_ label: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
            Button("Retry") { Task { await state.load(item, context: context, retry: true) } }.buttonStyle(.plain)
        }
    }

    private var answerMessages: [FeatureMessage] {
        FeatureV2ItemDetail.answers(shown, source: item.source)
    }
}

/// UIKit owns text layout and scrolling for large output; SwiftUI keeps a small inline excerpt.
private struct FeatureV2NativeOutputText: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .black
        view.textColor = .white
        view.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}

private struct FeatureV2HandoffEndpoints: View {
    let raw: JSONValue
    let providers: [FeatureProvider]
    @State private var selectedAccount: String?

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array((raw["fromModelSelections"]?.v2Array ?? []).enumerated()), id: \.offset) { _, model in
                endpoint(instanceID: model["instanceId"]?.stringValue ?? "", model: model["model"]?.stringValue)
            }
            Image(systemName: "arrow.right")
            endpoint(instanceID: raw["toProviderInstanceId"]?.stringValue ?? "", model: raw["toModel"]?.stringValue)
        }
        .font(T3Typography.supporting)
        .alert("Provider account", isPresented: Binding(get: { selectedAccount != nil }, set: { if !$0 { selectedAccount = nil } })) {
            Button("OK", role: .cancel) { selectedAccount = nil }
        } message: { Text(selectedAccount ?? "") }
    }

    private func endpoint(instanceID: String, model: String?) -> some View {
        let provider = providers.first { $0.id == instanceID }
        let modelName = provider?.models.first { $0.id == model }?.name ?? model
        return Button(modelName ?? provider?.name ?? instanceID) { selectedAccount = provider?.name ?? instanceID }
            .buttonStyle(.plain)
            .accessibilityHint("Show provider account")
    }
}


struct FeatureV2TurnFoldButton: View {
    let id: String
    let label: String
    @ObservedObject var state: FeatureV2TimelineState

    var body: some View {
        Button { state.toggle(id) } label: {
            Label(label, systemImage: state.expandedIDs.contains(id) ? "chevron.down" : "chevron.right")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(minHeight: T3Metrics.minimumTapTarget)
        }
        .buttonStyle(.plain)
        .accessibilityValue(state.expandedIDs.contains(id) ? "Expanded" : "Collapsed")
    }
}
