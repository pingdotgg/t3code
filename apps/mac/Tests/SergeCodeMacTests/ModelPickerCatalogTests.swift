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

    @Test("maps Claude drivers and keeps legacy Claudex threads in the Claude Code filter")
    func claudeDriversShareProviderKind() {
        #expect(
            LiveBackend.providerKindForServerProvider(
                instanceID: "claudeAgent", driver: "claudeAgent") == .claude)
        // `claudex` is a removed driver that persisted threads still name.
        #expect(
            LiveBackend.providerKindForServerProvider(
                instanceID: "claudex", driver: "claudex") == .claude)

        let items = ModelPickerCatalog.items(
            from: [
                option(
                    instance: "claudeAgent", modelID: "sonnet", name: "Sonnet",
                    provider: .claude),
                option(
                    instance: "claudex", modelID: "claude-sonnet-5", name: "Legacy Sonnet",
                    provider: .claude),
            ],
            selectedInstanceID: nil,
            selectedModelID: nil)

        let claudeCodeItems = ModelPickerCatalog.filteredItems(
            items,
            scope: .provider(.claude),
            query: "")

        #expect(claudeCodeItems.count == 2)
        #expect(
            Set(claudeCodeItems.map(\.option.instanceID)) == Set(["claudeAgent", "claudex"]))
    }

    @Test("preserves Claude Work instance override before general Claude mapping")
    func claudeWorkInstanceOverrideWins() {
        #expect(
            LiveBackend.providerKindForServerProvider(
                instanceID: "claude-work", driver: "claudeAgent") == .claudeWork)
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
            scope: .provider(.claude),
            query: ""
        )
        let searchResults = ModelPickerCatalog.filteredItems(
            items,
            scope: .all,
            query: "CODEX"
        )

        #expect(providerResults.map(\.option.modelID) == ["sonnet-5"])
        #expect(searchResults.map(\.option.modelID) == ["gpt-5"])
    }

    @Test("keys ignore the provider instance so favorites survive a reconnect")
    func keysAreInstanceIndependent() {
        let first = option(instance: "codex-a", modelID: "GPT-5", name: "GPT-5", provider: .codex)
        let second = option(instance: "codex-b", modelID: " gpt-5 ", name: "GPT-5", provider: .codex)

        #expect(ModelPickerCatalog.key(for: first) == ModelPickerCatalog.key(for: second))
        #expect(ModelPickerCatalog.key(for: first) == "codex/gpt-5")
    }

    @Test("favorites and recents scopes filter and order rows")
    func favoritesAndRecentsScopes() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "gpt-5", name: "GPT-5", provider: .codex),
                option(instance: "claude", modelID: "sonnet-5", name: "Sonnet 5", provider: .claude),
                option(instance: "grok", modelID: "grok-4", name: "Grok 4", provider: .grok),
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        let favorites = ModelPickerCatalog.filteredItems(
            items,
            scope: .favorites,
            query: "",
            favorites: ["codex/gpt-5", "grok/grok-4"]
        )
        // Recency order wins over catalog order, and models the backend no
        // longer offers drop out instead of rendering as dead rows.
        let recents = ModelPickerCatalog.filteredItems(
            items,
            scope: .recents,
            query: "",
            recents: ["grok/grok-4", "kimi/retired", "claude/sonnet-5"]
        )

        #expect(favorites.map(\.option.modelID) == ["gpt-5", "grok-4"])
        #expect(recents.map(\.option.modelID) == ["grok-4", "sonnet-5"])
    }

    @Test("search ranks exact and prefix hits above looser matches")
    func searchRanksByMatchQuality() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "gpt-5-codex", name: "GPT-5 Codex", provider: .codex),
                option(instance: "claude", modelID: "sonnet-5", name: "Sonnet 5", provider: .claude),
                option(instance: "grok", modelID: "grok-code", name: "Grok Code", provider: .grok),
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        let ranked = ModelPickerCatalog.filteredItems(items, scope: .all, query: "sonnet")
        let looser = ModelPickerCatalog.filteredItems(items, scope: .all, query: "code")

        #expect(ranked.first?.option.modelID == "sonnet-5")
        // "Grok Code" starts the word; "GPT-5 Codex" only contains it later.
        #expect(looser.map(\.option.modelID).prefix(2) == ["grok-code", "gpt-5-codex"])
    }

    @Test("search matches gapped subsequences but rejects out-of-order letters")
    func searchMatchesSubsequences() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "claude", modelID: "sonnet-5", name: "Sonnet 5", provider: .claude)
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        #expect(ModelPickerCatalog.filteredItems(items, scope: .all, query: "s5").count == 1)
        #expect(ModelPickerCatalog.filteredItems(items, scope: .all, query: "5s").isEmpty)
        #expect(ModelPickerCatalog.filteredItems(items, scope: .all, query: "zzz").isEmpty)
    }
}
