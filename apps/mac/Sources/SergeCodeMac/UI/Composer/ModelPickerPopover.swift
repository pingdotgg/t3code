import AppKit
import SwiftUI

/// Compact model-picker segment backed by a branded, searchable model browser.
struct ModelPickerMenu: View {
    let thread: ChatThread
    let model: AppModel

    @UIState private var isPresented = false
    @UIState private var isHovering = false

    private var preferences: ModelPickerPreferences { .shared }

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            HStack(spacing: 6) {
                ProviderIcon(provider: thread.provider, modelID: thread.modelID, size: 14)
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
        .animation(Motion.feedback, value: isHovering)
        // Right-click switches to a starred or recent model without opening
        // the browser at all — the common case is re-picking a model you
        // already use, not discovering a new one.
        .contextMenu { quickSwitchMenu }
        // UIProbe (DEBUG runs) opens the popover through the section-toggle
        // hook — same-process AX can't press SwiftUI buttons.
        .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
            if note.object as? String == "model-picker" {
                DispatchQueue.main.async { isPresented.toggle() }
            }
        }
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            ModelPickerPopoverContent(
                models: model.models,
                selectedInstanceID: thread.modelInstanceID,
                selectedModelID: thread.modelID,
                onSelect: { option in
                    Task { await model.setModel(option) }
                    isPresented = false
                }
            )
        }
    }

    @ViewBuilder
    private var quickSwitchMenu: some View {
        let items = ModelPickerCatalog.items(
            from: model.models,
            selectedInstanceID: thread.modelInstanceID,
            selectedModelID: thread.modelID
        )
        let favorites = ModelPickerCatalog.favoriteItems(items, favorites: preferences.favorites)
        let recents = ModelPickerCatalog.recentItems(items, recents: preferences.recents)
            .filter { !preferences.favorites.contains($0.id) }
            .prefix(5)

        if favorites.isEmpty && recents.isEmpty {
            Text("Star models in the picker for quick switching")
        }
        if !favorites.isEmpty {
            Section("Favorites") {
                ForEach(favorites) { item in
                    quickSwitchButton(item)
                }
            }
        }
        if !recents.isEmpty {
            Section("Recent") {
                ForEach(recents) { item in
                    quickSwitchButton(item)
                }
            }
        }
    }

    private func quickSwitchButton(_ item: ModelPickerItem) -> some View {
        Button {
            // Recency is recorded by `setModel` once the switch lands.
            Task { await model.setModel(item.option) }
        } label: {
            Label(item.option.displayName, systemImage: isCurrent(item.option) ? "checkmark" : "cpu")
        }
        .disabled(isCurrent(item.option))
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

/// The model browser's one chord, kept separate from the view so its modifier
/// rules are testable.
enum ModelPickerShortcut {
    /// `KeyEquivalent` is `ExpressibleByExtendedGraphemeClusterLiteral`, so a
    /// plain character literal is the same value as `.upArrow` and friends.
    static let favoriteKey: KeyEquivalent = "d"

    /// True only for ⌘D. Caps Lock and the numeric-pad flag ride along on real
    /// key events without changing intent — the same subtraction ComposerBar
    /// applies to Return — but any other modifier is a different chord.
    static func isFavoriteToggle(modifiers: EventModifiers) -> Bool {
        modifiers.subtracting([.capsLock, .numericPad]) == .command
    }
}

/// Optional leading "clear" row for pickers that allow selecting none.
struct ModelPickerClearRowConfig {
    let icon: String
    let title: String
    let detail: String
    let action: () -> Void

    init(
        icon: String = "slash.circle",
        title: String,
        detail: String,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.title = title
        self.detail = detail
        self.action = action
    }
}

/// Searchable, height-capped model browser shared by the thread model picker
/// and the Advisor/Planner executor picker.
struct ModelPickerPopoverContent: View {
    let models: [ModelOption]
    let selectedInstanceID: String?
    let selectedModelID: String?
    let onSelect: (ModelOption) -> Void
    var title: String = "Choose a model"
    var subtitle: String? = nil
    var clearRow: ModelPickerClearRowConfig? = nil
    var onBack: (() -> Void)? = nil

    private static let clearRowKey = "model-picker-clear"

    @UIState private var searchText = ""
    @UIState private var scope: ModelPickerScope = .all
    @UIState private var highlightedKey: String?
    @UIState private var scrollProxy: ScrollViewProxy?
    @FocusState private var searchFocused: Bool

    private var preferences: ModelPickerPreferences { .shared }

    private var allItems: [ModelPickerItem] {
        ModelPickerCatalog.items(
            from: models,
            selectedInstanceID: selectedInstanceID,
            selectedModelID: selectedModelID
        )
    }

    private var availableProviders: [ProviderKind] {
        ProviderKind.allCases.filter { provider in
            allItems.contains { $0.option.provider == provider }
        }
    }

    private var favoriteItems: [ModelPickerItem] {
        ModelPickerCatalog.favoriteItems(allItems, favorites: preferences.favorites)
    }

    private var recentItems: [ModelPickerItem] {
        ModelPickerCatalog.recentItems(allItems, recents: preferences.recents)
    }

    private var results: ModelPickerSearchResults {
        ModelPickerCatalog.searchResults(
            allItems,
            scope: scope,
            query: searchText,
            favorites: preferences.favorites,
            recents: preferences.recents
        )
    }

    private var visibleItems: [ModelPickerItem] { results.items }

    private var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The clear row is a standing choice, not a search result, so a query
    /// hides it. Leaving it in would put "None" above every ranked match and
    /// hand Return to it.
    private var showsClearRow: Bool { clearRow != nil && !isSearching }

    /// Sections in display order. While searching, ranking beats grouping, so
    /// the results arrive as one flat list.
    private var sections: [ModelPickerSection] {
        let items = visibleItems
        guard !isSearching else {
            return [ModelPickerSection(id: "results", title: nil, icon: nil, items: items)]
        }

        switch scope {
        case .favorites, .recents, .provider:
            return [ModelPickerSection(id: "scope", title: nil, icon: nil, items: items)]
        case .all:
            let favorites = items.filter { preferences.favorites.contains($0.id) }
            var grouped: [ModelPickerSection] = []
            if !favorites.isEmpty {
                grouped.append(
                    ModelPickerSection(
                        id: "favorites", title: "Favorites", icon: "star.fill", items: favorites))
            }
            // Favorites are lifted out of their provider group rather than
            // repeated, so the row count in the header still matches the rows.
            let rest = items.filter { !preferences.favorites.contains($0.id) }
            for provider in availableProviders {
                let group = rest.filter { $0.option.provider == provider }
                guard !group.isEmpty else { continue }
                grouped.append(
                    ModelPickerSection(
                        id: provider.rawValue, title: provider.displayName, provider: provider,
                        items: group))
            }
            return grouped
        }
    }

    /// Every row the keyboard can land on, in display order.
    private var navigableKeys: [String] {
        var keys = showsClearRow ? [Self.clearRowKey] : []
        keys.append(contentsOf: sections.flatMap { $0.items.map(\.id) })
        return keys
    }


    /// Where the keyboard starts when the popover opens. The current model
    /// when it is on offer — but a thread can run a model the connected
    /// providers no longer advertise, and leaving the highlight nil there made
    /// ⌘D and Return do nothing until the user pressed an arrow key first.
    private var initialHighlightKey: String? {
        if isClearSelected { return Self.clearRowKey }
        let keys = navigableKeys
        if let selectedItemKey, keys.contains(selectedItemKey) { return selectedItemKey }
        return ModelPickerCatalog.firstModelRowKey(in: keys, clearRowKey: Self.clearRowKey)
    }

    /// Rows collapse the instances advertising one model, so the checkmark,
    /// the opening highlight, and the scroll target are all this row key —
    /// resolved by row identity, which survives a reconnect renaming the
    /// instance the thread's stored selection points at.
    private var selectedItemKey: String? {
        ModelPickerCatalog.selectedRowKey(
            in: models, instanceID: selectedInstanceID, modelID: selectedModelID)
    }

    private var isClearSelected: Bool {
        clearRow != nil && selectedInstanceID == nil && selectedModelID == nil
    }

    private var resolvedSubtitle: String {
        subtitle ?? "\(allItems.count) models across \(availableProviders.count) providers"
    }

    var body: some View {
        ComposerPickerSurface(width: 610, height: 500) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "cpu",
                    title: title,
                    subtitle: resolvedSubtitle,
                    onBack: onBack
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
                Divider().opacity(0.55)
                shortcutLegend
            }
        }
        .task {
            // Do not install AppKit's remote completion view while SwiftUI is
            // still ordering the containing NSPopover window. On macOS 27
            // that race raises NSInternalInconsistencyException from
            // NSRemoteView and terminates the app. The view-bound task is
            // cancelled if the popover closes before it becomes stable.
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            searchFocused = true
            highlightedKey = initialHighlightKey
        }
        .onChange(of: searchText) { _, _ in resetHighlightToFirstRow() }
        .onChange(of: scope) { _, _ in resetHighlightToFirstRow() }
    }

    /// Names the scope being searched, since a query is scoped first. It still
    /// widens to the whole catalog when the scope has no match, and the
    /// browser says so when that happens.
    private var searchPlaceholder: String {
        switch scope {
        case .all: "Search by model or provider"
        case .favorites: "Search favorites"
        case .recents: "Search recently used"
        case .provider(let provider): "Search \(provider.displayName) models"
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            TextField(searchPlaceholder, text: $searchText)
                .textFieldStyle(.plain)
                // Search terms do not benefit from spelling completions, and
                // disabling them keeps SafariPlatformSupport's remote
                // completion view out of this transient popover entirely.
                .autocorrectionDisabled()
                .focused($searchFocused)
                .onSubmit { activateHighlightedRow() }
                // Arrow keys walk the list while the caret stays in the field,
                // so search-then-pick never needs the mouse.
                .onKeyPress(keys: [.upArrow, .downArrow]) { press in
                    moveHighlight(by: press.key == .downArrow ? 1 : -1)
                    return .handled
                }
                // ⌘D stars the highlighted model, matching the star button.
                // Plain "d" must keep reaching the field, and ⌥⌘D / ⇧⌘D are
                // different chords the picker does not own.
                .onKeyPress(keys: [ModelPickerShortcut.favoriteKey]) { press in
                    guard ModelPickerShortcut.isFavoriteToggle(modifiers: press.modifiers) else {
                        return .ignored
                    }
                    toggleFavoriteOnHighlightedRow()
                    return .handled
                }
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
        .animation(Motion.feedback, value: searchFocused)
    }

    private var providerSidebar: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Browse")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 9)
                .padding(.bottom, 4)

            ProviderFilterRow(
                icon: "square.grid.2x2",
                title: "All models",
                count: allItems.count,
                isSelected: scope == .all
            ) {
                select(scope: .all)
            }

            ProviderFilterRow(
                icon: "star.fill",
                title: "Favorites",
                count: favoriteItems.count,
                isSelected: scope == .favorites
            ) {
                select(scope: .favorites)
            }

            if !recentItems.isEmpty {
                ProviderFilterRow(
                    icon: "clock",
                    title: "Recent",
                    count: recentItems.count,
                    isSelected: scope == .recents
                ) {
                    select(scope: .recents)
                }
            }

            Text("Providers")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 9)
                .padding(.top, 10)
                .padding(.bottom, 4)

            ForEach(availableProviders) { provider in
                ProviderFilterRow(
                    provider: provider,
                    title: provider.displayName,
                    count: allItems.count { $0.option.provider == provider },
                    isSelected: scope == .provider(provider)
                ) {
                    select(scope: .provider(provider))
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
                if scope == .recents && !recentItems.isEmpty {
                    Button("Clear") {
                        preferences.clearRecents()
                        scope = .all
                    }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help("Forget recently used models")
                }
                Text("\(visibleItems.count) \(visibleItems.count == 1 ? "model" : "models")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .padding(.horizontal, 14)
            .frame(height: 40)

            Divider().opacity(0.45)

            if results.didWidenToAllModels {
                widenedSearchNotice
                Divider().opacity(0.45)
            }

            if visibleItems.isEmpty && !showsClearRow {
                emptyState
            } else {
                modelList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(Motion.reveal, value: scope)
        .animation(Motion.reveal, value: results.didWidenToAllModels)
    }

    /// Shown when the query found nothing in the current scope and the whole
    /// catalog answered instead — otherwise the widened rows would silently
    /// contradict the selected sidebar scope.
    private var widenedSearchNotice: some View {
        HStack(spacing: 7) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            Text("No matches in \(browserTitle) — searching all models")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button("Browse all") { select(scope: .all) }
                .buttonStyle(.plain)
                .font(.caption.weight(.medium))
                .foregroundStyle(AlpineTheme.forest)
                .help("Leave this scope and keep browsing every model")
        }
        .padding(.horizontal, 14)
        .frame(height: 30)
        .background(AlpineTheme.accent.opacity(0.12))
    }

    private var browserTitle: String {
        switch scope {
        case .all: "All models"
        case .favorites: "Favorites"
        case .recents: "Recently used"
        case .provider(let provider): provider.displayName
        }
    }

    private var shortcutLegend: some View {
        HStack(spacing: 12) {
            legendItem("↑↓", "Navigate")
            legendItem("↩", "Select")
            legendItem("⌘D", "Favorite")
            Spacer(minLength: 0)
            if let highlighted = highlightedItem {
                Text(highlighted.option.modelID)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 30)
    }

    private func legendItem(_ keys: String, _ label: String) -> some View {
        HStack(spacing: 4) {
            Text(keys)
                .font(.caption2.weight(.semibold))
                .monospaced()
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 4))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(keys)")
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: emptyStateIcon)
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(.tertiary)
            Text(emptyStateTitle)
                .font(.callout.weight(.medium))
            Text(emptyStateDetail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if scope != .all {
                Button("Browse all models") {
                    select(scope: .all)
                    searchFocused = true
                }
                .buttonStyle(.plain)
                .font(.caption.weight(.medium))
                .foregroundStyle(AlpineTheme.forest)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    AlpineTheme.accent.opacity(0.85),
                    in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyStateIcon: String {
        if !searchText.isEmpty { return "magnifyingglass" }
        switch scope {
        case .favorites: return "star"
        case .recents: return "clock"
        default: return "magnifyingglass"
        }
    }

    private var emptyStateTitle: String {
        if !searchText.isEmpty { return "No models found" }
        switch scope {
        case .favorites: return "No favorites yet"
        case .recents: return "Nothing used yet"
        default: return "No models found"
        }
    }

    private var emptyStateDetail: String {
        // A scoped search widens to the whole catalog before it can come up
        // empty, so an empty list with a query means no model anywhere matches.
        if !searchText.isEmpty { return "No model in any provider matches that search." }
        switch scope {
        case .favorites: return "Star a model with ⌘D or its star button to keep it here."
        case .recents: return "Models you pick show up here in the order you used them."
        default: return "Try another search or provider."
        }
    }

    private var modelList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3, pinnedViews: [.sectionHeaders]) {
                    if let clearRow, showsClearRow {
                        ComposerPickerChoiceRow(
                            icon: clearRow.icon,
                            title: clearRow.title,
                            detail: clearRow.detail,
                            isSelected: isClearSelected,
                            action: clearRow.action
                        )
                        .id(Self.clearRowKey)
                    }
                    ForEach(sections) { section in
                        Section {
                            ForEach(section.items) { item in
                                ModelPickerRow(
                                    item: item,
                                    isSelected: item.id == selectedItemKey,
                                    isHighlighted: highlightedKey == item.id,
                                    isFavorite: preferences.isFavorite(item.id),
                                    onHover: { hovering in
                                        if hovering { highlightedKey = item.id }
                                    },
                                    onToggleFavorite: { toggleFavorite(item) },
                                    onSelect: { select(item) }
                                )
                                .id(item.id)
                            }
                        } header: {
                            if let title = section.title {
                                sectionHeader(title: title, section: section)
                            }
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            }
            .onAppear {
                scrollProxy = proxy
                scrollToSelection(proxy: proxy)
            }
        }
    }

    private func sectionHeader(title: String, section: ModelPickerSection) -> some View {
        HStack(spacing: 6) {
            if let provider = section.provider {
                ProviderIcon(provider: provider, size: 12)
            } else if let icon = section.icon {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
            }
            Text(title)
        }
        .foregroundStyle(.secondary)
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.top, 9)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.ultraThinMaterial)
    }

    // MARK: - Actions

    private var highlightedItem: ModelPickerItem? {
        guard let highlightedKey else { return nil }
        return sections.lazy.flatMap(\.items).first { $0.id == highlightedKey }
    }

    private func select(scope newScope: ModelPickerScope) {
        withAnimation(Motion.reveal) { scope = newScope }
    }

    private func select(_ item: ModelPickerItem) {
        // Recency belongs to whoever performs the switch: `AppModel` records
        // it only after the backend accepts, so a rejected or cancelled change
        // never promotes a model the thread never ran.
        onSelect(item.option)
    }

    private func toggleFavorite(_ item: ModelPickerItem) {
        Haptics.play(.toggle)
        let keysBefore = navigableKeys
        preferences.toggleFavorite(item.id)
        // Unfavoriting inside the Favorites scope drops the row out from under
        // the keyboard. Without this the highlight points at a row that is no
        // longer rendered, and arrows and Return do nothing until the pointer
        // rescues them.
        guard let staleKey = highlightedKey else { return }
        let keysAfter = navigableKeys
        guard !keysAfter.contains(staleKey) else { return }
        highlightedKey = ModelPickerCatalog.highlightAfterRemoval(
            previousKeys: keysBefore, removedKey: staleKey, remainingKeys: keysAfter)
        if let scrollProxy, let highlightedKey {
            withAnimation(nil) { scrollProxy.scrollTo(highlightedKey, anchor: .center) }
        }
    }

    private func toggleFavoriteOnHighlightedRow() {
        guard let highlightedItem else { return }
        toggleFavorite(highlightedItem)
    }

    private func activateHighlightedRow() {
        if highlightedKey == Self.clearRowKey, let clearRow {
            clearRow.action()
            return
        }
        if let highlightedItem {
            select(highlightedItem)
            return
        }
        // Enter with nothing highlighted takes the best-ranked match, which is
        // what a plain type-then-Enter expects.
        guard let first = visibleItems.first else { return }
        select(first)
    }

    private func moveHighlight(by offset: Int) {
        let keys = navigableKeys
        guard !keys.isEmpty else { return }
        let currentIndex = highlightedKey.flatMap { keys.firstIndex(of: $0) }
        let nextIndex: Int
        if let currentIndex {
            nextIndex = (currentIndex + offset + keys.count) % keys.count
        } else {
            nextIndex = offset >= 0 ? 0 : keys.count - 1
        }
        highlightedKey = keys[nextIndex]
        Haptics.play(.selection)
        if let scrollProxy, let highlightedKey {
            withAnimation(Motion.feedback) {
                scrollProxy.scrollTo(highlightedKey, anchor: .center)
            }
        }
    }

    private func resetHighlightToFirstRow() {
        highlightedKey = ModelPickerCatalog.firstModelRowKey(
            in: navigableKeys, clearRowKey: Self.clearRowKey)
        if let scrollProxy, let highlightedKey {
            withAnimation(nil) { scrollProxy.scrollTo(highlightedKey, anchor: .center) }
        }
    }

    private func scrollToSelection(proxy: ScrollViewProxy) {
        if isClearSelected {
            DispatchQueue.main.async {
                withAnimation(nil) {
                    proxy.scrollTo(Self.clearRowKey, anchor: .center)
                }
            }
            return
        }
        guard let selectedItemKey else { return }
        DispatchQueue.main.async {
            withAnimation(nil) {
                proxy.scrollTo(selectedItemKey, anchor: .center)
            }
        }
    }
}

