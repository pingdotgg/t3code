import Testing

@testable import SergeCodeMac

@Suite("Motion policy")
struct MotionTests {
    @Test("routine motion stays within the responsiveness budget")
    func routineDurations() {
        let profile = MotionProfile(reduceMotion: false)

        #expect(profile.feedbackDuration == 0.14)
        #expect(profile.revealDuration == 0.19)
        #expect(profile.structureDuration == 0.24)
        #expect(profile.structureDuration <= 0.26)
        #expect(profile.delightDuration <= 0.42)
        // Playful, but short enough that rapid switching never queues ripples.
        #expect(profile.burstDuration <= 0.65)
        // The effort knob settles fast enough to keep dragging through, and
        // bounces enough that a detent reads as a landing.
        #expect(profile.knobSnapDuration <= 0.4)
        #expect(profile.knobSnapBounce > 0.2 && profile.knobSnapBounce < 0.5)
    }

    @Test("reduced motion removes movement and decorative effects")
    func reducedMotion() {
        let profile = MotionProfile(reduceMotion: true)

        #expect(profile.changeDuration == 0.12)
        #expect(!profile.usesMovement)
        #expect(!profile.allowsDecorativeEffects)
    }

    @Test("ordinary motion permits movement and rare effects")
    func ordinaryMotion() {
        let profile = MotionProfile(reduceMotion: false)

        #expect(profile.usesMovement)
        #expect(profile.allowsDecorativeEffects)
    }
}

@Suite("Playful motion policy")
struct PlayfulMotionTests {
    @Test("both switches on is the only state that animates characters")
    func characterMotionNeedsBothSwitches() {
        #expect(
            PlayfulMotionProfile(reduceMotion: false, playfulEnabled: true)
                .allowsCharacterMotion)
        #expect(
            !PlayfulMotionProfile(reduceMotion: true, playfulEnabled: true)
                .allowsCharacterMotion)
        #expect(
            !PlayfulMotionProfile(reduceMotion: false, playfulEnabled: false)
                .allowsCharacterMotion)
    }

    @Test("Reduce Motion stills the playful surfaces without deleting them")
    func reduceMotionKeepsTheSurfaces() {
        let profile = PlayfulMotionProfile(reduceMotion: true, playfulEnabled: true)

        // The dock and the pet each carry state nothing else shows as
        // plainly, so Reduce Motion freezes them rather than removing them.
        #expect(profile.showsPlayfulSurfaces)
        #expect(!profile.allowsCharacterMotion)
    }

    @Test("opting out removes the playful surfaces entirely")
    func optingOutRemovesTheSurfaces() {
        let profile = PlayfulMotionProfile(reduceMotion: false, playfulEnabled: false)

        #expect(!profile.showsPlayfulSurfaces)
        #expect(!profile.allowsCharacterMotion)
    }

    @Test("decorative loops stay inside their cost budget")
    func loopTimings() {
        let profile = PlayfulMotionProfile(reduceMotion: false, playfulEnabled: true)

        // 30fps for always-on decorative canvases; the shapes are soft-edged
        // blurs where the extra frames buy nothing visible.
        #expect(profile.decorativeFrameInterval == 1.0 / 30.0)
        // Slow enough to read as a drift rather than a spinner.
        #expect(profile.orbPeriod >= 4)
        #expect(profile.petBreathPeriod >= 2)
        // Long enough to read the caption twice, short enough that a settled
        // thread does not keep a character parked over it.
        #expect(profile.petVictoryDwell >= 4 && profile.petVictoryDwell <= 10)
    }
}
