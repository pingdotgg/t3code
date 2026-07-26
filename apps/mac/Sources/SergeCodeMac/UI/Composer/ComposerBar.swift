import AppKit
import SwiftUI
import UniformTypeIdentifiers

// Floating glass composer — the primary text-entry surface for the selected
// thread. Model/runtime controls and the editor share one visual container so
// the bottom of the window remains legible without covering the scenery.
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
    @UIState private var defersSuggestionWork = false
    /// Local Cmd+V monitor token while the composer text field is focused.
    @UIState private var pasteMonitor: Any?
    /// Host window of this composer, published by `ComposerWindowAnchor` so the
    /// Cmd+V monitor can tell its own window's key events from other windows'.
    @UIState private var windowBox = ComposerWindowBox()

    /// When set, the next send rewinds the origin thread to just before this
    /// message. Cleared on send, draft clear, or thread switch because edit
    /// identity is transient UI state and must never truncate the wrong thread.
    @UIState private var editedMessageID: String?
    @UIState private var editedMessageThreadID: String?

    @UIState private var showDictationDownloadPrompt = false
    @FocusState private var editorFocused: Bool

    /// Composer-level "create PR when done" toggle (see `AutoPRToggle` in
    /// ComposerControls.swift). When on, a fresh thread's first message gets
    /// `CreatePRPrompt.messageSuffix` appended before dispatch; the toggle is
    /// hidden and the suffix skipped once the thread has started.
    @AppStorage(CreatePRPrompt.autoCreateDefaultsKey) private var autoCreatePR = false

    // `nonisolated` so the background encode helpers (which run off the main
    // actor) can read these caps without hopping back to MainActor.
    nonisolated private static let maxAttachments = 8
    nonisolated private static let maxAttachmentBytes = 10 * 1024 * 1024
    /// Same wording `AttachmentFileEncoder` uses, so the paste, drop, and
    /// paperclip paths all explain the cap identically instead of two of them
    /// failing silently.
    nonisolated private static let capMessage = "At most \(maxAttachments) attachments per message."

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
        // `canSend` folds the connection in, so the disabled button has to say
        // which of the two reasons it is disabled for.
        if model.connection != .ready { return "Not connected — \(model.connection.statusText)" }
        return isThreadRunning ? "Send now - steers the running agent" : "Send message"
    }

    /// Provider slash commands + mode built-ins, filtered by the `/token`
    /// the draft currently starts with (nil when the draft isn't one — this
    /// is distinct from an empty array, which means "in slash context but no
    /// command matches", so the menu can show a "No matches" row instead of
    /// vanishing).
    private var slashMatches: [SlashCommandItem]? {
        guard !defersSuggestionWork else { return nil }
        guard draft.hasPrefix("/"), !draft.contains("\n") else { return nil }
        let token = draft.dropFirst()
        guard !token.contains(" ") else { return nil }
        let query = token.lowercased()
        let builtIns = [
            SlashCommandItem(name: "plan", detail: "Switch this thread to plan mode", builtIn: .plan),
            SlashCommandItem(
                name: "advisor",
                detail: "Ask without editing — the agent advises, it cannot change the workspace",
                builtIn: .advisor),
            SlashCommandItem(name: "default", detail: "Back to doing the work", builtIn: .normal),
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

    /// Split from `body` deliberately. The composer's chrome plus its ~20
    /// lifecycle/animation modifiers used to be one expression, and the Swift
    /// type checker on the CI runner gave up on it ("unable to type-check this
    /// expression in reasonable time", reported against the innermost leaf —
    /// the `.fileImporter` closure). It solved fine on a newer local
    /// toolchain, so the release build broke without any local signal. Keeping
    /// the chrome and the behaviour modifiers as two smaller expressions keeps
    /// the constraint system well inside every toolchain's budget. Modifier
    /// order across the split is unchanged.
    public var body: some View {
        composerBehaviour(composerChrome)
    }

    private var composerChrome: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let rows = activeSuggestionRows {
                SuggestionList(items: rows, highlightedIndex: highlightedSuggestionIndex)
            }

            if !model.selectedQueuedMessages.isEmpty {
                QueuedMessagesStrip(
                    messages: model.selectedQueuedMessages,
                    onEdit: editQueuedMessage,
                    onSendNow: sendQueuedMessageNow,
                    onRemove: removeQueuedMessage
                )
                .transition(Motion.banner)
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

            if dictationOverlayVisible {
                DictationLiveOverlay(dictation: model.dictation)
                    .transition(Motion.banner)
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
                    // A disabled control has to state its reason; at the cap
                    // the button is the only place that can.
                    .help(attachments.count >= Self.maxAttachments ? Self.capMessage : "Attach images")
                    .accessibilityLabel(
                        attachments.count >= Self.maxAttachments ? Self.capMessage : "Attach images")

                    TextEditor(text: draftBinding)
                        .font(SurgeTypography.composer)
                        .focused($editorFocused)
                        .scrollContentBackground(.hidden)
                        // Keep the editor transparent so the composer remains
                        // one continuous glass surface instead of gaining a
                        // second plate behind the draft.
                        .frame(minHeight: 22, maxHeight: 120)
                        .fixedSize(horizontal: false, vertical: true)
                        .background(ComposerDropTargetConfigurator())
                        .background(ComposerWindowAnchor(box: windowBox))
                        .overlay(alignment: .topLeading) {
                            if draft.isEmpty {
                                // Matches NSTextView's text origin (no top
                                // inset, 5pt line-fragment padding) so the
                                // placeholder sits exactly where typed text
                                // appears.
                                Text("Message…  (@ files, / commands)")
                                    .font(SurgeTypography.composer)
                                    .foregroundStyle(.secondary)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
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
                                Haptics.play(.selection)
                                rows[index].action()
                                return .handled
                            }
                            // Swallow Enter when there's nothing to send so an
                            // empty draft doesn't collect stray newlines.
                            if canSend {
                                send()
                            } else if !trimmedDraft.isEmpty || !attachments.isEmpty {
                                // There *was* something to send — the connection
                                // is what blocked it, so say so instead of
                                // eating the key with no feedback at all.
                                model.lastError =
                                    "Not connected (\(model.connection.statusText)) — your draft is kept; press Return again once connected."
                            }
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
                            // Walking a suggestion list ticks per row; holding
                            // the arrow key is rate-limited by the throttle
                            // rather than buzzing.
                            Haptics.play(.selection)
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
                            Haptics.play(.decision)
                            Task { await model.cancelCurrentTurn() }
                        } label: {
                            Image(systemName: "stop.fill")
                                .alpineIconLabel()
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .tint(.red)
                        .help("Stop the current turn")
                        .accessibilityLabel("Stop the current turn")
                        .transition(Motion.materialize)
                    }

                    smartSendStopButton
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 4)
            .background(stopShortcutHolder)
        }
        .padding(12)
        .glassEffect(.regular, in: .rect(cornerRadius: AlpineTheme.Corners.composer))
        .shadow(color: .black.opacity(0.10), radius: 16, y: 6)
    }

    /// The composer's animation, haptic, and lifecycle modifiers. Applied to
    /// `composerChrome` by `body`; see the note there for why this is a
    /// separate expression.
    private func composerBehaviour(_ content: some View) -> some View {
        composerStateSync(composerDialogs(composerLifecycle(composerAnimations(content))))
    }

    // Typing and suggestion filtering are deliberately unanimated. Async
    // arrivals reveal independently without moving the entire composer on
    // every keystroke. Suggestion menus intentionally carry no transition
    // declaration — keyboard-frequency UI stays instant.
    //
    // Attachments finish encoding asynchronously (file import, paste, drop),
    // so the strip filling in is confirmed by feel as well as by sight.
    // Removals are silent — the user already knows.
    private func composerAnimations(_ content: some View) -> some View {
        content
            .animation(Motion.reveal, value: attachments.map(\.id))
            .animation(Motion.reveal, value: model.selectedQueuedMessages.map(\.id))
            .animation(Motion.reveal, value: attachmentError)
            .animation(Motion.reveal, value: model.dictation.lastError)
            .animation(Motion.reveal, value: dictationOverlayVisible)
            .animation(Motion.reveal, value: model.lastError)
            .animation(Motion.feedback, value: isThreadRunning)
            .haptic(.selection, trigger: attachments.count) { old, new in new > old }
            .haptic(.failure, trigger: attachmentError) { _, new in new != nil }
            .haptic(.failure, trigger: model.lastError) { _, new in new != nil }
    }

    private func composerLifecycle(_ content: some View) -> some View {
        content
            .task { installDictationHandlers() }
            .onPasteCommand(of: [.image], perform: handlePasteProviders)
            .onDrop(of: [.fileURL, .image], isTargeted: nil, perform: handleDropProviders)
            .onChange(of: editorFocused, syncPasteMonitor)
            .onAppear(perform: installPasteMonitorIfFocused)
            .onDisappear(perform: removePasteMonitor)
    }

    private func composerDialogs(_ content: some View) -> some View {
        content
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
    }

    private func composerStateSync(_ content: some View) -> some View {
        content
            .onChange(of: model.composerPrefill, applyComposerPrefill)
            .onChange(of: model.selectedThreadID, handleSelectedThreadChange)
            .onChange(of: draft, handleDraftChange)
            .fileImporter(
                isPresented: $showFileImporter, allowedContentTypes: [.image],
                allowsMultipleSelection: true, onCompletion: handleFileImport)
    }

    // MARK: Behaviour handlers
    //
    // These are named methods rather than inline closures on purpose. As
    // multi-statement closures inside the modifier chain they were type-checked
    // as part of one expression, which is what pushed `body` over the CI
    // toolchain's solver budget (see `body`). A method reference contributes a
    // single known type instead.

    private func installDictationHandlers() {
        defersSuggestionWork = ComposerPerformancePolicy.shouldDeferSuggestions(for: draft)
        model.dictation.insertHandler = { threadID, text in
            insertDictated(text, into: threadID)
        }
        model.dictation.replaceHandler = { threadID, original, replacement in
            replaceDictated(original, with: replacement, in: threadID)
        }
    }

    /// TextEditor's NSTextView owns Cmd+V and swallows image-only pastes
    /// before `.onPasteCommand` runs. Intercept while the composer editor is
    /// focused so screenshots and image files still attach.
    private func syncPasteMonitor(_ wasFocused: Bool, _ isFocused: Bool) {
        if isFocused {
            installPasteMonitor()
        } else {
            removePasteMonitor()
        }
    }

    private func installPasteMonitorIfFocused() {
        if editorFocused { installPasteMonitor() }
    }

    /// Edit action on a sent message: load its text as the draft. An
    /// in-progress draft is replaced — the edit gesture is explicit intent to
    /// compose from the old message.
    private func applyComposerPrefill(
        _ previous: AppModel.ComposerPrefill?, _ prefill: AppModel.ComposerPrefill?
    ) {
        guard prefill != nil, let staged = model.takeComposerPrefill() else { return }
        editedMessageID = staged.editedMessageID
        editedMessageThreadID = staged.editedMessageThreadID
        if model.selectedThreadID == staged.threadID {
            editorFocused = true
        }
    }

    /// Drafts persist per-thread. ComposerBar stays mounted across thread
    /// switches, so only staged edit context and transient UI state drop.
    private func handleSelectedThreadChange(_ previous: String?, _ next: String?) {
        resetTransientState()
        defersSuggestionWork = ComposerPerformancePolicy.shouldDeferSuggestions(for: draft)
        model.clearComposerPrefill()
    }

    /// User wiped the draft: drop edit identity so a later unrelated send is a
    /// normal append.
    private func handleDraftChange(_ previous: String, _ newValue: String) {
        defersSuggestionWork = ComposerPerformancePolicy.shouldDeferSuggestions(for: newValue)
        if newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            editedMessageID = nil
            editedMessageThreadID = nil
        }
    }

    private func handleFileImport(_ result: Result<[URL], any Error>) {
        let targetThreadID = fileImporterThreadID
        fileImporterThreadID = nil
        guard let targetThreadID else { return }
        guard case .success(let urls) = result else { return }
        attach(urls: urls, to: targetThreadID)
    }

    /// Cmd+. must cancel a running turn regardless of what the composer looks
    /// like. The visible stop controls take turns being mounted (compact
    /// button vs. smart button) and SwiftUI honors only one shortcut per view,
    /// so the shortcut lives here instead — mounted for the whole run.
    @ViewBuilder
    private var stopShortcutHolder: some View {
        if isThreadRunning {
            Button {
                Task { await model.cancelCurrentTurn() }
            } label: {
                EmptyView()
            }
            .buttonStyle(.plain)
            .keyboardShortcut(".", modifiers: .command)
            .frame(width: 0, height: 0)
            .clipped()
            .opacity(0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private var smartSendStopButton: some View {
        styledSmartSendStopButton(active: showsStop || canSend)
            .disabled(!showsStop && !canSend)
            .keyboardShortcut(.return, modifiers: .command)
            .help(sendHelp)
            .accessibilityLabel(sendHelp)
            // `canSend` follows typing and must update immediately.
            .animation(Motion.feedback, value: showsStop)
            .animation(Motion.feedback, value: isThreadRunning)
    }

    @ViewBuilder
    private func styledSmartSendStopButton(active: Bool) -> some View {
        if active {
            smartSendStopBaseButton
                .buttonStyle(.glassProminent)
                .tint(showsStop ? .red : (isThreadRunning ? AlpineTheme.clay : accent))
        } else {
            smartSendStopBaseButton
                .foregroundStyle(.secondary)
                .buttonStyle(.glass)
        }
    }

    private var smartSendStopBaseButton: some View {
        Button {
            if showsStop {
                Haptics.play(.decision)
                Task { await model.cancelCurrentTurn() }
            } else {
                send()
            }
        } label: {
            Image(systemName: sendIconName)
                .contentTransition(
                    Motion.reduceMotion ? .identity : .symbolEffect(.replace))
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
                // FluidAudio reports `fractionCompleted` per sub-download, so a
                // determinate ring visibly runs backwards each time the next
                // file starts. Spin indeterminately instead.
                case (_, .downloading):
                    ProgressView()
                        .controlSize(.small)
                case (.processing, _):
                    ProgressView()
                        .controlSize(.small)
                default:
                    dictationMicIcon
                        .contentTransition(
                            Motion.reduceMotion ? .identity : .symbolEffect(.replace))
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
        .animation(Motion.feedback, value: isRecording)
        // Dictation is the one mode where the user's eyes may be off the
        // screen: opening and closing the mic is felt, not just seen. Silence
        // detection ends recording on its own, so this is keyed on the state
        // rather than on the button press.
        .haptic(.toggle, trigger: isRecording)
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
        case (.processing, _): "Finishing dictation…"
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

    /// Whether the live dictation surface is showing: recording, finalizing,
    /// or polishing already-inserted text.
    private var dictationOverlayVisible: Bool {
        model.dictation.state != .idle || model.dictation.isPolishing
    }

    /// Inserts a finished dictation transcript into `threadID`'s draft — the
    /// thread selected when recording *started*, which may not be the
    /// currently selected thread anymore (see `DictationController`).
    private func insertDictated(_ text: String, into threadID: String) {
        // The transcript landing in the draft is the payoff of the recording;
        // it arrives asynchronously, so it announces itself.
        Haptics.play(.selection)
        let current = model.composerDraft(for: threadID).text
        model.setComposerDraftText(DictationDraft.appending(text, to: current), for: threadID)
    }

    /// Swaps the raw transcript for the polished one in place. A miss — the
    /// user edited or sent the raw text in the meantime — is a no-op by
    /// design (see `DictationDraft.replacingLastOccurrence`).
    private func replaceDictated(_ original: String, with replacement: String, in threadID: String) {
        let current = model.composerDraft(for: threadID).text
        guard
            let updated = DictationDraft.replacingLastOccurrence(
                of: original, with: replacement, in: current)
        else { return }
        model.setComposerDraftText(updated, for: threadID)
    }

    // MARK: - Sending

    /// The text actually dispatched for a draft: the user's words plus, when
    /// the auto-PR toggle is on and the thread hasn't started yet, the
    /// instruction to open a PR once the work is finished. Never appended to
    /// an empty (attachment-only) message or to follow-ups on a thread that
    /// already has messages.
    private func outgoingText(for trimmedDraft: String) -> String {
        guard autoCreatePR, !trimmedDraft.isEmpty, model.selectedThread?.hasStarted == false
        else { return trimmedDraft }
        return trimmedDraft + CreatePRPrompt.messageSuffix
    }

    private func send() {
        guard canSend, let threadID = model.selectedThreadID else { return }
        // Dispatch is felt at the keystroke, not after the round trip — the
        // draft has already left the composer by the time the server answers.
        Haptics.play(.commit)
        let submittedDraft = ComposerDraft(text: draft, attachments: attachments)
        let outgoingText = outgoingText(for: trimmedDraft)
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
            // `send` only sets `lastError` on failure, so a success must not
            // clear it — an unrelated error could have landed meanwhile.
            if !sent {
                model.restoreComposerDraft(submittedDraft, for: threadID)
            }
        }
    }

    private func queue() {
        guard canQueue else { return }
        Haptics.play(.commit)
        let text = outgoingText(for: trimmedDraft)
        let outgoing = attachments
        // Queued sends are deferred; an edit-resend must not silently become
        // an append later — drop the edit identity when queueing.
        clearSubmittedDraft()
        // Clicking the tray button unmounts it (canQueue goes false), so
        // without this the next follow-up needs a click back into the editor.
        editorFocused = true
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
        // Keep paste monitor while the editor stays focused across thread
        // switches; only drop it when focus leaves (onChange) or the view
        // disappears.
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
        case .some(let mode):
            draft = ""
            Task { await model.setInteractionMode(mode) }
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
        guard !ComposerPerformancePolicy.shouldDeferSuggestions(for: text) else {
            mentionQuery = nil
            mentionResults = []
            mentionSearchInFlight = false
            return
        }
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

    /// Reads and base64-encodes files picked from the file importer or
    /// dropped onto the composer. Validation and encoding run off the main
    /// actor in `AttachmentFileEncoder` since `Data(contentsOf:)` + base64 on
    /// up to 8×10 MB files is slow enough to stall the UI if it ran here
    /// directly. A new call supersedes any in-flight one — its result is
    /// discarded once cancelled.
    private func attach(urls: [URL], to threadID: String) {
        attachmentEncodeTask?.cancel()
        attachmentError = nil
        attachmentEncodeTask = Task {
            let existing = model.composerDraft(for: threadID).attachments
            let (encoded, error) = await AttachmentFileEncoder.encodeFromFiles(
                urls: urls, existing: existing,
                maxAttachments: Self.maxAttachments,
                maxAttachmentBytes: Self.maxAttachmentBytes)
            guard !Task.isCancelled else { return }
            if let error { attachmentError = error }
            guard !encoded.isEmpty else { return }
            let current = model.composerDraft(for: threadID).attachments
            // Re-check cap against any concurrent attach (paste monitor).
            let room = max(0, Self.maxAttachments - current.count)
            guard room > 0 else { return }
            model.setComposerDraftAttachments(
                current + Array(encoded.prefix(room)), for: threadID)
        }
    }

    /// Shared handler for pasted/dropped image providers: loads each
    /// provider's image bytes, then routes through the same encode + cap
    /// pipeline as file attachments.
    private func attachFromProviders(_ providers: [NSItemProvider], to threadID: String) {
        attachmentEncodeTask?.cancel()
        attachmentError = nil
        attachmentEncodeTask = Task {
            var loadError: String?
            var encodedAttachments: [OutgoingAttachment] = []
            let existingCount = model.composerDraft(for: threadID).attachments.count
            for (index, provider) in providers.enumerated() {
                guard !Task.isCancelled else { return }
                guard existingCount + encodedAttachments.count < Self.maxAttachments else {
                    loadError = "At most \(Self.maxAttachments) attachments per message."
                    break
                }
                let mimeType = Self.imageMIMEType(for: provider)
                do {
                    let data = try await Self.loadImageData(from: provider)
                    let ext = UTType(mimeType: mimeType)?.preferredFilenameExtension ?? "png"
                    let name = provider.suggestedName.map { "\($0).\(ext)" }
                        ?? "Pasted image \(index + 1).\(ext)"
                    let (encoded, encodeError) = await AttachmentFileEncoder.encodeFromData(
                        [(name: name, mimeType: mimeType, data: data)],
                        existingCount: existingCount + encodedAttachments.count,
                        maxAttachments: Self.maxAttachments,
                        maxAttachmentBytes: Self.maxAttachmentBytes)
                    if let encodeError {
                        loadError = encodeError
                    }
                    encodedAttachments.append(contentsOf: encoded)
                } catch {
                    loadError = "Could not read a pasted or dropped image."
                }
            }
            guard !Task.isCancelled else { return }
            attachmentError = loadError
            guard !encodedAttachments.isEmpty else { return }
            let current = model.composerDraft(for: threadID).attachments
            // Re-check cap against any concurrent attach (paste monitor).
            let room = max(0, Self.maxAttachments - current.count)
            guard room > 0 else { return }
            model.setComposerDraftAttachments(
                current + Array(encodedAttachments.prefix(room)), for: threadID)
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
        guard !imageProviders.isEmpty else { return }
        guard attachments.count < Self.maxAttachments else {
            attachmentError = Self.capMessage
            return
        }
        attachFromProviders(imageProviders, to: threadID)
    }

    /// Drop entry point for the composer (`.onDrop(of: [.fileURL, .image])`).
    /// Dragged files become real attachments through the same pipeline as the
    /// paperclip picker — claimed here so the editor never falls back to
    /// inserting the file's absolute path as text. Dragged text and non-file
    /// URLs carry no `.fileURL` payload, so returning false for them preserves
    /// normal text insertion.
    private func handleDropProviders(_ providers: [NSItemProvider]) -> Bool {
        guard let threadID = model.selectedThreadID else { return false }
        // A dragged image *file* conforms to both .fileURL and .image; check
        // files first so it attaches via its URL instead of re-encoded bytes.
        let fileProviders = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
        }
        guard fileProviders.isEmpty else {
            attachDroppedFiles(fileProviders, to: threadID)
            return true
        }
        let imageProviders = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }
        guard !imageProviders.isEmpty else { return false }
        guard attachments.count < Self.maxAttachments else {
            attachmentError = Self.capMessage
            // Claim the drop anyway: the text view has image drags unregistered
            // (see ComposerDropTargetConfigurator), so declining would just
            // drop the image on the floor with no explanation.
            return true
        }
        attachFromProviders(imageProviders, to: threadID)
        return true
    }

    /// Loads the file URL from each dropped item in drop order (deterministic
    /// attachment ordering), then routes them through `attach(urls:to:)`.
    /// Items that fail to yield a URL are skipped; a drop with no usable URLs
    /// (e.g. a cancelled drag) leaves the draft untouched.
    private func attachDroppedFiles(_ providers: [NSItemProvider], to threadID: String) {
        Task {
            var urls: [URL] = []
            for provider in providers {
                if let url = try? await Self.loadFileURL(from: provider) {
                    urls.append(url)
                }
            }
            guard !Task.isCancelled, !urls.isEmpty else { return }
            attach(urls: urls, to: threadID)
        }
    }

    /// Same bridging constraint as `loadImageData`: this SDK only exposes the
    /// completion-handler overload, and `NSItemProvider` isn't `Sendable`, so
    /// this stays on the caller's actor — the load itself runs inside the
    /// framework off the calling thread.
    private static func loadFileURL(from provider: NSItemProvider) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { item, error in
                if let url = item {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    /// Cmd+V while the draft editor is focused: claim image pasteboards so
    /// they become attachments instead of no-ops (or accidental text pastes).
    /// Captures only the class-bound `AppModel` and the attachment-error
    /// `Binding` (shared `State` storage, not the View struct) — the View
    /// struct itself is not shared with the escaping monitor closure.
    private func installPasteMonitor() {
        removePasteMonitor()
        let model = self.model
        let attachmentError = $attachmentError
        let windowBox = self.windowBox
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            // A local monitor sees key-downs for every window in the process.
            // Sibling AppKit windows (New Session, Settings, About) live
            // outside this scene, so their pastes must be handed straight back.
            guard let composerWindow = windowBox.window, event.window === composerWindow else {
                return event
            }
            let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
            guard flags == .command,
                event.charactersIgnoringModifiers?.lowercased() == "v"
            else { return event }
            guard let threadID = model.selectedThreadID else { return event }
            let existingCount = model.composerDraft(for: threadID).attachments.count
            // Everything below runs inline in key-event dispatch, and reading
            // the pasteboard means disk reads plus a hash of every byte — so
            // probe the flavors first, and never read more images than there
            // is room for (one, just to tell an image paste from a text one,
            // when the draft is already at the cap).
            let probe: [NSPasteboard.PasteboardType] = [
                .png, .tiff, .fileURL, NSPasteboard.PasteboardType("public.jpeg"),
            ]
            guard NSPasteboard.general.availableType(from: probe) != nil else { return event }
            let room = ComposerBar.maxAttachments - existingCount
            let images = Pasteboard.imagePayloads(limit: max(1, room))
            guard !images.isEmpty else { return event }
            guard room > 0 else {
                attachmentError.wrappedValue = ComposerBar.capMessage
                return nil
            }
            Task { @MainActor in
                let (encoded, encodeError) = await AttachmentFileEncoder.encodeFromData(
                    images, existingCount: existingCount,
                    maxAttachments: ComposerBar.maxAttachments,
                    maxAttachmentBytes: ComposerBar.maxAttachmentBytes)
                // Surface encoder failures (oversized/undecodable images) the
                // same way the file/drop attach paths do.
                attachmentError.wrappedValue = encodeError
                guard !encoded.isEmpty else { return }
                let current = model.composerDraft(for: threadID).attachments
                // Re-check cap against any concurrent attach (paperclip/drop).
                let room = max(0, ComposerBar.maxAttachments - current.count)
                guard room > 0 else { return }
                model.setComposerDraftAttachments(
                    current + Array(encoded.prefix(room)), for: threadID)
            }
            return nil
        }
    }

    private func removePasteMonitor() {
        if let pasteMonitor {
            NSEvent.removeMonitor(pasteMonitor)
            self.pasteMonitor = nil
        }
    }
}

// MARK: - Window identity

/// Mutable box so the escaping Cmd+V monitor closure can read the composer's
/// current window without capturing the View struct. Weak: a closed window must
/// not be kept alive by a stale monitor.
@MainActor private final class ComposerWindowBox {
    weak var window: NSWindow?
}

/// Publishes the composer's host window into `ComposerWindowBox`. The window is
/// only ever overwritten with a real one — on teardown the box's weak reference
/// clears itself, so a transient detach can't leave a bogus identity behind.
private struct ComposerWindowAnchor: NSViewRepresentable {
    let box: ComposerWindowBox

    func makeNSView(context: Context) -> NSView {
        let anchor = WindowReportingView(frame: .zero)
        anchor.box = box
        return anchor
    }

    func updateNSView(_ anchor: NSView, context: Context) {
        (anchor as? WindowReportingView)?.box = box
        if let window = anchor.window { box.window = window }
    }

    private final class WindowReportingView: NSView {
        weak var box: ComposerWindowBox?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { box?.window = window }
        }
    }
}

// MARK: - Drop-target configuration

/// SwiftUI's `TextEditor` is backed by an NSTextView that registers itself as
/// a drag destination for file URLs (and images). Left alone, a file dropped
/// on the composer is consumed by that text view — which inserts the file's
/// absolute path as text — before SwiftUI's `.onDrop` ever sees the drag.
/// This representable finds the backing text view once the composer is in a
/// window and narrows its drag registration to text formats only, so file and
/// image drops fall through to the composer's `.onDrop` and become real
/// attachments. Dragged text keeps working (`.string` stays registered), and
/// non-file URL drags from browsers still insert as text because those
/// pasteboards also carry a string representation.
private struct ComposerDropTargetConfigurator: NSViewRepresentable {
    /// Text formats the editor may still accept as drops. Deliberately no
    /// `.URL`: `public.file-url` conforms to `public.url`, so registering it
    /// would re-claim file drags and insert paths again.
    private static let textDragTypes: [NSPasteboard.PasteboardType] = [.string, .rtf, .rtfd, .html]

    func makeNSView(context: Context) -> NSView {
        let anchor = NSView(frame: .zero)
        DispatchQueue.main.async { Self.retuneEditorDragTypes(anchoredAt: anchor) }
        return anchor
    }

    func updateNSView(_ anchor: NSView, context: Context) {
        // SwiftUI rebuilds can swap or re-register the backing text view, so
        // the retune is idempotent and reapplied on updates.
        DispatchQueue.main.async { Self.retuneEditorDragTypes(anchoredAt: anchor) }
    }

    private static func retuneEditorDragTypes(anchoredAt anchor: NSView) {
        guard let textView = editorTextView(anchoredAt: anchor),
            textView.registeredDraggedTypes != textDragTypes
        else { return }
        textView.unregisterDraggedTypes()
        textView.registerForDraggedTypes(textDragTypes)
    }

    /// The anchor sits inside the composer's editor container, so the nearest
    /// ancestor subtree containing an NSTextView is the composer's own.
    /// Transcript text views live in sibling subtrees the climb never reaches
    /// because it stops at the first match.
    private static func editorTextView(anchoredAt anchor: NSView) -> NSTextView? {
        var ancestor = anchor.superview
        while let current = ancestor {
            if let textView = firstTextView(in: current) { return textView }
            ancestor = current.superview
        }
        return nil
    }

    private static func firstTextView(in view: NSView) -> NSTextView? {
        if let textView = view as? NSTextView { return textView }
        for subview in view.subviews {
            if let found = firstTextView(in: subview) { return found }
        }
        return nil
    }
}

// MARK: - Pieces

private struct SlashCommandItem {
    var name: String
    var detail: String?
    /// Non-nil for the built-in mode commands (`/plan`, `/advisor`, `/default`),
    /// which switch the thread's interaction mode instead of being sent as text.
    var builtIn: ThreadInteractionMode?
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
        .background(
            .regularMaterial,
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control))
        .overlay(
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.control)
                .stroke(.quaternary, lineWidth: 1))
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
                    .foregroundStyle(AlpineTheme.accent)
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
        .glassEffect(.regular, in: .rect(cornerRadius: AlpineTheme.Corners.card))
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

/// Horizontal strip of staged attachments with remove buttons and thumbnails.
private struct AttachmentChipsRow: View {
    let attachments: [OutgoingAttachment]
    let onRemove: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    HStack(spacing: 6) {
                        AttachmentChipThumbnail(dataURL: attachment.dataURL)
                        Text(attachment.name)
                            .font(.caption)
                            .lineLimit(1)
                            .frame(maxWidth: 120)
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
                    .padding(.leading, 4)
                    .padding(.trailing, 8)
                    .padding(.vertical, 4)
                    .background(.quaternary.opacity(0.5), in: Capsule())
                    .transition(Motion.materialize)
                }
            }
            .padding(.horizontal, 4)
        }
    }
}

private struct AttachmentChipThumbnail: View {
    let dataURL: String

    var body: some View {
        Group {
            if let image = Self.image(from: dataURL) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "photo")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 28, height: 28)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private static func image(from dataURL: String) -> NSImage? {
        guard let marker = dataURL.range(of: "base64,") else { return nil }
        guard let data = Data(base64Encoded: String(dataURL[marker.upperBound...])) else {
            return nil
        }
        return NSImage(data: data)
    }
}
