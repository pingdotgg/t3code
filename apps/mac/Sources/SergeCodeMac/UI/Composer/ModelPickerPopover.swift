import SwiftUI

/// Compact model-picker segment: opens a searchable, provider-grouped popover
/// instead of a flat `Menu` list.
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
                if isHovering {
                    RoundedRectangle(cornerRadius: AlpineTheme.Corners.compact, style: .continuous)
                        .fill(.fill.secondary)
                }
            }
        }
        .buttonStyle(.plain)
        .fixedSize()
        .disabled(model.models.isEmpty)
        .help("Model")
        .onHover { isHovering = $0 }
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

    private func isCurrent(_ option: ModelOption) -> Bool {
        option.instanceID == thread.modelInstanceID && option.modelID == thread.modelID
    }

    private var currentModelName: String {
        if let current = model.models.first(where: isCurrent(_:)) {
            return current.displayName
        }
        return thread.modelID ?? thread.provider.displayName
    }
}

/// Searchable model list grouped by provider. Presented as a popover from
/// `ModelPickerMenu`.
private struct ModelPickerPopoverContent: View {
    let thread: ChatThread
    let model: AppModel
    @Binding var isPresented: Bool

    @UIState private var searchText = ""
    @FocusState private var searchFocused: Bool

    private var query: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredModels: [ModelOption] {
        let q = query.lowercased()
        guard !q.isEmpty else { return model.models }
        return model.models.filter { option in
            option.displayName.lowercased().contains(q)
                || option.modelID.lowercased().contains(q)
                || option.provider.displayName.lowercased().contains(q)
        }
    }

    private var groupedSections: [(provider: ProviderKind, options: [ModelOption])] {
        ProviderKind.allCases.compactMap { kind in
            let options = filteredModels.filter { $0.provider == kind }
            guard !options.isEmpty else { return nil }
            return (kind, options)
        }
    }

    private var selectedOptionID: String? {
        model.models.first {
            $0.instanceID == thread.modelInstanceID && $0.modelID == thread.modelID
        }?.id
    }

    var body: some View {
        VStack(spacing: 0) {
            searchField
            Divider()
            if groupedSections.isEmpty {
                emptyState
            } else {
                modelList
            }
        }
        .frame(width: 340)
        .frame(maxHeight: 420)
        .onAppear {
            searchFocused = true
        }
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .imageScale(.small)
            TextField("Search models", text: $searchText)
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
                        .imageScale(.small)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var emptyState: some View {
        Text("No models match")
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 120)
            .padding(.horizontal, 16)
    }

    private var modelList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                    ForEach(groupedSections, id: \.provider) { section in
                        Section {
                            ForEach(section.options) { option in
                                ModelPickerRow(
                                    option: option,
                                    isSelected: option.id == selectedOptionID
                                ) {
                                    Task { await model.setModel(option) }
                                    isPresented = false
                                }
                                .id(option.id)
                            }
                        } header: {
                            sectionHeader(provider: section.provider, count: section.options.count)
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            .onAppear {
                scrollToSelection(proxy: proxy)
            }
            .onChange(of: isPresented) { _, presented in
                if presented {
                    // Popover content can remount; re-scroll after layout.
                    scrollToSelection(proxy: proxy)
                }
            }
        }
    }

    private func sectionHeader(provider: ProviderKind, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(provider.displayName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("\(count)")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(.fill.quaternary, in: Capsule())
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background)
    }

    private func scrollToSelection(proxy: ScrollViewProxy) {
        guard let selectedOptionID else { return }
        // Defer one run-loop tick so LazyVStack has registered the id.
        DispatchQueue.main.async {
            withAnimation(nil) {
                proxy.scrollTo(selectedOptionID, anchor: .center)
            }
        }
    }

    private func selectFirstVisibleMatch() {
        guard !query.isEmpty else { return }
        guard let first = groupedSections.first?.options.first else { return }
        Task { await model.setModel(first) }
        isPresented = false
    }
}

/// Single model row inside the picker popover.
private struct ModelPickerRow: View {
    let option: ModelOption
    let isSelected: Bool
    let onSelect: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.displayName)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let meta = metadataLine {
                        Text(meta)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(AlpineTheme.accent)
                        .imageScale(.medium)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
            .background {
                if isHovering {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(.fill.secondary)
                } else if isSelected {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(.fill.quaternary)
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
    }

    /// Facts drawn only from fields `ModelOption` actually exposes.
    private var metadataLine: String? {
        var parts: [String] = []
        let efforts = option.effortChoices.count
        if efforts > 0 {
            parts.append(efforts == 1 ? "1 effort level" : "\(efforts) effort levels")
        }
        let tiers = option.serviceTierChoices.count
        if tiers > 0 {
            parts.append(tiers == 1 ? "1 tier" : "\(tiers) tiers")
        }
        if parts.isEmpty {
            // Fall back to the wire model id so rows still show a subtitle.
            return option.modelID
        }
        return parts.joined(separator: " · ")
    }
}
