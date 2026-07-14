import AppKit
import SwiftUI

/// Slim git status strip under the chat header: current branch (switch/
/// create/pull menu), working-tree and ahead/behind chips, PR link, and the
/// stacked commit/push/PR action menu.
struct VcsToolbar: View {
    let model: AppModel
    /// The thread this toolbar instance is scoped to. The call site keys
    /// this view's identity to the same id (`.id(thread.id)`) so switching
    /// threads tears down and remounts a fresh instance — otherwise
    /// `branches`/`runningAction`/`pendingAction`/`commitMessage` below would
    /// survive the switch and briefly show thread A's in-flight git state
    /// over thread B.
    let threadID: String

    @UIState private var branches: [BranchRef] = []
    @UIState private var showNewBranchPrompt = false
    @UIState private var newBranchName = ""
    @UIState private var pendingAction: GitAction?
    @UIState private var commitMessage = ""
    @UIState private var runningAction: GitAction?
    @UIState private var showPullRequestReview = false

    private var isRunningAction: Bool { runningAction != nil }

    var body: some View {
        if let status = model.selectedVcsStatus(), status.isRepo {
            vcsStrip(status)
                .transition(Motion.unfold)
        }
    }

    private func vcsStrip(_ status: VcsStatus) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                branchMenu(status)
                statusChips(status)
                Spacer()
                if let prURL = status.prURL, let url = URL(string: prURL) {
                    let isMerged = status.prState == .merged
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Label(
                            (status.prNumber.map { "PR #\($0)" } ?? "PR")
                                + (isMerged ? " · Merged" : ""),
                            systemImage: isMerged ? "checkmark.seal.fill" : "arrow.triangle.pull")
                        .font(.caption)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(isMerged ? AnyShapeStyle(.purple) : AnyShapeStyle(.tint))
                    .help(status.prTitle ?? "Open pull request")
                }
                if let prNumber = status.prNumber {
                    Button {
                        showPullRequestReview = true
                    } label: {
                        Label(
                            status.unresolvedReviewThreadCount.map { "Comments · \($0)" }
                                ?? "Comments",
                            systemImage: "bubble.left.and.bubble.right")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(
                        (status.unresolvedReviewThreadCount ?? 0) > 0
                            ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    .help("View comments and review threads on PR #\(prNumber)")
                }
                if MergeReadiness.isReady(for: status) {
                    Button {
                        run(.mergePR, message: nil)
                    } label: {
                        if runningAction == .mergePR {
                            HStack(spacing: 6) {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(.black)
                                Text("Merging…")
                            }
                            .transition(.opacity)
                        } else {
                            Label("Merge PR", systemImage: "arrow.triangle.merge")
                                .transition(.opacity)
                        }
                    }
                    .buttonStyle(VcsMergePillButtonStyle())
                    .disabled(isRunningAction)
                    .animation(Motion.reveal, value: runningAction)
                    .help("Merge the open pull request")
                }
                actionMenu(status)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)

            if let outcome = model.lastGitActionOutcome(for: threadID) {
                outcomeBanner(outcome)
                    .transition(Motion.banner)
            }

            Divider()
        }
        .animation(Motion.reveal, value: model.lastGitActionOutcome(for: threadID))
        .animation(Motion.ambient, value: status)
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
        .sheet(isPresented: $showPullRequestReview) {
            if let prNumber = status.prNumber {
                PullRequestReviewView(
                    model: model, threadID: threadID, reference: String(prNumber))
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
        // Keyed to the thread (not a one-shot `.onAppear`) so the branch
        // list refreshes for the repo this toolbar instance now belongs to,
        // and cancels cleanly if the thread changes mid-fetch.
        .task(id: threadID) {
            branches = await model.listBranches(query: nil)
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
                .contentTransition(.numericText())
                .transition(Motion.materialize)
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
            .contentTransition(.numericText())
            .transition(Motion.materialize)
            .help("Commits ahead/behind upstream")
        }
    }

    // MARK: - Actions

    private func actionMenu(_ status: VcsStatus) -> some View {
        Menu {
            ForEach(GitAction.menuActions) { action in
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
            // Merge owns its own in-button spinner; only show menu spinner for other actions.
            if let runningAction, runningAction != .mergePR {
                ProgressView()
                    .controlSize(.small)
                    .transition(.opacity)
            } else {
                Label("Git", systemImage: "arrow.up.circle")
                    .font(.caption)
                    .transition(.opacity)
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(isRunningAction)
        .animation(Motion.reveal, value: runningAction)
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
        guard runningAction == nil else { return }
        runningAction = action
        Task {
            await model.runGitAction(action, commitMessage: message)
            runningAction = nil
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
                // The flat compat setter clears whichever thread is
                // currently selected — safe here because this toolbar only
                // ever renders for the selected thread, so it's always
                // `threadID` being cleared, matching the outcome read above.
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

/// Emphasized pill for the one-click merge affordance (matches follow-up bar).
private struct VcsMergePillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background {
                Capsule()
                    .fill(.white.opacity(configuration.isPressed ? 0.75 : 0.92))
            }
            .foregroundStyle(.black)
            .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
    }
}
