import Foundation
import Testing
@testable import T3Code

@Suite("Platform prompt links")
struct PlatformPromptLinkTests {
    @Test
    func hostedAndNativePromptsUseFormQueryDecoding() throws {
        let expected = PlatformNewThreadLink.new(
            prompt: .init(text: "Rate me + you", hiddenCharacters: 0),
            repository: .init(owner: "pingdotgg", name: "t3code"), provider: "codex", model: "Small"
        )
        for base in ["https://app.t3.codes/new", "t3code://new", "t3code-dev://new", "t3code-swiftui-dev://new"] {
            #expect(try PlatformDeepLinkParser.parse(
                base + "?prompt=Rate+me+%2B+you&repo=https://github.com/pingdotgg/t3code.git&provider=Codex&model=Small"
            ) == .newPrompt(environmentID: nil, projectID: nil, link: expected))
        }
        let route = PlatformRoute.newPrompt(environmentID: "remote", projectID: "project", link: expected)
        #expect(try PlatformDeepLinkParser.parse(#require(route.url)) == route)
    }

    @Test
    func duplicatePromptParametersUseTheFirstValueIncludingEmptyValues() throws {
        let route = try PlatformDeepLinkParser.parse("t3code://new?prompt=first&prompt=second")
        guard case let .newPrompt(_, _, link) = route else { Issue.record("Expected linked prompt"); return }
        #expect(link.prompt?.text == "first")
        #expect(throws: (any Error).self) { try PlatformDeepLinkParser.parse("t3code://new?prompt=&prompt=second") }
    }

    @Test
    func linkedThreadPromptsKeepEnvironmentScopeAndRoundTripLiteralPluses() throws {
        let expected = PlatformRoute.threadPrompt(environmentID: "second", threadID: "same",
                                                   prompt: .init(text: "Fix + review", hiddenCharacters: 0))
        #expect(try PlatformDeepLinkParser.parse("https://app.t3.codes/second/same?prompt=Fix+%2B+review") == expected)
        #expect(try PlatformDeepLinkParser.parse("t3code://threads/second/same?prompt=Fix+%2B+review") == expected)
        #expect(try PlatformDeepLinkParser.parse(#require(expected.url)) == expected)
        #expect(try PlatformDeepLinkParser.parse("t3code://threads/second/same?prompt=+")
            == .thread(environmentID: "second", threadID: "same"))
    }

    @Test
    func promptNavigationRejectsLookalikeOriginsCredentialsAndPorts() {
        for value in [
            "https://evil.example/new?prompt=hello", "https://app.t3.codes.evil.example/new?prompt=hello",
            "https://user@app.t3.codes/new?prompt=hello", "https://app.t3.codes:444/new?prompt=hello",
            "http://app.t3.codes/new?prompt=hello", "https://t3.codes/new?prompt=hello",
            "t3code://user@new?prompt=hello", "t3code://new:123?prompt=hello",
        ] {
            #expect(throws: (any Error).self) { try PlatformDeepLinkParser.parse(value) }
        }
    }

    @Test
    func sanitizationCountsScalarsAndKeepsEmojiJoiners() throws {
        let family = "👨‍👩‍👧 ❤️"
        #expect(PlatformPromptLinkParser.sanitize(family) == .init(text: family, hiddenCharacters: 0))
        #expect(PlatformPromptLinkParser.sanitize(" a\u{200B}b\u{202E}c\u{FEFF}\u{E0041}\u{E0042}\r\nx\u{2028}y ")
            == .init(text: "abc\nx\ny", hiddenCharacters: 5))
        #expect(PlatformPromptLinkParser.sanitize("a\u{200D}b").hiddenCharacters == 1)
        #expect(PlatformPromptLinkParser.sanitize("\u{20000}\u{200D}\u{20001}").hiddenCharacters == 1)
        #expect(throws: (any Error).self) { try PlatformPromptLinkParser.prompt("\u{200B}") }
    }

    @Test
    func persistedPromptRouteKeepsTheHiddenCharacterWarning() throws {
        let route = try PlatformDeepLinkParser.parse("t3code://new?prompt=hello%E2%80%8B")
        let restored = try JSONDecoder().decode(PlatformRoute.self, from: JSONEncoder().encode(route))
        #expect(restored == route)
        guard case let .newPrompt(_, _, link) = restored else { Issue.record("Expected prompt route"); return }
        #expect(link.prompt?.hiddenCharacters == 1)
        #expect(link.prompt?.text == "hello")
    }

    @Test
    func promptLengthUsesUTF16BeforeRemovingHiddenCharacters() throws {
        #expect(try PlatformPromptLinkParser.prompt(String(repeating: "😀", count: 4_000)) != nil)
        #expect(throws: (any Error).self) { try PlatformPromptLinkParser.prompt(String(repeating: "😀", count: 4_001)) }
        #expect(throws: (any Error).self) { try PlatformPromptLinkParser.prompt(String(repeating: "\u{200B}", count: 8_001)) }
    }

    @Test
    func repositoriesAndPullRequestsUseTheSharedGithubValidation() throws {
        for value in ["pingdotgg/t3code/42", "pingdotgg/t3code#42", "https://github.com/pingdotgg/t3code/pull/42/files"] {
            #expect(PlatformPromptLinkParser.pullRequest(value)?.number == 42)
        }
        for value in ["../etc", "a/..", "https://evil.example/a/b", "https://github.com/a/b?x=y", "https://user@github.com/a/b"] {
            #expect(PlatformPromptLinkParser.repository(value) == nil)
        }
        for value in ["a/b#0", "a/b#9007199254740992", "https://github.com/a/b/pull/-1"] {
            #expect(PlatformPromptLinkParser.pullRequest(value) == nil)
        }
        guard case let .pullRequest(pr, prompt) = try PlatformPromptLinkParser.newThread(["pr": "a/b#7"]) else {
            Issue.record("Expected PR link without prompt"); return
        }
        #expect(pr.number == 7)
        #expect(prompt == nil)
    }

    @Test
    func projectMatchingUsesForkOriginAndEnvironmentScopedActivity() {
        let repository = PlatformPromptRepository(owner: "PingDotGG", name: "T3Code")
        let first = project("first", environment: "a")
        let second = project("second", environment: "b")
        var fork = project("fork", environment: "a")
        fork.repositoryIdentity?.origin = .init(canonicalKey: "github.com/me/t3code", displayName: nil)
        let activity = [thread("old", environment: "a", project: "same", updated: 1),
                        thread("new", environment: "b", project: "same", updated: 2)]
        #expect(PlatformPromptLinkResolver.project(in: [fork, first, second], threads: activity, repository: repository)?.id == second.id)
        #expect(PlatformPromptLinkResolver.project(in: [first, second], threads: [], repository: repository)?.id == first.id)
        let link = PlatformNewThreadLink.new(prompt: .init(text: "hello", hiddenCharacters: 0), repository: repository, provider: nil, model: nil)
        let snapshot = FeatureSnapshot(environments: [environment("a"), environment("b")], projects: [first, second], threads: activity)
        #expect(PlatformPromptLinkResolver.destination(for: link, in: snapshot, environmentID: "a", projectID: "same") == .project(first))
        #expect(PlatformPromptLinkResolver.destination(for: link, in: snapshot, projectID: "same")
            == .unavailable("That project is not available on this device."))
    }

    @Test
    func prResolutionUsesLatestVisibleLinkAndDoesNotUseBranchDetection() throws {
        let pr = try #require(PlatformPromptLinkParser.pullRequest("pingdotgg/t3code#7"))
        var older = thread("older", environment: "a", project: "same", updated: 1)
        older.linkedPullRequest = .init(projectId: "same", repository: pr.repository.fullName, number: 7, url: pr.url)
        var newer = thread("newer", environment: "b", project: "same", updated: 2)
        newer.pullRequests = [prLink(pr)]
        var dismissed = thread("dismissed", environment: "a", project: "same", updated: 3)
        dismissed.pullRequests = [prLink(pr, source: "stack-dismissed")]
        dismissed.linkedPullRequest = older.linkedPullRequest
        var detected = thread("detected", environment: "a", project: "same", updated: 4)
        detected.branchPullRequest = older.linkedPullRequest
        #expect(PlatformPromptLinkResolver.pullRequestThread(in: [older, newer, dismissed, detected], pullRequest: pr)?.id == newer.id)
        let snapshot = FeatureSnapshot(environments: [environment("a"), environment("b")], projects: [project("p", environment: "a")],
                                       threads: [older, newer, dismissed, detected])
        #expect(PlatformPromptLinkResolver.destination(for: .pullRequest(pr, prompt: nil), in: snapshot, environmentID: "a") == .thread(older))
    }

    @Test
    func scratchChoosesRecentConnectedCapableEnvironment() {
        var offline = environment("offline")
        offline.connectionState = .disconnected
        let snapshot = FeatureSnapshot(environments: [environment("a"), environment("b"), offline], threads: [
            thread("recent", environment: "b", project: "p", updated: 3),
            thread("latest", environment: "offline", project: "p", updated: 4),
        ])
        #expect(PlatformPromptLinkResolver.scratchEnvironment(in: snapshot) == "b")
        #expect(PlatformPromptLinkResolver.scratchEnvironment(in: snapshot, environmentID: "a") == "a")
        #expect(PlatformPromptLinkResolver.scratchEnvironment(in: snapshot, environmentID: "offline") == nil)
    }

    @Test
    func modelSelectionStaysInTheDestinationEnvironmentAndFallsBack() {
        var provider = FeatureProvider(id: "work", name: "Claude", driver: "claudeAgent", models: [
            .init(id: "small", name: "Small"), .init(id: "large", name: "Large", isDefault: true),
        ])
        provider.status = "ready"
        let snapshot = FeatureSnapshot(providers: [provider], providersByEnvironment: ["remote": [provider]])
        #expect(PlatformPromptLinkResolver.modelSelection(in: snapshot, environmentID: "remote", provider: "claude", model: "SMALL")
            == .init(selection: .init(providerID: "work", modelID: "small"), exact: true))
        #expect(PlatformPromptLinkResolver.modelSelection(in: snapshot, environmentID: "remote", provider: "claude", model: "unknown")
            == .init(selection: .init(providerID: "work", modelID: "large"), exact: false))
        #expect(PlatformPromptLinkResolver.modelSelection(in: snapshot, environmentID: "local", provider: "claude", model: "small") == nil)
    }

    @Test
    func linkedTextPreservesDraftMetadataAndDoesNotDuplicate() {
        let prompt = PlatformLinkedPrompt(text: "Review this", hiddenCharacters: 0)
        let original = FeatureComposerDraft(text: "My draft", selection: .init(providerID: "work", modelID: "large"),
                                            workspace: .init(mode: .worktree, branch: "feature", worktreePath: nil, startFromOrigin: false),
                                            runtimeMode: .approvalRequired, interactionMode: .plan)
        let updated = prompt.appending(to: original)
        #expect(updated.text == "My draft\n\nReview this")
        #expect(updated.selection == original.selection)
        #expect(updated.workspace == original.workspace)
        #expect(updated.runtimeMode == original.runtimeMode)
        #expect(updated.interactionMode == original.interactionMode)
        #expect(prompt.appending(to: updated) == updated)
        #expect(prompt.applying(to: original) == nil)
        #expect(prompt.draftAction(currentText: "My draft") == .ask)
    }

    @Test
    func restoringUnavailableDraftModelKeepsItsExactChoiceAndBlocksSend() throws {
        var provider = FeatureProvider(id: "saved", name: "Saved", models: [.init(id: "chosen", name: "Chosen")])
        provider.isAvailable = false
        let choice = FeatureSelection(providerID: "saved", modelID: "chosen",
            options: [.init(id: "effort", value: .string("high"))])
        let fallback = FeatureSelection(providerID: "other", modelID: "default")
        let context = NewTaskDraftRestoreContext(projectID: "project", baseline: .init())
        let restored = try context.merging(saved: .init(text: "Keep my draft", selection: choice), current: .init(),
            fallbackSelection: fallback)
        let selection = NewTaskDraftRestoreContext.modelSelection(restoring: restored.selection, in: [provider], fallback: fallback)
        #expect(selection == choice)
        #expect(!ProjectProviderModelPolicy.canSelect(selection, in: [provider]))
    }

    @Test
    func modelAliasesPreferReadyProviderOverWarningProvider() {
        var model = FeatureModel(id: "slug", name: "Display name", isDefault: true)
        model.aliases = ["short"]
        var warning = FeatureProvider(id: "warning", name: "Warning", driver: "codex", models: [model])
        warning.status = "warning"
        var ready = FeatureProvider(id: "ready", name: "Ready", driver: "codex", models: [model])
        ready.status = "ready"
        let snapshot = FeatureSnapshot(providersByEnvironment: ["remote": [warning, ready]])
        #expect(PlatformPromptLinkResolver.modelSelection(in: snapshot, environmentID: "remote", provider: "codex", model: "SHORT")
            == .init(selection: .init(providerID: "ready", modelID: "slug"), exact: true))
        ready.status = "error"
        ready.isAvailable = false
        warning.status = nil
        let unavailable = FeatureSnapshot(providersByEnvironment: ["remote": [warning, ready]])
        #expect(PlatformPromptLinkResolver.modelSelection(in: unavailable, environmentID: "remote", provider: "codex", model: "short") == nil)
    }

    @Test
    func preparedPullRequestRequiresItsFetchedHeadAndAWorktreePath() throws {
        for response in [
            JSONValue.object(["branch": .string("pr/fork-main"), "worktreePath": .string("/work/pr"), "isOnPullRequestHead": .bool(true)]),
            .object(["branch": .string("pr/fork-main"), "worktreePath": .string("/work/pr")]),
        ] {
            let workspace = try response.decode(PreparedPromptPullRequestWorkspace.self).validatedWorkspace()
            #expect(workspace.branch == "pr/fork-main")
            #expect(workspace.path == "/work/pr")
        }
        for response in [
            JSONValue.object(["branch": .string("main"), "worktreePath": .string("/work/stale"), "isOnPullRequestHead": .bool(false)]),
            .object(["branch": .string("main"), "worktreePath": .null, "isOnPullRequestHead": .bool(true)]),
            .object(["branch": .string("main"), "worktreePath": .string(" "), "isOnPullRequestHead": .bool(true)]),
        ] {
            let prepared = try response.decode(PreparedPromptPullRequestWorkspace.self)
            #expect(throws: FeatureThreadRecoveryError.self) { try prepared.validatedWorkspace() }
        }
    }

    @Test
    func pullRequestReferenceSurvivesDraftRelaunchAndOutboxRecovery() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("drafts.json")
        let reference = "https://github.com/upstream/repo/pull/42"
        let workspace = FeatureComposerWorkspaceDraft(mode: .worktree, branch: "main", worktreePath: nil,
            startFromOrigin: false, pullRequestReference: reference)
        let draft = FeatureComposerDraft(text: "Review fork main", workspace: workspace)
        try await FeatureComposerDraftStore(fileURL: file).setDraft(draft, for: "project")
        #expect(try await FeatureComposerDraftStore(fileURL: file).draft(for: "project") == draft)
        let creation = FeatureQueuedCreation(projectID: "project", projectName: "Repo", workspaceMode: .worktree,
            branch: "main", worktreePath: nil, startFromOrigin: false, pullRequestReference: reference)
        let queued = FeatureQueuedSubmission(environmentID: "remote", identity: .init(), threadID: "pending",
            text: draft.text, selection: nil, runtimeMode: .fullAccess, interactionMode: .standard,
            attachments: [], creation: creation)
        let restored = try JSONDecoder().decode(FeatureQueuedSubmission.self, from: JSONEncoder().encode(queued))
        #expect(try FeatureSubmissionRecoveryDraft(submission: restored, reason: nil).composerDraft().workspace == workspace)
        var legacy = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(creation)) as? [String: Any])
        legacy.removeValue(forKey: "pullRequestReference")
        let oldCreation = try JSONDecoder().decode(FeatureQueuedCreation.self, from: JSONSerialization.data(withJSONObject: legacy))
        #expect(oldCreation.pullRequestReference == nil)
    }

    private func environment(_ id: String) -> FeatureEnvironment {
        var result = FeatureEnvironment(id: id, name: id, endpoint: "https://\(id).example", connectionState: .connected)
        result.supportsScratch = true
        return result
    }

    private func project(_ id: String, environment: String) -> FeatureProject {
        .init(id: id, wireID: "same", environmentID: environment, name: id, path: "/\(id)",
              repositoryIdentity: .init(canonicalKey: "github.com/pingdotgg/t3code"))
    }

    private func thread(_ id: String, environment: String, project: String, updated: TimeInterval) -> FeatureThread {
        .init(id: id, projectID: project, environmentID: environment, title: id,
              updatedAt: Date(timeIntervalSince1970: updated))
    }

    private func prLink(_ pr: PlatformPromptPullRequest, source: String = "created") -> ThreadPullRequestLink {
        .init(host: "github.com", repository: pr.repository.fullName, number: pr.number, url: pr.url,
              source: source, linkedAt: "2026-01-01T00:00:00.000Z", snapshot: nil, stack: nil)
    }
}
