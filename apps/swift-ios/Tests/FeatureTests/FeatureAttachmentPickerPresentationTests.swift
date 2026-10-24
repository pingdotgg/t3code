import Testing
import UIKit
@testable import T3Code

@MainActor
@Suite("Attachment picker dismissal")
struct FeatureAttachmentPickerPresentationTests {
    @Test
    func cancellationBeforeMountDoesNotLeaveARegisteredPresentation() {
        let controller = ControlledPresenter()
        var changes: [Bool] = []
        controller.configuration = configuration { changes.append($0) }
        controller.cancel()

        let window = mount(controller)
        defer { window.rootViewController = nil }
        controller.updatePresentation()

        #expect(controller.presentations == 0)
        #expect(changes.isEmpty)
    }

    @Test
    func cancellationDuringPresentationWaitsForBothTransitions() throws {
        let controller = ControlledPresenter()
        let window = mount(controller)
        defer { window.rootViewController = nil }
        var changes: [Bool] = []
        controller.configuration = configuration { changes.append($0) }
        controller.updatePresentation()
        #expect(changes == [true])

        controller.cancel()
        #expect(controller.dismissals == 0)
        try controller.completePresentation()
        #expect(controller.dismissals == 1)
        #expect(changes == [true])

        try controller.completeDismissal()
        #expect(changes == [true, false])
        controller.updatePresentation()
        #expect(controller.presentations == 1)
    }

    @Test
    func mountedDialogReportsCompletionOnlyAfterUIKitDismissal() throws {
        let controller = ControlledPresenter()
        let window = mount(controller)
        defer { window.rootViewController = nil }
        var changes: [Bool] = []
        var finishes = 0
        var options = configuration { changes.append($0) }
        controller.configuration = FeatureAttachmentPickerPresenter(
            requestID: options.requestID, maximumCount: 4,
            imagesAllowed: true, videosAllowed: false,
            onPresentationChange: options.onPresentationChange,
            onFinish: { selection in
                #expect(selection == nil)
                finishes += 1
            }
        )
        controller.updatePresentation()
        try controller.completePresentation()
        controller.cancel()
        #expect(changes == [true])
        #expect(finishes == 0)

        try controller.completeDismissal()
        #expect(changes == [true, false])
        #expect(finishes == 1)

        // A stale render of the completed request must not reopen the dialog.
        controller.configuration = options
        controller.updatePresentation()
        #expect(controller.presentations == 1)
        options.requestID = UUID()
        controller.configuration = options
        controller.updatePresentation()
        #expect(controller.presentations == 2)
        try controller.completePresentation()
        controller.cancel()
        try controller.completeDismissal()
    }

    private func configuration(
        onChange: @escaping (Bool) -> Void
    ) -> FeatureAttachmentPickerPresenter {
        FeatureAttachmentPickerPresenter(
            requestID: UUID(), maximumCount: 4,
            imagesAllowed: true, videosAllowed: false,
            onPresentationChange: onChange, onFinish: { _ in }
        )
    }

    private func mount(_ controller: UIViewController) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
        window.rootViewController = controller
        // No key window, actual modal, animation, or timer is needed. The test
        // advances the UIKit completion callbacks in the requested order.
        window.addSubview(controller.view)
        return window
    }

    private final class ControlledPresenter: FeatureAttachmentPickerPresenter.Controller {
        var presentations = 0
        var dismissals = 0
        var presentationCompletion: (() -> Void)?
        var dismissalCompletion: (() -> Void)?

        override func present(
            _ viewControllerToPresent: UIViewController,
            animated flag: Bool,
            completion: (() -> Void)? = nil
        ) {
            presentations += 1
            presentationCompletion = completion
        }

        override func dismissPicker(_ controller: UIViewController, completion: @escaping () -> Void) {
            dismissals += 1
            dismissalCompletion = completion
        }

        func completePresentation() throws {
            let completion = try #require(presentationCompletion)
            presentationCompletion = nil
            completion()
        }

        func completeDismissal() throws {
            let completion = try #require(dismissalCompletion)
            dismissalCompletion = nil
            completion()
        }
    }
}
