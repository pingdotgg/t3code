import SwiftUI

enum FeatureSourceControlDestinationPolicy {
    /// Commit needs local changes, even when the remote status never arrives.
    static func shouldOpenCommit(
        destination: FeatureThreadDestination?,
        handledDestination: FeatureThreadDestination?,
        status: FeatureSourceControlStatus?
    ) -> Bool {
        destination == .gitCommit && handledDestination != .gitCommit
            && status?.availableActions.contains(.commit) == true
    }
}

@MainActor
func runFeatureSourceControlAction<Value>(
    setRunning: (Bool) -> Void,
    operation: () async throws -> Value
) async -> Result<Value, Error> {
    setRunning(true)
    defer { setRunning(false) }

    do {
        return .success(try await operation())
    } catch {
        return .failure(error)
    }
}

public struct FeatureSourceControlView: View {
    let client: any FeatureClient
    let threadID: String
    let initialDestination: FeatureThreadDestination?

    @State private var status: FeatureSourceControlStatus?
    @State private var isLoading = true
    @State private var isRunningAction = false
    @State private var runState = FeatureToolRunState<FeatureGitOperation>()
    @State private var recovery = FeatureToolFailureState<FeatureGitOperation>()
    @State private var errorMessage: String?
    @State private var loadGeneration = 0
    @State private var statusGeneration = 0
    @State private var commitSubmission: FeatureSourceControlRequest?
    @State private var branchChoice: FeatureSourceControlRequest?
    @State private var branchChoiceName: String?
    @State private var showsBranches = false
    @State private var handledDestination: FeatureThreadDestination?
    @State private var pendingCommitAction: FeatureSourceControlAction?
    @AccessibilityFocusState private var recoveryFocus: FeatureToolRecoveryFocus?

    public init(client: any FeatureClient, threadID: String, initialDestination: FeatureThreadDestination? = nil) {
        self.client = client
        self.threadID = threadID
        self.initialDestination = initialDestination
    }

    private var canWrite: Bool {
        client.permissions(forThreadID: threadID)?.grants("source-control:write") == true
    }

