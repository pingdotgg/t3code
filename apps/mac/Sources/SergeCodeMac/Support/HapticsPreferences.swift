import Foundation

/// Local preference for trackpad haptics.
///
/// Default ON: on Force Touch hardware the taps are the physical half of the
/// app's feedback language, and on hardware without an actuator (external
/// mice, older Macs) `NSHapticFeedbackManager` is a no-op, so leaving it on
/// costs nothing. The toggle exists because haptics are a taste preference,
/// and macOS has no system-wide "reduce haptics" switch to inherit.
public enum HapticsPreferences {
    public static let enabledKey = "haptics.enabled"

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
