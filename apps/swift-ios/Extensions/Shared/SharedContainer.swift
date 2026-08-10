import Foundation

enum T3SharedContainer {
    #if DEBUG
    static let defaultAppGroupID = "group.com.t3tools.t3code.swiftui.dev"
    static let urlScheme = "t3code-swiftui-dev"
    #else
    static let defaultAppGroupID = "group.com.t3tools.t3code.swiftui"
    static let urlScheme = "t3code-swiftui"
    #endif

    static var appGroupID: String {
        configuredAppGroupID(
            Bundle.main.object(forInfoDictionaryKey: "T3CodeAppGroupIdentifier") as? String
        )
    }

    static func configuredAppGroupID(_ value: String?) -> String {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              value.hasPrefix("group."),
              value.count > "group.".count else {
            return defaultAppGroupID
        }
        return value
    }

    static var rootURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        )
    }
}
