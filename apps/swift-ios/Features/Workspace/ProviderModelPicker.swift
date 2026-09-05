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
    private let onRefresh: (@MainActor () async throws -> Void)?

    @State private var isPresented = false
    @State private var preservesSelectionDuringRefresh = false

    public init(
        providers: [FeatureProvider],
        selection: Binding<FeatureSelection?>,
        style: Style = .row,
        isLoading: Bool = false,
        threadSelection: FeatureSelection? = nil,
        materializesDefaultSelection: Bool = true,
        onRefresh: (@MainActor () async throws -> Void)? = nil,
        onPresentationChange: ((Bool) -> Void)? = nil
    ) {
        self.providers = providers
        normalizedProviders = ProviderModelCatalogNormalizer.normalized(providers)
        _selection = selection
        self.style = style
        self.isLoading = isLoading
        self.threadSelection = threadSelection
        self.materializesDefaultSelection = materializesDefaultSelection
        self.onRefresh = onRefresh
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
                    if let compactReasoningSummary {
                        Text("· \(compactReasoningSummary)")
                            .fixedSize()
                    }
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
                materializesDefaultSelection: materializesDefaultSelection,
                onRefresh: onRefresh.map { refresh in
                    {
                        preservesSelectionDuringRefresh = true
                        defer { preservesSelectionDuringRefresh = false }
                        try await refresh()
                    }
                }
            )
        }
        .onAppear(perform: materializeSelection)
        .onChange(of: providers) {
            if !preservesSelectionDuringRefresh { materializeSelection() }
        }
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

    private var compactReasoningSummary: String? {
        guard let selectedOption, let resolvedSelection else { return nil }
        return DailyUXModelOptions.reasoningSummary(
            for: selectedOption.model,
            selections: resolvedSelection.options
        )
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
    @SwiftUI.Environment(\.providerSetupContext) private var setupContext
    let providers: [FeatureProvider]
    @Binding var selection: FeatureSelection?
    let isLoading: Bool
    let threadSelection: FeatureSelection?
    let materializesDefaultSelection: Bool
    let onRefresh: (@MainActor () async throws -> Void)?

    @AppStorage("swift-ios.model-picker.favorites") private var favoriteStorage = ""
    @AppStorage("swift-ios.model-picker.recents") private var recentStorage = ""
    @State private var query = ""
    @State private var configuring: DailyUXModelOption?
    @State private var legacyModelsExpanded = false
    @State private var catalogCache = ModelPickerCatalogCache()
    @State private var draftSelection: FeatureSelection?
    @State private var draftBaseSelection: FeatureSelection?
    @State private var modelDrafts: [String: FeatureSelection]
    @State private var hasEditedDraft = false
    @State private var isRefreshing = false
    @State private var refreshError: String?

    init(
        providers: [FeatureProvider],
        selection: Binding<FeatureSelection?>,
        isLoading: Bool,
        threadSelection: FeatureSelection?,
        materializesDefaultSelection: Bool,
        onRefresh: (@MainActor () async throws -> Void)?
    ) {
        self.providers = providers
        _selection = selection
        self.isLoading = isLoading
        self.threadSelection = threadSelection
        self.materializesDefaultSelection = materializesDefaultSelection
        self.onRefresh = onRefresh
        let initialSelection = Self.effectiveSelection(
            explicit: selection.wrappedValue,
            inherited: threadSelection,
            providers: providers,
            materializesDefaultSelection: materializesDefaultSelection
        )
        _draftSelection = State(initialValue: initialSelection)
        _draftBaseSelection = State(initialValue: initialSelection)
        _modelDrafts = State(initialValue: initialSelection.map {
            [DailyUXModelOption.key(providerID: $0.providerID, modelID: $0.modelID): $0]
        } ?? [:])
    }

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
                if let setupContext {
                    ToolbarItem(placement: .topBarLeading) {
                        NavigationLink("Providers") {
                            ProvidersSettingsView(model: setupContext.model, environmentID: setupContext.environmentID)
                        }
                    }
                }
                if onRefresh != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            refreshCatalog()
                        } label: {
                            if isRefreshing {
                                Image(systemName: "hourglass")
                            } else {
                                Image(systemName: "arrow.clockwise")
                            }
                        }
                        .disabled(isRefreshing)
                        .accessibilityLabel(isRefreshing ? "Refreshing models" : "Refresh models")
                        .accessibilityIdentifier("model-picker-refresh")
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") { applySelection() }
                        .fontWeight(.semibold)
                        .disabled(!hasDraftChanges)
                        .accessibilityIdentifier("model-picker-apply")
                }
            }
            .navigationDestination(item: $configuring) { option in
                ModelConfigurationView(
                    option: option,
                    currentSelection: pickerSelection
                ) { configuredSelection in
                    draftSelection = configuredSelection
                    rememberDraft(configuredSelection)
                    hasEditedDraft = configuredSelection != committedSelection
                    configuring = nil
                }
            }
            .t3NavigationChrome()
            .alert("Could not refresh models", isPresented: Binding(
                get: { refreshError != nil },
                set: { if !$0 { refreshError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(refreshError ?? "Try again.")
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onAppear {
            reconcileDraftSelectionWithCurrentState()
            revealSelectedLegacyModel()
        }
        .onChange(of: selection) {
            reconcileDraftSelectionWithCurrentState()
            revealSelectedLegacyModel()
        }
        .onChange(of: threadSelection) {
            reconcileDraftSelectionWithCurrentState()
            revealSelectedLegacyModel()
        }
        .onChange(of: providers) {
            reconcileDraftSelectionWithCurrentState()
            revealSelectedLegacyModel()
        }
    }

    private func refreshCatalog() {
        guard let onRefresh, !isRefreshing else { return }
        isRefreshing = true
        refreshError = nil
        Task {
            do {
                try await onRefresh()
            } catch {
                refreshError = error.localizedDescription
            }
            isRefreshing = false
        }
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
        .safeAreaInset(edge: .bottom, spacing: 0) {
            selectionControls
        }
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
        pickerProviders
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
        let isSelected = pickerSelection?.providerID == option.provider.id
            && pickerSelection?.modelID == option.model.id
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
            .accessibilityIdentifier("model-option-\(option.id)")
            .accessibilityHint(
                isLocked(option)
                    ? "This task cannot change models."
                    : "Select this model."
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

    @ViewBuilder
    private var selectionControls: some View {
        if let selectedOption {
            VStack(alignment: .leading, spacing: 10) {
                Divider()
                if let descriptor = DailyUXModelOptions.reasoningDescriptor(
                    for: selectedOption.model
                ) {
                    modelOptionControl(descriptor)
                    optionFooter(for: descriptor)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Reasoning effort")
                            .font(T3Typography.control)
                            .foregroundStyle(T3Colors.textPrimary)
                        Text("This environment does not describe reasoning effort choices for this model.")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("reasoning-effort-unavailable")
                }

                if !DailyUXModelOptions.advancedDescriptors(for: selectedOption.model).isEmpty
                    || !undescribedSelections.isEmpty {
                    Button {
                        configuring = selectedOption
                    } label: {
                        HStack {
                            Text("Advanced options")
                                .foregroundStyle(T3Colors.textPrimary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(T3Typography.supportingStrong)
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("advanced-model-options")

                    if !undescribedSelections.isEmpty {
                        Text(undescribedOptionsMessage)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .background(T3Colors.background)
        }
    }

    private var selectedOption: DailyUXModelOption? {
        guard let pickerSelection,
              let provider = providers.first(where: { $0.id == pickerSelection.providerID }),
              let model = provider.models.first(where: { $0.id == pickerSelection.modelID }) else {
            return nil
        }
        return DailyUXModelOption(provider: provider, model: model)
    }

    private var undescribedSelections: [FeatureModelOptionSelection] {
        guard let selectedOption, let pickerSelection else { return [] }
        return DailyUXModelOptions.undescribedSelections(
            for: selectedOption.model,
            selections: pickerSelection.options
        )
    }

    private var undescribedOptionsMessage: String {
        let optionIDs = undescribedSelections.map(\.id).joined(separator: ", ")
        return "This environment does not describe these saved options: \(optionIDs). They will be kept when you apply."
    }

    @ViewBuilder
    private func modelOptionControl(
        _ descriptor: FeatureModelOptionDescriptor
    ) -> some View {
        switch descriptor.kind {
        case .select:
            HStack {
                Text("Reasoning effort")
                    .font(T3Typography.control)
                Spacer()
                if descriptor.choices.isEmpty {
                    Text("No choices available")
                        .foregroundStyle(T3Colors.textSecondary)
                        .accessibilityIdentifier("reasoning-effort-control")
                } else {
                    Menu {
                        if DailyUXModelOptions.defaultValue(for: descriptor) == nil {
                            Button {
                                updateDraftOption(id: descriptor.id, value: nil)
                            } label: {
                                if currentValue(for: descriptor) == nil {
                                    Label("Provider default", systemImage: "checkmark")
                                } else {
                                    Text("Provider default")
                                }
                            }
                        }
                        ForEach(descriptor.choices) { choice in
                            Button {
                                updateDraftOption(
                                    id: descriptor.id,
                                    value: .string(choice.id)
                                )
                            } label: {
                                if isSelected(choice, for: descriptor) {
                                    Label(choice.label, systemImage: "checkmark")
                                } else {
                                    Text(choice.label)
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Text(optionValueLabel(for: descriptor))
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 8, weight: .bold))
                        }
                        .foregroundStyle(T3Colors.textPrimary)
                    }
                    .accessibilityLabel("Reasoning effort")
                    .accessibilityValue(optionValueLabel(for: descriptor))
                    .accessibilityIdentifier("reasoning-effort-control")
                }
            }
            .frame(minHeight: T3Metrics.minimumTapTarget)
        case .boolean:
            BooleanModelOptionControl(
                title: "Reasoning effort",
                descriptor: descriptor,
                value: optionBinding(for: descriptor)
            )
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .accessibilityIdentifier("reasoning-effort-control")
        }
    }

    @ViewBuilder
    private func optionFooter(
        for descriptor: FeatureModelOptionDescriptor
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let detail = descriptor.detail {
                Text(detail)
            }
            if let value = currentValue(for: descriptor),
               !DailyUXModelOptions.isSupportedValue(value, for: descriptor) {
                Text("The saved value is not listed by this environment. Choose a listed value or keep the saved value.")
            } else if descriptor.kind == .select, descriptor.choices.isEmpty {
                Text("This environment did not provide choices for this option.")
            }
        }
    }

    private func optionValueLabel(
        for descriptor: FeatureModelOptionDescriptor
    ) -> String {
        switch currentValue(for: descriptor) {
        case let .string(value):
            return descriptor.choices.first(where: { $0.id == value })?.label ?? value
        case let .boolean(value):
            return value ? "On" : "Off"
        case nil:
            return "Provider default"
        }
    }

    private func currentValue(
        for descriptor: FeatureModelOptionDescriptor
    ) -> FeatureModelOptionValue? {
        DailyUXModelOptions.value(
            for: descriptor,
            in: pickerSelection?.options ?? []
        )
    }

    private func updateDraftOption(id: String, value: FeatureModelOptionValue?) {
        guard var next = pickerSelection else { return }
        next.options = DailyUXModelOptions.updating(next.options, id: id, value: value)
        draftSelection = next
        rememberDraft(next)
        hasEditedDraft = next != committedSelection
    }

    private func isSelected(
        _ choice: FeatureModelOptionChoice,
        for descriptor: FeatureModelOptionDescriptor
    ) -> Bool {
        currentValue(for: descriptor) == .string(choice.id)
    }

    private func optionBinding(
        for descriptor: FeatureModelOptionDescriptor
    ) -> Binding<FeatureModelOptionValue?> {
        Binding(
            get: { currentValue(for: descriptor) },
            set: { updateDraftOption(id: descriptor.id, value: $0) }
        )
    }

    private var favoriteIDs: Set<String> {
        Set(favoriteStorage.split(separator: "\n").map(String.init))
    }

    private var recentIDs: [String] {
        recentStorage.split(separator: "\n").map(String.init)
    }

    private var cachedCatalog: DailyUXModelCatalog {
        catalogCache.catalog(
            providers: pickerProviders,
            query: query,
            favoriteStorage: favoriteStorage,
            recentStorage: recentStorage
        )
    }

    private var pickerProviders: [FeatureProvider] {
        ThreadComposerModelSelectionPolicy.pickerProviders(
            providers,
            inherited: threadSelection,
            allowsProviderChange: materializesDefaultSelection
        )
    }

    private var displaySections: ProviderModelDisplaySections {
        ProviderModelDisplaySections(catalog: cachedCatalog)
    }

    private var committedSelection: FeatureSelection? {
        Self.effectiveSelection(
            explicit: selection,
            inherited: threadSelection,
            providers: providers,
            materializesDefaultSelection: materializesDefaultSelection
        )
    }

    private var pickerSelection: FeatureSelection? {
        draftSelection ?? committedSelection
    }

    private func select(_ option: DailyUXModelOption) {
        guard !isLocked(option) else { return }
        let next = ProviderModelDraftPolicy.selection(
            for: option,
            cached: modelDrafts[option.id],
            current: pickerSelection,
            committed: committedSelection
        )
        draftSelection = next
        rememberDraft(next)
        hasEditedDraft = next != committedSelection
    }

    private var hasDraftChanges: Bool {
        hasEditedDraft && draftSelection != nil && draftSelection != committedSelection
    }

    private func applySelection() {
        guard hasDraftChanges else { return }
        guard let validated = ProviderModelDraftPolicy.validated(
            draftSelection,
            providers: providers,
            inheriting: threadSelection,
            allowsProviderChange: materializesDefaultSelection
        ) else {
            replaceDraft(with: committedSelection)
            return
        }
        selection = validated
        recordRecent(DailyUXModelOption.key(
            providerID: validated.providerID,
            modelID: validated.modelID
        ))
        dismiss()
    }

    private func reconcileDraftSelectionWithCurrentState() {
        let committed = committedSelection
        guard hasEditedDraft else {
            replaceDraft(with: committed)
            return
        }
        guard ProviderModelDraftPolicy.canKeepEditedDraft(
            base: draftBaseSelection,
            currentCommitted: committed,
            draft: draftSelection,
            providers: providers,
            inheriting: threadSelection,
            allowsProviderChange: materializesDefaultSelection
        ) else {
            replaceDraft(with: committed)
            return
        }
    }

    private func replaceDraft(with value: FeatureSelection?) {
        draftSelection = value
        draftBaseSelection = value
        modelDrafts = value.map {
            [DailyUXModelOption.key(providerID: $0.providerID, modelID: $0.modelID): $0]
        } ?? [:]
        hasEditedDraft = false
    }

    private func rememberDraft(_ value: FeatureSelection) {
        modelDrafts[DailyUXModelOption.key(
            providerID: value.providerID,
            modelID: value.modelID
        )] = value
    }

    private func recordRecent(_ id: String) {
        recentStorage = ([id] + recentIDs.filter { $0 != id })
            .prefix(8)
            .joined(separator: "\n")
    }

    private func revealSelectedLegacyModel() {
        guard !legacyModelsExpanded, let pickerSelection else { return }
        if displaySections.legacy.contains(where: {
            $0.provider.id == pickerSelection.providerID
                && $0.model.id == pickerSelection.modelID
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
        guard let threadSelection else { return false }
        if option.provider.id != threadSelection.providerID { return true }
        return modelChangesAreLocked && option.model.id != threadSelection.modelID
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

    private static func effectiveSelection(
        explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider],
        materializesDefaultSelection: Bool
    ) -> FeatureSelection? {
        if materializesDefaultSelection {
            return ProviderModelSelectionResolver.materialized(explicit, in: providers)
        }
        return ThreadComposerModelSelectionPolicy.resolvedSelection(
            explicit: explicit,
            inherited: inherited,
            providers: providers
        )
    }
}

enum ProviderModelDraftPolicy {
    static func selection(
        for option: DailyUXModelOption,
        cached: FeatureSelection?,
        current: FeatureSelection?,
        committed: FeatureSelection?
    ) -> FeatureSelection {
        if let cached, matches(cached, option: option) {
            return ProviderModelConfiguration.selection(for: option, preserving: cached)
        }
        if let committed, matches(committed, option: option) {
            return ProviderModelConfiguration.selection(for: option, preserving: committed)
        }
        return ProviderModelConfiguration.selection(for: option, preserving: current)
    }

    static func validated(
        _ selection: FeatureSelection?,
        providers: [FeatureProvider],
        inheriting inherited: FeatureSelection?,
        allowsProviderChange: Bool
    ) -> FeatureSelection? {
        guard let selection,
              providers.contains(where: { provider in
                  provider.id == selection.providerID
                      && provider.isAvailable
                      && provider.models.contains { $0.id == selection.modelID }
              }) else {
            return nil
        }
        guard let validated = ProviderModelSelectionResolver.validated(selection, in: providers)
        else {
            return nil
        }
        if !allowsProviderChange {
            guard let inherited else { return nil }
            guard validated.providerID == inherited.providerID else { return nil }
            let inheritedProvider = providers.first { $0.id == inherited.providerID }
            if inheritedProvider?.requiresNewThreadForModelChange == true,
               validated.modelID != inherited.modelID {
                return nil
            }
        }
        return validated
    }

    static func canKeepEditedDraft(
        base: FeatureSelection?,
        currentCommitted: FeatureSelection?,
        draft: FeatureSelection?,
        providers: [FeatureProvider],
        inheriting inherited: FeatureSelection?,
        allowsProviderChange: Bool
    ) -> Bool {
        base == currentCommitted
            && validated(
                draft,
                providers: providers,
                inheriting: inherited,
                allowsProviderChange: allowsProviderChange
            ) != nil
    }

    private static func matches(
        _ selection: FeatureSelection,
        option: DailyUXModelOption
    ) -> Bool {
        selection.providerID == option.provider.id
            && selection.modelID == option.model.id
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
    static func pickerProviders(
        _ providers: [FeatureProvider],
        inherited: FeatureSelection?,
        allowsProviderChange: Bool
    ) -> [FeatureProvider] {
        if allowsProviderChange { return providers }
        guard let inherited else { return [] }
        return providers.filter { $0.id == inherited.providerID }
    }

    static func resolvedSelection(
        explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        explicitSelection(explicit, inherited: inherited, providers: providers)
            ?? preservedSelection(inherited, providers: providers)
    }

    static func explicitSelection(
        _ explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard let explicit, let inherited else { return nil }
        guard explicit.providerID == inherited.providerID else { return nil }
        let inheritedProvider = providers.first { $0.id == inherited.providerID }
        if inheritedProvider?.requiresNewThreadForModelChange == true,
           explicit.modelID != inherited.modelID {
            return nil
        }

        // An environment refresh can briefly remove a provider or a custom
        // model from discovery. Keep an existing override until discovery can
        // validate it again. Applying a new choice still uses the stricter
        // ProviderModelDraftPolicy validation path.
        return ProviderModelSelectionResolver.validated(explicit, in: providers)
            ?? explicit
    }

    private static func preservedSelection(
        _ selection: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard var selection else { return nil }
        guard let model = providers
            .first(where: { $0.id == selection.providerID })?
            .models.first(where: { $0.id == selection.modelID }) else {
            return selection
        }
        selection.options = ProviderModelConfiguration.materializedOptions(
            for: model,
            preserving: selection.options
        )
        return selection
    }
}

/// Existing threads use their saved environment and provider instance as the
/// catalog identity. Project rows and provider discovery can be temporarily
/// absent, but neither should make the thread's saved model disappear.
enum ThreadComposerProviderCatalog {
    static func providers(
        for thread: FeatureThread,
        in snapshot: FeatureSnapshot
    ) -> [FeatureProvider] {
        let environmentID = thread.environmentID
            ?? snapshot.projects.first(where: { $0.id == thread.projectID })?.environmentID
        var providers = environmentID.flatMap {
            snapshot.providersByEnvironment?[$0]
        } ?? []

        guard let providerID = thread.providerID,
              let modelID = thread.modelID else {
            return providers
        }

        // A missing catalog entry has unknown image support, not a known restriction.
        var savedModel = FeatureModel(id: modelID, name: modelID)
        savedModel.imageSupportIsUnknown = true
        if let providerIndex = providers.firstIndex(where: { $0.id == providerID }) {
            guard !providers[providerIndex].models.contains(where: { $0.id == modelID }) else {
                return providers
            }
            providers[providerIndex].models.append(savedModel)
            return providers
        }

        let providerName = thread.providerName?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedProviderName = providerName.flatMap { name in
            name.isEmpty ? nil : name
        } ?? providerID
        providers.append(FeatureProvider(
            id: providerID,
            name: resolvedProviderName,
            isAvailable: false,
            models: [savedModel]
        ))
        return providers
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
        if model.id == "antigravity-default" { return true }
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

private struct BooleanModelOptionControl: View {
    let title: String
    let descriptor: FeatureModelOptionDescriptor
    @Binding var value: FeatureModelOptionValue?

    var body: some View {
        if DailyUXModelOptions.defaultValue(for: descriptor) != nil {
            Toggle(title, isOn: Binding(
                get: { value == .boolean(true) },
                set: { value = .boolean($0) }
            ))
        } else {
            Picker(title, selection: $value) {
                Text("Provider default").tag(Optional<FeatureModelOptionValue>.none)
                Text("On").tag(Optional(FeatureModelOptionValue.boolean(true)))
                Text("Off").tag(Optional(FeatureModelOptionValue.boolean(false)))
                if case let .string(savedValue) = value {
                    Text(savedValue).tag(Optional(FeatureModelOptionValue.string(savedValue)))
                }
            }
            .pickerStyle(.menu)
            .tint(T3Colors.textPrimary)
        }
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
        _optionSelections = State(initialValue: ProviderModelConfiguration.selection(
            for: option,
            preserving: currentSelection
        ).options)
    }

    var body: some View {
        Form {
            Section {
                ModelOptionLabel(option: option, isSelected: false)
            }

            ForEach(DailyUXModelOptions.advancedDescriptors(for: option.model)) { descriptor in
                Section {
                    switch descriptor.kind {
                    case .select:
                        HStack {
                            Text(descriptor.label)
                            Spacer()
                            if descriptor.choices.isEmpty {
                                Text("No choices available")
                                    .foregroundStyle(T3Colors.textSecondary)
                            } else {
                                Menu {
                                    if DailyUXModelOptions.defaultValue(for: descriptor) == nil {
                                        Button {
                                            optionSelections = DailyUXModelOptions.updating(
                                                optionSelections,
                                                id: descriptor.id,
                                                value: nil
                                            )
                                        } label: {
                                            if DailyUXModelOptions.value(
                                                for: descriptor,
                                                in: optionSelections
                                            ) == nil {
                                                Label("Provider default", systemImage: "checkmark")
                                            } else {
                                                Text("Provider default")
                                            }
                                        }
                                    }
                                    ForEach(descriptor.choices) { choice in
                                        Button {
                                            optionSelections = DailyUXModelOptions.updating(
                                                optionSelections,
                                                id: descriptor.id,
                                                value: .string(choice.id)
                                            )
                                        } label: {
                                            if isSelected(choice, for: descriptor) {
                                                Label(choice.label, systemImage: "checkmark")
                                            } else {
                                                Text(choice.label)
                                            }
                                        }
                                    }
                                } label: {
                                    HStack(spacing: 5) {
                                        Text(optionValueLabel(for: descriptor))
                                        Image(systemName: "chevron.up.chevron.down")
                                            .font(.system(size: 8, weight: .bold))
                                    }
                                    .foregroundStyle(T3Colors.textPrimary)
                                }
                            }
                        }
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                        .accessibilityIdentifier("advanced-option-\(descriptor.id)")
                        .accessibilityValue(optionValueLabel(for: descriptor))
                    case .boolean:
                        BooleanModelOptionControl(
                            title: descriptor.label,
                            descriptor: descriptor,
                            value: optionBinding(for: descriptor)
                        )
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                        .accessibilityIdentifier("advanced-option-\(descriptor.id)")
                    }
                } footer: {
                    optionFooter(for: descriptor)
                }
            }

            if !undescribedSelections.isEmpty {
                Section("Saved options") {
                    Text(undescribedOptionsMessage)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Model options")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save options") {
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

    private var undescribedSelections: [FeatureModelOptionSelection] {
        DailyUXModelOptions.undescribedSelections(
            for: option.model,
            selections: optionSelections
        )
    }

    private var undescribedOptionsMessage: String {
        let optionIDs = undescribedSelections.map(\.id).joined(separator: ", ")
        return "This environment does not describe these saved options: \(optionIDs). T3 Code will keep them."
    }

    private func optionValueLabel(
        for descriptor: FeatureModelOptionDescriptor
    ) -> String {
        switch DailyUXModelOptions.value(
            for: descriptor,
            in: optionSelections
        ) {
        case let .string(value):
            return descriptor.choices.first(where: { $0.id == value })?.label ?? value
        case let .boolean(value):
            return value ? "On" : "Off"
        case nil:
            return "Provider default"
        }
    }

    private func isSelected(
        _ choice: FeatureModelOptionChoice,
        for descriptor: FeatureModelOptionDescriptor
    ) -> Bool {
        DailyUXModelOptions.value(
            for: descriptor,
            in: optionSelections
        ) == .string(choice.id)
    }

    @ViewBuilder
    private func optionFooter(
        for descriptor: FeatureModelOptionDescriptor
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let detail = descriptor.detail {
                Text(detail)
            }
            if let value = DailyUXModelOptions.value(
                for: descriptor,
                in: optionSelections
            ), !DailyUXModelOptions.isSupportedValue(value, for: descriptor) {
                Text("The saved value is not listed by this environment. Choose a listed value or keep the saved value.")
            } else if descriptor.kind == .select, descriptor.choices.isEmpty {
                Text("This environment did not provide choices for this option.")
            }
        }
    }

    private func optionBinding(
        for descriptor: FeatureModelOptionDescriptor
    ) -> Binding<FeatureModelOptionValue?> {
        Binding(
            get: {
                DailyUXModelOptions.value(
                    for: descriptor,
                    in: optionSelections
                )
            },
            set: { value in
                optionSelections = DailyUXModelOptions.updating(
                    optionSelections,
                    id: descriptor.id,
                    value: value
                )
            }
        )
    }
}

enum ProviderModelConfiguration {
    static func selection(
        for option: DailyUXModelOption,
        preserving currentSelection: FeatureSelection?
    ) -> FeatureSelection {
        let selections: [FeatureModelOptionSelection]
        if currentSelection?.providerID == option.provider.id,
           currentSelection?.modelID == option.model.id {
            selections = materializedOptions(
                for: option.model,
                preserving: currentSelection?.options ?? []
            )
        } else {
            selections = DailyUXModelOptions.defaults(for: option.model)
        }
        return FeatureSelection(
            providerID: option.provider.id,
            modelID: option.model.id,
            options: selections
        )
    }

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
