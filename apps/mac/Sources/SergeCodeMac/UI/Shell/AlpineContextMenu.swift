import AppKit
import SwiftUI

/// Which mouse events count as a request for a context menu. Pure, and split
/// out from the `NSView` below so the rule is testable without synthesizing
/// an `NSEvent` or standing up a window.
enum AlpineContextMenuInput {
    /// macOS opens context menus on right-click and on ⌃-click. AppKit only
    /// rewrites the latter into `rightMouseDown` for views that expose an
    /// `NSMenu`, and ours deliberately does not, so both forms are recognised
    /// here. Dragged/up variants are included because `hitTest` is consulted
    /// for the whole event sequence, not just the initial press — claiming
    /// only the `down` would hand the rest of the drag to the row below.
    static func isSecondaryClick(
        type: NSEvent.EventType,
        modifiers: NSEvent.ModifierFlags
    ) -> Bool {
        switch type {
        case .rightMouseDown, .rightMouseUp, .rightMouseDragged:
            return true
        case .leftMouseDown, .leftMouseUp, .leftMouseDragged:
            return modifiers.contains(.control)
        default:
            return false
        }
    }
}

/// Anchoring for a popover-based context menu: the menu hangs off the exact
/// point that was clicked, the way a native menu does, rather than off the
/// centre of the row. Pure so the clamping rule is testable.
enum AlpineContextMenuGeometry {
    /// The click point, held inside the view that was clicked. A click lands
    /// on the row's very edge often enough (and AppKit reports points a hair
    /// outside `bounds` during a drag) that an unclamped anchor would place
    /// the popover's arrow off the row.
    static func clamp(_ point: CGPoint, in size: CGSize) -> CGPoint {
        CGPoint(
            x: min(max(point.x, 0), max(size.width, 0)),
            y: min(max(point.y, 0), max(size.height, 0)))
    }

    /// SwiftUI attaches popovers to a rect, not a point. A degenerate rect at
    /// the click point is what makes the arrow land under the cursor.
    static func anchorRect(at point: CGPoint) -> CGRect {
        CGRect(origin: point, size: CGSize(width: 1, height: 1))
    }

    /// Where a menu opened without a cursor hangs from: the bottom edge,
    /// centred, so a VoiceOver "show menu" drops it under the focused row the
    /// way a click near the row's middle would.
    static func focusAnchor(in size: CGSize) -> CGPoint {
        clamp(CGPoint(x: size.width / 2, y: size.height), in: size)
    }
}

/// Transparent overlay that claims *only* secondary clicks. Everything else —
/// row selection, hover, and the buttons living inside a row — keeps falling
/// through to the SwiftUI content underneath, because `hitTest` refuses the
/// event unless it is a right- or ⌃-click.
private struct SecondaryClickCatcher: NSViewRepresentable {
    let onSecondaryClick: (CGPoint) -> Void

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.onSecondaryClick = onSecondaryClick
        return view
    }

    func updateNSView(_ nsView: CatcherView, context: Context) {
        nsView.onSecondaryClick = onSecondaryClick
    }

    final class CatcherView: NSView {
        var onSecondaryClick: ((CGPoint) -> Void)?

        /// Flipped so a converted window point already sits in SwiftUI's
        /// top-left space and the anchor needs no second conversion.
        override var isFlipped: Bool { true }

        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let event = NSApp.currentEvent,
                AlpineContextMenuInput.isSecondaryClick(
                    type: event.type, modifiers: event.modifierFlags)
            else { return nil }
            return super.hitTest(point)
        }

        /// AppKit asks the hit view for a menu before delivering the click.
        /// Answering nil is what keeps the native menu out of the picture —
        /// including the one an ancestor (the sidebar's table view) would
        /// otherwise supply.
        override func menu(for event: NSEvent) -> NSMenu? { nil }

        override func rightMouseDown(with event: NSEvent) {
            report(event)
        }

        override func mouseDown(with event: NSEvent) {
            // Only reachable for ⌃-click, since `hitTest` refuses plain left
            // clicks; a plain one arriving anyway belongs to the row below.
            guard
                AlpineContextMenuInput.isSecondaryClick(
                    type: event.type, modifiers: event.modifierFlags)
            else {
                super.mouseDown(with: event)
                return
            }
            report(event)
        }

        private func report(_ event: NSEvent) {
            let local = convert(event.locationInWindow, from: nil)
            onSecondaryClick?(AlpineContextMenuGeometry.clamp(local, in: bounds.size))
        }
    }
}

private struct AlpineContextMenuModifier<MenuContent: View>: ViewModifier {
    let width: CGFloat
    let menu: (@escaping () -> Void) -> MenuContent

    @UIState private var isPresented = false
    @UIState private var anchor: CGPoint = .zero
    /// Size of the row the menu belongs to, so an invocation that carries no
    /// cursor position still has somewhere to anchor.
    @UIState private var rowSize: CGSize = .zero

    func body(content: Content) -> some View {
        content
            .overlay {
                SecondaryClickCatcher(onSecondaryClick: present)
            }
            .onGeometryChange(for: CGSize.self) { $0.size } action: { rowSize = $0 }
            // A mouse is not the only way to ask for a context menu, and
            // `.contextMenu` answered the other way too: VoiceOver's "show
            // menu" (VO-Shift-M) reaches an element through AXShowMenu. macOS
            // has no system keyboard chord for a list row's menu — Finder has
            // none either — so this is the invocation path that had to be
            // replaced rather than dropped along with the NSMenu.
            .accessibilityAction(.showMenu) {
                present(at: AlpineContextMenuGeometry.focusAnchor(in: rowSize))
            }
            .popover(
                isPresented: $isPresented,
                attachmentAnchor: .rect(.rect(AlpineContextMenuGeometry.anchorRect(at: anchor))),
                arrowEdge: .bottom
            ) {
                ComposerPickerSurface(width: width) {
                    menu { isPresented = false }
                }
            }
    }

    private func present(at point: CGPoint) {
        Haptics.play(.selection)
        guard isPresented else {
            anchor = point
            isPresented = true
            return
        }
        // A second right-click while the menu is up should move it, and a
        // popover cannot be re-anchored while shown — dismiss, then reopen at
        // the new point once SwiftUI has torn the old one down.
        isPresented = false
        Task { @MainActor in
            anchor = point
            isPresented = true
        }
    }
}

extension View {
    /// The app's own context menu: a secondary click opens an Alpine
    /// popover anchored at the cursor instead of the native `NSMenu` that
    /// `.contextMenu` produces, so secondary-click menus read as part of this
    /// app rather than as a system control that wandered in.
    ///
    /// The content builder receives a `dismiss` closure — a row that performs
    /// an action must call it, and a row that opens a second page must not.
    /// Wrap rows in `AlpineMenuList` and separate groups with
    /// `AlpineMenuSeparator` so every menu shares one rhythm.
    ///
    /// Invocation matches `.contextMenu`: right-click, ⌃-click, and VoiceOver's
    /// AXShowMenu action.
    func alpineContextMenu<Content: View>(
        width: CGFloat = 260,
        @ViewBuilder content: @escaping (_ dismiss: @escaping () -> Void) -> Content
    ) -> some View {
        modifier(AlpineContextMenuModifier(width: width, menu: content))
    }
}