    private var canChangeWorkspace: Bool {
        canWrite && client.permissions(forThreadID: threadID)?.grants("orchestration:operate") == true
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let failure = recovery.failure {
                failureBanner(failure)
            }
            Group {
                if isLoading, status == nil {
                    ProgressView("Loading repository…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let status, status.isRepository {
                    statusList(status)
                } else {
                    ContentUnavailableView(
                        "Source control unavailable",
                        systemImage: "arrow.triangle.branch",
                        description: Text(
                            status?.isRepository == false
                                ? "This workspace is not a Git repository."
                                : "Repository status could not be loaded."
                        )
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(T3Colors.background)
        .navigationTitle("Source Control")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await reload() } } label: {
                    if isLoading {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(runState.isBusy)
                .accessibilityLabel("Reload source control")
            }
        }
        .sheet(isPresented: Binding(
            get: { pendingCommitAction != nil },
            set: { if !$0 { pendingCommitAction = nil } }
        ), onDismiss: {
            if let request = commitSubmission {
                commitSubmission = nil
                begin(request)
            }
        }) {
            if let action = pendingCommitAction, let status {
                FeatureGitCommitView(status: status, action: action, canCreateBranch: canChangeWorkspace) { request in
                    commitSubmission = request
                    pendingCommitAction = nil
                }
            }
        }
        .confirmationDialog("Continue on \(branchChoiceName ?? status?.branch ?? "the default branch")?", isPresented: Binding(
            get: { branchChoice != nil },
            set: { if !$0 { branchChoice = nil } }
        ), titleVisibility: .visible) {
            if let request = branchChoice {
                Button("Continue on this branch") {
                    var next = request
                    next.allowDefaultBranch = true
                    branchChoice = nil
                    Task { await run(.action(next)) }
                }
                Button("Create a feature branch and continue") {
                    var next = request
                    next.featureBranch = true
                    branchChoice = nil
                    Task { await run(.action(next)) }
                }
                .disabled(!canChangeWorkspace)
                Button("Cancel", role: .cancel) { branchChoice = nil }
            }
        }
        .navigationDestination(isPresented: $showsBranches) {
            FeatureGitBranchesView(client: client, threadID: threadID)
        }
        .onChange(of: showsBranches) { _, visible in
            if !visible { Task { await reload() } }
        }
        .onChange(of: recovery.failure?.id) { _, failureID in
            guard failureID != nil else { return }
            recoveryFocus = .failure
        }
        .onChange(of: recovery.recoveryAnnouncement) { _, _ in
            guard let announcement = recovery.takeRecoveryAnnouncement() else { return }
            recoveryFocus = .recoveredContent
            AccessibilityNotification.Announcement(announcement).post()
        }
        .onChange(of: status) { _, _ in
            openCommitDestinationIfNeeded()
        }
        .task(id: initialDestination) {
            let shouldOpen = initialDestination != handledDestination
            if shouldOpen, initialDestination == .gitBranches {
                handledDestination = initialDestination
                showsBranches = true
            }
            openCommitDestinationIfNeeded()
            await load()
        }
    }

    /// Keeps the failed output on screen — including while its retry runs — with a labelled
    /// Retry control immediately after it in the accessibility order.
    private func failureBanner(_ failure: FeatureToolFailure) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                Label(failure.title, systemImage: "exclamationmark.triangle.fill")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.danger)
                ScrollView {
                    Text(failure.message)
                        .font(T3Typography.tool)
                        .foregroundStyle(T3Colors.textSecondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: T3Metrics.maximumToolFailureMessageHeight)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(failure.accessibilityLabel)
            .accessibilityIdentifier("source-control-failure")
            .accessibilityFocused($recoveryFocus, equals: .failure)

            HStack(spacing: 10) {
                Button {
                    guard let operation = recovery.retryOperation else { return }
                    Task { await run(operation) }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                        .font(T3Typography.control)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                }
                .buttonStyle(.borderedProminent)
                .disabled(failure.isRetrying || runState.isBusy
                    || recovery.retryOperation.map { !canRun($0) } == true)
                .accessibilityLabel(failure.retryAccessibilityLabel)
                .accessibilityIdentifier("source-control-failure-retry")

                if failure.isRetrying {
                    ProgressView()
                    Text("Retrying…")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T3Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(T3Colors.danger.opacity(0.4), lineWidth: 1)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }

    private func statusList(_ status: FeatureSourceControlStatus) -> some View {
        List {
            // Once a status is on screen the unavailable-state view is
            // unreachable, so a later failure needs its own inline surface.
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(T3Typography.supporting)
                        .foregroundStyle(.orange)
                }
            }

            Section("Repository") {
                LabeledContent("Branch", value: status.branch ?? "Detached HEAD")
                    .accessibilityFocused($recoveryFocus, equals: .recoveredContent)
                if let upstream = status.upstream {
                    LabeledContent("Upstream", value: upstream)
                }
                if status.isRemoteKnown {
                    HStack {
                        Label("\(status.aheadCount) ahead", systemImage: "arrow.up")
                        Spacer()
                        Label("\(status.behindCount) behind", systemImage: "arrow.down")
                    }
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                } else {
                    // Only claim to be checking while something actually is.
                    Label(
                        isLoading ? "Checking remote…" : "Remote status unavailable",
                        systemImage: isLoading
                            ? "arrow.triangle.2.circlepath"
                            : "exclamationmark.triangle"
                    )
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                }
                if let pullRequest = status.pullRequest {
                    if let url = pullRequest.url {
                        Link(destination: url) {
                            Label("PR #\(pullRequest.number) · \(pullRequest.title)", systemImage: "arrow.up.right.square")
                        }
                    } else {
                        LabeledContent("Pull Request", value: "#\(pullRequest.number) · \(pullRequest.state)")
                    }
                }
            }

            Section("Actions") {
                Button {
                    showsBranches = true
                } label: {
                    Label("Branches and worktrees", systemImage: "arrow.triangle.branch")
                }
                .disabled(runState.isBusy)

                if status.availableActions.isEmpty {
                    Text(status.isBusy ? "Source control operation in progress" : "No actions available")
                        .foregroundStyle(T3Colors.textSecondary)
                }
                ForEach(status.availableActions, id: \.self) { action in
                    Button {
                        begin(action)
                    } label: {
                        Label(action.title, systemImage: action.icon)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .disabled(runState.isBusy || !canWrite)
                }
                if !canWrite {
                    Text("This connection has read-only source control.")
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }

            Section("\(status.files.count) changed \(status.files.count == 1 ? "file" : "files")") {
                if status.files.isEmpty {
                    Label("Working tree clean", systemImage: "checkmark.circle")
                        .foregroundStyle(T3Colors.textSecondary)
                }
                ForEach(status.files) { file in
                    HStack(spacing: 10) {
                        Text(file.state.shortLabel)
                            .font(.caption2.monospaced().weight(.bold))
                            .foregroundStyle(file.state.color)
                            .frame(width: 18)
                        Text(file.path)
                            .font(T3Typography.threadBody)
                            .lineLimit(1)
                        Spacer()
                        if file.isStaged {
                            Text("STAGED")
                                .font(T3Typography.eyebrow)
                                .foregroundStyle(.green)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await reload() }
        .overlay {
            if isRunningAction {
                ProgressView()
                    .padding(12)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    private func openCommitDestinationIfNeeded() {
        guard FeatureSourceControlDestinationPolicy.shouldOpenCommit(
            destination: initialDestination,
            handledDestination: handledDestination,
            status: status
        ) else { return }
        handledDestination = .gitCommit
        begin(.commit)
    }

    private func begin(_ action: FeatureSourceControlAction) {
        guard canWrite else { return }
        if action.includesCommit {
            pendingCommitAction = action
        } else {
            begin(FeatureSourceControlRequest(action: action))
        }
    }

    private func begin(_ request: FeatureSourceControlRequest) {
        if let status, request.requiresBranchChoice(status) {
            branchChoiceName = status.branch
            branchChoice = request
        } else {
            Task { await run(.action(request)) }
        }
    }

    private func canRun(_ operation: FeatureGitOperation) -> Bool {
        switch operation {
        case .load: true
        case let .action(request): canWrite && (!request.featureBranch || canChangeWorkspace)
        case let .syncWorkspace(_, pending):
            client.permissions(forThreadID: threadID)?.grants("orchestration:operate") == true
                && (pending == nil || canWrite)
        }
    }

    /// Cached loading can be replaced by an action or an explicit refresh.
    private func load() async {
        await load(force: false)
    }

    private func reload() async {
        await load(force: true)
    }

    private func load(force: Bool) async {
        guard !runState.isBusy else { return }
        if force, !runState.begin(.load) { return }
        loadGeneration += 1
        statusGeneration += 1
        let loadID = loadGeneration
        let statusID = statusGeneration
        isLoading = true
        recovery.begin(.load)
        defer {
            if loadID == loadGeneration { isLoading = false }
            if force { runState.finish(.load) }
        }
        do {
            try Task.checkCancellation()
            if force {
                let refreshed = try await client.sourceControlStatus(threadID: threadID)
                guard statusID == statusGeneration else { return }
                status = refreshed
                errorMessage = nil
                recovery.recordSuccess(.load)
            } else {
                let statuses = try await client.sourceControlStatuses(threadID: threadID)
                for try await nextStatus in statuses {
                    guard statusID == statusGeneration else { return }
                    status = nextStatus
                    errorMessage = nil
                    if nextStatus.isRemoteKnown { recovery.recordSuccess(.load) }
                }
            }
        } catch {
            guard statusID == statusGeneration else { return }
            if FeatureToolFailureState<FeatureGitOperation>.isCancellation(error) {
                recovery.recordFailure(.load, error: error)
                return
            }
            // An unrelated status failure must not discard a failed action's retry.
            if let retained = recovery.retryOperation, !retained.isLoad {
                errorMessage = error.localizedDescription
            } else {
                recovery.recordFailure(.load, error: error)
            }
            guard !force, status?.isRemoteKnown == false else { return }
            if loadID == loadGeneration { isLoading = false }
            for await recoveredStatus in client.sourceControlStatusEvents(threadID: threadID, intent: .active) {
                guard statusID == statusGeneration else { return }
                status = recoveredStatus
                if recoveredStatus.isRemoteKnown {
                    errorMessage = nil
                    recovery.recordSuccess(.load)
                    return
                }
            }
        }
    }

    /// Mutations finish before refresh so Retry cannot repeat completed work.
    private func run(_ operation: FeatureGitOperation) async {
        guard !operation.isLoad else {
            await reload()
            return
        }
        guard runState.begin(operation) else { return }
        loadGeneration += 1
        statusGeneration += 1
        isLoading = false
        recovery.begin(operation)
        let result = await runFeatureSourceControlAction(
            setRunning: { isRunningAction = $0 }
        ) {
            switch operation {
            case .load: break
            case .action(let request):
                try await client.performSourceControlAction(threadID: threadID, request: request)
            case .syncWorkspace(let workspace, let pending):
                try await client.syncSourceControlWorkspace(threadID: threadID, workspace: workspace)
                if let pending { try await client.performSourceControlAction(threadID: threadID, request: pending) }
            }
        }
        var shouldRecoverStatus = false
        switch result {
        case .success:
            do {
                status = try await client.sourceControlStatus(threadID: threadID)
                errorMessage = nil
                recovery.recordSuccess(operation, .load)
            } catch {
                recovery.recordFollowUpFailure(
                    .load,
                    afterCompletionOf: operation,
                    error: error
                )
            }
        case let .failure(error):
            if let syncError = error as? FeatureSourceControlWorkspaceSyncError {
                recovery.recordFollowUpFailure(.syncWorkspace(syncError.workspace, then: syncError.pendingRequest), afterCompletionOf: operation, error: error)
                // Git succeeded. Keep its actual state visible while metadata can be retried.
                do { status = try await client.sourceControlStatus(threadID: threadID) }
                catch { errorMessage = error.localizedDescription }
            } else if let retry = error as? FeatureSourceControlActionRetryError {
                recovery.recordFollowUpFailure(.action(retry.request), afterCompletionOf: operation, error: error)
            } else if let choice = error as? FeatureSourceControlBranchChoiceRequired,
                      let request = operation.request {
                recovery.recordSuccess(operation)
                branchChoiceName = choice.branch
                branchChoice = request
            } else {
                recovery.recordFailure(operation, error: error)
                shouldRecoverStatus = !FeatureToolFailureState<FeatureGitOperation>.isCancellation(error)
            }
        }
        runState.finish(operation)
        if shouldRecoverStatus {
            await load(force: false)
        }
    }
}

private extension FeatureSourceControlAction {
    var icon: String {
        switch self {
        case .commit: "checkmark.circle"
        case .push: "arrow.up.circle"
        case .pull: "arrow.down.circle"
        case .createPullRequest: "arrow.triangle.pull"
        case .commitAndPush: "arrow.up.circle.fill"
        case .commitPushAndCreatePullRequest: "point.3.connected.trianglepath.dotted"
        }
    }
}

private extension FeatureSourceControlFileState {
    var shortLabel: String {
        switch self {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case .untracked: "?"
        case .conflicted: "!"
        }
    }

    var color: Color {
        switch self {
        case .added: .green
        case .modified: .orange
        case .deleted, .conflicted: .red
        case .renamed: .blue
        case .untracked: .secondary
        }
    }
}
