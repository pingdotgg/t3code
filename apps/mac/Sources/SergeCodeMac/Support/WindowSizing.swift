import SwiftUI

/// Window-sizing floors for the shell.
///
/// These are not the only minimums AppKit sees: the sidebar column
/// (`navigationSplitViewColumnWidth(min: 230, …)`), the inspector column
/// (`inspectorColumnWidth(min: 300, ideal: 360, …)`, so 360 while it sits at
/// its ideal width), and the split/toolbar chrome all add their own on top.
/// What matters is that those are fixed, while the detail column's was moving
/// with content — these floors replace the moving part.
enum WindowSizing {
    /// Floor the detail column (chat / review) reports in place of whatever
    /// its content currently needs. Below it the detail content compresses and
    /// clips, which is the user's business; above it nothing the app renders
    /// can move the window. Measured window minimums with this floor: 1100pt
    /// with every column showing, 740 with the inspector hidden, 640 with both
    /// hidden (versus 1434 and climbing before the clamp).
    static let minContentWidth: CGFloat = 280
    static let minContentHeight: CGFloat = 320
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
        // Minimum probe: report the floor, not the content's minimum. This is
        // the only path the clamp exists to change.
        if proposed <= floor { return floor }
        // Unbounded probe: this answer becomes `NSWindow.contentMaxSize`, so
        // the content's own stretch is forwarded untouched — the clamp must
        // never be what stops a window expanding. A flexible detail column
        // answers `.infinity` here and keeps the window unbounded.
        guard proposed.isFinite else { return expansion(natural: natural, floor: floor) }
        // A concrete offer is the window: fill it exactly.
        return proposed
    }

    /// The unbounded answer, kept separate from the minimum path so the two
    /// cannot drift into each other.
    ///
    /// The content's number passes through as-is. The single exception is a
    /// content maximum that lands *below* the floor: a window whose maximum is
    /// under its minimum is not a size AppKit can honor, and the floor is the
    /// minimum we just reported. That case cannot cap a window in practice —
    /// the floor is 280x320 — but it keeps the pair consistent.
    private static func expansion(natural: CGFloat, floor: CGFloat) -> CGFloat {
        natural >= floor ? natural : floor
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
