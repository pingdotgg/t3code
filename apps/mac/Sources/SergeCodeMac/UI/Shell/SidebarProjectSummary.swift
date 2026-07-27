import Foundation

/// What one project section is carrying right now, as plain numbers.
///
/// Kept free of SwiftUI — like `MotionProfile` and `EntrancePolicy` — so the
/// meter's geometry and the header's summary line are directly testable
/// without rendering a view. The header reads this instead of recomputing
/// three separate `filter` passes per body, and a collapsed section can show
/// the same summary as an expanded one because building it never sorts.
struct SidebarProjectSummary: Equatable, Sendable {
    /// Threads that want a human: pending approval, error, stalled, or on a
    /// machine that dropped mid-turn.
    let attention: Int
    /// Threads with something actually running for them.
    let running: Int
    /// Open but quiet — neither running nor waiting on the user.
    let idle: Int
    /// Threads behind the section's "Settled" disclosure.
    let settled: Int

    init(attention: Int, running: Int, idle: Int, settled: Int) {
        self.attention = attention
        self.running = running
        self.idle = idle
        self.settled = settled
    }

    static let empty = SidebarProjectSummary(attention: 0, running: 0, idle: 0, settled: 0)

    /// Rows the section shows above its settled disclosure.
    var open: Int { attention + running + idle }
    var total: Int { open + settled }
    var isEmpty: Bool { total == 0 }
    /// Whether the project deserves the live treatment — a breathing tile and
    /// a lit rail. Attention alone does not: a thread parked on a question is
    /// not moving, and pretending otherwise would make the cue meaningless.
    var isBusy: Bool { running > 0 }
    var needsAttention: Bool { attention > 0 }

    // MARK: - Meter

    /// One band of the header's activity meter.
    struct Segment: Equatable, Sendable, Identifiable {
        enum Kind: String, Equatable, Sendable {
            case attention
            case running
            case idle
            case settled
        }

        let kind: Kind
        let count: Int
        /// Share of the meter's width, in 0...1. Present segments always sum
        /// to 1 so the meter fills its track exactly.
        let fraction: Double

        var id: String { kind.rawValue }
    }

    /// Floor on a present segment's share. A meter is a glance, not a chart:
    /// one thread needing approval among forty settled ones has to stay a
    /// visible sliver, so every present band claims this much before the
    /// remainder is split proportionally. Clamped by the band count so the
    /// floors alone can never exceed the track.
    static let minimumSegmentShare = 0.16

    /// Non-empty bands, in severity order, with widths that sum to 1. Empty
    /// when the project has no sessions at all.
    var segments: [Segment] {
        let present: [(Segment.Kind, Int)] = [
            (.attention, attention),
            (.running, running),
            (.idle, idle),
            (.settled, settled),
        ].filter { $0.1 > 0 }
        guard !present.isEmpty else { return [] }

        let denominator = Double(present.reduce(0) { $0 + $1.1 })
        let floor = min(Self.minimumSegmentShare, 1 / Double(present.count))
        let slack = 1 - floor * Double(present.count)
        return present.map { kind, count in
            Segment(
                kind: kind,
                count: count,
                fraction: floor + slack * Double(count) / denominator)
        }
    }

    /// Where the meter's bands sit: their point widths and the gap actually used
    /// between them.
    struct MeterLayout: Equatable, Sendable {
        let widths: [Double]
        let spacing: Double

        /// What the bands and their gaps occupy together. Never more than the
        /// track they were laid out for.
        var occupied: Double {
            widths.reduce(0, +) + spacing * Double(max(0, widths.count - 1))
        }
    }

    /// Gaps never claim more than this share of the track. An `HStack` lays its
    /// spacing out whether or not the bands have room, so on a meter too narrow
    /// to seat the requested gaps the gaps are what has to give.
    static let maximumGapShare = 0.5

    /// Lays the bands out across a `track`-wide meter. Widths plus gaps come to
    /// exactly `track`, at any track width and any band count.
    ///
    /// Both reservations happen before the remainder is shared out, rather than
    /// being clamped on afterwards. Clamping is what overflows: four bands each
    /// raised to a 2pt minimum, plus three 1.5pt gaps, want 12.5pt — more than a
    /// narrow meter has — and an `HStack` handed more than its frame does not
    /// compress, it draws past it. Reserving degrades instead: the gap shrinks
    /// first, then the band floor, and the proportions survive to the end.
    func meterLayout(track: Double, spacing: Double, minimumBar: Double) -> MeterLayout {
        let bands = segments
        guard !bands.isEmpty else { return MeterLayout(widths: [], spacing: spacing) }
        let gapCount = Double(bands.count - 1)
        let affordableGaps = min(spacing * gapCount, max(0, track) * Self.maximumGapShare)
        let resolvedSpacing = gapCount > 0 ? affordableGaps / gapCount : spacing
        let usable = max(0, track - affordableGaps)
        let floor = min(minimumBar, usable / Double(bands.count))
        let slack = usable - floor * Double(bands.count)
        return MeterLayout(
            widths: bands.map { floor + slack * $0.fraction },
            spacing: resolvedSpacing)
    }

    // MARK: - Text

    /// The header's second line. Deliberately short: what is on fire, then
    /// what is moving, and only when neither applies does it fall back to a
    /// plain census. A sidebar header is scanned, not read.
    var subtitle: String {
        guard !isEmpty else { return "No sessions" }
        var parts: [String] = []
        if attention > 0 {
            parts.append("\(attention) need\(attention == 1 ? "s" : "") attention")
        }
        if running > 0 {
            parts.append("\(running) running")
        }
        if parts.isEmpty {
            if open > 0 {
                parts.append("\(open) open")
            }
            if settled > 0 {
                parts.append("\(settled) settled")
            }
        }
        return parts.joined(separator: " · ")
    }

    /// Spoken form of the meter, which is decorative to VoiceOver otherwise.
    var accessibilitySummary: String {
        guard !isEmpty else { return "No sessions" }
        var parts: [String] = []
        if attention > 0 { parts.append("\(attention) needing attention") }
        if running > 0 { parts.append("\(running) running") }
        if idle > 0 { parts.append("\(idle) open") }
        if settled > 0 { parts.append("\(settled) settled") }
        return parts.joined(separator: ", ")
    }
}

@MainActor
extension SidebarProjectSummary {
    /// Counts a group in one pass, without ranking it.
    ///
    /// That is the point: `SidebarProjection.groupThreads` sorts, and the
    /// sidebar deliberately skips it for collapsed sections so paired
    /// machines do not re-rank invisible projects on every multi-device tick.
    /// The header still needs its numbers, so it counts here instead.
    init(group: SidebarProjectGroup, now: Date = Date()) {
        var attention = 0
        var running = 0
        var idle = 0
        var settled = 0
        for item in group.threads {
            if ThreadInboxSemantics.effectiveSettled(
                item.thread,
                now: now,
                changeRequestState: item.vcs?.prState)
            {
                settled += 1
            } else if item.needsAttention {
                attention += 1
            } else if item.belongsInRunning {
                running += 1
            } else {
                idle += 1
            }
        }
        self.init(attention: attention, running: running, idle: idle, settled: settled)
    }
}
