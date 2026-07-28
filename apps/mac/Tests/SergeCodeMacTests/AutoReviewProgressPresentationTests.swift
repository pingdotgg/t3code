import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Auto-review progress")
struct AutoReviewProgressPresentationTests {
    @Test("only auto-review statuses map to progress")
    func phaseMapping() {
        #expect(AutoReviewProgressPhase(status: .reviewing) == .reviewing)
        #expect(AutoReviewProgressPhase(status: .fixing) == .fixing)
        #expect(AutoReviewProgressPhase(status: .readyToMerge) == .readyToMerge)

        for status in [
            ThreadStatus.idle, .running, .waiting, .waitingApproval, .waitingInput,
            .backgroundWork, .error, .archived, .settled, .done,
        ] {
            #expect(AutoReviewProgressPhase(status: status) == nil)
        }
    }

    @Test("stages are ordered and fully described")
    func stagePresentation() {
        for (index, phase) in AutoReviewProgressPhase.allCases.enumerated() {
            #expect(phase.stepIndex == index)
            #expect(!AutoReviewProgressPresentation.headline(for: phase).isEmpty)
            #expect(!AutoReviewProgressPresentation.detail(for: phase).isEmpty)
            #expect(!AutoReviewProgressPresentation.symbolName(for: phase).isEmpty)
            #expect(
                AutoReviewProgressPresentation.accessibilityLabel(for: phase)
                    .contains(AutoReviewProgressPresentation.headline(for: phase)))
        }
    }

    @Test("only the terminal announcement retires itself")
    func terminalDwell() {
        #expect(AutoReviewProgressPresentation.dwell(for: .reviewing) == nil)
        #expect(AutoReviewProgressPresentation.dwell(for: .fixing) == nil)
        #expect(AutoReviewProgressPresentation.dwell(for: .readyToMerge) == 8)
    }
}
