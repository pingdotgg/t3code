import Testing
@testable import T3Code

@Suite("Thread keyboard dismissal")
struct ThreadKeyboardDismissTests {
    @Test
    func threadDismissControlAppearsWhileTheKeyboardIsUp() {
        #expect(FeatureComposerKeyboardDismissPolicy.showsDismissControl(
            isFocused: true,
            isEnabled: true,
            canDismiss: true
        ))
    }

    @Test
    func dismissControlStaysHiddenWithoutEveryRequirement() {
        #expect(FeatureComposerKeyboardDismissPolicy.showsDismissControl(
            isFocused: false,
            isEnabled: true,
            canDismiss: true
        ) == false)
        #expect(FeatureComposerKeyboardDismissPolicy.showsDismissControl(
            isFocused: true,
            isEnabled: false,
            canDismiss: true
        ) == false)
        #expect(FeatureComposerKeyboardDismissPolicy.showsDismissControl(
            isFocused: true,
            isEnabled: true,
            canDismiss: false
        ) == false)
    }

    @Test
    func dismissingTheKeyboardLeavesADraftedComposerExpanded() {
        // Dismissal only drops focus. A composer holding a long draft must stay
        // expanded so the draft is still visible and still editable.
        #expect(FeatureComposerCollapsePolicy.shouldCollapse(
            isFocused: false,
            textIsEmpty: false,
            attachmentsAreEmpty: true,
            isAttachmentFlowActive: false,
            isPreparingAttachments: false
        ) == false)
    }
}
