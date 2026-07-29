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
    private var readinessTask: Task<Void, Never>?

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
        readinessTask = Task { @MainActor [weak self, weak window] in
            guard let window else { return }
            while !Task.isCancelled {
                guard self?.window === window,
                    self?.observedWindow === window
                else { return }

                if window.isVisible {
                    // Visibility changes during AppKit's ordering transaction.
                    // Wait one display interval so the remote child view
                    // cannot re-enter that transaction.
                    try? await Task.sleep(for: .milliseconds(16))
                    guard !Task.isCancelled,
                        self?.window === window,
                        window.isVisible
                    else { return }
                    self?.onReady()
                    return
                }

                try? await Task.sleep(for: .milliseconds(16))
            }
        }
    }

    private func stopWaiting() {
        readinessTask?.cancel()
        readinessTask = nil
        observedWindow = nil
    }
}