/// One rendered group of model rows: a provider, the favorites shortcut, or
/// the flat result list produced by a search.
private struct ModelPickerSection: Identifiable {
    let id: String
    let title: String?
    var icon: String?
    var provider: ProviderKind?
    let items: [ModelPickerItem]

    init(
        id: String, title: String?, icon: String? = nil, provider: ProviderKind? = nil,
        items: [ModelPickerItem]
    ) {
        self.id = id
        self.title = title
        self.icon = icon
        self.provider = provider
        self.items = items
    }
}

private struct ProviderFilterRow: View {
    let icon: String?
    let provider: ProviderKind?
    let title: String
    let count: Int
    let isSelected: Bool
    let action: () -> Void

    @UIState private var isHovering = false

    init(
        icon: String, title: String, count: Int, isSelected: Bool, action: @escaping () -> Void
    ) {
        self.icon = icon
        self.provider = nil
        self.title = title
        self.count = count
        self.isSelected = isSelected
        self.action = action
    }

    init(
        provider: ProviderKind, title: String, count: Int, isSelected: Bool,
        action: @escaping () -> Void
    ) {
        self.icon = nil
        self.provider = provider
        self.title = title
        self.count = count
        self.isSelected = isSelected
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Group {
                    if let provider {
                        ProviderIcon(provider: provider, size: 13)
                    } else if let icon {
                        Image(systemName: icon)
                            .font(.system(size: 11, weight: .semibold))
                    }
                }
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
        .animation(Motion.feedback, value: isHovering)
        // Selection is otherwise conveyed by color alone — this row has no
        // checkmark, so without the trait the active filter is inaudible.
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct ModelPickerRow: View {
    let item: ModelPickerItem
    let isSelected: Bool
    let isHighlighted: Bool
    let isFavorite: Bool
    let onHover: (Bool) -> Void
    let onToggleFavorite: () -> Void
    let onSelect: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                ProviderIcon(
                    provider: item.option.provider,
                    modelID: item.option.modelID,
                    size: 15
                )
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

                favoriteButton

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
                    // Zero opacity keeps the layout stable but leaves the glyph
                    // in the accessibility tree, where it reads as a checkmark
                    // on every row including the unselected ones.
                    .opacity(isSelected ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .background {
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                    .fill(rowBackground)
            }
            .overlay {
                // Keyboard focus needs a shape of its own: the hover wash alone
                // is invisible once the pointer is elsewhere on screen.
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                    .stroke(AlpineTheme.accent.opacity(isHighlighted && !isHovering ? 0.9 : 0))
            }
        }
        .buttonStyle(.plain)
        .onHover {
            isHovering = $0
            onHover($0)
        }
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.feedback, value: isHighlighted)
        .contextMenu {
            Button(isFavorite ? "Remove from Favorites" : "Add to Favorites", action: onToggleFavorite)
            Button("Copy Model ID") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(item.option.modelID, forType: .string)
            }
        }
        // Selection is otherwise conveyed by color alone.
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// Stays visible once starred, and appears on hover or keyboard focus so
    /// the row is quiet at rest.
    private var favoriteButton: some View {
        Button(action: onToggleFavorite) {
            Image(systemName: isFavorite ? "star.fill" : "star")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(isFavorite ? AlpineTheme.sky : Color.secondary)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isFavorite || isHovering || isHighlighted ? 1 : 0)
        .help(isFavorite ? "Remove from favorites (⌘D)" : "Add to favorites (⌘D)")
        .accessibilityLabel(isFavorite ? "Remove from favorites" : "Add to favorites")
        .animation(Motion.feedback, value: isFavorite)
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
        if isHighlighted { return Color.primary.opacity(0.045) }
        return .clear
    }
}
