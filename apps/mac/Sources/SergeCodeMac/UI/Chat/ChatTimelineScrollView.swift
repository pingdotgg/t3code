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

    /// Whether an update's animation should be flattened to keep the streaming
    /// timeline's layout still. Two marked transaction kinds pierce the
    /// suppressor: user-initiated disclosure toggles (a deliberate click
    /// deserves its animation) and row entrances (render-time transforms only
    /// — opacity/scale/offset — so they cannot re-measure realized rows).
    static func shouldFlattenAnimation(
        suppressLayoutAnimation: Bool,
        isIntentionalDisclosure: Bool,
        isEntranceAnimation: Bool
    ) -> Bool {
        suppressLayoutAnimation && !isIntentionalDisclosure && !isEntranceAnimation
    }

    /// When the timeline must hold its layout perfectly still.
    ///
    /// The three long-standing windows are a pending first anchor, a live
    /// turn, and an in-flight gesture. The fourth is a thread switch: the
    /// selection renders the retained snapshot, then the refreshed one, while
    /// VCS status and plan state land on the `ChatScreen` above — and each of
    /// those carries an `.animation(_, value:)` whose transaction reaches this
    /// `LazyVStack` and animates the whole stack's layout, right while the
    /// pin-scroll is chasing the same height. That is what made switching to a
    /// finished thread judder.
    static func suppressesLayoutAnimation(
        hasPendingInitialAnchor: Bool,
        hasSettledInitialLayout: Bool,
        threadIsSettled: Bool,
        isUserScrolling: Bool
    ) -> Bool {
        hasPendingInitialAnchor || !hasSettledInitialLayout || !threadIsSettled || isUserScrolling
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

    /// False until the thread's first render has stopped moving. See
    /// `ChatTimelineScrollPolicy.suppressesLayoutAnimation`.
    @UIState private var hasSettledInitialLayout = false

    private static let bottomAnchorID = "chat-timeline-bottom-anchor"

    /// How long after mount the timeline holds its layout still. Covers the
    /// retained-snapshot → refreshed-snapshot swap plus the chrome updates
    /// (VCS status, plan progress) that a selection kicks off above it.
    private static let initialLayoutSettleWindow: Double = 0.6

    /// How long arriving rows may animate their entrance after the last
    /// structural change. A `LazyVStack` realizes rows as they scroll into
    /// view; without a window every row 200 items down would fade in under
    /// the pointer, including during the programmatic pin-scroll that follows
    /// a thread switch. Long enough for the clamped stagger plus the row
    /// curve, so a genuinely arriving row still lands inside it.
    private static let entranceWindow: Double = 0.5

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
        let thread = model.thread(threadID: threadID)
        let rowContext = TimelineRowContext(
            threadStatus: thread?.status,
            projectRoot: model.projectPath(forScopedThreadKey: threadKey),
            activeDecisionCardID: items.activeDecisionCardID,
            isConnectionReady: model.connection == .ready)
        // Single ephemeral row, not a timeline entry: a long working stretch
        // must never stack repeated status items into the transcript. Covers
        // both gaps a live turn leaves at the tail — silent reasoning and an
        // in-flight tool call whose own row has scrolled out of view.
        let activity = AgentActivityPresentation.activity(
            threadStatus: thread?.status,
            isStalled: thread?.isStalled ?? false,
            items: items)
        // Parsed once here, not inside the dock: the dock re-renders on its
        // own 30fps clock and must never re-enter the parse cache from a
        // decorative frame.
        let activitySubject = activity.flatMap(Self.subject(for:))

        // Cold load: spinner instead of an empty LazyVStack, which bypasses
        // the autoscroll machinery and avoids a blank flash before the first
        // snapshot lands. Keep showing retained content while a background
        // reload is in flight (stale-while-revalidate).
        let showColdLoader = displayItems.isEmpty && isLoadingTimeline
        Group {
            if showColdLoader {
                VStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading conversation…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(Motion.paneChange)
            } else {
                ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(displayItems) { item in
                            ChatTimelineRowView(
                                item: item, threadID: threadID, context: rowContext, model: model)
                                .equatable()
                                .id(item.id)
                                // Deliberately no `.transition` and no ambient
                                // `.animation(_, value: displayItems.count)`:
                                // both only fire by animating the LazyVStack's
                                // own layout, which re-measures every realized
                                // row for the duration. `.entrance` below
                                // covers arrival without that cost, which is
                                // the reason it exists (see Entrance.swift) —
                                // running both meant an arriving row animated
                                // twice, and a hydration swap animated the
                                // whole stack.
                                //
                                // Arrival motion for every row, hydrated or
                                // agent-produced (SER-144). Safe during a run
                                // where `rowTransition` is not: entrance only
                                // animates the row's own opacity and offset,
                                // which are render-time transforms, so no
                                // sibling is re-measured and the stack cannot
                                // blank. Its transaction is marked
                                // `isEntranceAnimation` so the suppressor
                                // below lets it play instead of flattening it
                                // into a pop. Unstaggered on purpose — the
                                // index needed for a cascade would mean
                                // rebuilding an enumerated array on every
                                // streaming tick.
                                .entrance(.row)
                        }
                        if let activity {
                            AgentActivityDock(activity: activity, subject: activitySubject)
                                .id("agent-activity-dock")
                                .transition(Motion.rise)
                                .entrance(.row)
                                #if DEBUG
                                    // Lets the probe assert the dock is
                                    // actually mounted, which it cannot see
                                    // any other way — the dock is pure
                                    // SwiftUI and never reaches the AppKit
                                    // accessibility tree.
                                    .probeSurface(
                                        UIProbeSurfaces.activityDock,
                                        threadID: threadID,
                                        detail: activity.phase.probeDescription)
                                #endif
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomAnchorID)
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                    .frame(maxWidth: 840, alignment: .leading)
                    .frame(maxWidth: .infinity)
                    // Never animate stack layout mid-run, mid-gesture, or while
                    // a selection is still settling: a row landing while the
                    // user drags (or while tools regroup, or while hydration
                    // swaps the whole snapshot) re-measures realized rows for
                    // the animation duration and is what made the transcript
                    // judder / blank. This flattens every transaction flowing
                    // to the rows — except the two marked kinds that are safe
                    // (see shouldFlattenAnimation): row entrances, which are
                    // render-time transforms only, and user-initiated
                    // disclosure toggles. Scroll re-anchors opt out
                    // individually below.
                    .transaction { transaction in
                        if ChatTimelineScrollPolicy.shouldFlattenAnimation(
                            suppressLayoutAnimation: suppressLayoutAnimation,
                            isIntentionalDisclosure: transaction.isIntentionalDisclosure,
                            isEntranceAnimation: transaction.isEntranceAnimation)
                        {
                            transaction.animation = nil
                        }
                    }
                    // The activity dock only ever appears/disappears mid-run,
                    // when the suppressor above has cleared the ambient
                    // animation. Re-arm a narrow reveal keyed to its mount
                    // flip so it rises/fades instead of popping. Keyed on
                    // presence, not on the activity value: the phase changes
                    // several times a turn and the dock animates those itself.
                    // Placed after `.transaction` — downstream transaction
                    // modifiers win.
                    .animation(Motion.reveal, value: activity != nil)
                    // A LazyVStack realizes rows as they scroll into view, so
                    // without this every row would fade in under the pointer on
                    // the way past. Entrance is for content arriving, not for
                    // content being revealed by scrolling.
                    .entranceSuppressed(isUserScrolling)
                    // The gesture guard above misses the realizations a
                    // *programmatic* scroll causes — chiefly the pin-scroll
                    // that lands a thread switch at the tail, which walked the
                    // viewport across rows that then faded in one by one. The
                    // window reopens on every structural change, so rows the
                    // agent actually produces still animate their arrival.
                    .entranceWindow(
                        resetOn: displayItems.count, duration: Self.entranceWindow)
                }
                // Turn navigation replaces the scrollbar: indicators are
                // hidden and the leading-edge rail jumps between turns.
                .scrollIndicators(.hidden)
                .overlay(alignment: .leading) {
                    // Both halves of the rail share the display cache's key:
                    // structural timeline edits recompute them, streaming
                    // refreshes don't. Deriving them inline re-walked the
                    // whole transcript — collapsing whitespace in every user
                    // prompt, then rebuilding the tape dictionary — on each of
                    // the ~30 body evaluations a streaming second produces.
                    let rail = ChatTurnRailCache.rail(
                        displayItems: displayItems,
                        timeline: items,
                        threadID: threadKey,
                        structureVersion: model.timelineStructureVersion(threadID: threadID))
                    ChatTurnRail(
                        turns: rail.turns,
                        tape: rail.tape,
                        threadIsSettled: threadIsSettled
                    ) { rowID in
                        // Jumping to a turn is explicit navigation away from
                        // the tail: unpin first, or the next content growth
                        // (streaming delta) would re-anchor to the bottom and
                        // yank the viewport back. The programmatic animated
                        // scrollTo reports an `.animating` phase, which the
                        // pin policy treats as non-user and leaves alone;
                        // normal scrolling re-pins near the bottom as usual.
                        isPinnedToBottom = false
                        withAnimation(Motion.structure) {
                            proxy.scrollTo(rowID, anchor: .top)
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
                // Opens the layout-animation gate once the selection has
                // stopped moving. The task starts when the scroll view itself
                // mounts, so a cold thread's window begins at its first real
                // render rather than expiring behind the loading spinner.
                .task {
                    try? await Task.sleep(for: .seconds(Self.initialLayoutSettleWindow))
                    hasSettledInitialLayout = true
                }
            }
            .transition(Motion.paneChange)
            }
        }
        // Cold load → first snapshot swaps the spinner for the whole
        // ScrollView; crossfade it so a thread open never hard-cuts.
        .animation(Motion.structure, value: showColdLoader)
    }

    /// What the activity dock names after its verb: the command being run,
    /// the file being touched, the tool being called. Resolved here, through
    /// the shared parse cache, so the pure `AgentActivityPresentation` policy
    /// stays a string function and the dock never parses JSON per frame.
    ///
    /// Deliberately the bare file name rather than `PathDisplay.short`: the
    /// dock is a one-line glance beside a live clock, and the row that owns
    /// the full project-relative path is already in the transcript above.
    private static func subject(for activity: AgentActivity) -> String? {
        guard case .tool(let tool) = activity.phase else { return nil }
        switch ToolDetailParseCache.parsed(
            detail: tool.detail, itemType: tool.kind.wireItemType)
        {
        case .command(let command):
            return command
        case .fileChange(let path, _):
            let trimmed = path.trimmingCharacters(in: .whitespaces)
            return trimmed.split(separator: "/").last.map(String.init) ?? trimmed
        case .plain(let text):
            // `fileRead` details arrive as a bare path often enough to be
            // worth the same treatment; anything else is free-form and goes
            // through as-is for `clip` to bound.
            if tool.kind == .fileRead, text.contains("/"), !text.contains(" ") {
                return text.split(separator: "/").last.map(String.init)
            }
            return text
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

    /// True while the agent is writing, the first anchor is pending, a
    /// gesture is in flight, or the selection has not settled — layout must
    /// not animate in any of those windows.
    private var suppressLayoutAnimation: Bool {
        ChatTimelineScrollPolicy.suppressesLayoutAnimation(
            hasPendingInitialAnchor: pendingInitialScrollThreadID == threadID,
            hasSettledInitialLayout: hasSettledInitialLayout,
            threadIsSettled: threadIsSettled,
            isUserScrolling: isUserScrolling)
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
