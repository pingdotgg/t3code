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
    /// talking, or a marmot appearing over the transcript is a non sequitur.
    static let title = "Auto review"

    static func caption(for phase: ReviewPetPhase) -> String {
        switch phase {
        case .reviewing: "Reading through the pull request"
        case .fixing: "Fixing what the review flagged"
        case .readyToMerge: "Review came back clean"
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

    /// How long the pet stays before ducking back into its burrow, or `nil`
    /// to stay for as long as the phase lasts.
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
struct MarmotPose: Equatable, Sendable {
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

    /// Resting pose: what Reduce Motion renders. Deliberately not the t=0
    /// pose — a still frame should look composed, so the prop sits at a
    /// slight angle rather than dead vertical.
    static func resting(phase: ReviewPetPhase) -> MarmotPose {
        MarmotPose(propAngle: phase == .fixing ? -12 : 8)
    }

    init() {}

    init(bob: Double = 0, squash: Double = 1, blink: Double = 0, look: Double = 0,
         earTwitch: Double = 0, propAngle: Double = 0, propSlide: Double = 0,
         sparkle: Double = 0
    ) {
        self.bob = bob
        self.squash = squash
        self.blink = blink
        self.look = look
        self.earTwitch = earTwitch
        self.propAngle = propAngle
        self.propSlide = propSlide
        self.sparkle = sparkle
    }

    init(phase: ReviewPetPhase, time: Double) {
        let breathPeriod = 2.6
        let breath = sin(time * 2 * .pi / breathPeriod)

        bob = breath * -1.6
        squash = 1 + 0.03 * breath
        // Two schedules at incommensurable periods, so blinks never settle
        // into a metronome.
        blink = min(
            1,
            max(
                Self.pulse(time, period: 3.1, duration: 0.13),
                Self.pulse(time + 1.7, period: 4.9, duration: 0.11)))
        // A slow sweep with a faster dart on top: marmots scan, they do not
        // pan.
        look = max(-1, min(1, sin(time * 0.9) * 0.7 + sin(time * 2.3) * 0.3))
        earTwitch = Self.pulse(time, period: 5.3, duration: 0.22) * 14

        switch phase {
        case .reviewing:
            // The glass sweeps across whatever it is reading, and catches the
            // light once per pass.
            let sweep = sin(time * 2 * .pi / 1.9)
            propSlide = sweep * 5
            propAngle = sweep * 10
            sparkle = Self.pulse(time, period: 1.9, duration: 0.18)
        case .fixing:
            // Short, fast wrench strokes with a spark at the end of each.
            propAngle = sin(time * 2 * .pi / 0.55) * 26
            sparkle = Self.pulse(time, period: 0.55, duration: 0.12)
        case .readyToMerge:
            propAngle = sin(time * 2 * .pi / 2.2) * 6
            // A hop on top of the breathing bob: brief, high, and mostly
            // grounded, so it reads as a celebration rather than hovering.
            let cycle = (time / 2.2).truncatingRemainder(dividingBy: 1)
            let hop = pow(max(0, sin(cycle * .pi)), 8)
            bob -= hop * 6
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
