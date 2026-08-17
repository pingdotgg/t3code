import SwiftUI

public struct FeatureSourceControlView: View {
    let client: any FeatureClient
    let threadID: String

    @State private var status: FeatureSourceControlStatus?
    @State private var isLoading = true
    @State private var isRunningAction = false
    @State private var errorMessage: String?
    @State private var commitMessage = ""
    @State private var pendingCommitAction: FeatureSourceControlAction?
    /// Owns the loading indicator; only a newer load supersedes it.
    @State private var loadGeneration = 0
    /// Invalidates status writes; a running action supersedes them too.
    @State private var statusGeneration = 0

    public init(client: any FeatureClient, threadID: String) {
        self.client = client
        self.threadID = threadID
    }

    public var body: some View {
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
                        errorMessage
                            ?? (status?.isRepository == false
                                ? "This workspace is not a Git repository."
                                : "Repository status could not be loaded.")
                    )
                )
            }
        }
        .background(T3Colors.background)
        .navigationTitle("Source Control")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await reload() } } label: {
                    // Never disabled on a populated screen, so the spinner is
                    // the only signal that a reload is under way.
                    if isLoading {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(isRunningAction)
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
        .task { await load() }
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

    /// Streams the cached status first so the screen fills immediately.
    private func load() async {
        await load(force: false)
    }

    /// Explicit refresh affordances bypass the server-side status cache: the
    /// streaming path is cache-first, so without this a reload would only
    /// replay what the server already had.
    private func reload() async {
        await load(force: true)
    }

    private func load(force: Bool) async {
        loadGeneration += 1
        statusGeneration += 1
        let loadID = loadGeneration
        let statusID = statusGeneration
        isLoading = true
        // Only a newer *load* takes over the indicator. An action supersedes
        // this load's writes without taking ownership of the indicator, so
        // this must still be the one to clear it — at the cost of a superseded
        // stream holding the toolbar spinner until its bound expires.
        defer { if loadID == loadGeneration { isLoading = false } }
        do {
            if force {
                let refreshed = try await client.sourceControlStatus(threadID: threadID)
                guard statusID == statusGeneration else { return }
                status = refreshed
                errorMessage = nil
            } else {
                let statuses = try await client.sourceControlStatuses(threadID: threadID)
                for try await nextStatus in statuses {
                    guard statusID == statusGeneration else { return }
                    status = nextStatus
                    errorMessage = nil
                }
            }
        } catch is CancellationError {
            return
        } catch {
            guard statusID == statusGeneration else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func perform(_ action: FeatureSourceControlAction, message: String?) async {
        // Supersede any open stream. Its accumulator still holds the local half
        // from before this action, so a late event would fold that stale half
        // into a status that overwrites this action's result — and a late
        // stream error would mask this action's failure message.
        statusGeneration += 1
        let statusID = statusGeneration
        isRunningAction = true
        defer { isRunningAction = false }
        do {
            let result = try await client.performSourceControlAction(
                threadID: threadID,
                action: action,
                message: message?.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            // Guarded like a load's: pull-to-refresh is not gated on a running
            // action, so a refresh started after this one must win.
            guard statusID == statusGeneration else { return }
            status = result
            errorMessage = nil
        } catch {
            guard statusID == statusGeneration else { return }
            errorMessage = error.localizedDescription
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

    var title: String {
        switch self {
        case .commit: "Commit changes"
        case .push: "Push"
        case .pull: "Pull latest"
        case .createPullRequest: "Create pull request"
        case .commitAndPush: "Commit and push"
        case .commitPushAndCreatePullRequest: "Commit, push, and create PR"
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
