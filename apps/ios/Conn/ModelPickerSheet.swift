import SwiftUI
import UIKit

/// The model list of Conn mobile's thread settings sheet (`ThreadSettingsSheet.tsx`
/// `ThreadSettingsModelsScreen`, `ThreadSettingsRows`): "Thread settings", a close button, Done
/// or Save, the "Find a model" search, and provider sections of grouped rows. A tap picks a row;
/// Save applies it. `model_picker` in conn-ffi builds the sections.
struct ModelPickerSheet: View {
    @Bindable var store: CoreStore
    let threadId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme
    @State private var query = ""
    @State private var toggled: [String] = []
    @State private var pending: (instanceId: String, model: String)?
    @State private var picker: FfiModelPicker?
    @State private var saving = false
    @State private var showingUnavailable = false

    private var reloadKey: String {
        let pick = pending.map { "\($0.instanceId):\($0.model)" } ?? ""
        let model = store.openThread?.modelLabel ?? ""
        return "\(store.providersRevision)|\(query)|\(toggled.joined(separator: ","))|\(pick)|\(model)"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let picker {
                        if !picker.loaded {
                            notice("Loading models…")
                        } else if picker.sections.isEmpty {
                            notice(query.isEmpty ? "No models available." : "No models match your search.")
                        }
                        ForEach(picker.sections, id: \.instanceId) { section in
                            header(section)
                            ForEach(Array(section.models.enumerated()), id: \.element.model) { index, row in
                                modelRow(row, isFirst: index == 0, isLast: index == section.models.count - 1)
                            }
                        }
                    }
                }
                .padding(.bottom, 16)
            }
            .background(theme.background.ignoresSafeArea())
            .navigationTitle("Thread settings")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Find a model"
            )
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Cancel thread settings")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(picker?.hasPending == true ? "Save" : "Done") { commitAndClose() }
                        .fontWeight(.semibold)
                        .disabled(saving)
                        .accessibilityIdentifier("modelPicker.confirm")
                }
            }
        }
        .alert("Model unavailable", isPresented: $showingUnavailable) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Set up this provider on web or desktop, or select another model.")
        }
        // `ProviderWorkspaceSnapshotScan`: models only the project's own config lists.
        // Asked again whenever the provider list changes, so a sheet opened before providers
        // arrived scans once they do; a pending scan asks again when the core says to.
        .task(id: store.providersRevision) {
            while !Task.isCancelled,
                  let delay = await store.scanThreadWorkspaceModels(threadId: threadId) {
                try? await Task.sleep(for: .milliseconds(max(delay, 250)))
            }
        }
        .task(id: reloadKey) {
            picker = await store.modelPicker(
                threadId: threadId,
                query: query,
                toggled: toggled,
                pending: pending
            )
        }
    }

    /// `commitPendingModel`: the core sends the pick only while the catalog still offers it;
    /// otherwise the sheet stays open with mobile's "Model unavailable" alert.
    private func commitAndClose() {
        guard let pending, picker?.hasPending == true else {
            dismiss()
            return
        }
        saving = true
        Task {
            let result = await store.saveThreadModel(
                threadId: threadId,
                instanceId: pending.instanceId,
                model: pending.model
            )
            saving = false
            switch result {
            case .saved?, .unchanged?: dismiss()
            case .unavailable?: showingUnavailable = true
            // The thread's scope is still loading; the sheet keeps its loading state.
            case .notReady?, nil: break
            }
        }
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14))
            .foregroundStyle(theme.mutedForeground)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
    }

    /// `ProviderHeader`: the icon at 15 and the label (14 medium, muted); a collapsible one adds the
    /// folded count and a 12pt chevron.
    private func header(_ section: FfiModelPickerSection) -> some View {
        let content = HStack(spacing: 7) {
            ProviderIcon(driver: section.driver, size: 15)
            Text(section.label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(theme.mutedForeground)
            if section.collapsible {
                Spacer(minLength: 0)
                if section.collapsed {
                    Text("\(section.modelCount)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(theme.mutedForeground)
                }
                ConnIcon(section.collapsed ? "chevron.down" : "chevron.up")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.mutedForeground)
            }
        }
        .padding(.horizontal, 3.5)
        .padding(.top, 7)
        .frame(minHeight: 44, alignment: .bottom)
        .padding(.horizontal, 14)
        .padding(.top, 3.5)

        return Group {
            if section.collapsible {
                Button {
                    if let index = toggled.firstIndex(of: section.instanceId) {
                        toggled.remove(at: index)
                    } else {
                        toggled.append(section.instanceId)
                    }
                } label: {
                    content.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(section.label), \(section.modelCount) models")
            } else {
                content.accessibilityAddTraits(.isHeader)
            }
        }
    }

    /// `ModelRowContent` with the iOS trailing checkmark: 44 tall, 14 at the sides inside a 14pt
    /// inset card, label 16 medium, badges 11 bold, sub-provider 13 muted.
    private func modelRow(_ row: FfiModelPickerRow, isFirst: Bool, isLast: Bool) -> some View {
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: isFirst ? 14 : 0,
            bottomLeadingRadius: isLast ? 14 : 0,
            bottomTrailingRadius: isLast ? 14 : 0,
            topTrailingRadius: isFirst ? 14 : 0,
            style: .continuous
        )
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            pending = (row.instanceId, row.model)
        } label: {
            HStack(spacing: 7) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 7) {
                        Text(row.label)
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)
                        if row.isDefault { badge("Default", strong: true) }
                        if row.isLegacy { badge("Legacy", strong: false) }
                    }
                    if !row.subtitle.isEmpty {
                        Text(row.subtitle)
                            .font(.system(size: 13))
                            .foregroundStyle(theme.mutedForeground)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if row.selected {
                    ConnIcon("checkmark")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(theme.foreground)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(theme.card, in: shape)
            .overlay(alignment: .bottom) {
                if !isLast {
                    Rectangle().fill(theme.border.opacity(0.6)).frame(height: 0.5)
                }
            }
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .accessibilityLabel([row.label, row.subtitle].filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityAddTraits(row.selected ? [.isSelected] : [])
    }

    private func badge(_ text: String, strong: Bool) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(theme.mutedForeground)
            .padding(.horizontal, 5.25)
            .padding(.vertical, 1.75)
            .background(theme.foreground.opacity(strong ? 0.12 : 0.06), in: RoundedRectangle(cornerRadius: 6))
    }
}
