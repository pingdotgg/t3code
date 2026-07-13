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
    private let accent: Color

    @UIState private var showFileImporter = false
    @UIState private var fileImporterThreadID: String?
    @UIState private var attachmentError: String?

    @UIState private var mentionResults: [WorkspaceEntry] = []
    @UIState private var mentionQuery: String?
    @UIState private var mentionSearchTask: Task<Void, Never>?
    /// True while a mention search is in flight — lets the empty state
    /// distinguish "still searching" from "genuinely no matches".
    @UIState private var mentionSearchInFlight = false

    /// Keyboard-navigable index into whichever suggestion list is showing
    /// (slash commands or mentions). Reset whenever the list's contents change.
    @UIState private var highlightedSuggestionIndex = 0
    /// Set by Escape; suppresses the slash-command menu until the draft
    /// changes again (slash matches are derived from the draft text, so
    /// there's no independent "hide" state to clear otherwise).
    @UIState private var suggestionMenuDismissed = false

    @UIState private var attachmentEncodeTask: Task<Void, Never>?

    /// When set, the next send rewinds the origin thread to just before this
    /// message. Cleared on send, draft clear, or thread switch because edit
    /// identity is transient UI state and must never truncate the wrong thread.
    @UIState private var editedMessageID: String?
    @UIState private var editedMessageThreadID: String?

    @UIState private var showDictationDownloadPrompt = false
    @FocusState private var editorFocused: Bool

    // `nonisolated` so the background encode helpers (which run off the main
    // actor) can read these caps without hopping back to MainActor.
    nonisolated private static let maxAttachments = 8
    nonisolated private static let maxAttachmentBytes = 10 * 1024 * 1024

    public init(model: AppModel, accent: Color) {
        self.model = model
        self.accent = accent
    }

    private var draft: String {
        get {
            guard let threadID = model.selectedThreadID else { return "" }
            return model.composerDraft(for: threadID).text
        }
        nonmutating set {
            guard let threadID = model.selectedThreadID else { return }
            model.setComposerDraftText(newValue, for: threadID)
        }
    }

    private var draftBinding: Binding<String> {
        Binding(get: { draft }, set: { draft = $0 })
    }

    private var attachments: [OutgoingAttachment] {
        get {
            guard let threadID = model.selectedThreadID else { return [] }
            return model.composerDraft(for: threadID).attachments
        }
        nonmutating set {
            guard let threadID = model.selectedThreadID else { return }
            model.setComposerDraftAttachments(newValue, for: threadID)
        }
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
    /// the draft currently starts with (nil when the draft isn't one — this
    /// is distinct from an empty array, which means "in slash context but no
    /// command matches", so the menu can show a "No matches" row instead of
    /// vanishing).
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
        return query.isEmpty ? all : all.filter { $0.name.lowercased().hasPrefix(query) }
    }

    /// Unified rows for whichever suggestion menu is active (slash commands
    /// take priority over mentions, mirroring how they're mutually exclusive
    /// draft states). `nil` means no menu should show at all; an empty array
    /// means the menu is showing but has no matches. Each row's `action`
    /// already knows how to apply itself, so keyboard accept (Enter) doesn't
    /// need to re-derive slash-vs-mention branching.
    private var activeSuggestionRows: [SuggestionRow]? {
        guard !suggestionMenuDismissed else { return nil }
        if let matches = slashMatches {
            return matches.prefix(8).map { item in
                SuggestionRow(
                    id: "slash-\(item.name)", icon: "slash.circle",
                    title: "/\(item.name)", subtitle: item.detail
                ) { applySlashCommand(item) }
            }
        }
        if let query = mentionQuery, !mentionResults.isEmpty || !mentionSearchInFlight {
            return mentionResults.prefix(8).map { entry in
                SuggestionRow(
                    id: entry.id, icon: entry.isDirectory ? "folder" : "doc.text",
                    title: entry.path, subtitle: nil
                ) { insertMention(entry, replacing: query) }
            }
        }
        return nil
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let rows = activeSuggestionRows {
                SuggestionList(items: rows, highlightedIndex: highlightedSuggestionIndex)
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

            if let lastError = model.lastError {
                HStack(alignment: .top, spacing: 6) {
                    Text(lastError)
                        .font(.caption)
                        .foregroundStyle(.red)
                    Spacer(minLength: 8)
                    Button {
                        model.lastError = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss error")
                }
                .padding(.horizontal, 4)
                .transition(Motion.rise)
            }

            GlassEffectContainer {
                HStack(alignment: .bottom, spacing: 10) {
                    Button {
                        fileImporterThreadID = model.selectedThreadID
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
                    .accessibilityLabel("Attach images")

                    TextEditor(text: draftBinding)
                        .font(.body)
                        .focused($editorFocused)
                        .scrollContentBackground(.hidden)
                        // Keep editor transparent so composer remains one
                        // continuous Liquid Glass surface; draft field does
                        // not create a second light plate inside outer glass.
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
                            // A fresh keystroke always reopens whatever menu
                            // the new text implies, and starts highlighting
                            // from the top again.
                            suggestionMenuDismissed = false
                            highlightedSuggestionIndex = 0
                            updateMentionSearch(for: newValue)
                        }
                        .onChange(of: mentionResults.map(\.id)) { _, _ in
                            highlightedSuggestionIndex = 0
                        }
                        // Enter sends (or accepts the highlighted suggestion
                        // while a list is open); Option+Enter queues while a
                        // turn is running; Shift+Enter falls through to
                        // insert a newline.
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
                            if let rows = activeSuggestionRows, !rows.isEmpty {
                                let index = min(highlightedSuggestionIndex, rows.count - 1)
                                rows[index].action()
                                return .handled
                            }
                            // Swallow Enter when there's nothing to send so an
                            // empty draft doesn't collect stray newlines.
                            if canSend { send() }
                            return .handled
                        }
                        // Arrow keys move the highlight within an open
                        // suggestion menu; otherwise they're left alone so
                        // the editor's normal caret movement still works.
                        .onKeyPress(keys: [.upArrow, .downArrow]) { press in
                            guard let rows = activeSuggestionRows, !rows.isEmpty else {
                                return .ignored
                            }
                            if press.key == .downArrow {
                                highlightedSuggestionIndex = (highlightedSuggestionIndex + 1) % rows.count
                            } else {
                                highlightedSuggestionIndex =
                                    (highlightedSuggestionIndex - 1 + rows.count) % rows.count
                            }
                            return .handled
                        }
                        // Escape dismisses whichever suggestion menu is open
                        // without touching the draft text.
                        .onKeyPress(keys: [.escape]) { _ in
                            guard slashMatches != nil || mentionQuery != nil else { return .ignored }
                            dismissSuggestions()
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
                        .accessibilityLabel("Queue for next turn")
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
                        .accessibilityLabel("Stop the current turn")
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
        .animation(Motion.enter, value: model.lastError)
        .animation(Motion.snap, value: isThreadRunning)
        .task {
            model.dictation.insertHandler = { threadID, text in
                appendDictated(text, to: threadID)
            }
        }
        .onPasteCommand(of: [.image], perform: handlePasteProviders)
        .onDrop(of: [.image], isTargeted: nil, perform: handleDropProviders)
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
            editedMessageID = staged.editedMessageID
            editedMessageThreadID = staged.editedMessageThreadID
            if model.selectedThreadID == staged.threadID {
                editorFocused = true
            }
        }
        // Drafts persist per-thread. ComposerBar stays mounted across thread
        // switches, so only staged edit context and transient UI state drop.
        .onChange(of: model.selectedThreadID) { _, _ in
            resetTransientState()
            model.clearComposerPrefill()
        }
        // User wiped the draft: drop edit identity so a later unrelated
        // send is a normal append.
        .onChange(of: draft) { _, newValue in
            if newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                editedMessageID = nil
                editedMessageThreadID = nil
            }
        }
        .fileImporter(
            isPresented: $showFileImporter, allowedContentTypes: [.image],
            allowsMultipleSelection: true
        ) { result in
            let targetThreadID = fileImporterThreadID
            fileImporterThreadID = nil
            if case .success(let urls) = result, let targetThreadID {
                attach(urls: urls, to: targetThreadID)
            }
        }
    }

    @ViewBuilder
    private var smartSendStopButton: some View {
        styledSmartSendStopButton(active: showsStop || canSend)
            .disabled(!showsStop && !canSend)
            .keyboardShortcut(.return, modifiers: .command)
            .help(sendHelp)
            .accessibilityLabel(sendHelp)
            .animation(Motion.snap, value: canSend)
            .animation(Motion.snap, value: showsStop)
            .animation(Motion.snap, value: isThreadRunning)
    }

    @ViewBuilder
    private func styledSmartSendStopButton(active: Bool) -> some View {
        if active {
            smartSendStopBaseButton
                .buttonStyle(.glassProminent)
                .tint(showsStop ? .red : (isThreadRunning ? .orange : accent))
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
                dictation.toggleRecording(threadID: model.selectedThreadID)
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
        .accessibilityLabel(dictationHelp)
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

    /// Appends a finished dictation transcript to `threadID`'s draft — the
    /// thread selected when recording *started*, which may not be the
    /// currently selected thread anymore (see `DictationController`).
    private func appendDictated(_ text: String, to threadID: String) {
        let current = model.composerDraft(for: threadID).text
        let updated: String
        if current.isEmpty {
            updated = text
        } else if current.hasSuffix(" ") || current.hasSuffix("\n") {
            updated = current + text
        } else {
            updated = current + " " + text
        }
        model.setComposerDraftText(updated, for: threadID)
    }

    // MARK: - Sending

    private func send() {
        guard canSend, let threadID = model.selectedThreadID else { return }
        let submittedDraft = ComposerDraft(text: draft, attachments: attachments)
        let outgoingText = trimmedDraft
        let replacingID = editedMessageID
        let replacingThreadID = editedMessageThreadID
        model.clearComposerDraft(for: threadID)
        resetTransientState()
        // Mouse-driven sends (clicking the send button) leave the editor
        // unfocused otherwise, breaking the type-send-type flow.
        editorFocused = true
        Task {
            let sent = await model.send(
                threadID: threadID, text: outgoingText,
                attachments: submittedDraft.attachments,
                replacingMessageID: replacingID,
                replacingMessageThreadID: replacingThreadID)
            if sent {
                model.lastError = nil
            } else {
                model.restoreComposerDraft(submittedDraft, for: threadID)
            }
        }
    }

    private func queue() {
        guard canQueue else { return }
        let text = trimmedDraft
        let outgoing = attachments
        // Queued sends are deferred; an edit-resend must not silently become
        // an append later — drop the edit identity when queueing.
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
        mentionSearchInFlight = false
        suggestionMenuDismissed = false
        highlightedSuggestionIndex = 0
        // Queued messages are not yet on the server timeline — no revert.
        editedMessageID = nil
        editedMessageThreadID = nil
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
        guard let threadID = model.selectedThreadID else { return }
        model.clearComposerDraft(for: threadID)
        resetTransientState()
    }

    private func resetTransientState() {
        mentionSearchTask?.cancel()
        mentionSearchTask = nil
        mentionQuery = nil
        mentionResults = []
        mentionSearchInFlight = false
        showFileImporter = false
        fileImporterThreadID = nil
        attachmentEncodeTask?.cancel()
        attachmentEncodeTask = nil
        attachmentError = nil
        showDictationDownloadPrompt = false
        editedMessageID = nil
        editedMessageThreadID = nil
        suggestionMenuDismissed = false
        highlightedSuggestionIndex = 0
    }

    /// Escape: hide whichever suggestion menu is open. Mentions have real
    /// state to clear; slash matches are derived from the draft text, so
    /// they're hidden via `suggestionMenuDismissed` until the next keystroke.
    private func dismissSuggestions() {
        if mentionQuery != nil {
            mentionSearchTask?.cancel()
            mentionSearchTask = nil
            mentionQuery = nil
            mentionResults = []
            mentionSearchInFlight = false
        }
        suggestionMenuDismissed = true
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
        // A slash pick is mouse-driven (or Enter, which already keeps focus)
        // — restore it either way so typing continues without a re-click.
        editorFocused = true
    }

    // MARK: - @-mentions

    /// Extracts the trailing `@token` being typed (nil when the caret isn't
    /// in one) and kicks a debounced workspace search.
    private func updateMentionSearch(for text: String) {
        mentionSearchTask?.cancel()
        guard let token = Self.trailingMentionToken(in: text) else {
            mentionQuery = nil
            mentionResults = []
            mentionSearchInFlight = false
            return
        }
        mentionQuery = token
        mentionSearchInFlight = true
        mentionSearchTask = Task {
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            let results = await model.searchWorkspace(query: String(token.dropFirst()))
            guard !Task.isCancelled else { return }
            mentionResults = results
            mentionSearchInFlight = false
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

    /// Reads and base64-encodes files picked from the file importer. The
    /// actual work runs off the main actor (see `encodeFromFiles`) since
    /// `Data(contentsOf:)` + base64 on up to 8×10 MB files is slow enough to
    /// stall the UI if it ran here directly. A new call supersedes any
    /// in-flight one — its result is discarded once cancelled.
    private func attach(urls: [URL], to threadID: String) {
        attachmentEncodeTask?.cancel()
        attachmentError = nil
        attachmentEncodeTask = Task {
            let existingCount = model.composerDraft(for: threadID).attachments.count
            let (encoded, error) = await Self.encodeFromFiles(urls: urls, existingCount: existingCount)
            guard !Task.isCancelled else { return }
            if let error { attachmentError = error }
            guard !encoded.isEmpty else { return }
            let current = model.composerDraft(for: threadID).attachments
            model.setComposerDraftAttachments(current + encoded, for: threadID)
        }
    }

    /// Off-main-actor file read + base64 encode. `nonisolated` so calling it
    /// via `await` from the (actor-inferred) view hops off the main actor;
    /// only `Sendable` state (URLs, the two size/count constants) crosses in.
    nonisolated private static func encodeFromFiles(
        urls: [URL], existingCount: Int
    ) async -> (attachments: [OutgoingAttachment], error: String?) {
        var staged: [OutgoingAttachment] = []
        var error: String?
        var count = existingCount
        for url in urls {
            guard count < maxAttachments else {
                error = "At most \(maxAttachments) attachments per message."
                break
            }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                error = "Could not read \(url.lastPathComponent)."
                continue
            }
            guard data.count <= maxAttachmentBytes else {
                error = "\(url.lastPathComponent) is over the 10 MB attachment limit."
                continue
            }
            let mimeType =
                UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/png"
            guard mimeType.hasPrefix("image/") else {
                error = "\(url.lastPathComponent) is not an image."
                continue
            }
            staged.append(
                OutgoingAttachment(
                    id: UUID().uuidString, name: url.lastPathComponent, mimeType: mimeType,
                    sizeBytes: data.count,
                    dataURL: "data:\(mimeType);base64,\(data.base64EncodedString())"))
            count += 1
        }
        return (staged, error)
    }

    /// Off-main-actor encode for already-in-memory image bytes (paste/drop),
    /// reusing the same size/count caps as file attachments.
    nonisolated private static func encodeFromData(
        _ items: [(name: String, mimeType: String, data: Data)], existingCount: Int
    ) async -> (attachments: [OutgoingAttachment], error: String?) {
        var staged: [OutgoingAttachment] = []
        var error: String?
        var count = existingCount
        for item in items {
            guard count < maxAttachments else {
                error = "At most \(maxAttachments) attachments per message."
                break
            }
            guard item.data.count <= maxAttachmentBytes else {
                error = "\(item.name) is over the 10 MB attachment limit."
                continue
            }
            staged.append(
                OutgoingAttachment(
                    id: UUID().uuidString, name: item.name, mimeType: item.mimeType,
                    sizeBytes: item.data.count,
                    dataURL: "data:\(item.mimeType);base64,\(item.data.base64EncodedString())"))
            count += 1
        }
        return (staged, error)
    }

    /// Shared handler for pasted/dropped image providers: loads each
    /// provider's image bytes, then routes through the same encode + cap
    /// pipeline as file attachments.
    private func attachFromProviders(_ providers: [NSItemProvider], to threadID: String) {
        attachmentEncodeTask?.cancel()
        attachmentError = nil
        attachmentEncodeTask = Task {
            var items: [(name: String, mimeType: String, data: Data)] = []
            var loadError: String?
            for (index, provider) in providers.enumerated() {
                guard !Task.isCancelled else { return }
                let mimeType = Self.imageMIMEType(for: provider)
                do {
                    let data = try await Self.loadImageData(from: provider)
                    let ext = UTType(mimeType: mimeType)?.preferredFilenameExtension ?? "png"
                    let name = provider.suggestedName.map { "\($0).\(ext)" }
                        ?? "Pasted image \(index + 1).\(ext)"
                    items.append((name: name, mimeType: mimeType, data: data))
                } catch {
                    loadError = "Could not read a pasted or dropped image."
                }
            }
            guard !Task.isCancelled else { return }
            let existingCount = model.composerDraft(for: threadID).attachments.count
            let (encoded, encodeError) = await Self.encodeFromData(items, existingCount: existingCount)
            guard !Task.isCancelled else { return }
            attachmentError = encodeError ?? loadError
            guard !encoded.isEmpty else { return }
            let current = model.composerDraft(for: threadID).attachments
            model.setComposerDraftAttachments(current + encoded, for: threadID)
        }
    }

    /// This SDK only exposes `NSItemProvider`'s completion-handler
    /// `loadDataRepresentation(for:completionHandler:)` (the `async throws`
    /// overload isn't present), so bridge it manually. Deliberately *not*
    /// `nonisolated`: `NSItemProvider` isn't `Sendable`, and the actual load
    /// happens off-thread inside the framework regardless — this call just
    /// awaits the bridge, it doesn't block the main actor.
    private static func loadImageData(from provider: NSItemProvider) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadDataRepresentation(for: .image) { data, error in
                if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    private static func imageMIMEType(for provider: NSItemProvider) -> String {
        for identifier in provider.registeredTypeIdentifiers {
            if let type = UTType(identifier), type.conforms(to: .image), let mime = type.preferredMIMEType {
                return mime
            }
        }
        return "image/png"
    }

    private func handlePasteProviders(_ providers: [NSItemProvider]) {
        guard let threadID = model.selectedThreadID else { return }
        let imageProviders = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }
        guard !imageProviders.isEmpty, attachments.count < Self.maxAttachments else { return }
        attachFromProviders(imageProviders, to: threadID)
    }

    private func handleDropProviders(_ providers: [NSItemProvider]) -> Bool {
        guard let threadID = model.selectedThreadID else { return false }
        let imageProviders = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }
        guard !imageProviders.isEmpty, attachments.count < Self.maxAttachments else { return false }
        attachFromProviders(imageProviders, to: threadID)
        return true
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
/// `highlightedIndex` tracks arrow-key navigation; an empty `items` renders a
/// "No matches" placeholder instead of vanishing (mirrors
/// `ModelPickerPopover`'s empty state).
private struct SuggestionList: View {
    let items: [SuggestionRow]
    let highlightedIndex: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty {
                Text("No matches")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
            } else {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
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
                        .background {
                            if index == highlightedIndex {
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(.fill.secondary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
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

    // Mirrors AppModel's private `maxQueuedSendAttempts` (3) — that constant
    // isn't reachable from here, so the threshold is duplicated. Queued
    // sends stop auto-retrying once `sendAttempts` reaches it.
    private static let maxSendAttempts = 3

    private var failedToSend: Bool {
        message.sendAttempts >= Self.maxSendAttempts
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: failedToSend ? "exclamationmark.triangle.fill" : "clock")
                .font(.caption)
                .foregroundStyle(failedToSend ? .red : .secondary)
                .frame(width: 16)

            Button(action: onEdit) {
                HStack(spacing: 6) {
                    Text(summary)
                        .font(.callout)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if failedToSend {
                        Text("Failed to send")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.red)
                    }
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
            .accessibilityLabel("Edit queued message")

            // Send-now doubles as the retry affordance once auto-retries are
            // exhausted — the message stays queued either way.
            Button(action: onSendNow) {
                Image(systemName: "arrow.up.right.circle.fill")
            }
            .buttonStyle(.plain)
            .help(failedToSend ? "Retry send" : "Send now - steers the running agent")
            .accessibilityLabel(failedToSend ? "Retry send" : "Send now")

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Remove queued message")
            .accessibilityLabel("Remove queued message")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            failedToSend
                ? AnyShapeStyle(Color.red.opacity(0.12))
                : AnyShapeStyle(Color.black.opacity(0.22)),
            in: RoundedRectangle(cornerRadius: 8)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(failedToSend ? Color.red.opacity(0.4) : Color.clear, lineWidth: 1)
        )
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
                        .help("Remove attachment")
                        .accessibilityLabel("Remove \(attachment.name)")
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
