import SwiftUI

// The moment a running tool finishes, its transcript row appears above the
// activity dock — and used to simply pop in. The handoff flight makes that
// promotion legible: the new row rises out of the dock wearing the dock's
// look (tinted fill, live border light) and settles into a completed tool
// card, so "the bubble's current action" visibly becomes "history".
//
// Everything here follows the streaming timeline's rules:
// - Detection is a pure diff over consecutive activity scans, so it is
//   testable without a view and costs nothing beyond the scan the dock
//   already pays for.
// - The flight itself is a `KeyframeAnimator` off its own clock, like
//   `ToolGroupRow`'s receive flight: the timeline clears
//   `transaction.animation` on its whole subtree mid-run
//   (`ChatTimelineScrollPolicy.shouldFlattenAnimation`), so a state-driven
//   animation would be flattened into a pop exactly when this is needed.
// - Every animated property is a render-time transform (opacity / scale /
//   offset / overlay), so no sibling row is re-measured and the streaming
//   `LazyVStack` cannot blank.

// MARK: - Policy

/// Pure rules for recognising a tool's promotion out of the live dock.
/// Free of SwiftUI so the detection and its guards are directly testable.
enum ToolHandoffPolicy {
    /// How long the promoted row keeps its handoff role after the promotion
    /// render: long enough to cover the flight plus a couple of streaming
    /// re-renders, short enough that the row's elevated z-order and entrance
    /// suppression cannot outlive the moment they exist for.
    static let flightWindow: TimeInterval = 0.9

    /// Points the promoted row starts below its resting slot — roughly one
    /// collapsed tool card plus the stack gap, which is where the dock's card
    /// sits. The flight fades in while it climbs, so the frames that overlap
    /// the dock (a later `LazyVStack` sibling, which would otherwise paint
    /// over them) are the near-transparent ones.
    static let travel: CGFloat = 56

    /// The tool that just left the running set, newest first, or nil when
    /// nothing was promoted this render. Only a disappearance counts: a first
    /// scan, a tool starting, and an unchanged set all report nothing, so
    /// hydrating a mid-turn thread never replays flights for work the user
    /// already watched land.
    static func promotedToolID(
        previousRunningIDs: [String],
        currentRunningIDs: [String]
    ) -> String? {
        guard !previousRunningIDs.isEmpty else { return nil }
        return previousRunningIDs.last { !currentRunningIDs.contains($0) }
    }

    /// Whether a flight that started at `startedAt` still owns its row.
    static func isFlightActive(startedAt: Date, now: Date) -> Bool {
        now.timeIntervalSince(startedAt) < flightWindow
    }
}

// MARK: - Tracker

/// Per-thread promotion state, held outside SwiftUI's dependency graph.
///
/// A reference box rather than `@UIState` values for the same reason as
/// `ScrollCoalescer`: the tracker is read and written inside
/// `ChatTimelineScrollView`'s body on every streaming delta, and observed
/// state would invalidate that body once more per write. The body already
/// re-evaluates on the timeline mutation that inserts the promoted row, so
/// piggybacking on those evaluations is free.
@MainActor
final class ToolHandoffTracker {
    private var previousRunningIDs: [String] = []
    private var flightID: String?
    private var flightStartedAt: Date?

    /// Diffs this render's running tools against the last render's and
    /// returns the id of the row currently flying, or nil. The id stays
    /// sticky for `ToolHandoffPolicy.flightWindow` so the streaming
    /// re-renders that land mid-flight keep the row in its handoff role
    /// instead of dropping its z-order under the dock halfway up.
    func activeFlightID(runningToolIDs: [String], now: Date) -> String? {
        if let promoted = ToolHandoffPolicy.promotedToolID(
            previousRunningIDs: previousRunningIDs,
            currentRunningIDs: runningToolIDs)
        {
            flightID = promoted
            flightStartedAt = now
        }
        previousRunningIDs = runningToolIDs

        guard let id = flightID, let startedAt = flightStartedAt,
            ToolHandoffPolicy.isFlightActive(startedAt: startedAt, now: now)
        else {
            flightID = nil
            flightStartedAt = nil
            return nil
        }
        return id
    }
}

