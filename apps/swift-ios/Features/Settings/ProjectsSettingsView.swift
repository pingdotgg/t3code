import SwiftUI

struct ResponseStreamingPicker: View {
    let title: String
    @Binding var selection: ResponseStreamingMode
    @State private var showingTokenWarning = false

    var body: some View {
        Picker(title, selection: Binding(
            get: { selection },
            set: { mode in
                if mode == .token { showingTokenWarning = true }
                else { selection = mode }
            }
        )) {
            ForEach(ResponseStreamingMode.allCases, id: \.self) { mode in
                Text(mode.label).tag(mode)
            }
        }
        .confirmationDialog("Use token streaming?", isPresented: $showingTokenWarning, titleVisibility: .visible) {
            Button("Use paragraphs") { selection = .paragraph }
            Button("Use tokens") { selection = .token }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Token streaming updates more often and can use more battery. Paragraph streaming is recommended.")
        }
    }
}

struct ProjectPreferencesSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let projectID: String

    var body: some View {
        NavigationStack {
            ProjectPreferencesView(model: model, projectID: projectID)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .onAppear { model.setConnectionManagementPresented(true) }
        .onDisappear { model.setConnectionManagementPresented(false) }
        .presentationBackground(T3Colors.background)
    }
}

struct ProjectsSettingsView: View {
    @Bindable var model: FeatureRootModel

    var body: some View {
        List {
            ForEach(model.snapshot.environments) { environment in
                let projects = model.snapshot.projects.filter { $0.environmentID == environment.id }
                    .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                if !projects.isEmpty {
                    Section(environment.name) {
                        ForEach(projects) { project in
                            NavigationLink(project.name) {
                                ProjectPreferencesView(model: model, projectID: project.id)
                            }
                        }
                    }
                    .listRowBackground(T3Colors.background)
                }
            }
            if model.snapshot.projects.isEmpty { Text("No projects") }
        }
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
    }
}

struct ProjectPreferencesView: View {
    @Bindable var model: FeatureRootModel
    let projectID: String
    @State private var settings: ServerSettingsSnapshot?
    @State private var busy = false
    @State private var errorMessage: String?

    private var project: FeatureProject? { model.snapshot.projects.first { $0.id == projectID } }
    private var wireID: String { project?.wireID ?? projectID }
    private var providers: [FeatureProvider] {
        DailyUXCreationContext.providers(for: project, in: model.snapshot)
    }
    private var effective: ServerSettingsSnapshot? {
        settings?.resolvingProject(
            id: wireID,
            disabledProviderIDs: Set(providers.filter { $0.isEnabled == false }.map(\.id))
        )
    }
    private var supportsRestartContinuation: Bool {
        guard let project else { return false }
        return model.snapshot.preferencesByEnvironment?[project.environmentID]?.continueThreadsAfterServerUpdate != nil
    }

