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
