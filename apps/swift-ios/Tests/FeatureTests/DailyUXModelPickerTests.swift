import Foundation
import Testing
@testable import T3Code

@Suite("Model picker")
struct DailyUXModelPickerTests {
    @Test
    func providerBrandsResolveFromDriversAndFallbackIDs() {
        #expect(
            ProviderBrand.resolve(driver: "codex", providerID: "work-openai") == .openAI
        )
        #expect(
            ProviderBrand.resolve(driver: "claudeAgent", providerID: "work-claude") == .claude
        )
        #expect(ProviderBrand.resolve(driver: "cursor", providerID: "cursor") == .cursor)
        #expect(ProviderBrand.resolve(driver: "grok", providerID: "grok") == .grok)
        #expect(ProviderBrand.resolve(driver: "opencode", providerID: "opencode") == .openCode)
        #expect(ProviderBrand.resolve(driver: "", providerID: "claude") == .claude)
        #expect(ProviderBrand.resolve(driver: "custom", providerID: "custom") == nil)
    }

    @Test
    func catalogPreservesFavoritesRecentsAndProviderGroups() {
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [
                    FeatureModel(id: "gpt-5", name: "GPT-5", supportsImages: true),
                    FeatureModel(id: "gpt-5-mini", name: "GPT-5 Mini"),
                ]
            ),
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [FeatureModel(id: "sonnet", name: "Sonnet", supportsReasoning: true)]
            ),
        ]
        let favorite = DailyUXModelOption.key(providerID: "claude", modelID: "sonnet")
        let recent = DailyUXModelOption.key(providerID: "codex", modelID: "gpt-5")

        let catalog = DailyUXModelCatalog(
            providers: providers,
            query: "",
            favoriteIDs: [favorite],
            recentIDs: [recent]
        )

        #expect(catalog.favorites.map(\.id) == [favorite])
        #expect(catalog.recents.map(\.id) == [recent])
        #expect(catalog.providerGroups.map(\.provider.id) == ["codex", "claude"])
    }

    @Test
    func catalogDeduplicatesRepeatedProviderAndModelIDs() {
        let repeated = FeatureProvider(
            id: "codex",
            name: "Codex",
            models: [
                FeatureModel(id: "gpt-5.6-sol", name: "Sol"),
                FeatureModel(id: "gpt-5.6-sol", name: "Sol again"),
            ]
        )
        let catalog = DailyUXModelCatalog(
            providers: [repeated, repeated],
            query: "",
            favoriteIDs: [],
            recentIDs: []
        )

        #expect(catalog.all.map(\.id) == ["codex::gpt-5.6-sol"])
        #expect(catalog.providerGroups.map(\.provider.id) == ["codex"])
        #expect(catalog.providerGroups.first?.models.count == 1)
    }

    @Test
    func searchIncludesCapabilitiesAndProviderNames() {
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [
                    FeatureModel(id: "vision", name: "Visual", supportsImages: true),
                    FeatureModel(id: "plain", name: "Plain"),
                ]
            ),
        ]

        let catalog = DailyUXModelCatalog(
            providers: providers,
            query: "images",
            favoriteIDs: [],
            recentIDs: []
        )

        #expect(catalog.all.map(\.model.id) == ["vision"])
    }

    @Test
    func optionDefaultsUseTypedDescriptorDefaults() {
        let model = FeatureModel(
            id: "gpt-5",
            name: "GPT-5",
            options: [
                FeatureModelOptionDescriptor(
                    id: "effort",
                    label: "Reasoning effort",
                    kind: .select,
                    choices: [
                        .init(id: "low", label: "Low"),
                        .init(id: "high", label: "High", isDefault: true),
                    ]
                ),
                FeatureModelOptionDescriptor(
                    id: "fast",
                    label: "Fast mode",
                    kind: .boolean,
                    defaultValue: .boolean(true)
                ),
                FeatureModelOptionDescriptor(
                    id: "thinking",
                    label: "Thinking",
                    kind: .boolean,
                    defaultValue: .boolean(false)
                ),
            ]
        )

        let defaults = DailyUXModelOptions.defaults(for: model)

        #expect(defaults == [
            FeatureModelOptionSelection(id: "effort", value: .string("high")),
            FeatureModelOptionSelection(id: "fast", value: .boolean(true)),
            FeatureModelOptionSelection(id: "thinking", value: .boolean(false)),
        ])
    }

    @Test
    func additionalReasoningOptionsRemainAvailable() {
        let effort = FeatureModelOptionDescriptor(
            id: "effort",
            label: "Reasoning",
            kind: .select,
            choices: [.init(id: "high", label: "High", isDefault: true)]
        )
        let thinking = FeatureModelOptionDescriptor(id: "thinking", label: "Thinking", kind: .boolean)
        let fast = FeatureModelOptionDescriptor(id: "fastMode", label: "Fast mode", kind: .boolean)
        let model = FeatureModel(id: "work-model", name: "Work model", options: [effort, thinking, fast])

        #expect(DailyUXModelOptions.reasoningDescriptor(for: model) == effort)
        #expect(DailyUXModelOptions.advancedDescriptors(for: model) == [thinking, fast])
    }

    @Test
    func selectingAModelDoesNotInventOptionDefaults() {
        let model = FeatureModel(
            id: "work-model",
            name: "Work model",
            options: [
                .init(
                    id: "effort",
                    label: "Reasoning",
                    kind: .select,
                    choices: [.init(id: "low", label: "Low"), .init(id: "high", label: "High")]
                ),
                .init(id: "thinking", label: "Thinking", kind: .boolean),
            ]
        )
        let provider = FeatureProvider(id: "work", name: "Work", models: [model])
        let selected = ProviderModelConfiguration.selection(
            for: DailyUXModelOption(provider: provider, model: model),
            preserving: nil
        )

        #expect(selected == FeatureSelection(providerID: "work", modelID: "work-model"))
        #expect(DailyUXModelOptions.summary(for: model, selections: selected.options) == nil)
        for descriptor in model.options {
            #expect(DailyUXModelOptions.value(for: descriptor, in: selected.options) == nil)
        }
    }

    @Test
    func returningToProviderDefaultsPreservesOtherSavedOptions() {
        let model = FeatureModel(
            id: "work-model",
            name: "Work model",
            options: [
                .init(
                    id: "effort",
                    label: "Reasoning",
                    kind: .select,
                    choices: [.init(id: "high", label: "High")]
                ),
                .init(id: "thinking", label: "Thinking", kind: .boolean),
            ]
        )
        let provider = FeatureProvider(id: "work", name: "Work", models: [model])
        let saved = FeatureSelection(
            providerID: provider.id,
            modelID: model.id,
            options: [
                .init(id: "effort", value: .string("unlisted")),
                .init(id: "thinking", value: .boolean(false)),
                .init(id: "providerFlag", value: .boolean(true)),
            ]
        )

        #expect(
            ProviderModelConfiguration.selection(
                for: DailyUXModelOption(provider: provider, model: model),
                preserving: saved
            ) == saved
        )

        let withoutThinking = DailyUXModelOptions.updating(saved.options, id: "thinking", value: nil)
        #expect(
            ProviderModelConfiguration.materializedOptions(
                for: model,
                preserving: withoutThinking
            ) == [
                .init(id: "effort", value: .string("unlisted")),
                .init(id: "providerFlag", value: .boolean(true)),
            ]
        )

        let withoutEffort = DailyUXModelOptions.updating(withoutThinking, id: "effort", value: nil)
        #expect(
            ProviderModelConfiguration.materializedOptions(
                for: model,
                preserving: withoutEffort
            ) == [
                .init(id: "providerFlag", value: .boolean(true)),
            ]
        )
    }

    @Test
    func updatingAnOptionReplacesOnlyItsPreviousValue() {
        let initial = [
            FeatureModelOptionSelection(id: "effort", value: .string("low")),
            FeatureModelOptionSelection(id: "fast", value: .boolean(false)),
        ]

        let updated = DailyUXModelOptions.updating(
            initial,
            id: "effort",
            value: .string("high")
        )

        #expect(updated.first { $0.id == "effort" }?.value == .string("high"))
        #expect(updated.first { $0.id == "fast" }?.value == .boolean(false))
        #expect(updated.count == 2)
    }

    @Test
    func optionSummaryUsesChoiceLabelsAndEnabledBooleans() {
        let model = FeatureModel(
            id: "gpt-5",
            name: "GPT-5",
            options: [
                .init(
                    id: "effort",
                    label: "Reasoning",
                    kind: .select,
                    choices: [.init(id: "high", label: "High")]
                ),
                .init(id: "fast", label: "Fast", kind: .boolean),
            ]
        )

        let summary = DailyUXModelOptions.summary(
            for: model,
            selections: [
                .init(id: "effort", value: .string("high")),
                .init(id: "fast", value: .boolean(true)),
            ]
        )

        #expect(summary == "High · Fast")
    }

    @Test
    func compactReasoningSummaryIgnoresOtherModelOptions() {
        let model = FeatureModel(
            id: "gpt-5",
            name: "A model name long enough to truncate",
            options: [
                .init(
                    id: "reasoningEffort",
                    label: "Reasoning",
                    kind: .select,
                    choices: [.init(id: "xhigh", label: "Extra high")]
                ),
                .init(id: "fast", label: "Fast mode", kind: .boolean),
            ]
        )

        let summary = DailyUXModelOptions.reasoningSummary(
            for: model,
            selections: [
                .init(id: "reasoningEffort", value: .string("xhigh")),
                .init(id: "fast", value: .boolean(true)),
            ]
        )

        #expect(summary == "Extra high")
    }

    @Test
    func preferredSelectionFindsDefaultAcrossProvidersAndIncludesDefaults() {
        let providers = [
            FeatureProvider(
                id: "first",
                name: "First",
                models: [.init(id: "basic", name: "Basic")]
            ),
            FeatureProvider(
                id: "second",
                name: "Second",
                models: [
                    .init(
                        id: "preferred",
                        name: "Preferred",
                        isDefault: true,
                        options: [
                            .init(
                                id: "fast",
                                label: "Fast",
                                kind: .boolean,
                                defaultValue: .boolean(true)
                            ),
                        ]
                    ),
                ]
            ),
        ]

        let selection = DailyUXModelOptions.preferredSelection(in: providers)

        #expect(selection?.providerID == "second")
        #expect(selection?.modelID == "preferred")
        #expect(selection?.options == [
            FeatureModelOptionSelection(id: "fast", value: .boolean(true)),
        ])
    }

    @Test
    func projectDefaultWinsBeforeAppAndCatalogDefaults() {
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [
                    .init(id: "project", name: "Project"),
                    .init(id: "app", name: "App"),
                    .init(id: "catalog", name: "Catalog", isDefault: true),
                ]
            ),
        ]

        let selection = DailyUXModelOptions.initialSelection(
            projectDefault: .init(providerID: "codex", modelID: "project"),
            appDefault: .init(providerID: "codex", modelID: "app"),
            providers: providers
        )

        #expect(selection?.modelID == "project")
    }

    @Test
    func missingAndStaleSelectionsMaterializeTheConcretePreferredModel() {
        let providers = [
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [
                    .init(
                        id: "claude-sonnet-4",
                        name: "Sonnet 4",
                        isDefault: true,
                        isLegacy: true
                    ),
                    .init(id: "claude-opus-5", name: "Opus 5"),
                ]
            ),
        ]

        #expect(
            ProviderModelSelectionResolver.materialized(nil, in: providers)?.modelID
                == "claude-opus-5"
        )
        #expect(
            ProviderModelSelectionResolver.materialized(
                .init(providerID: "claude", modelID: "removed"),
                in: providers
            )?.modelID == "claude-opus-5"
        )
    }

    @Test
    func selectionWaitsForTheProviderCatalogBeforeMaterializing() {
        let saved = FeatureSelection(
            providerID: "claude",
            modelID: "claude-opus-5"
        )

        #expect(ProviderModelSelectionResolver.materialized(saved, in: []) == saved)
        #expect(ProviderModelSelectionResolver.materialized(nil, in: []) == nil)
    }

    @Test
    func threadComposerInheritsClaudeWithoutMaterializingTheCodexDefault() {
        let inherited = FeatureSelection(providerID: "claude", modelID: "claude-opus-5")
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [.init(id: "gpt-5.6-sol", name: "Sol", isDefault: true)]
            ),
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [.init(id: "claude-opus-5", name: "Opus 5")]
            ),
        ]

        #expect(
            ThreadComposerModelSelectionPolicy.resolvedSelection(
                explicit: nil,
                inherited: inherited,
                providers: providers
            )?.providerID == "claude"
        )
        #expect(
            ThreadComposerModelSelectionPolicy.explicitSelection(
                nil,
                inherited: inherited,
                providers: providers
            ) == nil
        )
    }

    @Test
    func unlockedThreadRejectsCrossProviderOverrideAndAllowsSameProviderModel() {
        let inherited = FeatureSelection(providerID: "codex", modelID: "gpt-5.6-sol")
        let crossProvider = FeatureSelection(providerID: "claude", modelID: "claude-opus-5")
        let sameProvider = FeatureSelection(providerID: "codex", modelID: "gpt-5.6-terra")
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [
                    .init(id: "gpt-5.6-sol", name: "Sol", isDefault: true),
                    .init(id: "gpt-5.6-terra", name: "Terra"),
                ]
            ),
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [.init(id: "claude-opus-5", name: "Opus 5")]
            ),
        ]

        #expect(
            ThreadComposerModelSelectionPolicy.explicitSelection(
                crossProvider,
                inherited: inherited,
                providers: providers
            ) == nil
        )
        #expect(
            ThreadComposerModelSelectionPolicy.explicitSelection(
                sameProvider,
                inherited: inherited,
                providers: providers
            )?.modelID == "gpt-5.6-terra"
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                crossProvider,
                providers: providers,
                inheriting: inherited,
                allowsProviderChange: false
            ) == nil
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                sameProvider,
                providers: providers,
                inheriting: inherited,
                allowsProviderChange: false
            )?.modelID == "gpt-5.6-terra"
        )
    }

    @Test
    func lockedProviderRejectsAChangeToAnotherModel() {
        let inherited = FeatureSelection(providerID: "claude", modelID: "opus")
        let alternate = FeatureSelection(providerID: "claude", modelID: "sonnet")
        let configured = FeatureSelection(
            providerID: "claude",
            modelID: "opus",
            options: [.init(id: "reasoningEffort", value: .string("high"))]
        )
        let provider = FeatureProvider(
            id: "claude",
            name: "Claude",
            requiresNewThreadForModelChange: true,
            models: [
                .init(
                    id: "opus",
                    name: "Opus",
                    options: [
                        .init(
                            id: "reasoningEffort",
                            label: "Reasoning effort",
                            kind: .select,
                            choices: [.init(id: "high", label: "High")]
                        ),
                    ]
                ),
                .init(id: "sonnet", name: "Sonnet"),
            ]
        )

        #expect(
            ThreadComposerModelSelectionPolicy.explicitSelection(
                alternate,
                inherited: inherited,
                providers: [provider]
            ) == nil
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                alternate,
                providers: [provider],
                inheriting: inherited,
                allowsProviderChange: false
            ) == nil
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                configured,
                providers: [provider],
                inheriting: inherited,
                allowsProviderChange: false
            ) == configured
        )
    }

    @Test
    func pickerShowsAllProvidersForNewTasksAndOnlyTheThreadProviderOtherwise() {
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [.init(id: "sol", name: "Sol")]
            ),
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [.init(id: "opus", name: "Opus")]
            ),
        ]

        #expect(
            ThreadComposerModelSelectionPolicy.pickerProviders(
                providers,
                inherited: nil,
                allowsProviderChange: true
            ).map(\.id) == ["codex", "claude"]
        )
        #expect(
            ThreadComposerModelSelectionPolicy.pickerProviders(
                providers,
                inherited: .init(providerID: "codex", modelID: "sol"),
                allowsProviderChange: false
            ).map(\.id) == ["codex"]
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                .init(providerID: "claude", modelID: "opus"),
                providers: providers,
                inheriting: nil,
                allowsProviderChange: true
            )?.providerID == "claude"
        )
    }

    @Test
    func missingInheritedProviderDoesNotUseAnotherProviderCatalog() {
        let inherited = FeatureSelection(providerID: "claude", modelID: "opus")
        let codex = FeatureProvider(
            id: "codex",
            name: "Codex",
            models: [.init(id: "sol", name: "Sol", isDefault: true)]
        )

        #expect(
            ThreadComposerModelSelectionPolicy.pickerProviders(
                [codex],
                inherited: inherited,
                allowsProviderChange: false
            ).isEmpty
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                .init(providerID: "codex", modelID: "sol"),
                providers: [codex],
                inheriting: nil,
                allowsProviderChange: false
            ) == nil
        )
        #expect(
            ThreadComposerModelSelectionPolicy.pickerProviders(
                [codex],
                inherited: nil,
                allowsProviderChange: false
            ).isEmpty
        )
        #expect(
            ThreadComposerModelSelectionPolicy.resolvedSelection(
                explicit: nil,
                inherited: inherited,
                providers: [codex]
            ) == inherited
        )
    }

    @Test
    func threadCatalogUsesThreadEnvironmentWhenProjectIsMissing() {
        let codex = FeatureProvider(
            id: "codex-work",
            name: "Codex",
            driver: "codex",
            models: [.init(id: "current", name: "Current")]
        )
        let snapshot = FeatureSnapshot(
            providersByEnvironment: ["remote": [codex]]
        )
        let thread = FeatureThread(
            id: "thread",
            projectID: "missing-project",
            environmentID: "remote",
            title: "Task",
            providerID: "codex-work",
            providerName: "Codex",
            modelID: "current"
        )

        let providers = ThreadComposerProviderCatalog.providers(for: thread, in: snapshot)

        #expect(providers == [codex])
    }

    @Test
    func threadCatalogIgnoresAStaleProjectEnvironment() {
        let local = FeatureProvider(
            id: "claude-local",
            name: "Claude",
            driver: "claudeAgent",
            models: [.init(id: "sonnet", name: "Sonnet")]
        )
        let remote = FeatureProvider(
            id: "codex-remote",
            name: "Codex",
            driver: "codex",
            models: [.init(id: "current", name: "Current")]
        )
        let snapshot = FeatureSnapshot(
            projects: [
                .init(
                    id: "project",
                    environmentID: "local",
                    name: "Stale project",
                    path: "/tmp/project"
                ),
            ],
            providersByEnvironment: [
                "local": [local],
                "remote": [remote],
            ]
        )
        let thread = FeatureThread(
            id: "thread",
            projectID: "project",
            environmentID: "remote",
            title: "Task",
            providerID: "codex-remote",
            providerName: "Codex",
            modelID: "current"
        )

        let providers = ThreadComposerProviderCatalog.providers(for: thread, in: snapshot)

        #expect(providers == [remote])
    }

    @Test
    func threadCatalogKeepsCustomModelMissingFromDiscovery() {
        let savedOptions = [
            FeatureModelOptionSelection(id: "reasoningEffort", value: .string("high")),
        ]
        let discovered = FeatureProvider(
            id: "codex-work",
            name: "Codex",
            driver: "codex",
            models: [.init(id: "current", name: "Current")]
        )
        let thread = FeatureThread(
            id: "thread",
            projectID: "project",
            environmentID: "remote",
            title: "Task",
            providerID: "codex-work",
            providerName: "Codex",
            modelID: "custom-model",
            modelOptions: savedOptions
        )
        let snapshot = FeatureSnapshot(
            providersByEnvironment: ["remote": [discovered]]
        )

        let providers = ThreadComposerProviderCatalog.providers(for: thread, in: snapshot)
        let inherited = FeatureSelection(
            providerID: "codex-work",
            modelID: "custom-model",
            options: savedOptions
        )

        #expect(providers[0].models.map(\.id) == ["current", "custom-model"])
        #expect(
            ThreadComposerModelSelectionPolicy.resolvedSelection(
                explicit: nil,
                inherited: inherited,
                providers: providers
            ) == inherited
        )
    }

    @Test
    func threadCatalogKeepsSavedSelectionWhenProviderIsUnavailable() {
        let inherited = FeatureSelection(
            providerID: "codex-work",
            modelID: "custom-model",
            options: [.init(id: "reasoningEffort", value: .string("high"))]
        )
        let unavailable = FeatureProvider(
            id: "codex-work",
            name: "Codex",
            isAvailable: false,
            driver: "codex",
            models: [.init(id: "custom-model", name: "Custom model")]
        )

        #expect(
            ThreadComposerModelSelectionPolicy.resolvedSelection(
                explicit: nil,
                inherited: inherited,
                providers: [unavailable]
            ) == inherited
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                inherited,
                providers: [unavailable],
                inheriting: inherited,
                allowsProviderChange: false
            ) == nil
        )
    }

    @Test
    func threadCatalogLocksToExactProviderInstanceButAllowsItsModels() {
        let inherited = FeatureSelection(providerID: "codex-work", modelID: "current")
        let work = FeatureProvider(
            id: "codex-work",
            name: "Codex work",
            driver: "codex",
            models: [
                .init(id: "current", name: "Current"),
                .init(id: "alternate", name: "Alternate"),
            ]
        )
        let personal = FeatureProvider(
            id: "codex-personal",
            name: "Codex personal",
            driver: "codex",
            models: [
                .init(id: "current", name: "Current"),
                .init(id: "alternate", name: "Alternate"),
            ]
        )

        #expect(
            ThreadComposerModelSelectionPolicy.pickerProviders(
                [work, personal],
                inherited: inherited,
                allowsProviderChange: false
            ).map(\.id) == ["codex-work"]
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                .init(providerID: "codex-work", modelID: "alternate"),
                providers: [work, personal],
                inheriting: inherited,
                allowsProviderChange: false
            )?.modelID == "alternate"
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                .init(providerID: "codex-personal", modelID: "alternate"),
                providers: [work, personal],
                inheriting: inherited,
                allowsProviderChange: false
            ) == nil
        )
    }

    @Test
    func configurationMaterializesDisplayedDefaultsWithoutOverwritingSelections() {
        let model = FeatureModel(
            id: "gpt-5.6-sol",
            name: "Sol",
            options: [
                .init(
                    id: "effort",
                    label: "Effort",
                    kind: .select,
                    choices: [
                        .init(id: "high", label: "High", isDefault: true),
                    ]
                ),
                .init(
                    id: "fast",
                    label: "Fast",
                    kind: .boolean,
                    defaultValue: .boolean(true)
                ),
            ]
        )
        let existing = [
            FeatureModelOptionSelection(id: "effort", value: .string("custom")),
        ]

        #expect(
            ProviderModelConfiguration.materializedOptions(
                for: model,
                preserving: existing
            ) == [
                .init(id: "effort", value: .string("custom")),
                .init(id: "fast", value: .boolean(true)),
            ]
        )
    }

    @Test
    func concreteSelectionIncludesTheOptionDefaultsShownByThePicker() {
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [
                    .init(
                        id: "gpt-5.6-sol",
                        name: "Sol",
                        options: [
                            .init(
                                id: "effort",
                                label: "Effort",
                                kind: .select,
                                choices: [
                                    .init(id: "high", label: "High", isDefault: true),
                                ]
                            ),
                        ]
                    ),
                ]
            ),
        ]

        #expect(
            ProviderModelSelectionResolver.materialized(
                .init(providerID: "codex", modelID: "gpt-5.6-sol"),
                in: providers
            )?.options == [
                .init(id: "effort", value: .string("high")),
            ]
        )
    }

    @Test
    func configurationSeedsFromTheEffectiveSavedThreadSelection() {
        let model = FeatureModel(
            id: "gpt-5.6-sol",
            name: "Sol",
            options: [
                .init(
                    id: "reasoningEffort",
                    label: "Reasoning effort",
                    kind: .select,
                    choices: [
                        .init(id: "low", label: "Low"),
                        .init(id: "high", label: "High"),
                    ]
                ),
                .init(id: "fast", label: "Fast", kind: .boolean),
            ]
        )
        let provider = FeatureProvider(id: "codex", name: "Codex", models: [model])
        let inherited = FeatureSelection(
            providerID: "codex",
            modelID: model.id,
            options: [
                .init(id: "reasoningEffort", value: .string("high")),
                .init(id: "fast", value: .boolean(true)),
            ]
        )
        let effective = ThreadComposerModelSelectionPolicy.resolvedSelection(
            explicit: nil,
            inherited: inherited,
            providers: [provider]
        )

        let configured = ProviderModelConfiguration.selection(
            for: DailyUXModelOption(provider: provider, model: model),
            preserving: effective
        )

        #expect(configured == inherited)
    }

    @Test
    func explicitDraftOptionsWinOverTheInheritedThreadOptions() {
        let model = FeatureModel(
            id: "gpt-5.6-sol",
            name: "Sol",
            options: [
                .init(
                    id: "reasoningEffort",
                    label: "Reasoning effort",
                    kind: .select,
                    choices: [
                        .init(id: "low", label: "Low"),
                        .init(id: "high", label: "High"),
                    ]
                ),
            ]
        )
        let provider = FeatureProvider(id: "codex", name: "Codex", models: [model])
        let inherited = FeatureSelection(
            providerID: "codex",
            modelID: model.id,
            options: [.init(id: "reasoningEffort", value: .string("low"))]
        )
        let explicit = FeatureSelection(
            providerID: "codex",
            modelID: model.id,
            options: [.init(id: "reasoningEffort", value: .string("high"))]
        )

        let effective = ThreadComposerModelSelectionPolicy.resolvedSelection(
            explicit: explicit,
            inherited: inherited,
            providers: [provider]
        )

        #expect(effective == explicit)
    }

    @Test
    func unsupportedValuesAndUndescribedOptionsRemainVisibleAndPreserved() {
        let model = FeatureModel(
            id: "gpt-5.6-sol",
            name: "Sol",
            options: [
                .init(
                    id: "reasoningEffort",
                    label: "Reasoning effort",
                    kind: .select,
                    choices: [
                        .init(id: "low", label: "Low"),
                        .init(id: "high", label: "High"),
                    ]
                ),
            ]
        )
        let saved = [
            FeatureModelOptionSelection(
                id: "reasoningEffort",
                value: .string("environment-custom")
            ),
            FeatureModelOptionSelection(id: "providerFlag", value: .boolean(true)),
        ]
        let descriptor = DailyUXModelOptions.reasoningDescriptor(for: model)

        #expect(descriptor?.choices.map(\.id) == ["low", "high"])
        #expect(
            descriptor.map {
                DailyUXModelOptions.isSupportedValue(saved[0].value, for: $0)
            } == false
        )
        #expect(
            DailyUXModelOptions.undescribedSelections(
                for: model,
                selections: saved
            ).map(\.id) == ["providerFlag"]
        )
        #expect(
            DailyUXModelOptions.reasoningSummary(for: model, selections: saved)
                == "environment-custom"
        )
    }

    @Test
    func changingReasoningPreservesNonreasoningAndUndescribedOptions() {
        let selections = [
            FeatureModelOptionSelection(id: "reasoningEffort", value: .string("low")),
            FeatureModelOptionSelection(id: "fast", value: .boolean(true)),
            FeatureModelOptionSelection(id: "providerFlag", value: .string("keep")),
        ]

        let updated = DailyUXModelOptions.updating(
            selections,
            id: "reasoningEffort",
            value: .string("high")
        )

        #expect(updated.first { $0.id == "reasoningEffort" }?.value == .string("high"))
        #expect(updated.first { $0.id == "fast" }?.value == .boolean(true))
        #expect(updated.first { $0.id == "providerFlag" }?.value == .string("keep"))
    }

    @Test
    func modelDraftCachePreservesOptionsWhenReturningToASelection() {
        let reasoning = FeatureModelOptionDescriptor(
            id: "reasoningEffort",
            label: "Reasoning effort",
            kind: .select,
            choices: [
                .init(id: "low", label: "Low", isDefault: true),
                .init(id: "high", label: "High"),
            ]
        )
        let modelA = FeatureModel(id: "model-a", name: "Model A", options: [reasoning])
        let modelB = FeatureModel(id: "model-b", name: "Model B", options: [reasoning])
        let provider = FeatureProvider(id: "codex", name: "Codex", models: [modelA, modelB])
        let savedA = FeatureSelection(
            providerID: provider.id,
            modelID: modelA.id,
            options: [
                .init(id: reasoning.id, value: .string("high")),
                .init(id: "providerFlag", value: .boolean(true)),
            ]
        )
        let optionA = DailyUXModelOption(provider: provider, model: modelA)
        let optionB = DailyUXModelOption(provider: provider, model: modelB)
        let selectedB = ProviderModelDraftPolicy.selection(
            for: optionB,
            cached: nil,
            current: savedA,
            committed: savedA
        )

        let returnedA = ProviderModelDraftPolicy.selection(
            for: optionA,
            cached: savedA,
            current: selectedB,
            committed: savedA
        )

        #expect(returnedA == savedA)
    }

    @Test
    func liveSelectionChangesAndUnavailableModelsInvalidateEditedDrafts() {
        let modelA = FeatureModel(id: "model-a", name: "Model A")
        let modelB = FeatureModel(id: "model-b", name: "Model B")
        let provider = FeatureProvider(
            id: "codex",
            name: "Codex",
            requiresNewThreadForModelChange: true,
            models: [modelA, modelB]
        )
        let selectionA = FeatureSelection(providerID: provider.id, modelID: modelA.id)
        let selectionB = FeatureSelection(providerID: provider.id, modelID: modelB.id)

        #expect(
            ProviderModelDraftPolicy.canKeepEditedDraft(
                base: selectionA,
                currentCommitted: selectionB,
                draft: selectionA,
                providers: [provider],
                inheriting: nil,
                allowsProviderChange: true
            ) == false
        )
        #expect(
            ProviderModelDraftPolicy.canKeepEditedDraft(
                base: selectionA,
                currentCommitted: selectionA,
                draft: selectionA,
                providers: [],
                inheriting: nil,
                allowsProviderChange: true
            ) == false
        )
        #expect(
            ProviderModelDraftPolicy.validated(
                selectionB,
                providers: [provider],
                inheriting: selectionA,
                allowsProviderChange: false
            ) == nil
        )
    }

    @Test
    func duplicateCatalogEntriesCollapseAndImplicitModelsDisappear() {
        let normalized = ProviderModelCatalogNormalizer.normalized([
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [
                    .init(id: "environment-auto", name: "Automatic (recommended)"),
                    .init(id: "opus", name: "Opus"),
                ]
            ),
            FeatureProvider(
                id: "claude",
                name: "Claude duplicate",
                models: [
                    .init(id: "opus", name: "Opus duplicate"),
                    .init(id: "sonnet", name: "Sonnet"),
                ]
            ),
        ])

        #expect(normalized.map(\.id) == ["claude"])
        #expect(normalized[0].name == "Claude")
        #expect(normalized[0].models.map(\.id) == ["opus", "sonnet"])
        #expect(normalized[0].models.map(\.name) == ["Opus", "Sonnet"])
    }

    @Test
    func duplicateProvidersMergeComposerCommandsAndSkills() {
        let normalized = ProviderModelCatalogNormalizer.normalized([
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [.init(id: "opus", name: "Opus")],
                slashCommands: [.init(name: "review")],
                skills: [.init(name: "deploy")]
            ),
            FeatureProvider(
                id: "claude",
                name: "Claude",
                driver: "claudeAgent",
                models: [.init(id: "sonnet", name: "Sonnet")],
                slashCommands: [.init(name: "review"), .init(name: "compact")],
                skills: [.init(name: "deploy"), .init(name: "fix-ci")]
            ),
        ])

        #expect(normalized[0].driver == "claudeAgent")
        #expect(normalized[0].slashCommands?.map(\.name) == ["review", "compact"])
        #expect(normalized[0].skills?.map(\.name) == ["deploy", "fix-ci"])
    }

    @Test
    func favoritesAndRecentsDoNotRepeatInProviderSections() {
        let providers = [
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [
                    .init(id: "claude-opus-5", name: "Opus 5"),
                    .init(id: "claude-sonnet-5", name: "Sonnet 5"),
                    .init(id: "claude-fable-5", name: "Fable 5"),
                    .init(id: "claude-haiku-3", name: "Haiku 3", isLegacy: true),
                ]
            ),
        ]
        let opus = DailyUXModelOption.key(
            providerID: "claude",
            modelID: "claude-opus-5"
        )
        let sonnet = DailyUXModelOption.key(
            providerID: "claude",
            modelID: "claude-sonnet-5"
        )
        let catalog = DailyUXModelCatalog(
            providers: providers,
            query: "",
            favoriteIDs: [opus],
            recentIDs: [sonnet]
        )

        let remaining = ProviderModelDisplaySections(catalog: catalog)

        #expect(
            remaining.currentProviderGroups.flatMap(\.models).map(\.model.id)
                == ["claude-fable-5"]
        )
        #expect(remaining.legacy.map(\.model.id) == ["claude-haiku-3"])
    }

    @Test
    func legacyFavoritesStayPromotedAndReturnToLegacyWhenUnfavorited() {
        let provider = FeatureProvider(
            id: "claude",
            name: "Claude",
            models: [
                .init(id: "current", name: "Current"),
                .init(id: "older", name: "Older", isLegacy: true),
            ]
        )
        let favoriteID = DailyUXModelOption.key(providerID: provider.id, modelID: "older")
        for query in ["", "Older"] {
            let sections = ProviderModelDisplaySections(catalog: DailyUXModelCatalog(
                providers: [provider], query: query, favoriteIDs: [favoriteID], recentIDs: [favoriteID]
            ))
            #expect(sections.favorites.map(\.model.id) == ["older"])
            #expect(sections.recents.isEmpty)
            #expect(sections.legacy.isEmpty)
        }
        let unfavorited = ProviderModelDisplaySections(catalog: DailyUXModelCatalog(
            providers: [provider], query: "", favoriteIDs: [], recentIDs: [favoriteID]
        ))
        #expect(unfavorited.favorites.isEmpty)
        #expect(unfavorited.legacy.map(\.model.id) == ["older"])
    }

    @Test
    func serverLegacyMetadataIsAuthoritative() {
        let codex = FeatureProvider(id: "work-openai", name: "Codex", driver: "codex")
        let claude = FeatureProvider(
            id: "work-claude",
            name: "Anthropic",
            driver: "claudeAgent"
        )

        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "gpt-5.6-codex-luna", name: "Luna", isLegacy: false),
                provider: codex
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "gpt_5_6_terra", name: "GPT 5.6 Terra", isLegacy: false),
                provider: codex
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "gpt-5-6-sol", name: "Sol", isLegacy: false),
                provider: codex
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "claude-fable-5-202607", name: "Fable 5", isLegacy: false),
                provider: claude
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "claude-opus-5", name: "OPUS 5", isLegacy: false),
                provider: claude
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "claude-sonnet-5", name: "Sonnet v5", isLegacy: false),
                provider: claude
            )
        )
        #expect(
            !ProviderModelFamilyClassifier.isCurrent(
                .init(id: "claude-opus-4-1", name: "Opus 4.1", isLegacy: true),
                provider: claude
            )
        )
        #expect(
            !ProviderModelFamilyClassifier.isCurrent(
                .init(id: "gpt-5.5-codex-sol", name: "GPT 5.5 Sol", isLegacy: true),
                provider: codex
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "custom-opus-4", name: "Custom Opus 4"),
                provider: claude
            )
        )
    }
}
