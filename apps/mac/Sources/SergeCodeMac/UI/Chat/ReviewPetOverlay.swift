import SwiftUI

/// A marmot that pops out of a burrow in the corner of the transcript while
/// the server-side auto-reviewer is working, says what it is doing, and ducks
/// back down when it finishes.
///
/// It mounts only for `.reviewing` / `.fixing` / `.readyToMerge` (see
/// `ReviewPetPhase`), which are rare and mostly short, so the whole thing
/// costs nothing on an ordinary thread. `readyToMerge` is settled and would
/// otherwise persist for hours, so `ReviewPetPresentation.dwell` gives it a
/// fixed on-screen life and the pet leaves on its own.
///
/// Reduce Motion keeps the pet but freezes it into a composed resting pose:
/// the announcement is the point, the bobbing is not. Turning playful motion
/// off removes it entirely — the header badge and sidebar glyph already carry
/// the same state for anyone who does not want a character on screen.
struct ReviewPetOverlay: View {
    let status: ThreadStatus
    /// Re-triggers the entrance when the user switches to a different thread
    /// that is in the same phase.
    let threadID: String

    @UIState private var isVisible = false
    @UIState private var emerged = false
    /// Bumped once per appearance, so a delayed exit can tell whether the
    /// appearance it was scheduled for is still the current one.
    @UIState private var appearance = 0
    /// Bumped when the playful-motion preference changes. Part of `token`, so
    /// the toggle re-runs the gate rather than only redrawing: switching the
    /// preference off has to send a pet that is already on screen home, and
    /// switching it back on has to summon one for a phase still in flight.
    @UIState private var playfulRevision = 0

    private var phase: ReviewPetPhase? { ReviewPetPhase(status: status) }

    /// Identity of "this pet appearance". A new thread or a new phase is a
    /// new appearance and replays the entrance; anything else leaves the
    /// running animation alone.
    private var token: String {
        "\(threadID)|\(phase?.rawValue ?? "none")|\(playfulRevision)"
    }

    var body: some View {
        Group {
            if let phase, isVisible {
                ReviewPetCard(phase: phase, emerged: emerged)
                    .onTapGesture { dismiss() }
                    .help(ReviewPetPresentation.accessibilityLabel(for: phase))
                    .transition(.opacity)
            }
        }
        .task(id: token) { await run() }
        .playfulMotionInvalidated($playfulRevision)
    }

    /// Drives one appearance: show, let the pet climb out, and — for the
    /// phases that do not end on their own — retire it after its dwell.
    /// `.task(id:)` rather than a detached Task so a phase change mid-dwell
    /// cancels the pending exit instead of racing it.
    private func run() async {
        guard let phase, Motion.playful.showsPlayfulSurfaces else {
            isVisible = false
            emerged = false
            return
        }
        appearance += 1
        isVisible = true
        withAnimation(Motion.playful.allowsCharacterMotion ? Motion.delight : Motion.structure) {
            emerged = true
        }
        guard let dwell = ReviewPetPresentation.dwell(for: phase, profile: Motion.playful) else {
            return
        }
        try? await Task.sleep(for: .seconds(dwell))
        guard !Task.isCancelled else { return }
        dismiss()
    }

    /// Duck back into the burrow, then unmount. Two steps so the exit is the
    /// entrance played backwards rather than a fade from mid-air.
    ///
    /// The delayed half checks that its own appearance is still current: a
    /// phase change landing inside the 260ms would otherwise have the old
    /// exit hide a pet that had just been re-shown for the new phase.
    /// `appearance` is read through the state box, so it reports the live
    /// value rather than whatever this view value captured.
    private func dismiss() {
        let generation = appearance
        withAnimation(Motion.structure) { emerged = false }
        Task {
            try? await Task.sleep(for: .milliseconds(260))
            guard appearance == generation else { return }
            withAnimation(Motion.reveal) { isVisible = false }
        }
    }
}

// MARK: - Card

private struct ReviewPetCard: View {
    let phase: ReviewPetPhase
    let emerged: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            SpeechBubble(phase: phase)
                .opacity(emerged ? 1 : 0)
                .offset(x: emerged ? 0 : 10)
                .animation(Motion.reveal.delay(emerged ? 0.16 : 0), value: emerged)
            BurrowedMarmot(phase: phase, emerged: emerged)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ReviewPetPresentation.accessibilityLabel(for: phase))
    }
}

