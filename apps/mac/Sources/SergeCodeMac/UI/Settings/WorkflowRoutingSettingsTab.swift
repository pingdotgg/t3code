import SwiftUI

struct WorkflowRoutingSettingsTab: View {
    let model: AppModel

    @UIState private var draft: AppSettings?
    @UIState private var loadError: String?

    var body: some View {
        VStack(spacing: 18) {
            SettingsSection(header: "Ultra workflows", icon: "point.3.connected.trianglepath.dotted") {
                if let settings = draft {
                    routeRow(
                        title: "Explore & scope",
                        route: binding(settings, \.workflowModelRouting.explore))
                    SettingsDivider()
                    routeRow(
                        title: "Implement",
                        route: binding(settings, \.workflowModelRouting.implement))
                    SettingsDivider()
                    routeRow(
                        title: "Verify & review",
                        route: binding(settings, \.workflowModelRouting.verify))
                } else {
                    SettingsCardRow {
                        if let loadError {
                            VStack(alignment: .leading, spacing: 8) {
                                Label(
                                    "Could not load workflow settings",
                                    systemImage: "exclamationmark.triangle")
                                    .foregroundStyle(.red)
                                Text(loadError)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Button("Try Again") { Task { await loadDraft() } }
                                    .controlSize(.small)
                            }
                        } else {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }

            SettingsSection(header: "How routing works", icon: "questionmark.circle") {
                SettingsCardRow {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(
                            "Ultra Code and Ultra classify delegated work into these three roles. SurgeCode passes the routing policy to the parent agent and enforces it for product-native delegation."
                        )
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)

                        Label(
                            "Parent model keeps the current behavior for any role you leave unconfigured.",
                            systemImage: "arrow.triangle.branch")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .task { await loadDraft() }
    }

    @ViewBuilder
    private func routeRow(
        title: String, route: Binding<AppWorkflowModelRoute?>
    ) -> some View {
        SettingsPickerRow(title, selection: route) {
            Text("Parent model").tag(nil as AppWorkflowModelRoute?)
            ForEach(groupedModels, id: \.provider) { group in
                Section(group.provider.displayName) {
                    ForEach(group.models) { option in
                        Text(option.displayName)
                            .tag(
                                AppWorkflowModelRoute(
                                    instanceID: option.instanceID, modelID: option.modelID)
                                    as AppWorkflowModelRoute?)
                    }
                }
            }
        }
    }

    private var groupedModels: [(provider: ProviderKind, models: [ModelOption])] {
        Dictionary(grouping: model.models, by: \.provider)
            .map { provider, models in
                (
                    provider,
                    models.sorted {
                        $0.displayName.localizedCaseInsensitiveCompare($1.displayName)
                            == .orderedAscending
                    }
                )
            }
            .sorted { $0.provider.displayName < $1.provider.displayName }
    }

    private func binding(
        _ current: AppSettings,
        _ keyPath: WritableKeyPath<AppSettings, AppWorkflowModelRoute?>
    ) -> Binding<AppWorkflowModelRoute?> {
        Binding(
            get: { (draft ?? current)[keyPath: keyPath] },
            set: { newValue in
                var next = draft ?? current
                next[keyPath: keyPath] = newValue
                draft = next
                Task {
                    if await model.saveSettings(next) == false {
                        draft = model.settings
                    }
                }
            })
    }

    private func loadDraft() async {
        loadError = nil
        await model.loadSettings()
        draft = model.settings
        if draft == nil {
            loadError = model.lastError ?? "The server did not return settings."
        }
    }
}
