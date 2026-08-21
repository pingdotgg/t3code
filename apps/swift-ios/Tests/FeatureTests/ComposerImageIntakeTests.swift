import Foundation
import Testing
@testable import T3Code

@Suite("Composer image intake")
struct ComposerImageIntakeTests {
    private static func plan(
        providerCount: Int,
        attachmentCount: Int = 0,
        pendingCount: Int = 0
    ) -> FeatureComposerImageIntakePlan? {
        FeatureComposerImageIntakePlan.forProviders(
            providerCount: providerCount,
            attachmentCount: attachmentCount,
            pendingCount: pendingCount
        )
    }

    @Test
    func emptyComposerAcceptsEveryIncomingImage() throws {
        let plan = try #require(Self.plan(providerCount: 3))

        #expect(plan.acceptedCount == 3)
        #expect(plan.firstOrdinal == 1)
        #expect(plan.droppedCount == 0)
    }

    @Test
    func ordinalsContinueAfterExistingAndInFlightAttachments() throws {
        let plan = try #require(
            Self.plan(providerCount: 1, attachmentCount: 2, pendingCount: 1)
        )

        // Two attached plus one still preparing means this image is number four.
        #expect(plan.firstOrdinal == 4)
    }

    @Test
    func intakeIsRefusedOnceTheAttachmentCapIsReached() {
        #expect(Self.plan(providerCount: 1, attachmentCount: 8) == nil)
    }

    @Test
    func inFlightPreparationCountsAgainstTheCap() {
        // Seven attached plus one preparing already fills the eight-image budget.
        #expect(Self.plan(providerCount: 1, attachmentCount: 7, pendingCount: 1) == nil)
    }

    @Test
    func overshootIsTruncatedAndCounted() throws {
        let plan = try #require(Self.plan(providerCount: 5, attachmentCount: 6))

        #expect(plan.acceptedCount == 2)
        #expect(plan.droppedCount == 3)
    }

    @Test
    func anEmptyBatchYieldsNoPlan() {
        #expect(Self.plan(providerCount: 0) == nil)
    }
}