// MARK: - Speech bubble

private struct SpeechBubble: View {
    let phase: ReviewPetPhase

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(ReviewPetPresentation.title)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(phase.tint)
                .textCase(.uppercase)
                .tracking(0.5)
            Text(ReviewPetPresentation.caption(for: phase))
                .font(.caption)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .contentTransition(Motion.reduceMotion ? .identity : .opacity)
        }
        .padding(.leading, 10)
        .padding(.trailing, 10 + SpeechBubbleShape.tailWidth)
        .padding(.vertical, 7)
        // Fill and stroke share one path, tail included. Composing the tail
        // as a separate triangle beside the plate left a visible seam where
        // the two strokes met and a gap when the shadow offset them.
        .background {
            SpeechBubbleShape()
                .fill(Color(nsColor: .textBackgroundColor))
                .overlay {
                    SpeechBubbleShape().stroke(phase.tint.opacity(0.4), lineWidth: 1)
                }
        }
        .shadow(color: .black.opacity(0.18), radius: 7, y: 3)
        .animation(Motion.ambient, value: phase)
    }
}

/// Rounded plate with a right-pointing tail aimed at the marmot's head, as a
/// single closed path.
///
/// Opaque rather than a material on purpose: the bubble floats over scenery
/// photography and long-form transcript text, and a translucent plate over
/// either is unreadable (see the Liquid Glass rule in apps/mac/CLAUDE.md).
private struct SpeechBubbleShape: Shape {
    static let tailWidth: CGFloat = 7
    static let tailHeight: CGFloat = 11
    static let cornerRadius: CGFloat = 9

    /// One continuous outline, tail spliced into the right edge rather than
    /// unioned onto it. A union of two closed subpaths fills correctly but
    /// strokes the shared edge too, which is the seam this replaced.
    func path(in rect: CGRect) -> Path {
        let plate = CGRect(
            x: rect.minX, y: rect.minY,
            width: max(Self.cornerRadius * 2, rect.width - Self.tailWidth),
            height: rect.height)
        let radius = min(Self.cornerRadius, min(plate.width, plate.height) / 2)
        // Clamped so a short bubble cannot push the tail into its own corners.
        let half = min(Self.tailHeight / 2, max(0, plate.height / 2 - radius))
        let anchor = plate.midY

        var path = Path()
        path.move(to: CGPoint(x: plate.minX + radius, y: plate.minY))
        path.addLine(to: CGPoint(x: plate.maxX - radius, y: plate.minY))
        path.addArc(
            tangent1End: CGPoint(x: plate.maxX, y: plate.minY),
            tangent2End: CGPoint(x: plate.maxX, y: plate.minY + radius), radius: radius)
        path.addLine(to: CGPoint(x: plate.maxX, y: anchor - half))
        path.addLine(to: CGPoint(x: plate.maxX + Self.tailWidth, y: anchor))
        path.addLine(to: CGPoint(x: plate.maxX, y: anchor + half))
        path.addLine(to: CGPoint(x: plate.maxX, y: plate.maxY - radius))
        path.addArc(
            tangent1End: CGPoint(x: plate.maxX, y: plate.maxY),
            tangent2End: CGPoint(x: plate.maxX - radius, y: plate.maxY), radius: radius)
        path.addLine(to: CGPoint(x: plate.minX + radius, y: plate.maxY))
        path.addArc(
            tangent1End: CGPoint(x: plate.minX, y: plate.maxY),
            tangent2End: CGPoint(x: plate.minX, y: plate.maxY - radius), radius: radius)
        path.addLine(to: CGPoint(x: plate.minX, y: plate.minY + radius))
        path.addArc(
            tangent1End: CGPoint(x: plate.minX, y: plate.minY),
            tangent2End: CGPoint(x: plate.minX + radius, y: plate.minY), radius: radius)
        path.closeSubpath()
        return path
    }
}

// MARK: - The marmot

private struct BurrowedMarmot: View {
    let phase: ReviewPetPhase
    let emerged: Bool

