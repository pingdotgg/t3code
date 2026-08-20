import SwiftUI

/// Publication channel of the running build, so a personal Dev or Test install is
/// recognisable on sight instead of being mistaken for an ordinary upstream build.
enum PersonalBuildChannel: String, Equatable {
    case upstream
    case dev
    case test

    /// Reads the generic `T3BuildChannel` build setting. Forks and feature branches
    /// can opt into a label without embedding contributor-specific identifiers here.
    init(info: [String: Any]?) {
        self = Self.declared(in: info) ?? .upstream
    }

    static let current = PersonalBuildChannel(info: Bundle.main.infoDictionary)

    /// The channel word appended to the Home title. `nil` leaves an upstream build unmarked.
    var titleSuffix: String? {
        switch self {
        case .upstream: nil
        case .dev: "Dev"
        case .test: "Test"
        }
    }

    var color: Color {
        switch self {
        case .upstream: T3Colors.textSecondary
        case .dev: .orange
        case .test: .purple
        }
    }

    /// `T3BuildChannel` expands from the `T3_BUILD_CHANNEL` build setting. An empty value
    /// and a literal unexpanded `$(…)` both mean "not declared".
    private static func declared(in info: [String: Any]?) -> PersonalBuildChannel? {
        let raw = (info?["T3BuildChannel"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        guard !raw.isEmpty, !raw.hasPrefix("$(") else { return nil }
        return PersonalBuildChannel(rawValue: raw) ?? .upstream
    }
}
