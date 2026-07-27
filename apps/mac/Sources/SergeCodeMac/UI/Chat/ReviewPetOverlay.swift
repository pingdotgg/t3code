import SwiftUI

/// A fat, lazy Boston terrier that hauls himself up from behind his dog bed
/// in the corner of the transcript while the server-side auto-reviewer is
/// working, says what it is doing, and flops back down when it finishes.
///
/// It mounts only for `.reviewing` / `.fixing` / `.readyToMerge` (see
/// `ReviewPetPhase`), which are rare and mostly short, so the whole thing
/// costs nothing on an ordinary thread. `readyToMerge` is settled and would
/// otherwise persist for hours, so `ReviewPetPresentation.dwell` gives it a
/// fixed on-screen life and the pet leaves on its own.
///
/// Reduce Motion keeps the pet but freezes it into a composed resting pose:
/// the announcement is the point, the panting is not. Turning playful motion
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
                    #if DEBUG
                        // Registered from inside the mounted branch, so the
                        // probe's check is "the pet is on screen" rather than
                        // "the model says it should be". It also stands in
                        // for the surface check: the pet lives inside
                        // ChatScreen's chat branch, so it cannot be mounted
                        // while DiffReviewView owns the detail column.
                        .probeSurface(
                            UIProbeSurfaces.reviewPet,
                            threadID: threadID,
                            detail: phase.rawValue)
                    #endif
            }
        }
        .task(id: token) { await run() }
        .playfulMotionInvalidated($playfulRevision)
    }

    /// Drives one appearance: show, let the dog haul himself up, and — for
    /// the phases that do not end on their own — retire it after its dwell.
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

    /// Flop back down behind the bed, then unmount. Two steps so the exit is
    /// the entrance played backwards rather than a fade from mid-air.
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
            BeddedTerrier(phase: phase, emerged: emerged)
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

/// Rounded plate with a right-pointing tail aimed at the terrier's head, as a
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

// MARK: - The terrier

private struct BeddedTerrier: View {
    let phase: ReviewPetPhase
    let emerged: Bool

    /// Design box for the animal. The dog bed sits over its bottom edge, so
    /// anything below this line is "in the bed". A little wider than the
    /// marmot's box was — the belly needs the room.
    private static let boxSize = CGSize(width: 86, height: 66)
    /// How far down the dog sits when hidden — past the bed rim with room to
    /// spare, so the exit never shows a floating half-animal.
    private static let hiddenDrop: CGFloat = 58

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear
                .frame(width: Self.boxSize.width, height: Self.boxSize.height)
                .overlay {
                    TerrierBody(phase: phase)
                        .offset(y: emerged ? 0 : Self.hiddenDrop)
                }
                // Clips to the fixed box, not to the moving animal, so the
                // dog slides out of view behind the bed instead of
                // shrinking.
                .clipped()
            DogBed()
                .frame(width: Self.boxSize.width + 10, height: 22)
                .offset(y: 8)
        }
        .frame(width: Self.boxSize.width + 10, height: Self.boxSize.height + 8, alignment: .bottom)
    }
}

/// The plump cushion the terrier lives in. Also the reason the pop-in reads
/// as hauling himself up rather than materialising: something has to hide
/// the cut.
private struct DogBed: View {
    var body: some View {
        ZStack {
            Ellipse()
                .fill(
                    LinearGradient(
                        colors: [PetPalette.cushion, PetPalette.cushionShade],
                        startPoint: .top, endPoint: .bottom))
            Ellipse()
                .strokeBorder(PetPalette.cushionShade.opacity(0.8), lineWidth: 1)
            // The stitched seam around the rim that makes it a cushion and
            // not a puddle.
            Ellipse()
                .stroke(
                    PetPalette.stitch.opacity(0.75),
                    style: StrokeStyle(lineWidth: 1.2, dash: [3, 2.6]))
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
        }
        .shadow(color: .black.opacity(0.2), radius: 5, y: 2)
    }
}

private struct TerrierBody: View {
    let phase: ReviewPetPhase

    var body: some View {
        let profile = Motion.playful
        TimelineView(
            .animation(
                minimumInterval: profile.decorativeFrameInterval,
                paused: !profile.allowsCharacterMotion)
        ) { context in
            let pose = profile.allowsCharacterMotion
                ? TerrierPose(
                    phase: phase,
                    time: context.date.timeIntervalSinceReferenceDate,
                    breathPeriod: profile.petBreathPeriod)
                : TerrierPose.resting(phase: phase)
            animal(pose: pose)
        }
    }

