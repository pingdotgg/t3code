import SwiftUI

/// Defers a state-changing animation by one main-runloop turn. SwiftUI can
/// re-vend AppKit layout items while a window is mid-layout; changing measured
/// content synchronously can trip AppKit's layout-feedback-loop guard on
/// macOS 26/27 (`_postWindowNeedsUpdateConstraints`).
@MainActor
func withDeferredAnimation(
    _ animation: Animation,
    action: @escaping @MainActor @Sendable () -> Void
) {
    DispatchQueue.main.async {
        withAnimation(animation, action)
    }
}

/// Marks a state change as a user-initiated disclosure toggle (a click on a
/// tool row, plan card, or Show More button). `ChatTimelineScrollView` clears
/// `transaction.animation` on the streaming timeline to stop layout churn —
/// a deliberate click deserves its animation even mid-run, so the suppressor
/// lets marked transactions through.
private enum IntentionalDisclosureKey: TransactionKey {
    static let defaultValue = false
}

extension Transaction {
    var isIntentionalDisclosure: Bool {
        get { self[IntentionalDisclosureKey.self] }
        set { self[IntentionalDisclosureKey.self] = newValue }
    }
}

/// `withDeferredAnimation` for disclosure toggles: defers one runloop turn
/// (the AppKit layout-feedback-loop guard above), then applies the animation
/// via a transaction marked as user-initiated so timeline-level animation
/// suppression does not flatten the expand/collapse the user just asked for.
@MainActor
func withDeferredDisclosureAnimation(
    _ animation: Animation = Motion.structure,
    action: @escaping @MainActor @Sendable () -> Void
) {
    DispatchQueue.main.async {
        var transaction = Transaction(animation: animation)
        transaction.isIntentionalDisclosure = true
        withTransaction(transaction, action)
    }
}
