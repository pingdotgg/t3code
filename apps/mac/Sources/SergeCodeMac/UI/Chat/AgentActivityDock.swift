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
/// Cost: one `TimelineView` at 30fps plus two small `Canvas` passes, mounted only
/// while `AgentActivityPresentation` reports an activity — a settled thread
/// hosts nothing. Its geometry stays fixed across phase changes, so switching
/// from thinking to a tool never re-anchors the streaming transcript.
///
/// Reduce Motion / playful motion off: the whole thing degrades to the quiet
/// dots-and-label row the transcript used to show for silent reasoning (see
/// `ThinkingDots`). The information survives; only the show goes away.
struct AgentActivityDock: View {
    let activity: AgentActivity
    /// Already-parsed detail for the running tool — the caller resolves it
    /// through `ToolDetailParseCache` so this view never re-parses JSON.
    let subject: String?

    /// Bumped when the playful-motion preference changes, purely to
    /// invalidate this body so the branch below re-reads it.
    @UIState private var playfulRevision = 0

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
        Group {
            if playful.showsPlayfulSurfaces {
                dock(animated: playful.allowsCharacterMotion)
            } else {
                quietRow
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.updatesFrequently)
        .playfulMotionInvalidated($playfulRevision)
    }

    // MARK: - Playful dock

    /// A full-width member of the transcript column, with the same geometry as
    /// completed tool cards. The generous horizontal rhythm is intentional:
    /// this is the one place that owns all non-terminal work, not a small
    /// status pill competing with a second running row above it.
    private func dock(animated: Bool) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 12) {
                AuroraChip(tint: tint, symbolName: symbolName, animated: animated, size: 32)
                VStack(alignment: .leading, spacing: 3) {
                    phaseLabel(animated: animated)
                    Text(contextLabel)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .contentTransition(Motion.reduceMotion ? .identity : .opacity)
                }
                .frame(width: 280, alignment: .leading)
                Spacer(minLength: 12)
                ToolTape(kinds: activity.recentToolKinds)
                Group {
                    if let since = activity.since {
                        Text(since, style: .timer)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    } else {
                        Color.clear
                    }
                }
                // The clock updates once a second. Reserve its width, but let
                // the digits update immediately so they do not animate forever.
                .frame(width: 46, alignment: .trailing)
                .accessibilityHidden(true)
            }
            ActivityFlowLine(tint: tint, animated: animated)
        }
        .transcriptCard(fill: tint.opacity(0.08))
        .frame(maxWidth: .infinity, alignment: .leading)
        .shimmerBorder(
            color: tint, isActive: animated, cornerRadius: TranscriptMetrics.cardRadius)
        .animation(Motion.ambient, value: activity.phase)
        // A tiny downward recoil each time a tool leaves for the transcript,
        // timed against the promoted row's handoff flight above: the card
        // launches up, the dock dips as if it just let go. Keyframe-driven
        // for the same reason as the flight — the timeline's mid-run
        // suppressor would flatten a state-driven pulse. Render transforms
        // only; the dock's layout never moves.
        .keyframeAnimator(
            initialValue: DockReleaseFrame(),
            trigger: activity.completedToolCount
        ) { view, frame in
            view
                .scaleEffect(frame.scale, anchor: .bottom)
                .offset(y: frame.y)
        } keyframes: { _ in
            KeyframeTrack(\.y) {
                LinearKeyframe(animated && Motion.profile.usesMovement ? 2.5 : 0, duration: 0.10)
                SpringKeyframe(0, duration: 0.32, spring: .snappy)
            }
            KeyframeTrack(\.scale) {
                LinearKeyframe(animated && Motion.profile.usesMovement ? 0.99 : 1, duration: 0.10)
                SpringKeyframe(1, duration: 0.32, spring: .snappy)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private func phaseLabel(animated: Bool) -> some View {
        tickingLabel { text in
            ShimmerLabel(text: text, tint: tint, animated: animated)
        }
    }

    private var contextLabel: String {
        AgentActivityPresentation.contextLabel(
            phase: activity.phase, completedToolCount: activity.completedToolCount)
    }

    /// Cardless, so it carries the inset the card would otherwise supply —
    /// without it the dots sit 12pt left of the icon column every row above
    /// shares.
    private var quietRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            tickingLabel { text in
                QuietActivityRow(label: text, accessibilityLabel: accessibilityLabel)
            }
            Text(contextLabel)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.leading, TranscriptMetrics.iconColumn + 8)
        }
        .transcriptCard(fill: tint.opacity(0.05))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Both presentations ride this tick, and neither can go without it: the
    /// reassurance copy is derived from elapsed time (the 20s / 60s / 180s
    /// thresholds), but a silent stretch produces no timeline deltas to
    /// re-render on — which is exactly the stretch where the escalation
    /// matters. Rendering the label once at body-evaluation time froze it on
    /// "Thinking" for the whole turn.
    ///
    /// 2s rather than the orb's 30fps: crossing a threshold is the only thing
    /// this clock is for, so rebuilding a `Text` thirty times a second to
    /// catch one would be pure waste.
    private func tickingLabel<Content: View>(
        @ViewBuilder content: @escaping (String) -> Content
    ) -> some View {
        TimelineView(.periodic(from: activity.since ?? .now, by: 2)) { context in
            let elapsed = activity.since.map { context.date.timeIntervalSince($0) } ?? 0
            content(label(elapsed: max(0, elapsed)))
        }
    }

    private func label(elapsed: TimeInterval) -> String {
        AgentActivityPresentation.label(
            phase: activity.phase, subject: subject, elapsed: elapsed)
    }

    private var accessibilityLabel: String {
        AgentActivityPresentation.accessibilityLabel(phase: activity.phase, subject: subject)
    }
}

