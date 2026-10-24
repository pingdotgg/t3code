import Foundation
import Testing
@testable import T3Code

@Suite("Review guide tour")
struct FeatureReviewGuideTests {
    @Test func excerptsKeepReplacementPairsAndRespectSidesAndHunks() {
        let lines: [PullRequestDiffLine] = [
            .init(id: 0, kind: .header, text: "@@ -4,2 +4,2 @@", oldLine: nil, newLine: nil),
            .init(id: 1, kind: .deleted, text: "-before", oldLine: 4, newLine: nil),
            .init(id: 2, kind: .added, text: "+after", oldLine: nil, newLine: 4),
            .init(id: 3, kind: .context, text: " kept", oldLine: 5, newLine: 5),
            .init(id: 4, kind: .deleted, text: "-elsewhere", oldLine: 6, newLine: nil),
            .init(id: 5, kind: .header, text: "@@ -20,0 +20,1 @@", oldLine: nil, newLine: nil),
            .init(id: 6, kind: .added, text: "+separate", oldLine: nil, newLine: 20),
        ]
        #expect(FeatureReviewGuideTour.excerptLines(lines, excerpt: excerpt(side: .new, line: 4)).map(\.id) == [1, 2])
        #expect(FeatureReviewGuideTour.excerptLines(lines, excerpt: excerpt(side: .old, line: 4)).map(\.id) == [1, 2])
        #expect(FeatureReviewGuideTour.excerptLines(lines, excerpt: excerpt(side: .new, line: 20)).map(\.id) == [6])
        #expect(FeatureReviewGuideTour.excerptLines(lines, excerpt: excerpt(side: .old, line: 20)).isEmpty)
        #expect(FeatureReviewGuideTour.excerptLines(lines, excerpt: excerpt(side: .old, line: 6)).map(\.id) == [4])
    }

    @Test func tourIdentityChangesWhenTheSameHeadIsRewritten() {
        let guide = PullRequestReviewGuide(headSha: "head", generatedAt: "new-time",
            modelSelection: .init(instanceId: "provider", model: "model"), stops: [])
        let selection = FeatureReviewGuideStopSelection(headSha: "head", generatedAt: "old-time", position: 0)
        #expect(!selection.matches(guide))
        #expect(FeatureReviewGuideTour.step(0, by: -1, count: 3) == 0)
        #expect(FeatureReviewGuideTour.step(2, by: 1, count: 3) == 2)
        #expect(FeatureReviewGuideTour.step(0, by: 1, count: 0) == 0)
        #expect(FeatureReviewGuideTour.marker(25) == "Z")
        #expect(FeatureReviewGuideTour.marker(26) == "27")
    }

    @MainActor
    @Test func disabledHostsDoNotReadOrGenerateGuides() async {
        let client = ReviewGuideTestClient()
        client.access = .init(enabled: false, canWrite: true)
        let model = FeatureReviewGuideModel(client: client, target: target)
        await model.refresh()
        await model.generate()
        #expect(client.reads == 0)
        #expect(client.writes == 0)
        #expect(model.data == nil)
    }

    @MainActor
    @Test func readOnlyClientsCanReadAndPermissionIsCheckedAgainBeforeGeneration() async {
        let client = ReviewGuideTestClient()
        client.access = .init(enabled: true, canWrite: false)
        let model = FeatureReviewGuideModel(client: client, target: target)
        await model.refresh()
        await model.generate()
        #expect(client.reads == 1)
        #expect(client.writes == 0)
        client.access = .init(enabled: true, canWrite: true)
        await model.refresh()
        client.access = .init(enabled: true, canWrite: false)
        await model.generate()
        #expect(client.writes == 0)
        #expect(!model.canWrite)
    }

    @MainActor
    @Test func acceptedGenerationRetainsTheSavedGuideWhileRunningAndStopsDuplicateStarts() async {
        let client = ReviewGuideTestClient()
        let saved = PullRequestReviewGuide(headSha: "old", generatedAt: "time",
            modelSelection: .init(instanceId: "provider", model: "model"), stops: [])
        client.result = .init(guide: saved, run: nil, currentHeadSha: "head")
        let model = FeatureReviewGuideModel(client: client, target: target)
        await model.refresh()
        client.result = .init(guide: saved, run: .running(headSha: "head", startedAt: "time"), currentHeadSha: "head")
        await model.generate()
        await model.generate()
        #expect(client.writes == 1)
        #expect(model.running)
        #expect(model.data?.guide == saved)
        #expect(model.data?.isStale == true)
        #expect(!model.canWrite)
    }

    private func excerpt(side: PullRequestReviewGuideExcerpt.Side, line: Int) -> PullRequestReviewGuideExcerpt {
        .init(path: "file.swift", side: side, start: line, end: line, caption: "")
    }

    private var target: FeaturePullRequestTarget {
        .init(environmentID: "origin", environmentName: "Origin",
              reference: .init(projectId: "project", repository: "org/repo", number: 1, host: "github.com"))
    }
}

@MainActor
private final class ReviewGuideTestClient: FeatureReviewGuideClient {
    var access = FeatureReviewGuideAccess(enabled: true, canWrite: true)
    var result = PullRequestReviewGuideResult(guide: nil, run: nil, currentHeadSha: "head")
    var reads = 0
    var writes = 0

    func reviewGuideAccess(_ target: FeaturePullRequestTarget) async throws -> FeatureReviewGuideAccess { access }
    func pullRequestReviewGuide(_ target: FeaturePullRequestTarget) async throws -> PullRequestReviewGuideResult {
        reads += 1
        return result
    }
    func generatePullRequestReviewGuide(_ target: FeaturePullRequestTarget) async throws -> PullRequestReviewGuideResult {
        writes += 1
        return result
    }
}
