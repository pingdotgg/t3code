import SwiftUI
import UIKit

/// A responder the drawer may return focus to after it gives up ownership.
///
/// The protocol keeps the ownership decision testable without a live keyboard.
/// UIKit responders use the conformance below in the running app.
@MainActor
protocol FeatureCommandDrawerRestorableResponder: AnyObject {
    var canRestoreCommandDrawerFocus: Bool { get }
    @discardableResult func restoreCommandDrawerFocus() -> Bool
}

extension UIResponder: FeatureCommandDrawerRestorableResponder {
    var canRestoreCommandDrawerFocus: Bool {
        guard canBecomeFirstResponder || isFirstResponder else { return false }
        guard let view = commandDrawerRestorationView else { return false }
        guard let window = view.window,
              !window.isHidden,
              window.alpha > 0.01,
              window.isUserInteractionEnabled else { return false }

        var ancestor: UIView? = view
        while let candidate = ancestor {
            guard !candidate.isHidden,
                  candidate.alpha > 0.01,
                  candidate.isUserInteractionEnabled else { return false }
            if let control = candidate as? UIControl, !control.isEnabled {
                return false
            }
            ancestor = candidate.superview
        }
        return true
    }

    private var commandDrawerRestorationView: UIView? {
        if let view = self as? UIView { return view }
        if let viewController = self as? UIViewController {
            return viewController.viewIfLoaded
        }

        var candidate = next
        while let responder = candidate {
            if let view = responder as? UIView { return view }
            if let viewController = responder as? UIViewController {
                return viewController.viewIfLoaded
            }
            candidate = responder.next
        }
        return nil
    }

    @discardableResult
    func restoreCommandDrawerFocus() -> Bool {
        becomeFirstResponder()
    }
}

/// Owns the responder handoff for one drawer presentation lifecycle.
///
/// The prior responder is captured once, before drawer search takes focus. A
/// short abandoned pull restores it. A completed open keeps the ownership
/// token until the drawer closes, then restores the same responder only if the
/// view still belongs to a visible window. No delay or global keyboard reset is
/// involved.
@MainActor
final class FeatureCommandDrawerResponderOwnership {
    private weak var priorResponder: (any FeatureCommandDrawerRestorableResponder)?
    private(set) var ownsFocusTransfer = false

    func begin(from responder: (any FeatureCommandDrawerRestorableResponder)?) {
        guard !ownsFocusTransfer else { return }
        priorResponder = responder
        ownsFocusTransfer = true
    }

    /// Keeps ownership while open. Settling closed ends the lifecycle and
    /// restores the responder that owned focus before the pull.
    @discardableResult
    func settle(open: Bool) -> Bool {
        guard !open else { return false }
        return finish(restoringPrior: true)
    }

    /// A recognizer cancellation returns to the rest state it began from. A
    /// cancelled opening pull restores the prior responder; cancelling a close
    /// keeps the drawer's existing ownership token.
    @discardableResult
    func cancel(returningToOpen open: Bool) -> Bool {
        settle(open: open)
    }

    /// Selection can close the drawer while navigating elsewhere. That path
    /// explicitly declines restoration so an old composer cannot steal focus
    /// from the destination.
    @discardableResult
    func close(restoringPrior: Bool = true) -> Bool {
        finish(restoringPrior: restoringPrior)
    }

    @discardableResult
    private func finish(restoringPrior: Bool) -> Bool {
        guard ownsFocusTransfer else { return false }
        let responder = priorResponder
        priorResponder = nil
        ownsFocusTransfer = false
        guard restoringPrior,
              let responder,
              responder.canRestoreCommandDrawerFocus else {
            return false
        }
        return responder.restoreCommandDrawerFocus()
    }
}

@MainActor
private final class FeatureCommandDrawerResponderProbe: NSObject {
    weak var responder: UIResponder?
}

private extension UIResponder {
    @objc func captureCommandDrawerFirstResponder(
        _ probe: FeatureCommandDrawerResponderProbe
    ) {
        probe.responder = self
    }
}

enum FeatureCommandDrawerResponderLookup {
    /// Finds the exact UIKit responder before drawer search asks for focus.
    /// The responder chain answers this directly, avoiding a synchronous walk
    /// over a long transcript's full UIKit view tree.
    @MainActor
    static func firstResponder(in window: UIWindow?) -> UIResponder? {
        guard let window else { return nil }
        let probe = FeatureCommandDrawerResponderProbe()
        UIApplication.shared.sendAction(
            #selector(UIResponder.captureCommandDrawerFirstResponder(_:)),
            to: nil,
            from: probe,
            for: nil
        )
        guard let responder = probe.responder,
              owningWindow(of: responder) === window else { return nil }
        return responder
    }

