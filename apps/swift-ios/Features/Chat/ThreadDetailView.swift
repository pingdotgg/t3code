import ImageIO
import SwiftUI
import UIKit

public struct ThreadDetailView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @Bindable var model: FeatureRootModel
    let thread: FeatureThread
    let submitMessage: (FeatureMessageSubmission) async -> Bool
    let onNavigateBack: () -> Void
    private let draftStore: FeatureComposerDraftStore

    @State private var draft = ""
    @State private var selection: FeatureSelection?
    @State private var attachments: [FeatureDraftAttachment] = []
    @State private var isSending = false
    @State private var isLoading = true
    @State private var sendFailed = false
    @State private var didRestoreDraft = false
    @State private var draftSaveTask: Task<Void, Never>?
    @State private var toolSurface: FeatureThreadToolSurface?
    @FocusState private var composerFocused: Bool

    public init(
        model: FeatureRootModel,
        thread: FeatureThread,
        submitMessage: @escaping (FeatureMessageSubmission) async -> Bool,
        onNavigateBack: @escaping () -> Void = {},
        draftStore: FeatureComposerDraftStore = .shared
    ) {
        self.model = model
        self.thread = thread
        self.submitMessage = submitMessage
        self.onNavigateBack = onNavigateBack
        self.draftStore = draftStore
    }

    public var body: some View {
        Group {
            if isLoading {
                FeatureThreadOpeningView(isRefreshing: detail != nil)
            } else if let detail {
                timeline(detail)
            } else {
                ContentUnavailableView(
                    "Thread unavailable",
                    systemImage: "exclamationmark.bubble",
                    description: Text("The thread could not be loaded.")
                )
            }
        }
        .background(T3Colors.background)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(false)
        .t3NavigationChrome()
        .toolbar {
            ToolbarItem(placement: .principal) {
                threadHeaderTitle
            }
            ToolbarItem(placement: .primaryAction) {
                threadActionsMenu
            }
        }
        .task(id: thread.id) {
            let restoreBaseline = composerDraft
            let restoreKey = draftKey
            isLoading = true
            _ = await model.detail(for: thread.id, force: true)
            await restoreDraft(from: restoreBaseline, key: restoreKey)
            isLoading = false
        }
        .onChange(of: draft) { scheduleDraftSave() }
        .onChange(of: attachments) { scheduleDraftSave() }
        .onChange(of: selection) { scheduleDraftSave() }
        .onDisappear {
            model.releaseThread(thread.id)
            persistDraftBeforeLeaving()
        }
        .sheet(item: $toolSurface) { surface in
            NavigationStack {
                switch surface {
                case .files:
                    FeatureFilesView(client: model.client, threadID: thread.id)
                case .review:
                    FeatureReviewView(client: model.client, threadID: thread.id)
                case .sourceControl:
                    FeatureSourceControlView(client: model.client, threadID: thread.id)
                case .terminal:
                    FeatureTerminalView(client: model.client, threadID: thread.id)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        toolSurface = nil
                    }
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .alert("Message not sent", isPresented: $sendFailed) {
            Button("OK") {}
        } message: {
            Text("Your draft is still here. Check your connection and try again.")
        }
        .simultaneousGesture(edgeBackGesture)
    }

    private var edgeBackGesture: some Gesture {
        DragGesture(minimumDistance: 18, coordinateSpace: .local)
            .onEnded { value in
                guard horizontalSizeClass == .compact,
                      value.startLocation.x <= 24,
                      value.translation.width >= 72,
                      abs(value.translation.height) <= abs(value.translation.width) * 0.7 else {
                    return
                }
                onNavigateBack()
            }
    }

    private var detail: FeatureThreadDetail? {
        model.details[thread.id]
    }

    private var currentThread: FeatureThread {
        detail?.thread ?? thread
    }

    private var currentSelection: FeatureSelection? {
        guard let providerID = detail?.thread.providerID ?? thread.providerID,
              let modelID = detail?.thread.modelID ?? thread.modelID else { return nil }
        let provider = threadProviders.first { $0.id == providerID }
        let featureModel = provider?.models.first { $0.id == modelID }
        let savedOptions = detail?.thread.modelOptions ?? thread.modelOptions
        return FeatureSelection(
            providerID: providerID,
            modelID: modelID,
            options: savedOptions.isEmpty
                ? featureModel.map(DailyUXModelOptions.defaults) ?? []
                : savedOptions
        )
    }

    private var threadHeaderTitle: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(currentThread.title)
                .font(T3Typography.navigationTitle)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)

            HStack(spacing: 5) {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.triangle.branch")
                    Text(headerBranch)
                        .lineLimit(1)
                    if let environmentName = currentThread.homeEnvironmentLabel(in: model.snapshot) {
                        Text("·")
                        Text(environmentName)
                            .lineLimit(1)
                    }
                }
                .lineLimit(1)
                .truncationMode(.tail)

                Spacer(minLength: 6)

                // The per-second timeline only exists for the live working
                // duration; idle threads render a static status instead of
                // waking every second forever.
                Group {
                    if currentThread.homeStatus == .working {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            headerStatus(at: context.date)
                        }
                    } else {
                        headerStatus(at: .now)
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
            }
            .font(T3Typography.navigationMetadata)
            .foregroundStyle(T3Colors.textTertiary)
        }
        .frame(maxWidth: horizontalSizeClass == .compact ? 260 : 460, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func headerStatus(at now: Date) -> some View {
        HStack(spacing: 5) {
            if let icon = headerStatusIcon {
                Image(systemName: icon)
            }
            if let duration = currentThread.homeWorkingDuration(at: now) {
                Text(duration)
                    .monospaced()
                    .monospacedDigit()
            } else {
                Text(currentThread.homeStatusLabel ?? "Ready")
            }
        }
        .font(T3Typography.status)
        .foregroundStyle(headerStatusColor)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }

    private var threadActionsMenu: some View {
        Menu {
            Section("Workspace") {
                Button { toolSurface = .files } label: {
                    Label("Files", systemImage: "folder")
                }
                Button { toolSurface = .review } label: {
                    Label("Review changes", systemImage: "doc.text.magnifyingglass")
                }
                Button { toolSurface = .sourceControl } label: {
                    Label("Source Control", systemImage: "arrow.triangle.branch")
                }
                Button { toolSurface = .terminal } label: {
                    Label("Terminal", systemImage: "terminal")
                }
            }
            Section {
                if currentThread.canTogglePin, !currentThread.isArchived {
                    Button {
                        Task {
                            await model.setPinned(
                                thread.id,
                                pinned: currentThread.pinnedAt == nil
                            )
                        }
                    } label: {
                        Label(
                            currentThread.pinnedAt == nil ? "Pin" : "Unpin",
                            systemImage: currentThread.pinnedAt == nil ? "pin" : "pin.slash"
                        )
                    }
                }
                Button {
                    Task { _ = await model.detail(for: thread.id, force: true) }
                } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
                Button {
                    Task {
                        await model.setArchived(thread.id, archived: !currentThread.isArchived)
                    }
                } label: {
                    Label(
                        currentThread.isArchived ? "Restore" : "Archive",
                        systemImage: currentThread.isArchived
                            ? "arrow.uturn.backward"
                            : "archivebox"
                    )
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
        }
        .buttonStyle(.plain)
        .foregroundStyle(T3Colors.textSecondary)
        .accessibilityLabel("Thread actions")
    }

    private var headerBranch: String {
        if let branch = currentThread.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
           !branch.isEmpty {
            return branch
        }
        if let path = currentThread.worktreePath,
           !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(fileURLWithPath: path).lastPathComponent
        }
        return "workspace"
    }

    private var headerStatusIcon: String? {
        switch currentThread.homeStatus {
        case .working: "circle.dotted"
        case .done: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .approval, .input, .ready: nil
        }
    }

    private var headerStatusColor: Color {
        switch currentThread.homeStatus {
        case .working: T3Colors.statusRunning
        case .approval: T3Colors.warning
        case .input: T3Colors.statusInput
        case .failed: T3Colors.danger
        case .done: T3Colors.success
        case .ready: T3Colors.textTertiary
        }
    }

    private func timeline(_ detail: FeatureThreadDetail) -> some View {
        let isWorking = detail.thread.state == .working || detail.thread.state == .queued
        return Group {
            if detail.messages.isEmpty, !isWorking {
                ContentUnavailableView(
                    "Ready for a task",
                    systemImage: "sparkles",
                    description: Text("Tell the agent what you want to build.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                FeatureTranscriptCollectionView(
                    threadID: thread.id,
                    messages: detail.messages,
                    renderUpdate: model.detailRenderUpdates[thread.id],
                    dynamicTypeSize: dynamicTypeSize,
                    isWorking: isWorking,
                    canLoadEarlier: detail.page?.hasMore == true,
                    isLoadingEarlier: detail.page?.isLoading == true,
                    onLoadEarlier: {
                        Task { await model.loadEarlierTurns(for: thread.id) }
                    },
                    onDismissKeyboard: dismissKeyboard
                )
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            FeatureComposerView(
                text: $draft,
                selection: $selection,
                attachments: $attachments,
                providers: threadProviders,
                threadSelection: currentSelection,
                materializesDefaultSelection: false,
                isSending: isSending,
                isWorking: detail.thread.state == .working || detail.thread.state == .queued,
                focused: $composerFocused,
                onSend: send,
                onStop: {
                    Task { await model.cancelTurn(threadID: thread.id) }
                },
                pendingApprovals: detail.approvals,
                pendingUserInputs: detail.userInputs,
                isResolvingRequest: model.isPerformingAction,
                powerFeatures: composerPowerFeatures,
                onApprovalDecision: { id, decision in
                    Task { await model.resolveApproval(id, decision: decision) }
                },
                onUserInputSubmit: { id, answers in
                    Task { await model.resolveUserInput(id, answers: answers) }
                }
            )
            .simultaneousGesture(composerKeyboardDismissGesture)
        }
    }

    private var composerKeyboardDismissGesture: some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .local)
            .onChanged { value in
                guard composerFocused,
                      value.translation.height > 8,
                      value.translation.height > abs(value.translation.width) else {
                    return
                }
                dismissKeyboard()
            }
    }

    private var composerPowerFeatures: FeatureComposerPowerFeatures {
        let selectedProviderID = selection?.providerID ?? currentSelection?.providerID
        let provider = threadProviders.first { $0.id == selectedProviderID }
        return FeatureComposerPowerFeatures(
            slashCommands: provider?.slashCommands ?? [],
            skills: provider?.skills ?? [],
            pathSearchScopeID: currentThread.id,
            searchPaths: { query in
                try await model.client.searchThreadFiles(
                    threadID: currentThread.id,
                    query: query,
                    limit: 20
                ).map { entry in
                    FeatureComposerPathEntry(
                        path: entry.path,
                        kind: entry.kind == .directory ? .directory : .file
                    )
                }
            }
        )
    }

    private var threadProviders: [FeatureProvider] {
        let project = model.snapshot.projects.first { $0.id == currentThread.projectID }
        return DailyUXCreationContext.providers(for: project, in: model.snapshot)
    }

    private func dismissKeyboard() {
        guard composerFocused else { return }
        composerFocused = false
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private func send() {
        let message = draft
        let pendingAttachments = attachments
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pendingAttachments.isEmpty else {
            return
        }
        draftSaveTask?.cancel()
        isSending = true
        draft = ""
        attachments = []
        composerFocused = false
        Task {
            let sent = await submitMessage(
                FeatureMessageSubmission(
                threadID: thread.id,
                text: message,
                selection: selection,
                attachments: pendingAttachments
                )
            )
            if sent {
                let followUpDraft = composerDraft
                if followUpDraft.text.isEmpty && followUpDraft.attachments.isEmpty {
                    try? await draftStore.removeDraft(for: draftKey)
                } else {
                    try? await draftStore.setDraft(followUpDraft, for: draftKey)
                }
            } else {
                let currentDraft = draft
                let restoredMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
                if currentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    draft = message
                } else if !restoredMessage.isEmpty {
                    draft = "\(message)\n\(currentDraft)"
                }
                let pendingIDs = Set(pendingAttachments.map(\.id))
                attachments = pendingAttachments + attachments.filter {
                    !pendingIDs.contains($0.id)
                }
                sendFailed = true
                composerFocused = true
            }
            isSending = false
            if !sent {
                persistDraftImmediately()
            }
        }
    }

    private var draftKey: String {
        FeatureComposerDraftStore.threadKey(currentThread)
    }

    @MainActor
    private func restoreDraft(from baseline: FeatureComposerDraft, key: String) async {
        let saved = try? await draftStore.draft(for: key)
        guard !Task.isCancelled else { return }

        let liveDraft = composerDraft
        var restored = FeatureComposerDraftRestoration.merge(
            saved: saved,
            baseline: baseline,
            current: liveDraft
        )
        restored.selection = ThreadComposerModelSelectionPolicy.explicitSelection(
            restored.selection,
            inherited: currentSelection,
            providers: threadProviders
        )
        draft = restored.text
        attachments = restored.attachments
        selection = restored.selection
        didRestoreDraft = true

        // Changes made while the file read or thread refresh was in flight did
        // not pass the didRestoreDraft gate, so enqueue their first save now.
        if liveDraft != baseline {
            scheduleDraftSave()
        }
    }

    private func scheduleDraftSave() {
        guard didRestoreDraft, !isSending else { return }
        draftSaveTask?.cancel()
        let snapshot = composerDraft
        let key = draftKey
        draftSaveTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(220))
                try Task.checkCancellation()
                try await draftStore.setDraft(snapshot, for: key)
            } catch is CancellationError {
                return
            } catch {
                return
            }
        }
    }

    private func persistDraftImmediately() {
        guard didRestoreDraft else { return }
        draftSaveTask?.cancel()
        let snapshot = composerDraft
        let key = draftKey
        draftSaveTask = Task {
            try? await draftStore.setDraft(snapshot, for: key)
        }
    }

    private func persistDraftBeforeLeaving() {
        guard didRestoreDraft, !isSending else { return }
        persistDraftImmediately()
    }

    private var composerDraft: FeatureComposerDraft {
        FeatureComposerDraft(
            text: draft,
            attachments: attachments,
            selection: selection
        )
    }

}

