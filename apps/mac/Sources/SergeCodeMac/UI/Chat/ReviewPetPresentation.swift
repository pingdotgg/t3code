import Foundation

/// What the auto-review pet is here to announce.
///
/// Auto-review runs entirely on the server: it polls GitHub, reviews the
/// diff, posts comments, and queues a fix turn back into the origin thread.
/// The only trace in the UI was a two-word status badge, so the most
/// autonomous thing the app does was also its least visible. The pet is the
/// announcement — a character that shows up while the reviewer is working and
/// leaves when it is done.
enum ReviewPetPhase: String, CaseIterable, Sendable {
    /// A review job is queued or running against the thread's PR.
    case reviewing
    /// The review found something actionable and a fix turn is queued or in
    /// flight on this thread.
    case fixing
    /// The latest review came back with nothing blocking.
    case readyToMerge

    /// Projected thread status is the app's single source for auto-review
    /// state (`ThreadStatusProjection` folds the server's phase into it), so
    /// the pet reads the same value the header badge and sidebar glyph do and
    /// cannot disagree with them.
    init?(status: ThreadStatus) {
        switch status {
        case .reviewing: self = .reviewing
        case .fixing: self = .fixing
        case .readyToMerge: self = .readyToMerge
        case .idle, .running, .waiting, .waitingApproval, .waitingInput, .backgroundWork,
            .error, .archived, .settled, .done:
            return nil
        }
    }
}

/// Copy and timing for the pet. Pure so the wording, the prop, and — most
/// importantly — the rule that keeps a settled thread from hosting a
/// permanent character are all testable without a window.
enum ReviewPetPresentation {
    /// Eyebrow above the caption. Constant: the bubble has to name what is
    /// talking, or a Boston terrier appearing over the transcript is a non
    /// sequitur.
    static let title = "Auto review"

    static func caption(for phase: ReviewPetPhase) -> String {
        switch phase {
        case .reviewing: "Sniffing through the pull request"
        case .fixing: "Chewing on what the review flagged"
        case .readyToMerge: "Clean review, back to napping"
        }
    }

    /// The prop in the pet's paw.
    static func propSymbolName(for phase: ReviewPetPhase) -> String {
        switch phase {
        case .reviewing: "magnifyingglass"
        case .fixing: "wrench.adjustable.fill"
        case .readyToMerge: "checkmark.seal.fill"
        }
    }

    /// How long the pet stays before flopping back into its bed, or `nil` to
    /// stay for as long as the phase lasts.
    ///
    /// The distinction is the whole reason this is a policy and not a
    /// constant: `reviewing` and `fixing` are transient states that end on
    /// their own, but `readyToMerge` is *settled* — it persists until the
    /// user merges, which can be hours. A pet that stayed for it would stop
    /// being an announcement and become permanent furniture over the
    /// transcript.
    static func dwell(for phase: ReviewPetPhase, profile: PlayfulMotionProfile) -> TimeInterval? {
        switch phase {
        case .reviewing, .fixing: nil
        case .readyToMerge: profile.petVictoryDwell
        }
    }

    static func accessibilityLabel(for phase: ReviewPetPhase) -> String {
        "\(title): \(caption(for: phase))"
    }
}

/// The pet's pose at an instant, derived analytically from the clock.
///
/// Pulled out of the view for two reasons: the arithmetic is the animation
/// (there is no other state), and the bounds are worth asserting — a blink
/// that lands too often, or a bob big enough to shift layout, is a bug you
/// cannot see in a still screenshot.
///
/// The character is a fat, lazy Boston terrier, and the maths is where that
/// reads: the breath is slower than a fit animal's, a deep sigh lands every
/// so often, and most of the secondary motion goes through the belly.
struct TerrierPose: Equatable, Sendable {
    /// Vertical offset in points; negative is up.
    var bob: Double = 0
    /// Vertical scale for the breathing squash.
    var squash: Double = 1
    /// 0 = eyes open, 1 = fully closed.
    var blink: Double = 0
    /// Horizontal gaze, -1 (left) to 1 (right).
    var look: Double = 0
    /// Ear rotation in degrees.
    var earTwitch: Double = 0
    /// Prop rotation in degrees.
    var propAngle: Double = 0
    /// Prop horizontal slide in points.
    var propSlide: Double = 0
    /// 0…1 intensity of the glint/spark burst around the prop.
    var sparkle: Double = 0
    /// Signed scale delta for the beer belly's own wobble — the jelly physics
    /// are one number wide. Positive is wider-and-shorter.
    var bellyJiggle: Double = 0
    /// 0 = tongue tucked, 1 = full blep.
    var tongue: Double = 0
    /// Tail-nub rotation in degrees. Boston terriers have a stub, so this is
    /// a wiggle, not a sweep.
    var tailWag: Double = 0
    /// Head rotation in degrees — the confused-dog tilt.
    var headTilt: Double = 0

    /// Resting pose: what Reduce Motion renders. Deliberately not the t=0
    /// pose — a still frame should look composed, so the head sits at a
    /// slight tilt and the prop at a slight angle rather than dead vertical.
    /// Every *motion* channel is zero: nothing may move, but the dog may
    /// still have character.
    static func resting(phase: ReviewPetPhase) -> TerrierPose {
        TerrierPose(propAngle: phase == .fixing ? -12 : 8, headTilt: 4)
    }

