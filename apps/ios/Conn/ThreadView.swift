import DesignKit
import SwiftUI
import UIKit

struct ThreadView: View {
    @Bindable var store: CoreStore
    let threadId: String
    let initialTitle: String
    let initialProjectTitle: String?
    let initialBranch: String?
    let initialSettled: Bool
    let onOpenThread: (String) -> Void

    @Environment(\.connTheme) private var theme
    @State private var readingWindow: FfiThreadSnapshot?
    @State private var markers: [FfiPromptMarker] = []
    @State private var outlineQuery = ""
    @State private var showsOutline = false
    @State private var historyNotice: String?
    @State private var scrollTarget: String?
    @State private var historyRequest = UUID()
    @State private var viewport = TimelineViewport()
    @State private var prependAnchor: UnitPoint?
    @State private var requestedByScroll = false
    @State private var paging = false
    @State private var pageExhausted = false
    @State private var userScrolling = false
    @State private var stickToBottom = true
    @State private var settled: Bool
    @State private var showingRename = false
    @State private var renameDraft = ""
    /// The approval whose answer is on its way; its buttons stay off until the server answers.
    @State private var respondingApprovalId: String?
    /// Each open question's answers so far, by request id, then question id.
    @State private var questionDrafts: [String: [String: FfiQuestionDraft]] = [:]
    /// The step each open question shows, by request id.
    @State private var questionSteps: [String: Int] = [:]
    /// The question whose answers are on their way.
    @State private var respondingUserInputId: String?
    /// The step whose single-choice pick is about to move on (mobile's 200 ms).
    @State private var advancingStep: Int?
    @State private var advanceTask: Task<Void, Never>?
    @State private var viewHeight: CGFloat = 800

    /// This thread's composer text, kept in the store by thread id.
    private var draft: String {
        get { store.drafts[threadId] ?? "" }
        nonmutating set { store.drafts[threadId] = newValue.isEmpty ? nil : newValue }
    }

    private var draftBinding: Binding<String> {
        Binding(get: { draft }, set: { draft = $0 })
    }
    /// The chip's provider and the sheet; `model_picker` in conn-ffi builds both.
    @State private var modelPicker: FfiModelPicker?
    @State private var showingModelPicker = false

    init(
        store: CoreStore,
        threadId: String,
        initialTitle: String,
        initialProjectTitle: String?,
        initialBranch: String?,
        initialSettled: Bool,
        onOpenThread: @escaping (String) -> Void
    ) {
        self.store = store
        self.threadId = threadId
        self.initialTitle = initialTitle
        self.initialProjectTitle = initialProjectTitle
        self.initialBranch = initialBranch
        self.initialSettled = initialSettled
        self.onOpenThread = onOpenThread
        self._settled = State(initialValue: initialSettled)
    }

    private var snapshot: FfiThreadSnapshot? {
        if let readingWindow, readingWindow.threadId == threadId { return readingWindow }
        guard let current = store.openThread, current.threadId == threadId else { return nil }
        return current
    }

    /// An approval gives up height to the feed: at most 560pt, at least 160pt, and never more
    /// than the screen leaves above the composer (`derivePendingUserInputMaxHeight`).
    private var approvalMaxHeight: CGFloat {
        min(560, max(160, viewHeight - 140))
    }

    private var pendingQuestion: FfiPendingQuestion? { store.status == .connected ? snapshot?.pendingQuestion : nil }

    /// The open question's panel for its current step; the composer's text shows as the answer.
    private var questionPanelModel: FfiQuestionPanel? {
        guard let question = pendingQuestion else { return nil }
        return questionPanel(
            pending: question,
            step: UInt32(clamping: questionSteps[question.requestId] ?? 0),
            drafts: questionDrafts[question.requestId] ?? [:],
            typedAnswer: draft,
            responding: respondingUserInputId == question.requestId
        )
    }

    /// The panel leaves some of the feed in view above itself (`QUESTION_PANEL_FEED_PEEK`).
    private var questionMaxHeight: CGFloat {
        min(560, max(160, viewHeight - 140 - 96))
    }

