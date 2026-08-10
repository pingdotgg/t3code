import Foundation

enum SettingsAboutMetadata {
    static func appVersionLabel(info: [String: Any]?) -> String {
        let version = resolvedValue("CFBundleShortVersionString", info: info) ?? "?"
        let build = resolvedValue("CFBundleVersion", info: info) ?? "?"
        return "\(version) (\(build))"
    }

    static func environmentVersionLabel(
        connectionState: FeatureConnection.State,
        serverVersion: String?
    ) -> String {
        guard connectionState == .connected else { return "Not connected" }
        return normalized(serverVersion) ?? "Unknown"
    }

    private static func resolvedValue(_ key: String, info: [String: Any]?) -> String? {
        normalized(info?[key] as? String)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("$(") else { return nil }
        return trimmed
    }
}
