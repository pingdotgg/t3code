import Testing

@testable import SergeCodeMac

@Suite("Model picker catalog")
struct ModelPickerCatalogTests {
    private func option(
        instance: String,
        modelID: String,
        name: String,
        provider: ProviderKind,
        isDefault: Bool = false
    ) -> ModelOption {
        ModelOption(
            instanceID: instance,
            modelID: modelID,
            displayName: name,
            provider: provider,
            isDefault: isDefault
        )
    }

    @Test("collapses duplicate models advertised by multiple provider instances")
    func deduplicatesProviderInstances() {
        let options = [
            option(instance: "codex-a", modelID: "gpt-5", name: "GPT-5", provider: .codex),
            option(instance: "codex-b", modelID: "gpt-5", name: "GPT-5", provider: .codex),
            option(instance: "claude-a", modelID: "sonnet", name: "Sonnet", provider: .claude),
        ]

        let items = ModelPickerCatalog.items(
            from: options,
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        #expect(items.count == 2)
        #expect(items.first { $0.option.modelID == "gpt-5" }?.matchingInstanceCount == 2)
    }

    @Test("keeps the selected provider instance as the duplicate representative")
    func preservesSelectedInstance() {
        let options = [
            option(instance: "codex-a", modelID: "gpt-5", name: "GPT-5", provider: .codex),
            option(
                instance: "codex-b",
                modelID: "gpt-5",
                name: "GPT-5",
                provider: .codex,
                isDefault: true
            ),
        ]

        let item = ModelPickerCatalog.items(
            from: options,
            selectedInstanceID: "codex-a",
            selectedModelID: "gpt-5"
        ).first

        #expect(item?.option.instanceID == "codex-a")
    }

    @Test("filters by provider and searches names, ids, and providers")
    func filtersAndSearches() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "gpt-5", name: "GPT-5", provider: .codex),
                option(instance: "claude", modelID: "sonnet-5", name: "Sonnet 5", provider: .claude),
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        let providerResults = ModelPickerCatalog.filteredItems(
            items,
            providerFilter: .provider(.claude),
            query: ""
        )
        let searchResults = ModelPickerCatalog.filteredItems(
            items,
            providerFilter: .all,
            query: "CODEX"
        )

        #expect(providerResults.map(\.option.modelID) == ["sonnet-5"])
        #expect(searchResults.map(\.option.modelID) == ["gpt-5"])
    }
}