    private func animal(pose: TerrierPose) -> some View {
        ZStack {
            tailNub(pose: pose)
            torso(pose: pose)
            paws(pose: pose)
            prop(pose: pose)
            head(pose: pose)
        }
        .offset(y: pose.bob)
        .scaleEffect(x: 1, y: pose.squash, anchor: .bottom)
    }

    // MARK: Parts

    /// The stub. It peeks past the left hip so the wag reads even though the
    /// whole tail is nine points long.
    private func tailNub(pose: TerrierPose) -> some View {
        Capsule()
            .fill(PetPalette.coatShade)
            .frame(width: 7, height: 10)
            .rotationEffect(.degrees(-24 + pose.tailWag), anchor: .bottom)
            .offset(x: -24, y: 6)
    }

    /// Black barrel of a body with the cream beer belly front and center.
    /// The belly is the widest thing on the dog on purpose — it is the
    /// silhouette.
    private func torso(pose: TerrierPose) -> some View {
        ZStack {
            Ellipse()
                .fill(PetPalette.coatGradient)
                .frame(width: 50, height: 44)
            // White bib running into the belly, tuxedo-style.
            Ellipse()
                .fill(PetPalette.cream)
                .frame(width: 36, height: 34)
                .offset(y: 3)
                // The jiggle only touches the belly: wider-and-shorter on the
                // way down, so the mass reads as settling, not the dog
                // scaling.
                .scaleEffect(
                    x: 1 + pose.bellyJiggle,
                    y: 1 - pose.bellyJiggle * 0.7,
                    anchor: .bottom)
            // A navel shadow to sell the overhang.
            Ellipse()
                .fill(PetPalette.creamShade.opacity(0.55))
                .frame(width: 14, height: 4)
                .offset(y: 16)
        }
        .offset(y: 12)
    }

    private func paws(pose: TerrierPose) -> some View {
        ZStack {
            Capsule()
                .fill(PetPalette.coatShade)
                .frame(width: 9, height: 14)
                .rotationEffect(.degrees(-12 - pose.propAngle * 0.15), anchor: .top)
                .offset(x: -19, y: 12)
            Capsule()
                .fill(PetPalette.coatShade)
                .frame(width: 9, height: 14)
                .rotationEffect(.degrees(16 + pose.propAngle * 0.35), anchor: .top)
                .offset(x: 19, y: 12)
        }
    }

