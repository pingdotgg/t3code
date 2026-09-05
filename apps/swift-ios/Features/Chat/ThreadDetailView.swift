import ImageIO
import SwiftUI
import UIKit

public struct ThreadDetailView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @SwiftUI.Environment(\.openURL) private var parentOpenURL
    @SwiftUI.Environment(\.scenePhase) private var scenePhase

    @Bindable var model: FeatureRootModel
    let thread: FeatureThread
    let submitMessage: (FeatureMessageSubmission) async -> Bool
    let onNavigateBack: () -> Void
    private let draftStore: FeatureComposerDraftStore

    @State private var draft = ""
    @State private var selection: FeatureSelection?
    @State private var attachments: [FeatureDraftAttachment] = []
    @State private var isSending = false
    @State private var submittingCompaction = false
    @State private var isLoading = true
    @State private var sendFailed = false
    @State private var feedbackMessages: [FeatureMessage] = []
    @State private var feedbackRevision: UInt64 = 0
    @State private var feedbackAlertMessage: String?
    @State private var feedbackIdentifier: String?
    @State private var didRestoreDraft = false
    @State private var draftSaveTask: Task<Void, Never>?
    @State private var draftSaveError: String?
    @State private var toolSurface: FeatureThreadToolSurface?
    @State private var branchPullRequest: FeaturePullRequest?
    @State private var linkedMediaPreview: FeatureLinkedMediaPreview?
    @State private var linkedMediaPreviewError: String?
    // Plain state, not `FocusState`: the composer's UIKit text view owns
    // focus and mirrors it through this binding, because SwiftUI drops
    // writes to a `FocusState` no `.focused()` view registers with.
    @State private var composerFocused = false

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
            if let detail {
                timeline(detail)
            } else if isLoading {
                FeatureThreadOpeningView()
            } else {
                ContentUnavailableView {
                    Label("Thread unavailable", systemImage: "exclamationmark.bubble")
                } description: {
                    Text("The thread could not be loaded.")
                } actions: {
                    Button("Retry", action: reloadThread)
                }
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
            isLoading = true
            _ = await model.detail(for: thread.id, force: true)
            isLoading = false
        }
        .task(id: thread.id) {
            // A cached thread can already show its composer while the server
            // is catching up. Local drafts must not wait for that request.
            guard !didRestoreDraft else { return }
            await restoreDraft(from: composerDraft, key: draftKey)
        }
        .task(id: pullRequestObservationID) {
            await observeThreadPullRequest()
        }
        .task(id: workspaceCatalogID) {
            if let environmentID = currentThread.environmentID, let cwd = workspaceCatalogPath,
               let instanceID = selection?.providerID ?? currentSelection?.providerID {
                await model.refreshWorkspaceProviders(environmentID: environmentID, cwd: cwd, instanceID: instanceID)
            }
        }
        .environment(\.providerSetupContext, currentThread.environmentID.map {
            ProviderSetupContext(model: model, environmentID: $0)
        })
        .onChange(of: draft) { scheduleDraftSave() }
        .onChange(of: selection) { scheduleDraftSave() }
        .onChange(of: threadConnectionState) { _, state in
            if state == .connected,
               case .failed = model.detailLoadStates[thread.id],
               !isLoading {
                reloadThread()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                persistDraftBeforeLeaving()
            }
        }
        .onDisappear {
            model.releaseThread(thread.id)
            persistDraftBeforeLeaving()
        }
        .sheet(item: $toolSurface) { surface in
            NavigationStack {
                Group {
                    switch surface {
                    case .files:
                        FeatureFilesView(
                            client: model.client,
                            threadID: thread.id,
                            workspaceRoot: markdownImageContext?.workspaceRoot
                        )
                    case let .file(path):
                        FeatureFilesView(
                            client: model.client,
                            threadID: thread.id,
                            initialPath: path,
                            workspaceRoot: markdownImageContext?.workspaceRoot
                        )
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
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .alert("Message not sent", isPresented: $sendFailed) {
            // Refocusing happens here rather than when the send fails: the
            // alert takes first responder from the composer, so a refocus
            // issued before it presents is lost by the time it dismisses.
            Button("OK") { composerFocused = true }
        } message: {
            Text("Your draft is still here. Check your connection and try again.")
        }
        .alert(
            feedbackIdentifier == nil ? "Could not send feedback" : "Feedback sent to OpenAI",
            isPresented: Binding(
                get: { feedbackAlertMessage != nil },
                set: { if !$0 { feedbackAlertMessage = nil; feedbackIdentifier = nil } }
            )
        ) {
            if let feedbackIdentifier {
                Button("Copy ID") {
                    UIPasteboard.general.string = feedbackIdentifier
                }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(feedbackAlertMessage ?? "")
        }
        .background {
            ThreadBackSwipeGestureView(
                isEnabled: horizontalSizeClass == .compact,
                onNavigateBack: onNavigateBack
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .environment(\.openURL, OpenURLAction { url in
            if handleArtifactTemplateURL(url) { return .handled }
            if handleTypedMediaPreviewURL(url) { return .handled }
            if case let .workspaceFile(hostPath) = MarkdownImageSource.classify(
                url.absoluteString, workspaceRoot: markdownImageContext?.workspaceRoot
            ) {
                let kind = FeatureFilePreviewKind.infer(path: hostPath)
                let suffix = URL(fileURLWithPath: hostPath).pathExtension.lowercased()
                if kind == .image || kind == .video || kind == .pdf || ["html", "htm"].contains(suffix) {
                    resolveHostMedia(path: hostPath, kind: kind)
                    return .handled
                }
            }
            guard let workspaceRoot = markdownImageContext?.workspaceRoot,
                  let path = MarkdownWorkspaceFileLink.relativePath(
                      for: url,
                      workspaceRoot: workspaceRoot
                  ) else {
                if url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https",
                   let kind = FeatureLinkedMediaPreview.previewKind(for: url) {
                    linkedMediaPreview = FeatureLinkedMediaPreview(
                        source: url.isFileURL ? .file(url) : .remote(url),
                        kind: kind,
                        fileName: url.lastPathComponent
                    )
                    return .handled
                }
                if url.isFileURL {
                    let path = url.path
                    let kind = FeatureFilePreviewKind.infer(path: path)
                    if kind == .image || kind == .video {
                        resolveHostMedia(path: path, kind: kind)
                        return .handled
                    }
                }
                if url.scheme?.lowercased() == "t3code" { return .discarded }
                parentOpenURL(url)
                return .handled
            }
            let kind = FeatureFilePreviewKind.infer(path: path)
            if kind == .image || kind == .video {
                resolveHostMedia(path: path, kind: kind)
                return .handled
            }
            toolSurface = .file(path)
            return .handled
        })
        .fullScreenCover(item: $linkedMediaPreview) { preview in
            NavigationStack {
                FeatureNativeMediaPreviewView(
                    source: preview.source,
                    kind: preview.kind,
                    fileName: preview.fileName
                )
                .navigationTitle(preview.fileName)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { linkedMediaPreview = nil }
                    }
                }
            }
            .preferredColorScheme(.dark)
        }
        .alert(
            "Preview unavailable",
            isPresented: Binding(
                get: { linkedMediaPreviewError != nil },
                set: { if !$0 { linkedMediaPreviewError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(linkedMediaPreviewError ?? "The file could not be opened.")
        }
    }

    private var detail: FeatureThreadDetail? {
        model.details[thread.id]
    }

    private var currentThread: FeatureThread {
        detail?.thread ?? thread
    }

    private var isCompacting: Bool {
        submittingCompaction || detail?.isCompacting == true
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

                // Cached work state is not proof that the agent is still
                // running. Only current, working threads need a live timer.
                Group {
                    if refreshPresentation != nil {
                        EmptyView()
                    } else if currentThread.homeStatus == .working, !isCompacting {
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
        // Leave compact-width clearance for the trailing thread menu.
        .padding(.trailing, horizontalSizeClass == .compact ? 10 : 0)
        .frame(maxWidth: horizontalSizeClass == .compact ? 260 : 460, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityAddTraits(
            refreshPresentation == nil && !isCompacting && currentThread.hasLiveWorkingDuration
                ? .updatesFrequently : []
        )
        .transaction { transaction in
            transaction.animation = nil
            transaction.disablesAnimations = true
        }
    }

    @ViewBuilder
    private func headerStatus(at now: Date) -> some View {
        let duration = currentThread.homeWorkingDuration(at: now)
        if isCompacting {
            Label("Compacting", systemImage: "arrow.down.right.and.arrow.up.left")
                .font(T3Typography.status)
                .foregroundStyle(T3Colors.statusRunning)
                .lineLimit(1)
        } else if let label = duration ?? currentThread.detailHeaderStatusLabel {
            HStack(spacing: 5) {
                if let icon = currentThread.detailHeaderStatusIcon {
                    Image(systemName: icon)
                }
                headerStatusText(label, isDuration: duration != nil)
            }
            .font(T3Typography.status)
            .foregroundStyle(headerStatusColor)
            .lineLimit(1)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(currentThread.homeStatusAccessibilityLabel(at: now))
        }
    }

    @ViewBuilder
    private func headerStatusText(_ label: String, isDuration: Bool) -> some View {
        if isDuration {
            Text(label)
                .monospaced()
                .monospacedDigit()
        } else {
            Text(label)
        }
    }

    private var threadActionsMenu: some View {
        Menu {
            Section("Thread") {
                if let pullRequest = currentPullRequest {
                    Button {
                        parentOpenURL(pullRequest.url)
                    } label: {
                        Label("Open pull request #\(pullRequest.number)", systemImage: "arrow.triangle.pull")
                    }
                }
                if currentThread.supportsTitleRegeneration == true {
                    Button {
                        Task { await model.regenerateThreadTitle(thread.id) }
                    } label: {
                        Label("Regenerate title", systemImage: "sparkles")
                    }
                }
                Menu {
                    if !FeatureRuntimeMode.allCases.contains(currentThread.runtimeMode) {
                        Section("Current") {
                            Button {} label: {
                                Label(
                                    runtimeModeLabel(currentThread.runtimeMode),
                                    systemImage: "checkmark"
                                )
                            }
                            .disabled(true)
                        }
                    }
                    ForEach(FeatureRuntimeMode.allCases, id: \.self) { mode in
                        Button {
                            guard currentThread.runtimeMode != mode else {
                                return
                            }
                            Task { await model.setRuntimeMode(thread.id, mode: mode) }
                        } label: {
                            if currentThread.runtimeMode == mode {
                                Label(runtimeModeLabel(mode), systemImage: "checkmark")
                            } else {
                                Text(runtimeModeLabel(mode))
                            }
                        }
                    }
                } label: {
                    Label("Permissions", systemImage: "checkmark.shield")
                }
                .disabled(model.isPerformingAction)
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
                let isSettled = model.isEffectivelySettled(currentThread)
                if (isSettled || currentThread.canSettleNow()), !currentThread.isArchived {
                    Button {
                        Task { await model.setSettled(thread.id, settled: !isSettled) }
                    } label: {
                        Label(
                            isSettled ? "Reopen" : "Settle",
                            systemImage: isSettled ? "arrow.counterclockwise" : "checkmark"
                        )
                    }
                }
                Button(action: reloadThread) {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
            }
            Section("Workspace") {
                Button { toolSurface = .files } label: {
                    Label("Files", systemImage: "folder")
                }
                Button { toolSurface = .review } label: {
                    Label("Review changes", systemImage: "doc.text.magnifyingglass")
                }
                Button { toolSurface = .sourceControl } label: {
                    Label("Source control", systemImage: "arrow.triangle.branch")
                }
                Button { toolSurface = .terminal } label: {
                    Label("Terminal", systemImage: "terminal")
                }
            }
            Section {
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
        .accessibilityHint("Shows thread actions and workspace tools")
        .accessibilityIdentifier("thread-actions-menu")
    }

    private func runtimeModeLabel(_ mode: FeatureRuntimeMode) -> String {
        switch mode {
        case .approvalRequired: "Supervised"
        case .autoAcceptEdits: "Auto-accept edits"
        case .automatic: "Automatic"
        case .fullAccess: "Full access"
        }
    }

    private var currentPullRequest: ThreadPullRequestDestination? {
        return ThreadPullRequestDestination.resolve(
            thread: currentThread,
            branchPullRequest: branchPullRequest
        )
    }

    private var pullRequestObservationID: String? {
        currentThread.pullRequestObservationIdentity
    }

    @MainActor
    private func observeThreadPullRequest() async {
        branchPullRequest = nil
        guard let observationIdentity = pullRequestObservationID else {
            branchPullRequest = nil
            return
        }

        if let linked = currentThread.linkedPullRequest,
           let environmentID = currentThread.environmentID {
            let target = FeaturePullRequestTarget(
                environmentID: environmentID,
                environmentName: currentThread.environmentName ?? environmentID,
                reference: PullRequestRef(
                    projectId: linked.projectId,
                    repository: linked.repository,
                    number: linked.number
                )
            )
            while !Task.isCancelled {
                if let detail = try? await model.client.pullRequestDetail(target),
                   let presentation = HomeThreadPullRequestPresentation.resolve(
                       linkedPullRequest: linked,
                       detail: detail
                   ) {
                    model.updatePullRequest(
                        presentation,
                        threadID: currentThread.id,
                        observationIdentity: observationIdentity
                    )
                }
                do {
                    try await Task.sleep(for: .seconds(30))
                } catch {
                    return
                }
            }
            return
        }

        for await status in model.client.sourceControlStatusEvents(threadID: thread.id) {
            guard !Task.isCancelled else { return }
            let next = status.branch == currentThread.branch ? status.pullRequest : nil
            if next != branchPullRequest {
                branchPullRequest = next
            }
            model.updatePullRequest(
                HomeThreadPullRequestPresentation.resolve(thread: currentThread, status: status),
                threadID: currentThread.id,
                observationIdentity: observationIdentity
            )
        }
    }

    private func reloadThread() {
        isLoading = true
        Task {
            _ = await model.detail(for: thread.id, force: true, fresh: true)
            isLoading = false
        }
    }

    private var threadConnectionState: FeatureConnection.State? {
        guard let environmentID = currentThread.environmentID else { return nil }
        return model.snapshot.environments.first { $0.id == environmentID }?.connectionState
    }

    private var refreshPresentation: ThreadRefreshPresentation? {
        ThreadRefreshPresentation.resolve(
            loadState: model.detailLoadStates[thread.id],
            connectionState: threadConnectionState,
            isOpening: isLoading,
            syncState: model.threadSyncStates[thread.id]
        )
    }

    @ViewBuilder
    private var refreshStatus: some View {
        if let refreshPresentation {
            HStack(spacing: 8) {
                Label(refreshPresentation.title, systemImage: refreshPresentation.systemImage)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 4)
                if refreshPresentation.canRetry {
                    Button(action: reloadThread) {
                        Label("Retry", systemImage: "arrow.clockwise")
                            .font(T3Typography.control)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(T3Colors.accent)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .accessibilityIdentifier("thread-refresh-retry")
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
            .accessibilityIdentifier("thread-refresh-status")
        }
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

    private var headerStatusColor: Color {
        switch currentThread.homeStatus {
        case .working: T3Colors.statusRunning
        case .monitoring: T3Colors.statusRunning
        case .approval: T3Colors.warning
        case .input: T3Colors.statusInput
        case .failed: T3Colors.danger
        case .done: T3Colors.success
        case .ready: T3Colors.textTertiary
        }
    }

    private func timeline(_ detail: FeatureThreadDetail) -> some View {
        let hasActiveWork = detail.thread.state == .working
            || detail.thread.state == .queued
            || detail.thread.state == .monitoring
            || isCompacting
        let isWorking = hasActiveWork && refreshPresentation == nil
        return Group {
            if detail.messages.isEmpty, !hasActiveWork {
                if refreshPresentation == nil {
                    ContentUnavailableView(
                        "Ready for a task",
                        systemImage: "sparkles",
                        description: Text("Tell the agent what you want to build.")
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    Color.clear
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                FeatureTranscriptCollectionView(
                    threadID: thread.id,
                    messages: timelineMessages(detail.messages),
                    imageContext: markdownImageContext,
                    renderUpdate: timelineRenderUpdate,
                    dynamicTypeSize: dynamicTypeSize,
                    isWorking: isWorking,
                    isCompacting: isCompacting,
                    activeSubagentCount: detail.activeSubagentCount,
                    backgroundWorkIsActive: detail.backgroundWorkIsActive,
                    isMonitoring: detail.thread.state == .monitoring,
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
            VStack(spacing: 0) {
                refreshStatus
                FeatureComposerView(
                    text: $draft,
                    selection: $selection,
                    attachments: attachmentBinding,
                    draftOwnerID: "thread:\(currentThread.id)",
                    environmentID: currentThread.environmentID,
                    draftStorageKey: draftKey,
                    environmentIsConnected: threadConnectionState == .connected,
                    attachmentUploads: model.attachmentUploads,
                    attachmentPreferences: currentThread.environmentID.flatMap {
                        model.snapshot.preferencesByEnvironment?[$0]
                    } ?? FeatureEnvironmentPreferences(),
                    providers: threadProviders,
                    threadSelection: currentSelection,
                    materializesDefaultSelection: false,
                    isSending: isSending,
                    isWorking: detail.thread.state == .working || detail.thread.state == .queued
                        || isCompacting,
                    focused: $composerFocused,
                    onSend: send,
                    onStop: {
                        Task { await model.cancelTurn(threadID: thread.id) }
                    },
                    pendingApprovals: detail.approvals,
                    pendingUserInputs: detail.userInputs,
                    isResolvingRequest: model.isPerformingAction,
                    powerFeatures: composerPowerFeatures,
                    onDismissKeyboard: dismissKeyboard,
                    onApprovalDecision: { id, decision in
                        Task { await model.resolveApproval(id, decision: decision) }
                    },
                    onUserInputSubmit: { id, answers in
                        Task { await model.resolveUserInput(id, answers: answers) }
                    },
                    onRefreshModels: refreshThreadEnvironmentModels,
                    draftSaveError: draftSaveError,
                    onRetryDraftSave: persistDraftImmediately
                )
            }
            .background(T3Colors.background)
        }
    }

    private var composerPowerFeatures: FeatureComposerPowerFeatures {
        let selectedProviderID = selection?.providerID ?? currentSelection?.providerID
        let provider = threadProviders.first { $0.id == selectedProviderID }
        return FeatureComposerPowerFeatures(
            slashCommands: provider?.workspaceCatalog(cwd: workspaceCatalogPath).slashCommands ?? [],
            skills: provider?.workspaceCatalog(cwd: workspaceCatalogPath).skills ?? [],
            canCompactContext: FeatureContextCompaction.canStart(
                in: detail,
                isBusy: isSending || refreshPresentation != nil
            ),
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
        ThreadComposerProviderCatalog.providers(
            for: currentThread,
            in: model.snapshot
        )
    }

    private var workspaceCatalogPath: String? {
        currentThread.worktreePath ?? model.snapshot.projects.first { $0.id == currentThread.projectID }?.path
    }

    private var workspaceCatalogID: String {
        "\(currentThread.environmentID ?? ""):\(workspaceCatalogPath ?? ""):\(selection?.providerID ?? currentSelection?.providerID ?? "")"
    }

    private func refreshThreadEnvironmentModels() async throws {
        guard let environmentID = currentThread.environmentID else { return }
        guard await model.refreshProviders(environmentID: environmentID) else {
            throw FeatureModelRefreshError()
        }
    }

    private var timelineRenderUpdate: FeatureDetailRenderUpdate? {
        guard !feedbackMessages.isEmpty else {
            return model.detailRenderUpdates[thread.id]
        }
        let revision = model.detailRevisions[thread.id] ?? 0
        return FeatureDetailRenderUpdate(
            baseRevision: revision,
            revision: (UInt64.max / 2) &+ revision &+ feedbackRevision,
            change: .full
        )
    }

    private func timelineMessages(_ messages: [FeatureMessage]) -> [FeatureMessage] {
        guard !feedbackMessages.isEmpty else { return messages }
        return (messages + feedbackMessages).sorted {
            if $0.createdAt == $1.createdAt {
                return $0.id < $1.id
            }
            return $0.createdAt < $1.createdAt
        }
    }

    private var markdownImageContext: MarkdownImageContext? {
        guard let resolver = model.client as? any FeatureWorkspaceAssetResolving,
              let project = model.snapshot.projects.first(where: {
                  $0.id == currentThread.projectID
              }) else {
            return nil
        }
        return MarkdownImageContext(
            threadID: currentThread.id,
            workspaceRoot: currentThread.worktreePath ?? project.path,
            resolver: resolver
        )
    }

    private func handleArtifactTemplateURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "t3code",
              url.host?.lowercased() == "codex-artifact-template",
              url.path == "/use",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.queryItems?.count == 1,
              components.queryItems?.first?.name == "prompt",
              let prompt = components.queryItems?.first?.value?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !prompt.isEmpty, prompt.count <= 4_096 else { return false }
        if draft == prompt || draft.hasSuffix(" \(prompt)") || draft.hasSuffix("\n\(prompt)") {
            composerFocused = true
            return true
        }
        draft = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? prompt
            : draft + (draft.last?.isWhitespace == true ? "" : " ") + prompt
        composerFocused = true
        return true
    }

    private func handleTypedMediaPreviewURL(_ url: URL) -> Bool {
        guard let route = FeatureTypedMediaPreviewRoute.parse(url) else { return false }
        resolveHostMedia(path: route.path, kind: route.kind)
        return true
    }

    private func resolveHostMedia(path: String, kind: FeatureFilePreviewKind) {
        guard let resolver = model.client as? any FeatureWorkspaceAssetResolving else {
            linkedMediaPreviewError = "This environment cannot resolve media files."
            return
        }
        let requestedThreadID = currentThread.id
        Task {
            do {
                let resolved = try await resolver.mediaAssetURL(
                    threadID: requestedThreadID,
                    path: path
                )
                guard !Task.isCancelled, currentThread.id == requestedThreadID else { return }
                linkedMediaPreview = FeatureLinkedMediaPreview(
                    source: .remote(resolved),
                    kind: kind,
                    fileName: URL(fileURLWithPath: path).lastPathComponent
                )
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, currentThread.id == requestedThreadID else { return }
                linkedMediaPreviewError = error.localizedDescription
            }
        }
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
        let pendingAttachments = currentThread.environmentID.map {
            model.attachmentUploads.attachmentsForSend(
                draftKey: draftKey,
                environmentID: $0,
                attachments: attachments
            )
        } ?? attachments
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pendingAttachments.isEmpty else {
            return
        }
        if pendingAttachments.isEmpty,
           let command = FeatureCodexFeedbackCommand.parse(message),
           let providerID = currentThread.providerID,
           threadProviders.first(where: { $0.id == providerID })?.driver == "codex"
               || currentThread.providerName?.lowercased() == "codex",
           let submitter = model.client as? any FeatureFeedbackSubmitting {
            sendFeedback(command, message: message, submitter: submitter)
            return
        }
        let pendingDraftSave = draftSaveTask
        pendingDraftSave?.cancel()
        draftSaveTask = nil
        isSending = true
        submittingCompaction = FeatureContextCompaction.isCommand(
            message,
            hasAttachments: !pendingAttachments.isEmpty
        )
        draft = ""
        attachments = []
        composerFocused = false
        Task {
            await pendingDraftSave?.value
            let sent = await submitMessage(
                FeatureMessageSubmission(
                threadID: thread.id,
                text: message,
                selection: selection,
                attachments: pendingAttachments
                )
            )
            if sent {
                let trailingSave = draftSaveTask
                trailingSave?.cancel()
                draftSaveTask = nil
                await trailingSave?.value
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
            }
            submittingCompaction = false
            isSending = false
            if !sent || !draft.isEmpty || !attachments.isEmpty {
                persistDraftImmediately()
            }
        }
    }

    private func sendFeedback(
        _ command: FeatureCodexFeedbackCommand,
        message: String,
        submitter: any FeatureFeedbackSubmitting
    ) {
        guard detail?.messages.isEmpty == false else {
            feedbackAlertMessage = "Send a message before you submit feedback."
            return
        }

        let identifier = UUID().uuidString
        let createdAt = Date()
        let assistantID = "\(identifier):feedback"
        feedbackMessages.append(FeatureMessage(
            id: identifier,
            role: .user,
            text: message,
            createdAt: createdAt
        ))
        feedbackMessages.append(FeatureMessage(
            id: assistantID,
            role: .assistant,
            text: "Sending feedback to OpenAI...",
            createdAt: createdAt.addingTimeInterval(0.001)
        ))
        feedbackRevision &+= 1
        draftSaveTask?.cancel()
        draft = ""
        composerFocused = false
        isSending = true

        Task {
            defer {
                isSending = false
                if !draft.isEmpty || !attachments.isEmpty {
                    persistDraftImmediately()
                }
            }
            do {
                let identifier = try await submitter.submitCodexFeedback(
                    threadID: thread.id,
                    reason: command.reason
                )
                updateFeedbackMessage(
                    id: assistantID,
                    text: "Feedback sent to OpenAI.\n\nThread ID: `\(identifier)`"
                )
                feedbackIdentifier = identifier
                feedbackAlertMessage = "Thread ID: \(identifier)"
                try? await draftStore.removeDraft(for: draftKey)
            } catch {
                let detail = error.localizedDescription
                updateFeedbackMessage(
                    id: assistantID,
                    text: "Could not send feedback to OpenAI.\n\n\(detail)"
                )
                feedbackIdentifier = nil
                feedbackAlertMessage = detail
            }
        }
    }

    private func updateFeedbackMessage(id: String, text: String) {
        guard let index = feedbackMessages.firstIndex(where: { $0.id == id }) else { return }
        feedbackMessages[index].text = text
        feedbackRevision &+= 1
    }

    private var draftKey: String {
        FeatureComposerDraftStore.threadKey(currentThread)
    }

    private var attachmentBinding: Binding<[FeatureDraftAttachment]> {
        Binding(
            get: { attachments },
            set: { value in
                attachments = value
                // Photo results arrive while a full-screen cover is closing.
                // Save at the handoff, not through a parent view observer.
                persistDraftImmediately()
            }
        )
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
        } else if saved != nil, let environmentID = currentThread.environmentID {
            model.attachmentUploads.syncOwner(
                draftKey: key,
                environmentID: environmentID,
                attachments: restored.attachments
            )
        }
    }

    private func scheduleDraftSave() {
        guard didRestoreDraft, !isSending else { return }
        let previousSave = draftSaveTask
        previousSave?.cancel()
        let snapshot = composerDraft
        let key = draftKey
        let environmentID = currentThread.environmentID
        draftSaveTask = Task {
            await previousSave?.value
            do {
                try await Task.sleep(for: .milliseconds(220))
                try Task.checkCancellation()
                try await draftStore.setDraft(snapshot, for: key)
                guard !Task.isCancelled else { return }
                draftSaveError = nil
                if let environmentID {
                    model.attachmentUploads.syncOwner(
                        draftKey: key,
                        environmentID: environmentID,
                        attachments: snapshot.attachments
                    )
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                draftSaveError = "Could not save draft. \(error.localizedDescription)"
            }
        }
    }

    private func persistDraftImmediately() {
        guard didRestoreDraft, !isSending else { return }
        let previousSave = draftSaveTask
        previousSave?.cancel()
        let snapshot = composerDraft
        let key = draftKey
        let environmentID = currentThread.environmentID
        draftSaveTask = Task {
            do {
                await previousSave?.value
                try Task.checkCancellation()
                try await draftStore.setDraft(snapshot, for: key)
                guard !Task.isCancelled else { return }
                draftSaveError = nil
                if let environmentID {
                    model.attachmentUploads.syncOwner(
                        draftKey: key,
                        environmentID: environmentID,
                        attachments: snapshot.attachments
                    )
                }
            } catch {
                guard !Task.isCancelled else { return }
                draftSaveError = "Could not save draft. \(error.localizedDescription)"
            }
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

enum ThreadRefreshPresentation: Equatable {
    case loading
    case catchingUp
    case reconnecting
    case offline
    case failed

    var title: String {
        switch self {
        case .loading: "Updating thread..."
        case .catchingUp: "Catching up..."
        case .reconnecting: "Reconnecting..."
        case .offline: "Computer offline"
        case .failed: "Could not update thread"
        }
    }

    var systemImage: String {
        switch self {
        case .loading, .catchingUp: "hourglass"
        case .reconnecting: "wifi"
        case .offline, .failed: "wifi.exclamationmark"
        }
    }

    var canRetry: Bool { self == .offline || self == .failed }

    static func resolve(
        loadState: FeatureThreadLoadState?,
        connectionState: FeatureConnection.State?,
        isOpening: Bool,
        syncState: FeatureThreadSyncState? = nil
    ) -> Self? {
        switch syncState {
        case .catchingUp: return .catchingUp
        case .reconnecting: return .reconnecting
        case .failed: return .failed
        case .live, nil: break
        }
        // A synchronized subscription outranks local loading flags and an
        // environment's periodic shell probe. Socket loss has its own state.
        if syncState == .live { return nil }
        if isOpening || loadState == .loading { return .loading }
        if case .failed = loadState { return .failed }
        switch connectionState {
        case .connecting, .reconnecting: return .reconnecting
        case .disconnected: return .offline
        case .connected, nil: return nil
        }
    }
}

private struct FeatureThreadOpeningView: View {
    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.regular)
            Text("Loading thread…")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread-opening-state")
    }
}

private enum FeatureThreadToolSurface: Identifiable {
    case files
    case file(String)
    case review
    case sourceControl
    case terminal

    var id: String {
        switch self {
        case .files: "files"
        case let .file(path): "file:\(path)"
        case .review: "review"
        case .sourceControl: "sourceControl"
        case .terminal: "terminal"
        }
    }
}

struct ThreadPullRequestDestination: Equatable {
    let number: Int
    let url: URL

    static func resolve(
        thread: FeatureThread,
        branchPullRequest: FeaturePullRequest?
    ) -> Self? {
        if let linked = thread.linkedPullRequest,
           let url = URL(string: linked.url) {
            return Self(number: linked.number, url: url)
        }

        guard let pullRequest = branchPullRequest,
              let url = pullRequest.url else { return nil }
        return Self(number: pullRequest.number, url: url)
    }
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
    let imageContext: MarkdownImageContext?
    let renderUpdate: FeatureDetailRenderUpdate?
    let dynamicTypeSize: DynamicTypeSize
    let isWorking: Bool
    let isCompacting: Bool
    let activeSubagentCount: Int
    let backgroundWorkIsActive: Bool
    let isMonitoring: Bool
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
            imageContext: imageContext,
            renderUpdate: renderUpdate,
            dynamicTypeSize: dynamicTypeSize,
            isWorking: isWorking,
            isCompacting: isCompacting,
            activeSubagentCount: activeSubagentCount,
            backgroundWorkIsActive: backgroundWorkIsActive,
            isMonitoring: isMonitoring,
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
        private var currentImageContext: MarkdownImageContext?
        private var currentDetailRevision: UInt64?
        private var currentDynamicTypeSize: DynamicTypeSize?
        private var currentIsWorking = false
        private var currentIsCompacting = false
        private var currentActiveSubagentCount = 0
        private var currentBackgroundWorkIsActive = false
        private var currentIsMonitoring = false
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
                        FeatureThreadWorkingIndicator(
                            isCompacting: self?.currentIsCompacting == true,
                            activeSubagentCount: self?.currentActiveSubagentCount ?? 0,
                            backgroundWorkIsActive: self?.currentBackgroundWorkIsActive == true,
                            isMonitoring: self?.currentIsMonitoring == true
                        )
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
                    FeatureMessageView(message: message, imageContext: self?.currentImageContext)
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
            imageContext: MarkdownImageContext?,
            renderUpdate: FeatureDetailRenderUpdate?,
            dynamicTypeSize: DynamicTypeSize,
            isWorking: Bool,
            isCompacting: Bool,
            activeSubagentCount: Int,
            backgroundWorkIsActive: Bool,
            isMonitoring: Bool,
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
            let imageContextChanged = currentImageContext != imageContext
            let typeSizeChanged = currentDynamicTypeSize != dynamicTypeSize
            let revisionChanged = currentDetailRevision != renderUpdate?.revision
            let workingChanged = currentIsWorking != isWorking
            let workingDetailChanged = currentIsCompacting != isCompacting
                || currentActiveSubagentCount != activeSubagentCount
                || currentBackgroundWorkIsActive != backgroundWorkIsActive
                || currentIsMonitoring != isMonitoring
            let loadEarlierChanged = currentCanLoadEarlier != canLoadEarlier
                || currentIsLoadingEarlier != isLoadingEarlier
            guard threadChanged || imageContextChanged || typeSizeChanged || revisionChanged || workingChanged
                || workingDetailChanged || loadEarlierChanged else { return }

            let incremental = !threadChanged
                ? incrementalState(messages: messages, renderUpdate: renderUpdate)
                : nil
            let state = incremental ?? fullState(messages: messages)
            let newIDs = state.ids
            let idsChanged = state.idsChanged
            let changedIDs = typeSizeChanged || imageContextChanged
                ? newIDs
                : state.changedIDs

            currentImageContext = imageContext
            currentDetailRevision = renderUpdate?.revision
            currentDynamicTypeSize = dynamicTypeSize
            currentIsWorking = isWorking
            currentIsCompacting = isCompacting
            currentActiveSubagentCount = activeSubagentCount
            currentBackgroundWorkIsActive = backgroundWorkIsActive
            currentIsMonitoring = isMonitoring
            currentCanLoadEarlier = canLoadEarlier
            currentIsLoadingEarlier = isLoadingEarlier
            guard threadChanged || idsChanged || !changedIDs.isEmpty || workingChanged
                || workingDetailChanged || loadEarlierChanged else { return }

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
            if workingDetailChanged,
               snapshot.indexOfItem(FeatureTranscriptCollectionView.workingIndicatorID) != nil {
                reconfiguredIDs.append(FeatureTranscriptCollectionView.workingIndicatorID)
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
    let isCompacting: Bool
    let activeSubagentCount: Int
    let backgroundWorkIsActive: Bool
    let isMonitoring: Bool

    private var title: String {
        if isCompacting {
            return "Compacting context"
        }
        if isMonitoring {
            return "Monitoring in the background"
        }
        if activeSubagentCount == 1 {
            return "1 subagent is working"
        }
        if activeSubagentCount > 1 {
            return "\(activeSubagentCount) subagents are working"
        }
        return backgroundWorkIsActive ? "Background work is running" : "Agent is working"
    }

    private var detail: String? {
        isCompacting || backgroundWorkIsActive || isMonitoring ? nil : "New output will appear here"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: isCompacting ? "arrow.down.right.and.arrow.up.left" : "circle.dotted")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(T3Colors.statusRunning)
                .frame(width: 22, height: 22)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.statusRunning)
                if let detail {
                    Text(detail)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(detail.map { "\(title). \($0)." } ?? "\(title).")
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

/// The detail surface uses a native pan recognizer instead of a SwiftUI
/// `DragGesture`. SwiftUI's broad drag recognizer can begin before it knows
/// whether a gesture is vertical, which competes with the transcript's native
/// collection-view scrolling. This recognizer fails for vertical motion at
/// gesture-begin time and remains simultaneous with the collection view for
/// horizontal motion.
enum ThreadBackSwipeGesture {
    static let minimumTranslation: CGFloat = 72
    static let horizontalToVerticalRatio: CGFloat = 1.4
    private static let scrollExtentEpsilon: CGFloat = 1

    static func shouldBegin(with velocity: CGPoint) -> Bool {
        shouldBegin(with: velocity, translation: .zero)
    }

    static func shouldBegin(with velocity: CGPoint, translation: CGPoint) -> Bool {
        let direction = hypot(translation.x, translation.y) >= 8 ? translation : velocity
        return direction.x > 0
            && direction.x >= abs(direction.y) * horizontalToVerticalRatio
    }

    static func shouldNavigateBack(with translation: CGPoint) -> Bool {
        translation.x >= minimumTranslation
            && translation.x >= abs(translation.y) * horizontalToVerticalRatio
    }

    @MainActor
    static func shouldAllowSimultaneousRecognition(with scrollView: UIScrollView) -> Bool {
        let hasHorizontalContent = scrollView.alwaysBounceHorizontal
            || scrollView.contentSize.width
                > scrollView.bounds.width + scrollExtentEpsilon
        guard hasHorizontalContent else {
            return scrollView.alwaysBounceVertical
                || scrollView.contentSize.height
                    > scrollView.bounds.height + scrollExtentEpsilon
        }
        return isAtLeadingEdge(scrollView)
    }

    @MainActor
    static func shouldReceiveTouch(in view: UIView?, host: UIView) -> Bool {
        var currentView = view
        while let current = currentView {
            // Editable text and an active transcript selection need to own
            // horizontal drags for caret and selection-handle movement. Plain
            // rendered message text still participates in the full-surface pan.
            if current is UITextField {
                return false
            }
            if let textView = current as? UITextView,
               textView.isEditable || textView.isFirstResponder {
                return false
            }
            if let scrollView = current as? UIScrollView,
               scrollView.alwaysBounceHorizontal
                || scrollView.contentSize.width
                    > scrollView.bounds.width + scrollExtentEpsilon {
                guard isAtLeadingEdge(scrollView) else { return false }
            }
            if current === host { return true }
            currentView = current.superview
        }
        return false
    }

    @MainActor
    private static func isAtLeadingEdge(_ scrollView: UIScrollView) -> Bool {
        scrollView.contentOffset.x
            <= -scrollView.adjustedContentInset.left + scrollExtentEpsilon
    }

    @MainActor
    static func shouldReceiveTouch(
        _ touch: UITouch,
        surface: UIView,
        host: UIView
    ) -> Bool {
        guard surface.window === host.window,
              surface.bounds.contains(touch.location(in: surface)),
              shouldReceiveTouch(in: touch.view, host: host),
              surface.window?.rootViewController?.presentedViewController == nil else {
            return false
        }
        return true
    }
}

private struct ThreadBackSwipeGestureView: UIViewRepresentable {
    let isEnabled: Bool
    let onNavigateBack: () -> Void

    func makeUIView(context: Context) -> InstallerView {
        let view = InstallerView()
        view.update(isEnabled: isEnabled, onNavigateBack: onNavigateBack)
        return view
    }

    func updateUIView(_ view: InstallerView, context: Context) {
        view.update(isEnabled: isEnabled, onNavigateBack: onNavigateBack)
    }

    static func dismantleUIView(_ view: InstallerView, coordinator: ()) {
        view.uninstallGesture()
    }

    final class InstallerView: UIView {
        private var isEnabled = false
        private var onNavigateBack: (() -> Void)?
        private weak var gestureHost: UIView?
        private var panGesture: UIPanGestureRecognizer?
        private var gestureDelegate: GestureDelegate?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil {
                uninstallGesture()
            } else {
                installGestureIfPossible()
            }
        }

        func update(isEnabled: Bool, onNavigateBack: @escaping () -> Void) {
            self.isEnabled = isEnabled
            self.onNavigateBack = onNavigateBack
            installGestureIfPossible()
        }

        func uninstallGesture() {
            if let panGesture, let gestureHost {
                gestureHost.removeGestureRecognizer(panGesture)
            }
            panGesture = nil
            gestureDelegate = nil
            gestureHost = nil
        }

        private func installGestureIfPossible() {
            // SwiftUI hosts a background UIViewRepresentable beside, rather than
            // above, the transcript and composer. Install on their shared root
            // view and use the representable's frame to scope received touches.
            guard isEnabled, let window, let host = window.rootViewController?.view else {
                if !isEnabled { uninstallGesture() }
                return
            }
            guard gestureHost !== host else { return }

            uninstallGesture()
            let panGesture = UIPanGestureRecognizer(
                target: self,
                action: #selector(handlePan(_:))
            )
            let gestureDelegate = GestureDelegate(owner: self)
            panGesture.delegate = gestureDelegate
            panGesture.cancelsTouchesInView = false
            panGesture.delaysTouchesBegan = false
            panGesture.maximumNumberOfTouches = 1
            host.addGestureRecognizer(panGesture)
            gestureHost = host
            self.panGesture = panGesture
            self.gestureDelegate = gestureDelegate
        }

        @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
            guard isEnabled,
                  gesture.state == .ended,
                  ThreadBackSwipeGesture.shouldNavigateBack(
                      with: gesture.translation(in: gesture.view)
                  ) else {
                return
            }
            onNavigateBack?()
        }

        private final class GestureDelegate: NSObject, UIGestureRecognizerDelegate {
            weak var owner: InstallerView?

            init(owner: InstallerView) {
                self.owner = owner
            }

            func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
                guard let owner,
                      owner.isEnabled,
                      let panGesture = gestureRecognizer as? UIPanGestureRecognizer else {
                    return false
                }
                return ThreadBackSwipeGesture.shouldBegin(
                    with: panGesture.velocity(in: panGesture.view),
                    translation: panGesture.translation(in: panGesture.view)
                )
            }

            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldReceive touch: UITouch
            ) -> Bool {
                guard let owner,
                      let gestureHost = owner.gestureHost,
                      ThreadBackSwipeGesture.shouldReceiveTouch(
                          touch,
                          surface: owner,
                          host: gestureHost
                      )
                else { return false }
                return true
            }

            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
            ) -> Bool {
                if otherGestureRecognizer is UIScreenEdgePanGestureRecognizer {
                    return true
                }
                guard let scrollView = otherGestureRecognizer.view as? UIScrollView else {
                    return false
                }
                return ThreadBackSwipeGesture.shouldAllowSimultaneousRecognition(
                    with: scrollView
                )
            }
        }
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
    var imageContext: MarkdownImageContext? = nil

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
                            isStreaming: message.state == .streaming,
                            imageContext: imageContext
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
                        isStreaming: message.state == .streaming,
                        imageContext: imageContext
                    )
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("message-\(message.id)")
        case .tool:
            FeatureWorkLogView(message: message, imageContext: imageContext)
                .id(message.id)
        case .system:
            systemMessage
                .accessibilityIdentifier("message-\(message.id)")
        }
    }

    @ViewBuilder
    private var systemMessage: some View {
        if message.toolName == "runtime.warning" {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(T3Colors.warning)
                VStack(alignment: .leading, spacing: 5) {
                    Text(message.text)
                        .foregroundStyle(T3Colors.textPrimary)
                        .textSelection(.enabled)
                    Text(message.createdAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
            .font(T3Typography.supporting)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        } else if message.toolName == "context-compaction" {
            Label(message.text, systemImage: "arrow.down.right.and.arrow.up.left")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 4)
        } else {
            Text(message.text)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .center)
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

private struct FeatureWorkLogView: View {
    let message: FeatureMessage
    let imageContext: MarkdownImageContext?
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            FeatureToolActivityIcon(presentation: message.toolPresentation, context: imageContext)
                            Text(message.toolName ?? "Tool output")
                            if let source = message.toolPresentation?.sourceName {
                                Text(source).lineLimit(1)
                            }
                        }
                        if let activeWorkLabel = message.activeWorkLabel {
                            Text(activeWorkLabel)
                                .lineLimit(1)
                                .foregroundStyle(T3Colors.statusRunning)
                        }
                    }
                    Spacer(minLength: 8)
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                }
                .font(T3Typography.tool.weight(.medium))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("work-log-toggle-\(message.id)")

            if isExpanded {
                Text(message.text)
                    .font(T3Typography.tool)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(.top, 8)
                    .transition(.identity)
                if FeatureWorkLogMedia.shouldRenderImages(
                    isExpanded: isExpanded,
                    paths: message.workLogImagePaths ?? []
                ) {
                    MarkdownMessageView(
                        FeatureWorkLogMedia.markdownSource(
                            for: message.workLogImagePaths ?? []
                        ),
                        imageContext: imageContext
                    )
                    .padding(.top, 8)
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityIdentifier("message-\(message.id)")
        .transaction { transaction in
            transaction.animation = nil
            transaction.disablesAnimations = true
        }
    }
}

enum FeatureWorkLogMedia {
    static func shouldRenderImages(isExpanded: Bool, paths: [String]) -> Bool {
        isExpanded && !paths.isEmpty
    }

    static func markdownSource(for paths: [String]) -> String {
        paths.prefix(8).compactMap { path in
            guard let escaped = path.addingPercentEncoding(
                withAllowedCharacters: .urlPathAllowed.subtracting(
                    CharacterSet(charactersIn: "()<>[]!\\\"' #%?\n\r")
                )
            ) else { return nil }
            return "![](\(escaped))"
        }.joined(separator: "\n\n")
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
                    .accessibilityAddTraits(canPreview(attachment) ? .isButton : [])
                    .accessibilityHint(
                        canPreview(attachment)
                            ? "Opens full-screen preview"
                            : ""
                    )
                    .accessibilityAction {
                        if canPreview(attachment) {
                            previewedAttachment = attachment
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if canPreview(attachment) {
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

    private func canPreview(_ attachment: FeatureMessageAttachment) -> Bool {
        (attachment.previewData != nil && attachment.mimeType.hasPrefix("image/"))
            || attachment.url != nil
    }
}

private struct FeatureAttachmentPreview: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let attachment: FeatureMessageAttachment

    var body: some View {
        NavigationStack {
            FeatureNativeMediaPreviewView(
                source: attachment.previewData.map(FeatureMediaPreviewSource.localImage)
                    ?? attachment.url.map(FeatureMediaPreviewSource.remote)
                    ?? .localImage(Data()),
                kind: FeatureLinkedMediaPreview.previewKind(
                    fileName: attachment.name,
                    mimeType: attachment.mimeType
                ),
                fileName: attachment.name
            )
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

private struct FeatureLinkedMediaPreview: Identifiable {
    let id = UUID()
    let source: FeatureMediaPreviewSource
    let kind: FeatureFilePreviewKind
    let fileName: String

    static func previewKind(for url: URL) -> FeatureFilePreviewKind? {
        let kind = FeatureFilePreviewKind.infer(path: url.path)
        return switch kind {
        case .image, .pdf, .video, .document: kind
        case .markdown, .source, .plainText: nil
        }
    }

    static func previewKind(fileName: String, mimeType: String) -> FeatureFilePreviewKind {
        if mimeType.hasPrefix("image/") { return .image }
        if mimeType.hasPrefix("video/") { return .video }
        if mimeType == "application/pdf" { return .pdf }
        let inferred = FeatureFilePreviewKind.infer(path: fileName)
        return inferred == .plainText ? .document : inferred
    }
}
