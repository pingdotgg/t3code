import Foundation

/// What kind of thing is arriving. The role picks the curve and how far the
/// content travels; it does not encode timing, which is the policy's job.
enum EntranceRole: Equatable, Sendable, CaseIterable {
    /// A row in a collection: timeline items, sidebar sessions, diff files.
    case row
    /// A self-contained block that materializes in place: approval prompts,
    /// usage-limit notices, plan detail bodies.
    case card
    /// A whole region swapping: thread detail, inspector, settings tab bodies.
    case pane
    /// Chrome that fades in without travelling: toolbar items, pills, badges.
    case control
    /// A rare, occasional scene worth a little personality: the empty-state
    /// hero. Deliberately the only role that springs.
    case hero
}

/// Pure timing and distance policy for content arriving on screen. Kept free of
/// SwiftUI so the stagger clamp and the Reduce Motion guarantees are directly
/// testable, the same split `MotionProfile` uses for `Motion`.
///
/// Every surface in the app animates its arrival (SER-144). Under Reduce Motion
/// the movement is removed but the fade stays, so content still never pops.
struct EntrancePolicy: Equatable, Sendable {
    let reduceMotion: Bool

    /// Gap between adjacent siblings entering.
    let staggerStep = 0.028
    /// Delay stops growing past this index. Without the clamp a restored thread
    /// of 200 rows would ripple for nearly six seconds; clamped, the last row
    /// starts 224 ms in no matter how long the list is.
    let maxStaggered = 8

    /// Where a not-yet-entered view starts, so entrance is a fade-up from
    /// nothing rather than a cross-fade against a half-visible ghost.
    let initialOpacity = 0.0

    func delay(forIndex index: Int) -> Double {
        guard !reduceMotion else { return 0 }
        return Double(min(max(index, 0), maxStaggered)) * staggerStep
    }

    /// Points the content travels upward into place.
    func offset(for role: EntranceRole) -> Double {
        guard !reduceMotion else { return 0 }
        switch role {
        case .row: return 6
        case .card: return 8
        case .pane: return 4
        // Chrome sliding into a toolbar reads as a layout glitch, not motion.
        case .control: return 0
        // The hero settles by scaling; travelling as well would be too much.
        case .hero: return 0
        }
    }

    /// Scale a card starts at. Only cards scale — rows and panes that grow read
    /// as reflowing text, which is exactly the churn this app avoids.
    func initialScale(for role: EntranceRole) -> Double {
        guard !reduceMotion else { return 1 }
        switch role {
        case .card: return 0.98
        case .hero: return 0.96
        case .row, .pane, .control: return 1
        }
    }

    /// Entrance is one-shot per view identity. `suppressed` is the escape hatch
    /// for containers that are mid-stream or mid-regroup, where animating
    /// arrival would re-measure realized rows and blank the stack.
    func shouldPlay(alreadyPlayed: Bool, suppressed: Bool) -> Bool {
        !alreadyPlayed && !suppressed
    }
}
