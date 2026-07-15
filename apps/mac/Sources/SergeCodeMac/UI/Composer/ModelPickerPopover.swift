import SwiftUI

/// Compact model-picker segment backed by a branded, searchable model browser.
struct ModelPickerMenu: View {
    let thread: ChatThread
    let model: AppModel

    @UIState private var isPresented = false
    @UIState private var isHovering = false

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "cpu")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
                Text(currentModelName)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 7, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, AlpineControls.segmentHorizontalPadding)
            .padding(.vertical, AlpineControls.segmentVerticalPadding)
            .contentShape(Rectangle())
            .background {
                if isHovering || isPresented {
                    RoundedRectangle(cornerRadius: AlpineTheme.Corners.compact, style: .continuous)
                        .fill(
                            isPresented
                                ? AlpineTheme.accent.opacity(0.14)
                                : Color.primary.opacity(0.08)
                        )
                }
            }
        }
        .buttonStyle(.plain)
        .fixedSize()
        .disabled(model.models.isEmpty)
        .help("Choose model")
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isPresented)
        // UIProbe (DEBUG runs) opens the popover through the section-toggle
        // hook — same-process AX can't press SwiftUI buttons.
        .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
            if note.object as? String == "model-picker" {
                DispatchQueue.main.async { isPresented.toggle() }
            }
        }
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            ModelPickerPopoverContent(
                thread: thread,
                model: model,
                isPresented: $isPresented
            )
        }
    }

    private var currentModelName: String {
        if let current = model.models.first(where: isCurrent(_:)) {
            return current.displayName
        }
        return thread.modelID ?? thread.provider.displayName
    }

    private func isCurrent(_ option: ModelOption) -> Bool {
        option.instanceID == thread.modelInstanceID && option.modelID == thread.modelID
    }
}

private struct ModelPickerPopoverContent: View {
    let thread: ChatThread
    let model: AppModel
    @Binding var isPresented: Bool

    @UIState private var searchText = ""
    @UIState private var providerFilter: ModelPickerProviderFilter = .all
    @FocusState private var searchFocused: Bool

    private var allItems: [ModelPickerItem] {
        ModelPickerCatalog.items(
            from: model.models,
            selectedInstanceID: thread.modelInstanceID,
            selectedModelID: thread.modelID
        )
    }

    private var availableProviders: [ProviderKind] {
        ProviderKind.allCases.filter { provider in
            allItems.contains { $0.option.provider == provider }
        }
    }

    private var visibleItems: [ModelPickerItem] {
        ModelPickerCatalog.filteredItems(
            allItems,
            providerFilter: providerFilter,
            query: searchText
        )
    }

    private var groupedVisibleItems: [(provider: ProviderKind, items: [ModelPickerItem])] {
        availableProviders.compactMap { provider in
            let items = visibleItems.filter { $0.option.provider == provider }
            return items.isEmpty ? nil : (provider, items)
        }
    }

    private var selectedOptionID: String? {
        model.models.first {
            $0.instanceID == thread.modelInstanceID && $0.modelID == thread.modelID
        }?.id
    }

