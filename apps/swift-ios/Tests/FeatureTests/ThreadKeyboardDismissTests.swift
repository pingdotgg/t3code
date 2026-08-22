import CoreGraphics
import Testing
@testable import T3Code

@Suite("Thread keyboard dismissal")
struct ThreadKeyboardDismissTests {
    @Test
    func reachingBackThroughTheTranscriptDismissesTheKeyboard() {
        // Bottom-anchored transcript: dragging the content down walks backwards
        // through the thread, which is the reader asking for the transcript.
        #expect(TranscriptKeyboardDismissPolicy.shouldDismiss(
            dragOriginY: 900,
            currentY: 860
        ))
    }

    @Test
    func aTwitchDoesNotDismissTheKeyboard() {
        #expect(!TranscriptKeyboardDismissPolicy.shouldDismiss(
            dragOriginY: 900,
            currentY: 895
        ))
        #expect(!TranscriptKeyboardDismissPolicy.shouldDismiss(
            dragOriginY: 900,
            currentY: 900
        ))
    }

    @Test
    func nudgingTowardTheLatestTurnKeepsTheKeyboard() {
        // Upward drags head toward the newest message, not away from the
        // composer, so the draft stays editable.
        #expect(!TranscriptKeyboardDismissPolicy.shouldDismiss(
            dragOriginY: 900,
            currentY: 980
        ))
    }

    @Test
    func dismissControlAppearsOnlyWhileTheKeyboardIsUp() {
        #expect(FeatureComposerKeyboardDismissPolicy.showsDismissControl(
            isFocused: true,
            canDismiss: true
        ))
        #expect(!FeatureComposerKeyboardDismissPolicy.showsDismissControl(
            isFocused: false,
            canDismiss: true
        ))
    }

    @Test
    func composersWithoutADismissHandlerKeepTheirFooterUnchanged() {
        #expect(!FeatureComposerKeyboardDismissPolicy.showsDismissControl(
            isFocused: true,
            canDismiss: false
        ))
    }

    @Test
    func dismissingTheKeyboardLeavesADraftedComposerExpanded() {
        // Dismissal only drops focus. A composer holding a long draft must stay
        // expanded so the draft is still visible and still editable.
        #expect(!FeatureComposerCollapsePolicy.shouldCollapse(
            isFocused: false,
            textIsEmpty: false,
            attachmentsAreEmpty: true,
            isAttachmentFlowActive: false,
            isPreparingAttachments: false
        ))
    }
}
