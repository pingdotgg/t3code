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
    @State private var draft = ""
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
        guard let current = store.openThread, current.threadId == threadId else { return nil }
        return current
    }

    /// An approval gives up height to the feed: at most 560pt, at least 160pt, and never more
    /// than the screen leaves above the composer (`derivePendingUserInputMaxHeight`).
    private var approvalMaxHeight: CGFloat {
        min(560, max(160, viewHeight - 140))
    }

    private var pendingQuestion: FfiPendingQuestion? { snapshot?.pendingQuestion }

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
    private var composerCanSend: Bool {
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

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Kit.Space.l) {
                    if let error = store.lastError, !error.isEmpty {
                        KitNotice(error, icon: .warning, tone: .error)
                    }

                    if let snapshot {
                        if snapshot.entries.isEmpty {
                            Text("No messages in this thread yet.")
                                .font(.kitDetail)
                                .foregroundStyle(theme.mutedForeground)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 48)
                        } else {
                            let items = renderItems(for: snapshot)
                            ForEach(items) { item in
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
                        }

                        if snapshot.working {
                            HStack(spacing: Kit.Space.m) {
                                KitStatusIcon(.working, size: 14, label: "Working")
                                Text("Working…")
                                    .font(.kitDetail)
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
                .padding(.horizontal, Kit.contentInset)
                .padding(.top, Kit.Space.m)
                .padding(.bottom, Kit.Space.l)
            }
            .background(theme.background.ignoresSafeArea())
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geo in
                let maxOffset = max(0, geo.contentSize.height - geo.containerSize.height)
                return geo.contentOffset.y >= maxOffset - 80
            } action: { _, nearBottom in
                stickToBottom = nearBottom
            }
            .onChange(of: scrollFingerprint) { _, _ in
                if stickToBottom {
                    withAnimation(Kit.Motion.fast) {
                        proxy.scrollTo("timeline-bottom", anchor: .bottom)
                    }
                }
            }
            .kitComposerBar {
                VStack(alignment: .leading, spacing: Kit.Space.xs) {
                    // Conn mobile pins the first pending approval above the composer.
                    if let approval = snapshot?.pendingApprovals.first {
                        HeightCappedScroll(maxHeight: approvalMaxHeight) {
                            PendingApprovalCard(
                                approval: approval,
                                responding: respondingApprovalId == approval.requestId
                            ) { decision in
                                respond(to: approval, with: decision)
                            }
                        }
                        .id(approval.requestId)
                        .padding(.bottom, 8)
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
                        .padding(.bottom, 8)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                    if let queued = snapshot?.queuedCount, queued > 0 {
                        KitBadge("\(queued) queued")
                            .accessibilityIdentifier("thread.queuedBadge")
                    }

                    KitComposer(
                        questionPanelModel?.composerPlaceholder
                            ?? (isWorking ? "Queue a follow-up…" : "Ask anything"),
                        text: $draft,
                        maxLines: 6,
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
                        leading: {
                            Menu {
                                Button("Attachments (coming soon)") {}
                                    .disabled(true)
                            } label: {
                                ConnIcon("plus")
                                    .font(.system(size: 16, weight: .medium))
                                    .foregroundStyle(theme.mutedForeground)
                                    .frame(width: 28, height: 28)
                            }
                            .accessibilityLabel("More composer actions")
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
                                HStack(spacing: 3) {
                                    Image(systemName: "sparkle")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
                                    Image(systemName: "chevron.down")
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundStyle(theme.mutedForeground)
                                }
                                .padding(.trailing, 4)
                            }
                        }
                    )
                    .accessibilityIdentifier("thread.composer")
                }
            }
        }
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
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(displayTitle)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                    if let subtitle = displaySubtitle {
                        Text(subtitle)
                            .font(.system(size: 11))
                            .foregroundStyle(theme.mutedForeground)
                            .lineLimit(1)
                    }
                }
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
        .onDisappear {
            store.closeThread(threadId)
        }
    }

    private func sendDraft(scrollProxy: ScrollViewProxy) {
        let message = draft
        stickToBottom = true
        Task {
            let sent = await store.sendMessage(threadId: threadId, text: message, mode: .auto)
            if sent {
                draft = ""
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
