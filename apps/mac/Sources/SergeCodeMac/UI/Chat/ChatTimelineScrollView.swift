import SwiftUI

/// Pure pin / autoscroll policy for the chat timeline.
///
/// Extracted so the rules that decide whether the viewport stays glued to the
/// bottom are unit-testable without a live `ScrollView`.
enum ChatTimelineScrollPolicy {
    /// Distance from the bottom (in points) that still counts as "at the tail"
    /// for intentional user re-pinning. Kept generous enough for trackpad
    /// coasting, but not so large that LazyVStack height re-estimation can
    /// re-pin a user who is reading history.
    static let nearBottomThreshold: CGFloat = 48

    /// Whether geometry reports the viewport as near the content bottom.
    static func isNearBottom(
        contentOffsetY: CGFloat,
        containerHeight: CGFloat,
        contentHeight: CGFloat,
        threshold: CGFloat = nearBottomThreshold
    ) -> Bool {
        contentOffsetY + containerHeight >= contentHeight - threshold
    }

    /// Pin state only changes while the user is driving the scroll
    /// (drag / wheel / momentum). Layout churn, content growth, and
    /// programmatic `scrollTo` must never re-pin or unpin on their own —
    /// LazyVStack height re-estimation used to flip near-bottom true and yank
    /// the user back to the tail mid-read.
    static func pinAfterScrollPhase(
        isUserScrolling: Bool,
        isNearBottom: Bool,
        currentlyPinned: Bool
    ) -> Bool {
        guard isUserScrolling else { return currentlyPinned }
        return isNearBottom
    }

    /// Whether a content-size change should re-anchor to the bottom.
    /// Any height change while pinned (grow *or* shrink) needs a re-anchor:
    /// a structural regroup can collapse LazyVStack estimated height and leave
    /// the viewport staring at empty space past the real content.
    static func shouldFollowContentSizeChange(
        isPinned: Bool,
        pendingInitialAnchor: Bool,
        hasContent: Bool,
        oldHeight: CGFloat,
        newHeight: CGFloat
    ) -> Bool {
        guard newHeight != oldHeight else { return false }
        if pendingInitialAnchor { return hasContent }
        return isPinned
    }
}

/// Scrollable timeline body. Pins to the bottom as new items/deltas arrive,
/// but backs off the moment the user scrolls up so they can read history
/// without fighting an autoscroll.
struct ChatTimelineScrollView: View {
    let model: AppModel
    let threadID: String
    @Binding var isPinnedToBottom: Bool

    /// Coalesces content-size-driven pin-scrolls to at most one per runloop
    /// turn. Streaming deltas and in-place row remeasures can fire many
    /// height changes per frame; queuing a single unanimated scrollTo is
    /// enough to stay glued to the bottom without thrashing layout.
    ///
    /// Deliberately a reference box, not a boolean `@UIState`: toggling a
    /// `@State` flag would invalidate this body twice more per streaming tick
    /// (set, then clear), re-running the grouping and the whole `ForEach`
    /// diff each time.
    @UIState private var scrollCoalescer = ScrollCoalescer()

    /// Thread whose first non-empty timeline render still needs to be anchored
    /// after layout. Uncached thread selection renders an empty LazyVStack
    /// first; scrolling that empty stack can leave the scroll view at a
    /// stale offset until the user nudges it.
    @UIState private var pendingInitialScrollThreadID: String?

    /// Live scroll phase, so pin state only ever changes on user-driven
    /// scrolling. Content growth and LazyVStack height re-estimation report
    /// geometry changes through `.idle`/`.animating` phases and must never
    /// rewrite the pin.
    @UIState private var scrollPhase: ScrollPhase = .idle

    private static let bottomAnchorID = "chat-timeline-bottom-anchor"

