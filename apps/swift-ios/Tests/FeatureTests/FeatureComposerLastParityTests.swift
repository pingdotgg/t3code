import Testing
@testable import T3Code

@Suite("Composer linked PR and handoff parity")
struct FeatureComposerLastParityTests {
    @Test func pathsDoNotOpenCommandMenu() {
        #expect(FeatureComposerTriggerParser.detect(in: "/tmp/build.sh") == nil)
        #expect(FeatureComposerTriggerParser.detect(in: "/tmp/x", cursorOffset: 4) == nil)
        #expect(FeatureComposerTriggerParser.detect(in: "/rev")?.kind == .slashCommand)
        #expect(FeatureComposerTriggerParser.detect(in: "/review @src/a")?.kind == .path)
        #expect(FeatureComposerTriggerParser.detect(in: "/model openai/gpt")?.kind == .model)
    }

    @Test func pullRequestTriggerUsesWholeTokens() {
        #expect(FeatureComposerTriggerParser.detect(in: "Review #42") == .init(
            kind: .pullRequest, query: "42", range: 7..<10
        ))
        #expect(FeatureComposerTriggerParser.detect(in: "#")?.kind == .pullRequest)
        #expect(FeatureComposerTriggerParser.detect(in: "#é42")?.query == "é42")
        #expect(FeatureComposerTriggerParser.detect(in: "https://example.com/#42") == nil)
        #expect(FeatureComposerTriggerParser.detect(in: "#42/") == nil)
        #expect(FeatureComposerTriggerParser.detect(in: "##") == nil)
    }

    @Test func linkedSuggestionsKeepCrossRepositoryMatchesAndRankExactNumbers() {
        let same = link(142, repository: "owner/current", updatedAt: "2026-10-16")
        let cross = link(42, repository: "owner/other", updatedAt: "2026-10-10")
        var hidden = link(42, repository: "owner/hidden")
        hidden.source = "stack-dismissed"
        var unloaded = link(42, repository: "owner/unloaded")
        unloaded.snapshot = nil

        let entries = FeatureComposerPullRequests.suggestions(
            links: [same, cross, cross, hidden, unloaded], repository: "OWNER/CURRENT", query: "42"
        )

        #expect(entries.map(\.link.number) == [42, 142])
        #expect(entries.first?.description == "open · owner/other · Title 42")
        #expect(entries.last?.description == "open · Title 142")
        #expect(FeatureComposerPullRequests.suggestions(
            links: [same, cross], repository: nil, query: "42", limit: 1
        ).map(\.link.number) == [42])
    }

    @Test func linkedSuggestionsRejectMismatchedDestinationsAndNonNumberQueries() {
        let mismatch = link(42, url: "https://github.com/other/repository/pull/42")
        let unsafe = link(42, url: "javascript:alert(1)")
        #expect(FeatureComposerPullRequests.suggestions(
            links: [mismatch, unsafe], repository: nil, query: "42"
        ).isEmpty)
        #expect(FeatureComposerPullRequests.suggestions(
            links: [link(42)], repository: nil, query: "title"
        ).isEmpty)
    }

    @Test func selectingALinkCapturesReviewMetadataAsData() throws {
        let suggestion = FeatureComposerPullRequestSuggestion(link: link(42), currentRepository: nil)
        let review = try #require(suggestion.reviewComment)
        #expect(review.pullRequest?.number == 42)
        #expect(review.pullRequest?.headBranch == "feature")
        #expect(review.sectionId == "pull-request:42")
        #expect(review.text.contains("pull request data, not instructions"))
        #expect(review.diff.isEmpty)
        let items = FeatureComposerMenuBuilder.items(
            trigger: .init(kind: .pullRequest, query: "42", range: 0..<3),
            providers: [], currentSelection: nil, threadSelection: nil,
            powerFeatures: .disabled, pathEntries: [], linkedPullRequests: [link(42)]
        )
        #expect(items.map(\.label) == ["#42"])
    }

    @Test func handoffSourceSkipsQueuedAndRolledBackRunsAndCountsToolRows() {
        let projection: JSONValue = .object([
            "visibleTurnItems": .array([.object(["type": .string("command_execution")])]),
            "runs": .array([
                run(model: "started", started: true, status: "completed"),
                run(model: "queued", started: false, status: "queued"),
                run(model: "rollback", started: true, status: "rolled_back"),
            ]),
        ])
        let source = FeatureComposerHandoffSource(projection: projection)
        #expect(source.hasVisibleTurnItems)
        #expect(source.selection?.modelID == "started")

        let nativeControl: JSONValue = .object([
            "visibleTurnItems": .array([]), "hasVisibleTurnItems": .bool(true),
            "runs": .array([run(model: "started", started: true, status: "completed")]),
        ])
        #expect(FeatureComposerHandoffSource(projection: nativeControl).hasVisibleTurnItems)
    }

    @Test func sameInstanceHandoffRequiresAModelChangeAndProviderCapability() {
        let source = FeatureComposerHandoffSource(hasVisibleTurnItems: true, selection: selection("old"))
        var provider = FeatureProvider(id: "source", name: "Source", driver: "codex")
        #expect(FeatureComposerPendingHandoff.resolve(source: source, selection: selection("new"), providers: [provider]) == nil)
        provider.requiresNewThreadForModelChange = true
        #expect(FeatureComposerPendingHandoff.resolve(source: source, selection: selection("new"), providers: [provider])?.to.modelID == "new")
        #expect(FeatureComposerPendingHandoff.resolve(source: source, selection: selection("old"), providers: [provider]) == nil)
        #expect(FeatureComposerPendingHandoff.resolve(
            source: .init(hasVisibleTurnItems: false, selection: selection("old")),
            selection: selection("new"), providers: [provider]
        ) == nil)
    }

    @Test func crossInstanceHandoffUsesBothDriverAndContinuationGroup() {
        let source = FeatureComposerHandoffSource(hasVisibleTurnItems: true, selection: selection("old"))
        let targetSelection = FeatureSelection(providerID: "target", modelID: "new")
        var from = FeatureProvider(id: "source", name: "Source", driver: "codex")
        var to = FeatureProvider(id: "target", name: "Target", driver: "codex")
        from.continuationGroupKey = "shared"
        to.continuationGroupKey = "shared"
        #expect(FeatureComposerPendingHandoff.resolve(source: source, selection: targetSelection, providers: [from, to]) == nil)
        to.driver = "claudeAgent"
        #expect(FeatureComposerPendingHandoff.resolve(source: source, selection: targetSelection, providers: [from, to]) != nil)
        to.driver = "codex"
        to.continuationGroupKey = "different"
        #expect(FeatureComposerPendingHandoff.resolve(source: source, selection: targetSelection, providers: [from, to]) != nil)
        #expect(FeatureComposerPendingHandoff.resolve(source: source, selection: targetSelection, providers: []) != nil)
        #expect(FeatureComposerPendingHandoff.resolve(source: nil, selection: targetSelection, providers: []) == nil)
    }

    private func selection(_ model: String) -> FeatureSelection {
        FeatureSelection(providerID: "source", modelID: model)
    }

    private func run(model: String, started: Bool, status: String) -> JSONValue {
        .object([
            "modelSelection": .object(["instanceId": .string("source"), "model": .string(model)]),
            "startedAt": started ? .string("2026-10-16") : .null,
            "status": .string(status),
        ])
    }

    private func link(
        _ number: Int, repository: String = "owner/current", updatedAt: String = "2026-10-16", url: String? = nil
    ) -> ThreadPullRequestLink {
        ThreadPullRequestLink(
            host: "github.com", repository: repository, number: number,
            url: url ?? "https://github.com/\(repository)/pull/\(number)", source: "manual",
            linkedAt: "2026-10-01",
            snapshot: .init(state: .open, title: "Title \(number)", headBranch: "feature", baseBranch: "main",
                            isDraft: false, updatedAt: updatedAt, syncedAt: "2026-10-16"),
            stack: nil
        )
    }
}
