import SwiftUI

struct FeatureCommandPaletteView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel

    let activeProjectID: String?
    let onSelect: (FeatureCommandPaletteAction) -> Void

    @State private var mode: FeatureCommandPaletteMode = .root
    @State private var query = ""
    @FocusState private var searchIsFocused: Bool

    init(
        model: FeatureRootModel,
        activeProjectID: String?,
        onSelect: @escaping (FeatureCommandPaletteAction) -> Void
    ) {
        self.model = model
        self.activeProjectID = activeProjectID
        self.onSelect = onSelect
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                searchField
                Divider()
                    .overlay(T3Colors.border)
                results
            }
            .background(T3Colors.background)
            .navigationTitle(mode == .root ? "Command palette" : "New task in…")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if mode == .newTaskProjectPicker {
                        Button {
                            mode = .root
                            query = ""
                            focusSearch()
                        } label: {
                            Label("Back", systemImage: "chevron.left")
                        }
                    } else {
                        Button("Done") { dismiss() }
                    }
                }

                if mode == .newTaskProjectPicker {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { focusSearch() }
    }

    private var availableProjects: [FeatureProject] {
        DailyUXCreationContext.projects(in: model.snapshot)
    }

    private var searchField: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(T3Colors.textTertiary)
            TextField(
                mode == .root
                    ? "Search commands, projects, and threads…"
                    : "Search projects…",
                text: $query
            )
            .focused($searchIsFocused)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.search)
            .accessibilityIdentifier("command-palette-search")
            .accessibilityHint("Type greater-than to show actions only.")

            if !query.isEmpty {
                Button {
                    query = ""
                    focusSearch()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(T3Colors.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(T3Colors.inputBorder, lineWidth: 1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var results: some View {
        let groups = currentGroups
        if groups.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.title2)
                    .foregroundStyle(T3Colors.textTertiary)
                Text(mode == .root ? "No matching commands, projects, or threads." : "No matching projects.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(24)
        } else {
            List {
                ForEach(groups) { group in
                    Section(group.title) {
                        ForEach(group.items) { item in
                            Button {
                                select(item)
                            } label: {
                                paletteRow(item)
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(T3Colors.background)
                            .accessibilityIdentifier("command-palette-item-\(item.id)")
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
    }

    private var currentGroups: [FeatureCommandPaletteGroup] {
        switch mode {
        case .root:
            return FeatureCommandPaletteCatalog.groups(
                snapshot: model.snapshot,
                projects: availableProjects,
                activeProjectID: activeProjectID,
                query: query
            )
        case .newTaskProjectPicker:
            return FeatureCommandPaletteCatalog.newTaskProjectGroups(
                snapshot: model.snapshot,
                projects: availableProjects,
                query: query
            )
        }
    }

    private func paletteRow(_ item: FeatureCommandPaletteItem) -> some View {
        HStack(spacing: 12) {
            Image(systemName: item.systemImage)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                if let detail = item.detail {
                    Text(detail)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            if item.showsDisclosure {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
            }
        }
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
    }

    private func select(_ item: FeatureCommandPaletteItem) {
        switch item.action {
        case .chooseNewTaskProject:
            mode = .newTaskProjectPicker
            query = ""
            focusSearch()
        default:
            dismiss()
            onSelect(item.action)
        }
    }

    private func focusSearch() {
        Task { @MainActor in
            await Task.yield()
            searchIsFocused = true
        }
    }
}
