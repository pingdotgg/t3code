import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Chat timeline scroll policy")
struct ChatTimelineScrollPolicyTests {
    @Test("near-bottom uses a fixed threshold from the content edge")
    func nearBottomThreshold() {
        #expect(
            ChatTimelineScrollPolicy.isNearBottom(
                contentOffsetY: 940,
                containerHeight: 600,
                contentHeight: 1600,
                threshold: 48))
        #expect(
            !ChatTimelineScrollPolicy.isNearBottom(
                contentOffsetY: 900,
                containerHeight: 600,
                contentHeight: 1600,
                threshold: 48))
        // Exactly at threshold counts as near.
        #expect(
            ChatTimelineScrollPolicy.isNearBottom(
                contentOffsetY: 952,
                containerHeight: 600,
                contentHeight: 1600,
                threshold: 48))
    }

    @Test("layout churn never re-pins or unpins on its own")
    func layoutChurnLeavesPinAlone() {
        #expect(
            ChatTimelineScrollPolicy.pinAfterScrollPhase(
                isUserScrolling: false,
                isNearBottom: true,
                currentlyPinned: false) == false)
        #expect(
            ChatTimelineScrollPolicy.pinAfterScrollPhase(
                isUserScrolling: false,
                isNearBottom: false,
                currentlyPinned: true) == true)
    }

    @Test("user scroll drives pin state from near-bottom geometry")
    func userScrollDrivesPin() {
        #expect(
            ChatTimelineScrollPolicy.pinAfterScrollPhase(
                isUserScrolling: true,
                isNearBottom: false,
                currentlyPinned: true) == false)
        #expect(
            ChatTimelineScrollPolicy.pinAfterScrollPhase(
                isUserScrolling: true,
                isNearBottom: true,
                currentlyPinned: false) == true)
    }

    @Test("pinned content follows any height change; unpinned never does")
    func contentSizeFollowRules() {
        #expect(
            ChatTimelineScrollPolicy.shouldFollowContentSizeChange(
                isPinned: true,
                pendingInitialAnchor: false,
                hasContent: true,
                oldHeight: 100,
                newHeight: 140))
        // Shrink while pinned must re-anchor — otherwise LazyVStack collapse
        // leaves the viewport past real content (blank chat).
        #expect(
            ChatTimelineScrollPolicy.shouldFollowContentSizeChange(
                isPinned: true,
                pendingInitialAnchor: false,
                hasContent: true,
                oldHeight: 400,
                newHeight: 40))
        #expect(
            !ChatTimelineScrollPolicy.shouldFollowContentSizeChange(
                isPinned: false,
                pendingInitialAnchor: false,
                hasContent: true,
                oldHeight: 100,
                newHeight: 400))
        #expect(
            !ChatTimelineScrollPolicy.shouldFollowContentSizeChange(
                isPinned: true,
                pendingInitialAnchor: false,
                hasContent: true,
                oldHeight: 100,
                newHeight: 100))
    }

    @Test("pending initial anchor only fires once content exists")
    func pendingInitialAnchor() {
        #expect(
            ChatTimelineScrollPolicy.shouldFollowContentSizeChange(
                isPinned: false,
                pendingInitialAnchor: true,
                hasContent: true,
                oldHeight: 0,
                newHeight: 200))
        #expect(
            !ChatTimelineScrollPolicy.shouldFollowContentSizeChange(
                isPinned: false,
                pendingInitialAnchor: true,
                hasContent: false,
                oldHeight: 0,
                newHeight: 1))
    }
}
