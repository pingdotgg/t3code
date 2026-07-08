import SwiftUI

/// Contextual next-step strip between the timeline and the composer. Shows
/// at most one suggestion:
/// - the branch's PR merged → offer to archive the finished chat;
/// - the branch has an open PR → offer to fix actionable review comments;
/// - the agent finished a turn with shippable work and no PR yet → offer to
///   have it open one.
struct ChatFollowUpBar: View {
    let model: AppModel

    /// The turn the agent is asked to run when the user clicks "Create PR".
    /// Plain user-message text, so it works identically across providers.
    private static let createPRPrompt = """
        Please create a pull request for the work in this session.

        Guidelines:
        - Review the full diff of this branch before writing anything.
        - Commit any uncommitted changes with clear, conventional commit messages.
        - Push the branch and open the PR against the repository's default branch.
        - Use a concise, imperative PR title.
        - In the PR body, summarize what changed and why, and note how it was verified.
        - Follow the repository's PR template and contribution guidelines if present.
        """

    /// The turn the agent is asked to run when the user clicks "Fix Reviews".
    /// Plain user-message text, so it works identically across providers.
    private static let fixReviewCommentsPrompt = """
        Please fix the actionable review comments on this pull request.

        Guidelines:
        - Use the gh CLI to fetch PR comments and review threads, including human reviewers and bot reviewers such as CodeRabbit.
        - Start with gh pr view --comments, then use gh api graphql to inspect review threads and their resolved/outdated state.
        - Ignore comments that are resolved, outdated, purely informational, or nitpick-level unless they block correctness.
        - Implement the fixes, run the relevant checks, commit, and push to the PR branch.
        - Reply to each addressed comment with what changed, and resolve the corresponding review threads with gh api graphql where possible.
        - Summarize any comments you intentionally skipped and why.
        """

    var body: some View {
        if let thread = model.selectedThread, thread.status != .archived {
            let vcs = model.selectedVcsStatus()
            if let vcs, vcs.prState == .merged {
                archiveSuggestion(thread: thread, vcs: vcs)
                    .transition(Motion.bannerDrop)
            } else if let vcs, shouldOfferReviewFixes(thread: thread, vcs: vcs) {
                fixReviewCommentsSuggestion
                    .transition(Motion.bannerDrop)
            } else if let vcs, shouldOfferPR(thread: thread, vcs: vcs) {
                createPRSuggestion
                    .transition(Motion.bannerDrop)
            }
        }
    }

    // MARK: - PR merged → archive

    private func archiveSuggestion(thread: ChatThread, vcs: VcsStatus) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(.purple)
            Text(vcs.prNumber.map { "PR #\($0) merged" } ?? "PR merged")
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                Task { await model.archiveThread(thread) }
            } label: {
                Label("Archive Chat", systemImage: "archivebox")
                    .font(.callout)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.3))
    }

    // MARK: - Turn done → create PR

    /// Only once the agent has actually answered (not a fresh thread), on a
    /// feature branch with something to ship, a remote to push to, and no
    /// PR yet. "Something to ship" is a real delta — working-tree changes,
    /// unpushed commits, or commits ahead of the default branch (the pushed
    /// branch with no PR case, where aheadCount is 0) — never the mere
    /// absence of an upstream, which would offer PRs for empty branches.
    private func shouldOfferPR(thread: ChatThread, vcs: VcsStatus) -> Bool {
        guard thread.status == .idle, vcs.isRepo, vcs.hasPrimaryRemote, !vcs.isDefaultBranch,
            vcs.prNumber == nil
        else { return false }
        let hasShippableWork = vcs.changedFileCount > 0 || vcs.aheadCount > 0
            || (vcs.aheadOfDefaultCount ?? 0) > 0
        guard hasShippableWork else { return false }
        return hasCompletedAssistantMessage
    }

    private var createPRSuggestion: some View {
        HStack {
            Spacer()
            Button {
                Task { await model.send(text: Self.createPRPrompt) }
            } label: {
                Label("Create PR", systemImage: "arrow.triangle.pull")
            }
            .buttonStyle(BrightPillButtonStyle())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: - PR open → fix review comments

    private func shouldOfferReviewFixes(thread: ChatThread, vcs: VcsStatus) -> Bool {
        guard thread.status == .idle, vcs.prNumber != nil, vcs.prState == .open
        else { return false }
        return hasCompletedAssistantMessage
    }

    private var fixReviewCommentsSuggestion: some View {
        HStack {
            Spacer()
            Button {
                Task { await model.send(text: Self.fixReviewCommentsPrompt) }
            } label: {
                Label("Fix Reviews", systemImage: "text.bubble")
            }
            .buttonStyle(BrightPillButtonStyle())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var hasCompletedAssistantMessage: Bool {
        return model.selectedTimeline().contains {
            if case .assistantMessage(_, _, let isStreaming, _) = $0 { return !isStreaming }
            return false
        }
    }
}

private struct BrightPillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background {
                Capsule()
                    .fill(.white.opacity(configuration.isPressed ? 0.75 : 0.92))
            }
            .foregroundStyle(.black)
            .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
    }
}