private struct FeatureThreadOpeningView: View {
    let isRefreshing: Bool

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.regular)
            Text(isRefreshing ? "Refreshing thread…" : "Loading thread…")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread-opening-state")
    }
}

private enum FeatureThreadToolSurface: String, Identifiable {
    case files
    case review
    case sourceControl
    case terminal

    var id: String { rawValue }
}

/// Merges a stored draft with edits made while that draft was loading. Each
/// field is restored only if its live value still matches the value captured
/// before the asynchronous read began.
enum FeatureComposerDraftRestoration {
    static func merge(
        saved: FeatureComposerDraft?,
        baseline: FeatureComposerDraft,
        current: FeatureComposerDraft,
        fallbackSelection: FeatureSelection? = nil,
        fallbackWorkspace: FeatureComposerWorkspaceDraft? = nil
    ) -> FeatureComposerDraft {
        FeatureComposerDraft(
            text: current.text == baseline.text
                ? saved?.text ?? ""
                : current.text,
            attachments: current.attachments == baseline.attachments
                ? saved?.attachments ?? []
                : current.attachments,
            selection: current.selection == baseline.selection
                ? saved?.selection ?? fallbackSelection
                : current.selection,
            workspace: mergeWorkspace(
                saved: saved?.workspace ?? fallbackWorkspace,
                baseline: baseline.workspace,
                current: current.workspace
            )
        )
    }

