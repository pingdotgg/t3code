import AppKit
import SwiftUI

/// The app's motion language. Every interactive state change routes through
/// these curves so the whole app shares one physical feel: springs for
/// structure (things that move or grow), eases for atmosphere (color,
/// opacity). Nothing in the UI should flip instantly — if a view appears,
/// disappears, or changes shape, it does so through one of these.
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

    /// What movement-bearing curves degrade to under Reduce Motion: a fade
    /// fast enough to read as a state change, not an animation.
    private static let reducedChange = Animation.easeOut(duration: 0.15)

    // MARK: Curves

    /// Small state flips the user triggers directly and expects to feel
    /// immediate: chevrons, toggles, selection highlights, button states.
    static var snap: Animation {
        reduceMotion ? reducedChange : .snappy(duration: 0.28, extraBounce: 0.0)
    }

    /// Structural changes: panels swapping, cards expanding, layout shifts.
    /// A settled spring — responsive but with no overshoot, so text stays
    /// readable while it moves.
    static var settle: Animation {
        reduceMotion ? reducedChange : .smooth(duration: 0.38)
    }

    /// Elements entering the stage (cards, banners, menus). A touch of
    /// bounce gives arrivals some life without feeling springy.
    static var enter: Animation {
        reduceMotion ? reducedChange : .spring(response: 0.42, dampingFraction: 0.8)
    }

    /// Ambient property changes the user didn't directly cause: status
    /// tints, connection phases, progress meters, badge counts. Pure
    /// color/opacity eases, so they stay as-is under Reduce Motion.
    static let ambient = Animation.easeInOut(duration: 0.3)

    /// Quick fades for lightweight chrome (spinners, hints, tooltips).
    static let fade = Animation.easeOut(duration: 0.18)

    // MARK: Transitions

    /// New timeline content rising into place: fades in with a small upward
    /// drift, fades straight out on removal (removal is rare and shouldn't
    /// draw attention).
    static var rise: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: 12)),
                removal: .opacity
            )
    }

    /// Cards and sheets materializing: gentle scale-up from 96% with a fade,
    /// anchored center. Reads as "arriving" rather than "growing".
    static var materialize: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .opacity.combined(with: .scale(scale: 0.96)),
                removal: .opacity.combined(with: .scale(scale: 0.98))
            )
    }

    /// Transient overlays that pop from an edge anchor (suggestion menus,
    /// popover-like chrome above the composer).
    static func pop(from anchor: UnitPoint) -> AnyTransition {
        reduceMotion
            ? .opacity
            : .scale(scale: 0.94, anchor: anchor).combined(with: .opacity)
    }

    /// Banners and pills sliding in from the top of their container.
    static var bannerDrop: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .move(edge: .top).combined(with: .opacity),
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
                insertion: .opacity.combined(with: .offset(y: -6)),
                removal: .opacity
            )
    }

    /// Cross-fade with a whisper of scale for swapping whole panes
    /// (inspector tabs, list ↔ preview).
    static var paneSwap: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.985))
    }
}
