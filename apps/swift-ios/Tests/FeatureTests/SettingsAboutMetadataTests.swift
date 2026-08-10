import Foundation
import Testing
@testable import T3Code

@Suite("Settings about metadata")
struct SettingsAboutMetadataTests {
    @Test
    func formatsAppVersionAndBuild() {
        let info: [String: Any] = [
            "CFBundleShortVersionString": "1.2.3",
            "CFBundleVersion": "456",
        ]

        #expect(SettingsAboutMetadata.appVersionLabel(info: info) == "1.2.3 (456)")
        #expect(SettingsAboutMetadata.appVersionLabel(info: nil) == "? (?)")
        #expect(SettingsAboutMetadata.environmentVersionLabel(
            connectionState: .connected,
            serverVersion: "2.3.4"
        ) == "2.3.4")
        #expect(SettingsAboutMetadata.environmentVersionLabel(
            connectionState: .connected,
            serverVersion: nil
        ) == "Unknown")
        #expect(SettingsAboutMetadata.environmentVersionLabel(
            connectionState: .disconnected,
            serverVersion: "2.3.4"
        ) == "Not connected")
    }

    @Test
    func decodesEmbeddedBuildChangelog() throws {
        let json = #"{"revision":"abc123","baseRevision":"def456","generatedBy":"GPT-5.6 Luna","entries":[{"commit":"abc123","title":"Fix sync","summary":"Keeps messages in sync.","pullRequest":42,"committedAt":"2026-08-10T01:02:03Z"}]}"#
        let info = ["T3BuildChangelog": Data(json.utf8).base64EncodedString()]
        let changelog = try #require(BuildChangelog.load(info: info))

        #expect(changelog.revision == "abc123")
        #expect(changelog.generatedBy == "GPT-5.6 Luna")
        #expect(changelog.entries.first?.pullRequest == 42)
        #expect(changelog.entries.first?.shortCommit == "abc123")
        #expect(BuildChangelog.load(info: nil) == nil)
        #expect(BuildChangelog.load(info: ["T3BuildChangelog": "not base64"]) == nil)
        #expect(SettingsAboutMetadata.appVersionLabel(info: [
            "CFBundleShortVersionString": "$(MARKETING_VERSION)",
            "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
        ]) == "? (?)")
    }
}
