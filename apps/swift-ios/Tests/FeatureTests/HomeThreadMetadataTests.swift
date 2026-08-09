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
    func futureWorkingStartClampsToZeroSeconds() {
        #expect(workingDuration(startedAtOffset: 5) == "0s")
    }

    @Test
    func workingDurationUsesSecondsBelowOneMinute() {
        #expect(workingDuration(startedAtOffset: -42) == "42s")
    }

    @Test
    func queuedThreadsUseWorkingDuration() {
        #expect(workingDuration(state: .queued, startedAtOffset: -42) == "42s")
    }

    @Test
    func workingDurationSwitchesToMinutesAtOneMinute() {
        #expect(workingDuration(startedAtOffset: -60) == "1m")
    }

    @Test
    func workingDurationSwitchesToHoursAtOneHour() {
        #expect(workingDuration(startedAtOffset: -3_600) == "1h 0m")
    }

    @Test
    func workingDurationUsesHoursAndRemainingMinutes() {
        #expect(workingDuration(startedAtOffset: -5_465) == "1h 31m")
    }

    @Test
    func accessibilityDurationSpellsOutSingularUnits() {
        #expect(accessibilityDuration(startedAtOffset: -1) == "1 second")
        #expect(accessibilityDuration(startedAtOffset: -60) == "1 minute")
        #expect(accessibilityDuration(startedAtOffset: -3_600) == "1 hour")
    }

    @Test
    func futureAccessibilityDurationClampsToZeroSeconds() {
        #expect(accessibilityDuration(startedAtOffset: 5) == "0 seconds")
    }

    @Test
    func accessibilityDurationSpellsOutPluralHours() {
        #expect(accessibilityDuration(startedAtOffset: -7_200) == "2 hours")
    }

    @Test
    func accessibilityDurationSpellsOutHoursAndMinutes() {
        #expect(
            accessibilityDuration(startedAtOffset: -5_465)
                == "1 hour, 31 minutes"
        )
    }

    @Test
    func nonWorkingThreadsDoNotExposeWorkingDuration() {
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

        #expect(idle.homeWorkingDuration(at: now) == nil)
        #expect(monitoring.homeWorkingDuration(at: now) == nil)
    }

    private func workingDuration(
        state: FeatureThreadState = .working,
        startedAtOffset: TimeInterval
    ) -> String? {
        FeatureThread(
            id: "working",
            projectID: "project",
            title: "Build",
            state: state,
            workingStartedAt: now.addingTimeInterval(startedAtOffset)
        )
        .homeWorkingDuration(at: now)
    }

    private func accessibilityDuration(startedAtOffset: TimeInterval) -> String {
        HomeWorkingDuration.accessibility(
            since: now.addingTimeInterval(startedAtOffset),
            now: now
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
}
