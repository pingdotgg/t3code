import Foundation
import Testing
@testable import T3Code

@Suite("Web V2 home thread metadata")
struct HomeThreadMetadataTests {
    private let now = Date(timeIntervalSince1970: 10_000)

    @Test
    func statusLabelsFollowTheWebV2RowVocabulary() {
        let expected: [(FeatureThreadState, HomeThreadStatus, String?)] = [
            (.idle, .ready, nil),
            (.queued, .working, "Working"),
            (.working, .working, "Working"),
            (.monitoring, .monitoring, "Monitoring"),
            (.waitingForApproval, .approval, "Approval"),
            (.waitingForInput, .input, "Input"),
            (.failed, .failed, "Failed"),
            (.completed, .done, "Done"),
        ]

        for (state, status, label) in expected {
            let thread = FeatureThread(
                id: state.rawValue,
                projectID: "project",
                title: "Task",
                state: state
            )
            #expect(thread.homeStatus == status)
            #expect(thread.homeStatusLabel == label)
        }
    }

    @Test
    func workingDurationMatchesTheCompactWebFormatAndClampsFutureDates() {
        let thread = FeatureThread(
            id: "working",
            projectID: "project",
            title: "Build",
            state: .working,
            workingStartedAt: now.addingTimeInterval(-5_465)
        )
        let future = FeatureThread(
            id: "queued",
            projectID: "project",
            title: "Queue",
            state: .queued,
            workingStartedAt: now.addingTimeInterval(5)
        )
        let idle = FeatureThread(
            id: "idle",
            projectID: "project",
            title: "Rest",
            state: .idle,
            workingStartedAt: now.addingTimeInterval(-10)
        )
        let monitoring = FeatureThread(
            id: "monitoring",
            projectID: "project",
            title: "Watch",
            state: .monitoring,
            workingStartedAt: now.addingTimeInterval(-10)
        )

        #expect(thread.homeWorkingDuration(at: now) == "1h 31m")
        #expect(future.homeWorkingDuration(at: now) == "0s")
        #expect(idle.homeWorkingDuration(at: now) == nil)
        #expect(monitoring.homeWorkingDuration(at: now) == nil)
    }

    @Test
    func rowAttributionPrefersCurrentEnvironmentNameAndWireProviderName() {
        let thread = FeatureThread(
            id: "thread",
            projectID: "project",
            environmentID: "device",
            environmentName: "Old device name",
            title: "Build",
            branch: "feat/web-v2-home",
            worktreePath: "/worktrees/web-v2-home",
            providerID: "codex-work",
            providerName: "Codex Work"
        )
        let snapshot = FeatureSnapshot(
            environments: [
                FeatureEnvironment(
                    id: "device",
                    name: "leftbook",
                    endpoint: "https://leftbook.example"
                ),
            ],
            projects: [
                FeatureProject(
                    id: "project",
                    environmentID: "device",
                    name: "t3code",
                    path: "/work/t3code"
                ),
            ],
            providers: [FeatureProvider(id: "codex-work", name: "Config name")]
        )

        #expect(thread.homeEnvironmentLabel(in: snapshot) == "leftbook")
        #expect(thread.homeProviderLabel(in: snapshot) == "Codex Work")
        #expect(thread.branch == "feat/web-v2-home")
        #expect(thread.worktreePath == "/worktrees/web-v2-home")
    }

    @Test
    func rowAttributionFallsBackThroughProjectAndProviderCatalog() {
        let thread = FeatureThread(
            id: "thread",
            projectID: "project",
            title: "Build",
            providerID: "claude"
        )
        let snapshot = FeatureSnapshot(
            environments: [
                FeatureEnvironment(
                    id: "device",
                    name: "steambox",
                    endpoint: "https://steambox.example"
                ),
            ],
            projects: [
                FeatureProject(
                    id: "project",
                    environmentID: "device",
                    name: "t3code",
                    path: "/work/t3code"
                ),
            ],
            providers: [FeatureProvider(id: "claude", name: "Claude")]
        )

        #expect(thread.homeEnvironmentLabel(in: snapshot) == "steambox")
        #expect(thread.homeProviderLabel(in: snapshot) == "Claude")
    }

