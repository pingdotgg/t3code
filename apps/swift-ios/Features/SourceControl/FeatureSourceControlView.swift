import SwiftUI

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

    @State private var status: FeatureSourceControlStatus?
    @State private var isLoading = true
    @State private var isRunningAction = false
    @State private var runState = FeatureToolRunState<FeatureSourceControlOperation>()
    @State private var recovery = FeatureToolFailureState<FeatureSourceControlOperation>()
    @State private var errorMessage: String?
    @State private var loadGeneration = 0
    @State private var statusGeneration = 0
    @State private var commitMessage = ""
    @State private var pendingCommitAction: FeatureSourceControlAction?
    @AccessibilityFocusState private var recoveryFocus: FeatureToolRecoveryFocus?

    public init(client: any FeatureClient, threadID: String) {
        self.client = client
        self.threadID = threadID
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
        .alert("Commit changes", isPresented: Binding(
            get: { pendingCommitAction != nil },
            set: { if !$0 { pendingCommitAction = nil } }
        )) {
            TextField("Commit message", text: $commitMessage)
            Button("Cancel", role: .cancel) { pendingCommitAction = nil }
            Button("Commit") {
                if let action = pendingCommitAction {
                    Task { await perform(action, message: commitMessage) }
                }
                pendingCommitAction = nil
            }
            .disabled(
                commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || runState.isBusy
            )
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
        .task { await load() }
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
                .disabled(failure.isRetrying || runState.isBusy)
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
                    .disabled(runState.isBusy)
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

    private func begin(_ action: FeatureSourceControlAction) {
        if action.requiresMessage {
            commitMessage = ""
            pendingCommitAction = action
        } else {
            Task { await perform(action, message: nil) }
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
            if FeatureToolFailureState<FeatureSourceControlOperation>.isCancellation(error) {
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
            for await recoveredStatus in client.sourceControlStatusEvents(threadID: threadID) {
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

    private func perform(_ action: FeatureSourceControlAction, message: String?) async {
        await run(
            .action(action, message: message?.trimmingCharacters(in: .whitespacesAndNewlines))
        )
    }

    /// Mutations finish before refresh so Retry cannot repeat completed work.
    private func run(_ operation: FeatureSourceControlOperation) async {
        guard case let .action(action, message) = operation else {
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
            try await client.performSourceControlAction(
                threadID: threadID,
                action: action,
                message: message
            )
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
            recovery.recordFailure(operation, error: error)
            shouldRecoverStatus = !FeatureToolFailureState<FeatureSourceControlOperation>
                .isCancellation(error)
        }
        runState.finish(operation)
        if shouldRecoverStatus {
            await load(force: false)
        }
    }
}

private extension FeatureSourceControlAction {
    var requiresMessage: Bool {
        switch self {
        case .commit, .commitAndPush, .commitPushAndCreatePullRequest: true
        case .push, .pull, .createPullRequest: false
        }
    }

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
