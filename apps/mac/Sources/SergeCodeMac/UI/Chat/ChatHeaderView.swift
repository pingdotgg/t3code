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

        /// The pair that decides where the trailing edge is. Anchoring is keyed
        /// to this, not to the offset, so a scroll that lands short does not
        /// qualify as a new reason to scroll again.
        struct Size: Equatable {
            var contentWidth: CGFloat
            var containerWidth: CGFloat
        }

        var size: Size {
            Size(contentWidth: contentWidth, containerWidth: containerWidth)
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

            GitStrip(model: model, threadID: thread.id)
                .id(thread.id)

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

/// The header's git controls: branch dropdown, working-tree chips, PR
/// affordances, git actions. The one part of the header whose width follows
/// repository state — a long branch name next to PR pills asked for ~940pt on
/// its own, which became the window's minimum width and had AppKit grow the
/// window past whatever size the user had set.
///
/// It scrolls instead of widening the window, starting at its trailing edge so
/// the git actions menu is the last control to go, and it advertises the
/// overflow: a fade at the leading edge plus a visible scroller whenever there
/// is more strip than room.
///
/// Hosted with `.id(threadID)` by the header, which is what makes the trailing
/// start reliable: `ScrollPosition(edge:)` places the strip when its state is
/// created, so a thread switch has to be a fresh view rather than a reused one
/// being asked to scroll itself back. Corrective scrolling alone was measured
/// landing at offset 2 of 295 on a re-mounted strip — the git actions menu
/// entirely off-screen.
private struct GitStrip: View {
    let model: AppModel
    let threadID: String

    @UIState private var overflow = ChatHeaderView.GitStripOverflow()

    /// Identity for the strip's content, so the overflow transition below can
    /// align its trailing edge with the container's.
    private static let contentID = "git-strip-content"

    var body: some View {
        ScrollViewReader { proxy in
            strip(proxy)
        }
    }

    private func strip(_ proxy: ScrollViewProxy) -> some View {
        ScrollView(.horizontal) {
            VcsToolbar(model: model, threadID: threadID)
                .id(Self.contentID)
        }
        // Compressible: the strip must lose width to the title's compression
        // resistance and scroll, never win width and clip.
        .frame(minWidth: 0)
        .scrollIndicators(overflow.isOverflowing ? .visible : .hidden)
        // SwiftUI owns the anchor. Driving it from measurements instead —
        // scrolling to the trailing offset whenever geometry reported the strip
        // off-anchor — was both unreliable and a feedback risk: scrolls issued
        // out of a layout pass are dropped, a thread with a live run re-renders
        // its git controls and lands back at the leading edge, and every
        // correction re-fires the geometry callback that triggered it. Measured
        // at offset 2 of 295 on a revisited thread, git actions off-screen.
        //
        // The cost is the known one: a repository update re-anchors the strip
        // even if the user had scrolled it leading-ward to read a long branch
        // name. For a 470pt row of buttons whose trailing end holds the primary
        // actions, losing a scroll position is the cheaper failure than losing
        // the git menu, and it is what the probe can hold to account.
        .defaultScrollAnchor(.trailing)
        // The anchor must snap, not glide. A thread receiving updates
        // re-lays out its git controls constantly, and an animated re-anchor
        // meant the strip was perpetually in motion — it never came to rest at
        // the trailing edge between updates.
        .transaction { $0.animation = nil }
        .onScrollGeometryChange(for: ChatHeaderView.GitStripMetrics.self) { geometry in
            ChatHeaderView.GitStripMetrics(
                contentWidth: geometry.contentSize.width,
                containerWidth: geometry.containerSize.width,
                contentOffsetX: geometry.contentOffset.x)
        } action: { _, metrics in
            // Edge-triggered, once per transition into overflow: a strip that
            // fit a moment ago has no anchor to hold, and coming back over the
            // seam (window narrowing again) SwiftUI leaves it at the leading
            // edge — measured offset 0 of 54. Keyed to the transition rather
            // than to being off-anchor, so a scroll can never re-trigger the
            // rule that issued it.
            let becameOverflowing = metrics.overflow.isOverflowing && !overflow.isOverflowing
            // Only the derived booleans reach state; the raw offset changes on
            // every scroll tick and must not re-render the header.
            if overflow != metrics.overflow {
                overflow = metrics.overflow
            }
            if becameOverflowing {
                proxy.scrollTo(Self.contentID, anchor: .trailing)
            }
            #if DEBUG
                UIProbeGitStrip.record(metrics, threadID: threadID)
            #endif
        }
        .mask {
            // Both conditions: a trailing-anchored scroll view can report a
            // small positive offset even when nothing is clipped, and fading
            // the branch pill at full width would be a phantom cue.
            if overflow.isOverflowing, overflow.isScrolled {
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
        .animation(Motion.reveal, value: overflow)
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
