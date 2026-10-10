import SwiftUI

public struct FeatureGitBranchesView: View {
    let client: any FeatureClient
    let threadID: String
    @State private var snapshot: FeatureSourceControlBranches?
    @State private var newBranch = ""
    @State private var baseBranch = ""
    @State private var worktreeBranch = ""
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var pendingWorkspace: FeatureSourceControlWorkspace?

    public init(client: any FeatureClient, threadID: String) {
        self.client = client
        self.threadID = threadID
    }

    private var canChangeWorkspace: Bool {
        let permissions = client.permissions(forThreadID: threadID)
        return permissions?.grants("source-control:write") == true
            && permissions?.grants("orchestration:operate") == true
    }

    public var body: some View {
        List {
            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(T3Colors.danger)
                    if let pendingWorkspace {
                        Button("Retry thread update") { Task { await sync(pendingWorkspace) } }
                            .disabled(busy || client.permissions(forThreadID: threadID)?.grants("orchestration:operate") != true)
                    } else {
                        Button("Reload branches") { Task { await load() } }.disabled(busy)
                    }
                }
            }
            if busy { ProgressView("Updating workspace…") }
            if let snapshot {
                Section("Workspace") {
                    LabeledContent("Branch", value: snapshot.workspace.branch ?? "Detached HEAD")
                    Text(snapshot.workingDirectory).font(T3Typography.tool).textSelection(.enabled)
                }
                Group {
                    if snapshot.workspace.worktreePath != nil {
                        Section {
                            Button("Use project directory") { Task { await change(.useProjectDirectory) } }
                        } footer: {
                            Text("Keep the worktree and continue this thread in the project directory.")
                        }
                    }
                    Section("New branch") {
                        TextField("Branch name", text: $newBranch)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Create and check out") {
                            Task { await change(.createBranch(newBranch)) }
                        }
                        .disabled(newBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    Section("New worktree") {
                        TextField("Base branch", text: $baseBranch)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("New branch name", text: $worktreeBranch)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Create worktree") {
                            Task { await change(.createWorktree(baseBranch: baseBranch, newBranch: worktreeBranch)) }
                        }
                        .disabled(baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || worktreeBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    Section("Existing branches") {
                        if snapshot.branches.isEmpty { Text("No local branches") }
                        ForEach(snapshot.branches) { branch in
                            Button {
                                Task { await change(.switchBranch(branch.name)) }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(branch.name)
                                        if branch.isCurrent { Image(systemName: "checkmark") }
                                    }
                                    if !snapshot.isAvailable(branch) {
                                        Text("Checked out in another worktree")
                                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                                    } else if branch.isDefault {
                                        Text("Default branch").font(T3Typography.supporting)
                                            .foregroundStyle(T3Colors.textSecondary)
                                    }
                                }
                            }
                            .disabled(branch.isCurrent || !snapshot.isAvailable(branch))
                        }
                    }
                }
                .disabled(busy || pendingWorkspace != nil || !canChangeWorkspace)
            }
        }
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Branches and worktrees")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await refresh()
    }

    private func refresh() async {
        do {
            let loaded = try await client.sourceControlBranches(threadID: threadID)
            snapshot = loaded
            if baseBranch.isEmpty { baseBranch = loaded.workspace.branch ?? loaded.branches.first(where: \.isDefault)?.name ?? "main" }
            if pendingWorkspace == nil { errorMessage = nil }
        } catch is CancellationError {} catch { errorMessage = error.localizedDescription }
    }

    private func change(_ action: FeatureSourceControlWorkspaceAction) async {
        guard !busy, pendingWorkspace == nil, canChangeWorkspace else { return }
        busy = true
        defer { busy = false }
        do {
            try await client.changeSourceControlWorkspace(threadID: threadID, action: action)
            newBranch = ""
            worktreeBranch = ""
            await refresh()
        } catch let error as FeatureSourceControlWorkspaceSyncError {
            pendingWorkspace = error.workspace
            await refresh()
            errorMessage = error.localizedDescription
        } catch is CancellationError {} catch { errorMessage = error.localizedDescription }
    }

    private func sync(_ workspace: FeatureSourceControlWorkspace) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await client.syncSourceControlWorkspace(threadID: threadID, workspace: workspace)
            pendingWorkspace = nil
            newBranch = ""
            worktreeBranch = ""
            await refresh()
        } catch is CancellationError {} catch { errorMessage = error.localizedDescription }
    }
}
