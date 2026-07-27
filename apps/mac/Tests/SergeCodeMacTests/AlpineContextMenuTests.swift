import AppKit
import Testing

@testable import SergeCodeMac

/// The two rules the custom context menu rests on: which clicks it claims
/// (claiming too many kills row selection, too few leaves the native menu in
/// place), and where the popover anchors.
@Suite("Alpine context menu")
struct AlpineContextMenuTests {
    @Test("right-click in any phase is a secondary click")
    func rightClickPhasesAreSecondary() {
        for type in [NSEvent.EventType.rightMouseDown, .rightMouseUp, .rightMouseDragged] {
            #expect(
                AlpineContextMenuInput.isSecondaryClick(type: type, modifiers: []),
                "\(type) should open the menu")
        }
    }

    @Test("plain left clicks stay with the row underneath")
    func plainLeftClicksFallThrough() {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp, .leftMouseDragged] {
            #expect(
                !AlpineContextMenuInput.isSecondaryClick(type: type, modifiers: []),
                "\(type) must reach the row so selection still works")
        }
    }

    @Test("control-click is a secondary click")
    func controlClickIsSecondary() {
        #expect(
            AlpineContextMenuInput.isSecondaryClick(type: .leftMouseDown, modifiers: [.control]))
        #expect(
            AlpineContextMenuInput.isSecondaryClick(
                type: .leftMouseUp, modifiers: [.control, .shift]))
    }

    @Test("other modifiers do not turn a left click into a menu request")
    func otherModifiersFallThrough() {
        for modifiers in [
            NSEvent.ModifierFlags.command, .shift, .option, [.command, .shift],
        ] {
            #expect(
                !AlpineContextMenuInput.isSecondaryClick(
                    type: .leftMouseDown, modifiers: modifiers),
                "\(modifiers) is a selection gesture, not a menu request")
        }
    }

    @Test("non-mouse events never open the menu")
    func nonMouseEventsAreIgnored() {
        // `hitTest` is consulted during cursor updates and mouse moves too; a
        // yes there would swallow hover for the whole row.
        for type in [NSEvent.EventType.mouseMoved, .cursorUpdate, .keyDown, .scrollWheel] {
            #expect(!AlpineContextMenuInput.isSecondaryClick(type: type, modifiers: []))
            #expect(!AlpineContextMenuInput.isSecondaryClick(type: type, modifiers: [.control]))
        }
    }

    @Test("a click inside the row anchors where it landed")
    func clickInsideIsUnchanged() {
        let point = AlpineContextMenuGeometry.clamp(
            CGPoint(x: 40, y: 12), in: CGSize(width: 260, height: 28))

        #expect(point == CGPoint(x: 40, y: 12))
    }

    @Test("a click past the row's edges is pulled back inside it")
    func clicksOutsideAreClamped() {
        let size = CGSize(width: 260, height: 28)

        #expect(
            AlpineContextMenuGeometry.clamp(CGPoint(x: -8, y: -3), in: size)
                == CGPoint(x: 0, y: 0))
        #expect(
            AlpineContextMenuGeometry.clamp(CGPoint(x: 900, y: 400), in: size)
                == CGPoint(x: 260, y: 28))
    }

    @Test("an unmeasured row clamps to its origin instead of a negative anchor")
    func zeroSizedRowClampsToOrigin() {
        #expect(
            AlpineContextMenuGeometry.clamp(CGPoint(x: 30, y: 9), in: .zero)
                == .zero)
        // A negative frame is nonsense AppKit has been known to report
        // mid-layout; it must not become a negative anchor.
        #expect(
            AlpineContextMenuGeometry.clamp(
                CGPoint(x: 30, y: 9), in: CGSize(width: -10, height: -10)) == .zero)
    }

    @Test("a cursorless invocation hangs the menu off the row's bottom edge")
    func focusAnchorSitsUnderTheRow() {
        // VoiceOver's "show menu" carries no click point, so the anchor has to
        // come from the row itself — centred on its bottom edge, which puts the
        // popover under the row instead of at the window's origin.
        let anchor = AlpineContextMenuGeometry.focusAnchor(
            in: CGSize(width: 260, height: 28))

        #expect(anchor == CGPoint(x: 130, y: 28))
    }

    @Test("a cursorless invocation on an unmeasured row still anchors in bounds")
    func focusAnchorSurvivesAZeroSizedRow() {
        // The AX action can fire before any geometry has been reported.
        #expect(AlpineContextMenuGeometry.focusAnchor(in: .zero) == .zero)
        #expect(
            AlpineContextMenuGeometry.focusAnchor(in: CGSize(width: -20, height: -20))
                == .zero)
    }

    @Test("the anchor is a unit rect at the cursor, not the whole row")
    func anchorRectSitsAtThePoint() {
        let rect = AlpineContextMenuGeometry.anchorRect(at: CGPoint(x: 40, y: 12))

        #expect(rect.origin == CGPoint(x: 40, y: 12))
        // Non-zero: SwiftUI drops popovers anchored to an empty rect.
        #expect(rect.width > 0)
        #expect(rect.height > 0)
    }
}
