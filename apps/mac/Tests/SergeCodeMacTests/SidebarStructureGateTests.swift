import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Sidebar structure gate")
@MainActor
struct SidebarStructureGateTests {
    private func census(_ rows: [String], standing: [String]? = nil) -> SidebarRowCensus {
        SidebarRowCensus(standing: Set(standing ?? rows), rows: Set(rows))
    }

    @Test("the first pass inherits — nothing has moved yet")
    func firstPassInherits() {
        let gate = SidebarStructureGate()

        #expect(gate.decide(census(["section:a", "a/active/t1"])) == .inherit)
    }

    @Test("an unchanged census inherits, so hover and press keep their own curves")
    func unchangedCensusInherits() {
        let gate = SidebarStructureGate()
        let state = census(["section:a", "a/active/t1"])
        _ = gate.decide(state)

        #expect(gate.decide(state) == .inherit)
        #expect(gate.decide(state) == .inherit)
    }

    @Test("a session arriving animates")
    func arrivalAnimates() {
        let gate = SidebarStructureGate()
        _ = gate.decide(census(["section:a", "a/active/t1"]))

        #expect(gate.decide(census(["section:a", "a/active/t1", "a/active/t2"])) == .animate)
    }

    @Test("a promotion animates: the tier moves, the row does not leave")
    func promotionAnimates() {
        let gate = SidebarStructureGate()
        _ = gate.decide(
            census(
                ["section:a", "a/active/t1", "a/active/t2"],
                standing: ["section:a", "a/active/t1#3", "a/active/t2#3"]))

        // t2 needs attention now, so its tiered key changes while the row set
        // stays exactly the same. This is the move the animation exists for.
        let promoted = census(
            ["section:a", "a/active/t1", "a/active/t2"],
            standing: ["section:a", "a/active/t1#3", "a/active/t2#1"])
        #expect(gate.decide(promoted) == .animate)
    }

    @Test("a session leaving snaps, because an animated removal strands its row view")
    func removalSnaps() {
        let gate = SidebarStructureGate()
        _ = gate.decide(census(["section:a", "a/active/t1", "a/active/t2"]))

        #expect(gate.decide(census(["section:a", "a/active/t1"])) == .snap)
    }

    @Test("one row leaving while another arrives snaps — the case that stained the list")
    func simultaneousChurnSnaps() {
        let gate = SidebarStructureGate()
        _ = gate.decide(census(["section:a", "a/active/t1", "a/active/t2"]))

        #expect(gate.decide(census(["section:a", "a/active/t1", "a/active/t3"])) == .snap)
    }

    @Test("a whole project leaving snaps")
    func sectionRemovalSnaps() {
        let gate = SidebarStructureGate()
        _ = gate.decide(census(["section:a", "a/active/t1", "section:b", "b/active/t2"]))

        #expect(gate.decide(census(["section:a", "a/active/t1"])) == .snap)
    }

    @Test("an empty state giving way to rows snaps: the placeholder is a row too")
    func emptyStateHandoffSnaps() {
        let gate = SidebarStructureGate()
        _ = gate.decide(census(["search:section", "search/empty"]))

        #expect(gate.decide(census(["search:section", "search/t1"])) == .snap)
    }

    @Test("opening the settled disclosure animates")
    func disclosureRevealAnimates() {
        let gate = SidebarStructureGate()
        _ = gate.decide(census(["section:a", "a/active/t1", "a/settled-toggle"]))

        let revealed = census([
            "section:a", "a/active/t1", "a/settled-toggle", "a/settled/t9",
        ])
        #expect(gate.decide(revealed) == .animate)
    }

    @Test("the decision is against the census last seen, not the last animated one")
    func decisionTracksEveryPass() {
        let gate = SidebarStructureGate()
        _ = gate.decide(census(["section:a", "a/active/t1", "a/active/t2"]))
        #expect(gate.decide(census(["section:a", "a/active/t1"])) == .snap)
        // Back up to two rows: measured against the one-row census that
        // actually rendered, this is an arrival.
        #expect(gate.decide(census(["section:a", "a/active/t1", "a/active/t2"])) == .animate)
    }
}