    /// The tool in the right paw, plus the glint or spark it throws.
    private func prop(pose: TerrierPose) -> some View {
        ZStack {
            Image(systemName: ReviewPetPresentation.propSymbolName(for: phase))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(phase.tint)
                .shadow(color: phase.tint.opacity(0.6), radius: 3)
                .rotationEffect(.degrees(pose.propAngle))
                .offset(x: 22 + pose.propSlide, y: 12)
            if pose.sparkle > 0.01 {
                sparkBurst(intensity: pose.sparkle)
                    .offset(x: 22 + pose.propSlide, y: 12)
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

    private func head(pose: TerrierPose) -> some View {
        ZStack {
            ear(side: -1, twitch: pose.earTwitch)
            // The off ear rides the same twitch at half strength and mirrored,
            // so the two never move in lockstep — one flicks, the other
            // acknowledges.
            ear(side: 1, twitch: -pose.earTwitch * 0.5)
            Circle()
                .fill(PetPalette.coatGradient)
                .frame(width: 36, height: 36)
            // The white blaze running up the forehead.
            Capsule()
                .fill(PetPalette.cream)
                .frame(width: 8, height: 17)
                .offset(y: -8)
            cheek(side: -1)
            cheek(side: 1)
            eye(side: -1, pose: pose)
            eye(side: 1, pose: pose)
            muzzle(pose: pose)
        }
        .rotationEffect(.degrees(pose.headTilt))
        .offset(y: -13)
    }

    /// One bat ear: tall, upright, unmistakably Boston.
    private func ear(side: Double, twitch: Double) -> some View {
        ZStack {
            Ellipse()
                .fill(PetPalette.coatShade)
                .frame(width: 11, height: 17)
            Ellipse()
                .fill(PetPalette.innerEar)
                .frame(width: 5.5, height: 10)
                .offset(y: 1.5)
        }
        .rotationEffect(.degrees(9 * side + twitch * side), anchor: .bottom)
        .offset(x: 13 * side, y: -18)
    }

    private func cheek(side: Double) -> some View {
        Circle()
            .fill(PetPalette.cheek.opacity(0.45))
            .frame(width: 9, height: 9)
            .blur(radius: 2)
            .offset(x: 13 * side, y: 5)
    }

    /// One eye: round, glossy, a touch bulgy, set wide the way the breed
    /// wears them. `blink` collapses it vertically rather than hiding it, so
    /// the lid reads as closing instead of the eye disappearing, and a
    /// coat-colored lid droops over the top third full-time — this dog is
    /// never fully awake.
    private func eye(side: Double, pose: TerrierPose) -> some View {
        ZStack {
            Circle()
                .fill(.white.opacity(0.92))
                .frame(width: 9, height: 9)
            Circle()
                .fill(PetPalette.eye)
                .frame(width: 6.5, height: 6.5)
                .offset(x: pose.look * 1.0, y: 0.4)
            Circle()
                .fill(.white.opacity(0.9))
                .frame(width: 2.2, height: 2.2)
                .offset(x: 1.4 + pose.look * 1.0, y: -1.6)
            // The sleepy lid.
            Ellipse()
                .fill(PetPalette.coatGradient)
                .frame(width: 11, height: 7)
                .offset(y: -5.2)
        }
        .frame(width: 9, height: 9)
        .clipShape(Circle())
        .scaleEffect(x: 1, y: max(0.08, 1 - pose.blink))
        .offset(x: 11 * side + pose.look * 0.8, y: -2)
    }

    private func muzzle(pose: TerrierPose) -> some View {
        ZStack {
            // The tongue lives behind the muzzle band and slides out from
            // under it, so a tucked tongue costs nothing to hide.
            RoundedRectangle(cornerRadius: 3.2)
                .fill(PetPalette.tongue)
                .frame(width: 6.5, height: 4 + pose.tongue * 7)
                .offset(y: 6 + pose.tongue * 3.5)
                .opacity(pose.tongue > 0.05 ? 1 : 0)
            Ellipse()
                .fill(PetPalette.cream)
                .frame(width: 19, height: 13)
            Ellipse()
                .fill(PetPalette.eye)
                .frame(width: 6.5, height: 4.6)
                .offset(y: -3.5)
            // The underbite snaggle tooth, pointing up out of the jaw. Small,
            // but — like the marmot incisors before it — it is most of the
            // charm.
            RoundedRectangle(cornerRadius: 0.9)
                .fill(.white.opacity(0.95))
                .frame(width: 3.6, height: 4.2)
                .offset(x: 3.4, y: 4.4)
        }
        .offset(y: 8)
    }
}

// MARK: - Palette

/// Boston terrier colours: a tuxedo coat in soft warm blacks and creams,
/// with the pinks kept dusty so the whole dog still sits inside the same
/// Dolomites palette as `AlpineTheme` (the bed is straight `clay`) rather
/// than importing cartoon primaries from nowhere.
private enum PetPalette {
    static let coat = Color(red: 0.24, green: 0.22, blue: 0.23)
    static let coatShade = Color(red: 0.15, green: 0.13, blue: 0.14)
    static let cream = Color(red: 0.93, green: 0.89, blue: 0.81)
    static let creamShade = Color(red: 0.78, green: 0.72, blue: 0.62)
    static let innerEar = Color(red: 0.84, green: 0.62, blue: 0.60)
    static let cheek = Color(red: 0.88, green: 0.58, blue: 0.52)
    static let tongue = Color(red: 0.90, green: 0.55, blue: 0.57)
    static let eye = Color(red: 0.12, green: 0.10, blue: 0.10)
    static let cushion = Color(red: 0.72, green: 0.51, blue: 0.41)
    static let cushionShade = Color(red: 0.52, green: 0.35, blue: 0.28)
    static let stitch = Color(red: 0.90, green: 0.83, blue: 0.72)

    static let coatGradient = LinearGradient(
        colors: [coat, coatShade], startPoint: .top, endPoint: .bottom)
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
