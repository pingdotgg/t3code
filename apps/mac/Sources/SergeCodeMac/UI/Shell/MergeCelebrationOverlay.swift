import SwiftUI

/// Full-window celebration for a successful PR merge: two confetti cannons in
/// the bottom corners fire a pastel burst while a compact, neutral confirmation
/// appears beneath the toolbar. Mounted by
/// `RootView` for `model.mergeCelebration`, removed when it calls
/// `onFinished` after the burst has played out.
///
/// Reduce Motion: the cannons and badge movement are decorative, so the whole
/// overlay collapses to the badge fading in and out in place — no flight, no
/// spring, no spin.
struct MergeCelebrationOverlay: View {
    let celebration: MergeCelebration
    let onFinished: () -> Void

    @UIState private var badgeIn = false

    /// Slightly longer than the longest particle's delay + lifetime (0.45 +
    /// 3.4) so the last stragglers land before the overlay unmounts.
    private let duration: Double = 4.0
    private let reduceMotionDuration: Double = 1.6

    var body: some View {
        let profile = Motion.profile
        ZStack {
            if profile.allowsDecorativeEffects {
                ConfettiBurst(seed: celebration.id)
            }
            badge(reducedMotion: !profile.allowsDecorativeEffects)
                .frame(maxHeight: .infinity, alignment: .top)
                .padding(.top, 28)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
        .task {
            try? await Task.sleep(
                for: .seconds(profile.allowsDecorativeEffects ? duration : reduceMotionDuration))
            guard !Task.isCancelled else { return }
            onFinished()
        }
        .onAppear {
            withAnimation(Motion.reveal) {
                badgeIn = true
            }
            // The rarest success in the app gets the app's only two-tap
            // outcome. Reduce Motion strips the confetti, not the tap: the
            // haptic is the non-visual half of the announcement.
            Haptics.play(.success)
        }
    }

    private func badge(reducedMotion: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.seal")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(AlpineTheme.statusSuccess)
            Text(celebration.title)
                .font(.callout.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(.regularMaterial)
                .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
                }
        }
        .scaleEffect(reducedMotion || badgeIn ? 1 : 0.98)
        .opacity(badgeIn ? 1 : 0)
        .accessibilityLabel(Text("Pull request merged"))
    }
}

/// The confetti particle field. All randomness is seeded from the celebration
/// id so a given burst replays identically across re-renders; time comes from
/// a `TimelineView` clock, so pausing the canvas pauses the burst.
private struct ConfettiBurst: View {
    let seed: UUID

    /// Confetti tones all come from the alpine palette so even the party
    /// moment stays on-identity.
    private static let palette: [Color] = [
        AlpineTheme.accent, AlpineTheme.meadow, AlpineTheme.sky,
        AlpineTheme.clay, AlpineTheme.lichen, AlpineTheme.lavender,
    ]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
            Canvas { canvas, size in
                let elapsed = context.date.timeIntervalSinceReferenceDate
                    - startReferenceDate
                for particle in particles {
                    particle.draw(in: &canvas, size: size, elapsed: elapsed)
                }
            }
        }
        .onAppear { startReferenceDate = Date.timeIntervalSinceReferenceDate }
    }

    @UIState private var startReferenceDate = Date.timeIntervalSinceReferenceDate

    private var particles: [ConfettiParticle] {
        ConfettiParticle.makeBurst(seed: seed, palette: Self.palette)
    }
}

/// One piece of confetti fired from a bottom-corner cannon. Positions are
/// computed analytically per frame (velocity + gravity + flutter) rather than
/// simulated, so the animation is perfectly deterministic and cheap to draw.
private struct ConfettiParticle {
    enum Shape {
        case rectangle, circle, ribbon
    }

