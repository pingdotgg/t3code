import AppKit
import SwiftUI

/// Window-sizing floors for the main window.
///
/// These are the *only* minimums AppKit sees. They are deliberately small:
/// below them the shell compresses and clips, which is the user's business,
/// while above them nothing the app renders may move the window.
enum WindowSizing {
    /// Floor for the detail column (chat / review). The sidebar column (230),
    /// the inspector column (360) and the window toolbar add a fixed ~820 on
    /// top, so the window minimum lands near the 1100pt default width with
    /// every column showing, and near 510 with both columns hidden. Unlike the
    /// content's own minimum, it does not move while the app is running.
    static let minContentWidth: CGFloat = 280
    static let minContentHeight: CGFloat = 320

    /// Stable autosave key for the main window frame. SwiftUI's own generated
    /// key encodes the full generic type of the scene's view chain, so it
    /// changes whenever a modifier is added to the root view — every release
    /// that touched the shell silently discarded the user's window frame.
    static let mainWindowAutosaveName = "SurgeCodeMainWindow"
}

/// Reports a fixed minimum size to the host window instead of the content's
/// own, data-dependent minimum.
///
/// SwiftUI derives `NSWindow.contentMinSize` from the root view's minimum, and
/// AppKit *grows* any window whose frame is smaller than that minimum. The
/// chat header's git strip (branch name, PR pills, comment counts, merge
/// button) changes width as server state arrives, so the window minimum moved
/// while the app was running — a measured 1434pt with all columns visible —
/// and the window jumped to a size the user never asked for. Clamping the
/// reported minimum keeps the user's frame authoritative: content that no
/// longer fits compresses or clips instead of resizing the window.
struct WindowContentSizeClamp: Layout {
    var minWidth: CGFloat
    var minHeight: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) -> CGSize {
        // The minimum probe (`.zero`) is answered without consulting the
        // content at all — that is the whole point of the clamp.
        if proposal == .zero {
            return CGSize(width: minWidth, height: minHeight)
        }
        let natural = subviews.first?.sizeThatFits(proposal) ?? .zero
        return Self.resolvedSize(
            proposal: proposal, natural: natural, minWidth: minWidth, minHeight: minHeight)
    }

    func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) {
        guard let subview = subviews.first else { return }
        subview.place(
            at: bounds.origin,
            anchor: .topLeading,
            proposal: ProposedViewSize(bounds.size))
    }

    /// Pure size resolution, split out so it can be unit tested without a
    /// hosting view.
    static func resolvedSize(
        proposal: ProposedViewSize, natural: CGSize, minWidth: CGFloat, minHeight: CGFloat
    ) -> CGSize {
        CGSize(
            width: resolve(proposed: proposal.width, natural: natural.width, floor: minWidth),
            height: resolve(proposed: proposal.height, natural: natural.height, floor: minHeight))
    }

    private static func resolve(proposed: CGFloat?, natural: CGFloat, floor: CGFloat) -> CGFloat {
        // Ideal size (`nil`): the content's own ideal, never below the floor.
        guard let proposed else { return max(natural, floor) }
        // Minimum probe: report the floor, not the content's minimum.
        if proposed <= floor { return floor }
        // Maximum probe (`.infinity`): whatever the content can stretch to.
        guard proposed.isFinite else { return max(natural, floor) }
        // A concrete offer is the window: fill it exactly.
        return proposed
    }
}

extension View {
    /// Clamps the minimum size this view reports to its host window.
    func clampedWindowContentSize(
        minWidth: CGFloat = WindowSizing.minContentWidth,
        minHeight: CGFloat = WindowSizing.minContentHeight
    ) -> some View {
        WindowContentSizeClamp(minWidth: minWidth, minHeight: minHeight) {
            self
        }
    }
}

/// Gives the main window a stable frame autosave key so its size and position
/// survive both relaunches and app updates (see
/// `WindowSizing.mainWindowAutosaveName`).
struct MainWindowFrameAutosave: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = FrameAutosaveProbeView()
        view.onWindowChange = Self.adopt
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        Self.adopt(nsView.window)
    }

    static func adopt(_ window: NSWindow?) {
        guard let window,
            window.styleMask.contains(.titled),
            window.styleMask.contains(.resizable),
            window.frameAutosaveName != WindowSizing.mainWindowAutosaveName
        else { return }
        // Fails when another window already owns the key (a second WindowGroup
        // window); that window then keeps SwiftUI's generated key, which is
        // the pre-existing behavior.
        guard window.setFrameAutosaveName(WindowSizing.mainWindowAutosaveName) else { return }
        // `setFrameAutosaveName` only starts saving — the stored frame has to
        // be applied explicitly, and it must happen after SwiftUI has placed
        // the window with `.defaultSize`.
        _ = window.setFrameUsingName(WindowSizing.mainWindowAutosaveName)
    }
}

/// Host view that reports window attachment (SwiftUI can reparent the hosting
/// view before `window` is non-nil).
private final class FrameAutosaveProbeView: NSView {
    var onWindowChange: ((NSWindow?) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onWindowChange?(window)
    }
}