/// Animated state of the dock's release recoil: the small dip it plays when
/// a completed tool leaves it for the transcript.
private struct DockReleaseFrame {
    var y: CGFloat = 0
    var scale: CGFloat = 1
}

// MARK: - Activity flow

/// A quiet directional current across the bottom of the live card. It gives
/// continuous work a sense of travel without changing layout; the completed
/// row's handoff flight (see ToolHandoff.swift) carries the promotion into
/// transcript history.
private struct ActivityFlowLine: View {
    let tint: Color
    let animated: Bool

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(tint.opacity(0.10))
                if animated {
                    TimelineView(
                        .animation(minimumInterval: Motion.playful.decorativeFrameInterval)
                    ) { context in
                        let period = 2.2
                        let progress =
                            context.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: period) / period
                        Capsule()
                            .fill(
                                LinearGradient(
                                    colors: [.clear, tint.opacity(0.75), .clear],
                                    startPoint: .leading, endPoint: .trailing))
                            .frame(width: min(120, proxy.size.width * 0.32))
                            .offset(
                                x: CGFloat(progress)
                                    * (proxy.size.width + min(120, proxy.size.width * 0.32))
                                    - min(120, proxy.size.width * 0.32))
                    }
                } else {
                    Capsule()
                        .fill(tint.opacity(0.35))
                        .frame(width: min(96, proxy.size.width * 0.24))
                }
            }
        }
        .frame(height: 2)
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Aurora chip

/// The dock's leading badge: an `ActivityIconChip` whose fill is alive.
///
/// Same squircle, size, tint gradient and hairline as the static chip every
/// transcript row leads with — three palette lobes drift *inside* that
/// silhouette and a light travels the border, instead of the badge becoming
/// a glowing disc of its own. A working row should read as the same object
/// as a settled one, only breathing; the previous orb read as a foreign
/// element parked at the end of a column of tiles.
///
/// Everything is analytic — position from `context.date`, no simulation and
/// no stored per-frame state — so the chip costs one `Canvas` fill pass per
/// frame and renders identically no matter when it mounted.
private struct AuroraChip: View {
    let tint: Color
    let symbolName: String
    let animated: Bool
    var size: CGFloat = ActivityChipMetrics.size

    private var shape: RoundedRectangle { ActivityChipMetrics.shape(size: size) }

