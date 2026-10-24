import Foundation
import Testing
@testable import T3Code

@Suite("Project providers and model availability")
struct ProjectProviderModelParityTests {
    @Test
    func projectEnableIsIndependentOfOtherProjectsAndEnvironmentDefaults() throws {
        var config = try config()
        var settings = ServerSettingsSnapshot()
        settings.providerInstances = ["codex": .object([
            "driver": .string("codex"), "enabled": .bool(false), "config": .object(["enabled": .bool(false)]),
        ])]
        settings.projectSettingsOverrides = ["enabled": ["providerInstances": .object([
            "codex": .object(["enabled": .bool(true)]),
        ])]]
        config.settings = settings
        let selection = ModelSelection(instanceId: "codex", model: "ready")
        // The registry keeps this instance running because one project enabled it.
        #expect(config.providers[0].enabled)
        #expect(ServerProviderModelAvailability.canSelect(selection, in: config, projectID: "enabled"))
        #expect(!ServerProviderModelAvailability.canSelect(selection, in: config, projectID: "other"))
        #expect(!ServerProviderModelAvailability.canSelect(selection, in: config, projectID: nil))
        #expect(ServerProviderModelAvailability.defaultSelection(in: config, projectID: "other") == nil)
    }

    @Test
    func projectDisableWinsAndResetRestoresEnvironmentBehavior() throws {
        var config = try config()
        var settings = ServerSettingsSnapshot()
        settings.projectSettingsOverrides = ["project": ["providerInstances": .object([
            "codex": .object(["enabled": .bool(false)]),
        ])]]
        config.settings = settings
        let selection = ModelSelection(instanceId: "codex", model: "ready")
        #expect(!ServerProviderModelAvailability.canSelect(selection, in: config, projectID: "project"))
        #expect(ServerProviderModelAvailability.canSelect(selection, in: config, projectID: "other"))
        let change = ServerProjectSettingChange(providerInstanceID: "codex", enabled: nil)
        #expect(change.patch(projectID: "project", settings: settings).jsonValue == .object([
            "projectSettingsOverrides": .object(["project": .null]),
        ]))
        settings.projectSettingsOverrides = [:]
        config.settings = settings
        #expect(ServerProviderModelAvailability.canSelect(selection, in: config, projectID: "project"))
    }

    @Test
    func enabledResolutionMatchesDriverAndNestedConfigDefaults() {
        var settings = ServerSettingsSnapshot()
        #expect(settings.providerInstanceEnabled(instanceID: "codex"))
        #expect(settings.providerInstanceEnabled(instanceID: "claudeAgent"))
        #expect(!settings.providerInstanceEnabled(instanceID: "custom"))
        settings.providerInstances = [
            "custom": .object(["driver": .string("codex")]),
            "cursor": .object(["driver": .string("cursor")]),
            "nested": .object([
                "driver": .string("codex"), "enabled": .bool(true), "config": .object(["enabled": .bool(false)]),
            ]),
        ]
        #expect(settings.providerInstanceEnabled(instanceID: "custom"))
        #expect(!settings.providerInstanceEnabled(instanceID: "cursor"))
        #expect(!settings.providerInstanceEnabled(instanceID: "nested"))
    }

    @Test
    func instancePatchPreservesSiblingAndUnknownFields() {
        var settings = ServerSettingsSnapshot()
        settings.projectSettingsOverrides = ["project": [
            "defaultAutoPull": .bool(true),
            "providerInstances": .object([
                "codex": .object(["enabled": .bool(false), "future": .string("keep")]),
                "sibling": .object(["enabled": .bool(false)]),
            ]),
        ]]
        let patch = ServerProjectSettingChange(providerInstanceID: "codex", enabled: nil)
            .patch(projectID: "project", settings: settings).jsonValue
        #expect(patch["projectSettingsOverrides"]?["project"] == .object([
            "defaultAutoPull": .bool(true),
            "providerInstances": .object([
                "codex": .object(["future": .string("keep")]),
                "sibling": .object(["enabled": .bool(false)]),
            ]),
        ]))
        settings.projectSettingsOverrides["project"]?["providerInstances"] = .object([
            "codex": .object(["enabled": .bool(false)]),
        ])
        let reset = ServerProjectSettingChange(providerInstanceID: "codex", enabled: nil)
            .patch(projectID: "project", settings: settings).jsonValue
        #expect(reset["projectSettingsOverrides"]?["project"] == .object([
            "defaultAutoPull": .bool(true), "providerInstances": .object([:]),
        ]))
    }

    @Test
    func updateRequiredModelsCannotBeSelectedOrDefaultedEvenWithAFallbackRow() throws {
        var config = try config()
        config.providers[0].updateRequiredModels = [
            .init(slug: "gated", name: "New model", badge: "new", minVersion: "1.20.0"),
        ]
        #expect(!ServerProviderModelAvailability.canSelect(
            .init(instanceId: "codex", model: "gated"), in: config, projectID: "project"
        ))
        #expect(ServerProviderModelAvailability.defaultSelection(in: config, projectID: "project")?.model == "ready")
        let roundTrip = try JSONValue.encode(config).decode(ServerConfigSnapshot.self)
        #expect(roundTrip.providers[0].updateRequiredModels == config.providers[0].updateRequiredModels)
    }

    private func config() throws -> ServerConfigSnapshot {
        try JSONValue.object(["providers": .array([.object([
            "instanceId": .string("codex"), "driver": .string("codex"), "enabled": .bool(true),
            "installed": .bool(true), "status": .string("ready"), "auth": .object(["status": .string("authenticated")]),
            "checkedAt": .string("2026-10-16T00:00:00Z"),
            "models": .array([
                .object(["slug": .string("gated"), "name": .string("New model"), "isCustom": .bool(false), "isDefault": .bool(true)]),
                .object(["slug": .string("ready"), "name": .string("Ready model"), "isCustom": .bool(false)]),
            ]),
        ])])]).decode(ServerConfigSnapshot.self)
    }
}

