import SwiftUI
import T3MobileProtocol

struct ShellView: View {
    @State private var viewModel = ShellViewModel.preview()
    private let timing = MobileProtocolTiming()
    private let launchConfiguration: MobileServerConfiguration?
    private let cacheService: MobileCacheService?
    private let initializationError: Error?
    private let onAuthenticatedBearerToken: (String, URL) async throws -> Void
    private let onConfigureConnection: () -> Void
    @State private var showsDiagnostics = false

    init(
        configuration: MobileServerConfiguration?,
        onAuthenticatedBearerToken: @escaping (String, URL) async throws -> Void = { _, _ in },
        onConfigureConnection: @escaping () -> Void = {}
    ) {
        launchConfiguration = configuration
        self.onAuthenticatedBearerToken = onAuthenticatedBearerToken
        self.onConfigureConnection = onConfigureConnection
        do {
            cacheService = try MobileCacheService(store: MobileCacheStore.appStore())
            initializationError = nil
        } catch {
            cacheService = nil
            initializationError = error
        }
    }

    var body: some View {
        @Bindable var viewModel = viewModel

        NavigationSplitView {
            EnvironmentSidebarView(
                environments: viewModel.environments,
                selectedEnvironmentID: $viewModel.selectedEnvironmentID
            )
        } content: {
            ProjectThreadListView(
                sections: viewModel.threadSections,
                selectedProjectID: $viewModel.selectedProjectID,
                selectedThreadID: $viewModel.selectedThreadID,
                projectIDForThreadID: viewModel.projectID(forThreadID:)
            )
        } detail: {
            if let thread = viewModel.selectedThread {
                ThreadDetailPlaceholderView(
                    state: ThreadDetailViewState(
                        thread: thread,
                        detail: viewModel.selectedThreadDetail,
                        connectionState: viewModel.threadDetailState,
                        serverConnectionState: viewModel.connectionState,
                        canSend: viewModel.canSendMessage,
                        isSending: viewModel.isSendingMessage,
                        canInterrupt: viewModel.canInterruptSelectedThread,
                        isInterrupting: viewModel.isInterrupting,
                        commandErrorMessage: viewModel.commandErrorMessage,
                        respondedRequestIDs: viewModel.respondedRequestIDs,
                        respondingRequestIDs: viewModel.respondingRequestIDs
                    ),
                    composerText: $viewModel.composerDraft,
                    actions: ThreadDetailActions(
                        send: {
                            Task { await viewModel.sendMessage() }
                        },
                        interrupt: {
                            Task { await viewModel.interruptSelectedThread() }
                        },
                        approve: { requestID, decision in
                            Task { await viewModel.respondToApproval(requestID: requestID, decision: decision) }
                        },
                        userInput: { requestID, answer in
                            Task { await viewModel.respondToUserInput(requestID: requestID, answer: answer) }
                        },
                        showDiff: { checkpoint in
                            Task { await viewModel.loadDiff(for: checkpoint) }
                        },
                        revertCheckpoint: { checkpoint in
                            Task { await viewModel.revertToCheckpoint(checkpoint) }
                        }
                    )
                )
            } else {
                ThreadEmptyStateView(connectionState: viewModel.connectionState)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Connection", systemImage: "iphone.and.arrow.forward") {
                    onConfigureConnection()
                }
                .accessibilityHint("Opens mobile pairing and server connection setup.")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Diagnostics", systemImage: "stethoscope") {
                    showsDiagnostics = true
                }
                .accessibilityHint("Opens connection state and recent sync events.")
            }
        }
        .safeAreaInset(edge: .bottom) {
            ConnectionStatusView(state: viewModel.connectionState)
        }
        .task {
            timing.mark(.firstShellRender)
            await viewModel.loadInitialSync(
                configuration: launchConfiguration,
                cacheService: cacheService,
                initializationError: initializationError,
                onAuthenticatedBearerToken: { token in
                    if let launchConfiguration {
                        try await onAuthenticatedBearerToken(token, launchConfiguration.baseURL)
                    }
                }
            )
        }
        .sheet(
            isPresented: Binding(
                get: { viewModel.selectedDiff != nil },
                set: { isPresented in
                    if !isPresented {
                        viewModel.clearSelectedDiff()
                    }
                }
            )
        ) {
            if let diff = viewModel.selectedDiff {
                MobileDiffSheetView(diff: diff)
            }
        }
        .sheet(isPresented: $showsDiagnostics) {
            MobileDiagnosticsView(snapshot: viewModel.diagnosticsSnapshot)
        }
    }
}

#Preview {
    ShellView(configuration: nil)
}
