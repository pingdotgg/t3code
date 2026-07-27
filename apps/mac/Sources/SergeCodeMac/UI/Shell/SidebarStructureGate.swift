import Foundation

/// What the sidebar list holds, in the two forms the animation decision needs.
///
/// Kept free of SwiftUI — like `MotionProfile` and `SidebarProjectSummary` — so
/// the rule that decides whether a structural change may animate is directly
/// testable without rendering a list.
struct SidebarRowCensus: Equatable, Sendable {
    /// What the list animates on: which rows are on screen, in which section
    /// and which bucket, at which sort tier — deliberately *not* their exact
    /// order, and never their status, title or badge state.
    var standing: Set<String> = []
    /// The same rows without the tier, so a row *leaving* can be told apart
    /// from a row being promoted. A promotion rewrites the tiered key and
    /// therefore looks, in `standing` alone, like one row leaving and another
    /// arriving.
    var rows: Set<String> = []

    init(standing: Set<String> = [], rows: Set<String> = []) {
        self.standing = standing
        self.rows = rows
    }
}

/// What to do with an update's transaction.
enum SidebarStructureDecision: Equatable, Sendable {
    /// Not a structural change: leave whatever transaction is in flight alone,
    /// so a press, a hover or an explicit `withAnimation` keeps its own curve.
    case inherit
    case animate
    /// Apply it, but without a curve.
    case snap
}

/// Decides whether a structural change to the sidebar list may be animated, by
/// comparing the census against the one the list last rendered.
///
/// Rows that *leave* under an animated transaction strand their AppKit row
/// view: `List` hands the removal to `NSTableView`, and when the same update
/// also inserts a row, the removed row's hosting view is left drawn where the
/// diff last put it. It then sits on top of whatever moves into that slot —
/// a stray placeholder overlapping live sessions, or a deleted session's title
/// over the section below it — until something forces the whole column to
/// redraw. `SERGECODE_UI_PROBE_SCENARIO=sidebar-empty-state` reproduces it.
///
/// So removals snap. Everything else — a session arriving, a promotion between
/// tiers, a section overtaking another, a disclosure opening — still animates,
/// which is the motion this exists for. A snap costs one frame of polish on the
/// rarer half of the churn and cannot strand anything.
@MainActor
final class SidebarStructureGate {
    private var last: SidebarRowCensus?

    init() {}

    func decide(_ census: SidebarRowCensus) -> SidebarStructureDecision {
        defer { last = census }
        // The first pass has nothing to compare against, and nothing has moved
        // yet either.
        guard let last, last != census else { return .inherit }
        return census.rows.isSuperset(of: last.rows) ? .animate : .snap
    }
}