@Suite("Synced model preferences")
struct ServerModelPreferencesParityTests {
    @Test
    func nullAllowsLegacyMigrationButEmptyServerFavoritesDoNot() throws {
        let legacy = "codex::model\ncodex::model\ninvalid\n::bad\nclaudeAgent::model::variant"
        let unset = try JSONValue.object(["favorites": .null, "providerModelPreferences": .null])
            .decode(ServerSettingsSnapshot.self)
        let preferences = try #require(unset.modelPreferences)
        #expect(preferences.favoriteIDs(legacyStorage: legacy) == ["codex::model", "claudeAgent::model::variant"])
        #expect(preferences.migrationChange(legacyStorage: legacy) != nil)
        #expect(preferences.migrationChange(legacyStorage: "") == nil)
        let cleared = ServerModelPreferencesSnapshot(favorites: [])
        #expect(cleared.favoriteIDs(legacyStorage: legacy).isEmpty)
        #expect(cleared.migrationChange(legacyStorage: legacy) == nil)
        #expect(try JSONValue.object([:]).decode(ServerSettingsSnapshot.self).modelPreferences == nil)
        #expect(try JSONValue.encode(preferences)["favorites"] == .null)
    }

    @Test
    func favoriteAndHiddenWritesAreDeltasAndMigrationUsesCompareAndSet() {
        let model = ServerModelFavorite(provider: "work-codex", model: "ready")
        let legacy = [ServerModelFavorite(provider: "codex", model: "old")]
        let favorite = ServerModelPreferencesChange.favorite(model, enabled: false, legacyFavorites: legacy).jsonValue
        #expect(favorite["setModelFavorites"] == .array([.object([
            "provider": .string("work-codex"), "model": .string("ready"), "favorite": .bool(false),
        ])]))
        #expect(favorite["favorites"] == nil)
        #expect(favorite["migrateModelPreferences"]?["favorites"] == .array([.object([
            "provider": .string("codex"), "model": .string("old"),
        ])]))
        let hidden = ServerModelPreferencesChange.hidden(model, hidden: true).jsonValue
        #expect(hidden["providerModelPreferences"] == nil)
        #expect(hidden["setModelsHidden"] == .array([.object([
            "provider": .string("work-codex"), "model": .string("ready"), "hidden": .bool(true),
        ])]))
    }
}
