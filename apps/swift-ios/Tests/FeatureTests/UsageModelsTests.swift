import Foundation
import Testing
@testable import T3Code

@Suite("Usage reporting")
struct UsageModelsTests {
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

    private func summary(
        contractVersion: Int = usageContractVersion,
        provider: UsageProviderKind,
        costUsd: Double,
        uncachedInput: Int = 100,
        cachedInput: Int = 0,
        cacheCreation: Int = 0,
        output: Int = 20,
        reasoning: Int = 0,
        sourceStatus: UsageSourceStatus = .ok
    ) -> UsageSummary {
        let path = provider == .codex ? "/Users/theo/.codex" : "/Users/theo/.claude"
        return UsageSummary(
            contractVersion: contractVersion,
            readAt: "2026-08-09T12:00:00.000Z",
            timeZone: "America/Los_Angeles",
            sinceDay: "2026-08-03",
            untilDay: "2026-08-09",
            buckets: [
                UsageBucket(
                    day: "2026-08-09",
                    provider: provider,
                    model: provider == .codex ? "gpt-5.6-sol" : "claude-opus-4-1",
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
