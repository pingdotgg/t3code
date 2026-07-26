import SwiftUI
import Testing

@testable import SergeCodeMac

@Suite("Window content size clamp")
struct WindowSizingTests {
    private let floorWidth: CGFloat = 280
    private let floorHeight: CGFloat = 320

    private func resolved(_ proposal: ProposedViewSize, natural: CGSize) -> CGSize {
        WindowContentSizeClamp.resolvedSize(
            proposal: proposal,
            natural: natural,
            minWidth: floorWidth,
            minHeight: floorHeight)
    }

    @Test("the minimum probe reports the floor, not the content's minimum")
    func minimumProbeReportsFloor() {
        // The content asking for 938pt (a chat header carrying a long branch
        // name and PR pills) is exactly what used to become the window's
        // minimum, and grew the window past the size the user set.
        let size = resolved(.zero, natural: CGSize(width: 938, height: 1412))
        #expect(size.width == floorWidth)
        #expect(size.height == floorHeight)
    }

    @Test("a proposal under the floor still reports the floor")
    func belowFloorReportsFloor() {
        let size = resolved(
            ProposedViewSize(width: 120, height: 100),
            natural: CGSize(width: 938, height: 1412))
        #expect(size.width == floorWidth)
        #expect(size.height == floorHeight)
    }

    @Test("a concrete proposal is filled exactly, whatever the content wants")
    func concreteProposalFills() {
        let size = resolved(
            ProposedViewSize(width: 640, height: 900),
            natural: CGSize(width: 938, height: 1412))
        #expect(size.width == 640)
        #expect(size.height == 900)
    }

    @Test("the ideal size stays the content's, floored")
    func idealSizeUsesContent() {
        let size = resolved(
            ProposedViewSize(width: nil, height: nil),
            natural: CGSize(width: 938, height: 200))
        #expect(size.width == 938)
        #expect(size.height == floorHeight)
    }

    @Test("the maximum probe passes the content's stretch through")
    func maximumProbeUsesContent() {
        let unbounded = CGFloat.infinity
        let size = resolved(
            .infinity,
            natural: CGSize(width: unbounded, height: unbounded))
        #expect(size.width == unbounded)
        #expect(size.height == unbounded)
    }

    @Test("mixed proposals resolve each axis independently")
    func mixedProposalPerAxis() {
        let size = resolved(
            ProposedViewSize(width: 1200, height: 10),
            natural: CGSize(width: 938, height: 1412))
        #expect(size.width == 1200)
        #expect(size.height == floorHeight)
    }

    @Test("shell floors stay small enough for the default window")
    func floorsFitDefaultWindow() {
        // Measured on the mock shell: the window minimum is the detail floor
        // plus a fixed 820pt of sidebar, inspector, split, and toolbar chrome.
        // Keep the total at or under the 1100x720 default the app opens with.
        #expect(WindowSizing.minContentWidth + 820 <= 1100)
        #expect(WindowSizing.minContentHeight + 156 <= 720)
    }
}
