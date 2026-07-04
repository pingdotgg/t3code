import SwiftUI

/// The app's motion language. Every interactive state change routes through
/// these curves so the whole app shares one physical feel: springs for
/// structure (things that move or grow), eases for atmosphere (color,
/// opacity). Nothing in the UI should flip instantly — if a view appears,
/// disappears, or changes shape, it does so through one of these.
@MainActor
enum Motion {
    // MARK: Curves

    /// Small state flips the user triggers directly and expects to feel
    /// immediate: chevrons, toggles, selection highlights, button states.
    static let snap = Animation.snappy(duration: 0.28, extraBounce: 0.0)

    /// Structural changes: panels swapping, cards expanding, layout shifts.
    /// A settled spring — responsive but with no overshoot, so text stays
    /// readable while it moves.
    static let settle = Animation.smooth(duration: 0.38)

    /// Elements entering the stage (cards, banners, menus). A touch of
    /// bounce gives arrivals some life without feeling springy.
    static let enter = Animation.spring(response: 0.42, dampingFraction: 0.8)

    /// Ambient property changes the user didn't directly cause: status
    /// tints, connection phases, progress meters, badge counts.
    static let ambient = Animation.easeInOut(duration: 0.3)

    /// Quick fades for lightweight chrome (spinners, hints, tooltips).
    static let fade = Animation.easeOut(duration: 0.18)

    // MARK: Transitions

    /// New timeline content rising into place: fades in with a small upward
    /// drift, fades straight out on removal (removal is rare and shouldn't
    /// draw attention).
    static let rise = AnyTransition.asymmetric(
        insertion: .opacity.combined(with: .offset(y: 12)),
        removal: .opacity
    )

    /// Cards and sheets materializing: gentle scale-up from 96% with a fade,
    /// anchored center. Reads as "arriving" rather than "growing".
    static let materialize = AnyTransition.asymmetric(
        insertion: .opacity.combined(with: .scale(scale: 0.96)),
        removal: .opacity.combined(with: .scale(scale: 0.98))
    )

    /// Transient overlays that pop from an edge anchor (suggestion menus,
    /// popover-like chrome above the composer).
    static func pop(from anchor: UnitPoint) -> AnyTransition {
        .scale(scale: 0.94, anchor: anchor).combined(with: .opacity)
    }

    /// Banners and pills sliding in from the top of their container.
    static let bannerDrop = AnyTransition.asymmetric(
        insertion: .move(edge: .top).combined(with: .opacity),
        removal: .opacity
    )

    /// Inline detail unfolding beneath a disclosure row.
    static let unfold = AnyTransition.asymmetric(
        insertion: .opacity.combined(with: .move(edge: .top)),
        removal: .opacity
    )

    /// Cross-fade with a whisper of scale for swapping whole panes
    /// (inspector tabs, list ↔ preview).
    static let paneSwap = AnyTransition.opacity.combined(with: .scale(scale: 0.985))
}
