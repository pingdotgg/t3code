import SwiftUI
import UIKit

/// Keeps the sidebar beside an open thread only in a wide window where UIKit
/// really tiles it. Where UIKit would overlay the sidebar, `.all` dims and
/// covers the thread, so the thread gets the full width instead.
struct WorkspaceSidebarLayout: Equatable {
    var isWideWindow = false
    var splitTiles = false

    var tilesSidebar: Bool { isWideWindow && splitTiles }

    func visibility(hasThread: Bool, hasTool: Bool) -> NavigationSplitViewVisibility {
        (tilesSidebar && !hasTool) || !hasThread ? .all : .detailOnly
    }
}

/// Reports whether the enclosing split view tiles its sidebar. UIKit picks
/// tile or overlay from more than the window size: an iPhone Duo can overlay
/// at a width where it tiled before a rotation.
struct WorkspaceSplitBehaviorObserver: UIViewRepresentable {
    let onSplitTilesChange: (Bool) -> Void

    func makeUIView(context: Context) -> ProbeView {
        ProbeView(onSplitTilesChange: onSplitTilesChange)
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.onSplitTilesChange = onSplitTilesChange
    }

    final class ProbeView: UIView {
        var onSplitTilesChange: (Bool) -> Void
        private var lastSplitTiles: Bool?

        init(onSplitTilesChange: @escaping (Bool) -> Void) {
            self.onSplitTilesChange = onSplitTilesChange
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            // A collapsed split can detach the detail. Report again on return.
            if window == nil { lastSplitTiles = nil }
            updateBehavior()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            updateBehavior()
        }

        private func updateBehavior() {
            guard window != nil else { return }
            var responder: UIResponder? = self
            while let current = responder, !(current is UIViewController) { responder = current.next }
            guard let split = (responder as? UIViewController)?.splitViewController else { return }
            let splitTiles = !split.isCollapsed && split.splitBehavior == .tile
            guard lastSplitTiles != splitTiles else { return }
            lastSplitTiles = splitTiles
            // Layout may run during a SwiftUI update. Publish only the final value.
            DispatchQueue.main.async { [weak self] in
                guard let self, lastSplitTiles == splitTiles else { return }
                onSplitTilesChange(splitTiles)
            }
        }
    }
}
