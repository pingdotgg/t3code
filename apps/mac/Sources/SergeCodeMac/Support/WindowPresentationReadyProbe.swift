import AppKit
import SwiftUI

/// Signals after the containing AppKit window has ordered on screen.
///
/// Search fields inside transient popovers can vend a remote completion view.
/// Focusing one before its `NSPopover` window has finished ordering raises an
/// uncaught `NSInternalInconsistencyException` in `NSRemoteView` on macOS 27.
/// Observing the actual window lifecycle is deterministic; a fixed delay is not.
struct WindowPresentationReadyProbe: NSViewRepresentable {
    let onReady: @MainActor () -> Void

    func makeNSView(context: Context) -> WindowPresentationReadyView {
        WindowPresentationReadyView(onReady: onReady)
    }

    func updateNSView(_ nsView: WindowPresentationReadyView, context: Context) {
        nsView.onReady = onReady
    }
}

@MainActor
final class WindowPresentationReadyView: NSView {
    var onReady: @MainActor () -> Void

    private weak var observedWindow: NSWindow?
    private var visibilityObservation: NSKeyValueObservation?
    private var readinessScheduled = false

    init(onReady: @escaping @MainActor () -> Void) {
        self.onReady = onReady
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stopWaiting()

        guard let window else { return }
        observedWindow = window
        visibilityObservation = window.observe(\.isVisible, options: [.new]) {
            [weak self, weak window] _, change in
            guard change.newValue == true else { return }
            DispatchQueue.main.async { [weak self, weak window] in
                self?.scheduleReadiness(for: window)
            }
        }

        if window.isVisible {
            scheduleReadiness(for: window)
        }
    }

    private func stopWaiting() {
        visibilityObservation?.invalidate()
        visibilityObservation = nil
        readinessScheduled = false
        observedWindow = nil
    }

    private func scheduleReadiness(for window: NSWindow?) {
        guard let window,
            self.window === window,
            observedWindow === window,
            !readinessScheduled
        else { return }

        readinessScheduled = true
        // Continue on the next main-queue turn so the ordering transaction has
        // finished without relying on a display interval.
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window,
                self.window === window,
                self.observedWindow === window
            else { return }

            self.readinessScheduled = false
            guard window.isVisible else { return }
            self.onReady()
            self.stopWaiting()
        }
    }

}
