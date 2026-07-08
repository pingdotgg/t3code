import AppKit
import SwiftUI

/// Contextual next-step strip between the timeline and the composer. Shows
/// at most one suggestion:
/// - the branch's PR merged → offer to archive the finished chat;
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

    var body: some View {
        Group {
            if let thread = model.selectedThread, thread.status != .archived {
                let vcs = model.selectedVcsStatus()
                if let vcs, vcs.prState == .merged {
                    archiveSuggestion(thread: thread, vcs: vcs)
                        .transition(Motion.bannerDrop)
                } else if let vcs, vcs.prState == .open, let url = pullRequestURL(vcs) {
                    openPullRequestChip(vcs: vcs, url: url)
                        .transition(Motion.bannerDrop)
                } else if let vcs, shouldOfferPR(thread: thread, vcs: vcs) {
                    createPRSuggestion
                        .transition(Motion.bannerDrop)
                }
            }
        }
        .animation(Motion.settle, value: model.selectedVcsStatus())
    }

    // MARK: - PR open → link

    private func openPullRequestChip(vcs: VcsStatus, url: URL) -> some View {
        Button {
            NSWorkspace.shared.open(url)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.pull")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.tint)

                Text(pullRequestLabel(vcs))
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 8)

                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .help(vcs.prTitle ?? "Open pull request")
    }

    private func pullRequestURL(_ vcs: VcsStatus) -> URL? {
        guard let prURL = vcs.prURL else { return nil }
        return URL(string: prURL)
    }

    private func pullRequestLabel(_ vcs: VcsStatus) -> String {
        let number = vcs.prNumber.map { "PR #\($0)" } ?? "Pull request"
        guard
            let title = vcs.prTitle?.trimmingCharacters(in: .whitespacesAndNewlines),
            !title.isEmpty
        else {
            return number
        }
        return "\(number) · \(title)"
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
        return model.selectedTimeline().contains {
            if case .assistantMessage(_, _, let isStreaming, _) = $0 { return !isStreaming }
            return false
        }
    }

    private var createPRSuggestion: some View {
        HStack {
            Spacer()
            Button {
                Task { await model.send(text: Self.createPRPrompt) }
            } label: {
                Label("Create PR", systemImage: "arrow.triangle.pull")
                    .font(.callout)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}
