import Foundation
import Testing
@testable import T3Code

struct MainParityTests {
    @Test func unknownImageSupportDoesNotChangeTheRestOfTheCatalog() {
        var saved = FeatureModel(id: "custom", name: "Custom")
        saved.imageSupportIsUnknown = true
        var provider = FeatureProvider(id: "codex", name: "Codex", models: [
            .init(id: "old-server-model", name: "Old server model"), saved,
        ])
        #expect(DailyUXModelOptions.supportsImages(selection: .init(providerID: "codex", modelID: "old-server-model"), providers: [provider]))
        provider.models.append(.init(id: "vision", name: "Vision", supportsImages: true))
        #expect(DailyUXModelOptions.supportsImages(selection: .init(providerID: "codex", modelID: "custom"), providers: [provider]))
    }

    @Test func sharedPreferencesExcludeMachineSettings() throws {
        let settings = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: Data(#"{"defaultThreadEnvMode":"worktree","newWorktreesStartFromOrigin":false,"sidebarAutoSettleAfterDays":null,"sidebarAutoSettleOnMerge":false,"environmentIcon":"mac-mini","sourceControlWritingStyle":{"mode":"conventional_commits","customInstructions":"","followChangeRequestTemplates":true}}"#.utf8))
        #expect(settings.sharedPatch["environmentIcon"] == nil)
        #expect(settings.sharedPatch["defaultThreadEnvMode"] == .string("worktree"))
        #expect(settings.sharedPatch["sidebarAutoSettleAfterDays"] == .null)
        #expect(settings.sharedPatch["sourceControlWritingStyle"]?["mode"] == .string("conventional_commits"))
    }

    @Test func toolIconsRejectLocalURLsAndResolveNativeApps() {
        let presentation = ToolActivityPresentation(payload: .object([
            "toolSurface": .string("computer"),
            "toolIcon": .object(["_tag": .string("native-app"), "app": .object([
                "_tag": .string("app-id"), "appId": .string("com.apple.Safari"),
            ])]),
        ]))
        #expect(presentation?.nativeApp?.appId == "com.apple.Safari")
        let invalid = ToolActivityPresentation(payload: .object([
            "toolIcon": .object(["_tag": .string("themed-logo"), "logoUrl": .string("file:///private/icon.png")]),
        ]))
        #expect(invalid == nil)
    }

    @Test func externalSchemesAreNotWorkspaceFiles() throws {
        for raw in ["mailto:user@example.com", "ftp://example.com/file.txt", "custom://host/file.txt"] {
            #expect(MarkdownWorkspaceFileLink.relativePath(for: try #require(URL(string: raw)), workspaceRoot: "/repo") == nil)
        }
        #expect(MarkdownWorkspaceFileLink.relativePath(for: try #require(URL(string: "C:/repo/file.txt")), workspaceRoot: "C:/repo") == "file.txt")
    }

    @Test func machineIconsHaveASafeFallback() throws {
        var environment = FeatureEnvironment(id: "a", name: "A", endpoint: "https://example.test")
        environment.machineIcon = "mac-mini"
        #expect(environment.systemImage == "macmini")
        let data = try JSONEncoder().encode(environment)
        #expect(try JSONDecoder().decode(FeatureEnvironment.self, from: data).machineIcon == "mac-mini")
        environment.machineIcon = "future-machine"
        #expect(environment.systemImage == "server.rack")
    }

    @Test func projectIconsRetainServerMetadata() throws {
        let icon = try JSONDecoder().decode(ProjectIconOverride.self, from: Data(#"{"kind":"emoji","emoji":"🐈"}"#.utf8))
        var project = FeatureProject(id: "a", environmentID: "b", name: "Project", path: "/repo")
        project.projectIcon = icon
        #expect(try JSONDecoder().decode(FeatureProject.self, from: JSONEncoder().encode(project)).projectIcon == icon)
        #expect(ProjectIconPresentation.symbol("future-icon") == "folder")
    }
}
