import Testing

@testable import SergeCodeMac

@Suite("PR merge celebration")
@MainActor
struct MergeCelebrationTests {
    private func makeModel() -> AppModel {
        AppModel(backend: MockBackend())
    }

    @Test("successful merge sets a celebration carrying the outcome title")
    func mergeSuccessSetsCelebration() async {
        let model = makeModel()
        model.selectedThreadID = "thread-1"

        await model.runGitAction(.mergePR, commitMessage: nil)

        let celebration = model.mergeCelebration
        #expect(celebration != nil)
        #expect(celebration?.title == "Merged PR #1")
    }

    @Test("other successful git actions do not celebrate")
    func nonMergeActionDoesNotCelebrate() async {
        let model = makeModel()
        model.selectedThreadID = "thread-1"

        await model.runGitAction(.push, commitMessage: nil)

        #expect(model.mergeCelebration == nil)
        #expect(model.lastGitActionOutcome(for: "thread-1")?.success == true)
    }

    @Test("clearing removes only the matching celebration")
    func clearIgnoresStaleID() async {
        let model = makeModel()
        model.selectedThreadID = "thread-1"

        await model.runGitAction(.mergePR, commitMessage: nil)
        guard let first = model.mergeCelebration else {
            Issue.record("merge should set a celebration")
            return
        }

        // A stale dismiss (e.g. the first celebration's timer firing after a
        // second merge) must not remove the newer celebration.
        model.clearMergeCelebration(id: MergeCelebration(title: "other").id)
        #expect(model.mergeCelebration == first)

        model.clearMergeCelebration(id: first.id)
        #expect(model.mergeCelebration == nil)
    }
}
