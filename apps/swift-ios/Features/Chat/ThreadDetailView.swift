import ImageIO
import SwiftUI
import UIKit

public struct ThreadDetailView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.t3CodeSizeSteps) private var codeSizeSteps
    @SwiftUI.Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @SwiftUI.Environment(\.openURL) private var parentOpenURL
    @SwiftUI.Environment(\.scenePhase) private var scenePhase

    @Bindable var model: FeatureRootModel
    let thread: FeatureThread
    let submitMessage: (FeatureMessageSubmission) async -> Bool
    let onNavigateBack: () -> Void
    let onOpenThread: (String) -> Void
    let onNewTaskFromThread: (FeatureThread) -> Void
    let initialDestination: FeatureThreadDestination?
    let initialDestinationID: UUID?
    let onToolDestinationChange: (FeatureThreadDestination?) -> Void
    let isPresentedThread: Bool
    let rootNavigationDismissalID: UUID?
    let onRootNavigationDismissed: (UUID) -> Void
    private let draftStore: FeatureComposerDraftStore

    @State private var draft = ""
    @State private var composerContext: OrchestrationMessageContext?
    @State private var selection: FeatureSelection?
    @State private var draftRuntimeMode: FeatureRuntimeMode?
    @State private var draftInteractionMode: FeatureInteractionMode?
    @State private var draftWorkspace: FeatureComposerWorkspaceDraft?
    @State private var isTransferringDraft = false
    @State private var queuedEdit: FeatureQueuedRunEdit?
    @State private var ordinaryDraftBeforeQueueEdit: FeatureComposerDraft?
    @State private var didRestoreQueuedEdit = false
    @State private var recoveryError: String?
    @State private var isUpdatingRecovery = false
    @State private var pendingDiscardRecoveryID: String?
    @State private var customSnooze: FeatureCustomSnoozeSelection?
    @State private var attachments: [FeatureDraftAttachment] = []
    @State private var isSending = false
    @State private var confirmsRestart = false
    @State private var isRestarting = false
    @State private var pendingRewindMessageID: String?
    @State private var isPreparingRewind = false
    @State private var isPreparingInput = false
    @State private var submittingCompaction = false
    @State private var isLoading = true
    @State private var sendFailed = false
    @State private var feedbackMessages: [FeatureMessage] = []
    @State private var feedbackRevision: UInt64 = 0
    @State private var timelineMessagesCache = FeatureTimelineMessagesCache()
    @State private var feedbackAlertMessage: String?
    @State private var feedbackIdentifier: String?
    @State private var didRestoreDraft = false
    @State private var draftRestoreBaseline: FeatureComposerDraft?
    @State private var missingFileRecoverySnapshot: FeatureComposerDraft?
    @State private var draftSaveTask: Task<Void, Never>?
    @State private var draftSaveError: String?
    @State private var toolSurface: FeatureThreadToolSurface?
    @State private var pendingWorkspaceAction: (@MainActor () -> Void)?
    @State private var rootNavigationDismissal = FeatureRootNavigationDismissal()
    @State private var branchPullRequest: FeaturePullRequest?
    @State private var showsLinkPullRequest = false
    @State private var pullRequestURL = ""
    @State private var pullRequestError: String?
    @State private var linkedMediaPreview: FeatureLinkedMediaPreview?
    @State private var linkedMediaPreviewError: String?
    @State private var scriptLaunchError: String?
    @State private var remoteDeviceCount = 0
    @State private var browserObserver: FeatureServerBrowserModel?
    @State private var showsThreadQueue = false
    @State private var isUpdatingQueue = false
    @State private var queueActionError: String?
    @State private var usageLimitsReport: FeatureEnvironmentUsageLimits?
    @State private var showsAgents = false
    @State private var isUpdatingWorkflow = false
    @State private var workflowError: String?
    @State private var workflowTask: Task<Void, Never>?
    @StateObject private var v2TimelineState = FeatureV2TimelineState()
    @State private var visitCoordinator = FeatureThreadVisitCoordinator()
    // Plain state, not `FocusState`: the composer's UIKit text view owns
    // focus and mirrors it through this binding, because SwiftUI drops
    // writes to a `FocusState` no `.focused()` view registers with.
    @State private var composerFocused = false

    public init(
        model: FeatureRootModel,
        thread: FeatureThread,
        submitMessage: @escaping (FeatureMessageSubmission) async -> Bool,
        onNavigateBack: @escaping () -> Void = {},
        onOpenThread: @escaping (String) -> Void = { _ in },
        onNewTaskFromThread: @escaping (FeatureThread) -> Void = { _ in },
        initialDestination: FeatureThreadDestination? = nil,
        initialDestinationID: UUID? = nil,
        onToolDestinationChange: @escaping (FeatureThreadDestination?) -> Void = { _ in },
        rootNavigationDismissalID: UUID? = nil,
        onRootNavigationDismissed: @escaping (UUID) -> Void = { _ in },
        draftStore: FeatureComposerDraftStore = .shared,
        isPresentedThread: Bool = true
    ) {
        self.isPresentedThread = isPresentedThread
        self.model = model
        self.thread = thread
        self.submitMessage = submitMessage
        self.onNavigateBack = onNavigateBack
        self.onOpenThread = onOpenThread
        self.onNewTaskFromThread = onNewTaskFromThread
        self.initialDestination = initialDestination
        self.initialDestinationID = initialDestinationID
        self.onToolDestinationChange = onToolDestinationChange
        self.rootNavigationDismissalID = rootNavigationDismissalID
        self.onRootNavigationDismissed = onRootNavigationDismissed
        self.draftStore = draftStore
    }

    // Bound the size of each modifier group. Keeping the whole screen inline
    // exhausts the device main-thread stack while constructing its toolbar.
    // These stable boundaries leave transcript row identity and diffing intact.
    private var threadContent: AnyView {
        let content = observedThreadContent
        .featureKeyboardScope(
            id: "thread:\(thread.id)",
            isActive: scenePhase == .active && toolSurface == nil && !showsAgents
                && !showsThreadQueue && customSnooze == nil && linkedMediaPreview == nil,
            enabledCommands: [.files, .terminal, .review, .copyThreadReference],
            onCommand: performThreadKeyboardCommand
        )
        .sheet(item: sheetToolSurface, onDismiss: toolDidDismiss) { surface in
            toolView(surface)
                .onAppear { rootNavigationDismissal.presentationDidAppear() }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .fullScreenCover(isPresented: deviceToolPresented, onDismiss: toolDidDismiss) {
            toolView(.devices)
                .onAppear { rootNavigationDismissal.presentationDidAppear() }
        }
        return AnyView(content)
    }

    private var sheetToolSurface: Binding<FeatureThreadToolSurface?> {
        Binding(
            get: { toolSurface == .devices ? nil : toolSurface },
            set: { if toolSurface != .devices { toolSurface = $0 } }
        )
    }

    private var deviceToolPresented: Binding<Bool> {
        Binding(
            get: { toolSurface == .devices },
            set: { if !$0, toolSurface == .devices { toolSurface = nil } }
        )
    }

    private func toolDidDismiss() {
        // Replacing a sheet item can dismiss the previous tool while the next
        // one is opening. Restore composer focus only after the final tool closes.
        guard toolSurface == nil else { return }
        let action = pendingWorkspaceAction
        pendingWorkspaceAction = nil
        if rootNavigationDismissal.requestID == nil { action?() }
        threadPresentationDidDismiss()
    }

    private var transcriptPresentationDismissal: FeatureThreadPresentationDismissal {
        FeatureThreadPresentationDismissal(requestID: rootNavigationDismissalID) { id, presented in
            rootNavigationDismissal.childPresentationChanged(id, isPresented: presented)
            finishRootNavigationDismissalIfReady()
        }
    }

    private func dismissPresentationsForRootNavigation() {
        guard let id = rootNavigationDismissalID else { return }
        rootNavigationDismissal.request(id, hasPresentation:
            toolSurface != nil || customSnooze != nil || showsAgents || showsThreadQueue
                || linkedMediaPreview != nil)
        pendingWorkspaceAction = nil
        toolSurface = nil
        customSnooze = nil
        showsAgents = false
        showsThreadQueue = false
        linkedMediaPreview = nil
        confirmsRestart = false
        pendingRewindMessageID = nil
        pendingDiscardRecoveryID = nil
        showsLinkPullRequest = false
        pullRequestError = nil
        workflowError = nil
        scriptLaunchError = nil
        linkedMediaPreviewError = nil
        feedbackAlertMessage = nil
        sendFailed = false
        finishRootNavigationDismissalIfReady()
    }

    private func threadPresentationDidDismiss() {
        rootNavigationDismissal.presentationDidDismiss()
        finishRootNavigationDismissalIfReady()
    }

    private func finishRootNavigationDismissalIfReady() {
        guard let id = rootNavigationDismissal.takeReadyRequest() else { return }
        onRootNavigationDismissed(id)
    }

    private func presentTool(_ surface: FeatureThreadToolSurface) {
        if let active = toolSurface, (active == .devices) != (surface == .devices) {
            pendingWorkspaceAction = { toolSurface = surface }
            toolSurface = nil
        } else {
            toolSurface = surface
        }
    }

    private func toolView(_ surface: FeatureThreadToolSurface) -> some View {
            NavigationStack {
                Group {
                    switch surface {
                    case .files:
                        FeatureFilesView(
                            client: model.client,
                            threadID: thread.id,
                            workspaceRoot: markdownImageContext?.workspaceRoot
                        )
                    case let .file(path, line):
                        FeatureFilesView(
                            client: model.client,
                            threadID: thread.id,
                            initialPath: path,
                            initialLine: line,
                            workspaceRoot: markdownImageContext?.workspaceRoot
                        )
                    case .review:
                        FeatureReviewView(
                            client: model.client,
                            threadID: thread.id,
                            onAppendComment: { record in
                                guard canTransferDraft, didRestoreQueuedEdit, queuedEdit == nil else {
                                    throw FeatureThreadRecoveryError("Finish the current composer action before adding a review comment.")
                                }
                                let context = try FeatureComposerContext.merge(
                                    ComposerContextReferences.referenced(composerContext, text: draft), .init(records: [record])
                                )
                                let text = ComposerContextReferences.ensureReferences(draft, records: [record])
                                let pendingSave = draftSaveTask
                                pendingSave?.cancel()
                                draftSaveTask = nil
                                isTransferringDraft = true
                                defer { isTransferringDraft = false }
                                await pendingSave?.value
                                var updated = composerDraft
                                updated.text = text
                                updated.context = context
                                try await draftStore.setDraft(updated, for: draftKey)
                                applyComposerDraft(updated)
                                pendingWorkspaceAction = { composerFocused = true }
                            }
                        )
                    case let .sourceControl(destination):
                        FeatureSourceControlView(client: model.client, threadID: thread.id, initialDestination: destination)
                    case let .browser(tabID):
                        FeatureServerBrowserView(threadID: thread.id, client: model.client, initialTabID: tabID)
                    case .devices:
                        if let client = model.client as? any FeatureRemoteDeviceManaging {
                            FeatureRemoteDevicesView(threadID: thread.id, client: client)
                        } else {
                            ContentUnavailableView("Devices unavailable", systemImage: "iphone")
                        }
                    case let .terminal(sessionID):
                        FeatureTerminalView(client: model.client, threadID: thread.id, initialTerminalID: sessionID) { record in
                            guard didRestoreDraft, !isTransferringDraft, !isRewinding, !isUpdatingQueue else {
                                throw FeatureThreadRecoveryError("Wait for the composer to finish restoring your message.")
                            }
                            composerContext = try FeatureComposerContext.merge(
                                ComposerContextReferences.referenced(composerContext, text: draft), .init(records: [record])
                            )
                            draft = ComposerContextReferences.ensureReferences(draft, records: [record])
                            persistDraftImmediately()
                            composerFocused = true
                        }
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
            .t3CodeSizing(steps: codeSizeSteps)
            .featureKeyboardScope(
                id: "thread-tool:\(thread.id)",
                isActive: scenePhase == .active,
                enabledCommands: [.files, .terminal, .review, .copyThreadReference, .back],
                isTerminalActive: surface.isTerminal,
                beforeRootAction: { action in
                    pendingWorkspaceAction = action
                    toolSurface = nil
                },
                onCommand: performThreadKeyboardCommand
            )
    }

    private var observedThreadContent: AnyView {
        let content = loadedThreadContent
        .onChange(of: thread.id) { v2TimelineState.reset() }
        // A child observes the text so keystrokes do not re-run this body.
        .background(FeatureDraftTextObserver(text: $draft, onChange: scheduleDraftSave))
        .onChange(of: selection) { scheduleDraftSave() }
        .onChange(of: draftRuntimeMode) { scheduleDraftSave() }
        .onChange(of: draftInteractionMode) { scheduleDraftSave() }
        .onChange(of: selection) { usageLimitsReport = nil }
        .onChange(of: currentThread.modelID) { usageLimitsReport = nil }
        .onChange(of: currentThread.inboxFacts?.latestRunID) { usageLimitsReport = nil }
        .onChange(of: model.recoveredRewindDrafts[thread.id]) { _, recovered in
            if recovered != nil { restoreRewindDraft() }
        }
        .onChange(of: threadConnectionState) { _, state in
            if state == .connected,
               case .failed = model.detailLoadStates[thread.id],
               !isLoading {
                reloadThread()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            updateVisibleThread()
            if phase != .active {
                persistDraftBeforeLeaving()
            }
        }
        .onDisappear {
            workflowTask?.cancel()
            clearVisibleThread()
            onToolDestinationChange(nil)
            model.releaseThread(thread.id)
            persistDraftBeforeLeaving()
        }
        return AnyView(content)
    }

    private var loadedThreadContent: AnyView {
        let content = baseThreadContent
        .task(id: thread.id) {
            isLoading = true
            _ = await model.detail(for: thread.id, force: true)
            isLoading = false
        }
        .task(id: thread.id) {
            // A cached thread can already show its composer while the server
            // is catching up. Local drafts must not wait for that request.
            await model.checkRewindRecovery(for: currentThread)
            guard !didRestoreDraft else { return }
            await restoreDraft(from: composerDraft, key: draftKey)
        }
        .task(id: FeatureThreadToolRequest(destination: initialDestination, requestID: initialDestinationID)) {
            if let initialDestination { presentTool(FeatureThreadToolSurface(initialDestination)) }
        }
        .task(id: didRestoreDraft) {
            await restoreQueuedEditIfNeeded()
        }
        .onChange(of: detail?.execution) { _, execution in
            guard let edit = currentQueuedEdit, let execution,
                  !edit.isStillQueued(in: execution), !isUpdatingQueue, !isTransferringDraft,
                  refreshPresentation == nil else { return }
            recoverStartedQueueEdit()
        }
        .onChange(of: refreshPresentation) { _, presentation in
            if presentation == nil { recoverStartedQueueEdit() }
        }
        .onChange(of: isPreparingInput) { _, preparing in
            if !preparing {
                Task { await restoreQueuedEditIfNeeded() }
                recoverStartedQueueEdit()
            }
        }
        .onChange(of: isTransferringDraft) { _, transferring in
            if !transferring, !didRestoreQueuedEdit, queueActionError == nil {
                Task { await restoreQueuedEditIfNeeded() }
            }
        }
        .onChange(of: isRewinding) { _, rewinding in
            if !rewinding { Task { await restoreQueuedEditIfNeeded() } }
        }
        .onChange(of: isUpdatingQueue) { _, updating in
            if !updating { Task { await restoreQueuedEditIfNeeded() } }
        }
        .onChange(of: toolSurface) { _, surface in
            onToolDestinationChange(surface?.destination)
        }
        .onAppear { updateVisibleThread() }
        .task(id: pullRequestObservationID) {
            await observeThreadPullRequest()
        }
        .task(id: scenePhase == .active ? FeatureThreadVisitRequest(
            observation: FeatureThreadVisitObservation(thread: currentThread), connection: threadConnectionState
        ) : nil) {
            guard scenePhase == .active, threadConnectionState == .connected,
                  let visitor = model.client as? any FeatureThreadVisiting else { return }
            await visitCoordinator.visit(FeatureThreadVisitObservation(thread: currentThread), using: visitor)
        }
        .task(id: workspaceCatalogID) {
            if let environmentID = currentThread.environmentID, let cwd = workspaceCatalogPath,
               let instanceID = selection?.providerID ?? currentSelection?.providerID {
                await model.refreshWorkspaceProviders(environmentID: environmentID, cwd: cwd, instanceID: instanceID)
            }
        }
        .task(id: FeatureThreadDeviceObservation(
            threadID: currentThread.id, connection: threadConnectionState,
            foreground: scenePhase != .background
        )) {
            remoteDeviceCount = 0
            guard scenePhase != .background, threadConnectionState == .connected,
                  let devices = model.client as? any FeatureRemoteDeviceManaging else { return }
            do {
                let states = try await devices.remoteDeviceStates(threadID: currentThread.id)
                for try await state in states {
                    guard !Task.isCancelled else { return }
                    remoteDeviceCount = state.previews.count
                }
            } catch {
                guard !Task.isCancelled else { return }
                remoteDeviceCount = 0
            }
        }
        .task(id: FeatureThreadDeviceObservation(
            threadID: currentThread.id, connection: threadConnectionState,
            foreground: scenePhase == .active && isPresentedThread && supportsServerBrowser
        )) {
            browserObserver?.suspend()
            guard scenePhase == .active, isPresentedThread, supportsServerBrowser,
                  threadConnectionState == .connected,
                  let browser = model.client as? any FeatureServerBrowserManaging else { return }
            let observer = FeatureServerBrowserModel(threadID: currentThread.id, client: browser)
            browserObserver = observer
            defer { observer.suspend() }
            await observer.watch()
        }
        .onChange(of: browserObserver?.revealRequest) { _, request in
            guard let request, isPresentedThread, scenePhase == .active else { return }
            if toolSurface == nil || request.force { presentTool(.browser(request.tabID)) }
            browserObserver?.consumeReveal()
        }
        .environment(\.providerSetupContext, currentThread.environmentID.map {
            ProviderSetupContext(model: model, environmentID: $0)
        })
        return AnyView(content)
    }

    private var supportsServerBrowser: Bool {
        model.snapshot.environments.first { $0.id == currentThread.environmentID }?.supportsServerBrowser == true
    }

    private var baseThreadContent: AnyView {
        let content = Group {
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
        .alert("Link pull request", isPresented: $showsLinkPullRequest) {
            TextField("Pull request URL", text: $pullRequestURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Link") { changePullRequest(url: pullRequestURL, linked: true) }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Could not update pull request", isPresented: Binding(
            get: { pullRequestError != nil }, set: { if !$0 { pullRequestError = nil } }
        )) {
            Button("OK") { pullRequestError = nil }
        } message: { Text(pullRequestError ?? "") }
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
        return AnyView(content)
    }

    public var body: some View {
        threadContent
        .confirmationDialog("Delete unsent message?", isPresented: Binding(
            get: { pendingDiscardRecoveryID != nil },
            set: { if !$0 { pendingDiscardRecoveryID = nil } }
        ), titleVisibility: .visible, presenting: model.submissionRecoveryDrafts.first {
            $0.id == pendingDiscardRecoveryID
        }) { recovery in
            Button("Delete", role: .destructive) {
                pendingDiscardRecoveryID = nil
                Task { await model.discardSubmissionRecovery(id: recovery.id) }
            }
            Button("Cancel", role: .cancel) { pendingDiscardRecoveryID = nil }
        } message: { _ in
            Text("This message has not been sent. Its saved text and files will be removed.")
        }
        .sheet(item: $customSnooze, onDismiss: threadPresentationDidDismiss) { selection in
            FeatureCustomSnoozeSheet(selection: selection) { id, until in
                Task { await model.setSnoozed(id, until: until) }
            }
            .onAppear { rootNavigationDismissal.presentationDidAppear() }
        }
        .sheet(isPresented: $showsAgents, onDismiss: threadPresentationDidDismiss) {
            NavigationStack {
                FeatureThreadAgentsView(roster: detail?.workflows?.agentRoster, onOpenThread: openRelatedThread)
                    .onAppear { rootNavigationDismissal.presentationDidAppear() }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showsAgents = false }
                        }
                    }
            }
            .preferredColorScheme(.dark)
        }
        .alert("Could not open thread", isPresented: Binding(
            get: { workflowError != nil }, set: { if !$0 { workflowError = nil } }
        )) { Button("OK") { workflowError = nil } }
        message: { Text(workflowError ?? "") }
        .alert("Script could not start", isPresented: Binding(
            get: { scriptLaunchError != nil }, set: { if !$0 { scriptLaunchError = nil } }
        )) { Button("OK") { scriptLaunchError = nil } }
        message: { Text(scriptLaunchError ?? "") }
        .sheet(isPresented: $showsThreadQueue, onDismiss: threadPresentationDidDismiss) {
            NavigationStack {
                if let execution = detail?.execution {
                    FeatureThreadQueueView(
                        execution: execution,
                        controlsAvailable: queueControlsAvailable && execution.canManageQueue,
                        isUpdating: isUpdatingQueue,
                        error: queueActionError,
                        performAction: updateThreadQueue,
                        onEdit: beginQueuedEdit
                    )
                    .onAppear { rootNavigationDismissal.presentationDidAppear() }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showsThreadQueue = false }
                        }
                    }
                }
            }
            .preferredColorScheme(.dark)
            .presentationDetents([.large])
        }
        .confirmationDialog("Restart agent session?", isPresented: $confirmsRestart, titleVisibility: .visible) {
            Button("Restart") {
                Task {
                    isRestarting = true
                    defer { isRestarting = false }
                    await model.restartAgentSession(thread.id)
                }
            }
        } message: {
            Text("This stops the current turn and keeps the conversation. Your next message reloads skills, plugins, and tool permissions.")
        }
        .alert("Message not sent", isPresented: $sendFailed) {
            // Refocusing happens here rather than when the send fails: the
            // alert takes first responder from the composer, so a refocus
            // issued before it presents is lost by the time it dismisses.
            Button("OK") { composerFocused = true }
        } message: {
            Text("Your draft is still here. Try again when this conversation is ready.")
        }
        .confirmationDialog("Edit from here?", isPresented: Binding(
            get: { pendingRewindMessageID != nil },
            set: { if !$0 { pendingRewindMessageID = nil } }
        ), titleVisibility: .visible) {
            Button("Revert and keep changes") {
                guard let messageID = pendingRewindMessageID else { return }
                pendingRewindMessageID = nil
                rewindConversation(before: messageID)
            }
            Button("Cancel", role: .cancel) { pendingRewindMessageID = nil }
        } message: {
            Text("Rewind chat to before this message. Your prompt and attachments return to the composer. File changes stay as they are.")
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
            // iOS 26 owns the interactive content back-swipe. A second pan
            // recognizer can block it or clear the selection during a pop.
            if #unavailable(iOS 26.0) {
                ThreadBackSwipeGestureView(
                    isEnabled: horizontalSizeClass == .compact,
                    onNavigateBack: onNavigateBack
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .environment(\.openURL, transcriptOpenURL)
        .environment(\.featureThreadPresentationDismissal, transcriptPresentationDismissal)
        .onChange(of: rootNavigationDismissalID, initial: true) { _, _ in
            dismissPresentationsForRootNavigation()
        }
        .fullScreenCover(item: $linkedMediaPreview, onDismiss: threadPresentationDidDismiss) { preview in
            NavigationStack {
                FeatureNativeMediaPreviewView(
                    source: preview.source,
                    kind: preview.kind,
                    fileName: preview.fileName
                )
                .onAppear { rootNavigationDismissal.presentationDidAppear() }
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

    private var isRewinding: Bool {
        isPreparingRewind || model.rewindingThreadIDs.contains(thread.id)
    }

    private func canRewind(_ messageID: String) -> Bool {
        !isSending && !isRewinding && !isPreparingInput && !isTransferringDraft
            && queuedEdit == nil && didRestoreDraft && didRestoreQueuedEdit
            && model.canRewindConversation(threadID: thread.id, messageID: messageID)
    }

    private func rewindConversation(before messageID: String) {
        guard canRewind(messageID) else { return }
        isPreparingRewind = true
        dismissKeyboard()
        let pendingSave = draftSaveTask
        pendingSave?.cancel()
        draftSaveTask = nil
        let saved = composerDraft
        Task {
            await pendingSave?.value
            await model.rewindConversation(threadID: thread.id, messageID: messageID, draft: saved)
            isPreparingRewind = false
        }
    }

    private func restoreRewindDraft() {
        guard let recovered = model.consumeRewindDraft(threadID: thread.id) else { return }
        applyComposerDraft(recovered)
    }

    private func recoverSavedRewind() {
        guard canTransferDraft else { return }
        isPreparingRewind = true
        let pendingSave = draftSaveTask
        pendingSave?.cancel()
        draftSaveTask = nil
        let saved = composerDraft
        Task {
            await pendingSave?.value
            await model.recoverSavedRewind(threadID: thread.id, draft: saved)
            isPreparingRewind = false
        }
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
                if detail?.workflows?.agentRoster != nil {
                    Button("Agents", systemImage: "person.2") { showsAgents = true }
                }
                if let workflows = detail?.workflows {
                    FeatureThreadMergeBackButton(workflows: workflows, isBusy: isUpdatingWorkflow) {
                        performWorkflow { client in try await client.mergeBackThread(threadID: thread.id) }
                    }
                }
                if let pullRequest = currentPullRequest {
                    Button {
                        parentOpenURL(pullRequest.url)
                    } label: {
                        Label("Open pull request #\(pullRequest.number)", systemImage: "arrow.triangle.pull")
                    }
                }
                let links = ThreadPullRequests.visible(currentThread.pullRequests ?? [])
                if links.count > 1 {
                    Menu("Linked pull requests") {
                        ForEach(links) { link in
                            if let url = URL(string: link.url) {
                                Button("\(link.repository)#\(link.number)") { parentOpenURL(url) }
                            }
                        }
                    }
                }
                if currentThread.supportsMultiplePullRequests == true || currentThread.supportsPullRequestLinking == true {
                    Button("Link pull request…") { showsLinkPullRequest = true }
                    if !links.isEmpty {
                        Menu("Unlink pull request") {
                            ForEach(links) { link in
                                Button("\(link.repository)#\(link.number)") { changePullRequest(url: link.url, linked: false) }
                            }
                        }
                    } else if let linked = currentThread.linkedPullRequest {
                        Button("Unlink pull request #\(linked.number)") { changePullRequest(url: linked.url, linked: false) }
                    }
                }
                if currentThread.supportsTitleRegeneration == true {
                    Button {
                        Task { await model.regenerateThreadTitle(thread.id) }
                    } label: {
                        Label(
                            currentThread.isRegeneratingTitle ? "Regenerating title…" : "Regenerate title",
                            systemImage: "sparkles"
                        )
                    }
                    .disabled(currentThread.isRegeneratingTitle)
                }
                Menu {
                    if !runtimeModeChoices.contains(effectiveRuntimeMode) {
                        Section("Current") {
                            Button {} label: {
                                Label(
                                    runtimeModeLabel(effectiveRuntimeMode),
                                    systemImage: "checkmark"
                                )
                            }
                            .disabled(true)
                        }
                    }
                    ForEach(runtimeModeChoices, id: \.self) { mode in
                        Button {
                            draftRuntimeMode = mode
                        } label: {
                            if effectiveRuntimeMode == mode {
                                Label(runtimeModeLabel(mode), systemImage: "checkmark")
                            } else {
                                Text(runtimeModeLabel(mode))
                            }
                        }
                    }
                } label: {
                    Label("Permissions", systemImage: "checkmark.shield")
                }
                .disabled(isSending || isTransferringDraft || queuedEdit != nil)
                if currentThread.canToggleSnooze, !currentThread.isArchived {
                    if currentThread.isEffectivelySnoozed(at: .now) {
                        Button("Wake", systemImage: "sun.max") {
                            Task { await model.setSnoozed(thread.id, until: nil) }
                        }
                    } else {
                        Menu("Snooze", systemImage: "clock") {
                            ForEach(DailyUXSnoozePresets.resolve(now: .now)) { preset in
                                Button(preset.label) {
                                    Task { await model.setSnoozed(thread.id, until: preset.until) }
                                }
                            }
                            Button("Custom…") { customSnooze = FeatureCustomSnoozeSelection(thread: currentThread) }
                        }
                        .disabled(!currentThread.canSnoozeNow(at: .now))
                    }
                }
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
                if currentThread.supportsAutoSettleOptOut == true {
                    Toggle("Auto-settle", isOn: Binding(
                        get: { currentThread.autoSettleDisabledAt == nil },
                        set: { enabled in Task { await model.setAutoSettle(thread.id, enabled: enabled) } }
                    ))
                }
                let isSettled = currentThread.isEffectivelySettled()
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
                Button {
                    confirmsRestart = true
                } label: {
                    Label("Restart agent session", systemImage: "arrow.clockwise")
                }
                .disabled(isSending || isRestarting)
                if let execution = detail?.execution {
                    if !execution.queuedEntries.isEmpty || execution.isQueueHeld {
                        Button { showsThreadQueue = true } label: {
                            Label("Queued messages", systemImage: "text.line.first.and.arrowtriangle.forward")
                        }
                    }
                    if execution.canStopThread {
                        Button("Stop", systemImage: "stop.fill", action: stopThreadWork)
                            .disabled(!queueControlsAvailable || isUpdatingQueue)
                    }
                }
                Button(action: reloadThread) {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
                if let message = detail?.messages.last(where: { $0.role == .user }),
                   canRewind(message.id) {
                    Button { pendingRewindMessageID = message.id } label: {
                        Label("Edit last prompt", systemImage: "arrow.uturn.backward")
                    }
                }
            }
            Section("Workspace") {
                if let branch = currentThread.branch, !branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button(currentThread.worktreePath == nil ? "New task on this branch" : "New task in this worktree",
                           systemImage: "plus") {
                        onNewTaskFromThread(currentThread)
                    }
                }
                Button { toolSurface = .files } label: {
                    Label("Files", systemImage: "folder")
                }
                Button { toolSurface = .review } label: {
                    Label("Review changes", systemImage: "doc.text.magnifyingglass")
                }
                Button { toolSurface = .sourceControl(.git) } label: {
                    Label("Source control", systemImage: "arrow.triangle.branch")
                }
                Button { toolSurface = .terminal(nil) } label: {
                    Label("Terminal", systemImage: "terminal")
                }
                FeatureProjectScriptsMenu(client: model.client, threadID: thread.id,
                    onError: { scriptLaunchError = $0 }) {
                    toolSurface = .terminal($0)
                }
                if supportsServerBrowser {
                    Button("Browser (\(browserObserver?.count ?? 0))", systemImage: "globe") {
                        presentTool(.browser(nil))
                    }
                }
                if remoteDeviceCount > 0 {
                    Button("Devices (\(remoteDeviceCount))", systemImage: "iphone") { toolSurface = .devices }
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

    private func changePullRequest(url: String, linked: Bool) {
        Task {
            do { try await model.client.setThreadPullRequest(id: thread.id, url: url.trimmingCharacters(in: .whitespacesAndNewlines), linked: linked) }
            catch { pullRequestError = error.localizedDescription }
        }
    }

    private var pullRequestObservationID: String? {
        currentThread.pullRequestObservationIdentity
    }

    /// Follows the branch pull request for a thread with no linked one.
    /// Linked pull requests resolve from the thread itself.
    @MainActor
    private func observeThreadPullRequest() async {
        branchPullRequest = nil
        guard pullRequestObservationID != nil,
              currentThread.pullRequests?.isEmpty ?? true else {
            return
        }
        if currentThread.effectivePullRequest != nil, currentThread.environmentID != nil {
            return
        }

        for await status in model.client.sourceControlStatusEvents(threadID: thread.id) {
            guard !Task.isCancelled else { return }
            let next = status.branch == currentThread.branch ? status.pullRequest : nil
            if next != branchPullRequest {
                branchPullRequest = next
            }
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

    private var queueControlsAvailable: Bool {
        model.client is any FeatureThreadQueueManaging
            && threadConnectionState == .connected && refreshPresentation == nil
            && model.client.permissions(forThreadID: thread.id)?.grants("orchestration:operate") == true
            && !isSending && !isRewinding && !isRestarting && !isTransferringDraft && !isUpdatingRecovery
    }

    private var messageDeliveries: [FeatureMessageDelivery] {
        guard model.client is any FeatureMessageDeliveryManaging,
              let execution = detail?.execution,
              execution.canManageQueue, execution.activeRun != nil else { return [] }
        var deliveries: [FeatureMessageDelivery] = [.queue]
        if execution.canSteer { deliveries.append(.steer) }
        if execution.canRestart { deliveries.append(.restart) }
        return deliveries
    }

    @MainActor
    private func updateThreadQueue(_ action: FeatureThreadQueueAction) async -> Bool {
        guard !isUpdatingQueue, queueControlsAvailable,
              let client = model.client as? any FeatureThreadQueueManaging,
              let execution = detail?.execution else { return false }
        guard execution.allows(action) else {
            queueActionError = "The queue changed. Check the current messages and try again."
            return false
        }
        isUpdatingQueue = true
        queueActionError = nil
        defer { isUpdatingQueue = false }
        do {
            try await client.updateThreadQueue(threadID: thread.id, action: action)
            // The existing live detail subscription supplies the new state.
            return true
        } catch {
            queueActionError = error.localizedDescription
            return false
        }
    }

    private func stopThreadWork() {
        if let execution = detail?.execution {
            guard execution.canStopThread else { return }
            if let run = execution.interruptibleRun, execution.canInterrupt {
                Task { _ = await updateThreadQueue(.interrupt(runID: run.id, holdQueue: true)) }
            } else {
                Task { await model.cancelTurn(threadID: thread.id) }
            }
        } else {
            Task { await model.cancelTurn(threadID: thread.id) }
        }
    }

    @ViewBuilder
    private var providerGoalStatus: some View {
        if let goal = currentThread.goal {
            let presentation = OrchestrationV2Presentation.providerGoal(goal, working: currentThread.state == .working)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "target")
                VStack(alignment: .leading, spacing: 3) {
                    Text(presentation.title).font(T3Typography.supporting)
                    Text(presentation.objective).font(.caption).lineLimit(2)
                    if let usage = presentation.usage { Text(usage).font(.caption).foregroundStyle(T3Colors.textSecondary) }
                }
                Spacer(minLength: 4)
                Menu {
                    if threadProviders.first(where: { $0.id == (currentThread.sessionProviderID ?? currentThread.providerID) })?.driver == "codex" {
                        if presentation.canResume { Button("Resume goal") { sendGoalCommand("/goal resume") } }

                    }
                    Button("Clear goal") { sendGoalCommand("/goal clear") }
                } label: { Image(systemName: "ellipsis") }
                .disabled(currentThread.state == .working || isSending || model.client.permissions(forThreadID: thread.id)?.grants("orchestration:operate") != true)
            }
            .padding(.horizontal, 18).padding(.vertical, 8)
        }
    }

    private func sendGoalCommand(_ command: String) {
        Task {
            _ = await submitMessage(FeatureMessageSubmission(threadID: thread.id, text: command,
                selection: currentSelection, runtimeMode: currentThread.runtimeMode,
                interactionMode: currentThread.interactionMode))
        }
    }

    @ViewBuilder
    private var threadQueueControls: some View {
        if let execution = detail?.execution {
            if !execution.queuedEntries.isEmpty || execution.isQueueHeld {
                Button { showsThreadQueue = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "text.line.first.and.arrowtriangle.forward")
                        Text("\(execution.queuedEntries.count) queued")
                        if execution.isQueueHeld { Text("Paused") }
                        Spacer()
                        Image(systemName: "chevron.up")
                    }
                    .font(T3Typography.control)
                    .foregroundStyle(Color.white)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .padding(.horizontal, 18)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(Color.black)
                .accessibilityIdentifier("thread-queue-open")
            }
        }
        if let queueActionError {
            HStack {
                Text(queueActionError)
                    .foregroundStyle(T3Colors.danger)
                Spacer(minLength: 4)
                if !didRestoreQueuedEdit {
                    Button("Retry") { Task { await restoreQueuedEditIfNeeded() } }
                        .disabled(!canTransferDraft)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                } else {
                    Button("Dismiss") { self.queueActionError = nil }
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                }
            }
            .font(T3Typography.supporting)
            .padding(.horizontal, 18)
        }
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
                    environmentID: currentThread.environmentID,
                    messages: timelineMessages(detail.messages),
                    openURL: transcriptOpenURL,
                    imageContext: markdownImageContext,
                    attachmentContext: (model.client as? any FeatureAttachmentAssetResolving).map {
                        FeatureAttachmentContext(
                            threadID: thread.id, resolver: $0,
                            environmentID: currentThread.environmentID,
                            wireThreadID: currentThread.wireID ?? currentThread.id
                        )
                    },
                    skills: threadProviderSkills,
                    v2Inspection: v2InspectionContext,
                    secretContext: secretRequestContext,
                    embeddedContext: embeddedContentContext,
                    workflows: detail.workflows ?? .unavailable,
                    isWorkflowBusy: isUpdatingWorkflow,
                    onFork: { source in
                        performWorkflow { client in try await client.forkThread(threadID: thread.id, source: source) }
                    },
                    onOpenThread: openRelatedThread,
                    presentationDismissal: transcriptPresentationDismissal,
                    renderUpdate: timelineRenderUpdate,
                    expandedTurnFoldIDs: expandedTurnFoldIDs,
                    dynamicTypeSize: dynamicTypeSize,
                    codeSizeSteps: codeSizeSteps,
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
                    onDismissKeyboard: dismissKeyboard,
                    canEditMessage: canRewind,
                    onEditMessage: { pendingRewindMessageID = $0 },
                    canEditPendingMessage: canEditPendingMessage,
                    onEditPendingMessage: editPendingMessage
                )
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                refreshStatus
                providerGoalStatus
                threadQueueControls
                submissionRecoveryControls
                if let recovery = detail.recovery?.usageLimit {
                    FeatureUsageLimitRecoveryView(recovery: recovery,
                        controlsAvailable: recoveryControlsAvailable,
                        performAction: updateThreadRecovery)
                        .padding(.horizontal, 18)
                }
                if let recoveryError {
                    Text(recoveryError).font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger).padding(.horizontal, 18)
                }
                if let edit = currentQueuedEdit {
                    FeatureQueuedRunEditBanner(edit: Binding(
                        get: { currentQueuedEdit ?? edit },
                        set: { updated in
                            queuedEdit = updated
                            applyComposerDraft(updated.draft)
                            scheduleDraftSave()
                        }), isSaving: isUpdatingQueue || isTransferringDraft,
                        cancel: cancelQueuedEdit)
                        .padding(.horizontal, 18)
                    if let execution = detail.execution, !edit.isStillQueued(in: execution) {
                        Button("Recover queued edit", action: recoverStartedQueueEdit)
                            .disabled(isTransferringDraft || isUpdatingQueue)
                            .frame(minHeight: T3Metrics.minimumTapTarget)
                    }
                }
                if let report = usageLimitsReport {
                    FeatureThreadUsageLimitsView(client: model.client, report: report) {
                        usageLimitsReport = nil
                    }
                }
                if isRewinding {
                    Text("Rewinding conversation")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textPrimary)
                        .padding(.vertical, 8)
                        .accessibilityIdentifier("conversation-rewind-status")
                }
                if let error = model.rewindErrors[thread.id] {
                    Text(error)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 8)
                }
                if model.pendingRewindRecoveryIDs.contains(thread.id), !isRewinding {
                    VStack(spacing: 4) {
                        Text("A prompt is saved from an unconfirmed rewind. Reload the thread to check its history.")
                            .font(T3Typography.supporting)
                        Button("Recover saved prompt", action: recoverSavedRewind)
                            .disabled(!canTransferDraft)
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 8)
                }
                if detail.execution?.isReadOnly == true {
                    FeatureThreadOpenParentButton(workflows: detail.workflows ?? .unavailable,
                        onOpenThread: openRelatedThread)
                    Text("Read-only conversation")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 18)
                } else {
                    FeatureComposerView(
                        text: $draft,
                        selection: $selection,
                        attachments: attachmentBinding,
                        draftOwnerID: queuedEdit.map { "queue:\($0.runID)" } ?? "thread:\(currentThread.id)",
                        environmentID: currentThread.environmentID,
                        draftStorageKey: activeDraftKey,
                        environmentIsConnected: threadConnectionState == .connected,
                        attachmentUploads: model.attachmentUploads,
                        attachmentPreferences: currentThread.environmentID.flatMap {
                            model.snapshot.preferencesByEnvironment?[$0]
                        } ?? FeatureEnvironmentPreferences(),
                        providers: threadProviders,
                        threadSelection: currentSelection,
                        materializesDefaultSelection: false,
                        isSending: isSending || isRewinding || !didRestoreDraft || isUpdatingQueue || isTransferringDraft,
                        isWorking: queuedEdit == nil && (detail.execution.map { $0.canStopThread && queueControlsAvailable }
                            ?? (detail.thread.state == .working || detail.thread.state == .queued || isCompacting)),
                        focused: $composerFocused,
                        onSend: { send() },
                        onStop: stopThreadWork,
                        pendingApprovals: detail.approvals,
                        pendingUserInputs: detail.userInputs,
                        resolvingRequestIDs: model.resolvingRequestIDs,
                        powerFeatures: composerPowerFeatures,
                        showsKeyboardDismissControl: true,
                        onDismissKeyboard: dismissKeyboard,
                        onApprovalDecision: { id, decision in
                            Task { await model.resolveApproval(id, decision: decision) }
                        },
                        onUserInputSubmit: { id, answers, attachments in
                            await model.resolveUserInput(id, answers: answers, attachmentsByQuestionID: attachments)
                        },
                        onUserInputDismiss: { id in
                            await model.dismissUserInput(id)
                        },
                        onRefreshModels: refreshThreadEnvironmentModels,
                        draftSaveError: draftSaveError,
                        onRetryDraftSave: missingFileRecoverySnapshot == nil ? {
                            if didRestoreDraft {
                                persistDraftImmediately()
                            } else {
                                Task { await restoreDraft(from: draftRestoreBaseline ?? composerDraft, key: draftKey) }
                            }
                        } : nil,
                        context: contextBinding,
                        onInputPreparationChange: { isPreparingInput = $0 },
                        contextAttachmentResolver: model.client as? any FeatureContextAttachmentResolving,
                        messageDeliveries: queuedEdit == nil ? messageDeliveries : [],
                        onSendWithDelivery: model.client is any FeatureMessageDeliveryManaging
                            ? { send(delivery: $0) } : nil,
                        allowProviderSwitch: detail.allowsProviderSwitch == true,
                        followUpBehavior: model.snapshot.settings.followUpBehavior,
                        interactionMode: effectiveInteractionMode,
                        onInteractionModeChange: queuedEdit == nil ? { draftInteractionMode = $0 } : nil,
                        isSendEnabled: canSubmitComposer,
                        composerEnterBehavior: model.snapshot.settings.composerEnterBehavior,
                        retainedAttachmentCount: queuedEdit?.existingAttachments.count ?? 0,
                        submitLabel: queuedEdit == nil ? nil : "Save message",
                        isModelSelectionEnabled: queuedEdit == nil,
                        onCommandMenuUse: {
                            Task {
                                if let environmentID = currentThread.environmentID,
                                   let cwd = workspaceCatalogPath,
                                   let instanceID = selection?.providerID ?? currentSelection?.providerID {
                                    await model.refreshWorkspaceProviders(environmentID: environmentID, cwd: cwd, instanceID: instanceID)
                                }
                            }
                        }
                    )
                    .disabled(isRewinding || isTransferringDraft || isUpdatingQueue)
                }
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

    private var effectiveRuntimeMode: FeatureRuntimeMode { draftRuntimeMode ?? currentThread.runtimeMode }
    private var effectiveInteractionMode: FeatureInteractionMode {
        FeatureComposerModePolicy.interactionMode(draftInteractionMode ?? currentThread.interactionMode,
            provider: threadProviders.first { $0.id == (selection ?? currentSelection)?.providerID })
    }
    private var runtimeModeChoices: [FeatureRuntimeMode] {
        FeatureComposerModePolicy.runtimeModes(for: selection ?? currentSelection, providers: threadProviders)
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

    var threadProviderSkills: [FeatureProviderSkill] {
        guard let selectedProviderID = currentSelection?.providerID else { return [] }
        return threadProviders.first { $0.id == selectedProviderID }?
            .workspaceCatalog(cwd: workspaceCatalogPath).skills ?? []
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

    private var expandedTurnFoldIDs: Set<String>? {
        guard v2InspectionContext != nil else { return nil }
        return Set(v2TimelineState.expandedIDs.filter { $0.hasPrefix("v2-fold:") })
    }

    /// Body runs for many reasons that do not change the transcript, so reuse
    /// the last result until the detail revision, folds, or feedback change.
    private func timelineMessages(_ messages: [FeatureMessage]) -> [FeatureMessage] {
        let key = FeatureTimelineMessagesCache.Key(
            threadID: thread.id,
            detailRevision: model.detailRevisions[thread.id] ?? 0,
            expandedTurnFoldIDs: expandedTurnFoldIDs,
            feedbackRevision: feedbackRevision
        )
        if timelineMessagesCache.key == key { return timelineMessagesCache.messages }
        let result = uncachedTimelineMessages(messages, expandedTurnFoldIDs: key.expandedTurnFoldIDs)
        timelineMessagesCache.key = key
        timelineMessagesCache.messages = result
        return result
    }

    private func uncachedTimelineMessages(
        _ messages: [FeatureMessage],
        expandedTurnFoldIDs: Set<String>?
    ) -> [FeatureMessage] {
        if let expandedTurnFoldIDs {
            // Folds are display-only. The model retains source order and original action targets.
            return FeatureV2TurnFolding.messages(messages, expandedIDs: expandedTurnFoldIDs) + feedbackMessages
        }
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
        guard didRestoreDraft, !isTransferringDraft, !isRewinding, !isUpdatingQueue else { return true }
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
        let requestedWorkspaceRoot = markdownImageContext?.workspaceRoot
        Task {
            do {
                let resolved = try await resolver.previewAssetURL(
                    threadID: requestedThreadID,
                    path: path,
                    kind: kind,
                    workspaceRoot: requestedWorkspaceRoot
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

    private var secretRequestContext: FeatureSecretRequestContext? {
        (model.client as? any FeatureSecretRequestAnswering).map {
            FeatureSecretRequestContext(threadID: thread.id, client: $0,
                canAnswer: model.client.permissions(forThreadID: thread.id)?.grants("orchestration:operate"))
        }
    }

    private var embeddedContentContext: FeatureEmbeddedContentContext? {
        guard let client = model.client as? any FeatureEmbeddedContentClient else { return nil }
        return FeatureEmbeddedContentContext(threadID: thread.id, client: client, sendMessage: { text in
            guard model.client.permissions(forThreadID: thread.id)?.grants("orchestration:operate") == true else {
                throw EnvironmentPermissionDeniedError(requiredScope: "orchestration:operate")
            }
            let sent = await submitMessage(FeatureMessageSubmission(
                threadID: thread.id, text: text, selection: selection ?? currentSelection,
                attachments: [], runtimeMode: effectiveRuntimeMode, interactionMode: effectiveInteractionMode
            ))
            guard sent else { throw FeatureCapabilityUnavailable("Message delivery") }
        }, canEnterFullscreen: scenePhase == .active && isPresentedThread
            && detail?.approvals.isEmpty != false && detail?.userInputs.isEmpty != false)
    }

    private var v2InspectionContext: FeatureV2ItemInspectionContext? {
        guard let client = model.client as? any FeatureV2ItemInspecting,
              detail?.workflows?.isAvailable == true else { return nil }
        return FeatureV2ItemInspectionContext(threadID: thread.id, client: client,
            state: v2TimelineState,
            toolImages: (model.client as? any FeatureToolOutputImageResolving).map {
                FeatureToolOutputImageContext(threadID: thread.id, resolver: $0)
            }, providers: threadProviders,
            onOpenThread: { wireID in
                guard let environmentID = currentThread.environmentID else { return }
                openRelatedThread(FeatureScopedID.thread(environmentID: environmentID, wireID: wireID))
            },
            retryableRunIDs: recoveryControlsAvailable && !isUpdatingRecovery
                ? detail?.execution?.failedWorkspaceRunIDs ?? [] : [],
            onRetryWorkspacePreparation: { runID in
                Task {
                    do { try await updateThreadRecovery(.retryWorkspacePreparation(runID: runID)) }
                    catch { recoveryError = error.localizedDescription }
                }
            })
    }

    private func openRelatedThread(_ id: String) {
        guard !isUpdatingWorkflow else { return }
        isUpdatingWorkflow = true
        workflowTask = Task {
            defer { isUpdatingWorkflow = false }
            do {
                try await model.prepareRelatedThread(id: id, from: thread.id)
                try Task.checkCancellation()
                showsAgents = false
                onOpenThread(id)
            } catch is CancellationError {} catch { workflowError = error.localizedDescription }
        }
    }

    private func performWorkflow(_ action: @escaping @MainActor (any FeatureThreadWorkflowClient) async throws -> String) {
        guard !isUpdatingWorkflow, let client = model.client as? any FeatureThreadWorkflowClient else { return }
        isUpdatingWorkflow = true
        workflowTask = Task {
            defer { isUpdatingWorkflow = false }
            do {
                let id = try await action(client)
                try Task.checkCancellation()
                try await model.prepareRelatedThread(id: id, from: thread.id)
                try Task.checkCancellation()
                onOpenThread(id)
            } catch is CancellationError {} catch { workflowError = error.localizedDescription }
        }
    }

    private func send(delivery requestedDelivery: FeatureMessageDelivery? = nil) {
        guard !isSending, !isUpdatingQueue, !isRewinding, !isTransferringDraft,
              didRestoreDraft, didRestoreQueuedEdit else { return }
        if queuedEdit != nil {
            saveQueuedEdit()
            return
        }
        if let selection, ThreadComposerModelSelectionPolicy.explicitSelection(
            selection, inherited: currentSelection, providers: threadProviders,
            allowProviderSwitch: detail?.allowsProviderSwitch == true
        ) == nil {
            draftSaveError = "This model cannot be used in this thread right now. Your draft is unchanged."
            return
        }
        let delivery = requestedDelivery ?? (model.client is any FeatureMessageDeliveryManaging
            ? FeatureComposerSendPresentation.resolve(
                isWorking: detail?.execution?.activeRun != nil || currentThread.state == .working,
                canSteer: messageDeliveries.contains(.steer),
                followUpBehavior: model.snapshot.settings.followUpBehavior,
                supportsExplicitDelivery: messageDeliveries.contains(.queue)
            ).delivery : .auto)
        guard detail?.execution?.isReadOnly != true else { return }
        guard delivery == .auto || (delivery == .queue && model.client is any FeatureMessageDeliveryManaging)
            || messageDeliveries.contains(delivery) else { return }
        let message = draft
        let pendingContext = composerContext
        let pendingSelection = selection ?? currentSelection
        let pendingRuntimeMode = effectiveRuntimeMode
        let pendingInteractionMode = effectiveInteractionMode
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
        if FeatureThreadUsageLimits.isCommand(message, hasAttachments: !pendingAttachments.isEmpty),
           let providerID = selection?.providerID ?? currentSelection?.providerID,
           let source = model.client as? any FeatureThreadUsageLimitsProviding,
           let report = source.threadUsageLimits(threadID: thread.id, providerID: providerID) {
            usageLimitsReport = report
            draft = ""
            composerContext = nil
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
        composerContext = nil
        composerFocused = false
        Task {
            await pendingDraftSave?.value
            let sent = await submitMessage(
                FeatureMessageSubmission(
                    threadID: thread.id,
                    text: message,
                    selection: pendingSelection,
                    attachments: pendingAttachments,
                    context: pendingContext,
                    runtimeMode: pendingRuntimeMode,
                    interactionMode: pendingInteractionMode,
                    delivery: delivery
                )
            )
            if sent {
                let trailingSave = draftSaveTask
                trailingSave?.cancel()
                draftSaveTask = nil
                await trailingSave?.value
                let followUpDraft = composerDraft
                if followUpDraft.isEmpty {
                    try? await draftStore.removeDraft(for: draftKey)
                } else {
                    try? await draftStore.setDraft(followUpDraft, for: draftKey)
                }
                // Release the sent attachments' bytes and upload jobs.
                if let environmentID = currentThread.environmentID {
                    model.attachmentUploads.syncOwner(
                        draftKey: draftKey,
                        environmentID: environmentID,
                        attachments: followUpDraft.attachments
                    )
                }
            } else {
                let currentDraft = draft
                let restoredMessage: String
                do {
                    composerContext = try FeatureComposerContext.merge(pendingContext, composerContext)
                    restoredMessage = message
                } catch {
                    // The failed turn and the new draft can each contain 200 items.
                    // Retain the failed turn as readable text if their records cannot fit together.
                    restoredMessage = ComposerContextReferences.providerProjection(message, context: pendingContext)
                }
                if currentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    draft = restoredMessage
                } else if !restoredMessage.isEmpty {
                    draft = "\(restoredMessage)\n\(currentDraft)"
                }
                let pendingIDs = Set(pendingAttachments.map(\.id))
                attachments = pendingAttachments + attachments.filter {
                    !pendingIDs.contains($0.id)
                }
                sendFailed = model.errorMessage == nil
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

    private var activeDraftKey: String {
        queuedEdit == nil ? draftKey : FeatureComposerDraftStore.queuedRunEditKey(for: draftKey)
    }

    private var canSubmitComposer: Bool {
        if let environment = model.snapshot.environments.first(where: { $0.id == currentThread.environmentID }),
           environment.connectionState == .connected,
           environment.permissions?.grants("orchestration:operate") != true { return false }
        guard didRestoreQueuedEdit else { return false }
        guard let edit = currentQueuedEdit else { return true }
        guard queueControlsAvailable, edit.validationMessage == nil,
              let execution = detail?.execution else { return false }
        return edit.isStillQueued(in: execution)
    }

    private var currentQueuedEdit: FeatureQueuedRunEdit? {
        guard var edit = queuedEdit else { return nil }
        edit.draft = composerDraft
        return edit
    }

    private func applyComposerDraft(_ saved: FeatureComposerDraft) {
        draft = saved.text
        attachments = saved.attachments
        composerContext = saved.context
        selection = saved.selection
        draftWorkspace = saved.workspace
        draftRuntimeMode = saved.runtimeMode
        draftInteractionMode = saved.interactionMode
        missingFileRecoverySnapshot = nil
        didRestoreDraft = true
    }

    private var canTransferDraft: Bool {
        didRestoreDraft && !isSending && !isRewinding && !isPreparingInput
            && !isUpdatingQueue && !isTransferringDraft && queuedEdit == nil
    }

    private func canEditPendingMessage(_ messageID: String) -> Bool {
        canTransferDraft && model.canEditPendingSubmission(threadID: thread.id, messageID: messageID)
    }

    private func editPendingMessage(_ messageID: String) {
        guard canEditPendingMessage(messageID) else { return }
        transferSubmissionDraft { saved in
            await model.editPendingSubmission(threadID: thread.id, messageID: messageID, draft: saved)
        }
    }

    @ViewBuilder
    private var submissionRecoveryControls: some View {
        ForEach(model.submissionRecoveryDrafts.filter { $0.threadID == thread.id && !$0.isNewTask }) { recovery in
            VStack(alignment: .leading, spacing: 4) {
                Text(recovery.reason ?? "This message could not be sent.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.danger)
                HStack(spacing: 20) {
                    Button("Edit message") {
                        transferSubmissionDraft { saved in
                            await model.recoverSubmission(id: recovery.id, draftKey: draftKey, draft: saved)
                        }
                    }
                    Button("Discard", role: .destructive) {
                        pendingDiscardRecoveryID = recovery.id
                    }
                }
                .disabled(!canTransferDraft || model.recoveringSubmissionIDs.contains(recovery.id))
                .frame(minHeight: T3Metrics.minimumTapTarget)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
        }
    }

    private func transferSubmissionDraft(
        _ transfer: @escaping @MainActor (FeatureComposerDraft) async -> FeatureComposerDraft?
    ) {
        guard canTransferDraft else { return }
        isTransferringDraft = true
        let saved = composerDraft
        let pendingSave = draftSaveTask
        pendingSave?.cancel()
        draftSaveTask = nil
        Task {
            defer { isTransferringDraft = false }
            await pendingSave?.value
            if let recovered = await transfer(saved) {
                applyComposerDraft(recovered)
                draftSaveError = nil
                syncComposerAttachments()
                composerFocused = true
            } else {
                draftSaveError = model.errorMessage ?? "The message could not be restored. Try again."
            }
        }
    }

    private func syncComposerAttachments() {
        guard let environmentID = currentThread.environmentID else { return }
        model.attachmentUploads.syncOwner(draftKey: activeDraftKey,
            environmentID: environmentID, attachments: attachments)
    }

    @MainActor
    private func beginQueuedEdit(_ entry: FeatureThreadExecution.QueuedEntry) async {
        guard canTransferDraft, queueControlsAvailable, let execution = detail?.execution,
              execution.queuedEntries.contains(where: { $0.id == entry.id && $0.messageID == entry.messageID }),
              entry.hasMessage else { return }
        isTransferringDraft = true
        let normal = composerDraft
        let pendingSave = draftSaveTask
        pendingSave?.cancel()
        draftSaveTask = nil
        await pendingSave?.value
        do {
            try await draftStore.setDraft(normal, for: draftKey)
            let edit = FeatureQueuedRunEdit(entry: entry)
            try await draftStore.saveQueuedRunEdit(edit, for: draftKey)
            ordinaryDraftBeforeQueueEdit = normal
            queuedEdit = edit
            applyComposerDraft(edit.draft)
            didRestoreQueuedEdit = true
            showsThreadQueue = false
            queueActionError = nil
            syncComposerAttachments()
            composerFocused = true
        } catch {
            queueActionError = error.localizedDescription
        }
        isTransferringDraft = false
        if let edit = currentQueuedEdit, let execution = detail?.execution,
           !edit.isStillQueued(in: execution) {
            recoverStartedQueueEdit()
        }
    }

    @MainActor
    private func restoreQueuedEditIfNeeded() async {
        guard canTransferDraft, !didRestoreQueuedEdit else { return }
        isTransferringDraft = true
        let pendingSave = draftSaveTask
        pendingSave?.cancel()
        draftSaveTask = nil
        await pendingSave?.value
        do {
            if let edit = try await draftStore.queuedRunEdit(for: draftKey) {
                let normal = composerDraft
                try await draftStore.setDraft(normal, for: draftKey)
                ordinaryDraftBeforeQueueEdit = normal
                queuedEdit = edit
                applyComposerDraft(edit.draft)
                syncComposerAttachments()
            }
            didRestoreQueuedEdit = true
            queueActionError = nil
        } catch {
            queueActionError = "Could not restore queued edit. \(error.localizedDescription)"
        }
        isTransferringDraft = false
        if let edit = currentQueuedEdit, let execution = detail?.execution,
           !edit.isStillQueued(in: execution) {
            recoverStartedQueueEdit()
        }
    }

    private func cancelQueuedEdit() {
        guard queuedEdit != nil, !isUpdatingQueue, !isTransferringDraft, !isPreparingInput else { return }
        isTransferringDraft = true
        let pendingSave = draftSaveTask
        pendingSave?.cancel()
        draftSaveTask = nil
        Task {
            defer { isTransferringDraft = false }
            await pendingSave?.value
            do { try await finishQueuedEdit() }
            catch { queueActionError = error.localizedDescription }
        }
    }

    @MainActor
    private func finishQueuedEdit(restoring recovered: FeatureComposerDraft? = nil) async throws {
        let normal: FeatureComposerDraft
        if let recovered { normal = recovered }
        else { normal = try await draftStore.draft(for: draftKey) ?? ordinaryDraftBeforeQueueEdit ?? .init() }
        // Recovery already moved the draft and removed the edit in one write.
        if recovered == nil { try await draftStore.removeQueuedRunEdit(for: draftKey) }
        model.attachmentUploads.removeOwner(draftKey: activeDraftKey)
        queuedEdit = nil
        ordinaryDraftBeforeQueueEdit = nil
        applyComposerDraft(normal)
        queueActionError = nil
        draftSaveError = nil
        syncComposerAttachments()
        composerFocused = true
    }

    private func saveQueuedEdit() {
        guard let edit = currentQueuedEdit, !isPreparingInput, queueControlsAvailable,
              !isUpdatingQueue, let client = model.client as? any FeatureThreadQueueManaging else { return }
        if let validation = edit.validationMessage {
            queueActionError = validation
            return
        }
        guard let execution = detail?.execution, edit.isStillQueued(in: execution) else {
            recoverStartedQueueEdit()
            return
        }
        isUpdatingQueue = true
        queueActionError = nil
        let pendingSave = draftSaveTask
        pendingSave?.cancel()
        draftSaveTask = nil
        Task {
            await pendingSave?.value
            do {
                try await draftStore.saveQueuedRunEdit(edit, for: draftKey)
                try await client.updateThreadQueue(threadID: thread.id, action: .replace(edit))
                try await finishQueuedEdit()
            } catch {
                queueActionError = error.localizedDescription
                _ = await model.detail(for: thread.id, force: true, fresh: true)
            }
            isUpdatingQueue = false
            if let edit = currentQueuedEdit, let execution = detail?.execution,
               !edit.isStillQueued(in: execution), refreshPresentation == nil {
                recoverStartedQueueEdit()
            }
        }
    }

    /// Another device can start the run while this composer is open. Retain
    /// the edit until its server files and new files are saved as a normal draft.
    private func recoverStartedQueueEdit() {
        guard let edit = currentQueuedEdit, let execution = detail?.execution,
              !edit.isStillQueued(in: execution), !isUpdatingQueue, !isTransferringDraft,
              !isPreparingInput, refreshPresentation == nil,
              let client = model.client as? any FeatureThreadRecoveryClient else { return }
        isTransferringDraft = true
        let pendingSave = draftSaveTask
        pendingSave?.cancel()
        draftSaveTask = nil
        Task {
            defer { isTransferringDraft = false }
            await pendingSave?.value
            do {
                // Freeze upload-reference writes along with text edits during the transfer.
                model.attachmentUploads.removeOwner(draftKey: activeDraftKey)
                try await draftStore.saveQueuedRunEdit(edit, for: draftKey)
                guard let savedEdit = try await draftStore.queuedRunEdit(for: draftKey) else {
                    throw FeatureThreadRecoveryError("The saved edit is unavailable. Try again.")
                }
                let recovery = try await client.queuedRunEditRecoveryDraft(threadID: thread.id, edit: savedEdit)
                let restored = try await draftStore.recoverQueuedRunEdit(savedEdit, recovery: recovery, for: draftKey)
                try await finishQueuedEdit(restoring: restored)
                queueActionError = "The queued message already started or was removed. Your edit is in the composer."
            } catch {
                queueActionError = "Your queued edit is still saved. \(error.localizedDescription)"
                syncComposerAttachments()
            }
        }
    }

    private var recoveryControlsAvailable: Bool {
        model.client is any FeatureThreadRecoveryClient && threadConnectionState == .connected
            && refreshPresentation == nil && detail?.execution?.canManageQueue == true
            && !isSending && !isTransferringDraft && !isRewinding && !isRestarting
            && !isUpdatingRecovery && !isUpdatingQueue
    }

    @MainActor
    private func updateThreadRecovery(_ action: FeatureThreadRecoveryAction) async throws {
        guard recoveryControlsAvailable, let client = model.client as? any FeatureThreadRecoveryClient else {
            throw FeatureThreadRecoveryError("Recovery is unavailable. Reconnect and try again.")
        }
        isUpdatingRecovery = true
        recoveryError = nil
        defer { isUpdatingRecovery = false }
        try await client.updateThreadRecovery(threadID: thread.id, action: action)
    }

    private func performThreadKeyboardCommand(_ command: FeatureKeyboardCommand) {
        switch command {
        case .files: presentTool(.files)
        case .terminal: presentTool(.terminal(nil))
        case .review: presentTool(.review)
        case .back: toolSurface = nil
        case .copyThreadReference:
            UIPasteboard.general.string = currentPullRequest?.url.absoluteString
                ?? currentThread.wireID ?? currentThread.id
        default: break
        }
    }

    private func updateVisibleThread() {
        guard let environmentID = currentThread.environmentID, let wireID = currentThread.wireID else { return }
        if scenePhase == .active {
            PlatformVisibleThreadTracker.shared.setVisibleThread(environmentID: environmentID, wireID: wireID)
        } else {
            PlatformVisibleThreadTracker.shared.clear(environmentID: environmentID, wireID: wireID)
        }
    }

    private func clearVisibleThread() {
        guard let environmentID = currentThread.environmentID, let wireID = currentThread.wireID else { return }
        PlatformVisibleThreadTracker.shared.clear(environmentID: environmentID, wireID: wireID)
    }

    private var draftKey: String {
        FeatureComposerDraftStore.threadKey(currentThread)
    }

    private var contextBinding: Binding<OrchestrationMessageContext?> {
        Binding(get: { composerContext }, set: { value in
            composerContext = value
            scheduleDraftSave()
        })
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
        if model.recoveredRewindDrafts[thread.id] != nil {
            restoreRewindDraft()
            return
        }
        draftRestoreBaseline = baseline
        let saved: FeatureComposerDraft?
        do { saved = try await draftStore.draft(for: key) }
        catch {
            draftSaveError = "Could not restore draft. \(error.localizedDescription)"
            return
        }
        guard !Task.isCancelled else { return }
        if model.recoveredRewindDrafts[thread.id] != nil {
            restoreRewindDraft()
            return
        }

        let liveDraft = composerDraft
        let restored: FeatureComposerDraft
        var recoveredMissingFiles = false
        do {
            restored = try FeatureComposerDraftRestoration.merge(saved: saved, baseline: baseline, current: liveDraft,
                onMissingAttachments: { recoveredMissingFiles = true })
        } catch {
            draftSaveError = error.localizedDescription
            return
        }
        // A saved handoff remains intentional while live capability discovery catches up.
        // The picker and dispatch boundary validate new choices against current capabilities.
        applyComposerDraft(restored)
        missingFileRecoverySnapshot = recoveredMissingFiles ? composerDraft : nil
        draftSaveError = recoveredMissingFiles ? FeatureComposerDraftRestoration.missingFilesWarning : nil

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
        persistComposerDraft(debounced: true)
    }

    private func persistDraftImmediately() {
        persistComposerDraft(debounced: false)
    }

    private func persistComposerDraft(debounced: Bool) {
        guard didRestoreDraft, !isRewinding, !isTransferringDraft, !isUpdatingQueue else { return }
        guard !FeatureComposerDraftRestoration.keepsSavedRecovery(missingFileRecoverySnapshot, current: composerDraft) else { return }
        missingFileRecoverySnapshot = nil
        let previousSave = draftSaveTask
        previousSave?.cancel()
        let snapshot = composerDraft
        let edit = currentQueuedEdit
        let key = draftKey
        let uploadKey = activeDraftKey
        let environmentID = currentThread.environmentID
        draftSaveTask = Task {
            await previousSave?.value
            do {
                if debounced { try await Task.sleep(for: .milliseconds(220)) }
                try Task.checkCancellation()
                if let edit { try await draftStore.saveQueuedRunEdit(edit, for: key) }
                else { try await draftStore.setDraft(snapshot, for: key) }
                guard !Task.isCancelled else { return }
                draftSaveError = nil
                if let environmentID {
                    model.attachmentUploads.syncOwner(draftKey: uploadKey,
                        environmentID: environmentID, attachments: snapshot.attachments)
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                draftSaveError = "Could not save draft. \(error.localizedDescription)"
            }
        }
    }

    private func persistDraftBeforeLeaving() {
        guard didRestoreDraft else { return }
        persistDraftImmediately()
    }

    /// Routes transcript links in-app: workspace files open the Files sheet,
    /// media opens the native preview, artifact templates fill the composer.
    /// Installed on the SwiftUI tree and injected into every hosted cell,
    /// because `UIHostingConfiguration` does not inherit the parent
    /// environment across the representable boundary.
    private var transcriptOpenURL: OpenURLAction {
        OpenURLAction { url in
            if handleArtifactTemplateURL(url) { return .handled }
            if handleTypedMediaPreviewURL(url) { return .handled }
            if PlatformDeepLinkParser.isThreadLink(url) {
                if let environmentID = currentThread.environmentID,
                   let route = try? PlatformDeepLinkParser.threadLinkRoute(
                    url, environmentID: environmentID, in: model.snapshot
                ), let scopedURL = route.url {
                    parentOpenURL(scopedURL)
                } else {
                    parentOpenURL(url)
                }
                return .handled
            }
            if PlatformInAppLinkRouter.route(for: url, in: model.snapshot) != nil {
                parentOpenURL(url)
                return .handled
            }
            if case let .workspaceFile(hostPath) = MarkdownImageSource.classify(
                url.absoluteString, workspaceRoot: markdownImageContext?.workspaceRoot
            ) {
                let kind = FeatureFilePreviewKind.infer(path: hostPath)
                if kind.opensLinkedMediaPreview {
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
                    if kind.opensLinkedMediaPreview {
                        resolveHostMedia(path: path, kind: kind)
                        return .handled
                    }
                }
                if url.scheme?.lowercased() == "t3code" { return .discarded }
                parentOpenURL(url)
                return .handled
            }
            let kind = FeatureFilePreviewKind.infer(path: path)
            if kind.opensLinkedMediaPreview {
                resolveHostMedia(path: path, kind: kind)
                return .handled
            }
            toolSurface = .file(path, line: nil)
            return .handled
        }
    }

    private var composerDraft: FeatureComposerDraft {
        FeatureComposerDraft(
            text: draft,
            attachments: attachments,
            selection: selection,
            workspace: draftWorkspace,
            context: composerContext,
            runtimeMode: draftRuntimeMode,
            interactionMode: draftInteractionMode
        )
    }

}

enum ThreadRefreshPresentation: Equatable {
    case loading
    case catchingUp
    case reconnecting
    case offline
    case failed
    case needsPairing

    var title: String {
        switch self {
        case .loading: "Updating thread..."
        case .catchingUp: "Catching up..."
        case .reconnecting: "Reconnecting..."
        case .offline: "Computer offline"
        case .failed: "Could not update thread"
        case .needsPairing: "Pair with this computer again in Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .loading, .catchingUp: "hourglass"
        case .reconnecting: "wifi"
        case .offline, .failed: "wifi.exclamationmark"
        case .needsPairing: "key.slash"
        }
    }

    var canRetry: Bool { self == .offline || self == .failed }

    static func resolve(
        loadState: FeatureThreadLoadState?,
        connectionState: FeatureConnection.State?,
        isOpening: Bool,
        syncState: FeatureThreadSyncState? = nil
    ) -> Self? {
        if connectionState == .needsPairing { return .needsPairing }
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
        case .needsPairing: return .needsPairing
        case .connected, nil: return nil
        }
    }
}

/// Last `timelineMessages` result. A plain class, so filling it during body
/// does not invalidate the view.
@MainActor
private final class FeatureTimelineMessagesCache {
    struct Key: Equatable {
        let threadID: String
        let detailRevision: UInt64
        let expandedTurnFoldIDs: Set<String>?
        let feedbackRevision: UInt64
    }

    var key: Key?
    var messages: [FeatureMessage] = []
}

/// Runs `onChange` when the draft text changes. Only this view depends on
/// the text, so typing does not re-evaluate the whole thread view.
private struct FeatureDraftTextObserver: View {
    @Binding var text: String
    let onChange: () -> Void

    var body: some View {
        Color.clear.onChange(of: text) { onChange() }
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

private struct FeatureThreadDeviceObservation: Hashable {
    let threadID: String
    let connection: FeatureConnection.State?
    let foreground: Bool
}

private struct FeatureThreadVisitRequest: Hashable {
    let observation: FeatureThreadVisitObservation
    let connection: FeatureConnection.State?
}

private struct FeatureThreadToolRequest: Hashable {
    let destination: FeatureThreadDestination?
    let requestID: UUID?
}

private enum FeatureThreadToolSurface: Identifiable, Equatable {
    case files
    case file(String, line: Int?)
    case review
    case sourceControl(FeatureThreadDestination)
    case terminal(String?)
    case devices
    case browser(String?)

    init(_ destination: FeatureThreadDestination) {
        switch destination {
        case let .files(path?, line): self = .file(path, line: line)
        case .files: self = .files
        case let .terminal(sessionID): self = .terminal(sessionID)
        case .review: self = .review
        case .devices: self = .devices
        case let .browser(tabID): self = .browser(tabID)
        case .git, .gitCommit, .gitBranches: self = .sourceControl(destination)
        }
    }

    var destination: FeatureThreadDestination {
        switch self {
        case .files: .files(path: nil, line: nil)
        case let .file(path, line): .files(path: path, line: line)
        case .review: .review
        case let .sourceControl(destination): destination
        case let .terminal(sessionID): .terminal(sessionID: sessionID)
        case .devices: .devices
        case let .browser(tabID): .browser(tabID: tabID)
        }
    }

    var id: FeatureThreadDestination { destination }

    var isTerminal: Bool {
        if case .terminal = self { return true }
        return false
    }
}

struct ThreadPullRequestDestination: Equatable {
    let number: Int
    let url: URL

    static func resolve(
        thread: FeatureThread,
        branchPullRequest: FeaturePullRequest?
    ) -> Self? {
        if let linked = thread.effectivePullRequest,
           let url = URL(string: linked.url) {
            return Self(number: linked.number, url: url)
        }

        guard let pullRequest = branchPullRequest,
              let url = pullRequest.url else { return nil }
        return Self(number: pullRequest.number, url: url)
    }
}

/// Keep live edits, but restore file context only with the attachments it needs.
enum FeatureComposerDraftRestoration {
    static let missingFilesWarning = "Some saved files are missing. Their metadata is shown in the draft. The saved draft stays unchanged until you edit or send."

    static func keepsSavedRecovery(_ snapshot: FeatureComposerDraft?, current: FeatureComposerDraft) -> Bool {
        guard let snapshot else { return false }
        return snapshot.text == current.text && snapshot.context == current.context
            && snapshot.runtimeMode == current.runtimeMode
            && snapshot.interactionMode == current.interactionMode
            && snapshot.attachments.count == current.attachments.count
            && zip(snapshot.attachments, current.attachments).allSatisfy { saved, live in
                var saved = saved
                var live = live
                saved.uploadedReference = nil
                live.uploadedReference = nil
                return saved == live
            }
    }

    enum RestorationError: LocalizedError {
        case attachmentLimit

        var errorDescription: String? {
            switch self {
            case .attachmentLimit:
                "Remove an attachment, then retry restoring the draft. The saved draft has not changed."
            }
        }
    }

    static func merge(
        saved: FeatureComposerDraft?,
        baseline: FeatureComposerDraft,
        current: FeatureComposerDraft,
        fallbackSelection: FeatureSelection? = nil,
        fallbackWorkspace: FeatureComposerWorkspaceDraft? = nil,
        onMissingAttachments: () -> Void = {}
    ) throws -> FeatureComposerDraft {
        var restored = FeatureComposerDraft(
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
            ),
            context: current.context == baseline.context ? saved?.context : current.context,
            runtimeMode: current.runtimeMode == baseline.runtimeMode
                ? saved?.runtimeMode : current.runtimeMode,
            interactionMode: current.interactionMode == baseline.interactionMode
                ? saved?.interactionMode : current.interactionMode
        )
        restored.context = ComposerContextReferences.referenced(restored.context, text: restored.text)
        var missing: [ComposerContextRecord] = []
        if let context = restored.context {
            func matches(_ attachment: FeatureDraftAttachment, id: String) -> Bool {
                attachment.id.uuidString.caseInsensitiveCompare(id) == .orderedSame
                    || attachment.uploadedReference?.attachmentID == id
            }
            for record in context.records {
                guard let binding = record.attachment,
                      !restored.attachments.contains(where: { matches($0, id: binding.attachmentId) }) else { continue }
                guard let attachment = saved?.attachments.first(where: { matches($0, id: binding.attachmentId) }) else {
                    missing.append(record)
                    continue
                }
                guard restored.attachments.count < FeatureImageAttachmentLimits.maximumCount else {
                    throw RestorationError.attachmentLimit
                }
                restored.attachments.append(attachment)
            }
        }
        let missingIDs = Set(missing.map(\.contextId))
        let directIDs = Set(ComposerContextReferences.collect(restored.text).map(\.contextId))
        func missingText(_ record: ComposerContextRecord) -> String {
            "[Missing attachment: \(record.label)]\n" + ComposerContextReferences.providerPayload(record)
        }
        let originalText = restored.text
        restored.text = ComposerContextReferences.replace(originalText) { reference in
            missing.first(where: { $0.contextId == reference.contextId }).map(missingText)
                ?? (originalText as NSString).substring(with: reference.range)
        }
        for record in missing where !directIDs.contains(record.contextId) {
            restored.text += "\n\n" + missingText(record)
        }
        var repairedScreenshot = false
        let records = (restored.context?.records ?? []).filter { !missingIDs.contains($0.contextId) }.map { record in
            var record = record
            if case var .previewAnnotation(annotation) = record.payload,
               let screenshot = annotation.screenshotContextId,
               missingIDs.contains(screenshot) || !(restored.context?.records.contains { $0.contextId == screenshot && $0.kind == "image" } ?? false) {
                if !missingIDs.contains(screenshot) {
                    restored.text += "\n\n[Missing screenshot: \(record.label)]\ncontextId: \(screenshot)"
                }
                annotation.screenshotContextId = nil
                record.payload = .previewAnnotation(annotation)
                repairedScreenshot = true
            }
            return record
        }
        restored.context = records.isEmpty ? nil : .init(records: records)
        if !missing.isEmpty || repairedScreenshot { onMissingAttachments() }
        return restored
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
    let environmentID: String?
    let messages: [FeatureMessage]
    let openURL: OpenURLAction
    let imageContext: MarkdownImageContext?
    let attachmentContext: FeatureAttachmentContext?
    let skills: [FeatureProviderSkill]
    let v2Inspection: FeatureV2ItemInspectionContext?
    let secretContext: FeatureSecretRequestContext?
    let embeddedContext: FeatureEmbeddedContentContext?
    let workflows: FeatureThreadWorkflows
    let isWorkflowBusy: Bool
    let onFork: (FeatureThreadWorkflowSource) -> Void
    let onOpenThread: (String) -> Void
    let presentationDismissal: FeatureThreadPresentationDismissal
    let renderUpdate: FeatureDetailRenderUpdate?
    let expandedTurnFoldIDs: Set<String>?
    let dynamicTypeSize: DynamicTypeSize
    let codeSizeSteps: Int
    let isWorking: Bool
    let isCompacting: Bool
    let activeSubagentCount: Int
    let backgroundWorkIsActive: Bool
    let isMonitoring: Bool
    let canLoadEarlier: Bool
    let isLoadingEarlier: Bool
    let onLoadEarlier: () -> Void
    let onDismissKeyboard: () -> Void
    let canEditMessage: (String) -> Bool
    let onEditMessage: (String) -> Void
    let canEditPendingMessage: (String) -> Bool
    let onEditPendingMessage: (String) -> Void

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
        collectionView.keyboardDismissMode = .interactive
        collectionView.delaysContentTouches = false
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.isPrefetchingEnabled = true
        collectionView.accessibilityIdentifier = "thread-transcript"
        context.coordinator.connect(to: collectionView)
        return collectionView
    }

    func updateUIView(_ collectionView: UICollectionView, context: Context) {
        context.coordinator.currentOpenURL = openURL
        context.coordinator.canEditMessage = canEditMessage
        context.coordinator.onEditMessage = onEditMessage
        context.coordinator.canEditPendingMessage = canEditPendingMessage
        context.coordinator.onEditPendingMessage = onEditPendingMessage
        let inspectionChanged = context.coordinator.currentV2Inspection?.retryableRunIDs != v2Inspection?.retryableRunIDs
            || context.coordinator.currentV2Inspection?.providers != v2Inspection?.providers
            || context.coordinator.currentEmbeddedContext?.canEnterFullscreen != embeddedContext?.canEnterFullscreen
            || context.coordinator.currentSecretContext?.canAnswer != secretContext?.canAnswer
        context.coordinator.currentV2Inspection = v2Inspection
        context.coordinator.currentSecretContext = secretContext
        context.coordinator.currentEmbeddedContext = embeddedContext
        context.coordinator.onFork = onFork
        context.coordinator.onOpenThread = onOpenThread
        context.coordinator.update(
            threadID: threadID,
            environmentID: environmentID,
            inspectionChanged: inspectionChanged,
            messages: messages,
            imageContext: imageContext,
            attachmentContext: attachmentContext,
            skills: skills,
            workflows: workflows,
            isWorkflowBusy: isWorkflowBusy,
            presentationDismissal: presentationDismissal,
            renderUpdate: renderUpdate,
            expandedTurnFoldIDs: expandedTurnFoldIDs,
            dynamicTypeSize: dynamicTypeSize,
            codeSizeSteps: codeSizeSteps,
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
        private var currentEnvironmentID: String?
        var currentOpenURL: OpenURLAction?
        var canEditMessage: ((String) -> Bool)?
        var onEditMessage: ((String) -> Void)?
        var canEditPendingMessage: ((String) -> Bool)?
        var onEditPendingMessage: ((String) -> Void)?
        var currentV2Inspection: FeatureV2ItemInspectionContext?
        var currentSecretContext: FeatureSecretRequestContext?
        var currentEmbeddedContext: FeatureEmbeddedContentContext?
        var onFork: ((FeatureThreadWorkflowSource) -> Void)?
        var onOpenThread: ((String) -> Void)?
        private var currentWorkflows: FeatureThreadWorkflows = .unavailable
        private var currentIsWorkflowBusy = false
        private var workflowState = FeatureTranscriptWorkflowState()
        private var currentPresentationDismissal = FeatureThreadPresentationDismissal()
        private var currentImageContext: MarkdownImageContext?
        private var currentAttachmentContext: FeatureAttachmentContext?
        private var currentSkills: [FeatureProviderSkill] = []
        private var currentDetailRevision: UInt64?
        private var currentExpandedTurnFoldIDs: Set<String>?
        private var currentDynamicTypeSize: DynamicTypeSize?
        private var currentCodeSizeSteps = 0
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

        func collectionView(
            _ collectionView: UICollectionView,
            contextMenuConfigurationForItemAt indexPath: IndexPath,
            point: CGPoint
        ) -> UIContextMenuConfiguration? {
            guard let messageID = dataSource?.itemIdentifier(for: indexPath),
                  messagesByID[messageID]?.role == .user,
                  canEditMessage?(messageID) == true || canEditPendingMessage?(messageID) == true else { return nil }
            return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
                var actions: [UIAction] = []
                if self?.canEditPendingMessage?(messageID) == true {
                    actions.append(UIAction(title: "Edit pending message", image: UIImage(systemName: "pencil")) { [weak self] _ in
                        guard self?.canEditPendingMessage?(messageID) == true else { return }
                        self?.onEditPendingMessage?(messageID)
                    })
                } else if self?.canEditMessage?(messageID) == true {
                    actions.append(UIAction(title: "Edit from here", image: UIImage(systemName: "arrow.uturn.backward")) { [weak self] _ in
                        guard self?.canEditMessage?(messageID) == true else { return }
                        self?.onEditMessage?(messageID)
                    })
                }
                return UIMenu(children: actions)
            }
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
                    VStack(alignment: .leading, spacing: 0) {
                        FeatureMessageView(
                            message: message,
                            imageContext: self?.currentImageContext,
                            attachmentContext: self?.currentAttachmentContext,
                            skills: self?.currentSkills ?? [],
                            v2Inspection: self?.currentV2Inspection,
                            secretContext: self?.currentSecretContext,
                            embeddedContext: self?.currentEmbeddedContext,
                            environmentID: self?.currentEnvironmentID,
                            agents: self?.currentWorkflows.agents ?? [],
                            onOpenThread: { self?.onOpenThread?($0) }
                        )
                        FeatureThreadForkButton(source: message.v2FoldID == nil ? message.v2Timeline?.workflowSource : nil,
                            workflows: self?.currentWorkflows ?? .unavailable,
                            isBusy: self?.currentIsWorkflowBusy == true,
                            onFork: { self?.onFork?($0) })
                    }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .environment(
                            \.featureThreadPresentationDismissal,
                            self?.currentPresentationDismissal ?? FeatureThreadPresentationDismissal()
                        )
                        .environment(\.t3CodeSizeSteps, self?.currentCodeSizeSteps ?? 0)
                        .environment(
                            \.openURL,
                            self?.currentOpenURL ?? OpenURLAction { _ in .systemAction }
                        )
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
            environmentID: String?,
            inspectionChanged: Bool,
            messages: [FeatureMessage],
            imageContext: MarkdownImageContext?,
            attachmentContext: FeatureAttachmentContext?,
            skills: [FeatureProviderSkill],
            workflows: FeatureThreadWorkflows,
            isWorkflowBusy: Bool,
            presentationDismissal: FeatureThreadPresentationDismissal,
            renderUpdate: FeatureDetailRenderUpdate?,
            expandedTurnFoldIDs: Set<String>?,
            dynamicTypeSize: DynamicTypeSize,
            codeSizeSteps: Int,
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
                || currentAttachmentContext != attachmentContext
            let skillsChanged = currentSkills != skills
            let environmentChanged = currentEnvironmentID != environmentID
            let inspectionContextChanged = environmentChanged || inspectionChanged
            let revisionChanged = currentDetailRevision != renderUpdate?.revision
            let turnFoldsChanged = currentExpandedTurnFoldIDs != expandedTurnFoldIDs
            // The scan walks every row, so run it only when one of its inputs changed.
            let workflowInputsChanged = threadChanged || revisionChanged || turnFoldsChanged || environmentChanged
                || currentWorkflows != workflows || currentIsWorkflowBusy != isWorkflowBusy
            let workflowChangedIDs = workflowInputsChanged
                ? workflowState.update(
                    messages: messages, workflows: workflows,
                    environmentID: environmentID, isWorkflowBusy: isWorkflowBusy
                )
                : []
            // Keep future cell configurations current even when no displayed row changed.
            currentWorkflows = workflows
            currentIsWorkflowBusy = isWorkflowBusy
            let presentationDismissalChanged = currentPresentationDismissal.requestID != presentationDismissal.requestID
            currentPresentationDismissal = presentationDismissal
            let typeSizeChanged = currentDynamicTypeSize != dynamicTypeSize
                || currentCodeSizeSteps != codeSizeSteps
            let workingChanged = currentIsWorking != isWorking
            let workingDetailChanged = currentIsCompacting != isCompacting
                || currentActiveSubagentCount != activeSubagentCount
                || currentBackgroundWorkIsActive != backgroundWorkIsActive
                || currentIsMonitoring != isMonitoring
            let loadEarlierChanged = currentCanLoadEarlier != canLoadEarlier
                || currentIsLoadingEarlier != isLoadingEarlier
            guard threadChanged || imageContextChanged || skillsChanged || typeSizeChanged
                || inspectionContextChanged || !workflowChangedIDs.isEmpty
                || presentationDismissalChanged
                || revisionChanged || turnFoldsChanged || workingChanged
                || workingDetailChanged || loadEarlierChanged else { return }

            let incremental = !threadChanged && !turnFoldsChanged
                ? incrementalState(messages: messages, renderUpdate: renderUpdate,
                                   verifyDisplayOrder: expandedTurnFoldIDs != nil)
                : nil
            let state = incremental ?? fullState(messages: messages)
            let newIDs = state.ids
            let idsChanged = state.idsChanged
            let contentChangedIDs = typeSizeChanged || imageContextChanged || skillsChanged || inspectionContextChanged
                ? newIDs
                : state.changedIDs
            var changedIDs = workflowChangedIDs.isEmpty
                ? contentChangedIDs
                : Array(Set(contentChangedIDs).union(workflowChangedIDs))
            if presentationDismissalChanged {
                let currentIDs = Set(newIDs)
                let visibleIDs = collectionView.indexPathsForVisibleItems.compactMap {
                    dataSource.itemIdentifier(for: $0)
                }.filter { currentIDs.contains($0) }
                changedIDs = Array(Set(changedIDs).union(visibleIDs))
            }

            currentImageContext = imageContext
            currentAttachmentContext = attachmentContext
            currentSkills = skills
            currentEnvironmentID = environmentID
            currentDetailRevision = renderUpdate?.revision
            currentExpandedTurnFoldIDs = expandedTurnFoldIDs
            currentDynamicTypeSize = dynamicTypeSize
            currentCodeSizeSteps = codeSizeSteps
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
                // Agent progress and fork controls do not change parsed markdown.
                var invalidatedIDs = Set(contentChangedIDs)
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
            // Self-sizing cells can grow before the next layout restores the
            // bottom offset. Keep following until an actual drag releases it.
            let shouldFollowBottom = isInitialLoad || (!turnFoldsChanged && (wasNearBottom
                || (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor == true))
            let prependAnchor = !shouldFollowBottom
                && (prependedMessages || turnFoldsChanged || (loadEarlierChanged && !canLoadEarlier))
                ? visibleAnchor(in: collectionView, dataSource: dataSource)
                : nil

            currentThreadID = threadID
            if let replacementMessagesByID = state.replacementMessagesByID {
                messagesByID = replacementMessagesByID
            }
            orderedIDs = newIDs
            (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor =
                shouldFollowBottom

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
                    guard self.currentThreadID == threadID else { return }
                    // A streaming delta lands every ~80 ms. Never fight a
                    // finger that is on the list.
                    let userIsScrolling = collectionView.isTracking
                        || collectionView.isDragging
                        || collectionView.isDecelerating
                    let stillFollowing = (collectionView as? BottomAnchoredTranscriptCollectionView)?
                        .maintainsBottomAnchor == true
                    if stillFollowing, !userIsScrolling {
                        self.scrollToBottom(
                            collectionView,
                            animated: !isInitialLoad && lastIDChanged
                        )
                    } else if !userIsScrolling, !stillFollowing, let prependAnchor {
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
            renderUpdate: FeatureDetailRenderUpdate?,
            verifyDisplayOrder: Bool
        ) -> MessageState? {
            guard let currentDetailRevision,
                  let renderUpdate,
                  renderUpdate.baseRevision == currentDetailRevision,
                  case let .delta(delta) = renderUpdate.change,
                  messages.count == orderedIDs.count + delta.appendedMessageIDs.count else {
                return nil
            }

            let appendedIDs = delta.appendedMessageIDs
            // Authoritative deltas refer to unfolded rows. Reuse them only when
            // their exact ID order also describes the displayed collection.
            if verifyDisplayOrder, messages.map(\.id) != orderedIDs + appendedIDs { return nil }
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

    func showsScrollToBottom(at offset: CGFloat) -> Bool {
        viewportHeight > 0 && bottomOffset - offset >= 120
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

/// Full-content back-swipe fallback for iOS 17 and 18. Newer iOS versions use
/// system navigation. SwiftUI's `DragGesture` can begin before it knows
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
final class BottomAnchoredTranscriptCollectionView: UICollectionView {
    var maintainsBottomAnchor = false

    private var lastLaidOutGeometry: TranscriptViewportGeometry?
    private var isRestoringBottomAnchor = false
    private var needsInitialBottomPosition = true
    private let bottomButton = UIButton(type: .system)

    override init(frame: CGRect, collectionViewLayout layout: UICollectionViewLayout) {
        super.init(frame: frame, collectionViewLayout: layout)
        var configuration = UIButton.Configuration.filled()
        configuration.image = UIImage(systemName: "arrow.down")
        configuration.preferredSymbolConfigurationForImage = .init(pointSize: 17, weight: .semibold)
        configuration.baseForegroundColor = T3Colors.uiTextPrimary
        configuration.baseBackgroundColor = T3Colors.uiSurfaceRaised
        configuration.cornerStyle = .capsule
        bottomButton.configuration = configuration
        bottomButton.accessibilityLabel = "Scroll to bottom"
        bottomButton.accessibilityIdentifier = "thread-scroll-to-bottom"
        bottomButton.isHidden = true
        bottomButton.addTarget(self, action: #selector(jumpToBottom), for: .touchUpInside)
        addSubview(bottomButton)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            needsInitialBottomPosition = true
            maintainsBottomAnchor = true
            setNeedsLayout()
        }
    }

    @objc private func jumpToBottom() {
        layoutIfNeeded()
        maintainsBottomAnchor = true
        let geometry = viewportGeometry
        // Jump directly in long threads instead of rendering every intervening
        // message. Keep keyboard focus and follow subsequent streamed output.
        setContentOffset(CGPoint(x: contentOffset.x, y: geometry.bottomOffset), animated: false)
        updateBottomButton(geometry)
    }

    private var viewportGeometry: TranscriptViewportGeometry {
        TranscriptViewportGeometry(
            contentHeight: contentSize.height,
            viewportHeight: bounds.height,
            topInset: adjustedContentInset.top,
            bottomInset: adjustedContentInset.bottom
        )
    }

    private func updateBottomButton(_ geometry: TranscriptViewportGeometry) {
        bottomButton.isHidden = needsInitialBottomPosition || bounds.height < 64
            || !geometry.showsScrollToBottom(at: contentOffset.y)
        bottomButton.frame = CGRect(
            x: bounds.midX - 22, y: bounds.maxY - adjustedContentInset.bottom - 54,
            width: 44, height: 44
        )
        bringSubviewToFront(bottomButton)
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let geometry = viewportGeometry
        defer {
            lastLaidOutGeometry = geometry
            updateBottomButton(geometry)
        }

        let isInteracting = isTracking || isDragging || isDecelerating || isRestoringBottomAnchor
        if needsInitialBottomPosition, isInteracting {
            needsInitialBottomPosition = false
        }
        if needsInitialBottomPosition, window != nil, bounds.height > 0, contentSize.height > 0 {
            needsInitialBottomPosition = false
            maintainsBottomAnchor = true
            isRestoringBottomAnchor = true
            contentOffset = CGPoint(x: contentOffset.x, y: geometry.bottomOffset)
            isRestoringBottomAnchor = false
            return
        }

        guard let bottomY = geometry.restoredBottomOffset(
            after: lastLaidOutGeometry,
            maintainsBottomAnchor: maintainsBottomAnchor,
            isInteracting: isInteracting
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
    var attachmentContext: FeatureAttachmentContext? = nil
    var skills: [FeatureProviderSkill] = []
    var v2Inspection: FeatureV2ItemInspectionContext? = nil
    var secretContext: FeatureSecretRequestContext? = nil
    var embeddedContext: FeatureEmbeddedContentContext? = nil
    var environmentID: String? = nil
    var agents: [FeatureThreadAgent] = []
    var onOpenThread: ((String) -> Void)? = nil
    @SwiftUI.Environment(\.openURL) private var openURL
    @SwiftUI.Environment(\.featureThreadPresentationDismissal) private var presentationDismissal
    @State private var presentationID = UUID()
    @State private var previewedContext: ComposerContextRecord?
    @State private var contextAttachmentPresented = false
    @State private var contextUnavailable = false

    var body: some View {
        messageBody
            .environment(\.openURL, OpenURLAction { url in
                guard let reference = ComposerContextReferences.parseHref(url.absoluteString) else {
                    openURL(url)
                    return .handled
                }
                guard let record = message.context?.records.first(where: { $0.contextId == reference.contextId }) else {
                    contextUnavailable = true
                    return .handled
                }
                if case let .mention(value) = record.payload, let path = FeatureComposerFileLinkSerializer.url(for: value.path) {
                    openURL(path)
                } else {
                    previewedContext = record
                }
                return .handled
            })
            .onChange(of: previewedContext != nil) { _, presented in
                if presented { presentationDismissal.onPresentationChange(presentationID, true) }
            }
            .onChange(of: presentationDismissal.requestID) { _, id in
                if id != nil {
                    if !contextAttachmentPresented { previewedContext = nil }
                    contextUnavailable = false
                }
            }
            .sheet(item: $previewedContext, onDismiss: {
                presentationDismissal.onPresentationChange(presentationID, false)
            }) { record in
                NavigationStack {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if let binding = record.attachment,
                               let attachment = message.attachments.first(where: { $0.id == binding.attachmentId }) {
                                FeatureMessageAttachmentsView(attachments: [attachment], context: attachmentContext)
                                    .environment(\.featureThreadPresentationDismissal,
                                        FeatureThreadPresentationDismissal(requestID: presentationDismissal.requestID) { id, presented in
                                            contextAttachmentPresented = presented
                                            presentationDismissal.onPresentationChange(id, presented)
                                            if !presented, presentationDismissal.requestID != nil {
                                                previewedContext = nil
                                            }
                                        })
                            } else {
                                Text(ComposerContextReferences.providerPayload(record))
                                    .font(T3Typography.tool)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if case let .reviewComment(value) = record.payload,
                               let request = value.pullRequest,
                               let url = URL(string: request.url), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                                Link("Open pull request #\(request.number)", destination: url)
                            }
                        }
                        .padding()
                    }
                    .background(T3Colors.background)
                    .navigationTitle(record.label)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { previewedContext = nil }
                        }
                    }
                    .t3NavigationChrome()
                }
                .preferredColorScheme(.dark)
            }
            .alert("Context unavailable", isPresented: $contextUnavailable) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("This message has a context link without its saved record.")
            }
    }

    private var renderedText: String {
        // Images use the existing attachment preview. Do not ask Markdown to fetch t3-context URLs.
        ComposerContextReferences.replace(message.text) {
            "[\($0.label)](t3-context://v1/\($0.kind)/\($0.contextId))"
        }
    }

    private var clipboardSource: ComposerContextClipboardFragment.Source? {
        attachmentContext?.environmentID.map {
            .init(environmentId: $0, threadId: message.v2Timeline?.sourceThreadID ?? attachmentContext?.wireThreadID,
                  messageId: message.v2Timeline?.messageID ?? message.id)
        }
    }

    private var transcriptAgent: FeatureThreadAgent? {
        guard let environmentID, let items = message.v2WorkItems,
              items.count == 1, let item = items.first else { return nil }
        return item.threadAgent(environmentID: environmentID, agents: agents)
    }

    @ViewBuilder private var messageBody: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 44)
                VStack(alignment: .leading, spacing: 10) {
                    if let source = message.v2Timeline, FeatureV2MessageAttribution.hasContent(source) {
                        FeatureV2MessageAttribution(source: source, onOpenThread: v2Inspection?.onOpenThread)
                    }
                    FeatureMessageAttachmentsView(attachments: message.attachments, context: attachmentContext)
                    if !message.text.isEmpty {
                        MarkdownMessageView(
                            renderedText,
                            isStreaming: message.state == .streaming,
                            imageContext: imageContext,
                            skills: skills,
                            clipboardSource: clipboardSource,
                            messageContext: message.context,
                            copyText: message.text
                        )
                    }
                    if message.v2Timeline != nil {
                        Text(message.createdAt, format: .dateTime.hour().minute())
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                    if message.state == .queued {
                        Label("Queued. Sends when connected.", systemImage: "clock")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                    } else if message.state == .failed {
                        Label("Not sent", systemImage: "exclamationmark.circle")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.danger)
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
                FeatureMessageAttachmentsView(attachments: message.attachments, context: attachmentContext)
                if !message.text.isEmpty {
                    MarkdownMessageView(
                        renderedText,
                        isStreaming: message.state == .streaming,
                        imageContext: imageContext,
                        skills: skills,
                        clipboardSource: clipboardSource,
                        messageContext: message.context,
                        copyText: message.text
                    )
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("message-\(message.id)")
            if let source = message.v2Timeline, source.itemType == "assistant_message",
               message.state != .streaming, source.status == "completed" {
                Text(NativeTimestampParser.parse(source.updatedAt) ?? message.createdAt, format: .dateTime.hour().minute())
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
        case .tool:
            if let items = message.v2WorkItems, items.count == 1, let item = items.first,
               item.source.itemType == "secret_request" {
                FeatureSecretRequestCard(item: item, context: secretContext).id(item.id)
            } else if let items = message.v2WorkItems, items.count == 1, let item = items.first,
                      item.hasEmbeddedContent, let embeddedContext {
                FeatureEmbeddedContentView(item: item, context: embeddedContext).id(item.id)
            } else if let agent = transcriptAgent, let onOpenThread {
                FeatureThreadAgentRow(agent: agent, onOpenThread: onOpenThread)
                if let item = message.v2WorkItems?.first, let v2Inspection {
                    FeatureV2ItemInspector(item: item, context: v2Inspection,
                        imageContext: imageContext, attachmentContext: attachmentContext, title: "Details")
                        .id(message.id)
                } else {
                    FeatureWorkLogView(message: message, imageContext: imageContext)
                        .id(message.id)
                }
            } else if message.v2WorkItems != nil, let v2Inspection {
                FeatureV2WorkLogView(message: message, context: v2Inspection,
                    imageContext: imageContext, attachmentContext: attachmentContext)
                    .id(message.id)
            } else {
                FeatureWorkLogView(message: message, imageContext: imageContext)
                    .id(message.id)
            }
        case .system:
            if let foldID = message.v2FoldID, let v2Inspection {
                FeatureV2TurnFoldButton(id: foldID, label: message.text, state: v2Inspection.state)
            } else {
                systemMessage
                    .accessibilityIdentifier("message-\(message.id)")
            }
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
                    .t3CodeTextSize()
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

struct FeatureMessageAttachmentsView: View {
    let attachments: [FeatureMessageAttachment]
    let context: FeatureAttachmentContext?
    @SwiftUI.Environment(\.featureThreadPresentationDismissal) private var presentationDismissal
    @State private var presentationID = UUID()
    @State private var previewedAttachment: FeatureMessageAttachment?

    var body: some View {
        if !attachments.isEmpty {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 118, maximum: 190), spacing: 7)],
                alignment: .leading,
                spacing: 7
            ) {
                ForEach(attachments) { attachment in
                    FeatureMessageAttachmentView(attachment: attachment, context: context) {
                        previewedAttachment = $0
                    }
                    .id("\(context?.threadID ?? ""):attachment:\(attachment.id)")
                }
            }
            .onChange(of: previewedAttachment != nil) { _, presented in
                if presented { presentationDismissal.onPresentationChange(presentationID, true) }
            }
            .onChange(of: presentationDismissal.requestID) { _, id in
                if id != nil { previewedAttachment = nil }
            }
            .fullScreenCover(item: $previewedAttachment, onDismiss: {
                presentationDismissal.onPresentationChange(presentationID, false)
            }) { attachment in
                FeatureAttachmentPreview(attachment: attachment, context: context)
            }
        }
    }
}

private struct FeatureMessageAttachmentView: View {
    let attachment: FeatureMessageAttachment
    let context: FeatureAttachmentContext?
    let onPreview: (FeatureMessageAttachment) -> Void
    @State private var resolvedURL: URL?
    @State private var failed = false
    @State private var isOpening = false

    private var isImage: Bool { attachment.mimeType.hasPrefix("image/") }
    private var currentURL: URL? { resolvedURL ?? attachment.url }
    private var hasLocalPreview: Bool { isImage && attachment.previewData != nil }
    private var showsStatus: Bool { failed || isOpening || (currentURL == nil && !hasLocalPreview) }
    private var statusText: String { failed ? "Couldn’t load. Tap to retry." : "Loading attachment…" }
    private var canPreview: Bool { hasLocalPreview || currentURL != nil || context != nil }
    private var sizeText: String {
        ByteCountFormatter.string(fromByteCount: Int64(attachment.sizeBytes), countStyle: .file)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if isImage { thumbnail }
            HStack(spacing: 9) {
                Image(systemName: isImage ? "photo" : "doc")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(width: 30, height: 30)
                    .background(T3Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
                VStack(alignment: .leading, spacing: 1) {
                    Text(attachment.name)
                        .font(T3Typography.control)
                        .lineLimit(1)
                    Text(showsStatus ? statusText : sizeText)
                        .font(T3Typography.supporting.monospacedDigit())
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(7)
        .overlay {
            RoundedRectangle(cornerRadius: 8).stroke(T3Colors.border, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isImage ? "Image attachment" : "File attachment")
        .accessibilityValue("\(attachment.name), \(showsStatus ? statusText : sizeText)")
        .accessibilityIdentifier("attachment-\(attachment.id)")
        .accessibilityAddTraits(canPreview ? .isButton : [])
        .accessibilityHint(canPreview ? "Opens full-screen preview" : "")
        .accessibilityAction { openPreview() }
        .contentShape(Rectangle())
        .onTapGesture { openPreview() }
        .task { await resolveURL() }
        .task(id: isOpening) {
            guard isOpening else { return }
            defer { isOpening = false }
            // A row can stay mounted beyond a signed URL's expiry.
            await resolveURL()
            guard !Task.isCancelled, !failed, let currentURL else { return }
            var preview = attachment
            preview.url = currentURL
            onPreview(preview)
        }
    }

    private var thumbnail: some View {
        Group {
            if let previewData = attachment.previewData {
                FeatureLocalAttachmentThumbnail(attachmentID: attachment.id, previewData: previewData)
            } else if let currentURL {
                FeatureRemoteAttachmentThumbnail(url: currentURL)
            } else {
                Image(systemName: failed ? "exclamationmark.triangle" : "photo")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(height: 160)
        .frame(maxWidth: .infinity)
        .background(T3Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func openPreview() {
        if hasLocalPreview {
            onPreview(attachment)
        } else if canPreview {
            isOpening = true
        }
    }

    private func resolveURL() async {
        guard let context else {
            failed = currentURL == nil && !hasLocalPreview
            return
        }
        failed = false
        do {
            let url = try await context.resolver.attachmentAssetURL(
                threadID: context.threadID, attachment: attachment
            )
            try Task.checkCancellation()
            resolvedURL = url
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
        }
    }
}

private struct FeatureAttachmentPreview: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let attachment: FeatureMessageAttachment
    let context: FeatureAttachmentContext?

    private var resolveURL: (@MainActor () async throws -> URL)? {
        guard attachment.previewData == nil, let context else { return nil }
        return { try await context.resolver.attachmentAssetURL(threadID: context.threadID, attachment: attachment) }
    }

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
                fileName: attachment.name,
                mimeType: attachment.mimeType,
                resolveURL: resolveURL
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
        case .image, .pdf, .video, .audio, .browser, .document: kind
        case .markdown, .source, .plainText: nil
        }
    }

    static func previewKind(fileName: String, mimeType: String) -> FeatureFilePreviewKind {
        switch FeatureAttachmentContentKind.infer(name: fileName, mimeType: mimeType) {
        case .image: return .image
        case .video: return .video
        case .audio: return .audio
        case .pdf: return .pdf
        case .html: return .browser
        case .markdown: return .markdown
        case .text: return .plainText
        case .native: return .document
        }
    }
}
