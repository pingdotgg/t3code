import Foundation
import Testing
@testable import T3Code

@Suite("Stable thread display policy")
struct StableThreadDisplayPolicyTests {
    private let now = Date(timeIntervalSince1970: 10_000)

    @Test
    func localSendRemainsQueuedOnlyWithinTheAdoptionWindow() {
        let value = FeatureThread(
            id: "local", projectID: "project", title: "Task", createdAt: now.addingTimeInterval(-10),
            updatedAt: now, state: .idle,
            supportsSettlement: true, supportsSnooze: true,
            settlementFacts: .init(latestUserMessageAt: now)
        )
        #expect(!value.canSettleNow(at: now))
        #expect(!value.canSnoozeNow(at: now))
        #expect(value.queuedSettlementBoundary(after: now) == now.addingTimeInterval(120.001))
        #expect(value.canSettleNow(at: now.addingTimeInterval(121)))
        #expect(value.canSnoozeNow(at: now.addingTimeInterval(-121)))

        var working = value
        working.state = .working
        #expect(!working.canArchive)
        #expect(!working.canSettleNow(at: now.addingTimeInterval(121)))
        #expect(FeatureInboxPolicy.isWorking(working))

        let older = FeatureThread(
            id: "older", projectID: "project", title: "Task", createdAt: value.createdAt,
            updatedAt: now, state: .idle,
            supportsSettlement: true, supportsSnooze: true,
            settlementFacts: .init(latestUserMessageAt: now.addingTimeInterval(-1))
        )
        #expect(FeatureInboxPolicy.sortWorking([older, value]).first?.id == value.id)
    }

    @Test
    func runAdoptionFactsRefreshSnoozeAvailabilityWithoutVisitEchoInvalidation() {
        let value = FeatureThread(
            id: "loaded", projectID: "project", title: "Task", createdAt: now.addingTimeInterval(-10),
            updatedAt: now, state: .working,
            supportsSettlement: true, supportsSnooze: true,
            settlementFacts: .init(latestUserMessageAt: now),
            inboxFacts: .init(
                runtimeStatus: "running", latestRunID: "run", latestRunStatus: "running",
                latestRunRequestedAt: now.addingTimeInterval(-1)
            )
        )
        #expect(!value.canSnoozeNow(at: now))

        var adopted = value
        adopted.inboxFacts?.latestRunStartedAt = now
        #expect(adopted.canSnoozeNow(at: now))
        #expect(HomeOrderKey(adopted) != HomeOrderKey(value))

        var invalid = value
        invalid.inboxFacts?.latestRunHasInvalidTimestamp = true
        #expect(invalid.canSnoozeNow(at: now))
        #expect(HomeOrderKey(invalid) != HomeOrderKey(value))

        var visited = value
        visited.inboxFacts?.lastVisitedAt = now.ISO8601Format()
        visited.inboxFacts?.lastVisitedAtIsPresent = true
        visited.inboxFacts?.runtimeUpdatedAt = now.addingTimeInterval(1)
        #expect(HomeOrderKey(visited) == HomeOrderKey(value))
    }
}
