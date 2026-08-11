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
        #expect(SettingsAboutMetadata.connectedEnvironmentVersion(
            connectionState: .connected,
            serverVersion: "2.3.4"
        ) == "2.3.4")
    }

    @Test
    func formatsUnknownConnectedEnvironmentVersion() {
        #expect(SettingsAboutMetadata.connectedEnvironmentVersion(
            connectionState: .connected,
            serverVersion: nil
        ) == nil)
        #expect(SettingsAboutMetadata.connectedEnvironmentVersion(
            connectionState: .connected,
            serverVersion: "  "
        ) == nil)
    }

    @Test
    func hidesStaleEnvironmentVersionWhileDisconnected() {
        #expect(SettingsAboutMetadata.connectedEnvironmentVersion(
            connectionState: .disconnected,
            serverVersion: "2.3.4"
        ) == nil)
        #expect(SettingsAboutMetadata.connectedEnvironmentVersion(
            connectionState: .reconnecting,
            serverVersion: "2.3.4"
        ) == nil)
        #expect(SettingsAboutMetadata.connectedEnvironmentVersion(
            connectionState: .connecting,
            serverVersion: "2.3.4"
        ) == nil)
    }
}
