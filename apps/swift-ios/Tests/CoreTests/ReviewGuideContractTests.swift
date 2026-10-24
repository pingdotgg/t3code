import Foundation
import Testing
@testable import T3Code

@Suite("Review guide wire contract")
struct ReviewGuideContractTests {
    @Test func runningAndFailedRunsRoundTripWithServerTags() throws {
        let running = try JSONDecoder.t3.decode(PullRequestReviewGuideResult.self, from: Data(#"""
        {"guide":null,"run":{"_tag":"Running","headSha":"current","startedAt":"2026-10-16T12:00:00Z"},"currentHeadSha":"current","started":true}
        """#.utf8))
        #expect(running.isRunning)
        #expect(!running.isStale)
        #expect(running.failure == nil)
        #expect(try JSONDecoder.t3.decode(PullRequestReviewGuideResult.self,
                                        from: JSONEncoder.t3.encode(running)) == running)

        let failure = PullRequestReviewGuideResult(guide: nil,
            run: .failed(headSha: "current", failedAt: "2026-10-16T12:01:00Z", detail: "Provider unavailable"),
            currentHeadSha: "current")
        #expect(!failure.isRunning)
        #expect(failure.failure == "Provider unavailable")
        #expect(try JSONDecoder.t3.decode(PullRequestReviewGuideResult.self,
                                        from: JSONEncoder.t3.encode(failure)) == failure)
        #expect(PullRequestReviewGuideResult(guide: nil, run: failure.run, currentHeadSha: "new").failure == nil)
        #expect(PullRequestReviewGuideResult(guide: nil, run: failure.run, currentHeadSha: nil).failure == nil)
    }

    @Test func savedGuideKeepsOptionalFileNotesAndStalenessRequiresAKnownHead() throws {
        let guide = try JSONDecoder.t3.decode(PullRequestReviewGuide.self, from: Data(#"""
        {"headSha":"saved","generatedAt":"2026-10-16T12:00:00Z",
         "modelSelection":{"instanceId":"provider","model":"review-model"},
         "stops":[{"title":"Check the contract","summary":"**Why** this changed",
          "attention":{"kind":"contract","note":"Check callers"},
          "excerpts":[{"path":"new.swift","side":"old","start":4,"end":8,"caption":"Previous behavior"}],
          "files":[{"path":"other.swift"}],
          "notes":[{"path":"new.swift","line":5,"title":"A note","body":"Details"}],
          "questions":["Does the caller handle this?"]}]}
        """#.utf8))
        #expect(guide.stops.first?.files.first?.note == nil)
        #expect(guide.stops.first?.excerpts.first?.side == .old)
        #expect(guide.stops.first?.attention?.kind == .contract)
        #expect(PullRequestReviewGuideResult(guide: guide, run: nil, currentHeadSha: "new").isStale)
        #expect(!PullRequestReviewGuideResult(guide: guide, run: nil, currentHeadSha: nil).isStale)
        #expect(!PullRequestReviewGuideResult(guide: guide, run: nil, currentHeadSha: "saved").isStale)
    }
}