    var body: some View {
        Form {
            if project?.supportsProjectSettingsOverrides != true {
                Text("Update this environment to change project settings.")
            } else if let effective {
                projectSetting(.defaultModelSelection) {
                    Menu {
                        Button("No default model") { save(.defaultModelSelection, value: .null) }
                        ForEach(providers.filter(\.isAvailable)) { provider in
                            Section(provider.name) {
                                ForEach(provider.models) { model in
                                    Button(model.name) {
                                        setDefaultModel(providerID: provider.id, modelID: model.id)
                                    }
                                }
                            }
                        }
                    } label: {
                        LabeledContent("Default model", value: modelLabel(effective.defaultModelSelection))
                    }
                    .accessibilityIdentifier("project-default-model")
                }
                projectSetting(.defaultThreadEnvMode) {
                    Picker("New threads", selection: Binding(
                        get: { effective.defaultThreadEnvMode },
                        set: { save(.defaultThreadEnvMode, value: .string($0.rawValue)) }
                    )) {
                        Text("Local workspace").tag(ServerThreadEnvironmentMode.local)
                        Text("New worktree").tag(ServerThreadEnvironmentMode.worktree)
                    }
                    .accessibilityIdentifier("project-default-workspace")
                }
                projectSetting(.newWorktreesStartFromOrigin) {
                    Toggle("Start worktrees from origin", isOn: booleanBinding(
                        .newWorktreesStartFromOrigin, value: effective.newWorktreesStartFromOrigin
                    ))
                }
                projectSetting(.defaultAutoPull) {
                    Toggle("Pull before new threads", isOn: booleanBinding(.defaultAutoPull, value: effective.defaultAutoPull))
                }
                if settings?.responseStreamingMode != nil {
                    projectSetting(.responseStreamingMode) {
                        ResponseStreamingPicker(title: "Response streaming", selection: Binding(
                            get: { effective.responseStreamingMode ?? .paragraph },
                            set: { save(.responseStreamingMode, value: .string($0.rawValue)) }
                        ))
                        .accessibilityIdentifier("project-response-streaming")
                    }
                }
                projectSetting(.sidebarAutoSettleOnMerge) {
                    Toggle("Settle after merge", isOn: booleanBinding(
                        .sidebarAutoSettleOnMerge, value: effective.sidebarAutoSettleOnMerge
                    ))
                }
                projectSetting(.sidebarAutoSettleAfterDays) {
                    Picker("Settle after inactivity", selection: Binding(
                        get: { effective.sidebarAutoSettleAfterDays.map(Int.init) ?? 0 },
                        set: { save(.sidebarAutoSettleAfterDays, value: $0 == 0 ? .null : .number(Double($0))) }
                    )) {
                        Text("Never").tag(0)
                        ForEach(settlementDays(effective.sidebarAutoSettleAfterDays), id: \.self) { days in
                            Text(days == 1 ? "1 day" : "\(days) days").tag(days)
                        }
                    }
                }
                if supportsRestartContinuation {
                    projectSetting(.continueThreadsAfterServerUpdate) {
                        Toggle("Continue threads after restarts", isOn: booleanBinding(
                            .continueThreadsAfterServerUpdate, value: effective.continueThreadsAfterServerUpdate
                        ))
                    }
                }
            } else if errorMessage == nil {
                Text("Loading preferences...")
            }
            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .foregroundStyle(T3Colors.danger)
                    Button("Try again") { Task { await load() } }
                }
            }
        }
        .disabled(busy)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle(project?.name ?? "Project")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .task(id: projectID) { await load() }
    }

    private func projectSetting<Content: View>(
        _ key: ServerProjectSettingKey,
        @ViewBuilder content: () -> Content
    ) -> some View {
        let overridden = settings?.projectSettingsOverrides[wireID]?[key.rawValue] != nil
        return Section {
            content()
            if overridden {
                Button("Use environment setting") { save(key, value: nil) }
                    .accessibilityIdentifier("project-reset-\(key.rawValue)")
            }
        } footer: {
            Text(overridden ? "Project setting" : "Uses environment setting")
            if key == .responseStreamingMode, effective?.responseStreamingMode == .token {
                Text("Token streaming updates more often and can use more battery.")
            }
        }
        .listRowBackground(T3Colors.background)
    }

    private func booleanBinding(_ key: ServerProjectSettingKey, value: Bool) -> Binding<Bool> {
        Binding(get: { value }, set: { save(key, value: .bool($0)) })
    }

    private func settlementDays(_ current: Double?) -> [Int] {
        Array(Set([1, 3, 7, 14, 30, 90] + (current.map { [Int($0)] } ?? []))).sorted()
    }

    private func modelLabel(_ selection: ModelSelection?) -> String {
        guard let selection else { return "None" }
        return providers.first { $0.id == selection.instanceId }?
            .models.first { $0.id == selection.model }?.name ?? selection.model
    }

    private func setDefaultModel(providerID: String, modelID: String) {
        do {
            let selection = ModelSelection(instanceId: providerID, model: modelID)
            save(.defaultModelSelection, value: try JSONValue.encode(selection))
        } catch { errorMessage = "Could not save this model." }
    }

    private func load() async {
        guard let project, project.supportsProjectSettingsOverrides == true else { return }
        do {
            settings = try await model.client.serverPreferences(environmentID: project.environmentID)
            errorMessage = nil
        } catch { errorMessage = "Could not load project settings. Check this connection." }
    }

    private func save(_ key: ServerProjectSettingKey, value: JSONValue?) {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await model.client.updateProjectPreferences(
                    projectID: projectID, change: .init(key: key, value: value)
                )
                await load()
            } catch { errorMessage = "Could not save project settings. Check this connection and try again." }
        }
    }
}