    init() {}

    init(bob: Double = 0, squash: Double = 1, blink: Double = 0, look: Double = 0,
         earTwitch: Double = 0, propAngle: Double = 0, propSlide: Double = 0,
         sparkle: Double = 0, bellyJiggle: Double = 0, tongue: Double = 0,
         tailWag: Double = 0, headTilt: Double = 0
    ) {
        self.bob = bob
        self.squash = squash
        self.blink = blink
        self.look = look
        self.earTwitch = earTwitch
        self.propAngle = propAngle
        self.propSlide = propSlide
        self.sparkle = sparkle
        self.bellyJiggle = bellyJiggle
        self.tongue = tongue
        self.tailWag = tailWag
        self.headTilt = headTilt
    }

    init(phase: ReviewPetPhase, time: Double, breathPeriod: Double = 3.4) {
        let breath = sin(time * 2 * .pi / max(0.1, breathPeriod))

        bob = breath * -1.2
        squash = 1 + 0.035 * breath
        // The belly carries its own wobble, lagging the breath by a beat so
        // it reads as mass catching up rather than the body scaling.
        bellyJiggle = sin(time * 2 * .pi / max(0.1, breathPeriod) - 0.9) * 0.03
        // Two schedules at incommensurable periods, so blinks never settle
        // into a metronome. Slower and longer than an alert animal's: these
        // are heavy-lidded, could-nap-right-now blinks.
        blink = min(
            1,
            max(
                Self.pulse(time, period: 3.7, duration: 0.2),
                Self.pulse(time + 1.9, period: 5.7, duration: 0.17)))
        // A drowsy drift with a slower dart on top: this dog scans the room
        // from the sofa, it does not patrol.
        look = max(-1, min(1, sin(time * 0.6) * 0.7 + sin(time * 1.7) * 0.3))
        earTwitch = Self.pulse(time, period: 6.1, duration: 0.3) * 12
        // The occasional blep. Out, hang, back in — one slow half-sine does
        // all three.
        tongue = Self.pulse(time, period: 8.7, duration: 2.6)
        // The stub gives one lazy wiggle every few seconds: an envelope over
        // a fast flick, because a nub cannot sweep.
        tailWag = Self.pulse(time, period: 7.3, duration: 1.4)
            * sin(time * 2 * .pi / 0.35) * 12

        switch phase {
        case .reviewing, .fixing:
            // Every so often the whole dog heaves one deep sigh. Only in the
            // working phases: the celebration below spends the same vertical
            // budget on the hop, and a sighing celebrant reads wrong anyway.
            let sigh = Self.pulse(time, period: 11, duration: 2.4)
            bob -= sigh * 2.5
            squash += sigh * 0.03
        case .readyToMerge:
            break
        }

        switch phase {
        case .reviewing:
            // The glass sweeps across whatever it is smelling, catches the
            // light once per pass, and the head tilts along with it.
            let sweep = sin(time * 2 * .pi / 2.1)
            propSlide = sweep * 5
            propAngle = sweep * 10
            headTilt = sweep * 7
            sparkle = Self.pulse(time, period: 2.1, duration: 0.2)
        case .fixing:
            // Short, fast wrench strokes with a spark at the end of each —
            // and every stroke kicks the belly, because on this dog every
            // effort does.
            propAngle = sin(time * 2 * .pi / 0.55) * 26
            bellyJiggle += Self.pulse(time, period: 0.55, duration: 0.2) * 0.06
            headTilt = -4
            sparkle = Self.pulse(time, period: 0.55, duration: 0.12)
        case .readyToMerge:
            propAngle = sin(time * 2 * .pi / 2.2) * 6
            // A labored hop on top of the breathing bob: brief, mostly
            // grounded, and followed by the belly wobbling through the
            // landing half a beat later.
            let cycle = (time / 2.2).truncatingRemainder(dividingBy: 1)
            let hop = pow(max(0, sin(cycle * .pi)), 8)
            bob -= hop * 6
            bellyJiggle += Self.pulse(time + 1.35, period: 2.2, duration: 0.5) * 0.09
            // Happy panting and a fast nub-blur replace the idle blep and
            // the occasional flick.
            tongue = min(1, 0.7 + 0.3 * sin(time * 2 * .pi / 0.5))
            tailWag = sin(time * 2 * .pi / 0.22) * 22
            headTilt = sin(time * 2 * .pi / 2.2) * 5
            sparkle = Self.pulse(time, period: 2.2, duration: 0.5)
        }
    }

    /// A 0→1→0 half-sine occupying `duration` seconds out of every `period`.
    static func pulse(_ time: Double, period: Double, duration: Double) -> Double {
        guard period > 0, duration > 0 else { return 0 }
        let phase = (time / period).truncatingRemainder(dividingBy: 1)
        let elapsed = (phase < 0 ? phase + 1 : phase) * period
        guard elapsed < duration else { return 0 }
        return sin(.pi * elapsed / duration)
    }
}