    var body: some View {
        let profile = Motion.playful
        ZStack {
            // The static chip, unchanged, as the ground the light plays on.
            // It is also the whole badge under Reduce Motion once the lobes
            // park, which is why the animated layers only ever add.
            ActivityChipMetrics.fill(tint: tint)
            TimelineView(
                .animation(
                    minimumInterval: animated ? profile.decorativeFrameInterval : nil,
                    paused: !animated)
            ) { context in
                // Parked on a fixed, pleasing phase when still, so the
                // Reduce Motion chip is a composed image rather than whatever
                // frame the clock happened to stop on.
                let t = animated
                    ? context.date.timeIntervalSinceReferenceDate / profile.orbPeriod
                    : 0.18
                ZStack {
                    lobes(t: t)
                    rim(t: t)
                }
            }
            glyph
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(
            shape.strokeBorder(
                tint.opacity(ActivityChipMetrics.strokeOpacity), lineWidth: 0.5)
        )
        .accessibilityHidden(true)
    }

    /// The aurora itself: three blurred palette lobes on slightly elliptical
    /// orbits, drifting through the tile so its colour keeps shifting.
    ///
    /// Composited normally rather than additively, which is the change that
    /// let the black well go. `plusLighter` only reads as light if there is
    /// something dark under it, and the orb bought that with an opaque black
    /// disc — the single detail that made it a foreign object in a column of
    /// translucent tiles. Painting the palette straight onto the chip's own
    /// gradient instead keeps the badge exactly as light as its siblings and
    /// still varies, because what moves is the hue, not the brightness. It
    /// also survives a bright scenery photo behind the transcript, where
    /// additive light saturates to a flat wash.
    private func lobes(t: Double) -> some View {
        Canvas { canvas, canvasSize in
            let radius = canvasSize.width / 2
            // Wide orbits, small lobes, restrained blur. The orb could merge
            // its three into one wash because the black well gave the result
            // somewhere to glow; painted flat, over-blurred lobes just
            // average out to a single flat pastel and the chip stops moving.
            canvas.addFilter(.blur(radius: radius * 0.20))
            let center = CGPoint(x: radius, y: radius)
            let orbit = radius * 0.46
            let base = radius * 0.62
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
                canvas.fill(Path(ellipseIn: rect), with: .color(color.opacity(0.8)))
            }
        }
    }

    /// Two companions from the palette keep the chip from reading as a single
    /// flat tint while still belonging to the phase's colour.
    ///
    /// Sage and sky rather than the orb's accent-and-lavender pairing: those
    /// two are near-identical greens, so on a lavender thinking chip the
    /// three lobes averaged to one grey and the drift disappeared. These are
    /// separated enough in hue to stay legible against any phase tint.
    private var lobeColors: [Color] {
        [tint, AlpineTheme.accent, AlpineTheme.sky]
    }

    /// Travelling border light: the same angular-gradient trick
    /// `shimmerBorder` runs on the card around it, at badge scale and on the
    /// badge's own squircle, so the two sweeps read as one effect at two
    /// sizes. It rides over the static hairline rather than replacing it, so
    /// the chip keeps a visible edge at every point of the sweep.
    private func rim(t: Double) -> some View {
        shape.strokeBorder(
            AngularGradient(
                colors: [
                    tint.opacity(0), tint.opacity(0.85), tint.opacity(0),
                ],
                center: .center,
                startAngle: .degrees(t * 220),
                endAngle: .degrees(t * 220 + 360)),
            lineWidth: 1)
    }

    /// Outside the `TimelineView` on purpose: inside, the 30fps rebuild would
    /// restart the symbol's replace transition every frame.
    private var glyph: some View {
        Image(systemName: symbolName)
            .font(ActivityChipMetrics.glyphFont(size: size))
            .foregroundStyle(tint)
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
        let base = Text(text).font(.callout.weight(.medium))
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
    private static let slotCount = TimelineActivityScan.recentToolTapeLength
    private static let chipSize: CGFloat = 14
    private static let spacing: CGFloat = 3

    var body: some View {
        let visibleKinds = Array(kinds.suffix(Self.slotCount))
        let leadingEmptySlots = Self.slotCount - visibleKinds.count
        HStack(spacing: Self.spacing) {
            ForEach(0..<Self.slotCount, id: \.self) { slot in
                if slot < leadingEmptySlots {
                    Color.clear
                        .frame(width: Self.chipSize, height: Self.chipSize)
                } else {
                    let index = slot - leadingEmptySlots
                    let kind = visibleKinds[index]
                    let strength = Self.strength(index: index, count: visibleKinds.count)
                    Image(systemName: kind.activitySymbolName)
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(kind.activityTint.opacity(0.35 + 0.6 * strength))
                        .frame(width: Self.chipSize, height: Self.chipSize)
                        .background(
                            kind.activityTint.opacity(0.08 + 0.12 * strength),
                            in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        .contentTransition(
                            Motion.reduceMotion ? .identity : .symbolEffect(.replace))
                        .animation(Motion.ambient, value: kind)
                }
            }
        }
        .frame(
            width: Self.chipSize * CGFloat(Self.slotCount)
                + Self.spacing * CGFloat(Self.slotCount - 1),
            alignment: .trailing)
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
