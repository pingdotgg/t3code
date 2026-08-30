import SwiftUI

public struct ProviderModelPicker: View {
    public enum Style {
        case row
        case compact
    }

    let providers: [FeatureProvider]
    private let normalizedProviders: [FeatureProvider]
    @Binding var selection: FeatureSelection?
    let style: Style
    let isLoading: Bool
    let threadSelection: FeatureSelection?
    let materializesDefaultSelection: Bool
    private let onPresentationChange: ((Bool) -> Void)?

    @State private var isPresented = false

    public init(
        providers: [FeatureProvider],
        selection: Binding<FeatureSelection?>,
        style: Style = .row,
        isLoading: Bool = false,
        threadSelection: FeatureSelection? = nil,
        materializesDefaultSelection: Bool = true,
        onPresentationChange: ((Bool) -> Void)? = nil
    ) {
        self.providers = providers
        normalizedProviders = ProviderModelCatalogNormalizer.normalized(providers)
        _selection = selection
        self.style = style
        self.isLoading = isLoading
        self.threadSelection = threadSelection
        self.materializesDefaultSelection = materializesDefaultSelection
        self.onPresentationChange = onPresentationChange
    }

    public var body: some View {
        Button {
            onPresentationChange?(true)
            isPresented = true
        } label: {
            switch style {
            case .row:
                HStack(spacing: 12) {
                    selectionMark(size: 22)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Model")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                        Text(selectionLabel)
                            .font(T3Typography.control)
                            .foregroundStyle(T3Colors.textPrimary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                }
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            case .compact:
                HStack(spacing: 5) {
                    selectionMark(size: 14)
                    Text(compactModelName)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 8, weight: .bold))
                        .fixedSize()
                }
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textSecondary)
                .compositingGroup()
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose model")
        .accessibilityValue(selectionLabel)
        .accessibilityIdentifier("model-picker")
        .sheet(isPresented: $isPresented, onDismiss: { onPresentationChange?(false) }) {
            ModelPickerSheet(
                providers: normalizedProviders,
                selection: $selection,
                isLoading: isLoading,
                threadSelection: threadSelection,
                materializesDefaultSelection: materializesDefaultSelection
            )
        }
        .onAppear(perform: materializeSelection)
        .onChange(of: providers) { materializeSelection() }
        .onChange(of: selection) { materializeSelection() }
    }

    private var selectedOption: DailyUXModelOption? {
        guard let resolvedSelection,
              let provider = normalizedProviders.first(where: {
                  $0.id == resolvedSelection.providerID
              }),
              let model = provider.models.first(where: { $0.id == resolvedSelection.modelID }) else {
            return nil
        }
        return DailyUXModelOption(provider: provider, model: model)
    }

    private var resolvedSelection: FeatureSelection? {
        if materializesDefaultSelection {
            return ProviderModelSelectionResolver.materialized(selection, in: normalizedProviders)
        }
        return ThreadComposerModelSelectionPolicy.resolvedSelection(
            explicit: selection,
            inherited: threadSelection,
            providers: normalizedProviders
        )
    }

    private func materializeSelection() {
        guard !normalizedProviders.isEmpty else { return }
        let resolved = materializesDefaultSelection
            ? ProviderModelSelectionResolver.materialized(selection, in: normalizedProviders)
            : ThreadComposerModelSelectionPolicy.explicitSelection(
                selection,
                inherited: threadSelection,
                providers: normalizedProviders
            )
        guard selection != resolved else { return }
        selection = resolved
    }

    private var selectionLabel: String {
        guard let selectedOption else {
            return unavailableSelectionLabel
        }
        let base = "\(selectedOption.provider.name) · \(selectedOption.model.name)"
        guard let resolvedSelection,
              let summary = DailyUXModelOptions.summary(
                for: selectedOption.model,
                selections: resolvedSelection.options
              ) else {
            return base
        }
        return "\(base) · \(summary)"
    }

    private var compactModelName: String {
        guard let selectedOption else {
            return unavailableSelectionLabel
        }
        return selectedOption.model.name
    }

    private var unavailableSelectionLabel: String {
        if isLoading { return "Loading models" }
        if normalizedProviders.isEmpty { return "No providers" }
        if !normalizedProviders.contains(where: \.isAvailable) { return "Providers offline" }
        if !normalizedProviders.contains(where: { $0.isAvailable && !$0.models.isEmpty }) {
            return "No models"
        }
        return "Choose model"
    }

