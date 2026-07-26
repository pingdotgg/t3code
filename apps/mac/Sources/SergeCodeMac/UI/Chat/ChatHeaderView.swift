import SwiftUI

/// Single task-identity header. The task title leads; project scenery,
/// provider, and status remain compact supporting context. The git controls
/// (branch dropdown, working-tree chips, PR affordances, git actions) live
/// inline on the trailing side — there is no separate git section below.
/// Transparent by design: the full-page frosted scenery remains atmospheric
/// behind this shallow identity band without adding another gray plate.
struct ChatHeaderView: View {
    let thread: ChatThread
    let model: AppModel
    let scenery: SceneryStore
    let threadKey: String

    /// Live overflow state of the git strip, so the header can say out loud
    /// that controls continue past the leading edge.
    @UIState private var gitStripOverflow = GitStripOverflow()

    /// Starts the strip at its trailing edge and then follows the user. This is
    /// deliberately *not* `.defaultScrollAnchor(.trailing)`: that re-anchors on
    /// every content-size change, so a PR pill or file-count landing would yank
    /// the strip back while the user was reading a long branch name — the same
    /// footgun `ChatTimelineScrollView` documents for `.bottom` during
    /// streaming. Trailing is the starting position, not a standing rule.
    @UIState private var gitStripPosition = ScrollPosition(edge: .trailing)

    /// Set once the user drags the strip, which stops the trailing follow —
    /// the same shape as the timeline's pin-to-bottom state. Until then the
    /// strip is held at trailing, because the initial placement alone drifts:
    /// the container keeps narrowing as the header settles, and a scroll view
    /// holds its old offset, which measured up to 21pt short of the trailing
    /// edge and cut into the git actions menu.
    @UIState private var gitStripUserScrolled = false

    struct GitStripOverflow: Equatable {
        /// The strip needs more width than the header gives it.
        var isOverflowing = false
        /// Something is currently scrolled off the leading edge.
        var isScrolled = false
    }

    /// Raw scroll geometry of the git strip. Kept separate from the derived
    /// booleans the view renders from: the offset changes continuously while
    /// scrolling, and only the booleans should drive re-renders.
    struct GitStripMetrics: Equatable {
        var contentWidth: CGFloat = 0
        var containerWidth: CGFloat = 0
        var contentOffsetX: CGFloat = 0

        /// Half a point of slack for the overflow test: content and container
        /// widths land on fractional values and would otherwise flicker at the
        /// seam.
        private static let slack: CGFloat = 0.5

        /// How far off the trailing edge still counts as anchored. Wider than
        /// `slack` because a scroll view settles against fractional widths: on
        /// a fresh mount the strip lands up to 4pt short across probe runs, and
        /// chasing that residue only makes the strip re-scroll itself. The
        /// drift worth catching was 21pt — enough to cut into the git actions
        /// menu — and anything at that scale still fails the check.
        private static let anchorTolerance: CGFloat = 6

        var overflow: GitStripOverflow {
            GitStripOverflow(
                isOverflowing: contentWidth > containerWidth + Self.slack,
                isScrolled: contentOffsetX > Self.slack)
        }

        /// The offset at which the strip's trailing end meets the container's.
        var trailingEdgeOffset: CGFloat {
            max(0, contentWidth - containerWidth)
        }

        /// Whether the strip sits at its trailing edge — the position it is
        /// placed at on first show and on a thread switch. A strip that
        /// overflows but reports a zero offset has silently landed at the
        /// leading edge instead, hiding the git actions menu.
        var isAtTrailingEdge: Bool {
            guard contentWidth > containerWidth + Self.slack else { return true }
            return contentOffsetX >= trailingEdgeOffset - Self.anchorTolerance
        }
    }

