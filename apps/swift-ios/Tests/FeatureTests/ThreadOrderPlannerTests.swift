import Foundation
import Testing
@testable import T3Code

/// Parity coverage for `ThreadOrderPlanner` against
/// `packages/client-runtime/src/state/threadSort.ts` and
/// `apps/mobile/src/features/threads/threadOrder.ts`.
@Suite("Thread order planner")
struct ThreadOrderPlannerTests {
    private let now = Date(timeIntervalSince1970: 2_000_000)

    // MARK: - orderKeyBetween

    @Test
    func orderKeyBetweenFindsAKeyBetweenKeyedNeighbors() {
        let key = ThreadOrderPlanner.orderKeyBetween(before: "f", after: "t")
        #expect(key != nil)
        #expect(key! > "f")
        #expect(key! < "t")
    }

    @Test
    func orderKeyBetweenHandlesOpenBoundsAndRepeatedSplitting() {
        let top = ThreadOrderPlanner.orderKeyBetween(before: nil, after: "b")
        #expect(top != nil)
        #expect(top! < "b")

        let bottom = ThreadOrderPlanner.orderKeyBetween(before: "y", after: nil)
        #expect(bottom != nil)
        #expect(bottom! > "y")

        // Splitting a one-digit gap must extend, not collide.
        var a = "f"
        for _ in 0..<64 {
            let next = ThreadOrderPlanner.orderKeyBetween(before: a, after: "g")
            #expect(next != nil)
            #expect(next! > a)
            #expect(next! < "g")
            a = next!
        }
    }

    @Test
    func orderKeyBetweenRejectsCorruptOrInvertedBounds() {
        #expect(ThreadOrderPlanner.orderKeyBetween(before: "fa", after: "z") == nil)
        #expect(ThreadOrderPlanner.orderKeyBetween(before: "f", after: "1") == nil)
        #expect(ThreadOrderPlanner.orderKeyBetween(before: "t", after: "f") == nil)
        #expect(ThreadOrderPlanner.orderKeyBetween(before: "m", after: "m") == nil)
        #expect(ThreadOrderPlanner.orderKeyBetween(before: nil, after: nil) != nil)
    }

    // MARK: - spreadKeys

    @Test(arguments: [0, 1, 650, 675, 676, 1_001, 2_000])
    func spreadKeysAreUniqueSortedAndInsertable(count: Int) {
        let keys = ThreadOrderPlanner.spreadKeys(count: count)
        #expect(keys.count == count)
        #expect(Set(keys).count == count)
        #expect(keys.sorted() == keys)
        for (index, key) in keys.enumerated() {
            #expect(key.last != "a")
            let between = ThreadOrderPlanner.orderKeyBetween(
                before: index > 0 ? keys[index - 1] : nil,
                after: key
            )
            #expect(between != nil)
            #expect(between! < key)
            if index > 0 {
                #expect(between! > keys[index - 1])
            }
        }
    }

    // MARK: - planMove

    @Test
    func moveUpWritesASingleKeyOnTheMovedThread() {
        let assignments = ThreadOrderPlanner.planMove(
            orderedIDs: ["a", "b", "c"],
            keysByID: ["a": "f", "b": "m", "c": "t"],
            movedID: "c",
            direction: .up
        )
        #expect(assignments?.count == 1)
        #expect(assignments?[0].threadID == "c")
        #expect(assignments![0].orderKey > "f")
        #expect(assignments![0].orderKey < "m")
    }

