import Foundation
import Testing
@testable import T3Code

@Suite("Usage presentation")
struct UsagePresentationTests {
    /// The view reads stacked chart segments and sorted rows from the load
    /// state, so one received result must produce all of them at once.
    @Test
    func receivedResultStacksProvidersPerDayAndOrdersRows() throws {
        let timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let now = try #require(ISO8601DateFormatter().date(from: "2026-08-09T20:00:00Z"))
        var state = UsageLoadState(days: 7, now: now, timeZone: timeZone)
        let request = state.begin(days: 7, now: now, timeZone: timeZone)

        state.receive([
            environment(id: "a", provider: .codex, costUsd: 2, tokens: 300),
            environment(id: "b", provider: .claude, costUsd: 3, tokens: 100),
        ], for: request)

        let presentation = state.presentation
        let day = "2026-08-09"
        let daySegments = presentation.costSegments.filter { $0.period == day }
        #expect(presentation.costSegments.count == 7 * UsageProviderKind.allCases.count)
        #expect(daySegments.map(\.provider) == UsageProviderKind.allCases)
        #expect(daySegments.map { ($0.start, $0.end) }.map { [$0.0, $0.1] } == [[0, 2], [2, 5], [5, 5]])
        #expect(presentation.tokenSegments.filter { $0.period == day }.map(\.end) == [300, 400, 400])
        #expect(presentation.providersByCost.map(\.provider) == [.claude, .codex])
        #expect(presentation.providersByTokens.map(\.provider) == [.codex, .claude])
        #expect(presentation.periods.map(\.id) == [day])
        #expect(presentation.periods.first?.label == UsageFormat.dayShort(day))
        #expect(presentation.activePeriodCount == 1)
        #expect(presentation.periodAverageTokens == 400)
        #expect(presentation.hasCostActivity)
        #expect(presentation.sinceLabel == UsageFormat.dayShort(request.input.sinceDay))

        state.selectWindow(days: 30, now: now, timeZone: timeZone)
        #expect(state.presentation == UsagePresentation())
    }

    private func environment(
        id: String,
        provider: UsageProviderKind,
        costUsd: Double,
        tokens: Int
    ) -> FeatureEnvironmentUsage {
        FeatureEnvironmentUsage(
            environmentID: id,
            label: id.uppercased(),
            summary: UsageSummary(
                contractVersion: usageContractVersion,
                readAt: "2026-08-09T12:00:00.000Z",
                timeZone: "America/Los_Angeles",
                sinceDay: "2026-08-03",
                untilDay: "2026-08-09",
                buckets: [
                    UsageBucket(
                        day: "2026-08-09",
                        provider: provider,
                        model: "\(provider.rawValue)-model",
                        totals: UsageTokenTotals(
                            uncachedInputTokens: tokens,
                            cachedInputTokens: 0,
                            cacheCreationTokens: 0,
                            outputTokens: 0,
                            reasoningTokens: 0
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
                            hostId: id,
                            provider: provider,
                            resolvedHomePath: "/Users/\(id)/.\(provider.rawValue)",
                            volumeId: "1:2"
                        ),
                        status: .ok,
                        scannedFiles: 1,
                        skippedFiles: 0,
                        malformedRecords: 0,
                        distinctSessions: 1,
                        message: nil
                    ),
                ],
                pricing: UsagePricing(status: .fresh, source: "LiteLLM", fetchedAt: nil, knownModels: 1),
                scanDurationMs: 1
            )
        )
    }
}
