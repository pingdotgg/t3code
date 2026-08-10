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
    }

    @Test
    func decodesEmbeddedBuildChangelog() throws {
        let json = #"{"revision":"abc123","baseRevision":"def456","repositoryURL":"https://github.com/pingdotgg/t3code","generatedBy":"GPT-5.6 Luna","entries":[{"commit":"abc123","title":"Fix sync","summary":"Keeps messages in sync.","pullRequest":42,"pullRequestURL":"https://github.com/pingdotgg/t3code/pull/42","committedAt":"2026-08-10T01:02:03Z"}]}"#
        let info = ["T3BuildChangelog": Data(json.utf8).base64EncodedString()]
        let changelog = try #require(BuildChangelog.load(info: info))

        #expect(changelog.revision == "abc123")
        #expect(changelog.generatedBy == "GPT-5.6 Luna")
        #expect(changelog.entries.first?.pullRequest == 42)
        #expect(changelog.entries.first?.pullRequestURL?.absoluteString == "https://github.com/pingdotgg/t3code/pull/42")
        #expect(changelog.repositoryURL?.absoluteString == "https://github.com/pingdotgg/t3code")
        #expect(changelog.entries.first?.shortCommit == "abc123")
        #expect(changelog.entries.first?.displaySummary == "Keeps messages in sync.")
        #expect(BuildChangelog.load(info: nil) == nil)
        #expect(BuildChangelog.load(info: ["T3BuildChangelog": "not base64"]) == nil)
        #expect(SettingsAboutMetadata.appVersionLabel(info: [
            "CFBundleShortVersionString": "$(MARKETING_VERSION)",
            "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
        ]) == "? (?)")
    }

    @Test
    func changelogSummarySuppressesEmptyAndDuplicateCopy() throws {
        let duplicate = BuildChangelog.Entry(
            commit: "abc123",
            title: "Fix sync",
            summary: " fix sync ",
            pullRequest: nil,
            pullRequestURL: nil,
            committedAt: nil
        )
        let empty = BuildChangelog.Entry(
            commit: "def456",
            title: "Add cache",
            summary: "   ",
            pullRequest: nil,
            pullRequestURL: nil,
            committedAt: nil
        )

        #expect(duplicate.displaySummary == nil)
        #expect(empty.displaySummary == nil)

        let json = #"{"revision":"def456","baseRevision":"abc123","repositoryURL":null,"generatedBy":"git","entries":[{"commit":"def456","title":"Add cache","summary":"","pullRequest":null,"pullRequestURL":null,"committedAt":null}]}"#
        let decoded = try #require(BuildChangelog.load(info: [
            "T3BuildChangelog": Data(json.utf8).base64EncodedString(),
        ]))
        #expect(decoded.entries.first?.displaySummary == nil)
    }
}
