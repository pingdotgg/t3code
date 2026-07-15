import Foundation
import Testing
@testable import SergeCodeMac

@Suite("Composer performance policy")
struct ComposerPerformancePolicyTests {
    @Test("defers suggestion parsing for the defined large-paste benchmark")
    func largePasteBenchmark() {
        let payload = String(repeating: "x", count: 1_024 * 1_024)

        #expect(ComposerPerformancePolicy.shouldDeferSuggestions(for: payload))
    }

    @Test("keeps normal-sized drafts on the existing suggestion path")
    func normalDraftsRemainInteractive() {
        let payload = String(repeating: "x", count: ComposerPerformancePolicy.largeDraftThreshold - 1)

        #expect(!ComposerPerformancePolicy.shouldDeferSuggestions(for: payload))
    }
}
