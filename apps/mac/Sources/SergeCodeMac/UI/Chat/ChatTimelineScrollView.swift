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

    /// Live scroll phase, so pin state only ever changes on user-driven
    /// scrolling. Content growth and LazyVStack height re-estimation report
    /// geometry changes through `.idle`/`.animating` phases and must never
    /// unpin — that's what caused the viewport to drift up mid-stream.
    @UIState private var scrollPhase: ScrollPhase = .idle

    private static let bottomAnchorID = "chat-timeline-bottom-anchor"

    var body: some View {
        let items = model.selectedTimeline()
        // Finished tool bursts render condensed; grouping is pure render
        // sugar over the untouched timeline array.
        let displayItems = items.groupedForDisplay()

        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(displayItems) { item in
                        ChatTimelineRowView(item: item, model: model)
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
                .animation(Motion.enter, value: items.count)
            }
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
            // bottom instantly. Watching contentSize (not just the last item)
            // is what keeps the viewport from being shoved up when a row
            // above the fold changes height.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentSize.height
            } action: { oldHeight, newHeight in
                guard isPinnedToBottom, newHeight != oldHeight else { return }
                proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
            }
            .onChange(of: items.count) { _, newCount in
                let appendedRow = newCount > lastItemCount
                lastItemCount = newCount
                guard isPinnedToBottom, appendedRow else { return }
                withAnimation(Motion.settle) {
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                }
            }
            // Thread switches reuse this ScrollView. A same-sized timeline
            // changes neither items.count nor contentSize, so without this
            // the new thread would inherit the old thread's scroll offset.
            .onChange(of: model.selectedThreadID) { _, _ in
                lastItemCount = items.count
                proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
            }
            .onAppear {
                lastItemCount = items.count
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
}
