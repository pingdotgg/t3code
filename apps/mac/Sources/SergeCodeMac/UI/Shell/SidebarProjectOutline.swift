import SwiftUI

// The visual vocabulary of the project-first sidebar: the tile that anchors a
// project, the meter that summarizes its workload, the rail that ties its
// sessions back to it, and the chip that carries a session's status.
//
// They are separate views rather than `@ViewBuilder` helpers on `SidebarView`
// so each owns its own hover/appear state and only that state invalidates —
// the sidebar re-renders on every backend tick, and a header that redrew its
// whole subtree because one row was hovered was the old shape's main cost.
//
// Motion rules, uniform across this file:
// - Everything decorative is gated on `Motion.profile.allowsDecorativeEffects`
//   and collapses to a static, still-legible presentation under Reduce Motion.
// - Ongoing loops (`phaseAnimator`) mount only while a project is actually
//   working, so a settled sidebar animates nothing at all.

// MARK: - Palette

extension SidebarProjectSummary.Segment.Kind {
    /// Meter band colors. Same semantics as `SidebarThreadItem.statusTint`, one
    /// step calmer: the meter is a glance at proportions, not a status light.
    @MainActor var color: Color {
        switch self {
        case .attention: AlpineTheme.clay
        case .running: AlpineTheme.accent
        case .idle: AlpineTheme.sky.opacity(0.55)
        case .settled: Color.secondary.opacity(0.28)
        }
    }
}

// MARK: - Chevron

/// The collapse affordance. A rotation rather than a symbol swap: chevron.right
/// → chevron.down through `.symbolEffect(.replace)` is a cross-fade between two
/// glyphs, which reads as a flicker at 10pt. Rotating one glyph is continuous,
/// so an interrupted toggle resumes from wherever it got to.
struct SidebarDisclosureChevron: View {
    let isExpanded: Bool
    var size: CGFloat = 10

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: size, weight: .semibold))
            .rotationEffect(.degrees(isExpanded ? 90 : 0))
            .animation(Motion.structure, value: isExpanded)
            .frame(width: 12, height: 12)
    }
}

// MARK: - Project tile

/// The mark that anchors a project section: its scenery symbol and accent in a
/// small rounded tile, breathing while the project has work running and wearing
/// a halo while something needs attention.
struct SidebarProjectTile: View {
    let symbol: String
    let accent: Color
    let summary: SidebarProjectSummary
    let isHovering: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(accent.opacity(isHovering ? 0.28 : 0.17))
                .overlay {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(accent.opacity(summary.isBusy ? 0.5 : 0.24), lineWidth: 1)
                }
            Image(systemName: symbol)
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(accent)
        }
        .frame(width: 19, height: 19)
        // Attention outranks activity: a project with an approval waiting wears
        // the clay halo even while other threads keep running.
        .background {
            if summary.needsAttention {
                SidebarPulseHalo(color: AlpineTheme.clay, cornerRadius: 6)
            } else if summary.isBusy {
                SidebarPulseHalo(color: accent, cornerRadius: 6)
            }
        }
        .scaleEffect(isHovering ? 1.09 : 1)
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.ambient, value: summary.isBusy)
        .animation(Motion.ambient, value: summary.needsAttention)
        .accessibilityHidden(true)
    }
}

/// A soft halo behind a small mark. It stays static because each busy project
/// can already contain many animated live surfaces.
private struct SidebarPulseHalo: View {
    let color: Color
    let cornerRadius: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius + 2, style: .continuous)
        shape
            .fill(color)
            .blur(radius: 4)
            .opacity(Motion.reduceMotion ? 0.3 : 0.42)
            .scaleEffect(Motion.reduceMotion ? 1 : 1.04)
            .padding(-2)
            .allowsHitTesting(false)
    }
}

// MARK: - Activity meter

/// The header's workload bar: one band per non-empty bucket, widths animating
/// as threads move between them.
///
/// This replaces the pair of competing count labels the header used to carry.
/// Two badges that swap places when the attention count hits zero made the
/// header jump; a meter changes shape instead of changing which control exists.
struct SidebarActivityMeter: View {
    let summary: SidebarProjectSummary
    var width: CGFloat = 44
    var height: CGFloat = 4

    /// The gap the meter asks for between bands, and the smallest band it asks
    /// to keep. Both are requests: `meterLayout` reserves them out of the track
    /// before sharing the remainder, and shrinks them on a track too narrow to
    /// afford them, so the bands can never add up to more than the meter.
    private static let requestedSpacing: Double = 1.5
    private static let requestedMinimumBar: Double = 2

    /// A band paired with the width the geometry gave it. Identified by kind, so
    /// a bucket emptying out removes *that* band rather than renumbering the
    /// rest and animating every one of them.
    private struct Band: Identifiable {
        let segment: SidebarProjectSummary.Segment
        let width: CGFloat

        var id: String { segment.id }
    }

    var body: some View {
        let layout = summary.meterLayout(
            track: Double(width),
            spacing: Self.requestedSpacing,
            minimumBar: Self.requestedMinimumBar)
        let bands = zip(summary.segments, layout.widths).map {
            Band(segment: $0, width: $1)
        }
        HStack(spacing: layout.spacing) {
            ForEach(bands) { band in
                Capsule(style: .continuous)
                    .fill(band.segment.kind.color)
                    .frame(width: band.width)
                    .transition(Motion.pop(from: .leading))
            }
        }
        .frame(width: width, height: height, alignment: .leading)
        .background {
            Capsule(style: .continuous)
                .fill(Color.primary.opacity(0.07))
        }
        .animation(Motion.structure, value: summary)
        .accessibilityElement()
        .accessibilityLabel(summary.accessibilitySummary)
    }
}

