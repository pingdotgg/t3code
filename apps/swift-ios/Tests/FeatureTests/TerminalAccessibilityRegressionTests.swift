import Testing
import UIKit
@testable import T3Code

struct TerminalAccessibilityRegressionTests {
    @Test
    @MainActor
    func terminalAccessibilityReadsCurrentOutputWithoutDependingOnVoiceOverStartTime() throws {
        let view = GhosttyTerminalView()
        view.buffer = "first\n\u{1B}[32msecond\u{1B}[0m"
        let viewport = try #require(
            view.subviews.first { $0.accessibilityLabel == "Terminal output" }
        )

        #expect(viewport.accessibilityValue == "first\nsecond")
        #expect(
            TerminalAccessibilityPaging.rowOffset(for: .down, visibleRows: 24) == 23
        )
        #expect(
            TerminalAccessibilityPaging.rowOffset(for: .up, visibleRows: 24) == -23
        )
    }

}
