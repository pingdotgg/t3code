import Foundation
import Testing
@testable import T3Code

@Suite("Thread arrangement")
struct ThreadArrangementTests {
    private let now = Date(timeIntervalSince1970: 20_000)

    @Test
    func crossSectionMoveUsesAllProjectsAndScopedThreadIDs() throws {
        var source = thread("same", environment: "two")
        source.projectID = "another-project"
        var first = thread("same", environment: "one")
        first.pinnedAt = now
        first.pinOrderKey = "f"
        var last = thread("last", environment: "two")
        last.pinnedAt = now
        last.pinOrderKey = "t"
        let plan = try #require(ThreadArrangementPlanner.plan(
            id: source.id,
            destination: .init(section: .pinned, targetID: last.id),
            threads: [last, source, first],
            connectedEnvironmentIDs: ["one", "two"],
            now: now
        ))
        #expect(plan.orderedIDs == [first.id, source.id, last.id])
        #expect(plan.assignments.count == 1)
        #expect(plan.assignments[0].threadID == source.id)
        #expect(plan.assignments[0].orderKey > "f")
        #expect(plan.assignments[0].orderKey < "t")
        #expect(source.projectID == "another-project")
    }

    @Test
    func liveSectionsAcceptDropsWhenEmpty() throws {
        var source = thread("source")
        source.pinnedAt = now
        let active = try #require(plan(source, destination: .active))
        #expect(active.orderedIDs == [source.id])
        #expect(active.assignments.count == 1)
        source.pinnedAt = nil
        let pinned = try #require(plan(source, destination: .pinned))
        #expect(pinned.orderedIDs == [source.id])
    }

    @Test
    func reopeningClearsEveryParkedStateBeforeReordering() {
        var source = thread("source")
        source.pinnedAt = now
        source.isSettled = true
        source.snoozedUntil = now.addingTimeInterval(100)
        #expect(ThreadArrangementPlanner.lifecycle(source, section: .active, now: now)
            == [.unpin, .unsettle, .unsnooze])
        // The server's pin command clears settlement and snooze itself.
        #expect(ThreadArrangementPlanner.lifecycle(source, section: .pinned, now: now) == [.pin])
        #expect(plan(source, destination: .active) != nil)
        #expect(plan(source, destination: .pinned) != nil)
    }

    @Test
    func staleOrUnsupportedLifecycleMovesDoNotWriteKeys() {
        var source = thread("source")
        source.supportsPinning = nil
        #expect(plan(source, destination: .pinned) == nil)
        source.supportsPinning = true
        source.isSettled = true
        source.supportsSettlement = nil
        #expect(plan(source, destination: .pinned) == nil)
        #expect(plan(source, destination: .active) == nil)
        source.supportsSettlement = true
        source.snoozedUntil = now.addingTimeInterval(100)
        source.supportsSnooze = nil
        #expect(plan(source, destination: .active) == nil)
        source.supportsSnooze = true
        source.supportsActiveReorder = nil
        #expect(plan(source, destination: .active) == nil)
        #expect(ThreadArrangementPlanner.plan(
            id: source.id, destination: .init(section: .pinned), threads: [source],
            connectedEnvironmentIDs: [], now: now
        ) == nil)
    }

    @Test
    func settlementRejectsLiveWorkAndSnoozedIsNotADropDestination() {
        var source = thread("source")
        #expect(plan(source, destination: .settled)?.section == nil)
        #expect(plan(source, destination: .settled) != nil)
        #expect(plan(source, destination: .snoozed) == nil)
        source.state = .working
        #expect(plan(source, destination: .settled) == nil)
        source.state = .idle
        source.isArchived = true
        #expect(plan(source, destination: .active) == nil)
        #expect(plan(source, destination: .pinned) == nil)
        #expect(plan(source, destination: .settled) == nil)
    }

    @Test
    func staleTargetDoesNotBecomeAnIndexMove() {
        let source = thread("source")
        #expect(ThreadArrangementPlanner.plan(
            id: source.id, destination: .init(section: .pinned, targetID: "deleted"),
            threads: [source], connectedEnvironmentIDs: ["one"], now: now
        ) == nil)
        #expect(plan(source, destination: .active) == nil)
    }

    @Test
    func aCrossSectionSpreadCannotWriteAnOfflineNeighbor() {
        let source = thread("source")
        var offline = thread("neighbor", environment: "two")
        offline.pinnedAt = now
        #expect(ThreadArrangementPlanner.plan(
            id: source.id, destination: .init(section: .pinned), threads: [source, offline],
            connectedEnvironmentIDs: ["one"], now: now
        ) == nil)
        offline.pinOrderKey = "m"
        #expect(ThreadArrangementPlanner.plan(
            id: source.id, destination: .init(section: .pinned), threads: [source, offline],
            connectedEnvironmentIDs: ["one"], now: now
        )?.assignments.map(\.threadID) == [source.id])
    }

    private func plan(_ source: FeatureThread, destination: ThreadArrangementSection) -> ThreadArrangementPlanner.Plan? {
        ThreadArrangementPlanner.plan(
            id: source.id, destination: .init(section: destination), threads: [source],
            connectedEnvironmentIDs: ["one"], now: now
        )
    }

    private func thread(_ id: String, environment: String = "one") -> FeatureThread {
        FeatureThread(
            id: "\(environment):\(id)", wireID: id, projectID: "project", environmentID: environment,
            title: id, createdAt: now, updatedAt: now,
            supportsSettlement: true, supportsSnooze: true, supportsPinning: true,
            supportsPinReorder: true, supportsActiveReorder: true
        )
    }
}