// MARK: - Session rail

/// The vertical guide that ties a session row back to its project, plus the
/// elbow into the row itself. It is what makes the sidebar read as an outline
/// rather than as a flat list with indented text.
///
/// It draws itself in from the top when the section expands, staggered by row
/// index, so an expanding project unrolls rather than appearing. Selection
/// thickens and lights the segment instead of adding another affordance.
struct SidebarThreadRail: View {
    let accent: Color
    let isSelected: Bool
    /// Last row of the section: the guide stops at the elbow instead of running
    /// on into whatever comes after the project.
    let isLast: Bool
    /// Position within the section; drives the draw-in stagger.
    let index: Int

    @UIState private var drawn = false

    var body: some View {
        let policy = EntrancePolicy(reduceMotion: Motion.reduceMotion)
        ZStack(alignment: .top) {
            // Vertical guide. Full height for a middle row, half for the last
            // one so the outline visibly terminates.
            //
            // The negative padding is what makes it read as one guide: rows are
            // separate `List` rows with their own spacing, so a segment bounded
            // by its row's height leaves a gap at every boundary and the outline
            // comes out dashed.
            GeometryReader { proxy in
                Capsule()
                    .fill(guideColor)
                    .frame(
                        width: isSelected ? 2.5 : 1.5,
                        // The last row's guide stops exactly at its own elbow —
                        // measured from the padded top, that is 5pt of bridge
                        // plus the elbow's 10pt inset.
                        height: isLast ? 15 : proxy.size.height)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(.vertical, -5)
            // Elbow into the row.
            Capsule()
                .fill(guideColor)
                .frame(width: 5, height: 1.5)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.top, 10)
                .opacity(isLast ? 1 : 0.55)
        }
        .frame(width: 11)
        .scaleEffect(y: drawn ? 1 : 0, anchor: .top)
        .opacity(drawn ? 1 : 0)
        .animation(Motion.feedback, value: isSelected)
        .onAppear {
            guard Motion.profile.usesMovement else {
                drawn = true
                return
            }
            withAnimation(Motion.structure.delay(policy.delay(forIndex: index))) {
                drawn = true
            }
        }
        .accessibilityHidden(true)
    }

    private var guideColor: Color {
        isSelected ? accent.opacity(0.9) : accent.opacity(0.3)
    }
}

/// The rail as it passes a non-session element — the "Show N more" pill, the
/// settled toggle. Same width and color as `SidebarThreadRail`'s guide so the
/// outline runs unbroken past the section's own affordances.
struct SidebarRailStub: View {
    let accent: Color

    var body: some View {
        Capsule()
            .fill(accent.opacity(0.3))
            .frame(width: 1.5)
            .frame(maxHeight: .infinity)
            // Bridges the row gap the same way `SidebarThreadRail` does, so the
            // guide runs unbroken past the affordance instead of restarting.
            .padding(.vertical, -5)
            .frame(width: 11)
            .accessibilityHidden(true)
    }
}

// MARK: - Status chip

/// A session's status glyph, seated in a tinted chip.
///
/// The glyph alone was a 9pt mark floating against the row's text; a chip gives
/// it a constant footprint, so a row changing status no longer nudges its title
/// and the tint carries at a glance from across the window.
struct SidebarStatusChip: View {
    let symbol: String
    let tint: Color
    let isWorking: Bool

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 18, height: 18)
            .background {
                RoundedRectangle(cornerRadius: 5.5, style: .continuous)
                    .fill(tint.opacity(isWorking ? 0.18 : 0.11))
            }
            .pulseGlow(isActive: isWorking)
            .contentTransition(Motion.reduceMotion ? .identity : .symbolEffect(.replace))
    }
}

// MARK: - Pills

/// The small, quiet capsule the sidebar uses for secondary facts: a machine
/// name on a header, a background-agent count on a row, the settled toggle.
struct SidebarPill<Content: View>: View {
    var tint: Color = .secondary
    var isProminent = false
    @ViewBuilder let content: Content

    var body: some View {
        content
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundStyle(isProminent ? tint : Color.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background {
                Capsule(style: .continuous)
                    .fill(isProminent ? tint.opacity(0.16) : Color.primary.opacity(0.06))
            }
    }
}

/// A button that springs a little when pressed. Used for the sidebar's own
/// affordances ("Show N more", the settled toggle, header actions) so they feel
/// like controls rather than tappable text.
struct SidebarPressStyle: ButtonStyle {
    var pressedScale: CGFloat = 0.94

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(
                configuration.isPressed && Motion.profile.usesMovement ? pressedScale : 1)
            .animation(Motion.feedback, value: configuration.isPressed)
    }
}

// MARK: - Hover surface

/// The rounded wash that appears behind a hovered or active header control.
/// One place so every affordance in the sidebar lights up identically.
struct SidebarHoverSurface: View {
    let isActive: Bool
    var tint: Color = .primary
    var cornerRadius: CGFloat = 6

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(tint.opacity(isActive ? 0.1 : 0))
    }
}
