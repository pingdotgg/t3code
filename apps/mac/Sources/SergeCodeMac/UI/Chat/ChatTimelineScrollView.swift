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

    private static let bottomAnchorID = "chat-timeline-bottom-anchor"

    var body: some View {
        let items = model.selectedTimeline()

        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(items) { item in
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
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height
                    >= geometry.contentSize.height - 60
            } action: { _, pinned in
                isPinnedToBottom = pinned
            }
            .onChange(of: changeToken(for: items)) { _, _ in
                let appendedRow = items.count != lastItemCount
                lastItemCount = items.count
                guard isPinnedToBottom else { return }
                if appendedRow {
                    withAnimation(Motion.settle) {
                        proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                    }
                } else {
                    // Streaming delta: follow instantly. A spring here fires
                    // per token, falls behind fast streams, and silently
                    // unpins the viewport once it lags past the threshold.
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                }
            }
            .onAppear {
                proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
            }
        }
    }

    /// Cheap signature that changes on append *and* on in-place streaming
    /// deltas (which don't change `items.count`), so the scroll-to-bottom
    /// `onChange` fires in both cases.
    private func changeToken(for items: [TimelineItem]) -> String {
        guard let last = items.last else { return "empty" }
        switch last {
        case .assistantMessage(let id, let markdown, let isStreaming, _):
            return "\(items.count)|\(id)|\(markdown.count)|\(isStreaming)"
        case .reasoning(let id, let text, _):
            // Streaming reasoning replaces the row's text in place (same id).
            return "\(items.count)|\(id)|\(text.count)"
        case .toolEvent(let id, _, let detail, _, let status, _):
            // Lifecycle upserts mutate status/detail without changing count.
            return "\(items.count)|\(id)|\(detail.count)|\(status)"
        default:
            return "\(items.count)|\(last.id)"
        }
    }
}
