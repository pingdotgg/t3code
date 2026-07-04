import AppKit
import SwiftUI

/// Slim git status strip under the chat header: current branch (switch/
/// create/pull menu), working-tree and ahead/behind chips, PR link, and the
/// stacked commit/push/PR action menu.
struct VcsToolbar: View {
    let model: AppModel

    @UIState private var branches: [BranchRef] = []
    @UIState private var showNewBranchPrompt = false
    @UIState private var newBranchName = ""
    @UIState private var pendingAction: GitAction?
    @UIState private var commitMessage = ""
    @UIState private var isRunningAction = false

    var body: some View {
        if let status = model.selectedProjectVcsStatus(), status.isRepo {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    branchMenu(status)
                    statusChips(status)
                    Spacer()
                    if let prURL = status.prURL, let url = URL(string: prURL) {
                        Button {
                            NSWorkspace.shared.open(url)
                        } label: {
                            Label(
                                status.prNumber.map { "PR #\($0)" } ?? "PR",
                                systemImage: "arrow.triangle.pull")
                            .font(.caption)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tint)
                        .help(status.prTitle ?? "Open pull request")
                    }
                    actionMenu(status)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)

                if let outcome = model.lastGitActionOutcome {
                    outcomeBanner(outcome)
                }

                Divider()
            }
            .alert("New branch", isPresented: $showNewBranchPrompt) {
                TextField("Branch name", text: $newBranchName)
                Button("Create") {
                    let name = newBranchName.trimmingCharacters(in: .whitespaces)
                    newBranchName = ""
                    guard !name.isEmpty else { return }
                    Task { await model.createBranch(name) }
                }
                Button("Cancel", role: .cancel) { newBranchName = "" }
            }
            .sheet(isPresented: commitSheetBinding) {
                commitMessageSheet
            }
        }
    }

    // MARK: - Branch menu

    private func branchMenu(_ status: VcsStatus) -> some View {
        Menu {
            ForEach(branches) { branch in
                Button {
                    Task { await model.switchBranch(branch.name) }
                } label: {
                    if branch.isCurrent {
                        Label(branch.name, systemImage: "checkmark")
                    } else {
                        Text(branch.name)
                    }
                }
                .disabled(branch.isCurrent)
            }
            Divider()
            Button("New Branch…") { showNewBranchPrompt = true }
            Button("Pull") { Task { await model.pull() } }
        } label: {
            Label(status.branch ?? "no branch", systemImage: "arrow.triangle.branch")
                .font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .onAppear {
            Task { branches = await model.listBranches(query: nil) }
        }
    }

    // MARK: - Status chips

    @ViewBuilder
    private func statusChips(_ status: VcsStatus) -> some View {
        if status.changedFileCount > 0 {
            Text("\(status.changedFileCount) changed  +\(status.insertions) −\(status.deletions)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        if status.aheadCount > 0 || status.behindCount > 0 {
            HStack(spacing: 2) {
                if status.aheadCount > 0 {
                    Label("\(status.aheadCount)", systemImage: "arrow.up")
                }
                if status.behindCount > 0 {
                    Label("\(status.behindCount)", systemImage: "arrow.down")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .help("Commits ahead/behind upstream")
        }
    }

    // MARK: - Actions

    private func actionMenu(_ status: VcsStatus) -> some View {
        Menu {
            ForEach(GitAction.allCases) { action in
                Button(action.displayName) {
                    if action.needsCommitMessage {
                        commitMessage = ""
                        pendingAction = action
                    } else {
                        run(action, message: nil)
                    }
                }
            }
        } label: {
            if isRunningAction {
                ProgressView()
                    .controlSize(.small)
            } else {
                Label("Git", systemImage: "arrow.up.circle")
                    .font(.caption)
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(isRunningAction)
    }

    private var commitSheetBinding: Binding<Bool> {
        Binding(
            get: { pendingAction != nil },
            set: { if !$0 { pendingAction = nil } })
    }

    private var commitMessageSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(pendingAction?.displayName ?? "Commit")
                .font(.headline)
            TextEditor(text: $commitMessage)
                .font(.body)
                .frame(width: 380, height: 90)
                .overlay(alignment: .topLeading) {
                    if commitMessage.isEmpty {
                        Text("Commit message (optional — server generates one if empty)")
                            .foregroundStyle(.tertiary)
                            .padding(.top, 1)
                            .padding(.leading, 4)
                            .allowsHitTesting(false)
                    }
                }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { pendingAction = nil }
                Button("Run") {
                    let action = pendingAction
                    pendingAction = nil
                    let message = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let action {
                        run(action, message: message.isEmpty ? nil : message)
                    }
                }
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(20)
    }

    private func run(_ action: GitAction, message: String?) {
        guard !isRunningAction else { return }
        isRunningAction = true
        Task {
            await model.runGitAction(action, commitMessage: message)
            isRunningAction = false
        }
    }

    // MARK: - Outcome banner

    private func outcomeBanner(_ outcome: GitActionOutcome) -> some View {
        HStack(spacing: 8) {
            Image(systemName: outcome.success ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(outcome.success ? .green : .red)
            VStack(alignment: .leading, spacing: 1) {
                Text(outcome.title)
                    .font(.caption)
                if let detail = outcome.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            if let prURL = outcome.prURL, let url = URL(string: prURL) {
                Button("Open PR") { NSWorkspace.shared.open(url) }
                    .font(.caption)
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
            }
            Spacer()
            Button {
                model.lastGitActionOutcome = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 5)
        .background(.quaternary.opacity(0.3))
    }
}
