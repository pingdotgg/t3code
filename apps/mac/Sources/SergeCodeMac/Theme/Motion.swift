import AppKit
import SwiftUI

/// Pure timing and accessibility policy for the app's motion language.
/// Keeping the policy free of SwiftUI values makes its responsiveness and
/// Reduce Motion guarantees directly testable.
struct MotionProfile: Equatable, Sendable {
    let reduceMotion: Bool

    let feedbackDuration = 0.14
    let revealDuration = 0.19
    let structureDuration = 0.24
    let delightDuration = 0.40

    var changeDuration: Double { reduceMotion ? 0.12 : revealDuration }
    var usesMovement: Bool { !reduceMotion }
    var allowsDecorativeEffects: Bool { !reduceMotion }
}

/// The app's motion language. Every interactive state change routes through
/// purpose-specific curves so frequent feedback stays crisp while occasional
/// structure and rare success moments retain a calm alpine personality.
///
/// Accessibility: when macOS Reduce Motion is on, every movement-bearing
/// curve collapses to a quick fade and every transition to plain opacity —
/// state changes still ease (no jarring pops) but nothing slides, scales,
/// springs, or pulses. Checked per access, so a settings change applies from
/// the next state change onward.
@MainActor
enum Motion {
    /// Mirrors the system accessibility preference. Also the gate call sites
    /// use for ongoing decorative movement (e.g. the connection pill pulse).
    static var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    static var profile: MotionProfile {
        MotionProfile(reduceMotion: reduceMotion)
    }

    private static var reducedChange: Animation {
        .easeOut(duration: profile.changeDuration)
    }

    // MARK: Curves

    /// Pointer-driven press feedback and small icon changes. Keyboard actions
    /// should not opt into this animation at all.
    static var feedback: Animation {
        reduceMotion
            ? reducedChange
            : .timingCurve(0.23, 1, 0.32, 1, duration: profile.feedbackDuration)
    }

    /// Compact content entering or leaving: suggestions, chips, banners, and
    /// newly appended user-visible blocks.
    static var reveal: Animation {
        reduceMotion
            ? reducedChange
            : .timingCurve(0.23, 1, 0.32, 1, duration: profile.revealDuration)
    }

    /// Occasional panels, disclosures, and intentional layout changes. The
    /// smooth curve is interruptible and avoids overshoot around text.
    static var structure: Animation {
        reduceMotion ? reducedChange : .smooth(duration: profile.structureDuration)
    }

    /// A one-shot accent for rare successful state transitions.
    static var delight: Animation {
        reduceMotion
            ? reducedChange
            : .spring(response: profile.delightDuration, dampingFraction: 0.82)
    }

    /// Asynchronous status tint, opacity, and meter changes.
    static var ambient: Animation {
        .timingCurve(0.77, 0, 0.175, 1, duration: reduceMotion ? 0.12 : 0.22)
    }

    /// Quick fades for lightweight chrome (spinners, hints, tooltips).
    static var fade: Animation { reveal }

    /// Occasional scenery changes are atmospheric rather than interactive.
    static var scenery: Animation {
        .timingCurve(0.77, 0, 0.175, 1, duration: reduceMotion ? 0.12 : 0.30)
    }

    // MARK: Transitions

    /// New timeline content rising into place: fades in with a small upward
    /// drift, fades straight out on removal (removal is rare and shouldn't
    /// draw attention).
    static var rise: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: 6)),
                removal: .opacity
            )
    }

    /// Cards and sheets materializing: gentle scale-up from 96% with a fade,
    /// anchored center. Reads as "arriving" rather than "growing".
    static var materialize: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .opacity.combined(with: .scale(scale: 0.97)),
                removal: .opacity.combined(with: .scale(scale: 0.99))
            )
    }

    /// Transient overlays that pop from an edge anchor (suggestion menus,
    /// popover-like chrome above the composer).
    static func pop(from anchor: UnitPoint) -> AnyTransition {
        reduceMotion
            ? .opacity
            : .scale(scale: 0.96, anchor: anchor).combined(with: .opacity)
    }

    /// Banners and pills reveal from their nearby container edge, never from a
    /// full-height offscreen position.
    static var banner: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .offset(y: -8).combined(with: .opacity),
                removal: .opacity
            )
    }

    /// Inline detail unfolding beneath a disclosure row: fade with a small
    /// upward drift. Not `.move(edge: .top)` — that offsets the content by
    /// its full height, so a tall body (e.g. an expanded tool group) slides
    /// in from far above its row and reads as falling from the top of the
    /// window.
    static var unfold: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: -4)),
                removal: .opacity
            )
    }

    /// Cross-fade with a whisper of scale for swapping whole panes
    /// (inspector tabs, list ↔ preview).
    static var paneChange: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.992))
    }

    // Compatibility aliases while call sites migrate by semantic purpose.
    static var snap: Animation { feedback }
    static var settle: Animation { structure }
    static var enter: Animation { reveal }
    static var bannerDrop: AnyTransition { banner }
    static var paneSwap: AnyTransition { paneChange }
}