    var body: some View {
        HStack(spacing: 16) {
            let names = scenery.displayNames(for: thread, threadKey: threadKey)
            VStack(alignment: .leading, spacing: 5) {
                Text(thread.title.isEmpty ? names.primary : thread.title)
                    .font(SurgeTypography.threadTitle)
                    .lineLimit(1)
                    // A generated title lands after the header is already on
                    // screen; fade the swap instead of teleporting the
                    // header's largest text.
                    .contentTransition(Motion.reduceMotion ? .identity : .opacity)
                    .animation(Motion.reveal, value: thread.title)

                HStack(spacing: 8) {
                    projectIdentity(names.primary)
                    if model.isRemote {
                        metadataDivider
                        Label(model.deviceName ?? "Remote Mac", systemImage: "laptopcomputer")
                    }
                }
                // Truncate rather than wrap: at the narrowest window widths a
                // wrapped project name pushed the whole identity band taller.
                .lineLimit(1)
                .font(SurgeTypography.technicalMetadata)
                .foregroundStyle(.primary.opacity(0.76))
            }

            Spacer(minLength: 8)

            gitStrip

            // Provider and status are fixed-width and never scroll away: they
            // are the header's at-a-glance state, and pinning them also keeps
            // the git strip's trailing anchor on the git actions menu.
            ProviderBadge(provider: thread.provider, modelID: thread.modelID)
            StatusBadge(status: thread.status, stalled: thread.isStalled)
        }
        .padding(.horizontal, 16)
        // Floor height shared with the inspector Activity header so the
        // dividers under both headers line up; a floor (not a fixed height)
        // so the header can grow instead of clipping if its content ever
        // exceeds the band (see AlpineTheme.contentHeaderHeight).
        .frame(minHeight: AlpineTheme.contentHeaderHeight)
    }

    /// Git controls ride the header instead of a separate section below; the
    /// toolbar owns the repo-status gate and shows nothing for non-repo
    /// projects. Keyed per thread so in-flight git state never leaks across a
    /// thread switch (see VcsToolbar.threadID).
    ///
    /// This is the one part of the header whose width follows repository state
    /// — a long branch name next to PR pills asked for ~940pt on its own,
    /// which became the window's minimum width and had AppKit grow the window
    /// past whatever size the user had set. It scrolls instead of widening the
    /// window, starting at its trailing edge so the git actions menu is the
    /// last thing to go, and it advertises the overflow: a fade at the leading
    /// edge plus a visible scroller whenever there is more strip than room.
    private var gitStrip: some View {
        ScrollView(.horizontal) {
            VcsToolbar(model: model, threadID: thread.id)
                .id(thread.id)
        }
        // Compressible: the strip must lose width to the title's compression
        // resistance and scroll, never win width and clip.
        .frame(minWidth: 0)
        .scrollIndicators(gitStripOverflow.isOverflowing ? .visible : .hidden)
        .scrollPosition($gitStripPosition)
        // A new thread is a new repository state; start it at trailing again.
        .onChange(of: thread.id) { _, _ in
            gitStripUserScrolled = false
            gitStripPosition.scrollTo(edge: .trailing)
        }
        // A drag hands the strip to the user; nothing re-anchors it after this
        // until they switch threads. Programmatic scrolls report `.animating`,
        // so holding the strip at trailing does not count as interaction.
        .onScrollPhaseChange { _, phase in
            if phase == .tracking || phase == .interacting {
                gitStripUserScrolled = true
            }
        }
        .onScrollGeometryChange(for: GitStripMetrics.self) { geometry in
            GitStripMetrics(
                contentWidth: geometry.contentSize.width,
                containerWidth: geometry.containerSize.width,
                contentOffsetX: geometry.contentOffset.x)
        } action: { _, metrics in
            // Only the derived booleans reach state; the raw offset changes on
            // every scroll tick and must not re-render the header.
            if gitStripOverflow != metrics.overflow {
                gitStripOverflow = metrics.overflow
            }
            // Hold the trailing edge while the strip is still the app's to
            // place: the header keeps re-measuring as the window settles, and
            // a stale offset leaves part of the git actions menu off-screen.
            //
            // By explicit offset, not `scrollTo(edge: .trailing)`: the position
            // already reads as trailing from its own initial value, so asking
            // for that edge again is a no-op and the strip kept the offset it
            // was placed at against a wider container — measured 4pt short on
            // every thread, eating into the git actions menu.
            if !gitStripUserScrolled, !metrics.isAtTrailingEdge {
                gitStripPosition.scrollTo(x: metrics.trailingEdgeOffset)
            }
            #if DEBUG
                UIProbeGitStrip.record(metrics, threadID: thread.id)
            #endif
        }
        .mask {
            // Both conditions: a trailing-anchored scroll view can report a
            // small positive offset even when nothing is clipped, and fading
            // the branch pill at full width would be a phantom cue.
            if gitStripOverflow.isOverflowing, gitStripOverflow.isScrolled {
                HStack(spacing: 0) {
                    LinearGradient(
                        colors: [.clear, .black], startPoint: .leading, endPoint: .trailing
                    )
                    .frame(width: 22)
                    Rectangle()
                }
            } else {
                Rectangle()
            }
        }
        .animation(Motion.reveal, value: gitStripOverflow)
    }

