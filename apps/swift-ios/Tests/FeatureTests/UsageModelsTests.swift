import Foundation
import Testing
@testable import T3Code

@Suite("Usage reporting")
struct UsageModelsTests {
    @Test
    func pastDayRequestsTwentyFourMinuteAlignedHourlyBuckets() throws {
        let timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let now = try #require(
            ISO8601DateFormatter().date(from: "2026-08-18T12:34:56Z")
        )

        let input = UsageWindow.make(days: 1, now: now, timeZone: timeZone)
        let since = try #require(input.sinceTime)
        let until = try #require(input.untilTime)
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let sinceDate = try #require(parser.date(from: since))
        let untilDate = try #require(parser.date(from: until))

        #expect(input.resolution == .hour)
        #expect(untilDate.timeIntervalSince(sinceDate) == 24 * 60 * 60)
        #expect(Calendar.current.component(.second, from: untilDate) == 0)
        #expect(UsageWindow.hours(in: input).count == 24)
    }

    @Test
    func hourlyBucketsMergeAcrossEnvironmentsAndProviders() {
        let hour = "2026-08-18T12:00:00.000Z"
        let first = FeatureEnvironmentUsage(
            environmentID: "a",
            label: "First",
            summary: summary(provider: .codex, costUsd: 2, hourStart: hour),
            errorMessage: nil
        )
        let second = FeatureEnvironmentUsage(
            environmentID: "b",
            label: "Second",
            summary: summary(provider: .claude, costUsd: 3, hourStart: hour),
            errorMessage: nil
        )

        let merged = UsageMerger.merge([first, second])

        #expect(merged.hourly.count == 1)
        #expect(merged.hourly[0].hourStart == hour)
        #expect(merged.hourly[0].costUsd == 5)
        #expect(merged.hourly[0].byProvider[.codex]?.costUsd == 2)
        #expect(merged.hourly[0].byProvider[.claude]?.costUsd == 3)
    }

    @Test
    func mergeDoesNotCountReasoningTokensTwice() {
        let report = FeatureEnvironmentUsage(
            environmentID: "environment-a",
            label: "Studio",
            summary: summary(
                provider: .codex,
                costUsd: 12,
                uncachedInput: 100,
                cachedInput: 200,
                cacheCreation: 30,
                output: 40,
                reasoning: 10
            ),
            errorMessage: nil
        )

        let merged = UsageMerger.merge([report])

        #expect(merged.totalTokens == 370)
        #expect(merged.reasoningTokens == 10)
        #expect(merged.providers.first?.totalTokens == 370)
        #expect(merged.sessions == 1)
    }

    @Test
    func duplicateTranscriptSourcesAreCountedOnce() {
        let first = FeatureEnvironmentUsage(
            environmentID: "a",
            label: "First",
            summary: summary(provider: .codex, costUsd: 10),
            errorMessage: nil
        )
        let duplicate = FeatureEnvironmentUsage(
            environmentID: "b",
            label: "Second",
            summary: summary(provider: .codex, costUsd: 50),
            errorMessage: nil
        )

        let merged = UsageMerger.merge([duplicate, first])

        #expect(merged.costUsd == 10)
        #expect(merged.contributingEnvironments == ["a"])
        #expect(merged.duplicateSources == ["Second: /Users/theo/.codex"])
    }

    @Test
    func healthySourceOwnsFingerprintInsteadOfEarlierFailedSource() {
        let failed = FeatureEnvironmentUsage(
            environmentID: "a",
            label: "Failed",
            summary: summary(provider: .codex, costUsd: 50, sourceStatus: .failed),
            errorMessage: nil
        )
        let healthy = FeatureEnvironmentUsage(
            environmentID: "b",
            label: "Healthy",
            summary: summary(provider: .codex, costUsd: 10),
            errorMessage: nil
        )

        let merged = UsageMerger.merge([failed, healthy])

        #expect(merged.costUsd == 10)
        #expect(merged.contributingEnvironments == ["b"])
        #expect(merged.duplicateSources == ["Failed: /Users/theo/.codex"])
    }

    @Test
    func staleContractsDoNotChangeTotals() {
        let current = FeatureEnvironmentUsage(
            environmentID: "current",
            label: "Current",
            summary: summary(provider: .codex, costUsd: 10),
            errorMessage: nil
        )
        let stale = FeatureEnvironmentUsage(
            environmentID: "stale",
            label: "Stale",
            summary: summary(contractVersion: 2, provider: .claude, costUsd: 25),
            errorMessage: nil
        )

        let merged = UsageMerger.merge([current, stale])

        #expect(merged.costUsd == 10)
        #expect(merged.staleEnvironments == ["stale"])
    }

    @Test
    func calendarWindowStaysInclusiveAcrossDaylightSavingTime() throws {
        let timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let now = try #require(
            ISO8601DateFormatter().date(from: "2024-03-10T19:00:00Z")
        )

        let window = UsageWindow.make(days: 7, now: now, timeZone: timeZone)

        #expect(window.sinceDay == "2024-03-04")
        #expect(window.untilDay == "2024-03-10")
        #expect(UsageWindow.days(in: window).count == 7)
    }

    @Test
    func refreshRecomputesTheSelectedWindowAfterMidnight() throws {
        let timeZone = try #require(TimeZone(identifier: "Australia/Sydney"))
        let beforeMidnight = try #require(
            ISO8601DateFormatter().date(from: "2026-08-10T13:59:00Z")
        )
        let afterMidnight = try #require(
            ISO8601DateFormatter().date(from: "2026-08-10T14:01:00Z")
        )
        var state = UsageLoadState(days: 30, now: beforeMidnight, timeZone: timeZone)
        let initial = state.begin(days: 30, now: beforeMidnight, timeZone: timeZone)
        let previous = FeatureEnvironmentUsage(
            environmentID: "current",
            label: "Current",
            summary: summary(provider: .codex, costUsd: 10),
            errorMessage: nil
        )
        let receivedInitial = state.receive([previous], for: initial)
        #expect(receivedInitial)

        let refresh = state.begin(days: 30, now: afterMidnight, timeZone: timeZone)

        #expect(refresh.input.untilDay == "2026-08-11")
        #expect(refresh.input.sinceDay == "2026-07-13")
        #expect(state.windowInput.untilDay == "2026-08-10")
        #expect(state.merged.costUsd == 10)

        let current = FeatureEnvironmentUsage(
            environmentID: "current",
            label: "Current",
            summary: summary(provider: .codex, costUsd: 11),
            errorMessage: nil
        )
        let receivedRefresh = state.receive([current], for: refresh)
        #expect(receivedRefresh)
        #expect(state.windowInput.untilDay == "2026-08-11")
        #expect(state.merged.costUsd == 11)
    }

    @Test(arguments: [7, 30, 90])
    func refreshAndRetryRecomputeEveryWindowLength(days: Int) throws {
        let timeZone = try #require(TimeZone(identifier: "Australia/Sydney"))
        let firstDay = try #require(
            ISO8601DateFormatter().date(from: "2026-08-10T12:00:00Z")
        )
        let nextDay = try #require(
            ISO8601DateFormatter().date(from: "2026-08-11T12:00:00Z")
        )
        var state = UsageLoadState(days: 30, now: firstDay, timeZone: timeZone)

        let refresh = state.begin(days: days, now: firstDay, timeZone: timeZone)
        #expect(UsageWindow.days(in: refresh.input).count == days)
        let recordedRefreshFailure = state.fail(TestUsageError.unavailable, for: refresh)
        #expect(recordedRefreshFailure)

        let retry = state.begin(days: days, now: nextDay, timeZone: timeZone)
        #expect(UsageWindow.days(in: retry.input).count == days)
        #expect(retry.input.untilDay == "2026-08-11")
        #expect(state.errorMessage == nil)
    }

    @Test
    func failedRefreshKeepsTheLastTruthfulTotalsAndWindow() throws {
        let timeZone = try #require(TimeZone(identifier: "Australia/Sydney"))
        let now = try #require(
            ISO8601DateFormatter().date(from: "2026-08-10T12:00:00Z")
        )
        var state = UsageLoadState(days: 30, now: now, timeZone: timeZone)
        let initial = state.begin(days: 30, now: now, timeZone: timeZone)
        let previous = FeatureEnvironmentUsage(
            environmentID: "current",
            label: "Current",
            summary: summary(provider: .codex, costUsd: 10),
            errorMessage: nil
        )
        let receivedInitial = state.receive([previous], for: initial)
        #expect(receivedInitial)
        let truthfulWindow = state.windowInput

        let refresh = state.begin(days: 30, now: now, timeZone: timeZone)
        let recordedRefreshFailure = state.fail(TestUsageError.unavailable, for: refresh)
        #expect(recordedRefreshFailure)

        #expect(state.windowInput == truthfulWindow)
        #expect(state.environments == [previous])
        #expect(state.merged.costUsd == 10)
        #expect(state.errorMessage != nil)
    }

    @Test
    func staleOrCancelledLoadCannotOverwriteTheNewestLoad() throws {
        let timeZone = try #require(TimeZone(identifier: "Australia/Sydney"))
        let now = try #require(
            ISO8601DateFormatter().date(from: "2026-08-10T12:00:00Z")
        )
        var state = UsageLoadState(days: 30, now: now, timeZone: timeZone)
        let stale = state.begin(days: 30, now: now, timeZone: timeZone)
        let previous = FeatureEnvironmentUsage(
            environmentID: "previous",
            label: "Previous",
            summary: summary(provider: .codex, costUsd: 30),
            errorMessage: nil
        )
        let receivedPrevious = state.receive([previous], for: stale)
        #expect(receivedPrevious)
        state.selectWindow(days: 7, now: now, timeZone: timeZone)
        #expect(state.environments.isEmpty)
        #expect(state.merged == MergedUsage())
        #expect(state.errorMessage == nil)
        #expect(state.isLoading)
        #expect(UsageWindow.days(in: state.windowInput).count == 7)
        let staleResult = FeatureEnvironmentUsage(
            environmentID: "stale",
            label: "Stale",
            summary: summary(provider: .codex, costUsd: 99),
            errorMessage: nil
        )
        let currentResult = FeatureEnvironmentUsage(
            environmentID: "current",
            label: "Current",
            summary: summary(provider: .codex, costUsd: 7),
            errorMessage: nil
        )

        let receivedStale = state.receive([staleResult], for: stale)
        #expect(!receivedStale)
        let recordedStaleFailure = state.fail(TestUsageError.unavailable, for: stale)
        #expect(!recordedStaleFailure)
        #expect(state.errorMessage == nil)
        state.finish(stale)
        #expect(state.isLoading)

        let current = state.begin(days: 7, now: now, timeZone: timeZone)
        let receivedCurrent = state.receive([currentResult], for: current)
        #expect(receivedCurrent)
        state.finish(current)

        #expect(!state.isLoading)
        #expect(state.environments == [currentResult])
        #expect(state.merged.costUsd == 7)
        #expect(UsageWindow.days(in: state.windowInput).count == 7)
    }

    @Test
    func sameWindowOverlapOnlyLetsTheNewestLoadCommitOrFinish() throws {
        let timeZone = try #require(TimeZone(identifier: "Australia/Sydney"))
        let now = try #require(
            ISO8601DateFormatter().date(from: "2026-08-10T12:00:00Z")
        )
        var state = UsageLoadState(days: 30, now: now, timeZone: timeZone)
        let superseded = state.begin(days: 30, now: now, timeZone: timeZone)
        let current = state.begin(days: 30, now: now, timeZone: timeZone)
        let result = FeatureEnvironmentUsage(
            environmentID: "current",
            label: "Current",
            summary: summary(provider: .codex, costUsd: 30),
            errorMessage: nil
        )

        let receivedSuperseded = state.receive([result], for: superseded)
        #expect(!receivedSuperseded)
        let recordedSupersededFailure = state.fail(
            TestUsageError.unavailable,
            for: superseded
        )
        #expect(!recordedSupersededFailure)
        state.finish(superseded)
        #expect(state.isLoading)

        let receivedCurrent = state.receive([result], for: current)
        #expect(receivedCurrent)
        state.finish(current)
        #expect(!state.isLoading)
        #expect(state.environments == [result])
    }

    @Test
    func partialEnvironmentFailureRemainsVisibleBesideTruthfulTotals() throws {
        let timeZone = try #require(TimeZone(identifier: "Australia/Sydney"))
        let now = try #require(
            ISO8601DateFormatter().date(from: "2026-08-10T12:00:00Z")
        )
        var state = UsageLoadState(days: 30, now: now, timeZone: timeZone)
        let request = state.begin(days: 30, now: now, timeZone: timeZone)
        let available = FeatureEnvironmentUsage(
            environmentID: "available",
            label: "Available",
            summary: summary(provider: .codex, costUsd: 10),
            errorMessage: nil
        )
        let unavailable = FeatureEnvironmentUsage(
            environmentID: "unavailable",
            label: "Unavailable",
            summary: nil,
            errorMessage: "This environment could not report usage."
        )

        let receivedPartial = state.receive([available, unavailable], for: request)
        #expect(receivedPartial)

        #expect(state.merged.costUsd == 10)
        #expect(state.environments.filter { $0.errorMessage != nil } == [unavailable])
        #expect(state.errorMessage == nil)
    }

    @Test
    func rollingServerVersionsLoadWhenAnotherEnvironmentIsOffline() throws {
        let timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let now = try #require(
            ISO8601DateFormatter().date(from: "2026-08-18T12:00:00Z")
        )
        var state = UsageLoadState(days: 30, now: now, timeZone: timeZone)
        let request = state.begin(days: 30, now: now, timeZone: timeZone)
        let currentServer = FeatureEnvironmentUsage(
            environmentID: "current-server",
            label: "Current server",
            summary: summary(
                contractVersion: usageContractVersion,
                provider: .codex,
                costUsd: 10
            ),
            errorMessage: nil
        )
        let previousServer = FeatureEnvironmentUsage(
            environmentID: "previous-server",
            label: "Previous server",
            summary: summary(
                contractVersion: minimumCompatibleUsageContractVersion,
                provider: .claude,
                costUsd: 20
            ),
            errorMessage: nil
        )
        let offlineServer = FeatureEnvironmentUsage(
            environmentID: "offline-server",
            label: "Offline server",
            summary: nil,
            errorMessage: "This environment could not report usage."
        )

        let received = state.receive(
            [currentServer, previousServer, offlineServer],
            for: request
        )
        #expect(received)

        #expect(state.merged.costUsd == 30)
        #expect(
            state.merged.contributingEnvironments == ["current-server", "previous-server"]
        )
        #expect(state.merged.staleEnvironments.isEmpty)
        #expect(state.environments.filter { $0.errorMessage != nil } == [offlineServer])
    }

    @Test
    func grokUsageMergesWithOlderServersAndAppearsInCharts() {
        let environments = [
            FeatureEnvironmentUsage(
                environmentID: "new", label: "New",
                summary: summary(contractVersion: 5, provider: .grok, costUsd: 15),
                errorMessage: nil
            ),
            FeatureEnvironmentUsage(
                environmentID: "older", label: "Older",
                summary: summary(contractVersion: 4, provider: .codex, costUsd: 10),
                errorMessage: nil
            ),
            FeatureEnvironmentUsage(
                environmentID: "legacy", label: "Legacy",
                summary: summary(contractVersion: 3, provider: .claude, costUsd: 5),
                errorMessage: nil
            ),
        ]
        let merged = UsageMerger.merge(environments)
        #expect(merged.costUsd == 30)
        #expect(Set(merged.providers.map(\.provider)) == [.grok, .codex, .claude])
        #expect(merged.daily.first?.byProvider[.grok]?.costUsd == 15)
        #expect(merged.models.contains { $0.provider == .grok })
        #expect(merged.staleEnvironments.isEmpty)
        #expect(!isCompatibleUsageContractVersion(2))
        #expect(!isCompatibleUsageContractVersion(6))
    }

    @Test
    func versionThreeKeepsDailyUsageButCannotEnterHourlyTotals() throws {
        let now = try #require(ISO8601DateFormatter().date(from: "2026-08-18T12:00:00Z"))
        let environment = FeatureEnvironmentUsage(
            environmentID: "legacy", label: "Legacy",
            summary: summary(contractVersion: 3, provider: .claude, costUsd: 20)
        )
        var state = UsageLoadState(days: 1, now: now)
        let hourly = state.begin(days: 1, now: now)
        state.receive([environment], for: hourly)

        #expect(state.merged.costUsd == 0)
        #expect(state.merged.totalTokens == 0)
        #expect(state.merged.staleEnvironments == ["legacy"])
        #expect(!isCompatibleUsageContractVersion(3, resolution: .hour))
        #expect(isCompatibleUsageContractVersion(4, resolution: .hour))
        #expect(isCompatibleUsageContractVersion(5, resolution: .hour))

        let daily = state.begin(days: 7, now: now)
        state.receive([environment], for: daily)
        #expect(state.merged.costUsd == 20)
        #expect(state.merged.staleEnvironments.isEmpty)
        #expect(isCompatibleUsageContractVersion(3, resolution: .day))
    }

    @Test
    func firstEnvironmentRendersWhileAnotherIsStillPending() throws {
        let now = try #require(ISO8601DateFormatter().date(from: "2026-08-18T12:00:00Z"))
        var state = UsageLoadState(now: now)
        let request = state.begin(days: 30, now: now)
        let pending = FeatureEnvironmentUsage(
            environmentID: "slow", label: "Slow", summary: nil, isPending: true
        )
        let ready = FeatureEnvironmentUsage(
            environmentID: "ready", label: "Ready", summary: summary(provider: .codex, costUsd: 10)
        )

        state.receive([ready, pending], for: request)
        #expect(state.merged.costUsd == 10)
        #expect(state.isLoading)
        #expect(state.isPartial)
        #expect(!state.hasPendingCachedTotals)

        state.receive([
            ready,
            .init(environmentID: "slow", label: "Slow", summary: nil, errorMessage: "Offline")
        ], for: request)
        state.finish(request)
        #expect(state.merged.costUsd == 10)
        #expect(!state.isLoading)
        #expect(!state.isPartial)
        #expect(state.environments.last?.errorMessage == "Offline")
    }

    @Test
    func pendingRefreshRetainsOnlyTheSameWindowsLastScan() throws {
        let now = try #require(ISO8601DateFormatter().date(from: "2026-08-18T12:00:00Z"))
        let timeZone = try #require(TimeZone(identifier: "UTC"))
        var state = UsageLoadState(now: now, timeZone: timeZone)
        let initial = state.begin(days: 30, now: now, timeZone: timeZone)
        let previous = FeatureEnvironmentUsage(
            environmentID: "current", label: "Current", summary: summary(provider: .codex, costUsd: 10)
        )
        state.receive([previous], for: initial)
        state.finish(initial)
        let pending = FeatureEnvironmentUsage(
            environmentID: "current", label: "Current", summary: nil, isPending: true
        )

        let refresh = state.begin(days: 30, now: now, timeZone: timeZone)
        state.receive([pending], for: refresh)
        #expect(state.merged.costUsd == 10)
        #expect(state.environments.first?.isPending == true)
        #expect(state.hasPendingCachedTotals)
        #expect(!state.isPartial)

        let nextDay = state.begin(days: 30, now: now.addingTimeInterval(24 * 60 * 60), timeZone: timeZone)
        state.receive([pending], for: nextDay)
        #expect(state.merged.costUsd == 0)
        #expect(state.environments.first?.summary == nil)
        #expect(!state.hasPendingCachedTotals)
    }

    private func summary(
        contractVersion: Int = usageContractVersion,
        provider: UsageProviderKind,
        costUsd: Double,
        uncachedInput: Int = 100,
        cachedInput: Int = 0,
        cacheCreation: Int = 0,
        output: Int = 20,
        reasoning: Int = 0,
        sourceStatus: UsageSourceStatus = .ok,
        hourStart: String? = nil
    ) -> UsageSummary {
        let path = "/Users/theo/.\(provider.rawValue)"
        return UsageSummary(
            contractVersion: contractVersion,
            readAt: "2026-08-09T12:00:00.000Z",
            timeZone: "America/Los_Angeles",
            sinceDay: "2026-08-03",
            untilDay: "2026-08-09",
            buckets: [
                UsageBucket(
                    day: "2026-08-09",
                    hourStart: hourStart,
                    provider: provider,
                    model: "\(provider.rawValue)-test-model",
                    totals: UsageTokenTotals(
                        uncachedInputTokens: uncachedInput,
                        cachedInputTokens: cachedInput,
                        cacheCreationTokens: cacheCreation,
                        outputTokens: output,
                        reasoningTokens: reasoning
                    ),
                    costUsd: costUsd,
                    cacheSavingsUsd: 0,
                    costSource: .modelPriced,
                    records: 1,
                    unpricedRecords: 0,
                    sessions: 1
                ),
            ],
            sources: [
                UsageSource(
                    fingerprint: UsageSourceFingerprint(
                        hostId: "host",
                        provider: provider,
                        resolvedHomePath: path,
                        volumeId: "1:2"
                    ),
                    status: sourceStatus,
                    scannedFiles: 1,
                    skippedFiles: 0,
                    malformedRecords: 0,
                    distinctSessions: 1,
                    message: nil
                ),
            ],
            pricing: UsagePricing(
                status: .fresh,
                source: "LiteLLM",
                fetchedAt: nil,
                knownModels: 1
            ),
            scanDurationMs: 1
        )
    }
}

private enum TestUsageError: Error {
    case unavailable
}
