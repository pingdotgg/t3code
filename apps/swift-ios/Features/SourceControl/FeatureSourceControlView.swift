import SwiftUI

public struct FeatureSourceControlView: View {
    let client: any FeatureClient
    let threadID: String

    @State private var status: FeatureSourceControlStatus?
    @State private var isLoading = true
    @State private var isRunningAction = false
    @State private var recovery = FeatureToolFailureState<FeatureSourceControlOperation>()
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
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(isLoading || isRunningAction)
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
            .disabled(commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
                Text(failure.message)
                    .font(T3Typography.tool)
                    .foregroundStyle(T3Colors.textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
                .disabled(failure.isRetrying)
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
            Section("Repository") {
                LabeledContent("Branch", value: status.branch ?? "Detached HEAD")
                    .accessibilityFocused($recoveryFocus, equals: .recoveredContent)
                if let upstream = status.upstream {
                    LabeledContent("Upstream", value: upstream)
                }
                HStack {
                    Label("\(status.aheadCount) ahead", systemImage: "arrow.up")
                    Spacer()
                    Label("\(status.behindCount) behind", systemImage: "arrow.down")
                }
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
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
                    .disabled(isRunningAction)
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
        .refreshable { await load() }
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

    private func load() async {
        await run(.load)
    }

    private func perform(_ action: FeatureSourceControlAction, message: String?) async {
        await run(
            .action(action, message: message?.trimmingCharacters(in: .whitespacesAndNewlines))
        )
    }

    /// Single entry point for every source control request, so a retry replays the exact failed
    /// operation — commit message included — instead of falling back to a plain reload.
    private func run(_ operation: FeatureSourceControlOperation) async {
        recovery.begin(operation)
        if operation.isLoad {
            isLoading = true
        } else {
            isRunningAction = true
        }
        defer {
            if operation.isLoad {
                isLoading = false
            } else {
                isRunningAction = false
            }
        }
        do {
            switch operation {
            case .load:
                status = try await client.sourceControlStatus(threadID: threadID)
            case .action(let action, let message):
                status = try await client.performSourceControlAction(
                    threadID: threadID,
                    action: action,
                    message: message
                )
            }
            recovery.recordSuccess(operation)
        } catch {
            recovery.recordFailure(operation, error: error)
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
