import Foundation
import Testing
@testable import T3Code

@Suite("Project model picker parity")
struct ProviderModelParityTests {
    @Test
    func disabledProjectProviderKeepsSavedChoiceButCannotApplyANewChoice() {
        var provider = FeatureProvider(id: "work", name: "Work", models: [.init(id: "model", name: "Model")])
        provider.isEnabled = true
        var project = FeatureProject(id: "environment/project", environmentID: "environment", name: "Project", path: "/project")
        project.providerInstanceOverrides = ["work": false]
        let scoped = ProjectProviderModelPolicy.providers([provider], for: project)
        let saved = FeatureSelection(providerID: "work", modelID: "model", options: [.init(id: "future", value: .boolean(true))])
        #expect(scoped[0].models == provider.models)
        #expect(!scoped[0].isAvailable)
        #expect(ProviderModelSelectionResolver.materialized(saved, in: scoped) == saved)
        #expect(!ProjectProviderModelPolicy.canSelect(saved, in: scoped))
        #expect(ProviderModelDraftPolicy.canKeepEditedDraft(
            base: saved, currentCommitted: saved, draft: saved, providers: scoped,
            inheriting: nil, allowsProviderChange: true
        ))
        #expect(ProviderModelDraftPolicy.validated(saved, providers: scoped, inheriting: nil, allowsProviderChange: true) == nil)
    }

    @Test
    func projectEnableOverridesEnvironmentDisableOnlyForItsOwnCatalog() {
        var provider = FeatureProvider(id: "work", name: "Work", models: [.init(id: "model", name: "Model")])
        provider.isEnabled = false
        var project = FeatureProject(id: "project", environmentID: "environment", name: "Project", path: "/project")
        project.providerInstanceOverrides = ["work": true]
        #expect(ProjectProviderModelPolicy.providers([provider], for: project)[0].isAvailable)
        #expect(!ProjectProviderModelPolicy.providers([provider], for: nil)[0].isAvailable)
        #expect(provider.isAvailable)
    }

    @Test
    func gatedFallbackRowsStayOutOfSelectableCatalogAndSearchFindsUpdateNotice() {
        var provider = FeatureProvider(id: "codex", name: "Codex", driver: "codex", models: [
            .init(id: "gated", name: "New model", isDefault: true), .init(id: "ready", name: "Ready model"),
        ])
        provider.updateRequiredModels = [.init(slug: "gated", name: "New model", minVersion: "v1.20.0")]
        let saved = FeatureSelection(providerID: "codex", modelID: "gated")
        #expect(ProviderModelSelectionResolver.materialized(saved, in: [provider]) == saved)
        #expect(ProviderModelSelectionResolver.materialized(nil, in: [provider])?.modelID == "ready")
        #expect(ProjectProviderModelPolicy.selectableProviders([provider])[0].models.map(\.id) == ["ready"])
        #expect(ProviderUpdateRequiredNotice.models(for: provider, query: " GATED ").map(\.slug) == ["gated"])
        #expect(ProviderUpdateRequiredNotice.models(for: provider, query: "unrelated").isEmpty)
        #expect(ProviderUpdateRequiredNotice.message(driver: provider.driver, model: provider.updateRequiredModels![0])
            == "Update the Codex CLI to v1.20.0 or newer to use New model.")
    }

    @Test
    func hiddenModelsCanBeShownAgainAndCustomModelsAlwaysRemainVisible() {
        var custom = FeatureModel(id: "custom", name: "Custom")
        custom.isCustom = true
        let provider = FeatureProvider(id: "codex", name: "Codex", models: [
            .init(id: "hidden", name: "Hidden"), .init(id: "first", name: "First"), custom,
            .init(id: "last", name: "Last"),
        ])
        let preferences = ServerModelPreferencesSnapshot(providerModelPreferences: ["codex": .init(
            hiddenModels: ["hidden", "custom"], modelOrder: ["custom", "custom", "first"]
        )])
        let visible = ProviderModelPreferencesPolicy.providers([provider], preferences: preferences, includeHidden: false)
        #expect(visible[0].models.map(\.id) == ["custom", "first", "last"])
        let all = ProviderModelPreferencesPolicy.providers([provider], preferences: preferences, includeHidden: true)
        #expect(all[0].models.map(\.id) == ["custom", "first", "hidden", "last"])
        #expect(!ProviderModelPreferencesPolicy.isHidden(.init(provider: provider, model: custom), preferences: preferences))
        // Visibility only affects new picker rows. A saved choice is still usable.
        let saved = FeatureSelection(providerID: "codex", modelID: "hidden")
        #expect(ProjectProviderModelPolicy.canSelect(saved, in: [provider]))
        #expect(ThreadComposerModelSelectionPolicy.preservedSelection(saved, providers: [provider]) == saved)
    }
}