// MARK: - Flight

/// Animated state of one promotion flight. The initial value is the launch
/// pose — invisible, offset down into the dock, wearing the dock's tint —
/// so the armed row renders hidden for the frame or two before its trigger
/// fires instead of flashing settled and then restarting from nothing.
struct ToolHandoffFrame {
    var opacity: Double
    var y: CGFloat
    var scale: CGFloat
    /// Strength of the tinted wash matching the live card's fill, 1 → 0.
    var wash: Double
    /// Strength of the tinted border echoing the dock's shimmer, fading as
    /// the card settles into plain history.
    var glow: Double

    /// Reduce Motion keeps the fades (the row still never pops) but drops
    /// the climb and the grow-in, matching `EntrancePolicy`'s guarantee.
    static func launch(movement: Bool) -> ToolHandoffFrame {
        ToolHandoffFrame(
            opacity: 0,
            y: movement ? ToolHandoffPolicy.travel : 0,
            scale: movement ? 0.97 : 1,
            wash: 1,
            glow: 0.9)
    }
}

private struct ToolHandoffFlightModifier: ViewModifier {
    let tint: Color
    /// Whether this row ever flies. False for every hydrated or scrolled-in
    /// row, which therefore mounts no animator at all — the same
    /// only-pay-when-it-moves rule `pulseGlow` follows.
    let isArmed: Bool
    let trigger: Int

    func body(content: Content) -> some View {
        if isArmed {
            let movement = Motion.profile.usesMovement
            content.keyframeAnimator(
                initialValue: ToolHandoffFrame.launch(movement: movement),
                trigger: trigger
            ) { view, frame in
                // Overlays first, transforms last: the wash and glow must ride
                // the same scale/offset as the card, or the tint would hover
                // at the row's resting slot while the card is still climbing.
                view
                    .overlay {
                        if frame.wash > 0 {
                            RoundedRectangle(cornerRadius: TranscriptMetrics.cardRadius)
                                .fill(tint.opacity(0.10))
                                .opacity(frame.wash)
                                .allowsHitTesting(false)
                        }
                    }
                    .overlay {
                        if frame.glow > 0 {
                            RoundedRectangle(cornerRadius: TranscriptMetrics.cardRadius)
                                .strokeBorder(tint.opacity(0.65), lineWidth: 1)
                                .opacity(frame.glow)
                                .allowsHitTesting(false)
                        }
                    }
                    .opacity(frame.opacity)
                    // Anchored at the bottom so the grow-in reads as the card
                    // unfurling upward out of the dock rather than inflating
                    // in place.
                    .scaleEffect(frame.scale, anchor: .bottom)
                    .offset(y: frame.y)
            } keyframes: { _ in
                KeyframeTrack(\.opacity) {
                    LinearKeyframe(1, duration: 0.14)
                }
                KeyframeTrack(\.y) {
                    SpringKeyframe(0, duration: 0.5, spring: .snappy)
                }
                KeyframeTrack(\.scale) {
                    SpringKeyframe(1, duration: 0.45, spring: .snappy)
                }
                // The tint drains after the movement lands: first the card
                // arrives, then it cools from "live" to "done".
                KeyframeTrack(\.wash) {
                    LinearKeyframe(1, duration: 0.16)
                    LinearKeyframe(0, duration: 0.36)
                }
                KeyframeTrack(\.glow) {
                    LinearKeyframe(0.9, duration: 0.18)
                    LinearKeyframe(0, duration: 0.42)
                }
            }
        } else {
            content
        }
    }
}

extension View {
    /// Plays the dock → transcript promotion flight on this row. `isArmed`
    /// must be true from the row's first render (it decides whether the
    /// animator exists at all); `trigger` launches the flight.
    func toolHandoffFlight(tint: Color, isArmed: Bool, trigger: Int) -> some View {
        modifier(ToolHandoffFlightModifier(tint: tint, isArmed: isArmed, trigger: trigger))
    }
}
