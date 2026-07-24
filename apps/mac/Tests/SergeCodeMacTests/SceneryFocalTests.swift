import SwiftUI
import Testing

@testable import SergeCodeMac

@Suite("Scenery focal")
struct SceneryFocalTests {
    /// The cover-crop anchor must be deterministic at every window size:
    /// center for chrome/blurred variants, top for hero scenes so a wide
    /// window crops the foreground instead of the ridgeline.
    @Test("focal anchors are deterministic", arguments: [
        (SceneryFocal.center, UnitPoint(x: 0.5, y: 0.5)),
        (SceneryFocal.skyline, UnitPoint(x: 0.5, y: 0)),
    ])
    func focalUnitPoints(_ focal: SceneryFocal, _ expected: UnitPoint) {
        #expect(focal.unitPoint == expected)
    }
}
