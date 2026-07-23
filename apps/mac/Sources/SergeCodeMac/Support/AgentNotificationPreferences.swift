import Foundation

/// Local preferences for macOS agent lifecycle notifications.
///
/// Defaults match other coding apps: master on, every interruptive kind on.
/// Authorization is separate — the OS prompt is requested on first launch.
public enum AgentNotificationPreferences {
    public static let masterEnabledKey = "agentNotifications.enabled"
    public static let kindEnabledKeyPrefix = "agentNotifications.kind."

    public static var isMasterEnabled: Bool {
        get {
            // Default ON when the key has never been written.
            if UserDefaults.standard.object(forKey: masterEnabledKey) == nil {
                return true
            }
            return UserDefaults.standard.bool(forKey: masterEnabledKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: masterEnabledKey)
        }
    }

    public static func isEnabled(_ kind: AgentNotificationKind) -> Bool {
        let key = kindKey(kind)
        if UserDefaults.standard.object(forKey: key) == nil {
            return true
        }
        return UserDefaults.standard.bool(forKey: key)
    }

    public static func setEnabled(_ kind: AgentNotificationKind, _ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: kindKey(kind))
    }

    public static var enabledKinds: Set<AgentNotificationKind> {
        Set(AgentNotificationKind.allCases.filter { isEnabled($0) })
    }

    private static func kindKey(_ kind: AgentNotificationKind) -> String {
        "\(kindEnabledKeyPrefix)\(kind.rawValue)"
    }
}
