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
        #expect(SettingsAboutMetadata.appVersionLabel(info: [
            "CFBundleShortVersionString": "$(MARKETING_VERSION)",
            "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
        ]) == "? (?)")
    }

    @Test
    func formatsConnectedEnvironmentVersion() {
        #expect(SettingsAboutMetadata.environmentVersionLabel(
            connectionState: .connected,
            serverVersion: "2.3.4"
        ) == "2.3.4")
    }

    @Test
    func formatsUnknownConnectedEnvironmentVersion() {
        #expect(SettingsAboutMetadata.environmentVersionLabel(
            connectionState: .connected,
            serverVersion: nil
        ) == "Unknown")
        #expect(SettingsAboutMetadata.environmentVersionLabel(
            connectionState: .connected,
            serverVersion: "  "
        ) == "Unknown")
    }

    @Test
    func hidesStaleEnvironmentVersionWhileDisconnected() {
        #expect(SettingsAboutMetadata.environmentVersionLabel(
            connectionState: .disconnected,
            serverVersion: "2.3.4"
        ) == "Not connected")
        #expect(SettingsAboutMetadata.environmentVersionLabel(
            connectionState: .reconnecting,
            serverVersion: "2.3.4"
        ) == "Not connected")
        #expect(SettingsAboutMetadata.environmentVersionLabel(
            connectionState: .connecting,
            serverVersion: "2.3.4"
        ) == "Not connected")
    }
}
