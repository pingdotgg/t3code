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
