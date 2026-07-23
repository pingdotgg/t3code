import Testing

@testable import SergeCodeMac

@Suite("Entrance policy")
struct EntrancePolicyTests {
    @Test("stagger delay grows one step per sibling")
    func staggerProgression() {
        let policy = EntrancePolicy(reduceMotion: false)

        #expect(policy.delay(forIndex: 0) == 0)
        #expect(policy.delay(forIndex: 1) == policy.staggerStep)
        #expect(policy.delay(forIndex: 3) == policy.staggerStep * 3)
    }

    @Test("stagger clamps so long lists cannot ripple")
    func staggerClamp() {
        let policy = EntrancePolicy(reduceMotion: false)
        let longest = policy.delay(forIndex: policy.maxStaggered)

        #expect(policy.delay(forIndex: policy.maxStaggered + 1) == longest)
        #expect(policy.delay(forIndex: 500) == longest)
        // A restored thread must finish entering well inside a quarter second.
        #expect(longest <= 0.25)
    }

    @Test("negative indices are treated as the first sibling")
    func negativeIndex() {
        let policy = EntrancePolicy(reduceMotion: false)

        #expect(policy.delay(forIndex: -1) == 0)
    }

    @Test("reduced motion removes delay, offset, and scale")
    func reducedMotion() {
        let policy = EntrancePolicy(reduceMotion: true)

        #expect(policy.delay(forIndex: 5) == 0)
        // Every role, so a role added later cannot quietly skip Reduce Motion.
        for role in EntranceRole.allCases {
            #expect(policy.offset(for: role) == 0)
            #expect(policy.initialScale(for: role) == 1)
        }
    }

    @Test("ordinary motion moves content-bearing roles")
    func ordinaryMotion() {
        let policy = EntrancePolicy(reduceMotion: false)

        #expect(policy.offset(for: .row) > 0)
        #expect(policy.offset(for: .card) > 0)
        #expect(policy.offset(for: .pane) > 0)
        // Controls and the hero settle in place; sliding chrome reads as a
        // glitch, and the hero has its scale to carry the arrival.
        #expect(policy.offset(for: .control) == 0)
        #expect(policy.offset(for: .hero) == 0)
        #expect(policy.initialScale(for: .card) < 1)
        // The hero is the app's one expressive arrival, so it travels furthest.
        #expect(policy.initialScale(for: .hero) < policy.initialScale(for: .card))
    }

    @Test("entrance plays once and never while suppressed")
    func playOnce() {
        let policy = EntrancePolicy(reduceMotion: false)

        #expect(policy.shouldPlay(alreadyPlayed: false, suppressed: false))
        #expect(!policy.shouldPlay(alreadyPlayed: true, suppressed: false))
        #expect(!policy.shouldPlay(alreadyPlayed: false, suppressed: true))
        #expect(!policy.shouldPlay(alreadyPlayed: true, suppressed: true))
    }

    @Test("reduced motion still animates rather than popping")
    func reducedMotionStillAnimates() {
        // SER-144's requirement is that nothing appears instantly. Under Reduce
        // Motion the fade survives even though movement is removed.
        let policy = EntrancePolicy(reduceMotion: true)

        #expect(policy.shouldPlay(alreadyPlayed: false, suppressed: false))
        #expect(policy.initialOpacity == 0)
    }
}