    /// Design box for the animal. The burrow mound sits over its bottom
    /// edge, so anything below this line is "underground".
    private static let boxSize = CGSize(width: 78, height: 64)
    /// How far down the marmot sits when hidden — past the mound with room to
    /// spare, so the exit never shows a floating half-animal.
    private static let hiddenDrop: CGFloat = 54

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear
                .frame(width: Self.boxSize.width, height: Self.boxSize.height)
                .overlay {
                    MarmotBody(phase: phase)
                        .offset(y: emerged ? 0 : Self.hiddenDrop)
                }
                // Clips to the fixed box, not to the moving animal, so the
                // marmot slides out of view behind the mound instead of
                // shrinking.
                .clipped()
            BurrowMound()
                .frame(width: Self.boxSize.width + 10, height: 20)
                .offset(y: 8)
        }
        .frame(width: Self.boxSize.width + 10, height: Self.boxSize.height + 8, alignment: .bottom)
    }
}

/// The mound of earth the marmot lives in. Also the reason the pop-in reads
/// as emerging rather than materialising: something has to hide the cut.
private struct BurrowMound: View {
    var body: some View {
        ZStack {
            Ellipse()
                .fill(
                    LinearGradient(
                        colors: [PetPalette.soil, PetPalette.soilShade],
                        startPoint: .top, endPoint: .bottom))
            Ellipse()
                .strokeBorder(PetPalette.soilShade.opacity(0.7), lineWidth: 1)
            // A hint of alpine grass on the rim.
            Ellipse()
                .trim(from: 0.52, to: 0.98)
                .stroke(AlpineTheme.meadow.opacity(0.55), lineWidth: 2)
                .padding(.horizontal, 6)
        }
        .shadow(color: .black.opacity(0.2), radius: 5, y: 2)
    }
}

private struct MarmotBody: View {
    let phase: ReviewPetPhase

    var body: some View {
        let profile = Motion.playful
        TimelineView(
            .animation(
                minimumInterval: profile.decorativeFrameInterval,
                paused: !profile.allowsCharacterMotion)
        ) { context in
            let pose = profile.allowsCharacterMotion
                ? MarmotPose(
                    phase: phase, time: context.date.timeIntervalSinceReferenceDate)
                : MarmotPose.resting(phase: phase)
            animal(pose: pose)
        }
    }

    private func animal(pose: MarmotPose) -> some View {
        ZStack {
            haunches
            arms(pose: pose)
            prop(pose: pose)
            head(pose: pose)
        }
        .offset(y: pose.bob)
        .scaleEffect(x: 1, y: pose.squash, anchor: .bottom)
    }

    // MARK: Parts

    private var haunches: some View {
        ZStack {
            Ellipse()
                .fill(PetPalette.furGradient)
                .frame(width: 42, height: 41)
            Ellipse()
                .fill(PetPalette.belly)
                .frame(width: 25, height: 26)
                .offset(y: 4)
        }
        .offset(y: 11)
    }

    private func arms(pose: MarmotPose) -> some View {
        ZStack {
            Capsule()
                .fill(PetPalette.furShade)
                .frame(width: 8, height: 15)
                .rotationEffect(.degrees(-14 - pose.propAngle * 0.15), anchor: .top)
                .offset(x: -16, y: 6)
            Capsule()
                .fill(PetPalette.furShade)
                .frame(width: 8, height: 15)
                .rotationEffect(.degrees(18 + pose.propAngle * 0.35), anchor: .top)
                .offset(x: 16, y: 6)
        }
    }

    /// The tool in the right paw, plus the glint or spark it throws.
    private func prop(pose: MarmotPose) -> some View {
        ZStack {
            Image(systemName: ReviewPetPresentation.propSymbolName(for: phase))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(phase.tint)
                .shadow(color: phase.tint.opacity(0.6), radius: 3)
                .rotationEffect(.degrees(pose.propAngle))
                .offset(x: 19 + pose.propSlide, y: 8)
            if pose.sparkle > 0.01 {
                sparkBurst(intensity: pose.sparkle)
                    .offset(x: 19 + pose.propSlide, y: 8)
            }
        }
        .contentTransition(Motion.reduceMotion ? .identity : .symbolEffect(.replace))
        .animation(Motion.ambient, value: phase)
    }

