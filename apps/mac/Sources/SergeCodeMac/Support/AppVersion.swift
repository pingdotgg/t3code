import Foundation

/// Provides access to the app's version information from the bundle.
struct AppVersion {
    /// The user-visible version string (e.g., "0.1.0-alpha.1")
    static var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "Unknown"
    }

    /// The build number (e.g., "1")
    static var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "Unknown"
    }

    /// Full version string including build number (e.g., "0.1.0-alpha.1 (1)")
    static var fullVersion: String {
        "\(version) (\(buildNumber))"
    }
}
