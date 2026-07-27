import Foundation

/// Pure layout and input math for the reasoning-effort slider: where each
/// detent sits on the track, which detent a pointer position claims, and what
/// a step between them should feel like.
///
/// Kept free of SwiftUI so the snapping rules — the part a drag gets subtly
/// wrong — stay directly testable, in the same spirit as `EffortLevelStyle`.
struct EffortSliderGeometry: Equatable, Sendable {
    /// Detents on the ramp: one per effort choice the model offers.
    let stopCount: Int
    /// Full track width, knob overhang included.
    let width: Double
    /// Distance from each edge to the first/last detent — the knob's radius,
    /// so a knob parked on an end stop still sits fully inside the track.
    let inset: Double

    init(stopCount: Int, width: Double, inset: Double) {
        self.stopCount = max(1, stopCount)
        let width = max(0, width)
        self.width = width
        self.inset = max(0, min(inset, width / 2))
    }

    /// Distance between the first and the last detent.
    var span: Double { max(0, width - inset * 2) }

    var lastIndex: Int { stopCount - 1 }

    func clamp(_ index: Int) -> Int { min(max(index, 0), lastIndex) }

    /// Normalized position (0...1) of a detent along the span.
    func progress(of index: Int) -> Double {
        guard stopCount > 1 else { return 0 }
        return Double(clamp(index)) / Double(lastIndex)
    }

    /// Center x of a detent.
    func x(of index: Int) -> Double { x(atProgress: progress(of: index)) }

    /// Center x for a continuous position, so the knob and the fill read the
    /// same number while a drag is between detents and neither leads the other.
    func x(atProgress progress: Double) -> Double {
        inset + min(max(progress, 0), 1) * span
    }

    /// Where a pointer x sits along the span. Clamped, so a drag that leaves
    /// the popover parks the knob on the end detent instead of flying off it.
    func progress(atX x: Double) -> Double {
        guard span > 0 else { return 0 }
        return min(max((x - inset) / span, 0), 1)
    }

    /// Detent claiming a pointer x: nearest wins, exact halves round up.
    func index(atX x: Double) -> Int {
        guard stopCount > 1 else { return 0 }
        return clamp(Int((progress(atX: x) * Double(lastIndex)).rounded()))
    }

    /// Center x for a stop's label. Pulled inside the track, because a label
    /// centered on an end detent hangs half its width past the edge — which is
    /// where the longest name on the ramp ("Extra High") gets clipped.
    func labelX(of index: Int, labelWidth: Double) -> Double {
        let half = min(max(labelWidth, 0) / 2, width / 2)
        return min(max(x(of: index), half), width - half)
    }

    /// One arrow-key or VoiceOver step, clamped rather than wrapped: the ramp
    /// has a calmest and a most intense end, and rolling from one straight to
    /// the other is never what an arrow key meant.
    static func step(from index: Int, by delta: Int, stopCount: Int) -> Int {
        let last = max(1, stopCount) - 1
        return min(max(min(max(index, 0), last) + delta, 0), last)
    }

    /// What moving from `previous` to `next` should feel like: a detent tick
    /// mid-ramp, a thud at either end, and nothing at all when the pointer is
    /// still inside the detent it started in.
    static func feedback(from previous: Int, to next: Int, stopCount: Int) -> HapticEvent? {
        guard previous != next else { return nil }
        return next == 0 || next == max(1, stopCount) - 1 ? .boundary : .step
    }
}
