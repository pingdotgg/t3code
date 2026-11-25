import SwiftUI
import UIKit

struct ModelPickerSheet: View {
    @Bindable var store: CoreStore
    let threadId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme
    private enum Page: Hashable { case providers, models(String) }
    @State private var pages: [Page] = []
    @State private var toggled: [String] = []
    @State private var pending: (instanceId: String, model: String)?
    @State private var picker: FfiModelPicker?
    @State private var optionChanges: [String: String] = [:]
    @State private var steer = false
    @State private var saving = false
    @State private var showingUnavailable = false

    private var reloadKey: String {
        let pick = pending.map { "\($0.instanceId):\($0.model)" } ?? ""
        let model = store.openThread?.modelLabel ?? ""
        return "\(store.providersRevision)|\(toggled.joined(separator: ","))|\(pick)|\(model)"
    }

    var body: some View {
        NavigationStack(path: $pages) {
            List {
                if let picker, picker.loaded {
                    let section = picker.sections.first { $0.models.contains(where: \.selected) }
                    let row = section?.models.first(where: \.selected)
                    if picker.sections.isEmpty {
                        Text("No models available.").foregroundStyle(.secondary)
                    } else {
                        Section {
                            NavigationLink(value: Page.providers) {
                                LabeledContent("Provider", value: section?.label ?? "Select")
                            }
                            if let section {
                                Button { browse(section) } label: {
                                    LabeledContent("Model", value: row?.label ?? "Select")
                                }
                            }
                            if let row {
                                ForEach(row.controls, id: \.id) { control in
                                    Picker(control.toggle || control.id == "serviceTier" ? "Speed" : "Effort", selection: Binding(
                                        get: { optionChanges[control.id] ?? control.current },
                                        set: { value in
                                            pending = (row.instanceId, row.model)
                                            optionChanges[control.id] = value == control.current ? nil : value
                                        }
                                    )) {
                                        ForEach(Array(zip(control.values, control.labels)), id: \.0) { value, label in
                                            Text(label).tag(value)
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else { ProgressView("Loading models…") }
                Section {
                    Picker("Follow-up messages", selection: $steer) {
                        Text("Steer").tag(true)
                        Text("Queue").tag(false)
                    }
                }
            }
            .navigationDestination(for: Page.self) { page in
                switch page {
                case .providers:
                    List(picker?.sections ?? [], id: \.instanceId) { section in
                        Button { browse(section) } label: {
                            Label { Text(section.label) } icon: { ProviderIcon(driver: section.driver, size: 18) }
                        }.accessibilityIdentifier("modelPicker.provider." + section.instanceId)
                    }.navigationTitle("Provider")
                case .models(let instance):
                    List(picker?.sections.first { $0.instanceId == instance }?.models ?? [], id: \.model) { row in
                        Button {
                            if !row.selected { optionChanges = [:] }
                            pending = (row.instanceId, row.model)
                            pages = []
                        } label: {
                            HStack {
                                Text(row.label)
                                Spacer()
                                if row.selected { Image(systemName: "checkmark") }
                            }
                        }.accessibilityIdentifier("modelPicker.model." + row.model)
                    }.navigationTitle("Model")
                }
            }
            .navigationTitle("Thread settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Cancel thread settings")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(picker?.hasPending == true || !optionChanges.isEmpty || steer != store.followUpSteers(threadId) ? "Save" : "Done") { commitAndClose() }
                        .fontWeight(.semibold)
                        .disabled(saving)
                        .accessibilityIdentifier("modelPicker.confirm")
                }
            }
        }
        .onAppear { steer = store.followUpSteers(threadId) }
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
            let result = await store.modelPicker(
                threadId: threadId,
                query: "",
                toggled: toggled,
                pending: pending
            )
            if !Task.isCancelled { picker = result }
        }
    }

    /// `commitPendingModel`: the core sends the pick only while the catalog still offers it;
    /// otherwise the sheet stays open with mobile's "Model unavailable" alert.
    private func commitAndClose() {
        guard let pending, picker?.hasPending == true || !optionChanges.isEmpty else {
            store.setFollowUpSteers(steer, threadId: threadId)
            dismiss()
            return
        }
        saving = true
        Task {
            let result = await store.saveThreadModel(
                threadId: threadId,
                instanceId: pending.instanceId,
                model: pending.model, changes: optionChanges
            )
            saving = false
            switch result {
            case .saved?, .unchanged?:
                store.setFollowUpSteers(steer, threadId: threadId)
                dismiss()
            case .unavailable?: showingUnavailable = true
            // The thread's scope is still loading; the sheet keeps its loading state.
            case .notReady?, nil: break
            }
        }
    }

    private func browse(_ section: FfiModelPickerSection) {
        if section.collapsed {
            if toggled.contains(section.instanceId) { toggled.removeAll { $0 == section.instanceId } }
            else { toggled.append(section.instanceId) }
        }
        pages.append(.models(section.instanceId))
    }
}
