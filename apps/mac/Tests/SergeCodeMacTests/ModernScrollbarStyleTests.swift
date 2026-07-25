import AppKit
import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Modern scrollbar style")
@MainActor
struct ModernScrollbarStyleTests {
    @Test("knob hugs the trailing edge at a fixed slim thickness")
    func knobTrailingEdgeAndThickness() {
        let knob = ModernScrollbarStyle.knobRect(
            for: CGRect(x: 0, y: 0, width: 15, height: 200))
        #expect(knob.width == ModernScrollbarStyle.knobThickness)
        #expect(knob.maxX == 15 - ModernScrollbarStyle.trailingInset)
        // Vertical extent stays centered: equal insets at both ends.
        #expect(knob.midY == 100)
        #expect(knob.minY == ModernScrollbarStyle.endInset)
        #expect(knob.height == 200 - ModernScrollbarStyle.endInset * 2)
    }

    @Test("narrow slots never overflow their bounds")
    func narrowSlotClamps() {
        let knob = ModernScrollbarStyle.knobRect(
            for: CGRect(x: 10, y: 40, width: 2, height: 80))
        #expect(knob.width == 2)
        #expect(knob.maxX <= 12)
        #expect(knob.minY == 42)
    }

    @Test("zero-length slots produce an empty, drawable-safe rect")
    func zeroLengthSlot() {
        let knob = ModernScrollbarStyle.knobRect(
            for: CGRect(x: 0, y: 0, width: 15, height: 1))
        #expect(knob.height == 0)
    }

    @Test("pressed knob is more opaque than resting")
    func pressedMoreOpaque() {
        #expect(ModernScrollbarStyle.pressedAlpha > ModernScrollbarStyle.restingAlpha)
        let resting = ModernScrollbarStyle.knobColor(pressed: false)
        let pressed = ModernScrollbarStyle.knobColor(pressed: true)
        #expect(pressed.alphaComponent > resting.alphaComponent)
    }

    @Test("custom scroller is an overlay-style vertical scroller")
    func scrollerConfiguration() {
        let scroller = ModernOverlayScroller()
        #expect(scroller.scrollerStyle == .overlay)
        #expect(ModernOverlayScroller.isCompatibleWithOverlayScrollers)
    }
}
