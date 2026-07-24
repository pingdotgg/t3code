import Testing

@testable import SergeCodeMac

@Suite("Effort level style")
struct EffortLevelStyleTests {
    @Test("well-known wire ids map onto ordered ramp ranks")
    func keywordRanks() {
        let cases: [(String, Double)] = [
            ("minimal", 0),
            ("low", 0.25),
            ("medium", 0.5),
            ("high", 0.75),
            ("max", 1),
            ("ultrathink", 1),
            ("xhigh", 1),
        ]
        for (id, rank) in cases {
            let style = EffortLevelStyle.resolve(choiceID: id, index: 0, count: 4)
            #expect(style.rank == rank, "\(id) should rank \(rank)")
        }
    }

    @Test("ranks rise monotonically along the calm-to-intense ramp")
    func monotonicSlots() {
        let ids = ["minimal", "low", "medium", "high", "max"]
        let slots = ids.map { EffortLevelStyle.resolve(choiceID: $0, index: 0, count: 5).slot }

        #expect(slots == slots.sorted())
        #expect(slots.first == 0)
        #expect(slots.last == EffortLevelStyle.slotCount - 1)
    }

    @Test("keyword matching wins over ordinal position")
    func keywordBeatsOrdinal() {
        // "low" sits last in the list but must keep its calm semantic slot.
        let style = EffortLevelStyle.resolve(choiceID: "low", index: 3, count: 4)
        #expect(style.rank == 0.25)
    }

    @Test("unknown ids fall back to ordinal position within the model's list")
    func ordinalFallback() {
        let first = EffortLevelStyle.resolve(choiceID: "turbo", index: 0, count: 3)
        let last = EffortLevelStyle.resolve(choiceID: "turbo", index: 2, count: 3)
        let single = EffortLevelStyle.resolve(choiceID: "turbo", index: 0, count: 1)

        #expect(first.slot == 0)
        #expect(last.slot == EffortLevelStyle.slotCount - 1)
        #expect(single.rank == 0.5)
    }

    @Test("out-of-range ordinals clamp into the ramp")
    func clamping() {
        let style = EffortLevelStyle.resolve(choiceID: "turbo", index: 99, count: 4)
        #expect(style.slot == EffortLevelStyle.slotCount - 1)
    }

    @Test("every slot has a symbol and distinct slots give distinct symbols")
    func symbols() {
        #expect(EffortLevelStyle.slotSymbols.count == EffortLevelStyle.slotCount)
        let symbols = (0..<EffortLevelStyle.slotCount).map {
            EffortLevelStyle(slot: $0, rank: 0).symbolName
        }
        #expect(Set(symbols).count == EffortLevelStyle.slotCount)
    }
}
