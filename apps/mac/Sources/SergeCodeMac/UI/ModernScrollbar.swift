import AppKit
import SwiftUI

/// Visual constants for the app's slim overlay scrollbar. Pure value math so
/// the geometry is unit-testable without a live `NSScroller`.
enum ModernScrollbarStyle {
    /// Resting knob thickness. Slim enough to read as chrome, not a control.
    static let knobThickness: CGFloat = 4
    /// Gap between the knob and the scroller's outer (trailing) edge.
    static let trailingInset: CGFloat = 3
    /// Small inset at both ends so the capsule floats instead of touching
    /// the viewport edges.
    static let endInset: CGFloat = 2
    static let restingAlpha: CGFloat = 0.30
    static let pressedAlpha: CGFloat = 0.55

    static func knobColor(pressed: Bool) -> NSColor {
        NSColor.labelColor.withAlphaComponent(pressed ? pressedAlpha : restingAlpha)
    }

    /// Slim, trailing-edge-aligned drawing rect inside the slot AppKit
    /// reserves for the knob. Length is AppKit's own — it already enforces a
    /// usable minimum and maps it to the scroll position — so we only thin
    /// the slot and hug the trailing edge.
    static func knobRect(for slot: CGRect) -> CGRect {
        let width = min(knobThickness, slot.width)
        let x = slot.maxX - trailingInset - width
        let height = max(0, slot.height - endInset * 2)
        return CGRect(x: x, y: slot.minY + endInset, width: width, height: height)
    }
}

/// Slim capsule scrollbar that replaces the default overlay scroller in the
/// chat timeline. AppKit keeps owning behavior — auto fade-in/out while
/// scrolling, knob drag, hit testing — this class only takes over drawing so
/// the knob renders as a quiet pill instead of the stock Tahoe bar.
final class ModernOverlayScroller: NSScroller {
    override class var isCompatibleWithOverlayScrollers: Bool { true }

    init() {
        super.init(frame: .zero)
        scrollerStyle = .overlay
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("ModernOverlayScroller is created programmatically")
    }

    /// No slot/track chrome — the knob floats over the content.
    override func drawKnobSlot(in _: NSRect, highlight _: Bool) {}

    override func drawKnob() {
        let slot = rect(for: .knob)
        guard !slot.isEmpty else { return }
        let knob = ModernScrollbarStyle.knobRect(for: slot)
        guard knob.height > 0, knob.width > 0 else { return }
        let pressed = isHighlighted && hitPart == .knob
        ModernScrollbarStyle.knobColor(pressed: pressed).setFill()
        NSBezierPath(
            roundedRect: knob, xRadius: knob.width / 2, yRadius: knob.width / 2
        ).fill()
    }
}

/// Zero-size probe that installs `ModernOverlayScroller` on the SwiftUI
/// `ScrollView` it is placed inside.
///
/// SwiftUI owns the underlying `NSScrollView`, so styling has to happen from
/// within: this representable walks its superview chain to the enclosing
/// scroll view and swaps the vertical scroller. The swap is one-way and
/// idempotent — SwiftUI only toggles `isHidden` on the scroller afterwards,
/// so the custom instance persists for the scroll view's lifetime.
struct ModernScrollbarInstaller: NSViewRepresentable {
    func makeNSView(context _: Context) -> NSView {
        let view = NSView(frame: .zero)
        scheduleInstall(from: view)
        return view
    }

    func updateNSView(_ nsView: NSView, context _: Context) {
        scheduleInstall(from: nsView)
    }

    /// The probe can be created before SwiftUI has attached it to the scroll
    /// view hierarchy, so installation retries briefly instead of assuming
    /// the first pass lands.
    private func scheduleInstall(from view: NSView, attemptsRemaining: Int = 10) {
        DispatchQueue.main.async { [weak view] in
            guard let view else { return }
            Self.install(from: view, attemptsRemaining: attemptsRemaining)
        }
    }

    private static func install(from view: NSView, attemptsRemaining: Int) {
        var node = view.superview
        while let current = node {
            if let scrollView = current as? NSScrollView {
                if !(scrollView.verticalScroller is ModernOverlayScroller) {
                    scrollView.verticalScroller = ModernOverlayScroller()
                }
                return
            }
            node = current.superview
        }
        guard attemptsRemaining > 0 else { return }
        DispatchQueue.main.async { [weak view] in
            guard let view else { return }
            install(from: view, attemptsRemaining: attemptsRemaining - 1)
        }
    }
}
