import Testing

@testable import SergeCodeMac

@Suite("Effort level style")
struct EffortLevelStyleTests {
    @Test("well-known wire ids map onto ordered ramp ranks")
    func keywordRanks() {
        let step = 1.0 / Double(EffortLevelStyle.slotCount - 1)
        let cases: [(String, Double, EffortCostTier)] = [
            ("minimal", 0, .standard),
            ("low", step, .standard),
            ("medium", step * 2, .standard),
            ("high", step * 3, .standard),
            ("xhigh", step * 4, .extraHigh),
            ("max", step * 5, .maximum),
            ("ultrathink", step * 5, .maximum),
            ("ultra", 1, .unlimited),
            ("ultra-code", 1, .unlimited),
            ("ultracode", 1, .unlimited),
        ]
        for (id, rank, costTier) in cases {
            let style = EffortLevelStyle.resolve(choiceID: id, index: 0, count: 4)
            #expect(style.rank == rank, "\(id) should rank \(rank)")
            #expect(style.costTier == costTier, "\(id) should use \(costTier)")
        }
    }

    @Test("ranks rise monotonically along the calm-to-intense ramp")
    func monotonicSlots() {
        let ids = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        let slots = ids.map { EffortLevelStyle.resolve(choiceID: $0, index: 0, count: 5).slot }

        #expect(slots == slots.sorted())
        #expect(slots.first == 0)
        #expect(slots.last == EffortLevelStyle.slotCount - 1)
    }

    @Test("keyword matching wins over ordinal position")
    func keywordBeatsOrdinal() {
        // "low" sits last in the list but must keep its calm semantic slot.
        let style = EffortLevelStyle.resolve(choiceID: "low", index: 3, count: 4)
        #expect(style.slot == 1)
        #expect(style.costTier == .standard)
    }

    @Test("unknown ids fall back to ordinal position within the model's list")
    func ordinalFallback() {
        let first = EffortLevelStyle.resolve(choiceID: "turbo", index: 0, count: 3)
        let last = EffortLevelStyle.resolve(choiceID: "turbo", index: 2, count: 3)
        let single = EffortLevelStyle.resolve(choiceID: "turbo", index: 0, count: 1)

        #expect(first.slot == 0)
        #expect(last.slot == EffortLevelStyle.slotCount - 1)
        #expect(single.rank == 0.5)
        #expect(last.costTier == .standard)
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

    @Test("only known above-high modes receive usage warnings")
    func warningTiers() {
        #expect(
            EffortLevelStyle.resolve(choiceID: "high", index: 3, count: 7).costTier
                == .standard)
        #expect(
            EffortLevelStyle.resolve(choiceID: "xhigh", index: 4, count: 7).costTier
                == .extraHigh)
        #expect(
            EffortLevelStyle.resolve(choiceID: "max", index: 5, count: 7).costTier
                == .maximum)
        #expect(
            EffortLevelStyle.resolve(choiceID: "ultra", index: 6, count: 7).costTier
                == .unlimited)

        // An unknown provider's last choice may use the hottest ramp color, but
        // must not claim unlimited-subagent semantics that were never advertised.
        #expect(
            EffortLevelStyle.resolve(choiceID: "turbo", index: 2, count: 3).costTier
                == .standard)
    }

    @Test("usage-warning animation cost rises with severity and remains bounded")
    func animationBudgets() {
        #expect(EffortCostTier.extraHigh.particleCount < EffortCostTier.maximum.particleCount)
        #expect(EffortCostTier.maximum.particleCount < EffortCostTier.unlimited.particleCount)
        #expect(
            EffortCostTier.extraHigh.animationFrameInterval
                > EffortCostTier.maximum.animationFrameInterval)
        #expect(
            EffortCostTier.maximum.animationFrameInterval
                > EffortCostTier.unlimited.animationFrameInterval)
        #expect(EffortCostTier.unlimited.animationFrameInterval >= 1.0 / 30.0)
    }
}
