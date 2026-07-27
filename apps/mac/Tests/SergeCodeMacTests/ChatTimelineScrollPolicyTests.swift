import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Chat timeline scroll policy")
struct ChatTimelineScrollPolicyTests {
    @Test("near-bottom uses a fixed threshold from the content edge")
    func nearBottomThreshold() {
        // Viewport bottom is 40pt from the content edge — inside the 48pt
        // threshold, so it counts as near.
        #expect(
            ChatTimelineScrollPolicy.isNearBottom(
                contentOffsetY: 960,
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
        // One point past the threshold does not.
        #expect(
            !ChatTimelineScrollPolicy.isNearBottom(
                contentOffsetY: 951,
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

    @Test("mid-run flattening spares entrance and disclosure transactions")
    func animationFlattening() {
        // Settled timeline: nothing is flattened.
        #expect(
            !ChatTimelineScrollPolicy.shouldFlattenAnimation(
                suppressLayoutAnimation: false,
                isIntentionalDisclosure: false,
                isEntranceAnimation: false))
        // Mid-run, unmarked updates (streaming churn, regroups) flatten.
        #expect(
            ChatTimelineScrollPolicy.shouldFlattenAnimation(
                suppressLayoutAnimation: true,
                isIntentionalDisclosure: false,
                isEntranceAnimation: false))
        // Row entrances pierce the suppressor — without this, arriving tool
        // rows pop in mid-run instead of animating.
        #expect(
            !ChatTimelineScrollPolicy.shouldFlattenAnimation(
                suppressLayoutAnimation: true,
                isIntentionalDisclosure: false,
                isEntranceAnimation: true))
        // User-initiated disclosure toggles keep their animation too.
        #expect(
            !ChatTimelineScrollPolicy.shouldFlattenAnimation(
                suppressLayoutAnimation: true,
                isIntentionalDisclosure: true,
                isEntranceAnimation: false))
    }

    @Test("layout animation is suppressed until a selection has settled")
    func layoutSuppressionWindows() {
        // A settled thread, sitting still, with its first layout behind it:
        // the only state in which the stack may animate at all.
        #expect(
            !ChatTimelineScrollPolicy.suppressesLayoutAnimation(
                hasPendingInitialAnchor: false,
                hasSettledInitialLayout: true,
                threadIsSettled: true,
                isUserScrolling: false))
        // Just switched threads: hydration swaps the whole snapshot and the
        // chrome above lands its own animations, while the pin-scroll chases
        // the resulting height. Hold still.
        #expect(
            ChatTimelineScrollPolicy.suppressesLayoutAnimation(
                hasPendingInitialAnchor: false,
                hasSettledInitialLayout: false,
                threadIsSettled: true,
                isUserScrolling: false))
        // The three long-standing windows.
        #expect(
            ChatTimelineScrollPolicy.suppressesLayoutAnimation(
                hasPendingInitialAnchor: true,
                hasSettledInitialLayout: true,
                threadIsSettled: true,
                isUserScrolling: false))
        #expect(
            ChatTimelineScrollPolicy.suppressesLayoutAnimation(
                hasPendingInitialAnchor: false,
                hasSettledInitialLayout: true,
                threadIsSettled: false,
                isUserScrolling: false))
        #expect(
            ChatTimelineScrollPolicy.suppressesLayoutAnimation(
                hasPendingInitialAnchor: false,
                hasSettledInitialLayout: true,
                threadIsSettled: true,
                isUserScrolling: true))
    }
}