    @Test
    func movesOffTheSectionEndsReturnNil() {
        let keys: [String: String?] = ["a": "f", "b": "m"]
        #expect(ThreadOrderPlanner.planMove(
            orderedIDs: ["a", "b"], keysByID: keys, movedID: "a", direction: .up
        ) == nil)
        #expect(ThreadOrderPlanner.planMove(
            orderedIDs: ["a", "b"], keysByID: keys, movedID: "b", direction: .down
        ) == nil)
    }

    @Test
    func keylessNeighborMaterializesTheWholeSectionInTheNewOrder() {
        let assignments = ThreadOrderPlanner.planMove(
            orderedIDs: ["a", "b", "c"],
            keysByID: ["a": nil, "b": "m", "c": nil],
            movedID: "b",
            direction: .up
        )
        #expect(assignments != nil)
        let keys = assignments!.map(\.orderKey)
        #expect(keys.sorted() == keys)
        // The requested order is [b, a, c]: b's new key sorts first.
        let keyByID = Dictionary(
            uniqueKeysWithValues: assignments!.map { ($0.threadID, $0.orderKey) }
        )
        #expect(keyByID["b"]! < keyByID["a"]!)
        #expect(keyByID["a"]! < keyByID["c"]!)
    }

    @Test
    func keylessThreadMovesIntoTheArrangedRunWithOneWrite() {
        let assignments = ThreadOrderPlanner.planMove(
            orderedIDs: ["new", "reopened", "first", "last"],
            keysByID: ["new": nil, "reopened": nil, "first": "f", "last": "t"],
            movedID: "reopened",
            direction: .down
        )
        #expect(assignments?.count == 1)
        #expect(assignments?[0].threadID == "reopened")
        #expect(assignments![0].orderKey > "f")
        #expect(assignments![0].orderKey < "t")
    }

    // MARK: - hidden-row reservations

    @Test
    func hiddenRowKeysAreReservedForSingleKeyInserts() {
        let midpoint = ThreadOrderPlanner.orderKeyBetween(before: "f", after: "t")!
        let assignments = ThreadOrderPlanner.planReorder(
            orderedIDs: ["a", "moved", "b"],
            keysByID: ["a": "f", "b": "t", "moved": "z", "snoozed": midpoint],
            movedID: "moved"
        )
        #expect(assignments.count == 1)
        #expect(assignments[0].threadID == "moved")
        #expect(assignments[0].orderKey > "f")
        #expect(assignments[0].orderKey < "t")
        #expect(assignments[0].orderKey != midpoint)
    }

    @Test
    func spreadRewritesNeverStealAHiddenRowKey() {
        let reserved = ThreadOrderPlanner.spreadKeys(count: 6)
        var keysByID: [String: String?] = ["a": nil, "b": nil, "c": nil]
        for (index, key) in reserved.enumerated() {
            keysByID["hidden-\(index)"] = key
        }
        let assignments = ThreadOrderPlanner.planReorder(
            orderedIDs: ["c", "a", "b"],
            keysByID: keysByID,
            movedID: "c"
        )
        #expect(assignments.map(\.threadID) == ["c", "a", "b"])
        let keys = assignments.map(\.orderKey)
        #expect(keys.sorted() == keys)
        #expect(Set(keys).count == 3)
        #expect(keys.allSatisfy { !reserved.contains($0) })
    }

    // MARK: - movePlanner / moveOptions capability gating

    @Test
    func movePlannerRequiresReorderSupportOnEveryAssignedEnvironment() {
        let envA = sectionThreads(
            environmentID: "env-a",
            pinned: true,
            keys: ["a-1": "f", "a-2": "t"],
            supportsPinReorder: true
        )
        // env-b predates reordering: its rows stay keyless and unwritable.
        let envB = sectionThreads(
            environmentID: "env-b",
            pinned: true,
            keys: ["b-1": nil],
            supportsPinReorder: false
        )
        let all = envA + envB
        let ordered = DailyUXSidebarIndex.orderedSection(all, section: .pinned, now: now)
        // Keyed rows first (env-a), keyless env-b row last.
        #expect(ordered.map(\.id) == ["env-a:a-1", "env-a:a-2", "env-b:b-1"])

        let planner = ThreadOrderPlanner.movePlanner(
            ordered: ordered,
            all: all,
            section: .pinned
        )
        // Single-key move within the writable environment works.
        let moving = ordered.first { $0.id == "env-a:a-2" }!
        let assignments = planner(moving, .up)
        #expect(assignments?.count == 1)
        #expect(assignments?[0].threadID == "env-a:a-2")

        // Moving the env-a row down past the keyless env-b row would need a
        // spread rewrite touching env-b — refused, like React Native.
        let edge = ordered.first { $0.id == "env-a:a-2" }!
        #expect(planner(edge, .down) == nil)

        // The env-b row itself gets no plan at all.
        let unwritable = ordered.first { $0.id == "env-b:b-1" }!
        #expect(planner(unwritable, .up) == nil)
        #expect(planner(unwritable, .down) == nil)
    }

    @Test
    func moveOptionsReportPerDirectionAvailabilityForWritableRowsOnly() {
        let threads = sectionThreads(
            environmentID: "env-a",
            pinned: true,
            keys: ["a-1": "f", "a-2": "m", "a-3": "t"],
            supportsPinReorder: true
        ) + sectionThreads(
            environmentID: "env-b",
            pinned: true,
            keys: ["b-1": "n"],
            supportsPinReorder: false
        )
        var options: [String: FeatureThreadMoveOptions] = [:]
        for thread in threads {
            if let value = DailyUXSidebarIndex.moveOptions(for: thread, in: threads, now: now) {
                options[thread.id] = value
            }
        }
        // Ordered by key: a-1(f), a-2(m), b-1(n), a-3(t).
        #expect(options["env-a:a-1"] == FeatureThreadMoveOptions(canMoveUp: false, canMoveDown: true))
        #expect(options["env-a:a-3"] == FeatureThreadMoveOptions(canMoveUp: true, canMoveDown: false))
        // env-b's row sorts mid-list by key but cannot be written itself.
        #expect(options["env-b:b-1"] == nil)
        // Moving a-2 down past the keyed env-b row is still a single write on
        // a-2, so it stays enabled.
        #expect(options["env-a:a-2"] == FeatureThreadMoveOptions(canMoveUp: true, canMoveDown: true))
    }

    @Test
    func activeSectionUsesActiveOrderKeysAndCapability() {
        let threads = sectionThreads(
            environmentID: "env-a",
            pinned: false,
            keys: ["a-1": "f", "a-2": "m"],
            supportsActiveReorder: true
        )
        let ordered = DailyUXSidebarIndex.orderedSection(threads, section: .active, now: now)
        let planner = ThreadOrderPlanner.movePlanner(
            ordered: ordered,
            all: threads,
            section: .active
        )
        let assignments = planner(ordered[1], .up)
        #expect(assignments?.count == 1)
        #expect(assignments?[0].threadID == "env-a:a-2")
    }

    // MARK: - pinned section ordering

    @Test
    func pinnedSectionSortsKeyedRowsFirstThenKeylessByCreation() {
        var keyed = thread(id: "env-a:keyed", pinned: true, created: -1_000)
        keyed.pinOrderKey = "m"
        var keyedEarly = thread(id: "env-a:keyed-early", pinned: true, created: -500)
        keyedEarly.pinOrderKey = "f"
        let keylessNew = thread(id: "env-a:keyless-new", pinned: true, created: -100)
        let keylessOld = thread(id: "env-a:keyless-old", pinned: true, created: -900)

        let ordered = DailyUXSidebarIndex.orderedSection(
            [keylessNew, keyed, keylessOld, keyedEarly],
            section: .pinned,
            now: now
        )
        #expect(ordered.map(\.id) == [
            "env-a:keyed-early",
            "env-a:keyed",
            "env-a:keyless-new",
            "env-a:keyless-old",
        ])
    }

    @Test
    func pinnedTiesBreakByWireIDThenEnvironment() {
        var first = thread(id: "z-env:a-thread", pinned: true, created: -100)
        first.wireID = "a-thread"
        first.environmentID = "z-env"
        first.pinOrderKey = "m"
        var second = thread(id: "a-env:z-thread", pinned: true, created: -100)
        second.wireID = "z-thread"
        second.environmentID = "a-env"
        second.pinOrderKey = "m"
        var sameWire = thread(id: "a-env:a-thread", pinned: true, created: -100)
        sameWire.wireID = "a-thread"
        sameWire.environmentID = "a-env"
        sameWire.pinOrderKey = "m"

        let ordered = DailyUXSidebarIndex.orderedSection(
            [second, first, sameWire],
            section: .pinned,
            now: now
        )
        #expect(ordered.map(\.id) == ["a-env:a-thread", "z-env:a-thread", "a-env:z-thread"])
    }

    @Test
    func orderedSectionExcludesArchivedSnoozedAndSettledRows() {
        let live = thread(id: "env-a:live", pinned: true, created: -100)
        var archived = thread(id: "env-a:archived", pinned: true, created: -50)
        archived.isArchived = true
        var snoozed = thread(id: "env-a:snoozed", pinned: true, created: -50)
        snoozed.snoozedUntil = now.addingTimeInterval(3_600)
        snoozed.supportsSnooze = true
        var settled = thread(id: "env-a:settled", pinned: true, created: -50)
        settled.supportsSettlement = true
        settled.settlementFacts = FeatureThreadSettlementFacts(settlementOverride: .settled)

        let ordered = DailyUXSidebarIndex.orderedSection(
            [live, archived, snoozed, settled],
            section: .pinned,
            now: now
        )
        #expect(ordered.map(\.id) == ["env-a:live"])
    }

    // MARK: - fixtures

    private func thread(
        id: String,
        pinned: Bool = false,
        created: TimeInterval
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            wireID: String(id.split(separator: ":").last!),
            projectID: "project",
            environmentID: id.split(separator: ":").first.map(String.init),
            title: "Task",
            createdAt: now.addingTimeInterval(created),
            updatedAt: now.addingTimeInterval(created),
            pinnedAt: pinned ? now.addingTimeInterval(created) : nil,
            supportsPinning: true
        )
    }

    private func sectionThreads(
        environmentID: String,
        pinned: Bool,
        keys: [String: String?],
        supportsPinReorder: Bool = false,
        supportsActiveReorder: Bool = false
    ) -> [FeatureThread] {
        keys.keys.sorted().enumerated().map { index, wireID in
            FeatureThread(
                id: "\(environmentID):\(wireID)",
                wireID: wireID,
                projectID: "project",
                environmentID: environmentID,
                title: "Task",
                createdAt: now.addingTimeInterval(-Double(index) - 100),
                updatedAt: now.addingTimeInterval(-Double(index) - 100),
                activeOrderKey: pinned ? nil : keys[wireID] ?? nil,
                pinnedAt: pinned ? now.addingTimeInterval(-Double(index) - 100) : nil,
                pinOrderKey: pinned ? keys[wireID] ?? nil : nil,
                supportsPinning: true,
                supportsPinReorder: supportsPinReorder,
                supportsActiveReorder: supportsActiveReorder
            )
        }
    }
}
