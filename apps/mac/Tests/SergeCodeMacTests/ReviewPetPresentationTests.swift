import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Auto-review pet")
struct ReviewPetPresentationTests {
    private let playful = PlayfulMotionProfile(reduceMotion: false, playfulEnabled: true)

    @Test("only auto-review statuses summon the pet")
    func phaseMapping() {
        #expect(ReviewPetPhase(status: .reviewing) == .reviewing)
        #expect(ReviewPetPhase(status: .fixing) == .fixing)
        #expect(ReviewPetPhase(status: .readyToMerge) == .readyToMerge)

        for status in [
            ThreadStatus.idle, .running, .waiting, .waitingApproval, .waitingInput,
            .backgroundWork, .error, .archived, .settled, .done,
        ] {
            #expect(ReviewPetPhase(status: status) == nil, "\(status) must not summon the pet")
        }
    }

    @Test("every phase has copy and a prop")
    func everyPhaseIsPresentable() {
        for phase in ReviewPetPhase.allCases {
            #expect(!ReviewPetPresentation.caption(for: phase).isEmpty)
            #expect(!ReviewPetPresentation.propSymbolName(for: phase).isEmpty)
            #expect(
                ReviewPetPresentation.accessibilityLabel(for: phase)
                    .contains(ReviewPetPresentation.caption(for: phase)))
        }
    }

    @Test("copy follows the brand voice")
    func copyIsCalm() {
        for phase in ReviewPetPhase.allCases {
            let caption = ReviewPetPresentation.caption(for: phase)
            // BRAND.md: sentence case, no exclamation marks.
            #expect(!caption.contains("!"))
            #expect(caption.first?.isUppercase == true)
        }
    }

    @Test("the settled phase retires itself, the in-flight phases do not")
    func onlySettledPhaseHasADwell() {
        // readyToMerge persists until the user merges — hours, potentially —
        // so a pet without a dwell would become permanent furniture.
        #expect(
            ReviewPetPresentation.dwell(for: .readyToMerge, profile: playful)
                == playful.petVictoryDwell)
        #expect(ReviewPetPresentation.dwell(for: .reviewing, profile: playful) == nil)
        #expect(ReviewPetPresentation.dwell(for: .fixing, profile: playful) == nil)
    }
}

@Suite("Terrier pose")
struct TerrierPoseTests {
    /// One second of frames at the decorative cadence, over a window long
    /// enough to cover every schedule in the pose — including the 11s sigh
    /// and the 8.7s blep.
    private func frames(phase: ReviewPetPhase, seconds: Double = 30) -> [TerrierPose] {
        let step = 1.0 / 30.0
        return stride(from: 0, to: seconds, by: step).map {
            TerrierPose(phase: phase, time: $0)
        }
    }

    @Test("the bob stays small enough that it can never shift layout")
    func bobIsBounded() {
        for phase in ReviewPetPhase.allCases {
            for pose in frames(phase: phase) {
                #expect(abs(pose.bob) <= 8, "\(phase) bob escaped its box at \(pose.bob)")
                #expect(pose.squash >= 0.9 && pose.squash <= 1.1)
            }
        }
    }

    @Test("the new dog channels stay inside their boxes")
    func dogChannelsAreBounded() {
        for phase in ReviewPetPhase.allCases {
            for pose in frames(phase: phase) {
                // The jiggle is a scale delta on the belly alone; anything
                // bigger than this stops reading as mass and starts reading
                // as the render glitching.
                #expect(abs(pose.bellyJiggle) <= 0.15, "\(phase) belly at \(pose.bellyJiggle)")
                #expect(pose.tongue >= 0 && pose.tongue <= 1)
                #expect(abs(pose.tailWag) <= 30, "\(phase) tail at \(pose.tailWag)")
                #expect(abs(pose.headTilt) <= 12, "\(phase) head at \(pose.headTilt)")
            }
        }
    }

    @Test("gaze and blink stay inside their ranges")
    func gazeAndBlinkAreClamped() {
        for pose in frames(phase: .reviewing) {
            #expect(pose.look >= -1 && pose.look <= 1)
            #expect(pose.blink >= 0 && pose.blink <= 1)
            #expect(pose.sparkle >= 0 && pose.sparkle <= 1)
        }
    }

    @Test("blinking is occasional, not a flicker")
    func blinksAreRare() {
        let closed = frames(phase: .reviewing).filter { $0.blink > 0.5 }.count
        let total = frames(phase: .reviewing).count
        // Eyes shut for a small slice of the window: enough to read as a
        // drowsy blink, nowhere near enough to read as a strobe. The
        // permanent sleepy lid is drawn in the view, not the pose, so it
        // cannot leak into this duty cycle.
        #expect(Double(closed) / Double(total) < 0.1)
        #expect(closed > 0, "the terrier never blinked")
    }

    @Test("the celebration actually pants and wags")
    func celebrationIsLively() {
        let poses = frames(phase: .readyToMerge, seconds: 5)
        // Sustained pant, not the occasional idle blep.
        #expect(poses.allSatisfy { $0.tongue > 0.3 })
        // And the nub hits real speed at some point in the cycle.
        #expect(poses.contains { abs($0.tailWag) > 15 })
    }

    @Test("the resting pose is completely still, but composed")
    func restingPoseIsStill() {
        for phase in ReviewPetPhase.allCases {
            let pose = TerrierPose.resting(phase: phase)
            #expect(pose.bob == 0)
            #expect(pose.squash == 1)
            #expect(pose.blink == 0)
            #expect(pose.look == 0)
            #expect(pose.earTwitch == 0)
            #expect(pose.sparkle == 0)
            #expect(pose.bellyJiggle == 0)
            #expect(pose.tongue == 0)
            #expect(pose.tailWag == 0)
            // Composed is not the same as zeroed: the still frame keeps the
            // head tilt so the dog looks arranged, not switched off.
            #expect(pose.headTilt != 0)
        }
    }

    @Test("the pulse helper is a bounded, periodic burst")
    func pulseIsWellBehaved() {
        #expect(TerrierPose.pulse(0, period: 2, duration: 0.5) == 0)
        #expect(TerrierPose.pulse(0.25, period: 2, duration: 0.5) == 1)
        #expect(TerrierPose.pulse(1.0, period: 2, duration: 0.5) == 0)
        // Repeats a period later.
        #expect(abs(TerrierPose.pulse(2.25, period: 2, duration: 0.5) - 1) < 1e-9)
        // Degenerate inputs must not divide by zero.
        #expect(TerrierPose.pulse(1, period: 0, duration: 0.5) == 0)
        #expect(TerrierPose.pulse(1, period: 2, duration: 0) == 0)
    }
}