    private static func mergeWorkspace(
        saved: FeatureComposerWorkspaceDraft?,
        baseline: FeatureComposerWorkspaceDraft?,
        current: FeatureComposerWorkspaceDraft?
    ) -> FeatureComposerWorkspaceDraft? {
        guard let saved else {
            return current == baseline ? nil : current
        }
        guard let baseline, let current else {
            return current == baseline ? saved : current
        }
        return FeatureComposerWorkspaceDraft(
            mode: current.mode == baseline.mode ? saved.mode : current.mode,
            branch: current.branch == baseline.branch ? saved.branch : current.branch,
            worktreePath: current.worktreePath == baseline.worktreePath
                ? saved.worktreePath
                : current.worktreePath,
            startFromOrigin: current.startFromOrigin == baseline.startFromOrigin
                ? saved.startFromOrigin
                : current.startFromOrigin
        )
    }
}

/// A recycled transcript surface. SwiftUI still owns each message's rendering,
/// while UIKit keeps offscreen messages out of the active view hierarchy.
private struct FeatureTranscriptCollectionView: UIViewRepresentable {
    private static let workingIndicatorID = "__t3-working-indicator__"
    private static let loadEarlierID = "__t3-load-earlier__"

    private enum Section: Hashable {
        case transcript
    }

    let threadID: String
    let messages: [FeatureMessage]
    let renderUpdate: FeatureDetailRenderUpdate?
    let dynamicTypeSize: DynamicTypeSize
    let isWorking: Bool
    let canLoadEarlier: Bool
    let isLoadingEarlier: Bool
    let onLoadEarlier: () -> Void
    let onDismissKeyboard: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UICollectionView {
        let collectionView = BottomAnchoredTranscriptCollectionView(
            frame: .zero,
            collectionViewLayout: Self.makeLayout()
        )
        collectionView.backgroundColor = T3Colors.uiBackground
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .onDrag
        collectionView.delaysContentTouches = false
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.isPrefetchingEnabled = true
        collectionView.accessibilityIdentifier = "thread-transcript"
        context.coordinator.connect(to: collectionView)
        return collectionView
    }

    func updateUIView(_ collectionView: UICollectionView, context: Context) {
        context.coordinator.update(
            threadID: threadID,
            messages: messages,
            renderUpdate: renderUpdate,
            dynamicTypeSize: dynamicTypeSize,
            isWorking: isWorking,
            canLoadEarlier: canLoadEarlier,
            isLoadingEarlier: isLoadingEarlier,
            onLoadEarlier: onLoadEarlier,
            onDismissKeyboard: onDismissKeyboard,
            in: collectionView
        )
    }

