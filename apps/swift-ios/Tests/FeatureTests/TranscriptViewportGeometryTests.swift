import Testing
@testable import T3Code

@Suite("Transcript viewport anchoring")
struct TranscriptViewportGeometryTests {
    @Test
    func firstLoadedTranscriptAnchorsToLatestMessage() {
        let empty = TranscriptViewportGeometry(
            contentHeight: 0,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )
        let loaded = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )

        #expect(
            loaded.restoredBottomOffset(
                after: empty,
                maintainsBottomAnchor: true,
                isInteracting: false
            ) == 500
        )
    }

    @Test
    func keyboardViewportChangeKeepsLatestMessageVisible() {
        let beforeKeyboard = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )
        let afterKeyboard = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 400,
            topInset: 0,
            bottomInset: 0
        )

        #expect(
            afterKeyboard.restoredBottomOffset(
                after: beforeKeyboard,
                maintainsBottomAnchor: true,
                isInteracting: false
            ) == 800
        )
    }

    @Test
    func readerPositionIsUntouchedAwayFromLatestMessage() {
        let beforeKeyboard = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )
        let afterKeyboard = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 400,
            topInset: 0,
            bottomInset: 0
        )

        #expect(
            afterKeyboard.restoredBottomOffset(
                after: beforeKeyboard,
                maintainsBottomAnchor: false,
                isInteracting: false
            ) == nil
        )
    }

    @Test
    func activeTranscriptGestureOwnsItsScrollPosition() {
        let before = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )
        let after = TranscriptViewportGeometry(
            contentHeight: 1_260,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )

        #expect(
            after.restoredBottomOffset(
                after: before,
                maintainsBottomAnchor: true,
                isInteracting: true
            ) == nil
        )
    }
}
