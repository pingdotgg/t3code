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

    @Test("the selected instance stays the representative despite id casing drift")
    func selectedInstanceSurvivesCasingDrift() {
        let options = [
            option(instance: "codex-a", modelID: "GPT-5", name: "GPT-5", provider: .codex),
            option(
                instance: "codex-b", modelID: "GPT-5", name: "GPT-5", provider: .codex,
                isDefault: true),
        ]

        // The thread stores the model id it was created with; a provider that
        // re-advertises the same model in another casing must not cost the
        // picker its knowledge of which instance the thread runs on.
        let item = ModelPickerCatalog.items(
            from: options,
            selectedInstanceID: "codex-a",
            selectedModelID: "gpt-5 "
        ).first

        #expect(item?.option.instanceID == "codex-a")
        #expect(
            ModelPickerCatalog.instanceKey(for: options[0])
                == ModelPickerCatalog.instanceKey(instanceID: "codex-a", modelID: " gpt-5"))
    }

    @Test("the selected option is found despite casing or padding drift")
    func selectedOptionLookupNormalizes() {
        let options = [
            option(instance: "codex-a", modelID: "GPT-5", name: "GPT-5", provider: .codex),
            option(instance: "claude", modelID: "sonnet-5", name: "Sonnet 5", provider: .claude),
        ]

        // The checkmark, the opening highlight, and the scroll target all hang
        // off this lookup; an exact match would leave the picker showing no
        // current model at all.
        #expect(
            ModelPickerCatalog.selectedOption(
                in: options, instanceID: "codex-a", modelID: " gpt-5 ")?.modelID == "GPT-5")
        #expect(
            ModelPickerCatalog.selectedOption(
                in: options, instanceID: "codex-a", modelID: "GPT-5")?.instanceID == "codex-a")
        // A different instance is a different selection, and "nothing
        // selected" must stay nothing.
        #expect(
            ModelPickerCatalog.selectedOption(
                in: options, instanceID: "codex-b", modelID: "gpt-5") == nil)
        #expect(
            ModelPickerCatalog.selectedOption(in: options, instanceID: nil, modelID: nil) == nil)
        #expect(
            ModelPickerCatalog.selectedOption(in: options, instanceID: "codex-a", modelID: nil)
                == nil)
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

    @Test("equally good matches fall back to catalog order, not input order")
    func rankingTiesKeepCatalogOrder() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "beta-5", name: "Beta 5", provider: .codex),
                option(instance: "codex", modelID: "alpha-5", name: "Alpha 5", provider: .codex),
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )
        let scores = items.map { ModelPickerCatalog.matchScore($0, query: "5") }

        // Both models match "5" the same way, so only the catalog's own
        // ordering can decide — otherwise the list reshuffles per keystroke.
        #expect(scores[0] == scores[1])
        #expect(
            ModelPickerCatalog.filteredItems(items, scope: .all, query: "5").map(\.option.modelID)
                == ["alpha-5", "beta-5"])
    }

    @Test("a hit on the model name outranks the same hit on a provider name")
    func nameMatchesOutrankProviderMatches() {
        let items = ModelPickerCatalog.items(
            from: [
                // Ranks first on its provider name ("Claude Code") alone.
                option(instance: "claude", modelID: "zed-1", name: "Zed 1", provider: .claude),
                option(instance: "codex", modelID: "cloud-1", name: "Cloud 1", provider: .codex),
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        let ranked = ModelPickerCatalog.filteredItems(items, scope: .all, query: "cl")

        // Claude sorts before Codex in the catalog, so name-over-provider
        // weighting is the only thing that can put Cloud 1 on top.
        #expect(ranked.map(\.option.modelID) == ["cloud-1", "zed-1"])
    }

    @Test("match scores are nil for misses and neutral for an empty query")
    func matchScoreEdgeCases() {
        let item = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "gpt-5", name: "GPT-5", provider: .codex)
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        ).first!

        #expect(ModelPickerCatalog.matchScore(item, query: "  ") == 0)
        #expect(ModelPickerCatalog.matchScore(item, query: "sonnet") == nil)
        // Whitespace and case are normalized rather than treated as a miss.
        #expect(ModelPickerCatalog.matchScore(item, query: " GPT-5 ") == ModelPickerCatalog.matchScore(item, query: "gpt-5"))
    }

    @Test("empty scopes render nothing rather than falling back to all models")
    func emptyScopesStayEmpty() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "gpt-5", name: "GPT-5", provider: .codex)
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        #expect(ModelPickerCatalog.filteredItems(items, scope: .favorites, query: "").isEmpty)
        #expect(ModelPickerCatalog.filteredItems(items, scope: .recents, query: "").isEmpty)
        #expect(ModelPickerCatalog.filteredItems(items, scope: .favorites, query: "gpt").isEmpty)
        #expect(ModelPickerCatalog.filteredItems([], scope: .all, query: "gpt").isEmpty)
        #expect(ModelPickerCatalog.favoriteItems(items, favorites: ["codex/absent"]).isEmpty)
        #expect(ModelPickerCatalog.recentItems(items, recents: ["codex/absent"]).isEmpty)
    }

    @Test("searching inside a scope never escapes it")
    func searchStaysWithinScope() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "gpt-5", name: "GPT-5", provider: .codex),
                option(instance: "claude", modelID: "sonnet-5", name: "Sonnet 5", provider: .claude),
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )
        let favorites: Set<String> = ["codex/gpt-5"]

        let hit = ModelPickerCatalog.filteredItems(
            items, scope: .favorites, query: "gpt", favorites: favorites)
        let miss = ModelPickerCatalog.filteredItems(
            items, scope: .favorites, query: "sonnet", favorites: favorites)

        #expect(hit.map(\.option.modelID) == ["gpt-5"])
        #expect(miss.isEmpty)
    }

    @Test("a scoped search that matches nothing widens to the whole catalog")
    func scopedSearchWidensWhenEmpty() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "gpt-5", name: "GPT-5", provider: .codex),
                option(instance: "claude", modelID: "sonnet-5", name: "Sonnet 5", provider: .claude),
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        let inScope = ModelPickerCatalog.searchResults(
            items, scope: .provider(.codex), query: "gpt")
        let widened = ModelPickerCatalog.searchResults(
            items, scope: .provider(.codex), query: "sonnet")
        let nowhere = ModelPickerCatalog.searchResults(
            items, scope: .provider(.codex), query: "zzz")

        #expect(inScope.items.map(\.option.modelID) == ["gpt-5"])
        #expect(inScope.didWidenToAllModels == false)
        // The search field is the picker's one global affordance, so a model
        // the scope does not have is still findable by typing its name.
        #expect(widened.items.map(\.option.modelID) == ["sonnet-5"])
        #expect(widened.didWidenToAllModels)
        #expect(nowhere.items.isEmpty)
        #expect(nowhere.didWidenToAllModels == false)
    }

    @Test("an empty scope with no query stays empty instead of widening")
    func emptyScopeWithoutQueryDoesNotWiden() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "gpt-5", name: "GPT-5", provider: .codex)
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        let noQuery = ModelPickerCatalog.searchResults(items, scope: .favorites, query: "")
        let allScope = ModelPickerCatalog.searchResults(items, scope: .all, query: "zzz")

        #expect(noQuery.items.isEmpty)
        #expect(noQuery.didWidenToAllModels == false)
        #expect(allScope.items.isEmpty)
        #expect(allScope.didWidenToAllModels == false)
    }

    @Test("a highlight reset lands on a model row, not the clear row")
    func highlightResetSkipsClearRow() {
        let clearKey = "model-picker-clear"

        // Return after typing must pick a model, never the "none" choice that
        // pickers with a clear row list first.
        #expect(
            ModelPickerCatalog.firstModelRowKey(
                in: [clearKey, "codex/gpt-5", "claude/sonnet-5"], clearRowKey: clearKey)
                == "codex/gpt-5")
        #expect(
            ModelPickerCatalog.firstModelRowKey(in: ["codex/gpt-5"], clearRowKey: clearKey)
                == "codex/gpt-5")
        // With nothing else on offer the clear row is still a valid target.
        #expect(
            ModelPickerCatalog.firstModelRowKey(in: [clearKey], clearRowKey: clearKey) == clearKey)
        #expect(ModelPickerCatalog.firstModelRowKey(in: [], clearRowKey: clearKey) == nil)
    }

    @Test("the keyboard highlight moves to the row that took the removed row's place")
    func highlightFollowsRemovedRow() {
        let before = ["a", "b", "c"]

        #expect(
            ModelPickerCatalog.highlightAfterRemoval(
                previousKeys: before, removedKey: "b", remainingKeys: ["a", "c"]) == "c")
        // Removing the last row clamps to the new last row.
        #expect(
            ModelPickerCatalog.highlightAfterRemoval(
                previousKeys: before, removedKey: "c", remainingKeys: ["a", "b"]) == "b")
        #expect(
            ModelPickerCatalog.highlightAfterRemoval(
                previousKeys: before, removedKey: "b", remainingKeys: []) == nil)
        // A key that was never in the list falls back to the top row.
        #expect(
            ModelPickerCatalog.highlightAfterRemoval(
                previousKeys: before, removedKey: "z", remainingKeys: ["a", "c"]) == "a")
    }

    @Test("a repeated recents key yields one row")
    func recentsDeduplicateKeys() {
        let items = ModelPickerCatalog.items(
            from: [
                option(instance: "codex", modelID: "gpt-5", name: "GPT-5", provider: .codex),
                option(instance: "claude", modelID: "sonnet-5", name: "Sonnet 5", provider: .claude),
            ],
            selectedInstanceID: nil,
            selectedModelID: nil
        )

        let recents = ModelPickerCatalog.recentItems(
            items, recents: ["codex/gpt-5", "claude/sonnet-5", "codex/gpt-5"])

        #expect(recents.map(\.option.modelID) == ["gpt-5", "sonnet-5"])
    }
}