    /// `false` fires from the bottom-left corner up-and-right; `true` mirrors
    /// the arc from the bottom-right corner.
    let fromRightCannon: Bool
    /// Launch angle in radians from horizontal, always pointing up/inward.
    let angle: Double
    /// Launch speed in points/second.
    let speed: Double
    /// Seconds after the burst starts before this piece launches, so the
    /// cannon reads as a sustained spray rather than a single clap.
    let delay: Double
    /// Total airtime before the piece fades out.
    let lifetime: Double
    let size: CGSize
    let color: Color
    let shape: Shape
    /// Radians/second of tumble.
    let spin: Double
    /// Sinusoidal side-to-side sway layered on the ballistic path.
    let flutterAmplitude: Double
    let flutterFrequency: Double
    let flutterPhase: Double

    private static let gravity: Double = 1500

    func draw(in canvas: inout GraphicsContext, size: CGSize, elapsed: Double) {
        let t = elapsed - delay
        guard t >= 0, t <= lifetime else { return }

        let origin = CGPoint(x: fromRightCannon ? size.width : 0, y: size.height)
        let direction: Double = fromRightCannon ? -1 : 1
        let x = origin.x
            + direction * cos(angle) * speed * t
            + sin(t * flutterFrequency + flutterPhase) * flutterAmplitude
        let y = origin.y
            - sin(angle) * speed * t
            + 0.5 * Self.gravity * t * t

        // Hold full opacity for most of the flight, then fade to nothing over
        // the last 35% so pieces never pop out of existence mid-screen.
        let fadeStart = lifetime * 0.65
        let opacity = t < fadeStart ? 1 : 1 - (t - fadeStart) / (lifetime - fadeStart)

        let rect = CGRect(
            x: x - self.size.width / 2, y: y - self.size.height / 2,
            width: self.size.width, height: self.size.height)

        var piece = canvas
        piece.opacity = opacity
        piece.translateBy(x: rect.midX, y: rect.midY)
        piece.rotate(by: .radians(spin * t))
        piece.translateBy(x: -rect.midX, y: -rect.midY)

        switch shape {
        case .circle:
            piece.fill(Path(ellipseIn: rect), with: .color(color))
        case .rectangle, .ribbon:
            piece.fill(
                Path(roundedRect: rect, cornerRadius: min(self.size.width, self.size.height) * 0.2),
                with: .color(color))
        }
    }

    /// Builds the two-cannon burst deterministically from the celebration id.
    static func makeBurst(seed: UUID, palette: [Color]) -> [ConfettiParticle] {
        var generator = SeededGenerator(seed: seed)
        let piecesPerCannon = 90
        return (0..<(piecesPerCannon * 2)).map { index in
            let fromRight = index >= piecesPerCannon
            let shapeRoll = generator.next()
            let shape: Shape =
                shapeRoll < 0.45 ? .rectangle : shapeRoll < 0.75 ? .circle : .ribbon
            let base = 4.5 + generator.next() * 4.5
            return ConfettiParticle(
                fromRightCannon: fromRight,
                // 55°–85° above horizontal: a tall, inward-tilted fan.
                angle: (.pi * 55 / 180) + generator.next() * (.pi * 30 / 180),
                speed: 780 + generator.next() * 470,
                delay: generator.next() * 0.45,
                lifetime: 2.5 + generator.next() * 0.9,
                size: shape == .ribbon
                    ? CGSize(width: base * 0.55, height: base * 2.2)
                    : CGSize(width: base, height: base * (0.7 + generator.next() * 0.5)),
                color: palette[index % palette.count],
                shape: shape,
                spin: (generator.next() - 0.5) * 14,
                flutterAmplitude: generator.next() * 26,
                flutterFrequency: 2.5 + generator.next() * 3.5,
                flutterPhase: generator.next() * .pi * 2)
        }
    }
}

/// Deterministic SplitMix64-style generator so the burst depends only on the
/// celebration id — SwiftUI re-renders can then recompute the identical
/// particle set instead of reshuffling every frame.
private struct SeededGenerator {
    private var state: UInt64

    init(seed: UUID) {
        var hasher = Hasher()
        hasher.combine(seed)
        state = UInt64(bitPattern: Int64(hasher.finalize())) &+ 0x9E37_79B9_7F4A_7C15
    }

    /// Uniform Double in [0, 1).
    mutating func next() -> Double {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z = z ^ (z >> 31)
        return Double(z >> 11) * 0x1.0p-53
    }
}
