import Foundation

extension Bundle {
    var appVersionDisplay: String {
        let shortVersion = infoDictionary?["CFBundleShortVersionString"] as? String
        let build = infoDictionary?["CFBundleVersion"] as? String
        switch (shortVersion, build) {
        case let (.some(version), .some(build)):
            return "\(version) (\(build))"
        case let (.some(version), .none):
            return version
        default:
            return "—"
        }
    }
}
