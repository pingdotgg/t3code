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

    // MARK: - planReorder

    @Test
    func reorderWritesASingleKeyOnTheMovedThread() {
        let assignments = ThreadOrderPlanner.planReorder(
            orderedIDs: ["a", "c", "b"],
            keysByID: ["a": "f", "b": "m", "c": "t"],
            movedID: "c"
        )
        #expect(assignments.count == 1)
        #expect(assignments[0].threadID == "c")
        #expect(assignments[0].orderKey > "f")
        #expect(assignments[0].orderKey < "m")
    }

    @Test
    func keylessNeighborMaterializesTheWholeSectionInTheNewOrder() {
        let assignments = ThreadOrderPlanner.planReorder(
            orderedIDs: ["b", "a", "c"],
            keysByID: ["a": nil, "b": "m", "c": nil],
            movedID: "b"
        )
        let keys = assignments.map(\.orderKey)
        #expect(keys.sorted() == keys)
        // The requested order is [b, a, c]: b's new key sorts first.
        let keyByID = Dictionary(
            uniqueKeysWithValues: assignments.map { ($0.threadID, $0.orderKey) }
        )
        #expect(keyByID["b"]! < keyByID["a"]!)
        #expect(keyByID["a"]! < keyByID["c"]!)
    }

    @Test
    func keylessThreadMovesIntoTheArrangedRunWithOneWrite() {
        let assignments = ThreadOrderPlanner.planReorder(
            orderedIDs: ["new", "first", "reopened", "last"],
            keysByID: ["new": nil, "reopened": nil, "first": "f", "last": "t"],
            movedID: "reopened"
        )
        #expect(assignments.count == 1)
        #expect(assignments[0].threadID == "reopened")
        #expect(assignments[0].orderKey > "f")
        #expect(assignments[0].orderKey < "t")
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

    // MARK: - planDrop capability gating

    @Test
    func dropRequiresTheSectionCapabilityOnTheMovedEnvironment() {
        // env-a supports pinned reordering but not active reordering: its
        // active rows cannot be written in the active section.
        let threads = sectionThreads(
            environmentID: "env-a",
            pinned: false,
            keys: ["a-1": "f", "a-2": "m"],
            supportsPinReorder: true,
            supportsActiveReorder: false
        )
        let ordered = DailyUXSidebarIndex.orderedSection(threads, section: .active, now: now)
        #expect(ThreadOrderPlanner.planDrop(
            ordered: [ordered[1], ordered[0]],
            all: threads,
            section: .active,
            connectedEnvironmentIDs: ["env-a"],
            movedID: "env-a:a-2"
        ) == nil)
        // The same row is writable in the pinned section.
        let pinned = sectionThreads(
            environmentID: "env-a",
            pinned: true,
            keys: ["a-1": "f", "a-2": "m"],
            supportsPinReorder: true,
            supportsActiveReorder: false
        )
        let pinnedOrdered = DailyUXSidebarIndex.orderedSection(pinned, section: .pinned, now: now)
        #expect(ThreadOrderPlanner.planDrop(
            ordered: [pinnedOrdered[1], pinnedOrdered[0]],
            all: pinned,
            section: .pinned,
            connectedEnvironmentIDs: ["env-a"],
            movedID: "env-a:a-2"
        ) != nil)
    }

    // MARK: - planDrop (hold-and-drag reorder)

    @Test
    func dropToSectionEndWritesASingleKeyBelowTheLastRow() {
        let threads = sectionThreads(
            environmentID: "env-a",
            pinned: true,
            keys: ["a-1": "f", "a-2": "m", "a-3": "t"],
            supportsPinReorder: true
        )
        let ordered = DailyUXSidebarIndex.orderedSection(threads, section: .pinned, now: now)
        #expect(ordered.map(\.id) == ["env-a:a-1", "env-a:a-2", "env-a:a-3"])

        // Dragging the first row below the last: post-drop order [a-2, a-3, a-1].
        let assignments = ThreadOrderPlanner.planDrop(
            ordered: [ordered[1], ordered[2], ordered[0]],
            all: threads,
            section: .pinned,
            connectedEnvironmentIDs: ["env-a"],
            movedID: "env-a:a-1"
        )
        #expect(assignments?.count == 1)
        #expect(assignments?[0].threadID == "env-a:a-1")
        #expect(assignments![0].orderKey > "t")
    }

    @Test
    func dropToSectionStartWritesASingleKeyAboveTheFirstRow() {
        let threads = sectionThreads(
            environmentID: "env-a",
            pinned: false,
            keys: ["a-1": "f", "a-2": "m", "a-3": "t"],
            supportsActiveReorder: true
        )
        let ordered = DailyUXSidebarIndex.orderedSection(threads, section: .active, now: now)
        // Keyless-first ordering does not apply here: every row is keyed, so
        // keys decide — a-1(f), a-2(m), a-3(t).
        #expect(ordered.map(\.id) == ["env-a:a-1", "env-a:a-2", "env-a:a-3"])

        // Dragging the last row above the first: post-drop order [a-3, a-1, a-2].
        let assignments = ThreadOrderPlanner.planDrop(
            ordered: [ordered[2], ordered[0], ordered[1]],
            all: threads,
            section: .active,
            connectedEnvironmentIDs: ["env-a"],
            movedID: "env-a:a-3"
        )
        #expect(assignments?.count == 1)
        #expect(assignments?[0].threadID == "env-a:a-3")
        #expect(assignments![0].orderKey < "f")
    }

    @Test
    func dropOntoKeylessNeighborsMaterializesTheSectionInTheDroppedOrder() {
        // Pinned order: keyed a-2(m) first, then keyless by newest creation.
        let threads = sectionThreads(
            environmentID: "env-a",
            pinned: true,
            keys: ["a-1": nil, "a-2": "m", "a-3": nil],
            supportsPinReorder: true
        )
        let ordered = DailyUXSidebarIndex.orderedSection(threads, section: .pinned, now: now)
        #expect(ordered.map(\.id) == ["env-a:a-2", "env-a:a-1", "env-a:a-3"])

        // Drag a-2 to the bottom: both new neighbors are keyless, so the whole
        // section gets fresh spread keys in the dropped order.
        let dropped = [ordered[1], ordered[2], ordered[0]]
        let assignments = ThreadOrderPlanner.planDrop(
            ordered: dropped,
            all: threads,
            section: .pinned,
            connectedEnvironmentIDs: ["env-a"],
            movedID: "env-a:a-2"
        )
        #expect(assignments?.map(\.threadID) == ["env-a:a-1", "env-a:a-3", "env-a:a-2"])
        let keys = assignments!.map(\.orderKey)
        #expect(keys.sorted() == keys)
    }

    @Test
    func dropRejectsAPlanThatWouldWriteToAnUnwritableNeighbor() {
        let writable = sectionThreads(
            environmentID: "env-a",
            pinned: true,
            keys: ["a-1": "f"],
            supportsPinReorder: true
        )
        // env-b predates reordering: keyless and unwritable.
        let legacy = sectionThreads(
            environmentID: "env-b",
            pinned: true,
            keys: ["b-1": nil],
            supportsPinReorder: false
        )
        let all = writable + legacy
        let ordered = DailyUXSidebarIndex.orderedSection(all, section: .pinned, now: now)
        #expect(ordered.map(\.id) == ["env-a:a-1", "env-b:b-1"])

        // Dragging a-1 below the keyless env-b row needs a spread rewrite that
        // would assign b-1 a key — refused, no partial write.
        let dropped = [ordered[1], ordered[0]]
        #expect(ThreadOrderPlanner.planDrop(
            ordered: dropped,
            all: all,
            section: .pinned,
            connectedEnvironmentIDs: ["env-a", "env-b"],
            movedID: "env-a:a-1"
        ) == nil)
        // The legacy row itself cannot be dragged either.
        #expect(ThreadOrderPlanner.planDrop(
            ordered: dropped,
            all: all,
            section: .pinned,
            connectedEnvironmentIDs: ["env-a", "env-b"],
            movedID: "env-b:b-1"
        ) == nil)
    }

    @Test
    func dropRejectsAMovedRowOnADisconnectedEnvironment() {
        let threads = sectionThreads(
            environmentID: "env-a",
            pinned: true,
            keys: ["a-1": "f", "a-2": "t"],
            supportsPinReorder: true
        ) + sectionThreads(
            environmentID: "env-b",
            pinned: true,
            keys: ["b-1": "m"],
            supportsPinReorder: true
        )
        let ordered = DailyUXSidebarIndex.orderedSection(threads, section: .pinned, now: now)
        #expect(ordered.map(\.id) == ["env-a:a-1", "env-b:b-1", "env-a:a-2"])

        // env-b is disconnected: its row anchors position but cannot be moved.
        #expect(ThreadOrderPlanner.planDrop(
            ordered: [ordered[1], ordered[0], ordered[2]],
            all: threads,
            section: .pinned,
            connectedEnvironmentIDs: ["env-a"],
            movedID: "env-b:b-1"
        ) == nil)
        // A connected row can still drop across the stale anchor with one write.
        let assignments = ThreadOrderPlanner.planDrop(
            ordered: [ordered[0], ordered[2], ordered[1]],
            all: threads,
            section: .pinned,
            connectedEnvironmentIDs: ["env-a"],
            movedID: "env-a:a-2"
        )
        #expect(assignments == [
            FeatureThreadOrderAssignment(threadID: "env-a:a-2", orderKey: "j")
        ])
    }

    @Test
    func dropReservesKeysHeldByRowsOutsideTheDroppedOrder() {
        let threads = sectionThreads(
            environmentID: "env-a",
            pinned: true,
            keys: ["a-1": "f", "a-2": "t", "a-3": "z"],
            supportsPinReorder: true
        )
        // A snoozed row holds "m" — the exact midpoint of f and t. Hidden from
        // the section, its key stays reserved so the dropped row lands on the
        // next free key instead of colliding with it.
        var snoozed = thread(id: "env-a:snoozed", pinned: true, created: -10)
        snoozed.pinOrderKey = "m"
        snoozed.snoozedUntil = now.addingTimeInterval(3_600)
        snoozed.supportsSnooze = true
        let all = threads + [snoozed]
        let ordered = DailyUXSidebarIndex.orderedSection(all, section: .pinned, now: now)
        #expect(ordered.map(\.id) == ["env-a:a-1", "env-a:a-2", "env-a:a-3"])

        // Drop a-3 between a-1(f) and a-2(t).
        let assignments = ThreadOrderPlanner.planDrop(
            ordered: [ordered[0], ordered[2], ordered[1]],
            all: all,
            section: .pinned,
            connectedEnvironmentIDs: ["env-a"],
            movedID: "env-a:a-3"
        )
        #expect(assignments?.count == 1)
        #expect(assignments![0].orderKey > "f")
        #expect(assignments![0].orderKey < "t")
        #expect(assignments![0].orderKey != "m")
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