    @Test
    func rowContextCarriesHarnessIdentityAndCustomProviderFallback() throws {
        let knownThread = FeatureThread(
            id: "known",
            projectID: "project",
            title: "Use Claude",
            providerID: "work-claude"
        )
        let customThread = FeatureThread(
            id: "custom",
            projectID: "project",
            title: "Use a custom harness",
            providerID: "acme-agent",
            providerName: "Acme Agent"
        )
        let snapshot = FeatureSnapshot(
            projects: [
                FeatureProject(
                    id: "project",
                    environmentID: "device",
                    name: "t3code",
                    path: "/work/t3code"
                ),
            ],
            threads: [knownThread, customThread],
            providers: [
                FeatureProvider(id: "work-claude", name: "Claude Code", driver: "custom"),
                FeatureProvider(id: "acme-agent", name: "Acme Agent", driver: "custom"),
            ]
        )

        let contexts = HomeThreadRowContext.index(snapshot: snapshot)
        let known = try #require(contexts[knownThread.id])
        let custom = try #require(contexts[customThread.id])

        #expect(known.providerID == "work-claude")
        #expect(known.projectEnvironmentID == "device")
        #expect(known.projectWorkspaceRoot == "/work/t3code")
        #expect(known.providerDriver == "custom")
        #expect(known.providerName == "Claude Code")
        #expect(
            ProviderBrand.resolve(
                driver: known.providerDriver,
                providerID: known.providerID,
                providerName: known.providerName
            ) == .claude
        )
        #expect(custom.providerID == "acme-agent")
        #expect(custom.providerDriver == "custom")
        #expect(custom.providerName == "Acme Agent")
        #expect(
            ProviderBrand.resolve(
                driver: custom.providerDriver,
                providerID: custom.providerID,
                providerName: custom.providerName
            ) == nil
        )
    }

    @Test
    func pullRequestPresentationCarriesSafeDestinationNumberStateAndAccessibility() throws {
        let thread = pullRequestThread(branch: " feature/pr-links ")
        let destination = try #require(URL(string: "https://github.com/pingdotgg/t3code/pull/5804"))
        let presentation = try #require(HomeThreadPullRequestPresentation(
            thread: thread,
            status: FeatureSourceControlStatus(
                branch: "feature/pr-links",
                pullRequest: FeaturePullRequest(
                    number: 5804,
                    title: "Link thread rows",
                    state: " open ",
                    url: destination
                )
            )
        ))

        #expect(presentation.number == 5804)
        #expect(presentation.state == "open")
        #expect(presentation.destination == destination)
        #expect(presentation.shortLabel == "#5804")
        #expect(presentation.accessibilityLabel == "Pull request 5804, open")
        #expect(presentation.accessibilityActionName == "Open pull request 5804, open")
        #expect(
            presentation.accessibilityValue(appending: "Ready. Project t3code")
                == "Ready. Project t3code. Pull request 5804, open."
        )
    }

    @Test
    func pullRequestPresentationRejectsMissingMismatchedOrMalformedRemoteData() {
        let thread = pullRequestThread(branch: "feature/pr-links")
        let validPullRequest = FeaturePullRequest(
            number: 5804,
            title: "Link thread rows",
            state: "open",
            url: URL(string: "https://github.com/pingdotgg/t3code/pull/5804")
        )

        #expect(HomeThreadPullRequestPresentation(
            thread: thread,
            status: FeatureSourceControlStatus(branch: "feature/other", pullRequest: validPullRequest)
        ) == nil)
        #expect(HomeThreadPullRequestPresentation(
            thread: thread,
            status: FeatureSourceControlStatus(branch: nil, pullRequest: validPullRequest)
        ) == nil)
        #expect(HomeThreadPullRequestPresentation(
            thread: thread,
            status: FeatureSourceControlStatus(branch: "feature/pr-links", pullRequest: nil)
        ) == nil)

        for unsafeURL in [
            nil,
            URL(string: "t3code-swiftui://pull/5804"),
            URL(string: "https://token@example.com/pull/5804"),
            URL(string: "https:///pull/5804"),
            URL(string: "not a remote URL"),
        ] {
            var pullRequest = validPullRequest
            pullRequest.url = unsafeURL
            #expect(HomeThreadPullRequestPresentation(
                thread: thread,
                status: FeatureSourceControlStatus(
                    branch: "feature/pr-links",
                    pullRequest: pullRequest
                )
            ) == nil)
        }

        var invalidNumber = validPullRequest
        invalidNumber.number = 0
        #expect(HomeThreadPullRequestPresentation(
            thread: thread,
            status: FeatureSourceControlStatus(
                branch: "feature/pr-links",
                pullRequest: invalidNumber
            )
        ) == nil)

        var missingBranch = thread
        missingBranch.branch = "  "
        #expect(HomeThreadPullRequestPresentation(
            thread: missingBranch,
            status: FeatureSourceControlStatus(
                branch: "feature/pr-links",
                pullRequest: validPullRequest
            )
        ) == nil)
    }

    @Test
    func pullRequestLookupKeysAndDestinationsDoNotFollowRecycledThreadIDs() throws {
        let first = pullRequestThread(
            id: "first-row",
            environmentID: "mac",
            branch: " feature/pr-links ",
            worktreePath: " /worktrees/pr-links "
        )
        let recycled = pullRequestThread(
            id: "recycled-row",
            environmentID: "mac",
            branch: "feature/pr-links",
            worktreePath: "/worktrees/pr-links"
        )
        let otherCheckout = pullRequestThread(
            id: "other-row",
            environmentID: "mac",
            branch: "feature/other",
            worktreePath: "/worktrees/other"
        )
        let firstKey = try #require(HomeThreadPullRequestLookupKey(thread: first))
        let recycledKey = try #require(HomeThreadPullRequestLookupKey(thread: recycled))
        let otherKey = try #require(HomeThreadPullRequestLookupKey(thread: otherCheckout))

        #expect(firstKey == recycledKey)
        #expect(firstKey != otherKey)

        let firstDestination = URL(string: "https://github.com/pingdotgg/t3code/pull/5804")
        let otherDestination = URL(string: "https://github.com/pingdotgg/t3code/pull/5999")
        let firstPresentation = try #require(HomeThreadPullRequestPresentation(
            thread: first,
            status: FeatureSourceControlStatus(
                branch: "feature/pr-links",
                pullRequest: FeaturePullRequest(
                    number: 5804,
                    title: "First",
                    state: "open",
                    url: firstDestination
                )
            )
        ))
        let otherPresentation = try #require(HomeThreadPullRequestPresentation(
            thread: otherCheckout,
            status: FeatureSourceControlStatus(
                branch: "feature/other",
                pullRequest: FeaturePullRequest(
                    number: 5999,
                    title: "Other",
                    state: "merged",
                    url: otherDestination
                )
            )
        ))

        #expect(firstPresentation.destination == firstDestination)
        #expect(otherPresentation.destination == otherDestination)
        #expect(firstPresentation.accessibilityActionName != otherPresentation.accessibilityActionName)
        #expect(HomeThreadPullRequestLookupKey(thread: pullRequestThread(branch: nil)) == nil)
    }

    @Test
    func pullRequestLookupCacheExpiresResultsAndThrottlesFailures() {
        let now = Date(timeIntervalSince1970: 1_000)
        let cachedMissingPullRequest = HomeThreadPullRequestResolution.cached(nil, at: now)
        let failedLookup = HomeThreadPullRequestResolution.failed(at: now)

        #expect(
            cachedMissingPullRequest.needsLoad(at: now.addingTimeInterval(5 * 60 - 1))
                == false
        )
        #expect(cachedMissingPullRequest.needsLoad(at: now.addingTimeInterval(5 * 60)))
        #expect(failedLookup.needsLoad(at: now.addingTimeInterval(9)) == false)
        #expect(failedLookup.needsLoad(at: now.addingTimeInterval(10)))
    }

    @Test
    func blankPullRequestStateHasATruthfulAccessibilityFallback() throws {
        let presentation = try #require(HomeThreadPullRequestPresentation(
            thread: pullRequestThread(branch: "feature/pr-links"),
            status: FeatureSourceControlStatus(
                branch: "feature/pr-links",
                pullRequest: FeaturePullRequest(
                    number: 5804,
                    title: "Link thread rows",
                    state: "   ",
                    url: URL(string: "http://127.0.0.1/pull/5804")
                )
            )
        ))

        #expect(presentation.state == "unknown state")
        #expect(presentation.accessibilityLabel == "Pull request 5804, unknown state")
    }

    private func pullRequestThread(
        id: String = "thread",
        environmentID: String? = "environment",
        branch: String?,
        worktreePath: String? = "/worktrees/pr-links"
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: "project",
            environmentID: environmentID,
            title: "Build",
            branch: branch,
            worktreePath: worktreePath
        )
    }
}