    private static func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { _, environment in
            let width = environment.container.effectiveContentSize.width
            let sideInset = max(18, (width - T3Metrics.readingWidth) / 2)
            let itemSize = NSCollectionLayoutSize(
                widthDimension: .fractionalWidth(1),
                heightDimension: .estimated(120)
            )
            let item = NSCollectionLayoutItem(layoutSize: itemSize)
            let group = NSCollectionLayoutGroup.vertical(
                layoutSize: itemSize,
                subitems: [item]
            )
            let section = NSCollectionLayoutSection(group: group)
            section.interGroupSpacing = 22
            section.contentInsets = NSDirectionalEdgeInsets(
                top: 18,
                leading: sideInset,
                bottom: 14,
                trailing: sideInset
            )
            return section
        }
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDataSourcePrefetching, UICollectionViewDelegate {
        private struct MarkdownPrefetch {
            let revision: MarkdownContentRevision
            let task: Task<Void, Never>
        }

        private var dataSource: UICollectionViewDiffableDataSource<Section, String>?
        private var messagesByID: [String: FeatureMessage] = [:]
        private var orderedIDs: [String] = []
        private var currentThreadID: String?
        private var currentDetailRevision: UInt64?
        private var currentDynamicTypeSize: DynamicTypeSize?
        private var currentIsWorking = false
        private var currentCanLoadEarlier = false
        private var currentIsLoadingEarlier = false
        private var markdownPrefetches: [String: MarkdownPrefetch] = [:]
        private var onLoadEarlier: (() -> Void)?
        private var onDismissKeyboard: (() -> Void)?

        deinit {
            markdownPrefetches.values.forEach { $0.task.cancel() }
        }

        func connect(to collectionView: UICollectionView) {
            let registration = UICollectionView.CellRegistration<UICollectionViewCell, String> {
                [weak self] cell, _, messageID in
                if messageID == FeatureTranscriptCollectionView.loadEarlierID {
                    cell.contentConfiguration = UIHostingConfiguration {
                        FeatureLoadEarlierTurnsButton(
                            isLoading: self?.currentIsLoadingEarlier == true,
                            onLoad: { self?.onLoadEarlier?() }
                        )
                    }
                    .margins(.all, 0)
                    cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
                    cell.accessibilityIdentifier = "load-earlier-turns"
                    return
                }
                if messageID == FeatureTranscriptCollectionView.workingIndicatorID {
                    cell.contentConfiguration = UIHostingConfiguration {
                        FeatureThreadWorkingIndicator()
                    }
                    .margins(.all, 0)
                    cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
                    cell.accessibilityIdentifier = "thread-working-indicator"
                    return
                }
                guard let message = self?.messagesByID[messageID] else {
                    cell.contentConfiguration = nil
                    return
                }

                cell.contentConfiguration = UIHostingConfiguration {
                    FeatureMessageView(message: message)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .margins(.all, 0)
                cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
                cell.accessibilityIdentifier = "message-cell-\(messageID)"
            }

            dataSource = UICollectionViewDiffableDataSource<Section, String>(
                collectionView: collectionView
            ) { collectionView, indexPath, messageID in
                collectionView.dequeueConfiguredReusableCell(
                    using: registration,
                    for: indexPath,
                    item: messageID
                )
            }
            collectionView.prefetchDataSource = self
            collectionView.delegate = self
        }

        func update(
            threadID: String,
            messages: [FeatureMessage],
            renderUpdate: FeatureDetailRenderUpdate?,
            dynamicTypeSize: DynamicTypeSize,
            isWorking: Bool,
            canLoadEarlier: Bool,
            isLoadingEarlier: Bool,
            onLoadEarlier: @escaping () -> Void,
            onDismissKeyboard: @escaping () -> Void,
            in collectionView: UICollectionView
        ) {
            guard let dataSource else { return }
            self.onLoadEarlier = onLoadEarlier
            self.onDismissKeyboard = onDismissKeyboard

            let threadChanged = currentThreadID != threadID
            let typeSizeChanged = currentDynamicTypeSize != dynamicTypeSize
            let revisionChanged = currentDetailRevision != renderUpdate?.revision
            let workingChanged = currentIsWorking != isWorking
            let loadEarlierChanged = currentCanLoadEarlier != canLoadEarlier
                || currentIsLoadingEarlier != isLoadingEarlier
            guard threadChanged || typeSizeChanged || revisionChanged || workingChanged
                || loadEarlierChanged else { return }

            let incremental = !threadChanged
                ? incrementalState(messages: messages, renderUpdate: renderUpdate)
                : nil
            let state = incremental ?? fullState(messages: messages)
            let newIDs = state.ids
            let idsChanged = state.idsChanged
            let changedIDs = typeSizeChanged
                ? newIDs
                : state.changedIDs

            currentDetailRevision = renderUpdate?.revision
            currentDynamicTypeSize = dynamicTypeSize
            currentIsWorking = isWorking
            currentCanLoadEarlier = canLoadEarlier
            currentIsLoadingEarlier = isLoadingEarlier
            guard threadChanged || idsChanged || !changedIDs.isEmpty || workingChanged
                || loadEarlierChanged else { return }

            if threadChanged {
                cancelAllMarkdownPrefetches()
            } else {
                var invalidatedIDs = Set(changedIDs)
                if idsChanged, !state.isAppendOnly {
                    invalidatedIDs.formUnion(Set(orderedIDs).subtracting(newIDs))
                }
                cancelMarkdownPrefetches(for: invalidatedIDs)
            }

            let wasNearBottom = isNearBottom(collectionView)
            let lastIDChanged = orderedIDs.last != newIDs.last || workingChanged
            let isInitialLoad = currentThreadID == nil || threadChanged
            let previousIDs = orderedIDs
            let prependedMessages = !threadChanged
                && newIDs.count > previousIDs.count
                && Array(newIDs.suffix(previousIDs.count)) == previousIDs
            let shouldFollowBottom = isInitialLoad || wasNearBottom
            let prependAnchor = !shouldFollowBottom
                && (prependedMessages || (loadEarlierChanged && !canLoadEarlier))
                ? visibleAnchor(in: collectionView, dataSource: dataSource)
                : nil

            currentThreadID = threadID
            if let replacementMessagesByID = state.replacementMessagesByID {
                messagesByID = replacementMessagesByID
            }
            orderedIDs = newIDs
            (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor =
                isInitialLoad || wasNearBottom

            var snapshot: NSDiffableDataSourceSnapshot<Section, String>
            if threadChanged || loadEarlierChanged {
                snapshot = NSDiffableDataSourceSnapshot<Section, String>()
                snapshot.appendSections([.transcript])
                if canLoadEarlier {
                    snapshot.appendItems(
                        [FeatureTranscriptCollectionView.loadEarlierID],
                        toSection: .transcript
                    )
                }
                snapshot.appendItems(newIDs, toSection: .transcript)
            } else if !idsChanged {
                snapshot = dataSource.snapshot()
            } else if state.isAppendOnly {
                snapshot = dataSource.snapshot()
                snapshot.appendItems(state.appendedIDs, toSection: .transcript)
            } else if newIDs.starts(with: previousIDs) {
                snapshot = dataSource.snapshot()
                snapshot.appendItems(Array(newIDs.dropFirst(previousIDs.count)), toSection: .transcript)
            } else {
                snapshot = NSDiffableDataSourceSnapshot<Section, String>()
                snapshot.appendSections([.transcript])
                if canLoadEarlier {
                    snapshot.appendItems(
                        [FeatureTranscriptCollectionView.loadEarlierID],
                        toSection: .transcript
                    )
                }
                snapshot.appendItems(newIDs, toSection: .transcript)
            }
            if snapshot.indexOfItem(FeatureTranscriptCollectionView.workingIndicatorID) != nil {
                snapshot.deleteItems([FeatureTranscriptCollectionView.workingIndicatorID])
            }
            if isWorking {
                snapshot.appendItems(
                    [FeatureTranscriptCollectionView.workingIndicatorID],
                    toSection: .transcript
                )
            }
            let appendedIDSet = Set(state.appendedIDs)
            var reconfiguredIDs = changedIDs.filter { !appendedIDSet.contains($0) }
            if loadEarlierChanged,
               snapshot.indexOfItem(FeatureTranscriptCollectionView.loadEarlierID) != nil {
                reconfiguredIDs.append(FeatureTranscriptCollectionView.loadEarlierID)
            }
            if !reconfiguredIDs.isEmpty {
                snapshot.reconfigureItems(reconfiguredIDs)
            }

            dataSource.apply(snapshot, animatingDifferences: false) {
                [weak self, weak collectionView] in
                guard let self, let collectionView else { return }
                DispatchQueue.main.async {
                    if shouldFollowBottom {
                        self.scrollToBottom(
                            collectionView,
                            animated: !isInitialLoad && lastIDChanged
                        )
                    } else if let prependAnchor {
                        self.restore(prependAnchor, in: collectionView, dataSource: dataSource)
                    }
                }
            }
        }

        private struct VisibleAnchor {
            let id: String
            let offsetFromViewportTop: CGFloat
        }

        private func visibleAnchor(
            in collectionView: UICollectionView,
            dataSource: UICollectionViewDiffableDataSource<Section, String>
        ) -> VisibleAnchor? {
            for indexPath in collectionView.indexPathsForVisibleItems.sorted() {
                guard let id = dataSource.itemIdentifier(for: indexPath),
                      id != FeatureTranscriptCollectionView.loadEarlierID,
                      id != FeatureTranscriptCollectionView.workingIndicatorID,
                      let attributes = collectionView.layoutAttributesForItem(at: indexPath) else {
                    continue
                }
                return VisibleAnchor(
                    id: id,
                    offsetFromViewportTop: attributes.frame.minY - collectionView.contentOffset.y
                )
            }
            return nil
        }

        private func restore(
            _ anchor: VisibleAnchor,
            in collectionView: UICollectionView,
            dataSource: UICollectionViewDiffableDataSource<Section, String>
        ) {
            collectionView.layoutIfNeeded()
            guard let indexPath = dataSource.indexPath(for: anchor.id),
                  let attributes = collectionView.layoutAttributesForItem(at: indexPath) else {
                return
            }
            let minimumY = -collectionView.adjustedContentInset.top
            let maximumY = max(
                minimumY,
                collectionView.contentSize.height
                    - collectionView.bounds.height
                    + collectionView.adjustedContentInset.bottom
            )
            let targetY = min(
                maximumY,
                max(minimumY, attributes.frame.minY - anchor.offsetFromViewportTop)
            )
            (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor = false
            collectionView.setContentOffset(
                CGPoint(x: collectionView.contentOffset.x, y: targetY),
                animated: false
            )
        }

        private struct MessageState {
            let ids: [String]
            let replacementMessagesByID: [String: FeatureMessage]?
            let changedIDs: [String]
            let appendedIDs: [String]
            let idsChanged: Bool
            let isAppendOnly: Bool
        }

        private func incrementalState(
            messages: [FeatureMessage],
            renderUpdate: FeatureDetailRenderUpdate?
        ) -> MessageState? {
            guard let currentDetailRevision,
                  let renderUpdate,
                  renderUpdate.baseRevision == currentDetailRevision,
                  case let .delta(delta) = renderUpdate.change,
                  messages.count == orderedIDs.count + delta.appendedMessageIDs.count else {
                return nil
            }

            let appendedIDs = delta.appendedMessageIDs
            guard Set(appendedIDs).count == appendedIDs.count,
                  appendedIDs.allSatisfy({ messagesByID[$0] == nil }) else {
                return nil
            }

            let appendedIDSet = Set(appendedIDs)
            let changedMessageIDs = Set(delta.changedMessages.map(\.id))
            guard appendedIDs.allSatisfy(changedMessageIDs.contains),
                  delta.changedMessages.allSatisfy({
                      messagesByID[$0.id] != nil || appendedIDSet.contains($0.id)
                  }) else {
                return nil
            }

            var changedIDs: [String] = []
            changedIDs.reserveCapacity(delta.changedMessages.count)
            for message in delta.changedMessages {
                if messagesByID[message.id] != message {
                    changedIDs.append(message.id)
                }
                messagesByID[message.id] = message
            }

            return MessageState(
                ids: appendedIDs.isEmpty ? orderedIDs : orderedIDs + appendedIDs,
                replacementMessagesByID: nil,
                changedIDs: changedIDs,
                appendedIDs: appendedIDs,
                idsChanged: !appendedIDs.isEmpty,
                isAppendOnly: !appendedIDs.isEmpty
            )
        }

        private func fullState(messages: [FeatureMessage]) -> MessageState {
            var seenMessageIDs = Set<String>()
            let uniqueMessages = Array(messages.reversed().filter {
                seenMessageIDs.insert($0.id).inserted
            }.reversed())
            let ids = uniqueMessages.map(\.id)
            let updatedMessages = uniqueMessages.reduce(into: [String: FeatureMessage]()) {
                $0[$1.id] = $1
            }
            return MessageState(
                ids: ids,
                replacementMessagesByID: updatedMessages,
                changedIDs: ids.filter { messagesByID[$0] != updatedMessages[$0] },
                appendedIDs: [],
                idsChanged: orderedIDs != ids,
                isAppendOnly: false
            )
        }

        func collectionView(
            _ collectionView: UICollectionView,
            prefetchItemsAt indexPaths: [IndexPath]
        ) {
            for indexPath in indexPaths where orderedIDs.indices.contains(indexPath.item) {
                let messageID = orderedIDs[indexPath.item]
                guard markdownPrefetches[messageID] == nil,
                      let message = messagesByID[messageID],
                      !message.text.isEmpty,
                      message.state != .streaming,
                      message.role == .user || message.role == .assistant else {
                    continue
                }

                let revision = MarkdownContentRevision(message.text)
                guard MarkdownRenderCache.shared.cachedDocument(for: revision) == nil else {
                    continue
                }

                let task = Task { [weak self] in
                    guard !Task.isCancelled else { return }
                    _ = await MarkdownRenderCache.shared.document(for: revision)
                    guard !Task.isCancelled else { return }
                    self?.finishMarkdownPrefetch(messageID: messageID, revision: revision)
                }
                markdownPrefetches[messageID] = MarkdownPrefetch(
                    revision: revision,
                    task: task
                )
            }
        }

        func collectionView(
            _ collectionView: UICollectionView,
            cancelPrefetchingForItemsAt indexPaths: [IndexPath]
        ) {
            let messageIDs = indexPaths.compactMap { indexPath in
                orderedIDs.indices.contains(indexPath.item) ? orderedIDs[indexPath.item] : nil
            }
            cancelMarkdownPrefetches(for: Set(messageIDs))
        }

        private func finishMarkdownPrefetch(
            messageID: String,
            revision: MarkdownContentRevision
        ) {
            guard markdownPrefetches[messageID]?.revision == revision else { return }
            markdownPrefetches.removeValue(forKey: messageID)
        }

        private func cancelMarkdownPrefetches(for messageIDs: Set<String>) {
            for messageID in messageIDs {
                markdownPrefetches.removeValue(forKey: messageID)?.task.cancel()
            }
        }

        private func cancelAllMarkdownPrefetches() {
            markdownPrefetches.values.forEach { $0.task.cancel() }
            markdownPrefetches.removeAll(keepingCapacity: true)
        }

        private func isNearBottom(_ collectionView: UICollectionView) -> Bool {
            let visibleBottom = collectionView.contentOffset.y
                + collectionView.bounds.height
                - collectionView.adjustedContentInset.bottom
            return collectionView.contentSize.height - visibleBottom < 120
        }

        private func scrollToBottom(
            _ collectionView: UICollectionView,
            animated: Bool
        ) {
            collectionView.layoutIfNeeded()
            let geometry = TranscriptViewportGeometry(
                contentHeight: collectionView.contentSize.height,
                viewportHeight: collectionView.bounds.height,
                topInset: collectionView.adjustedContentInset.top,
                bottomInset: collectionView.adjustedContentInset.bottom
            )
            let target = CGPoint(x: collectionView.contentOffset.x, y: geometry.bottomOffset)
            collectionView.setContentOffset(target, animated: animated)
            (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor = true
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            (scrollView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor = false
            scrollView.window?.endEditing(false)
            onDismissKeyboard?()
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            guard !decelerate else { return }
            updateBottomAnchor(for: scrollView)
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
            updateBottomAnchor(for: scrollView)
        }

        private func updateBottomAnchor(for scrollView: UIScrollView) {
            guard let collectionView = scrollView as? BottomAnchoredTranscriptCollectionView else {
                return
            }
            collectionView.maintainsBottomAnchor = isNearBottom(collectionView)
        }
    }
}

private struct FeatureLoadEarlierTurnsButton: View {
    let isLoading: Bool
    let onLoad: () -> Void

    var body: some View {
        Button(action: onLoad) {
            HStack(spacing: 7) {
                if isLoading {
                    Image(systemName: "ellipsis")
                        .font(T3Typography.supporting.weight(.semibold))
                }
                Text(isLoading ? "Loading earlier turns…" : "Load earlier turns")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: T3Metrics.minimumTapTarget)
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .accessibilityLabel(isLoading ? "Loading earlier turns" : "Load earlier turns")
    }
}

private struct FeatureThreadWorkingIndicator: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "circle.dotted")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(T3Colors.statusRunning)
                .frame(width: 22, height: 22)

            VStack(alignment: .leading, spacing: 2) {
                Text("Agent is working")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.statusRunning)
                Text("New output will appear here")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Agent is working. New output will appear here.")
    }
}

struct TranscriptViewportGeometry: Equatable {
    let contentHeight: CGFloat
    let viewportHeight: CGFloat
    let topInset: CGFloat
    let bottomInset: CGFloat

    var bottomOffset: CGFloat {
        max(-topInset, contentHeight - viewportHeight + bottomInset)
    }

    func restoredBottomOffset(
        after previous: Self?,
        maintainsBottomAnchor: Bool,
        isInteracting: Bool
    ) -> CGFloat? {
        guard maintainsBottomAnchor, !isInteracting else {
            return nil
        }

        guard let previous,
              previous.contentHeight > 0,
              previous.viewportHeight > 0 else {
            return contentHeight > 0 && viewportHeight > 0 ? bottomOffset : nil
        }

        let contentChanged = abs(contentHeight - previous.contentHeight) > 0.5
        let viewportChanged = abs(viewportHeight - previous.viewportHeight) > 0.5
            || abs(bottomInset - previous.bottomInset) > 0.5
        guard contentChanged || viewportChanged else { return nil }

        return bottomOffset
    }
}

/// Self-sizing hosted Markdown can change the transcript height after a snapshot finishes,
/// while presenting the keyboard changes the viewport without changing the content at all.
/// Preserve the visual bottom only while the reader is already following the latest turn.
private final class BottomAnchoredTranscriptCollectionView: UICollectionView {
    var maintainsBottomAnchor = false

    private var lastLaidOutGeometry: TranscriptViewportGeometry?
    private var isRestoringBottomAnchor = false

    override func layoutSubviews() {
        super.layoutSubviews()

        let geometry = TranscriptViewportGeometry(
            contentHeight: contentSize.height,
            viewportHeight: bounds.height,
            topInset: adjustedContentInset.top,
            bottomInset: adjustedContentInset.bottom
        )
        defer { lastLaidOutGeometry = geometry }

        guard let bottomY = geometry.restoredBottomOffset(
            after: lastLaidOutGeometry,
            maintainsBottomAnchor: maintainsBottomAnchor,
            isInteracting: isDragging || isDecelerating || isRestoringBottomAnchor
        ) else {
            return
        }
        guard abs(contentOffset.y - bottomY) > 0.5 else { return }

        isRestoringBottomAnchor = true
        contentOffset = CGPoint(x: contentOffset.x, y: bottomY)
        isRestoringBottomAnchor = false
    }
}

private struct FeatureRemoteAttachmentThumbnail: View {
    private struct Request: Hashable {
        let url: URL
        let maximumPixelSize: Int
    }

    @SwiftUI.Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var loadedRequest: Request?
    @State private var failedRequest: Request?

    let url: URL

    var body: some View {
        Group {
            if loadedRequest == request, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else if failedRequest == request {
                placeholder(systemImage: "exclamationmark.triangle")
            } else {
                placeholder(systemImage: "photo")
            }
        }
        .accessibilityHidden(true)
        .task(id: request) {
            let activeRequest = request
            do {
                let image = try await FeatureAttachmentThumbnailLoader.image(
                    for: activeRequest.url,
                    maximumPixelSize: activeRequest.maximumPixelSize
                )
                try Task.checkCancellation()
                self.image = image
                loadedRequest = activeRequest
                failedRequest = nil
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                image = nil
                loadedRequest = nil
                failedRequest = activeRequest
            }
        }
    }

    private var request: Request {
        Request(
            url: url,
            maximumPixelSize: min(768, max(190, Int(ceil(190 * displayScale))))
        )
    }

    private func placeholder(systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 22, weight: .medium))
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Local preview bytes routed through the shared thumbnail cache so streaming
/// reconfigures of a message with attachments never re-allocate UIImages in
/// body. Decode happens once, off the main thread.
private struct FeatureLocalAttachmentThumbnail: View {
    let attachmentID: String
    let previewData: Data

    @State private var image: UIImage?
    @State private var failed = false

    private var cacheKey: NSString { "local:\(attachmentID)" as NSString }

    var body: some View {
        Group {
            if let image = image ?? FeatureAttachmentThumbnailCache.shared.image(for: cacheKey) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else if failed {
                placeholder(systemImage: "exclamationmark.triangle")
            } else {
                placeholder(systemImage: "photo")
            }
        }
        .accessibilityHidden(true)
        .task(id: attachmentID) {
            guard FeatureAttachmentThumbnailCache.shared.image(for: cacheKey) == nil else { return }
            let data = previewData
            let decoded = await Task.detached(priority: .utility) {
                UIImage(data: data)
            }.value
            guard !Task.isCancelled else { return }
            if let decoded {
                FeatureAttachmentThumbnailCache.shared.insert(decoded, for: cacheKey)
                image = decoded
            } else {
                failed = true
            }
        }
    }

    private func placeholder(systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 22, weight: .medium))
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private enum FeatureAttachmentThumbnailLoader {
    static func image(for url: URL, maximumPixelSize: Int) async throws -> UIImage {
        let cacheKey = "\(url.absoluteString)#\(maximumPixelSize)" as NSString
        if let cached = FeatureAttachmentThumbnailCache.shared.image(for: cacheKey) {
            return cached
        }

        let (data, response) = try await URLSession.shared.data(from: url)
        try Task.checkCancellation()
        if let response = response as? HTTPURLResponse,
           !(200...299).contains(response.statusCode) {
            throw FeatureAttachmentThumbnailError.invalidResponse
        }

        let image = try await Task.detached(priority: .utility) {
            try downsample(data: data, maximumPixelSize: maximumPixelSize)
        }.value
        try Task.checkCancellation()
        FeatureAttachmentThumbnailCache.shared.insert(image, for: cacheKey)
        return image
    }

    private static func downsample(data: Data, maximumPixelSize: Int) throws -> UIImage {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            throw FeatureAttachmentThumbnailError.decodingFailed
        }

        let thumbnailOptions = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            thumbnailOptions
        ) else {
            throw FeatureAttachmentThumbnailError.decodingFailed
        }
        return UIImage(cgImage: thumbnail)
    }
}

private final class FeatureAttachmentThumbnailCache: @unchecked Sendable {
    static let shared = FeatureAttachmentThumbnailCache()