    private var projectPrefs: ProjectSceneryPrefs? {
        guard let project = model.projects.first(where: { $0.id == thread.projectID }) else {
            return nil
        }
        return scenery.projectPrefs(for: project.path)
    }

    @ViewBuilder
    private func projectIdentity(_ name: String) -> some View {
        if let prefs = projectPrefs, prefs.showsProjectBadge {
            HStack(spacing: 5) {
                ProjectSceneryBadge(prefs: prefs, symbolSize: 10, dotSize: 5)
                Text(name)
            }
        } else {
            Text(name)
        }
    }

    private var metadataDivider: some View {
        Text("·")
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }
}

private struct ProviderBadge: View {
    let provider: ProviderKind
    let modelID: String?

    var body: some View {
        ProviderLabel(provider: provider, modelID: modelID, iconSize: 13)
            .font(.caption)
            .foregroundStyle(.primary.opacity(0.76))
    }
}

private struct StatusBadge: View {
    let status: ThreadStatus
    /// Server-reported stall for the active turn; warning-tinted (not error).
    var stalled: Bool = false

    var body: some View {
        Label(text, systemImage: icon)
            .labelStyle(.titleAndIcon)
            .font(.caption)
            .foregroundStyle(color)
            .contentTransition(
                Motion.reduceMotion ? .identity : .symbolEffect(.replace))
            .animation(Motion.ambient, value: status)
            .animation(Motion.ambient, value: stalled)
    }

    private var text: String {
        if stalled { return "Stalled" }
        switch status {
        case .idle: return "Idle"
        case .running: return "Running"
        case .waiting: return "Waiting"
        case .waitingApproval: return "Needs approval"
        case .waitingInput: return "Needs input"
        case .backgroundWork: return "Background work"
        case .error: return "Error"
        case .archived: return "Archived"
        case .settled: return "Settled"
        case .done: return "Done"
        case .reviewing: return "Reviewing"
        case .fixing: return "Fixing"
        case .readyToMerge: return "Ready to merge"
        }
    }

    private var icon: String {
        if stalled { return "exclamationmark.circle" }
        switch status {
        case .idle: return "circle"
        case .running: return "bolt.fill"
        case .waiting: return "clock.fill"
        case .waitingApproval: return "exclamationmark.circle.fill"
        case .waitingInput: return "questionmark.bubble.fill"
        case .backgroundWork: return "person.2.fill"
        case .error: return "xmark.octagon.fill"
        case .archived: return "archivebox.fill"
        case .settled: return "checkmark.circle"
        case .done: return "checkmark"
        case .reviewing: return "magnifyingglass"
        case .fixing: return "wrench.and.screwdriver"
        case .readyToMerge: return "checkmark.seal"
        }
    }

    private var color: Color {
        if stalled { return AlpineTheme.clay }
        switch status {
        case .idle: return .secondary
        case .running: return AlpineTheme.accent
        case .waiting: return AlpineTheme.sky
        case .waitingApproval: return AlpineTheme.lichen
        case .waitingInput: return AlpineTheme.sky
        case .backgroundWork: return AlpineTheme.meadow
        case .error: return .red
        case .archived: return .secondary
        case .settled: return .secondary
        case .done: return .secondary
        case .reviewing: return AlpineTheme.sky
        case .fixing: return AlpineTheme.accent
        case .readyToMerge: return AlpineTheme.lichen
        }
    }
}
