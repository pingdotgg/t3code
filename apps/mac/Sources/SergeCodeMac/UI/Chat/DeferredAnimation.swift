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
