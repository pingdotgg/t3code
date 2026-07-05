import AppKit
import SwiftUI

/// NSScrollView wrapper for content that must scroll on both axes with
/// native trackpad panning — SwiftUI's two-axis ScrollView doesn't reliably
/// engage horizontal panning on macOS and a scroll wheel can never reach it.
/// The document is an NSHostingView pinned to the clip view's top-leading
/// corner and constrained to at least the viewport size, so content narrower
/// than the pane still fills it (full-width row backgrounds) while wider
/// content engages the horizontal scroller. Used by the diff panel and the
/// file preview pane.
struct PanScrollView<Content: View>: NSViewRepresentable {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false

        let hosting = NSHostingView(rootView: content)
        hosting.sizingOptions = .intrinsicContentSize
        hosting.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = hosting

        let clip = scroll.contentView
        NSLayoutConstraint.activate([
            hosting.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            hosting.topAnchor.constraint(equalTo: clip.topAnchor),
            hosting.widthAnchor.constraint(greaterThanOrEqualTo: clip.widthAnchor),
            hosting.heightAnchor.constraint(greaterThanOrEqualTo: clip.heightAnchor),
        ])
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let hosting = scroll.documentView as? NSHostingView<Content> else { return }
        hosting.rootView = content
    }
}
