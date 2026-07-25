import SwiftUI

/// Contextual next-step strip between the timeline and the composer. Shows at
/// most one suggestion: the agent finished a turn with shippable work and no
/// PR yet → offer to have it open one. Review status and the PR link live in
/// the git section at the top, so the chat log stays out of that business.
struct ChatFollowUpBar: View {
    let model: AppModel

    var body: some View {
        Group {
            if let thread = model.selectedThread, thread.status != .archived,
                let vcs = model.selectedVcsStatus(),
                vcs.prState != .merged,
                shouldOfferPR(thread: thread, vcs: vcs)
            {
                createPRSuggestion
                    .transition(Motion.banner)
            }
        }
        // A merged PR is the bar's rarest success moment: ripple once on the
        // merged edge (the Group identity persists across strip swaps, so
        // `fire` sees a real false→true) and let the strip spring in on the
        // delight curve. Every other strip swap keeps Motion.structure.
        .successRipple(
            fire: visibleStrip == .archive,
            cornerRadius: AlpineTheme.Corners.card)
        // Key on which strip is showing, not the whole VcsStatus: mid-run
        // file-count republishes must not re-animate the bar.
        .animation(
            visibleStrip == .archive ? Motion.delight : Motion.structure,
            value: visibleStrip)
    }

    /// Identity of whichever suggestion strip is on screen. Mirrors the
    /// branching in `body` so the bar's swap animation keys on presence and
    /// identity only — count-only VCS republishes leave it unchanged.
    private enum VisibleStrip: Equatable {
        case none
        case archive
        case createPR
    }

    private var visibleStrip: VisibleStrip {
        guard let thread = model.selectedThread, thread.status != .archived,
            let vcs = model.selectedVcsStatus()
        else { return .none }
        if vcs.prState == .merged { return .archive }
        return shouldOfferPR(thread: thread, vcs: vcs) ? .createPR : .none
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
        return model.selectedTimeline().hasCompletedAssistantMessage
    }

    private var createPRSuggestion: some View {
        HStack {
            Spacer()
            Button {
                Task { await model.send(text: CreatePRPrompt.standalone) }
            } label: {
                Label("Create PR", systemImage: "arrow.triangle.pull")
            }
            .buttonStyle(NatureActionButtonStyle())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}

private struct NatureActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background {
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                    .fill(AlpineTheme.accent.opacity(configuration.isPressed ? 0.72 : 1))
            }
            .foregroundStyle(AlpineTheme.forest)
            .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
            .animation(Motion.feedback, value: configuration.isPressed)
    }
}
