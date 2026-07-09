import AppKit
import SwiftUI
import UniformTypeIdentifiers

// Floating glass composer — the primary text-entry surface for the selected
// thread. Chrome-only glass; the text itself is typed over an opaque
// TextEditor background so long drafts stay readable.
//
// Adornments: image attachments (wire cap: 8 files / 10 MB each),
// `@`-mention file search backed by projects.searchEntries, and a `/`
// command menu (mode built-ins + provider-native slash commands).
public struct ComposerBar: View {
    private let model: AppModel

    @UIState private var draft: String = ""
    @UIState private var attachments: [OutgoingAttachment] = []
    @UIState private var showFileImporter = false
    @UIState private var attachmentError: String?

    @UIState private var mentionResults: [WorkspaceEntry] = []
    @UIState private var mentionQuery: String?
    @UIState private var mentionSearchTask: Task<Void, Never>?

    @UIState private var showDictationDownloadPrompt = false
    @FocusState private var editorFocused: Bool

    private static let maxAttachments = 8
    private static let maxAttachmentBytes = 10 * 1024 * 1024

    public init(model: AppModel) {
        self.model = model
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool {
        (!trimmedDraft.isEmpty || !attachments.isEmpty) && model.connection == .ready
    }

    private var canQueue: Bool {
        isThreadRunning && canSend
    }

    private var isThreadRunning: Bool {
        model.selectedThread?.status == .running
    }

    /// The trailing button is one smart control: a stop button while the
    /// agent runs, a send button the moment there's something to send, and
    /// a grayed-out send button otherwise.
    private var showsStop: Bool {
        isThreadRunning && trimmedDraft.isEmpty && attachments.isEmpty
    }

    private var sendIconName: String {
        if showsStop { return "stop.fill" }
        return isThreadRunning ? "arrow.up.right.circle.fill" : "paperplane.fill"
    }

    private var sendHelp: String {
        if showsStop { return "Stop the current turn" }
        return isThreadRunning ? "Send now - steers the running agent" : "Send message"
    }

    /// Provider slash commands + mode built-ins, filtered by the `/token`
    /// the draft currently starts with (nil when the draft isn't one).
    private var slashMatches: [SlashCommandItem]? {
        guard draft.hasPrefix("/"), !draft.contains("\n") else { return nil }
        let token = draft.dropFirst()
        guard !token.contains(" ") else { return nil }
        let query = token.lowercased()
        let builtIns = [
            SlashCommandItem(name: "plan", detail: "Switch this thread to plan mode", builtIn: .plan),
            SlashCommandItem(name: "default", detail: "Leave plan mode", builtIn: .normal),
        ]
        let provider = model.selectedThreadSlashCommands.map {
            SlashCommandItem(name: $0.name, detail: $0.detail, builtIn: nil)
        }
        let all = builtIns + provider
        let matches = query.isEmpty ? all : all.filter { $0.name.lowercased().hasPrefix(query) }
        return matches.isEmpty ? nil : matches
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let matches = slashMatches {
                SuggestionList(items: matches.map { item in
                    SuggestionRow(
                        id: "slash-\(item.name)", icon: "slash.circle",
                        title: "/\(item.name)", subtitle: item.detail
                    ) { applySlashCommand(item) }
                })
                .transition(Motion.pop(from: .bottomLeading))
            } else if let query = mentionQuery, !mentionResults.isEmpty {
                SuggestionList(items: mentionResults.map { entry in
                    SuggestionRow(
                        id: entry.id, icon: entry.isDirectory ? "folder" : "doc.text",
                        title: entry.path, subtitle: nil
                    ) { insertMention(entry, replacing: query) }
                })
                .transition(Motion.pop(from: .bottomLeading))
            }

            if !model.selectedQueuedMessages.isEmpty {
                QueuedMessagesStrip(
                    messages: model.selectedQueuedMessages,
                    onEdit: editQueuedMessage,
                    onSendNow: sendQueuedMessageNow,
                    onRemove: removeQueuedMessage
                )
                .transition(Motion.bannerDrop)
            }

            if let thread = model.selectedThread {
                ComposerControlsRow(thread: thread, model: model)
            }

            if !attachments.isEmpty {
                AttachmentChipsRow(attachments: attachments) { id in
                    attachments.removeAll { $0.id == id }
                }
                .transition(Motion.unfold)
            }

            if let attachmentError {
                Text(attachmentError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 4)
                    .transition(Motion.rise)
            }

            if let dictationError = model.dictation.lastError {
                Text(dictationError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 4)
                    .transition(Motion.rise)
            }

            GlassEffectContainer {
                HStack(alignment: .bottom, spacing: 10) {
                    Button {
                        showFileImporter = true
                    } label: {
                        Image(systemName: "paperclip")
                            .foregroundStyle(.secondary)
                            .alpineIconLabel()
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .disabled(attachments.count >= Self.maxAttachments)
                    .help("Attach images")

                    TextEditor(text: $draft)
                        .font(.body)
                        .focused($editorFocused)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 22, maxHeight: 120)
                        .fixedSize(horizontal: false, vertical: true)
                        .overlay(alignment: .topLeading) {
                            if draft.isEmpty {
                                // Matches NSTextView's text origin (no top
                                // inset, 5pt line-fragment padding) so the
                                // placeholder sits exactly where typed text
                                // appears.
                                Text("Message…  (@ to mention files, / for commands)")
                                    .font(.body)
                                    .foregroundStyle(.tertiary)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
                                    .transition(.opacity)
                            }
                        }
                        .padding(.vertical, 4)
                        .onChange(of: draft) { _, newValue in
                            updateMentionSearch(for: newValue)
                        }
                        // Enter sends (or accepts the top suggestion while a
                        // list is open); Option+Enter queues while a turn is
                        // running; Shift+Enter falls through to insert a newline.
                        .onKeyPress(keys: [.return]) { press in
                            // Caps Lock and keypad Enter report as modifiers
                            // but don't change intent — plain Enter still sends.
                            let semantic = press.modifiers.subtracting([.capsLock, .numericPad])
                            if semantic == .option {
                                if canQueue {
                                    queue()
                                    return .handled
                                }
                                return .ignored
                            }
                            guard semantic.isEmpty else { return .ignored }
                            if let first = slashMatches?.first {
                                applySlashCommand(first)
                                return .handled
                            }
                            if let query = mentionQuery, let first = mentionResults.first {
                                insertMention(first, replacing: query)
                                return .handled
                            }
                            // Swallow Enter when there's nothing to send so an
                            // empty draft doesn't collect stray newlines.
                            if canSend { send() }
                            return .handled
                        }

                    dictationButton

                    if canQueue {
                        Button {
                            queue()
                        } label: {
                            Image(systemName: "tray.and.arrow.down")
                                .alpineIconLabel()
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .keyboardShortcut(.return, modifiers: .option)
                        .help("Queue for next turn (Option-Return)")
                        .transition(Motion.materialize)
                    }

                    // While a draft claims the smart button for sending, stop
                    // stays reachable as its own compact control — a running
                    // turn must always be cancellable without discarding the
                    // draft.
                    if isThreadRunning && !showsStop {
                        Button {
                            Task { await model.cancelCurrentTurn() }
                        } label: {
                            Image(systemName: "stop.fill")
                                .alpineIconLabel()
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .tint(.red)
                        .keyboardShortcut(".", modifiers: .command)
                        .help("Stop the current turn")
                        .transition(Motion.materialize)
                    }

                    smartSendStopButton
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 10)
            }
            .glassEffect(.regular, in: .rect(cornerRadius: 25))
        }
        // One animation domain for the whole composer: draft edits drive the
        // editor's height growth and suggestion filtering; the other keys
        // cover async arrivals (mention results, staged files, errors).
        .animation(Motion.settle, value: draft)
        .animation(Motion.enter, value: mentionResults.map(\.id))
        .animation(Motion.enter, value: attachments.map(\.id))
        .animation(Motion.enter, value: model.selectedQueuedMessages.map(\.id))
        .animation(Motion.enter, value: attachmentError)
        .animation(Motion.enter, value: model.dictation.lastError)
        .animation(Motion.snap, value: isThreadRunning)
        .task {
            model.dictation.insertHandler = { text in
                appendDictated(text)
            }
        }
        .alert("Download dictation model?", isPresented: $showDictationDownloadPrompt) {
            Button("Download") { model.dictation.downloadModel() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Dictation runs fully on this Mac using the Parakeet v3 speech model — a one-time ~2.5 GB download."
            )
        }
        .alert("Microphone access needed", isPresented: micPermissionDeniedBinding) {
            Button("Open System Settings") { openMicrophonePrivacySettings() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Allow SurgeCode to use the microphone in Privacy & Security → Microphone.")
        }
        // Edit action on a sent message: load its text as the draft. An
        // in-progress draft is replaced — the edit gesture is explicit intent
        // to compose from the old message.
        .onChange(of: model.composerPrefill) { _, prefill in
            guard prefill != nil, let staged = model.takeComposerPrefill() else { return }
            draft = staged.text
            editorFocused = true
        }
        .fileImporter(
            isPresented: $showFileImporter, allowedContentTypes: [.image],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                attach(urls: urls)
            }
        }
    }

    @ViewBuilder
    private var smartSendStopButton: some View {
        styledSmartSendStopButton(active: showsStop || canSend)
            .disabled(!showsStop && !canSend)
            .keyboardShortcut(.return, modifiers: .command)
            .help(sendHelp)
            .animation(Motion.snap, value: canSend)
            .animation(Motion.snap, value: showsStop)
            .animation(Motion.snap, value: isThreadRunning)
    }

    @ViewBuilder
    private func styledSmartSendStopButton(active: Bool) -> some View {
        if active {
            smartSendStopBaseButton
                .buttonStyle(.glassProminent)
                .tint(showsStop ? .red : (isThreadRunning ? .orange : AlpineTheme.accent))
        } else {
            smartSendStopBaseButton
                .foregroundStyle(.secondary)
                .buttonStyle(.glass)
        }
    }

    private var smartSendStopBaseButton: some View {
        Button {
            if showsStop {
                Task { await model.cancelCurrentTurn() }
            } else {
                send()
            }
        } label: {
            Image(systemName: sendIconName)
                .contentTransition(.symbolEffect(.replace))
                .alpineIconLabel()
        }
        .buttonBorderShape(.circle)
    }

    // MARK: - Dictation

    private var isRecording: Bool {
        model.dictation.state == .recording
    }

    /// Mic control mirrors the smart send button's shape: one button whose
    /// icon, tint, and behavior track the dictation state machine.
    @ViewBuilder
    private var dictationButton: some View {
        let dictation = model.dictation
        Button {
            switch (dictation.state, dictation.modelStatus) {
            case (.recording, _), (.idle, .ready):
                dictation.toggleRecording()
            case (.idle, .notDownloaded):
                showDictationDownloadPrompt = true
            default:
                break
            }
        } label: {
            Group {
                switch (dictation.state, dictation.modelStatus) {
                case (_, .downloading(let fraction)):
                    ProgressView(value: fraction)
                        .progressViewStyle(.circular)
                        .controlSize(.small)
                case (.processing, _):
                    ProgressView()
                        .controlSize(.small)
                default:
                    dictationMicIcon
                        .contentTransition(.symbolEffect(.replace))
                        .symbolEffect(.pulse, isActive: isRecording && !Motion.reduceMotion)
                }
            }
            .alpineIconLabel()
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .tint(isRecording ? .red : nil)
        .disabled(
            dictation.state == .processing || dictation.modelStatus.isDownloading
        )
        .help(dictationHelp)
        .animation(Motion.snap, value: isRecording)
    }

    @ViewBuilder
    private var dictationMicIcon: some View {
        if isRecording {
            Image(systemName: "mic.fill")
                .foregroundStyle(.red)
        } else {
            Image(systemName: "mic")
                .foregroundStyle(.secondary)
        }
    }

    private var dictationHelp: String {
        switch (model.dictation.state, model.dictation.modelStatus) {
        case (.recording, _): "Stop dictating"
        case (.processing, _): "Transcribing…"
        case (_, .downloading): "Downloading the dictation model…"
        case (_, .notDownloaded): "Dictate (downloads the on-device speech model first)"
        default: "Dictate (on-device)"
        }
    }

    private var micPermissionDeniedBinding: Binding<Bool> {
        Binding(
            get: { model.dictation.micPermissionDenied },
            set: { model.dictation.micPermissionDenied = $0 })
    }

    private func openMicrophonePrivacySettings() {
        let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!
        NSWorkspace.shared.open(url)
    }

    private func appendDictated(_ text: String) {
        if draft.isEmpty {
            draft = text
        } else if draft.hasSuffix(" ") || draft.hasSuffix("\n") {
            draft += text
        } else {
            draft += " " + text
        }
    }

    // MARK: - Sending

    private func send() {
        guard canSend else { return }
        let text = trimmedDraft
        let outgoing = attachments
        clearSubmittedDraft()
        Task { await model.send(text: text, attachments: outgoing) }
    }

    private func queue() {
        guard canQueue else { return }
        let text = trimmedDraft
        let outgoing = attachments
        clearSubmittedDraft()
        model.enqueueMessage(text: text, attachments: outgoing)
    }

    private func editQueuedMessage(_ message: QueuedOutgoingMessage) {
        guard let threadID = model.selectedThreadID,
            let queued = model.takeQueuedMessage(id: message.id, from: threadID)
        else { return }
        draft = queued.text
        attachments = queued.attachments
        attachmentError = nil
        mentionQuery = nil
        mentionResults = []
        editorFocused = true
    }

    private func sendQueuedMessageNow(_ message: QueuedOutgoingMessage) {
        guard let threadID = model.selectedThreadID else { return }
        Task { await model.sendQueuedMessageNow(id: message.id, from: threadID) }
    }

    private func removeQueuedMessage(_ message: QueuedOutgoingMessage) {
        guard let threadID = model.selectedThreadID else { return }
        model.removeQueuedMessage(id: message.id, from: threadID)
    }

    private func clearSubmittedDraft() {
        draft = ""
        attachments = []
        attachmentError = nil
        mentionQuery = nil
        mentionResults = []
    }

    // MARK: - Slash commands

    private func applySlashCommand(_ item: SlashCommandItem) {
        switch item.builtIn {
        case .plan:
            draft = ""
            Task { await model.setInteractionMode(.plan) }
        case .normal:
            draft = ""
            Task { await model.setInteractionMode(.normal) }
        case nil:
            // Provider command: round-trips as plain message text.
            draft = "/\(item.name) "
        }
    }

    // MARK: - @-mentions

    /// Extracts the trailing `@token` being typed (nil when the caret isn't
    /// in one) and kicks a debounced workspace search.
    private func updateMentionSearch(for text: String) {
        mentionSearchTask?.cancel()
        guard let token = Self.trailingMentionToken(in: text) else {
            mentionQuery = nil
            mentionResults = []
            return
        }
        mentionQuery = token
        mentionSearchTask = Task {
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            let results = await model.searchWorkspace(query: String(token.dropFirst()))
            guard !Task.isCancelled else { return }
            mentionResults = results
        }
    }

    /// `"fix @app"` -> `"@app"`; nil when the draft doesn't end in an
    /// `@`-token (an `@` must start the draft or follow whitespace).
    static func trailingMentionToken(in text: String) -> String? {
        guard let atIndex = text.lastIndex(of: "@") else { return nil }
        if atIndex > text.startIndex {
            let before = text[text.index(before: atIndex)]
            guard before.isWhitespace || before.isNewline else { return nil }
        }
        let token = text[atIndex...]
        guard !token.contains(where: { $0.isWhitespace || $0.isNewline }) else { return nil }
        return String(token)
    }

    private func insertMention(_ entry: WorkspaceEntry, replacing token: String) {
        guard draft.hasSuffix(token) else { return }
        draft = String(draft.dropLast(token.count)) + "@" + entry.path + " "
        mentionQuery = nil
        mentionResults = []
    }

    // MARK: - Attachments

    private func attach(urls: [URL]) {
        attachmentError = nil
        for url in urls {
            guard attachments.count < Self.maxAttachments else {
                attachmentError = "At most \(Self.maxAttachments) attachments per message."
                break
            }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                attachmentError = "Could not read \(url.lastPathComponent)."
                continue
            }
            guard data.count <= Self.maxAttachmentBytes else {
                attachmentError = "\(url.lastPathComponent) is over the 10 MB attachment limit."
                continue
            }
            let mimeType =
                UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/png"
            guard mimeType.hasPrefix("image/") else {
                attachmentError = "\(url.lastPathComponent) is not an image."
                continue
            }
            attachments.append(
                OutgoingAttachment(
                    id: UUID().uuidString, name: url.lastPathComponent, mimeType: mimeType,
                    sizeBytes: data.count,
                    dataURL: "data:\(mimeType);base64,\(data.base64EncodedString())"))
        }
    }
}

// MARK: - Pieces

private enum BuiltInSlashAction {
    case plan, normal
}

private struct SlashCommandItem {
    var name: String
    var detail: String?
    var builtIn: BuiltInSlashAction?
}

private struct SuggestionRow: Identifiable {
    var id: String
    var icon: String
    var title: String
    var subtitle: String?
    var action: () -> Void
}

/// Shared popover-style list for slash-command and mention suggestions.
private struct SuggestionList: View {
    let items: [SuggestionRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items.prefix(8)) { item in
                Button(action: item.action) {
                    HStack(spacing: 8) {
                        Image(systemName: item.icon)
                            .foregroundStyle(.secondary)
                            .frame(width: 16)
                        Text(item.title)
                            .font(.callout)
                            .lineLimit(1)
                        if let subtitle = item.subtitle, !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
            }
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary, lineWidth: 1))
    }
}

/// Per-thread outgoing queue, shown above the composer input.
private struct QueuedMessagesStrip: View {
    let messages: [QueuedOutgoingMessage]
    let onEdit: (QueuedOutgoingMessage) -> Void
    let onSendNow: (QueuedOutgoingMessage) -> Void
    let onRemove: (QueuedOutgoingMessage) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "tray.and.arrow.down")
                    .font(.callout)
                    .foregroundStyle(Color.accentColor)
                Text("Queued for next turn")
                    .font(.callout.weight(.semibold))
                Text("\(messages.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                Spacer(minLength: 8)
            }