    /// Four motes thrown off the prop. Positions are fixed; only opacity and
    /// scale ride the pulse, so a burst costs four circles and no layout.
    private func sparkBurst(intensity: Double) -> some View {
        ZStack {
            ForEach(Array(Self.sparkOffsets.enumerated()), id: \.offset) { _, point in
                Circle()
                    .fill(phase.tint)
                    .frame(width: 2.6, height: 2.6)
                    .offset(x: point.x, y: point.y)
                    .scaleEffect(0.5 + intensity)
            }
        }
        .opacity(intensity * 0.9)
        .blendMode(.plusLighter)
        .allowsHitTesting(false)
    }

    private static let sparkOffsets: [CGPoint] = [
        CGPoint(x: 8, y: -7), CGPoint(x: -7, y: -8),
        CGPoint(x: 9, y: 6), CGPoint(x: -6, y: 7),
    ]

    private func head(pose: MarmotPose) -> some View {
        ZStack {
            ear(side: -1, twitch: pose.earTwitch)
            ear(side: 1, twitch: -pose.earTwitch)
            Circle()
                .fill(PetPalette.furGradient)
                .frame(width: 34, height: 34)
            cheek(side: -1)
            cheek(side: 1)
            eye(side: -1, pose: pose)
            eye(side: 1, pose: pose)
            muzzle
        }
        .offset(y: -12)
    }

    private func ear(side: Double, twitch: Double) -> some View {
        ZStack {
            Circle()
                .fill(PetPalette.furShade)
                .frame(width: 13, height: 13)
            Circle()
                .fill(PetPalette.innerEar)
                .frame(width: 6.5, height: 6.5)
        }
        .rotationEffect(.degrees(twitch * side), anchor: .bottom)
        .offset(x: 12 * side, y: -13)
    }

    private func cheek(side: Double) -> some View {
        Circle()
            .fill(PetPalette.cheek.opacity(0.4))
            .frame(width: 9, height: 9)
            .blur(radius: 2)
            .offset(x: 12 * side, y: 4)
    }

    /// One eye. `blink` collapses it vertically rather than hiding it, so the
    /// lid reads as closing instead of the eye disappearing.
    private func eye(side: Double, pose: MarmotPose) -> some View {
        ZStack {
            Ellipse()
                .fill(PetPalette.eye)
                .frame(width: 6, height: 7)
            Circle()
                .fill(.white.opacity(0.85))
                .frame(width: 1.9, height: 1.9)
                .offset(x: 1.1, y: -1.5)
        }
        .scaleEffect(x: 1, y: max(0.08, 1 - pose.blink))
        .offset(x: 7 * side + pose.look * 1.2, y: -3)
    }

    private var muzzle: some View {
        ZStack {
            Ellipse()
                .fill(PetPalette.belly)
                .frame(width: 16, height: 12)
            Ellipse()
                .fill(PetPalette.eye)
                .frame(width: 5, height: 3.6)
                .offset(y: -3)
            // Marmot incisors. Small, but they are most of the charm.
            RoundedRectangle(cornerRadius: 0.8)
                .fill(.white.opacity(0.92))
                .frame(width: 5, height: 4)
                .offset(y: 4)
        }
        .offset(y: 7)
    }
}

// MARK: - Palette

/// Marmot colours. Earth tones sampled around `AlpineTheme.clay` so the
/// animal belongs to the same Dolomites palette as everything else, rather
/// than importing a cartoon brown from nowhere.
private enum PetPalette {
    static let fur = Color(red: 0.70, green: 0.53, blue: 0.40)
    static let furShade = Color(red: 0.54, green: 0.39, blue: 0.29)
    static let belly = Color(red: 0.90, green: 0.83, blue: 0.72)
    static let innerEar = Color(red: 0.85, green: 0.67, blue: 0.63)
    static let cheek = Color(red: 0.88, green: 0.58, blue: 0.52)
    static let eye = Color(red: 0.14, green: 0.11, blue: 0.10)
    static let soil = Color(red: 0.44, green: 0.36, blue: 0.29)
    static let soilShade = Color(red: 0.29, green: 0.23, blue: 0.18)

    static let furGradient = LinearGradient(
        colors: [fur, furShade], startPoint: .top, endPoint: .bottom)
}

extension ReviewPetPhase {
    /// Matches the status tint the header badge and sidebar glyph already use
    /// for the same phase, so the three surfaces agree at a glance.
    var tint: Color {
        switch self {
        case .reviewing: AlpineTheme.sky
        case .fixing: AlpineTheme.accent
        case .readyToMerge: AlpineTheme.lichen
        }
    }
}
