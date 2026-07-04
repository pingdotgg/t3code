import SwiftUI

/// Scrollable timeline body. Pins to the bottom as new items/deltas arrive,
/// but backs off the moment the user scrolls up so they can read history
/// without fighting an autoscroll.
struct ChatTimelineScrollView: View {
    let model: AppModel
    @Binding var isPinnedToBottom: Bool

    private static let bottomAnchorID = "chat-timeline-bottom-anchor"

    var body: some View {
        let items = model.selectedTimeline()

        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(items) { item in
                        ChatTimelineRowView(item: item, model: model)
                            .id(item.id)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchorID)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // Opaque reading surface — no glass behind timeline content.
            .background(.background)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height
                    >= geometry.contentSize.height - 60
            } action: { _, pinned in
                isPinnedToBottom = pinned
            }
            .onChange(of: changeToken(for: items)) { _, _ in
                guard isPinnedToBottom else { return }
                withAnimation(.easeOut(duration: 0.2)) {
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
        default:
            return "\(items.count)|\(last.id)"
        }
    }
}