    var body: some View {
        // `threadID` is an immutable input rather than a second read of the
        // mutable selection. ChatScreen keys this view by the same ID, keeping
        // the LazyVStack, its rows, and every scroll callback on one thread.
        let items = model.timeline(threadID: threadID)
        // Finished tool bursts render condensed; grouping is pure render
        // sugar over the untouched timeline array. Memoized on
        // (threadID, structureVersion, settled), with timelineVersion used
        // only for content refreshes when assistant markdown changes.
        let threadKey = model.scopedThreadKey(threadID)
        let displayItems = TimelineDisplayCache.grouped(
            items: items,
            threadID: threadKey,
            version: model.timelineVersion(threadID: threadID),
            structureVersion: model.timelineStructureVersion(threadID: threadID),
            threadIsSettled: threadIsSettled)
        let isLoadingTimeline = model.threadState(threadID)?.isLoadingTimeline == true
        // Resolved once here so no row has to scan `threads` / `projects` /
        // the timeline itself — a per-row scan also made every row observe
        // those, so any thread churn during a run re-rendered the whole
        // visible transcript. See TimelineRowContext.
        let rowContext = TimelineRowContext(
            threadStatus: model.thread(threadID: threadID)?.status,
            projectRoot: model.projectPath(forScopedThreadKey: threadKey),
            activeDecisionCardID: items.activeDecisionCardID,
            isConnectionReady: model.connection == .ready)

        // Cold load: spinner instead of an empty LazyVStack, which bypasses
        // the autoscroll machinery and avoids a blank flash before the first
        // snapshot lands. Keep showing retained content while a background
        // reload is in flight (stale-while-revalidate).
        if displayItems.isEmpty && isLoadingTimeline {
            VStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading conversation…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(displayItems) { item in
                            ChatTimelineRowView(
                                item: item, threadID: threadID, context: rowContext, model: model)
                                .equatable()
                                .id(item.id)
                                // Rise-in is a settled-thread flourish. While the
                                // agent is working, structural regroups (tool
                                // bursts collapsing into summary rows) swap many
                                // identities at once; animating those removals
                                // blanks the LazyVStack for a frame or two.
                                .transition(rowTransition)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomAnchorID)
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                    .frame(maxWidth: 840, alignment: .leading)
                    .frame(maxWidth: .infinity)
                    // Never animate stack layout mid-run or mid-gesture: a row
                    // landing while the user drags (or while tools regroup)
                    // re-measures realized rows for the animation duration and
                    // is what made the transcript judder / blank.
                    .animation(revealAnimation, value: displayItems.count)
                    .transaction { transaction in
                        if suppressLayoutAnimation {
                            transaction.animation = nil
                            transaction.disablesAnimations = true
                        }
                    }
                }
                // Intentionally no `.defaultScrollAnchor(.bottom)`. That modifier
                // re-applies on content-size changes independently of pin state
                // and fought the user's scroll-up during streaming. Pin follow
                // is exclusive to the explicit `scrollTo` path below.
                .onScrollPhaseChange { _, newPhase in
                    scrollPhase = newPhase
                }
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    ChatTimelineScrollPolicy.isNearBottom(
                        contentOffsetY: geometry.contentOffset.y,
                        containerHeight: geometry.containerSize.height,
                        contentHeight: geometry.contentSize.height)
                } action: { _, nearBottom in
                    isPinnedToBottom = ChatTimelineScrollPolicy.pinAfterScrollPhase(
                        isUserScrolling: isUserScrolling,
                        isNearBottom: nearBottom,
                        currentlyPinned: isPinnedToBottom)
                }
                // Any content-size change while pinned — streaming growth,
                // tool upserts, LazyVStack re-measure, structural regroup
                // collapse — re-anchors. Coalesce to one scrollTo per runloop
                // turn so multi-delta height churn doesn't thrash layout.
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    geometry.contentSize.height
                } action: { oldHeight, newHeight in
                    let pendingInitial = pendingInitialScrollThreadID == threadID
                    guard ChatTimelineScrollPolicy.shouldFollowContentSizeChange(
                        isPinned: isPinnedToBottom,
                        pendingInitialAnchor: pendingInitial,
                        hasContent: !items.isEmpty,
                        oldHeight: oldHeight,
                        newHeight: newHeight)
                    else { return }

                    if pendingInitial {
                        pendingInitialScrollThreadID = nil
                        isPinnedToBottom = true
                        // First layout of a newly selected thread: land instantly.
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                        }
                        return
                    }

                    guard !scrollCoalescer.isQueued else { return }
                    scrollCoalescer.isQueued = true
                    DispatchQueue.main.async { [scrollCoalescer] in
                        scrollCoalescer.isQueued = false
                        // Still pinned? The user may have scrolled up between
                        // queue and fire — honour that.
                        guard isPinnedToBottom else { return }
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                        }
                    }
                }
                .onAppear {
                    guard !items.isEmpty else {
                        pendingInitialScrollThreadID = threadID
                        return
                    }
                    pendingInitialScrollThreadID = nil
                    var transaction = Transaction()
                    transaction.disablesAnimations = true
                    withTransaction(transaction) {
                        proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                    }
                }
            }
        }
    }

    /// True only for phases a person drives (drag, scroll wheel, momentum) —
    /// `.idle` and `.animating` cover programmatic scrolls and layout churn.
    private var isUserScrolling: Bool {
        switch scrollPhase {
        case .tracking, .interacting, .decelerating: true
        default: false
        }
    }

    /// True while the agent is still writing or the first anchor is pending —
    /// layout must not animate in those windows.
    private var suppressLayoutAnimation: Bool {
        pendingInitialScrollThreadID == threadID || !threadIsSettled || isUserScrolling
    }

    /// Nil while the initial anchor is still pending, while the user is
    /// scrolling, and while the agent is working. Animated inserts during a
    /// live turn are what made structural regroups flash the transcript empty.
    private var revealAnimation: Animation? {
        suppressLayoutAnimation ? nil : Motion.reveal
    }

    private var rowTransition: AnyTransition {
        suppressLayoutAnimation ? .identity : Motion.rise
    }

    /// Mirrors ToolEventRow's settled rule: once the thread is no longer
    /// working, tool rows stuck "running" count as finished for grouping.
    private var threadIsSettled: Bool {
        model.thread(threadID: threadID)?.status.isSettled ?? false
    }
}

/// Holds the "a pin-scroll is already queued for this runloop turn" flag
/// outside SwiftUI's state graph, so toggling it costs nothing.
@MainActor
private final class ScrollCoalescer {
    var isQueued = false
}