    @MainActor
    private static func owningWindow(of responder: UIResponder) -> UIWindow? {
        if let window = responder as? UIWindow { return window }
        if let view = responder as? UIView { return view.window }
        if let viewController = responder as? UIViewController {
            return viewController.viewIfLoaded?.window
        }

        var next = responder.next
        while let candidate = next {
            if let window = candidate as? UIWindow { return window }
            if let view = candidate as? UIView, let window = view.window { return window }
            next = candidate.next
        }
        return nil
    }
}

/// The command gesture uses a native pan recognizer for the same reason the
/// detail surface's back swipe does: a SwiftUI `DragGesture` can begin before
/// it knows the axis of the motion and would compete with Home's recycled
/// collection view and the thread transcript. This recognizer refuses every
/// touch that does not start in the drawer's grab band, so ordinary list
/// scrolling is never a candidate for the palette.
struct FeatureCommandDrawerGestureView: UIViewRepresentable {
    let reveal: CGFloat
    let isOpen: Bool
    let onBegan: (UIResponder?) -> Void
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat) -> Void
    let onCancelled: () -> Void

    static func cancelsActiveDragWhenUninstalled(
        state: UIGestureRecognizer.State
    ) -> Bool {
        state == .began || state == .changed
    }

    static func takesPriority(over recognizer: UIGestureRecognizer) -> Bool {
        guard let scrollView = recognizer.view as? UIScrollView else { return false }
        return recognizer === scrollView.panGestureRecognizer
    }

    @MainActor
    static func afterCurrentViewUpdate(_ action: @escaping @MainActor () -> Void) {
        Task { @MainActor in action() }
    }

    /// Text entry owns its own drags for caret and selection handles.
    @MainActor
    static func isTextEntry(_ view: UIView?) -> Bool {
        var current = view
        while let candidate = current {
            if candidate is UITextField { return true }
            if let textView = candidate as? UITextView,
               textView.isEditable || textView.isFirstResponder {
                return true
            }
            current = candidate.superview
        }
        return false
    }

    @MainActor
    static func canReceiveTouch(
        view: UIView?,
        location: CGPoint,
        window: UIWindow?,
        gestureHost: UIView?,
        reveal: CGFloat,
        topInset: CGFloat,
        hasPresentedViewController: Bool
    ) -> Bool {
        guard let window,
              let gestureHost,
              window === gestureHost.window,
              !hasPresentedViewController,
              window.bounds.contains(location),
              FeatureCommandDrawerGesture.canBeginTouch(
                  atY: location.y,
                  reveal: reveal,
                  topInset: topInset
              ) else {
            return false
        }
        return !isTextEntry(view)
    }

    func makeUIView(context: Context) -> InstallerView {
        let view = InstallerView()
        apply(to: view)
        return view
    }

    func updateUIView(_ view: InstallerView, context: Context) {
        apply(to: view)
    }

    static func dismantleUIView(_ view: InstallerView, coordinator: ()) {
        view.uninstallGesture()
    }

    private func apply(to view: InstallerView) {
        view.update(
            reveal: reveal,
            isOpen: isOpen,
            onBegan: onBegan,
            onChanged: onChanged,
            onEnded: onEnded,
            onCancelled: onCancelled
        )
    }

    final class InstallerView: UIView {
        private var reveal: CGFloat = 0
        private var isOpen = false
        private var onBegan: ((UIResponder?) -> Void)?
        private var onChanged: ((CGFloat) -> Void)?
        private var onEnded: ((CGFloat) -> Void)?
        private var onCancelled: (() -> Void)?
        private weak var gestureHost: UIView?
        private var panGesture: UIPanGestureRecognizer?
        private var gestureDelegate: GestureDelegate?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil {
                uninstallGesture()
            } else {
                installGestureIfPossible()
            }
        }

        func update(
            reveal: CGFloat,
            isOpen: Bool,
            onBegan: @escaping (UIResponder?) -> Void,
            onChanged: @escaping (CGFloat) -> Void,
            onEnded: @escaping (CGFloat) -> Void,
            onCancelled: @escaping () -> Void
        ) {
            self.reveal = reveal
            self.isOpen = isOpen
            self.onBegan = onBegan
            self.onChanged = onChanged
            self.onEnded = onEnded
            self.onCancelled = onCancelled
            installGestureIfPossible()
        }

        func uninstallGesture() {
            let removedGesture = panGesture
            let removedHost = gestureHost
            let cancellation = onCancelled
            let shouldCancel = removedGesture.map {
                FeatureCommandDrawerGestureView.cancelsActiveDragWhenUninstalled(
                    state: $0.state
                )
            } ?? false

            if let removedGesture, let removedHost {
                removedHost.removeGestureRecognizer(removedGesture)
            }
            panGesture = nil
            gestureDelegate = nil
            gestureHost = nil

            if shouldCancel {
                // UIKit teardown can happen during `updateUIView`. Cross that
                // transaction boundary before mutating the owning SwiftUI state.
                FeatureCommandDrawerGestureView.afterCurrentViewUpdate {
                    cancellation?()
                }
            }
        }

        // SwiftUI hosts this representable beside, rather than above, the
        // workspace, so install on their shared root view. Touch eligibility is
        // scoped in window coordinates by the drawer's current grab band.
        private func installGestureIfPossible() {
            guard let window, let host = window.rootViewController?.view else { return }
            guard gestureHost !== host else { return }

            uninstallGesture()
            let panGesture = UIPanGestureRecognizer(
                target: self,
                action: #selector(handlePan(_:))
            )
            let gestureDelegate = GestureDelegate(owner: self)
            panGesture.delegate = gestureDelegate
            panGesture.cancelsTouchesInView = false
            panGesture.delaysTouchesBegan = false
            panGesture.maximumNumberOfTouches = 1
            host.addGestureRecognizer(panGesture)
            gestureHost = host
            self.panGesture = panGesture
            self.gestureDelegate = gestureDelegate
        }

        @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
            switch gesture.state {
            case .began:
                onBegan?(FeatureCommandDrawerResponderLookup.firstResponder(in: window))
                onChanged?(gesture.translation(in: gesture.view).y)
            case .changed:
                onChanged?(gesture.translation(in: gesture.view).y)
            case .ended:
                onEnded?(gesture.velocity(in: gesture.view).y)
            case .cancelled, .failed:
                onCancelled?()
            default:
                break
            }
        }

        // Window coordinates keep the grab band unambiguous: the closed drawer's
        // edge is the window's own top safe-area boundary, which is also where
        // the app's top bar starts, so the band needs no SwiftUI measurement.
        fileprivate func canReceive(_ touch: UITouch) -> Bool {
            let location = touch.location(in: nil)
            return FeatureCommandDrawerGestureView.canReceiveTouch(
                view: touch.view,
                location: location,
                window: window,
                gestureHost: gestureHost,
                reveal: reveal,
                topInset: window?.safeAreaInsets.top ?? 0,
                hasPresentedViewController:
                    window?.rootViewController?.presentedViewController != nil
            )
        }

        fileprivate func canBegin(with gesture: UIPanGestureRecognizer) -> Bool {
            FeatureCommandDrawerGesture.shouldBegin(
                velocity: gesture.velocity(in: gesture.view),
                translation: gesture.translation(in: gesture.view),
                isOpen: isOpen
            )
        }

        private final class GestureDelegate: NSObject, UIGestureRecognizerDelegate {
            weak var owner: InstallerView?

            init(owner: InstallerView) {
                self.owner = owner
            }

            func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
                guard let owner,
                      let panGesture = gestureRecognizer as? UIPanGestureRecognizer else {
                    return false
                }
                return owner.canBegin(with: panGesture)
            }

            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldReceive touch: UITouch
            ) -> Bool {
                owner?.canReceive(touch) ?? false
            }

            // The command gesture deliberately does not run alongside scroll
            // views. It can only begin in the grab band, and inside that band it
            // owns the drag outright rather than nudging a list at the same time.
            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
            ) -> Bool {
                otherGestureRecognizer is UIScreenEdgePanGestureRecognizer
            }

            /// Inside the narrow grab band the drawer wins over a scroll view's
            /// pan recognizer. Without an explicit ordering, Home's collection
            /// view can cross its threshold first and prevent the drawer from
            /// ever receiving `.began`.
            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
            ) -> Bool {
                FeatureCommandDrawerGestureView.takesPriority(
                    over: otherGestureRecognizer
                )
            }
        }
    }
}