    private func setQuestionStep(_ step: Int, for question: FfiPendingQuestion) {
        advanceTask?.cancel()
        advanceTask = nil
        advancingStep = nil
        questionSteps[question.requestId] = max(0, step)
    }

    private func selectQuestionOption(_ value: String, question: FfiPendingQuestion, panel: FfiQuestionPanel) {
        UISelectionFeedbackGenerator().selectionChanged()
        questionDrafts[question.requestId] = questionToggleOption(
            pending: question,
            questionId: panel.questionId,
            drafts: questionDrafts[question.requestId] ?? [:],
            value: value
        )
        guard panel.advancesOnPick else { return }
        advanceTask?.cancel()
        let step = Int(panel.step)
        advancingStep = step
        advanceTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            advanceTask = nil
            advancingStep = nil
            questionSteps[question.requestId] = step + 1
        }
    }

    private func submitQuestion(_ question: FfiPendingQuestion) {
        guard let answers = questionAnswers(
            pending: question,
            drafts: questionDrafts[question.requestId] ?? [:]
        ) else { return }
        respondingUserInputId = question.requestId
        Task {
            await store.respondUserInput(threadId: threadId, requestId: question.requestId, answers: answers)
            if respondingUserInputId == question.requestId {
                respondingUserInputId = nil
            }
        }
    }

    private func dismissQuestion(_ question: FfiPendingQuestion) {
        respondingUserInputId = question.requestId
        Task {
            await store.dismissUserInput(threadId: threadId, requestId: question.requestId)
            if respondingUserInputId == question.requestId {
                respondingUserInputId = nil
            }
        }
    }

    /// Text sent while a question is open answers it: the prompt box is the free-text answer.
    private func answerQuestion(with text: String, question: FfiPendingQuestion, panel: FfiQuestionPanel) {
        questionDrafts[question.requestId] = questionSetCustomAnswer(
            pending: question,
            questionId: panel.questionId,
            drafts: questionDrafts[question.requestId] ?? [:],
            text: text
        )
        draft = ""
        if panel.isLast {
            submitQuestion(question)
        } else {
            setQuestionStep(Int(panel.step) + 1, for: question)
        }
    }

    /// The composer's send button with no text: the next question, or the answers.
    private func runAnswerAction(question: FfiPendingQuestion, panel: FfiQuestionPanel) {
        if panel.isLast {
            submitQuestion(question)
        } else {
            setQuestionStep(Int(panel.step) + 1, for: question)
        }
    }

    private func respond(to approval: FfiPendingApproval, with decision: FfiApprovalDecision) {
        respondingApprovalId = approval.requestId
        Task {
            await store.respondApproval(
                threadId: threadId,
                requestId: approval.requestId,
                decision: decision
            )
            if respondingApprovalId == approval.requestId {
                respondingApprovalId = nil
            }
        }
    }

    private var displayTitle: String {
        if let title = snapshot?.title, !title.isEmpty { return title }
        return initialTitle.isEmpty ? "Thread" : initialTitle
    }

    private var displaySubtitle: String? {
        var parts: [String] = []
        if let project = initialProjectTitle, !project.isEmpty {
            parts.append(project)
        }
        let branch = snapshot?.branch ?? initialBranch
        if let branch, !branch.isEmpty {
            parts.append(branch)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var isWorking: Bool {
        snapshot?.working == true
    }

    private var hasDraft: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// With a question open, text answers it and an empty composer runs the answer action.
    private var overlayHasCards: Bool {
        snapshot?.pendingApprovals.first != nil || questionPanelModel != nil
            || (snapshot?.queuedCount ?? 0) > 0
            || historyNotice != nil || readingWindow != nil || store.status != .connected
    }

    private var composerCanSend: Bool {
        guard store.status == .connected, readingWindow == nil else { return false }
        guard let question = pendingQuestion, let panel = questionPanelModel else {
            return hasDraft && !store.isSending
        }
        if hasDraft {
            return panel.acceptsText && question.answerable
                && respondingUserInputId != question.requestId
        }
        return panel.answerActionReady
    }

    private var scrollFingerprint: String {
        guard let snapshot else { return "loading" }
        let last = snapshot.entries.last.map(entryFingerprint) ?? "empty"
        return "\(snapshot.entries.count):\(snapshot.working):\(snapshot.queuedCount):\(last)"
    }

    private func latest() {
        historyRequest = UUID()
        paging = false
        pageExhausted = false
        readingWindow = nil
        historyNotice = nil
        stickToBottom = true
        scrollTarget = "timeline-bottom"
    }

    private func readHistory(prompt: String? = nil) {
        guard let reader = store.offlineReader, var current = snapshot else { return }
        if prompt == nil && (paging || pageExhausted) { return }
        let request = UUID()
        historyRequest = request
        paging = true
        let online = store.status == .connected
        Task {
            defer { if request == historyRequest { paging = false } }
            do {
                if let prompt {
                    let window = try await reader.promptWindow(thread: threadId, id: prompt, online: online)
                    guard request == historyRequest, store.offlineReader === reader,
                          store.openThreadId == threadId else { return }
                    pageExhausted = window.serverPage && window.historyCursor == nil
                    stickToBottom = false
                    readingWindow = window
                    scrollTarget = "e:" + prompt
                } else {
                    guard let first = current.entries.first(where: {
                        switch $0 { case .user, .assistant: true; default: false }
                    })?.entryId ?? current.entries.first?.entryId else { return }
                    var older: [FfiTimelineEntry] = []
                    if !current.serverPage {
                        older = try await reader.before(thread: threadId, id: first).entries
                    }
                    if older.isEmpty {
                        guard online else {
                            if request == historyRequest { historyNotice = "Reconnect to load earlier messages." }
                            return
                        }
                        var visited = Set<String>()
                        repeat {
                            guard request == historyRequest, store.offlineReader === reader,
                                  store.openThreadId == threadId else { return }
                            if current.serverPage && current.historyCursor == nil { break }
                            let atLiveBoundary = store.openThread?.entries.first?.entryId == first
                            let cursor = current.serverPage ? current.historyCursor
                                : (atLiveBoundary ? store.openThread?.historyCursor : nil)
                            if let cursor, !visited.insert(cursor).inserted { break }
                            let page = try await reader.serverBefore(
                                thread: threadId, anchor: first, continuation: cursor,
                                snapshotCursor: store.openThread?.historyCursor
                            )
                            older = page.entries
                            current.serverPage = true
                            current.historyCursor = page.historyCursor
                            current.workGroups.insert(contentsOf: page.workGroups, at: 0)
                        } while older.isEmpty
                    }
                    guard request == historyRequest, store.offlineReader === reader,
                          store.openThreadId == threadId else { return }
                    var ids = Set(current.entries.map(\.entryId))
                    current.entries.insert(contentsOf: older.filter { ids.insert($0.entryId).inserted }, at: 0)
                    pageExhausted = current.serverPage && current.historyCursor == nil
                    stickToBottom = false
                    let visible = viewport.frames.filter { $0.value.minY >= 0 && $0.value.minY < viewHeight }
                        .min { $0.value.minY < $1.value.minY }
                    readingWindow = current
                    if !older.isEmpty, let visible {
                        let fraction = visible.value.minY / max(1, viewHeight - visible.value.height)
                        prependAnchor = UnitPoint(x: 0.5, y: min(1, fraction))
                        scrollTarget = visible.key
                    }
                }
                historyNotice = nil
            } catch {
                guard request == historyRequest else { return }
                historyNotice = error.localizedDescription
            }
        }
    }

    private func loadOutline() async {
        guard let reader = store.offlineReader else { return }
        do {
            let result = try await reader.outline(thread: threadId, online: store.status == .connected)
            if !Task.isCancelled { markers = result }
        } catch {
            if !Task.isCancelled { historyNotice = error.localizedDescription }
        }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Kit.Space.l) {
                    if let error = store.lastError, !error.isEmpty {
                        KitNotice(error, icon: .warning, tone: .error)
                    }

                    if let snapshot {
                        if !snapshot.entries.isEmpty, store.offlineReader != nil, !pageExhausted {
                            Button("Earlier messages") { readHistory() }
                                .disabled(paging)
                                .font(.kitDetail)
                        }
                        if snapshot.entries.isEmpty {
                            Text(store.status == .connected ? "No messages in this thread yet." : "No saved messages for this thread.")
                                .font(.kitDetail)
                                .foregroundStyle(theme.mutedForeground)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 48)
                        } else {
                            let items = renderItems(for: snapshot)
                            let anchorCandidates = Set(items.prefix(12).map(\.id))
                            ForEach(items) { item in
                                Group {
                                    switch item {
                                    case let .workGroup(group, entries):
                                        WorkGroupCard(group: group, entries: entries)
                                    case let .entry(entry):
                                        TimelineEntryRow(
                                            threadId: threadId,
                                            entry: entry,
                                            store: store,
                                            onOpenThread: onOpenThread
                                        )
                                    }
                                }
                                .background {
                                    if anchorCandidates.contains(item.id) {
                                        GeometryReader { geometry in
                                            Color.clear.preference(
                                                key: TimelineFrames.self,
                                                value: [item.id: geometry.frame(in: .named("timeline-viewport"))]
                                            )
                                        }
                                    }
                                }
                                .id(item.id)
                            }
                        }

                        if snapshot.working && store.status == .connected {
                            HStack(spacing: Kit.Space.m) {
                                // Mobile's `RunFoldWorking` is plain text, never a spinner.
                                Text("Working…")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(theme.mutedForeground)
                            }
                            .padding(.top, Kit.Space.xs)
                        }
                    } else {
                        HStack(spacing: Kit.Space.m) {
                            KitStatusIcon(.working, size: 16, label: "Loading")
                            Text("Loading timeline…")
                                .font(.kitDetail)
                                .foregroundStyle(theme.mutedForeground)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("timeline-bottom")
                }
                .scrollTargetLayout()
                // `ThreadFeed`: full width, `paddingTop: 12`, 16 at the sides; the end inset is 12.
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 12)
            }
            .background(theme.background.ignoresSafeArea())
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .coordinateSpace(name: "timeline-viewport")
            .onPreferenceChange(TimelineFrames.self) { viewport.frames = $0 }
            .onScrollPhaseChange { _, phase in
                if phase == .interacting { userScrolling = true }
                if phase == .idle || phase == .animating { userScrolling = false }
                if phase == .idle && requestedByScroll {
                    requestedByScroll = false
                    readHistory()
                }
            }
            .onScrollGeometryChange(for: Int.self) { geometry in
                Int(min(160, geometry.contentOffset.y + geometry.contentInsets.top))
            } action: { previous, offset in
                if userScrolling && offset < previous && !paging {
                    userScrolling = false
                    requestedByScroll = true
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geo in
                let maxOffset = max(0, geo.contentSize.height - geo.containerSize.height)
                return geo.contentOffset.y >= maxOffset - 80
            } action: { _, nearBottom in
                stickToBottom = nearBottom
            }
            .onChange(of: scrollFingerprint) { _, _ in
                if stickToBottom && readingWindow == nil {
                    withAnimation(Kit.Motion.fast) {
                        proxy.scrollTo("timeline-bottom", anchor: .bottom)
                    }
                }
            }
            .onChange(of: scrollTarget) { _, target in
                if let target {
                    proxy.scrollTo(target, anchor: prependAnchor ?? (target == "timeline-bottom" ? .bottom : .top))
                    prependAnchor = nil
                    scrollTarget = nil
                }
            }
            // Mobile's thread overlay (`ThreadDetailScreen.tsx` 1640-1660, 1805-1862): the cards and the
            // composer float over the full-width feed. `safeAreaBar` insets the feed and gives the
            // bottom scroll-edge blur its height (mobile's `EdgeBlur` behind the composer).
            .safeAreaBar(edge: .bottom, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                  VStack(alignment: .leading, spacing: 10.5) {
                    if let historyNotice {
                        Text(historyNotice).font(.kitDetail)
                    }
                    if readingWindow != nil {
                        Button("Back to latest") { latest() }
                    }
                    if store.status != .connected {
                        Text("Offline · Viewing saved messages").font(.kitDetail)
                    }
                    // Conn mobile pins the first pending approval above the composer.
                    if store.status == .connected, let approval = snapshot?.pendingApprovals.first {
                        HeightCappedScroll(maxHeight: approvalMaxHeight) {
                            PendingApprovalCard(
                                approval: approval,
                                responding: respondingApprovalId == approval.requestId
                            ) { decision in
                                respond(to: approval, with: decision)
                            }
                        }
                        .id(approval.requestId)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                    if let question = pendingQuestion, let panel = questionPanelModel {
                        PendingUserInputCard(
                            question: question,
                            panel: panel,
                            responding: respondingUserInputId == question.requestId,
                            advancing: advancingStep == Int(panel.step),
                            maxHeight: questionMaxHeight,
                            onSelectOption: { value in
                                selectQuestionOption(value, question: question, panel: panel)
                            },
                            onStepChange: { step in
                                UISelectionFeedbackGenerator().selectionChanged()
                                setQuestionStep(step, for: question)
                            },
                            onSubmit: { submitQuestion(question) },
                            onDismiss: { dismissQuestion(question) }
                        )
                        .id(question.requestId)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                    if let queued = snapshot?.queuedCount, queued > 0 {
                        KitBadge("\(queued) queued")
                            .accessibilityIdentifier("thread.queuedBadge")
                    }
                  }
                  // Cards: `px-[14px] pb-[7px] gap-2.5` (2pt more than the composer's 12).
                  .padding(.horizontal, 2)
                  .padding(.bottom, overlayHasCards ? 7 : 0)

                    ConnComposerPill(
                        placeholder: questionPanelModel?.composerPlaceholder
                            ?? (isWorking ? "Queue a follow-up…" : "Ask anything"),
                        text: draftBinding,
                        isBusy: isWorking && !hasDraft && questionPanelModel == nil,
                        canSend: composerCanSend,
                        onSend: {
                            if let question = pendingQuestion, let panel = questionPanelModel {
                                if hasDraft {
                                    answerQuestion(with: draft, question: question, panel: panel)
                                } else {
                                    runAnswerAction(question: question, panel: panel)
                                }
                            } else {
                                sendDraft(scrollProxy: proxy)
                            }
                        },
                        onStop: {
                            Task {
                                await store.stopThread(threadId: threadId)
                            }
                        },
                        trailing: {
                            HStack(spacing: 4) {
                                if isWorking && (hasDraft || questionPanelModel != nil) {
                                    Button {
                                        Task {
                                            await store.stopThread(threadId: threadId)
                                        }
                                    } label: {
                                        KitIconImage(.stop, size: 13)
                                            .foregroundStyle(theme.destructive)
                                            .frame(width: 28, height: 28)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Stop")
                                }
                                ConnComposerModelChip(
                                    driver: modelPicker?.selectedDriver,
                                    modelLabel: modelPicker?.selectedLabel ?? snapshot?.modelLabel
                                ) {
                                    showingModelPicker = true
                                }
                            }
                        }
                    )
                    .disabled(store.status != .connected || readingWindow != nil)
                    .accessibilityIdentifier("thread.composer")
                    .padding(.top, 6)
                }
                // `FloatingWorkingControl`: a 38.5pt glass chevron, centred 40.5pt above the overlay
                // (`CONTROL_OVERLAY_OFFSET`), while the reader is away from the end of the feed.
                .overlay(alignment: .top) {
                    if snapshot != nil && !stickToBottom {
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            stickToBottom = true
                            if readingWindow != nil {
                                latest()
                            } else {
                                withAnimation(Kit.Motion.fast) {
                                    proxy.scrollTo("timeline-bottom", anchor: .bottom)
                                }
                            }
                        } label: {
                            ConnIcon("chevron.down")
                                .font(.system(size: 14))
                                .foregroundStyle(theme.foreground)
                                .frame(width: 38.5, height: 38.5)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .glassEffect(.regular.interactive(), in: Circle())
                        .offset(y: -40.5)
                        .transition(.opacity)
                        .accessibilityLabel("Scroll to end")
                        .accessibilityIdentifier("thread.scrollToEnd")
                    }
                }
                .animation(.easeOut(duration: 0.18), value: stickToBottom)
                // `ThreadComposer`: `px-[12px]`, and 2pt (`COMPOSER_BOTTOM_GUTTER`) above the safe area.
                .padding(.horizontal, 12)
                .padding(.bottom, 2)
            }
            .scrollEdgeEffectStyle(.soft, for: .top)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
        }
        // Mobile's `GLASS_HEADER_OPTIONS`: the native transparent bar with a centered title and
        // subtitle. The root has no title, so the back button is the bare chevron.
        .navigationTitle(displayTitle)
        .navigationSubtitle(displaySubtitle ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewHeight = $0 }
        .animation(.easeOut(duration: 0.2), value: snapshot?.pendingApprovals.first?.requestId)
        .animation(.easeOut(duration: 0.2), value: pendingQuestion?.requestId)
        .onChange(of: pendingQuestion?.requestId) { _, current in
            // Drafts of answered, skipped or expired questions go (`pruneResolvedRequestDrafts`).
            questionDrafts = questionDrafts.filter { $0.key == current }
            questionSteps = questionSteps.filter { $0.key == current }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showsOutline = true
                } label: {
                    Image(systemName: "list.bullet")
                }
                .accessibilityLabel("Thread outline")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                    } label: {
                        Label("Terminal", systemImage: "terminal")
                    }
                    Button {
                    } label: {
                        Label("Git controls", systemImage: "point.topleft.down.curvedto.point.bottomright.up")
                    }
                    Button {
                    } label: {
                        Label("Open files", systemImage: "folder")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("More actions")
                .accessibilityIdentifier("thread.moreButton")
            }
        }
        .sheet(isPresented: $showsOutline) {
            NavigationStack {
                List(markers.filter {
                    outlineQuery.isEmpty || $0.preview.localizedCaseInsensitiveContains(outlineQuery)
                        || ($0.assistantPreview?.localizedCaseInsensitiveContains(outlineQuery) ?? false)
                }, id: \.id) { marker in
                    Button {
                        showsOutline = false
                        readHistory(prompt: marker.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(marker.preview).lineLimit(2)
                            if let reply = marker.assistantPreview {
                                Text(reply).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            if marker.hasError { Label("Error", systemImage: "exclamationmark.triangle") }
                            if marker.hasCheckpoint { Label("Checkpoint", systemImage: "bookmark") }
                        }
                    }
                }
                .overlay { if markers.isEmpty { Text("No saved prompts").foregroundStyle(.secondary) } }
                .searchable(text: $outlineQuery, prompt: "Find a prompt")
                .navigationTitle("Thread outline")
                .toolbar { Button("Done") { showsOutline = false } }
                .task { await loadOutline() }
            }
        }
        .onChange(of: store.status) { _, status in
            if status == .connected { historyNotice = nil }
            if !stickToBottom && readingWindow == nil {
                readingWindow = store.openThread
            }
        }
        .alert("Rename Thread", isPresented: $showingRename) {
            TextField("Title", text: $renameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let newTitle = renameDraft
                Task {
                    await store.renameThread(threadId: threadId, title: newTitle)
                }
            }
        }
        .task(id: threadId) {
            store.openThread(threadId)
        }
        .task(id: "\(threadId)|\(store.providersRevision)|\(snapshot?.modelLabel ?? "")") {
            modelPicker = await store.modelPicker(threadId: threadId)
        }
        .sheet(isPresented: $showingModelPicker) {
            ModelPickerSheet(store: store, threadId: threadId)
                .presentationDetents([.large])
        }
        .onDisappear {
            historyRequest = UUID()
            store.closeThread(threadId)
        }
    }

    /// `CoreStore.sendDraft` clears the thread's draft as it sends and restores it on failure.
    private func sendDraft(scrollProxy: ScrollViewProxy) {
        stickToBottom = true
        Task {
            if await store.sendDraft(threadId: threadId) {
                withAnimation(Kit.Motion.fast) {
                    scrollProxy.scrollTo("timeline-bottom", anchor: .bottom)
                }
            }
        }
    }

    private enum RenderItem: Identifiable {
        case workGroup(FfiWorkGroupTiming, [FfiTimelineEntry])
        case entry(FfiTimelineEntry)

        var id: String {
            switch self {
            case let .workGroup(group, _): "wg:\(group.id)"
            case let .entry(entry): "e:\(entry.entryId)"
            }
        }
    }

    private func renderItems(for snapshot: FfiThreadSnapshot) -> [RenderItem] {
        var groupByFirstId: [String: FfiWorkGroupTiming] = [:]
        var memberIds = Set<String>()
        for group in snapshot.workGroups {
            groupByFirstId[group.firstEntryId] = group
            for id in group.entryIds {
                memberIds.insert(id)
            }
        }

        let entriesById = Dictionary(uniqueKeysWithValues: snapshot.entries.map { ($0.entryId, $0) })
        var items: [RenderItem] = []

        for entry in snapshot.entries {
            let id = entry.entryId
            if let group = groupByFirstId[id] {
                let groupedEntries = group.entryIds.compactMap { entriesById[$0] }
                if !groupedEntries.isEmpty {
                    items.append(.workGroup(group, groupedEntries))
                }
            } else if memberIds.contains(id) {
                continue
            } else {
                items.append(.entry(entry))
            }
        }
        return items
    }

    private func entryFingerprint(_ entry: FfiTimelineEntry) -> String {
        switch entry {
        case let .user(id, text, _, _, _, _, _): "u:\(id):\(text.count)"
        case let .queuedUser(id, _, _, text, _, _, _): "q:\(id):\(text.count)"
        case let .assistant(id, markdown, streaming, _, _, _): "a:\(id):\(streaming):\(markdown.count)"
        case let .thinking(id, text, streaming, _, _): "th:\(id):\(streaming):\(text.count)"
        case let .tool(id, _, title, detail, status, _, _, _): "t:\(id):\(status):\(title.count):\(detail?.count ?? 0)"
        case let .approval(id, _, title, _): "ap:\(id):\(title.count)"
        case let .userInputRequest(id, _, _, questions, _, pending, answers, _, _):
            "ui:\(id):\(pending):\(questions.count):\(answers.count)"
        case let .secretRequest(id, label, _, _, _, _, status, pending, _):
            "sec:\(id):\(status):\(pending):\(label.count)"
        case let .proposedPlan(id, _, title, markdown, _, _, _, streaming, _, _):
            "plan:\(id):\(streaming):\(title.count):\(markdown.count)"
        case let .subagent(id, _, title, _, status, _, _, summary, _, _, _, _):
            "sub:\(id):\(status):\(title.count):\(summary?.count ?? 0)"
        case let .turnCheckpoint(id, _, _, fileCount, additions, deletions, _):
            "cp:\(id):\(fileCount):\(additions):\(deletions)"
        case let .notice(id, text, isError): "n:\(id):\(isError):\(text.count)"
        case let .other(id, label): "o:\(id):\(label.count)"
        }
    }
}

private final class TimelineViewport {
    var frames: [String: CGRect] = [:]
}

private struct TimelineFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}
