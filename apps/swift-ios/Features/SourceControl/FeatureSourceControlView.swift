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
        .task { await load() }
    }

    private func statusList(_ status: FeatureSourceControlStatus) -> some View {
        List {
            Section("Repository") {
                LabeledContent("Branch", value: status.branch ?? "Detached HEAD")
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
        isLoading = true
        defer { isLoading = false }
        do {
            status = try await client.sourceControlStatus(threadID: threadID)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func perform(_ action: FeatureSourceControlAction, message: String?) async {
        isRunningAction = true
        defer { isRunningAction = false }
        do {
            status = try await client.performSourceControlAction(
                threadID: threadID,
                action: action,
                message: message?.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            errorMessage = nil
        } catch {
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