    @ViewBuilder
    private func selectionMark(size: CGFloat) -> some View {
        if let provider = selectedOption?.provider {
            ProviderIcon(
                driver: provider.driver,
                providerID: provider.id,
                fallbackName: provider.name,
                size: size
            )
        } else {
            Image(systemName: "cpu")
                .font(.system(size: size * 0.72, weight: .semibold))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: size, height: size)
        }
    }
}

private struct ModelPickerSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let providers: [FeatureProvider]
    @Binding var selection: FeatureSelection?
    let isLoading: Bool
    let threadSelection: FeatureSelection?
    let materializesDefaultSelection: Bool

    @AppStorage("swift-ios.model-picker.favorites") private var favoriteStorage = ""
    @AppStorage("swift-ios.model-picker.recents") private var recentStorage = ""
    @State private var query = ""
    @State private var configuring: DailyUXModelOption?
    @State private var legacyModelsExpanded = false
    @State private var catalogCache = ModelPickerCatalogCache()

    var body: some View {
        NavigationStack {
            Group {
                if isLoading, availableModelCount == 0 {
                    VStack(spacing: 12) {
                        Image(systemName: "cpu")
                            .font(.title2)
                            .foregroundStyle(T3Colors.textTertiary)
                            .accessibilityHidden(true)
                        Text("Loading models")
                            .font(T3Typography.control)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if availableModelCount == 0 {
                    ContentUnavailableView(
                        emptyStateTitle,
                        systemImage: emptyStateSymbol,
                        description: Text(emptyStateMessage)
                    )
                } else {
                    modelList
                }
            }
            .background(T3Colors.background)
            .navigationTitle("Choose model")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search models")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationDestination(item: $configuring) { option in
                ModelConfigurationView(
                    option: option,
                    currentSelection: selection
                ) { configuredSelection in
                    selection = configuredSelection
                    recordRecent(option.id)
                    dismiss()
                }
            }
            .t3NavigationChrome()
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onAppear(perform: revealSelectedLegacyModel)
        .onChange(of: selection) { revealSelectedLegacyModel() }
        .onChange(of: providers) { revealSelectedLegacyModel() }
    }

    private var modelList: some View {
        let catalog = cachedCatalog
        let sections = ProviderModelDisplaySections(catalog: catalog)
        let isSearching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return List {
            if modelChangesAreLocked {
                Section {
                    Label(
                        "This task cannot change models.",
                        systemImage: "lock"
                    )
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                }
            }

            if isSearching {
                ForEach(catalog.all) { option in
                    modelRow(
                        option,
                        showsProvider: true,
                        disambiguatesModel: sections.disambiguatedModelIDs.contains(option.id)
                    )
                }
            } else {
                if !sections.favorites.isEmpty {
                    Section("Favorites") {
                        ForEach(sections.favorites) { option in
                            modelRow(
                                option,
                                showsProvider: true,
                                disambiguatesModel: sections.disambiguatedModelIDs.contains(option.id)
                            )
                        }
                    }
                }

                if !sections.recents.isEmpty {
                    Section("Recent") {
                        ForEach(sections.recents) { option in
                            modelRow(
                                option,
                                showsProvider: true,
                                disambiguatesModel: sections.disambiguatedModelIDs.contains(option.id)
                            )
                        }
                    }
                }

                ForEach(sections.currentProviderGroups, id: \.provider.id) { group in
                    Section(group.provider.name) {
                        ForEach(group.models) { option in
                            modelRow(
                                option,
                                disambiguatesModel: sections.disambiguatedModelIDs.contains(option.id)
                            )
                        }
                    }
                }

                if !sections.legacy.isEmpty {
                    Section {
                        DisclosureGroup(isExpanded: $legacyModelsExpanded) {
                            ForEach(sections.legacy) { option in
                                modelRow(
                                    option,
                                    showsProvider: true,
                                    disambiguatesModel: sections.disambiguatedModelIDs.contains(option.id)
                                )
                            }
                        } label: {
                            HStack {
                                Text("Legacy models")
                                    .font(T3Typography.control.weight(.semibold))
                                Spacer()
                                Text("\(sections.legacy.count)")
                                    .font(T3Typography.supporting.monospacedDigit())
                                    .foregroundStyle(T3Colors.textTertiary)
                            }
                        }
                    }
                }
            }

            if catalog.all.isEmpty {
                ContentUnavailableView.search(text: query)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .background(T3Colors.background)
    }

    private var emptyStateTitle: String {
        if providers.isEmpty { return "No providers" }
        if !providers.contains(where: \.isAvailable) { return "Providers offline" }
        return "No models available"
    }

    private var emptyStateSymbol: String {
        providers.isEmpty || !providers.contains(where: \.isAvailable)
            ? "wifi.slash"
            : "cpu"
    }

    private var emptyStateMessage: String {
        if providers.isEmpty { return "Connect an environment to see its models." }
        if !providers.contains(where: \.isAvailable) {
            return "Reconnect this environment to choose a model."
        }
        return "This environment has no available models."
    }

    private var availableModelCount: Int {
        providers
            .filter(\.isAvailable)
            .reduce(into: 0) { count, provider in
                count += provider.models.count
            }
    }

    private func modelRow(
        _ option: DailyUXModelOption,
        showsProvider: Bool = false,
        disambiguatesModel: Bool = false
    ) -> some View {
        let isSelected = resolvedSelection?.providerID == option.provider.id
            && resolvedSelection?.modelID == option.model.id
        let isFavorite = favoriteIDs.contains(option.id)
        return HStack(spacing: 10) {
            Button {
                select(option)
            } label: {
                ModelOptionLabel(
                    option: option,
                    isSelected: isSelected,
                    showsProvider: showsProvider,
                    disambiguatesModel: disambiguatesModel
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isLocked(option))
            .opacity(isLocked(option) ? 0.36 : 1)
            .accessibilityLabel(option.model.name)
            .accessibilityValue(
                disambiguatesModel
                    ? "\(option.provider.name), \(option.model.id)"
                    : option.provider.name
            )
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityHint(
                isLocked(option)
                    ? "This task cannot change models."
                    : option.model.options.isEmpty
                        ? "Use this model."
                        : "Configure and use this model."
            )

            Button {
                toggleFavorite(option.id)
            } label: {
                Image(systemName: isFavorite ? "star.fill" : "star")
                    .font(.system(size: 15))
                    .foregroundStyle(
                        isFavorite ? T3Colors.warning : T3Colors.textTertiary
                    )
                    .frame(
                        width: T3Metrics.minimumTapTarget,
                        height: T3Metrics.minimumTapTarget
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(isFavorite ? "Remove from favorites" : "Add to favorites")
            .accessibilityValue(option.model.name)
        }
        .listRowBackground(T3Colors.background)
    }

    private var favoriteIDs: Set<String> {
        Set(favoriteStorage.split(separator: "\n").map(String.init))
    }

    private var recentIDs: [String] {
        recentStorage.split(separator: "\n").map(String.init)
    }

    private var cachedCatalog: DailyUXModelCatalog {
        catalogCache.catalog(
            providers: providers,
            query: query,
            favoriteStorage: favoriteStorage,
            recentStorage: recentStorage
        )
    }

    private var displaySections: ProviderModelDisplaySections {
        ProviderModelDisplaySections(catalog: cachedCatalog)
    }

    private var resolvedSelection: FeatureSelection? {
        if materializesDefaultSelection {
            return ProviderModelSelectionResolver.materialized(selection, in: providers)
        }
        return ThreadComposerModelSelectionPolicy.resolvedSelection(
            explicit: selection,
            inherited: threadSelection,
            providers: providers
        )
    }

    private func select(_ option: DailyUXModelOption) {
        guard !isLocked(option) else { return }
        if option.model.options.isEmpty {
            selection = FeatureSelection(providerID: option.provider.id, modelID: option.model.id)
            recordRecent(option.id)
            dismiss()
        } else {
            configuring = option
        }
    }

    private func recordRecent(_ id: String) {
        recentStorage = ([id] + recentIDs.filter { $0 != id })
            .prefix(8)
            .joined(separator: "\n")
    }

    private func revealSelectedLegacyModel() {
        guard !legacyModelsExpanded, let resolvedSelection else { return }
        if displaySections.legacy.contains(where: {
            $0.provider.id == resolvedSelection.providerID
                && $0.model.id == resolvedSelection.modelID
        }) {
            legacyModelsExpanded = true
        }
    }

    private var modelChangesAreLocked: Bool {
        guard let threadSelection,
              let provider = providers.first(where: { $0.id == threadSelection.providerID }) else {
            return false
        }
        return provider.requiresNewThreadForModelChange
    }

    private func isLocked(_ option: DailyUXModelOption) -> Bool {
        guard modelChangesAreLocked, let threadSelection else { return false }
        return option.provider.id != threadSelection.providerID
            || option.model.id != threadSelection.modelID
    }

    private func toggleFavorite(_ id: String) {
        var next = favoriteIDs
        if next.contains(id) {
            next.remove(id)
        } else {
            next.insert(id)
        }
        favoriteStorage = next.sorted().joined(separator: "\n")
    }
}

/// SwiftUI computed properties are ordinary function calls. The picker reads
/// its catalog throughout one body evaluation and invalidates on every search
/// keystroke, so retain the last derivation by its real inputs.
@MainActor
private final class ModelPickerCatalogCache {
    private struct Key: Equatable {
        let providers: [FeatureProvider]
        let query: String
        let favoriteStorage: String
        let recentStorage: String
    }

    private var key: Key?
    private var value: DailyUXModelCatalog?

    func catalog(
        providers: [FeatureProvider],
        query: String,
        favoriteStorage: String,
        recentStorage: String
    ) -> DailyUXModelCatalog {
        let key = Key(
            providers: providers,
            query: query,
            favoriteStorage: favoriteStorage,
            recentStorage: recentStorage
        )
        if self.key == key, let value { return value }

        let value = DailyUXModelCatalog(
            providers: ProviderModelSearch.matching(providers, query: query),
            query: "",
            favoriteIDs: Set(favoriteStorage.split(separator: "\n").map(String.init)),
            recentIDs: recentStorage.split(separator: "\n").map(String.init)
        )
        self.key = key
        self.value = value
        return value
    }
}

enum ProviderModelSearch {
    static func matching(_ providers: [FeatureProvider], query: String) -> [FeatureProvider] {
        let terms = query.split { !$0.isLetter && !$0.isNumber }.map(String.init)
        guard !terms.isEmpty else { return providers }

        return providers.compactMap { provider in
            var matchingProvider = provider
            matchingProvider.models = provider.models.filter { model in
                let searchableFields = [
                    provider.name,
                    provider.id,
                    model.name,
                    model.id,
                    model.detail ?? "",
                    model.supportsImages ? "images vision" : "",
                ]
                return terms.allSatisfy { term in
                    searchableFields.contains { $0.localizedCaseInsensitiveContains(term) }
                }
            }
            return matchingProvider.models.isEmpty ? nil : matchingProvider
        }
    }
}

/// The picker never represents an implicit "automatic" model. A missing or stale
/// selection becomes the environment's concrete preferred model as soon as the
/// catalog is available.
enum ProviderModelSelectionResolver {
    static func validated(
        _ selection: FeatureSelection?,
        in providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard !providers.isEmpty else { return selection }
        guard var validated = DailyUXModelOptions.validated(selection, in: providers),
              let model = providers
                  .first(where: { $0.id == validated.providerID })?
                  .models.first(where: { $0.id == validated.modelID }) else {
            return nil
        }
        validated.options = ProviderModelConfiguration.materializedOptions(
            for: model,
            preserving: validated.options
        )
        return validated
    }

    static func materialized(
        _ selection: FeatureSelection?,
        in providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard !providers.isEmpty else { return selection }
        if let validated = validated(selection, in: providers) {
            return validated
        }
        let currentProviders = providers.compactMap { provider -> FeatureProvider? in
            var current = provider
            current.models = provider.models.filter {
                ProviderModelFamilyClassifier.isCurrent($0, provider: provider)
            }
            return current.models.isEmpty ? nil : current
        }
        return DailyUXModelOptions.preferredSelection(in: currentProviders)
            ?? DailyUXModelOptions.preferredSelection(in: providers)
    }
}

/// Existing threads inherit their persisted model until the user deliberately
/// chooses an override. Unlike new-task composers, a missing selection must not
/// materialize the environment default and silently change providers.
enum ThreadComposerModelSelectionPolicy {
    static func resolvedSelection(
        explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        explicitSelection(explicit, inherited: inherited, providers: providers)
            ?? ProviderModelSelectionResolver.validated(inherited, in: providers)
    }

    static func explicitSelection(
        _ explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard let explicit, let inherited else { return nil }
        guard let validated = ProviderModelSelectionResolver.validated(explicit, in: providers)
        else {
            return nil
        }

        let inheritedProvider = providers.first { $0.id == inherited.providerID }
        if inheritedProvider?.requiresNewThreadForModelChange == true,
           (validated.providerID != inherited.providerID
               || validated.modelID != inherited.modelID) {
            return nil
        }
        return validated
    }
}

enum ProviderModelCatalogNormalizer {
    static func normalized(_ providers: [FeatureProvider]) -> [FeatureProvider] {
        var order: [String] = []
        var providersByID: [String: FeatureProvider] = [:]
        var modelIDsByProvider: [String: Set<String>] = [:]

        for provider in providers {
            let visibleModels = provider.models.filter { !isImplicitModel($0) }
            if var existing = providersByID[provider.id] {
                existing.isAvailable = existing.isAvailable || provider.isAvailable
                existing.requiresNewThreadForModelChange =
                    existing.requiresNewThreadForModelChange
                    || provider.requiresNewThreadForModelChange
                if existing.name.isEmpty {
                    existing.name = provider.name
                }
                if existing.driver.isEmpty {
                    existing.driver = provider.driver
                }
                existing.slashCommands = mergingMetadata(
                    existing.slashCommands,
                    provider.slashCommands,
                    id: \.id
                )
                existing.skills = mergingMetadata(
                    existing.skills,
                    provider.skills,
                    id: \.id
                )
                providersByID[provider.id] = existing
            } else {
                var normalized = provider
                normalized.models = []
                providersByID[provider.id] = normalized
                modelIDsByProvider[provider.id] = []
                order.append(provider.id)
            }

            for model in visibleModels {
                let wasInserted = modelIDsByProvider[provider.id, default: []]
                    .insert(model.id)
                    .inserted
                if wasInserted {
                    providersByID[provider.id]?.models.append(model)
                }
            }
        }

        return order.compactMap { providersByID[$0] }
    }

    private static func mergingMetadata<Value>(
        _ first: [Value]?,
        _ second: [Value]?,
        id: KeyPath<Value, String>
    ) -> [Value]? {
        guard first != nil || second != nil else { return nil }
        var seen = Set<String>()
        return ((first ?? []) + (second ?? [])).filter {
            seen.insert($0[keyPath: id]).inserted
        }
    }

    private static func isImplicitModel(_ model: FeatureModel) -> Bool {
        let tokens = [model.id, model.name].flatMap {
            $0.lowercased()
                .split { !$0.isLetter && !$0.isNumber }
                .map(String.init)
        }
        return tokens.contains("automatic") || tokens.contains("auto")
    }
}

struct ProviderModelDisplaySections {
    let favorites: [DailyUXModelOption]
    let recents: [DailyUXModelOption]
    let currentProviderGroups: [(
        provider: FeatureProvider,
        models: [DailyUXModelOption]
    )]
    let legacy: [DailyUXModelOption]
    let disambiguatedModelIDs: Set<String>

    init(catalog: DailyUXModelCatalog) {
        let currentIDs = Set(catalog.all.compactMap { option in
            ProviderModelFamilyClassifier.isCurrent(
                option.model,
                provider: option.provider
            ) ? option.id : nil
        })
        favorites = catalog.favorites
        var seenRecentIDs = Set<String>()
        recents = catalog.recents.filter {
            currentIDs.contains($0.id) && seenRecentIDs.insert($0.id).inserted
        }
        let promoted = Set((favorites + recents).map(\.id))
        currentProviderGroups = catalog.providerGroups.compactMap { group in
            let models = group.models.filter {
                currentIDs.contains($0.id) && !promoted.contains($0.id)
            }
            return models.isEmpty ? nil : (group.provider, models)
        }
        legacy = catalog.all.filter { !currentIDs.contains($0.id) && !promoted.contains($0.id) }

        let matchingLabels = Dictionary(grouping: catalog.all) { option in
            ModelPresentationKey(
                providerName: option.provider.name,
                name: option.model.name,
                detail: option.model.detail ?? option.model.id
            )
        }
        disambiguatedModelIDs = Set(
            matchingLabels.values
                .filter { $0.count > 1 }
                .flatMap { $0.map(\.id) }
        )
    }

    private struct ModelPresentationKey: Hashable {
        let providerName: String
        let name: String
        let detail: String
    }
}

enum ProviderModelFamilyClassifier {
    static func isCurrent(_ model: FeatureModel, provider _: FeatureProvider) -> Bool {
        model.isLegacy != true
    }
}

private struct ModelConfigurationView: View {
    let option: DailyUXModelOption
    let onConfirm: (FeatureSelection) -> Void
    @State private var optionSelections: [FeatureModelOptionSelection]

    init(
        option: DailyUXModelOption,
        currentSelection: FeatureSelection?,
        onConfirm: @escaping (FeatureSelection) -> Void
    ) {
        self.option = option
        self.onConfirm = onConfirm
        if currentSelection?.providerID == option.provider.id,
           currentSelection?.modelID == option.model.id {
            _optionSelections = State(initialValue: ProviderModelConfiguration.materializedOptions(
                for: option.model,
                preserving: currentSelection?.options ?? []
            ))
        } else {
            _optionSelections = State(initialValue: DailyUXModelOptions.defaults(for: option.model))
        }
    }

    var body: some View {
        Form {
            Section {
                ModelOptionLabel(option: option, isSelected: false)
            }

            ForEach(option.model.options) { descriptor in
                Section {
                    switch descriptor.kind {
                    case .select:
                        Picker(
                            descriptor.label,
                            selection: stringBinding(for: descriptor)
                        ) {
                            ForEach(descriptor.choices) { choice in
                                VStack(alignment: .leading) {
                                    Text(choice.label)
                                    if let detail = choice.detail {
                                        Text(detail)
                                    }
                                }
                                .tag(choice.id)
                            }
                        }
                        .pickerStyle(.navigationLink)
                    case .boolean:
                        Toggle(
                            descriptor.label,
                            isOn: booleanBinding(for: descriptor)
                        )
                    }
                } footer: {
                    if let detail = descriptor.detail {
                        Text(detail)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Model options")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Use model") {
                    onConfirm(
                        FeatureSelection(
                            providerID: option.provider.id,
                            modelID: option.model.id,
                            options: optionSelections
                        )
                    )
                }
                .fontWeight(.semibold)
            }
        }
    }

    private func stringBinding(
        for descriptor: FeatureModelOptionDescriptor
    ) -> Binding<String> {
        Binding(
            get: {
                guard case let .string(value) = DailyUXModelOptions.value(
                    for: descriptor,
                    in: optionSelections
                ) else {
                    return ""
                }
                return value
            },
            set: { value in
                optionSelections = DailyUXModelOptions.updating(
                    optionSelections,
                    id: descriptor.id,
                    value: .string(value)
                )
            }
        )
    }

    private func booleanBinding(
        for descriptor: FeatureModelOptionDescriptor
    ) -> Binding<Bool> {
        Binding(
            get: {
                guard case let .boolean(value) = DailyUXModelOptions.value(
                    for: descriptor,
                    in: optionSelections
                ) else {
                    return false
                }
                return value
            },
            set: { value in
                optionSelections = DailyUXModelOptions.updating(
                    optionSelections,
                    id: descriptor.id,
                    value: .boolean(value)
                )
            }
        )
    }
}

enum ProviderModelConfiguration {
    static func materializedOptions(
        for model: FeatureModel,
        preserving selections: [FeatureModelOptionSelection]
    ) -> [FeatureModelOptionSelection] {
        let selectedIDs = Set(selections.map(\.id))
        return selections + DailyUXModelOptions.defaults(for: model).filter {
            !selectedIDs.contains($0.id)
        }
    }
}

private struct ModelOptionLabel: View {
    let option: DailyUXModelOption
    let isSelected: Bool
    var showsProvider = false
    var disambiguatesModel = false

    var body: some View {
        HStack(spacing: 12) {
            providerMark
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(option.model.name)
                        .font(T3Typography.homeTitle)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    if option.model.supportsImages {
                        capability("Images", icon: "photo")
                    }
                }
                Text(modelDetail)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(T3Colors.textPrimary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }

    private var modelDetail: String {
        let detail = disambiguatesModel
            ? option.model.id
            : option.model.detail ?? option.model.id
        return showsProvider ? "\(option.provider.name) · \(detail)" : detail
    }

    private var providerMark: some View {
        ProviderIcon(
            driver: option.provider.driver,
            providerID: option.provider.id,
            fallbackName: option.provider.name,
            size: 26
        )
    }

    private func capability(_ title: String, icon: String) -> some View {
        Label(title, systemImage: icon)
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
    }
}