            ForEach(messages) { message in
                QueuedMessageRow(
                    message: message,
                    onEdit: { onEdit(message) },
                    onSendNow: { onSendNow(message) },
                    onRemove: { onRemove(message) })
            }
        }
        .padding(10)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .accessibilityIdentifier("queued-messages-strip")
    }
}

private struct QueuedMessageRow: View {
    let message: QueuedOutgoingMessage
    let onEdit: () -> Void
    let onSendNow: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 16)

            Button(action: onEdit) {
                HStack(spacing: 6) {
                    Text(summary)
                        .font(.callout)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if !message.attachments.isEmpty {
                        Label("\(message.attachments.count)", systemImage: "photo")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Edit queued message")

            Button(action: onSendNow) {
                Image(systemName: "arrow.up.right.circle.fill")
            }
            .buttonStyle(.plain)
            .help("Send now - steers the running agent")

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Remove queued message")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color(nsColor: .textBackgroundColor).opacity(0.9), in: RoundedRectangle(cornerRadius: 8))
        .transition(Motion.rise)
    }

    private var summary: String {
        let compact = message.text
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !compact.isEmpty { return compact }
        if message.attachments.count == 1, let attachment = message.attachments.first {
            return attachment.name
        }
        return "\(message.attachments.count) attachments"
    }
}

/// Horizontal strip of staged attachments with remove buttons.
private struct AttachmentChipsRow: View {
    let attachments: [OutgoingAttachment]
    let onRemove: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments) { attachment in
                    HStack(spacing: 4) {
                        Image(systemName: "photo")
                            .font(.caption)
                        Text(attachment.name)
                            .font(.caption)
                            .lineLimit(1)
                        Button {
                            onRemove(attachment.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.quaternary.opacity(0.5), in: Capsule())
                    .transition(Motion.materialize)
                }
            }
            .padding(.horizontal, 4)
        }
    }
}