    var body: some View {
        ComposerPickerSurface(width: 610, height: 470) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "cpu",
                    title: "Choose a model",
                    subtitle: "\(allItems.count) models across \(availableProviders.count) providers"
                )
                searchField
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
                Divider().opacity(0.55)
                HStack(spacing: 0) {
                    providerSidebar
                    Divider().opacity(0.55)
                    modelBrowser
                }
            }
        }
        .onAppear { searchFocused = true }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            TextField("Search by model or provider", text: $searchText)
                .textFieldStyle(.plain)
                .focused($searchFocused)
                .onSubmit { selectFirstVisibleMatch() }
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                    searchFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Clear search")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 34)
        .background(.fill.quaternary, in: RoundedRectangle(
            cornerRadius: AlpineTheme.Corners.control,
            style: .continuous
        ))
        .overlay {
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                .stroke(
                    searchFocused
                        ? AlpineTheme.accent.opacity(0.75)
                        : Color.primary.opacity(0.12)
                )
        }
    }

    private var providerSidebar: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Providers")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 9)
                .padding(.bottom, 4)

            ProviderFilterRow(
                icon: "square.grid.2x2",
                title: "All models",
                count: allItems.count,
                isSelected: providerFilter == .all
            ) {
                providerFilter = .all
            }

            ForEach(availableProviders) { provider in
                ProviderFilterRow(
                    icon: provider.modelPickerSymbolName,
                    title: provider.displayName,
                    count: allItems.count { $0.option.provider == provider },
                    isSelected: providerFilter == .provider(provider)
                ) {
                    providerFilter = .provider(provider)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(width: 184, alignment: .topLeading)
        .background(Color.primary.opacity(0.025))
    }

    private var modelBrowser: some View {
        VStack(spacing: 0) {
            HStack {
                Text(browserTitle)
                    .font(.callout.weight(.semibold))
                Spacer()
                Text("\(visibleItems.count) \(visibleItems.count == 1 ? "model" : "models")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .padding(.horizontal, 14)
            .frame(height: 40)

            Divider().opacity(0.45)

            if visibleItems.isEmpty {
                emptyState
            } else {
                modelList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var browserTitle: String {
        switch providerFilter {
        case .all: "All models"
        case .provider(let provider): provider.displayName
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(.tertiary)
            Text("No models found")
                .font(.callout.weight(.medium))
            Text("Try another search or provider.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var modelList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3, pinnedViews: [.sectionHeaders]) {
                    ForEach(groupedVisibleItems, id: \.provider) { group in
                        Section {
                            ForEach(group.items) { item in
                                ModelPickerRow(
                                    item: item,
                                    isSelected: item.option.id == selectedOptionID
                                ) {
                                    Task { await model.setModel(item.option) }
                                    isPresented = false
                                }
                                .id(item.option.id)
                            }
                        } header: {
                            if providerFilter == .all {
                                providerHeader(group.provider)
                            }
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            }
            .onAppear { scrollToSelection(proxy: proxy) }
        }
    }

    private func providerHeader(_ provider: ProviderKind) -> some View {
        HStack(spacing: 6) {
            Image(systemName: provider.modelPickerSymbolName)
            Text(provider.displayName)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 7)
        .padding(.top, 9)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.ultraThinMaterial)
    }

    private func scrollToSelection(proxy: ScrollViewProxy) {
        guard let selectedOptionID else { return }
        DispatchQueue.main.async {
            withAnimation(nil) {
                proxy.scrollTo(selectedOptionID, anchor: .center)
            }
        }
    }

    private func selectFirstVisibleMatch() {
        guard let first = visibleItems.first else { return }
        Task { await model.setModel(first.option) }
        isPresented = false
    }
}

private struct ProviderFilterRow: View {
    let icon: String
    let title: String
    let count: Int
    let isSelected: Bool
    let action: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(isSelected ? AlpineTheme.forest : Color.secondary)
                    .frame(width: 22, height: 22)
                    .background(
                        isSelected ? AlpineTheme.accent.opacity(0.85) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                    )
                Text(title)
                    .font(.caption.weight(isSelected ? .semibold : .medium))
                    .lineLimit(1)
                Spacer(minLength: 3)
                Text("\(count)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
            .padding(.horizontal, 7)
            .frame(height: 32)
            .contentShape(Rectangle())
            .background {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(isSelected ? AlpineTheme.accent.opacity(0.15) : Color.primary.opacity(isHovering ? 0.06 : 0))
            }
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
    }
}

private struct ModelPickerRow: View {
    let item: ModelPickerItem
    let isSelected: Bool
    let onSelect: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                Image(systemName: item.option.provider.modelPickerSymbolName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(isSelected ? AlpineTheme.forest : Color.secondary)
                    .frame(width: 32, height: 32)
                    .background(
                        isSelected ? AlpineTheme.accent.opacity(0.9) : Color.secondary.opacity(0.09),
                        in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.option.displayName)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Text(item.option.modelID)
                        if item.matchingInstanceCount > 1 {
                            Text("·")
                            Text("\(item.matchingInstanceCount) connections merged")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }

                Spacer(minLength: 8)

                if let capability = capabilityLabel {
                    Text(capability)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 5))
                }

                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(AlpineTheme.forest)
                    .frame(width: 22, height: 22)
                    .background(AlpineTheme.accent, in: Circle())
                    .opacity(isSelected ? 1 : 0)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .background {
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                    .fill(rowBackground)
            }
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
    }

    private var capabilityLabel: String? {
        if !item.option.effortChoices.isEmpty && !item.option.serviceTierChoices.isEmpty {
            return "Tunable"
        }
        if !item.option.effortChoices.isEmpty { return "Reasoning" }
        if !item.option.serviceTierChoices.isEmpty { return "Tiers" }
        return item.option.isDefault ? "Default" : nil
    }

    private var rowBackground: Color {
        if isHovering { return Color.primary.opacity(0.075) }
        if isSelected { return AlpineTheme.accent.opacity(0.14) }
        return .clear
    }
}

extension ProviderKind {
    var modelPickerSymbolName: String {
        switch self {
        case .claude: "sparkles"
        case .claudeWork: "briefcase.fill"
        case .claudex: "arrow.triangle.branch"
        case .claudeSynthero: "link"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .grok: "bolt"
        case .fugu: "fish"
        case .opencode: "curlybraces"
        case .legacyCursor: "exclamationmark.triangle"
        }
    }
}
