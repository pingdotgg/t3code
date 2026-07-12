import SwiftUI

/// Scrollable timeline body. Pins to the bottom as new items/deltas arrive,
/// but backs off the moment the user scrolls up so they can read history
/// without fighting an autoscroll.
struct ChatTimelineScrollView: View {
    let model: AppModel
    @Binding var isPinnedToBottom: Bool

    /// Item count at the last scroll-triggering change, to tell row appends
    /// (animate the scroll) apart from in-place streaming deltas (jump).
    @UIState private var lastItemCount = 0

    /// Coalesces content-size-driven pin-scrolls to at most one per runloop
    /// turn. Streaming deltas and in-place row remeasures can fire many
    /// height changes per frame; queuing a single unanimated scrollTo is
    /// enough to stay glued to the bottom without thrashing layout.
    @UIState private var scrollQueued = false

    /// Thread whose first non-empty timeline render still needs to be anchored
    /// after layout. Uncached thread selection renders an empty LazyVStack
    /// first; scrolling that empty stack can leave the reused scroll view at a
    /// stale offset until the user nudges it.
    @UIState private var pendingInitialScrollThreadID: String?

    /// Live scroll phase, so pin state only ever changes on user-driven
    /// scrolling. Content growth and LazyVStack height re-estimation report
    /// geometry changes through `.idle`/`.animating` phases and must never
    /// unpin — that's what caused the viewport to drift up mid-stream.
    @UIState private var scrollPhase: ScrollPhase = .idle

    private static let bottomAnchorID = "chat-timeline-bottom-anchor"

    var body: some View {
        let items = model.selectedTimeline()
        // Finished tool bursts render condensed; grouping is pure render
        // sugar over the untouched timeline array. Memoized on
        // (threadID, structureVersion, settled), with timelineVersion used
        // only for content refreshes when assistant markdown changes.
        let threadID = model.selectedThreadID ?? ""
        let displayItems = TimelineDisplayCache.grouped(
            items: items,
            threadID: threadID,
            version: model.timelineVersion(threadID: threadID),
            structureVersion: model.timelineStructureVersion(threadID: threadID),
            threadIsSettled: threadIsSettled)

        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(displayItems) { item in
                        ChatTimelineRowView(item: item, threadID: threadID, model: model)
                            .id(item.id)
                            .transition(Motion.rise)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchorID)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Keyed to count, not content: new rows rise in, but
                // per-token streaming updates never re-trigger layout
                // animation.
                .animation(
                    pendingInitialScrollThreadID == model.selectedThreadID ? nil : Motion.enter,
                    value: items.count)
            }
            .defaultScrollAnchor(.bottom)
            // Transparent: the timeline reads off ChatScreen's washed scenery
            // wallpaper (SceneryChatBackground guarantees the contrast).
            .onScrollPhaseChange { _, newPhase in
                scrollPhase = newPhase
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height
                    >= geometry.contentSize.height - 60
            } action: { _, nearBottom in
                if nearBottom {
                    isPinnedToBottom = true
                } else if isUserScrolling {
                    isPinnedToBottom = false
                }
            }
            // Any content growth while pinned — streaming deltas, tool rows
            // updating in place, lazy rows re-measuring — re-anchors to the
            // bottom. Watching contentSize (not just the last item) is what
            // keeps the viewport from being shoved up when a row above the
            // fold changes height. Coalesce to one scrollTo per runloop turn
            // so multi-delta height churn doesn't thrash layout.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentSize.height
            } action: { oldHeight, newHeight in
                guard newHeight != oldHeight else { return }
                if pendingInitialScrollThreadID == model.selectedThreadID, !items.isEmpty {
                    pendingInitialScrollThreadID = nil
                    lastItemCount = items.count
                    isPinnedToBottom = true
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                    return
                }
                guard isPinnedToBottom, newHeight > oldHeight, !scrollQueued else { return }
                scrollQueued = true
                DispatchQueue.main.async {
                    scrollQueued = false
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                }
            }
            .onChange(of: items.count) { _, newCount in
                let appendedRow = newCount > lastItemCount
                lastItemCount = newCount
                guard pendingInitialScrollThreadID != model.selectedThreadID else { return }
                guard isPinnedToBottom, appendedRow else { return }
                withAnimation(Motion.settle) {
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                }
            }
            // Thread switches reuse this ScrollView. A same-sized timeline
            // changes neither items.count nor contentSize, so without this
            // the new thread would inherit the old thread's scroll offset.
            .onChange(of: model.selectedThreadID) { _, newThreadID in
                isPinnedToBottom = true
                lastItemCount = items.count
                guard let newThreadID else {
                    pendingInitialScrollThreadID = nil
                    return
                }
                guard !items.isEmpty else {
                    pendingInitialScrollThreadID = newThreadID
                    return
                }
                pendingInitialScrollThreadID = nil
                proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
            }
            .onAppear {
                lastItemCount = items.count
                guard let threadID = model.selectedThreadID else { return }
                guard !items.isEmpty else {
                    pendingInitialScrollThreadID = threadID
                    return
                }
                pendingInitialScrollThreadID = nil
                proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
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

    /// Mirrors ToolEventRow's settled rule: once the thread is no longer
    /// working, tool rows stuck "running" count as finished for grouping.
    private var threadIsSettled: Bool {
        switch model.selectedThread?.status {
        case .idle, .archived, .error: true
        case .running, .waitingApproval, .backgroundWork, nil: false
        }
    }
}
