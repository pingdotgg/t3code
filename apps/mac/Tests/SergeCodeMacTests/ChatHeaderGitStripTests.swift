import SwiftUI
import Testing

@testable import SergeCodeMac

/// The header's git strip is placed at its trailing edge — where the git
/// actions menu lives — on first show and on every thread switch, and it stays
/// there until the user drags it. SwiftUI scroll views cannot be hosted in the
/// CLT test bundle, so these cover the geometry rules that decide when the
/// strip is off its anchor; the placement itself is asserted at runtime by the
/// `window-size` probe (`UIProbe.probeGitStripAnchor`).
@Suite("Chat header git strip")
struct ChatHeaderGitStripTests {
    private typealias Metrics = ChatHeaderView.GitStripMetrics

    @Test("a strip that fits is always considered anchored")
    func fittingStripIsAnchored() {
        let metrics = Metrics(contentWidth: 400, containerWidth: 600, contentOffsetX: 0)
        #expect(metrics.isAtTrailingEdge)
        #expect(!metrics.overflow.isOverflowing)
        #expect(!metrics.overflow.isScrolled)
    }

    @Test("an overflowing strip resting at zero offset is at the leading edge")
    func leadingEdgeIsNotAnchored() {
        // The silent failure this guards: the strip overflows but never moved,
        // so the branch name shows and the git actions menu is off-screen.
        let metrics = Metrics(contentWidth: 472, containerWidth: 177, contentOffsetX: 0)
        #expect(!metrics.isAtTrailingEdge)
        #expect(metrics.overflow.isOverflowing)
        #expect(!metrics.overflow.isScrolled)
    }

    @Test("the trailing edge is content width minus container width")
    func trailingEdgeIsMaxOffset() {
        // Measured on the mock shell: 472pt of strip in a 177pt container.
        let metrics = Metrics(contentWidth: 472, containerWidth: 177, contentOffsetX: 295)
        #expect(metrics.isAtTrailingEdge)
        #expect(metrics.overflow.isOverflowing)
        #expect(metrics.overflow.isScrolled)
    }

    @Test("an offset short of the trailing edge is not anchored")
    func staleOffsetIsNotAnchored() {
        // The drift that made the follow rule necessary: the container settled
        // 21pt narrower than when the offset was last set, leaving that much of
        // the git actions menu off-screen.
        let metrics = Metrics(contentWidth: 472, containerWidth: 156, contentOffsetX: 295)
        #expect(!metrics.isAtTrailingEdge)
    }

    @Test("settling residue does not count as off-anchor")
    func settlingResidueIsTolerated() {
        // A scroll view settling against fractional widths lands a few points
        // short; measured up to 4pt across probe runs. Treating that as
        // off-anchor would have the strip re-scrolling itself forever.
        let metrics = Metrics(contentWidth: 472.4, containerWidth: 177.1, contentOffsetX: 291)
        #expect(metrics.isAtTrailingEdge)
    }

    @Test("the tolerance stays well under the drift it has to catch")
    func toleranceIsNarrowerThanRealDrift() {
        // 21pt short must fail even though 4pt passes — otherwise the check
        // stops being evidence of anything.
        let settling = Metrics(contentWidth: 472, containerWidth: 177, contentOffsetX: 291)
        let drifted = Metrics(contentWidth: 472, containerWidth: 177, contentOffsetX: 274)
        #expect(settling.isAtTrailingEdge)
        #expect(!drifted.isAtTrailingEdge)
    }

    @Test("overflow needs more than a sub-point of extra content")
    func fractionalOverflowIsIgnored() {
        let metrics = Metrics(contentWidth: 600.2, containerWidth: 600, contentOffsetX: 0)
        #expect(!metrics.overflow.isOverflowing)
        #expect(metrics.isAtTrailingEdge)
    }
}