    private let images = NSCache<NSString, UIImage>()

    private init() {
        images.countLimit = 96
        images.totalCostLimit = 32 * 1_024 * 1_024
    }

    func image(for key: NSString) -> UIImage? {
        images.object(forKey: key)
    }

    func insert(_ image: UIImage, for key: NSString) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        images.setObject(image, forKey: key, cost: cost)
    }
}

private enum FeatureAttachmentThumbnailError: Error {
    case invalidResponse
    case decodingFailed
}

struct FeatureMessageView: View {
    let message: FeatureMessage

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 44)
                VStack(alignment: .leading, spacing: 10) {
                    FeatureMessageAttachmentsView(attachments: message.attachments)
                    if !message.text.isEmpty {
                        MarkdownMessageView(
                            message.text,
                            isStreaming: message.state == .streaming
                        )
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(maxWidth: T3Metrics.readingWidth * 0.88, alignment: .leading)
                .background(
                    T3Colors.subtleStrong,
                    in: UnevenRoundedRectangle(
                        topLeadingRadius: 16,
                        bottomLeadingRadius: 16,
                        bottomTrailingRadius: 4,
                        topTrailingRadius: 16
                    )
                )
            }
            .accessibilityLabel("You")
            .accessibilityValue(accessibilityValue)
            .accessibilityIdentifier("message-\(message.id)")
        case .assistant:
            VStack(alignment: .leading, spacing: 10) {
                if message.state == .streaming {
                    HStack(spacing: 6) {
                        Image(systemName: "circle.dotted")
                        Text("Working")
                    }
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.statusRunning)
                }
                FeatureMessageAttachmentsView(attachments: message.attachments)
                if !message.text.isEmpty {
                    MarkdownMessageView(
                        message.text,
                        isStreaming: message.state == .streaming
                    )
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("message-\(message.id)")
        case .tool:
            DisclosureGroup {
                Text(message.text)
                    .font(T3Typography.tool)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(.top, 8)
            } label: {
                Label(message.toolName ?? "Tool output", systemImage: "terminal")
                    .font(T3Typography.tool.weight(.medium))
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .padding(.vertical, 6)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .accessibilityIdentifier("message-\(message.id)")
        case .system:
            Text(message.text)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .accessibilityIdentifier("message-\(message.id)")
        }
    }

    private var accessibilityValue: String {
        let attachmentSummary = message.attachments.isEmpty
            ? ""
            : "\(message.attachments.count) image attachment"
                + (message.attachments.count == 1 ? "" : "s")
        return [message.text, attachmentSummary]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

private struct FeatureMessageAttachmentsView: View {
    let attachments: [FeatureMessageAttachment]
    @State private var previewedAttachment: FeatureMessageAttachment?

    var body: some View {
        if !attachments.isEmpty {
            LazyVGrid(
                columns: [
                    GridItem(.adaptive(minimum: 118, maximum: 190), spacing: 7),
                ],
                alignment: .leading,
                spacing: 7
            ) {
                ForEach(attachments) { attachment in
                    VStack(alignment: .leading, spacing: 6) {
                        if attachment.mimeType.hasPrefix("image/") {
                            Group {
                                if let previewData = attachment.previewData {
                                    FeatureLocalAttachmentThumbnail(
                                        attachmentID: attachment.id,
                                        previewData: previewData
                                    )
                                } else if let url = attachment.url {
                                    FeatureRemoteAttachmentThumbnail(url: url)
                                } else {
                                    attachmentPlaceholder(systemImage: "photo")
                                }
                            }
                            .frame(height: 160)
                            .frame(maxWidth: .infinity)
                            .background(T3Colors.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }

                        HStack(spacing: 9) {
                            Image(
                                systemName: attachment.mimeType.hasPrefix("image/")
                                    ? "photo"
                                    : "doc"
                            )
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(T3Colors.textSecondary)
                            .frame(width: 30, height: 30)
                            .background(
                                T3Colors.surfaceRaised,
                                in: RoundedRectangle(cornerRadius: 6)
                            )
                            VStack(alignment: .leading, spacing: 1) {
                                Text(attachment.name)
                                    .font(T3Typography.control)
                                    .lineLimit(1)
                                Text(
                                    ByteCountFormatter.string(
                                        fromByteCount: Int64(attachment.sizeBytes),
                                        countStyle: .file
                                    )
                                )
                                .font(T3Typography.supporting.monospacedDigit())
                                .foregroundStyle(T3Colors.textSecondary)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(7)
                    .overlay {
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(T3Colors.border, lineWidth: 1)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        attachment.mimeType.hasPrefix("image/")
                            ? "Image attachment"
                            : "File attachment"
                    )
                    .accessibilityValue(attachmentAccessibilityValue(attachment))
                    .accessibilityIdentifier("attachment-\(attachment.id)")
                    .accessibilityAddTraits(
                        attachment.mimeType.hasPrefix("image/") && attachment.url != nil
                            ? .isButton
                            : []
                    )
                    .accessibilityHint(
                        attachment.mimeType.hasPrefix("image/") && attachment.url != nil
                            ? "Opens full-screen preview"
                            : ""
                    )
                    .accessibilityAction {
                        if attachment.mimeType.hasPrefix("image/"), attachment.url != nil {
                            previewedAttachment = attachment
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if attachment.mimeType.hasPrefix("image/"), attachment.url != nil {
                            previewedAttachment = attachment
                        }
                    }
                }
            }
            .fullScreenCover(item: $previewedAttachment) { attachment in
                FeatureAttachmentPreview(attachment: attachment)
            }
        }
    }

    private func attachmentPlaceholder(systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 22, weight: .medium))
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func attachmentAccessibilityValue(
        _ attachment: FeatureMessageAttachment
    ) -> String {
        let size = ByteCountFormatter.string(
            fromByteCount: Int64(attachment.sizeBytes),
            countStyle: .file
        )
        return "\(attachment.name), \(size)"
    }
}

private struct FeatureAttachmentPreview: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let attachment: FeatureMessageAttachment

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let url = attachment.url {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFit()
                        case .failure:
                            ContentUnavailableView(
                                "Image unavailable",
                                systemImage: "exclamationmark.triangle"
                            )
                        case .empty:
                            ProgressView()
                        @unknown default:
                            ProgressView()
                        }
                    }
                    .padding(12)
                }
            }
            .navigationTitle(attachment.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .t3NavigationChrome()
        }
        .preferredColorScheme(.dark)
    }
}
