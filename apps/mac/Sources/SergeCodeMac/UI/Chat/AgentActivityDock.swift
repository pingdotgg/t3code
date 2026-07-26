import SwiftUI
import T3Kit

/// The live-turn status row pinned to the tail of the transcript.
///
/// This is the answer to a thread that looks dead while the agent is busy:
/// silent reasoning and in-flight tool calls both used to leave the tail
/// blank (or, for tools, leave the only signal scrolled off above). One row
/// stays at the bottom for the whole working stretch and says what is
/// happening, how long it has been happening, and what just happened before
/// it.
///
/// Cost: one `TimelineView` at 30fps plus a small `Canvas`, mounted only
/// while `AgentActivityPresentation` reports an activity — a settled thread
/// hosts nothing. Its height is fixed (single-line label), so the streaming
/// autoscroll never re-anchors because the dock re-rendered.
///
/// Reduce Motion / playful motion off: the whole thing degrades to the quiet
/// dots-and-label row the transcript used to show for silent reasoning (see
/// `ThinkingDots`). The information survives; only the show goes away.
struct AgentActivityDock: View {
    let activity: AgentActivity
    /// Already-parsed detail for the running tool — the caller resolves it
    /// through `ToolDetailParseCache` so this view never re-parses JSON.
    let subject: String?

    private var tint: Color {
        switch activity.phase {
        case .thinking: AlpineTheme.lavender
        case .stalled: AlpineTheme.clay
        case .tool(let tool): tool.kind.activityTint
        }
    }

    private var symbolName: String {
        AgentActivityPresentation.symbolName(for: activity.phase)
    }

