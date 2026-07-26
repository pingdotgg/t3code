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
        // Deliberately NOT clamped: this branch becomes the window's maximum
        // size. Capping it to the floor would forbid the user from resizing
        // the window larger, which is not what the clamp is for — window
        // growth came from the minimum, not the maximum.
        let unbounded = CGFloat.infinity
        let size = resolved(
            .infinity,
            natural: CGSize(width: unbounded, height: unbounded))
        #expect(size.width == unbounded)
        #expect(size.height == unbounded)
    }

    @Test("content that outgrows the floor cannot raise the reported minimum")
    func growingContentDoesNotRaiseTheMinimum() {
        // The whole point, stated as a property: whatever the content's ideal
        // does — the git strip measured 472pt growing to 1121pt when a long
        // branch name, a draft PR, conflicts, and review counts landed — the
        // minimum probe keeps answering the floor, and that is the number
        // AppKit enforces by growing the window.
        for naturalWidth in [472.0, 938.0, 1121.0, 4000.0] {
            let natural = CGSize(width: naturalWidth, height: 1412)
            #expect(resolved(.zero, natural: natural).width == floorWidth)
            #expect(
                resolved(ProposedViewSize(width: 100, height: 100), natural: natural).width
                    == floorWidth)
        }
    }

    @Test("the ideal reports the content's own size, floored")
    func idealIsNotCapped() {
        // Also deliberate: the ideal is what NavigationSplitView distributes
        // column width from. Capping it would understate the detail column
        // against the sidebar and inspector, and it is not a growth path —
        // AppKit sizes the window from contentMinSize, verified at runtime by
        // the `window-size` probe's content-growth check.
        let natural = CGSize(width: 1121, height: 400)
        #expect(resolved(ProposedViewSize(width: nil, height: nil), natural: natural).width == 1121)
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
        // Tripwire, not a layout model: the numbers below mirror values that
        // live at their use sites, so update them together.
        //   sidebarColumnMin / inspectorColumnIdeal — RootView's
        //     `navigationSplitViewColumnWidth(min: 230, …)` and
        //     `inspectorColumnWidth(min: 300, ideal: 360, …)`.
        //   defaultWindow — `SergeCodeApp.body`'s `.defaultSize`.
        //   titlebarAndSplitChrome — measured remainder on the mock shell
        //     (window minimum 1100 with 280 floor, 230 sidebar, 360 inspector).
        let sidebarColumnMin: CGFloat = 230
        let inspectorColumnIdeal: CGFloat = 360
        let titlebarAndSplitChrome = CGSize(width: 230, height: 156)
        let defaultWindow = CGSize(width: 1100, height: 720)

        let windowMinimum = CGSize(
            width: WindowSizing.minContentWidth + sidebarColumnMin + inspectorColumnIdeal
                + titlebarAndSplitChrome.width,
            height: WindowSizing.minContentHeight + titlebarAndSplitChrome.height)

        // The shell must never open already at its own minimum — that is the
        // state where AppKit used to grow the window on the next content change.
        #expect(windowMinimum.width <= defaultWindow.width)
        #expect(windowMinimum.height <= defaultWindow.height)
    }
}
