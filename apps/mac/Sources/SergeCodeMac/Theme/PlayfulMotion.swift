import Foundation

/// Local preference for the app's playful motion: the live activity dock's
/// aurora orb and the auto-review pet, plus the ongoing loops that animate
/// them.
///
/// Default ON. Everything it gates mounts only while the agent is actually
/// working, so a settled window pays nothing for it. The toggle exists
/// because charm is a taste preference and macOS Reduce Motion is a blunter
/// instrument than some people want — that switch strips movement app-wide,
/// including the functional easing the rest of the UI depends on. This one
/// removes only the decorative surfaces.
public enum PlayfulMotionPreferences {
    public static let enabledKey = "motion.playful"

    public static var isEnabled: Bool {
        get {
            // Default ON when the key has never been written.
            if UserDefaults.standard.object(forKey: enabledKey) == nil {
                return true
            }
            return UserDefaults.standard.bool(forKey: enabledKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: enabledKey)
        }
    }
}

/// Pure policy for the playful layer, kept free of SwiftUI values so the
/// interaction between Reduce Motion and the opt-out stays directly testable.
///
/// The two switches do different things on purpose:
///
/// - Reduce Motion silences the *movement* but keeps the surface. The dock
///   and the pet each carry state the rest of the chrome only whispers (what
///   the agent is doing right now; that a background review is running), so
///   deleting them would cost information, not just delight.
/// - The opt-out removes the surfaces outright. Someone who turns this off is
///   saying they don't want the character on screen at all, and the status
///   badge in the header plus the sidebar glyph already carry the same state.
struct PlayfulMotionProfile: Equatable, Sendable {
    let reduceMotion: Bool
    let playfulEnabled: Bool

    /// Orbiting sparks, particle puffs, blinking, bobbing: everything whose
    /// only job is charm.
    var allowsCharacterMotion: Bool { playfulEnabled && !reduceMotion }

    /// Whether the decorative surfaces mount at all.
    var showsPlayfulSurfaces: Bool { playfulEnabled }

    /// Frame cadence for the always-on decorative canvases. 30fps: these run
    /// for the whole length of a turn, and the shapes are soft-edged blurs
    /// where the extra 30 frames buy nothing visible.
    let decorativeFrameInterval = 1.0 / 30.0

    /// Seconds per full revolution of the activity orb's lobes. Slow enough
    /// to read as a drift rather than a spinner.
    let orbPeriod = 5.2

    /// Seconds per breath of the pet's idle bob.
    let petBreathPeriod = 2.6

    /// How long the "ready to merge" pet stays on screen before ducking back
    /// into its burrow. Long enough to read the caption twice; short enough
    /// that a settled thread does not keep a character parked over it.
    let petVictoryDwell = 6.5
}

extension Motion {
    /// Current playful policy. Read per access, like `Motion.profile`, so a
    /// settings change applies from the next state change onward.
    static var playful: PlayfulMotionProfile {
        PlayfulMotionProfile(
            reduceMotion: reduceMotion,
            playfulEnabled: PlayfulMotionPreferences.isEnabled)
    }
}