    var body: some View {
        let playful = Motion.playful
        HStack(alignment: .center, spacing: 0) {
            if playful.showsPlayfulSurfaces {
                dock(animated: playful.allowsCharacterMotion)
            } else {
                QuietActivityRow(
                    label: label(elapsed: elapsedNow),
                    accessibilityLabel: accessibilityLabel)
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, TranscriptMetrics.cardPadH)
        .padding(.vertical, 2)
        .accessibilityAddTraits(.updatesFrequently)
    }

    // MARK: - Playful dock

    private func dock(animated: Bool) -> some View {
        HStack(spacing: 10) {
            AuroraOrb(tint: tint, symbolName: symbolName, animated: animated)
            phaseLabel(animated: animated)
            if let since = activity.since {
                Text(since, style: .timer)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            if !activity.recentToolKinds.isEmpty {
                ToolTape(kinds: activity.recentToolKinds)
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, 12)
        .padding(.vertical, 7)
        .background(
            tint.opacity(0.10),
            in: RoundedRectangle(cornerRadius: TranscriptMetrics.cardRadius, style: .continuous))
        .shimmerBorder(
            color: tint, isActive: animated, cornerRadius: TranscriptMetrics.cardRadius)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    /// The label re-derives on a slow tick rather than the orb's 30fps clock:
    /// its only time dependence is the 20s / 60s / 180s reassurance
    /// thresholds, and rebuilding a `Text` thirty times a second to cross one
    /// of them would be pure waste.
    private func phaseLabel(animated: Bool) -> some View {
        TimelineView(.periodic(from: activity.since ?? .now, by: 2)) { context in
            let elapsed = activity.since.map { context.date.timeIntervalSince($0) } ?? 0
            ShimmerLabel(
                text: label(elapsed: max(0, elapsed)), tint: tint, animated: animated)
        }
    }

    private var elapsedNow: TimeInterval {
        guard let since = activity.since else { return 0 }
        return max(0, Date().timeIntervalSince(since))
    }

    private func label(elapsed: TimeInterval) -> String {
        AgentActivityPresentation.label(
            phase: activity.phase, subject: subject, elapsed: elapsed)
    }

    private var accessibilityLabel: String {
        AgentActivityPresentation.accessibilityLabel(phase: activity.phase, subject: subject)
    }
}

// MARK: - Aurora orb

/// A small pool of drifting light: three palette lobes orbiting behind a
/// rotating rim, with sparks thrown off the edge and the phase's glyph
/// floating in the middle.
///
/// Everything is analytic — position from `context.date`, no simulation and
/// no stored per-frame state — so the orb costs one `Canvas` fill pass per
/// frame and renders identically no matter when it mounted.
private struct AuroraOrb: View {
    let tint: Color
    let symbolName: String
    let animated: Bool
    var size: CGFloat = TranscriptMetrics.iconColumn

    /// Sparks thrown off the rim. Coprime-ish speeds keep them from ever
    /// lining up into a visible ring.
    private static let sparks: [(speed: Double, phase: Double, radius: Double, dot: Double)] = [
        (0.62, 0.0, 0.78, 2.4),
        (-0.41, 2.1, 0.92, 1.7),
        (0.83, 4.0, 0.70, 1.9),
        (-0.55, 5.4, 0.99, 1.4),
    ]

    var body: some View {
        let profile = Motion.playful
        ZStack {
            TimelineView(
                .animation(
                    minimumInterval: animated ? profile.decorativeFrameInterval : nil,
                    paused: !animated)
            ) { context in
                // Parked on a fixed, pleasing phase when still, so the
                // Reduce Motion orb is a composed image rather than whatever
                // frame the clock happened to stop on.
                let t = animated
                    ? context.date.timeIntervalSinceReferenceDate / profile.orbPeriod
                    : 0.18
                ZStack {
                    halo(t: t)
                    lobes(t: t)
                    rim(t: t)
                }
                .overlay { sparkField(t: t) }
            }
            glyph
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// Soft bloom under the orb so it reads as emitting light rather than
    /// being a filled circle.
    private func halo(t: Double) -> some View {
        let breath = 1 + 0.12 * sin(t * 2 * .pi)
        return Circle()
            .fill(
                RadialGradient(
                    colors: [tint.opacity(0.45), tint.opacity(0.05), .clear],
                    center: .center,
                    startRadius: 0,
                    endRadius: size * 0.62)
            )
            .scaleEffect(breath)
    }

    /// The aurora itself: three additively blended, blurred lobes on slightly
    /// elliptical orbits over a dark well. Blur plus `plusLighter` is what
    /// turns three hard circles into one shifting wash — and the well is what
    /// makes the lifting visible, since `plusLighter` over the transcript's
    /// own dark background had nothing to lift and read as a flat smudge.
    private func lobes(t: Double) -> some View {
        Canvas { canvas, canvasSize in
            let radius = canvasSize.width / 2
            let well = Path(ellipseIn: CGRect(origin: .zero, size: canvasSize))
            canvas.fill(well, with: .color(.black.opacity(0.55)))

            canvas.addFilter(.blur(radius: radius * 0.26))
            canvas.blendMode = .plusLighter
            let center = CGPoint(x: radius, y: radius)
            let orbit = radius * 0.36
            let base = radius * 0.78
            for (index, color) in lobeColors.enumerated() {
                let angle = t * 2 * .pi + Double(index) * (2 * .pi / 3)
                let wobble = 1 + 0.2 * sin(t * 2 * .pi * 1.7 + Double(index) * 1.3)
                let diameter = base * wobble
                let point = CGPoint(
                    x: center.x + cos(angle) * orbit,
                    y: center.y + sin(angle) * orbit * 0.82)
                let rect = CGRect(
                    x: point.x - diameter / 2, y: point.y - diameter / 2,
                    width: diameter, height: diameter)
                canvas.fill(Path(ellipseIn: rect), with: .color(color.opacity(0.9)))
            }
        }
        .clipShape(Circle())
    }

    /// Two companions from the palette keep the orb from reading as a single
    /// flat tint while still belonging to the phase's colour.
    private var lobeColors: [Color] {
        [tint, AlpineTheme.accent, AlpineTheme.lavender]
    }

    /// Rotating rim: the same angular-gradient trick the running tool cards
    /// use for their borders, at orb scale.
    private func rim(t: Double) -> some View {
        Circle()
            .strokeBorder(
                AngularGradient(
                    colors: [
                        tint.opacity(0.15), tint.opacity(0.95), tint.opacity(0.15),
                    ],
                    center: .center,
                    startAngle: .degrees(t * 220),
                    endAngle: .degrees(t * 220 + 360)),
                lineWidth: 1.2)
    }

    /// Motes orbiting just outside the rim. Purely decorative, so Reduce
    /// Motion drops them entirely rather than freezing them mid-flight where
    /// they would read as smudges.
    @ViewBuilder
    private func sparkField(t: Double) -> some View {
        if animated {
            ZStack {
                ForEach(Array(Self.sparks.enumerated()), id: \.offset) { _, spark in
                    let angle = t * 2 * .pi * spark.speed + spark.phase
                    let radius = size * 0.5 * spark.radius
                    Circle()
                        .fill(tint)
                        .frame(width: spark.dot, height: spark.dot)
                        .offset(x: cos(angle) * radius, y: sin(angle) * radius * 0.9)
                        .opacity(0.35 + 0.45 * (0.5 + 0.5 * sin(angle * 2)))
                }
            }
            .blendMode(.plusLighter)
            .allowsHitTesting(false)
        }
    }

    /// Outside the `TimelineView` on purpose: inside, the 30fps rebuild would
    /// restart the symbol's replace transition every frame.
    private var glyph: some View {
        Image(systemName: symbolName)
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(.white.opacity(0.92))
            .shadow(color: tint.opacity(0.8), radius: 3)
            .contentTransition(Motion.reduceMotion ? .identity : .symbolEffect(.replace))
            .animation(Motion.ambient, value: symbolName)
    }
}

// MARK: - Shimmer label

/// The phase text with a light band travelling through the glyphs. The band
/// is an overlay masked by the same `Text`, so it only ever brightens letter
/// shapes — the row's background stays untouched.
private struct ShimmerLabel: View {
    let text: String
    let tint: Color
    let animated: Bool

    var body: some View {
        let base = Text(text).font(SurgeTypography.agentStatus)
        base
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .overlay { if animated { sweep } }
            .mask { base.lineLimit(1) }
            .contentTransition(Motion.reduceMotion ? .identity : .opacity)
            .animation(Motion.ambient, value: text)
    }

    private var sweep: some View {
        GeometryReader { proxy in
            TimelineView(
                .animation(minimumInterval: Motion.playful.decorativeFrameInterval)
            ) { context in
                let period = 2.9
                let width = proxy.size.width
                let band: CGFloat = 54
                let progress =
                    context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: period) / period
                LinearGradient(
                    colors: [.clear, tint.opacity(0.95), .clear],
                    startPoint: .leading, endPoint: .trailing
                )
                .frame(width: band)
                .offset(x: -band + CGFloat(progress) * (width + band))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Tool tape

/// The turn's last few tool calls as tinted glyphs, oldest first and fading
/// back into the card. Cheap history: it says "work has been happening" for
/// the whole silent stretch that follows it.
private struct ToolTape: View {
    let kinds: [ToolEventKind]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(kinds.enumerated()), id: \.offset) { index, kind in
                let strength = Self.strength(index: index, count: kinds.count)
                Image(systemName: kind.activitySymbolName)
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(kind.activityTint.opacity(0.35 + 0.6 * strength))
                    .frame(width: 14, height: 14)
                    .background(
                        kind.activityTint.opacity(0.08 + 0.12 * strength),
                        in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            }
        }
        .accessibilityHidden(true)
    }

    /// 1 for the newest entry, ramping down to 0.35 for the oldest.
    static func strength(index: Int, count: Int) -> Double {
        guard count > 1 else { return 1 }
        return 0.35 + 0.65 * (Double(index) / Double(count - 1))
    }
}

// MARK: - Quiet fallback

/// The pre-dock presentation, kept for Reduce Motion and for people who turn
/// playful motion off: soft pastel dots and a quiet label, no card, no orb.
private struct QuietActivityRow: View {
    let label: String
    let accessibilityLabel: String

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            ThinkingDots()
                .frame(width: TranscriptMetrics.iconColumn, alignment: .center)
            HStack(spacing: 0) {
                Text(label)
                    .font(SurgeTypography.agentStatus)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                ThinkingEllipsis()
                    .font(SurgeTypography.agentStatus)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }
}
