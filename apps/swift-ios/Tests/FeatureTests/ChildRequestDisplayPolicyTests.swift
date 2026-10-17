import Foundation
import Testing
@testable import T3Code

@Suite("Child requests in the parent inbox")
struct ChildRequestDisplayPolicyTests {
    private let now = Date(timeIntervalSince1970: 10_000)

    private func parent() -> FeatureThread {
        FeatureThread(
            id: "parent", projectID: "project", title: "Parent", createdAt: now,
            updatedAt: now, state: .working, isSettled: true,
            snoozedUntil: now.addingTimeInterval(300), snoozedAt: now,
            supportsSettlement: true, supportsSnooze: true,
            settlementFacts: .init(settlementOverride: .settled),
            inboxFacts: .init(runtimeStatus: "running", latestRunID: "run", latestRunStatus: "running")
        )
    }

    @Test(arguments: [OrchestrationV2PendingSubagentRequest.approval, .userInput])
    func childRequestWakesTheParentAndReturnsItToInbox(request: OrchestrationV2PendingSubagentRequest) {
        var value = parent()
        var tracker = FeatureInboxReturnTracker()
        tracker.observe([value], at: now)
        value.pendingSubagentRequest = request
        tracker.observe([value], at: now.addingTimeInterval(1))

        #expect(value.homeStatus == (request == .approval ? .approval : .input))
        #expect(!FeatureInboxPolicy.isWorking(value))
        #expect(!value.isEffectivelySettled())
        #expect(!value.isEffectivelySnoozed(at: now))
        #expect(!value.canSnoozeNow(at: now))
        #expect(!value.canSettleNow(at: now))
        #expect(value.hasHardSettlementActivityBlock)
        #expect(tracker.returnedAt(for: value) == now.addingTimeInterval(1))
        #expect(value.settlementFacts?.settlementOverride == .settled)
        #expect(value.snoozedUntil == now.addingTimeInterval(300))

        let index = DailyUXSidebarIndex(
            snapshot: .init(threads: [value], settings: .init(workingShelfEnabled: true)), now: now
        )
        #expect(index.active.map(\.id) == [value.id])
        #expect(index.working.isEmpty && index.snoozed.isEmpty && index.settled.isEmpty)

        var archived = value
        archived.isArchived = true
        let hidden = DailyUXSidebarIndex(snapshot: .init(threads: [archived]), now: now)
        #expect(hidden.active.isEmpty && hidden.pinned.isEmpty && hidden.snoozed.isEmpty && hidden.settled.isEmpty)

        var child = value
        child.relationshipToParent = "subagent"
        let hiddenChild = DailyUXSidebarIndex(snapshot: .init(threads: [child]), now: now)
        #expect(hiddenChild.active.isEmpty && hiddenChild.working.isEmpty && hiddenChild.settled.isEmpty)

        value.pendingSubagentRequest = nil
        #expect(value.canSettleNow(at: now))
        #expect(!value.hasHardSettlementActivityBlock)
        #expect(FeatureInboxPolicy.isWorking(value))
        #expect(value.isEffectivelySnoozed(at: now))
        #expect(value.isEffectivelySettled())
    }

    @Test
    func directParentRequestsKeepServerSettlementValidation() {
        var value = parent()
        value.state = .waitingForInput
        value.settlementFacts?.hasPendingUserInput = true
        #expect(value.canSettleNow(at: now))
        #expect(!value.hasHardSettlementActivityBlock)

        value.state = .waitingForApproval
        value.settlementFacts?.hasPendingUserInput = false
        value.settlementFacts?.hasPendingApprovals = true
        #expect(value.canSettleNow(at: now))
        #expect(!value.hasHardSettlementActivityBlock)
    }

    @Test
    func requestChangesInvalidateShelfClassification() {
        var value = parent()
        let before = HomeOrderKey(value)
        value.pendingSubagentRequest = .userInput
        #expect(HomeOrderKey(value) != before)
        let input = HomeOrderKey(value)
        value.pendingSubagentRequest = .approval
        #expect(HomeOrderKey(value) != input)
    }

    @Test
    func parentQuestionTakesPriorityOverChildApproval() {
        var value = parent()
        value.pendingSubagentRequest = .approval
        value.state = .waitingForInput
        #expect(value.homeStatus == .input)
        #expect(value.homeStatusLabel == "Input")

        value.state = .working
        value.settlementFacts?.hasPendingUserInput = true
        #expect(value.homeStatus == .input)

        value.settlementFacts?.hasPendingUserInput = false
        #expect(value.homeStatus == .approval)
        value.pendingSubagentRequest = .userInput
        value.state = .waitingForApproval
        #expect(value.homeStatus == .approval)
    }
}
