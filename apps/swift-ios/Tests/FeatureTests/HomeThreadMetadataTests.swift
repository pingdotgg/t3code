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
    func completedAndIdleRowsUseQuietRelativeAges() {
        let updatedAt = now.addingTimeInterval(-120)
        let completed = FeatureThread(
            id: "completed",
            projectID: "project",
            title: "Done task",
            updatedAt: updatedAt,
            state: .completed
        )
        let idle = FeatureThread(
            id: "idle",
            projectID: "project",
            title: "Idle task",
            updatedAt: updatedAt,
            state: .idle
        )

        #expect(completed.homeRowStatusLabel(at: now) == "2m")
        #expect(idle.homeRowStatusLabel(at: now) == "2m")
    }

    @Test
    func completedDetailHeadersDoNotShowAStatusBadge() {
        let completed = FeatureThread(
            id: "completed",
            projectID: "project",
            title: "Completed task",
            state: .completed
        )
        let working = FeatureThread(
            id: "working",
            projectID: "project",
            title: "Working task",
            state: .working
        )

        #expect(completed.detailHeaderStatusLabel == nil)
        #expect(completed.detailHeaderStatusIcon == nil)
        #expect(working.detailHeaderStatusLabel == "Working")
        #expect(working.detailHeaderStatusIcon == "circle.dotted")
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
    func accessibilityDurationSpellsOutUnitsAndClampsFutureDates() {
        #expect(accessibilityDuration(startedAtOffset: 5) == "0 seconds")
        #expect(accessibilityDuration(startedAtOffset: -1) == "1 second")
        #expect(accessibilityDuration(startedAtOffset: -42) == "42 seconds")
        #expect(accessibilityDuration(startedAtOffset: -60) == "1 minute")
        #expect(accessibilityDuration(startedAtOffset: -120) == "2 minutes")
        #expect(accessibilityDuration(startedAtOffset: -3_600) == "1 hour")
        #expect(accessibilityDuration(startedAtOffset: -7_200) == "2 hours")
        #expect(accessibilityDuration(startedAtOffset: -5_465) == "1 hour, 31 minutes")
    }

    @Test
    func accessibilityStatusDescribesOnlyLiveWorkingDurations() {
        let working = thread(state: .working, startedAtOffset: -90)
        let queuedWithoutStart = thread(state: .queued)
        let monitoring = thread(state: .monitoring, startedAtOffset: -90)
        let idle = thread(state: .idle)

        #expect(working.hasLiveWorkingDuration)
        #expect(working.homeStatusAccessibilityLabel(at: now) == "Agent is working for 1 minute")
        #expect(!queuedWithoutStart.hasLiveWorkingDuration)
        #expect(queuedWithoutStart.homeStatusAccessibilityLabel(at: now) == "Agent is working")
        #expect(!monitoring.hasLiveWorkingDuration)
        #expect(monitoring.homeStatusAccessibilityLabel(at: now) == "Monitoring")
        #expect(!idle.hasLiveWorkingDuration)
        #expect(idle.homeStatusAccessibilityLabel(at: now) == "Ready")
    }

    private func accessibilityDuration(startedAtOffset: TimeInterval) -> String {
        HomeWorkingDuration.accessibility(
            since: now.addingTimeInterval(startedAtOffset),
            now: now
        )
    }

    private func thread(
        state: FeatureThreadState,
        startedAtOffset: TimeInterval? = nil
    ) -> FeatureThread {
        FeatureThread(
            id: state.rawValue,
            projectID: "project",
            title: "Task",
            state: state,
            workingStartedAt: startedAtOffset.map(now.addingTimeInterval)
        )
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
            providersByEnvironment: [
                "device": [FeatureProvider(id: "claude", name: "Claude")],
            ]
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
            providersByEnvironment: [
                "device": [
                    FeatureProvider(id: "work-claude", name: "Claude Code", driver: "custom"),
                    FeatureProvider(id: "acme-agent", name: "Acme Agent", driver: "custom"),
                ],
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
    func rowContextUsesRepositoryGroupNameInsteadOfStalePhysicalProjectTitle() throws {
        let thread = FeatureThread(
            id: "thread",
            projectID: "project",
            title: "Test T3 Code Functionality"
        )
        let snapshot = FeatureSnapshot(
            projects: [
                FeatureProject(
                    id: "project",
                    environmentID: "bb-1",
                    name: "wat",
                    path: "/work/t3code",
                    repositoryIdentity: FeatureRepositoryIdentity(
                        canonicalKey: "github.com/pingdotgg/t3code",
                        rootPath: "/work/t3code",
                        displayName: "pingdotgg/t3code",
                        name: "t3code"
                    )
                ),
            ],
            threads: [thread],
            preferencesByEnvironment: [
                "bb-1": FeatureEnvironmentPreferences(projectGroupingMode: .repository),
            ]
        )

        let context = try #require(HomeThreadRowContext.index(snapshot: snapshot)[thread.id])

        #expect(context.projectName == "pingdotgg/t3code")
    }

    @Test
    func pullRequestIndicatorsUseTheCurrentThreadBranchAndPreserveTheirState() {
        let thread = FeatureThread(
            id: "thread",
            projectID: "project",
            title: "Add native PR indicators",
            branch: "feature/native-pull-requests"
        )

        for state in ["open", "merged", "closed"] {
            let status = FeatureSourceControlStatus(
                branch: "feature/native-pull-requests",
                pullRequest: FeaturePullRequest(
                    number: 42,
                    title: "Add native PR indicators",
                    state: state
                )
            )

            let presentation = HomeThreadPullRequestPresentation.resolve(
                thread: thread,
                status: status
            )

            #expect(presentation?.label == "#42")
            #expect(presentation?.state.rawValue == state)
            #expect(presentation?.accessibilityLabel == "Pull request #42, \(state)")
        }
    }

    @Test
    func pullRequestIndicatorsIgnoreOtherBranchesAndUnknownStates() {
        let thread = FeatureThread(
            id: "thread",
            projectID: "project",
            title: "Task",
            branch: "feature/current"
        )
        let otherBranch = FeatureSourceControlStatus(
            branch: "feature/other",
            pullRequest: FeaturePullRequest(number: 42, title: "Other work", state: "open")
        )
        let unsupportedState = FeatureSourceControlStatus(
            branch: "feature/current",
            pullRequest: FeaturePullRequest(number: 42, title: "Current work", state: "draft")
        )
        let branchless = FeatureThread(id: "branchless", projectID: "project", title: "Task")

        #expect(HomeThreadPullRequestPresentation.resolve(thread: thread, status: otherBranch) == nil)
        #expect(HomeThreadPullRequestPresentation.resolve(thread: thread, status: unsupportedState) == nil)
        #expect(HomeThreadPullRequestPresentation.resolve(thread: branchless, status: otherBranch) == nil)
    }

    @Test
    func threadMenuOpensDurablePullRequestsInTheNativeDetailView() throws {
        let linked = ThreadLinkedPullRequest(
            projectId: "project-wire",
            repository: "pingdotgg/t3code",
            number: 5178,
            url: "https://github.com/pingdotgg/t3code/pull/5178"
        )
        let thread = FeatureThread(
            id: "thread",
            projectID: "environment:project-wire",
            environmentID: "studio",
            environmentName: "Studio",
            title: "Native client",
            linkedPullRequest: linked
        )

        let destination = try #require(ThreadPullRequestDestination.resolve(
            thread: thread,
            project: nil,
            branchPullRequest: nil
        ))

        #expect(destination.number == 5178)
        #expect(destination.target?.environmentID == "studio")
        #expect(destination.target?.environmentName == "Studio")
        #expect(destination.target?.reference.projectId == "project-wire")
        #expect(destination.target?.reference.repository == "pingdotgg/t3code")
    }

    @Test
    func threadMenuOpensBranchPullRequestsWithoutADurableLink() throws {
        let project = FeatureProject(
            id: "scoped-project",
            wireID: "project-wire",
            environmentID: "studio",
            name: "T3 Code",
            path: "/work/t3code"
        )
        let thread = FeatureThread(
            id: "thread",
            projectID: project.id,
            environmentID: "studio",
            environmentName: "Studio",
            title: "Native client",
            branch: "feature/native"
        )
        let pullRequest = FeaturePullRequest(
            number: 42,
            title: "Native client",
            state: "open",
            url: URL(string: "https://github.com/pingdotgg/t3code/pull/42")
        )

        let destination = try #require(ThreadPullRequestDestination.resolve(
            thread: thread,
            project: project,
            branchPullRequest: pullRequest
        ))

        #expect(destination.number == 42)
        #expect(destination.target?.reference.projectId == "project-wire")
        #expect(destination.target?.reference.repository == "pingdotgg/t3code")
    }

    @Test
    func threadMenuFallsBackToBrowserWhenThePullRequestCannotBeRoutedNatively() throws {
        let url = try #require(URL(string: "https://example.com/reviews/42"))
        let thread = FeatureThread(id: "thread", projectID: "missing", title: "Task")
        let pullRequest = FeaturePullRequest(number: 42, title: "Task", state: "open", url: url)

        let destination = try #require(ThreadPullRequestDestination.resolve(
            thread: thread,
            project: nil,
            branchPullRequest: pullRequest
        ))

        #expect(destination.target == nil)
        #expect(destination.url == url)
        #expect(ThreadPullRequestDestination.resolve(
            thread: thread,
            project: nil,
            branchPullRequest: nil
        ) == nil)
    }

    @Test
    func liveSourceControlSnapshotsCarryPullRequestsAndClearMissingRemoteState() {
        let local = VCSLocalStatus(
            isRepo: true,
            sourceControlProvider: nil,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: "feature/native-pull-requests",
            hasWorkingTreeChanges: false,
            workingTree: VCSWorkingTree(files: [], insertions: 0, deletions: 0)
        )
        let remote = VCSRemoteStatus(
            hasUpstream: true,
            aheadCount: 2,
            behindCount: 1,
            aheadOfDefaultCount: 2,
            pr: VCSChangeRequest(
                number: 42,
                title: "Add native PR indicators",
                url: "https://github.com/pingdotgg/t3code/pull/42",
                baseRef: "main",
                headRef: "feature/native-pull-requests",
                state: "open"
            )
        )

        let status = NativeWorkspaceMapper.sourceControl(local: local, remote: remote)
        let withoutRemote = NativeWorkspaceMapper.sourceControl(local: local, remote: nil)

        #expect(status.branch == "feature/native-pull-requests")
        #expect(status.pullRequest?.number == 42)
        #expect(status.pullRequest?.state == "open")
        #expect(status.aheadCount == 2)
        #expect(status.behindCount == 1)
        #expect(withoutRemote.pullRequest == nil)
    }
}
