import SwiftUI

struct DefaultRuntimeModePicker: View {
    @Binding var selection: RuntimeMode

    var body: some View {
        Picker("Default permissions", selection: $selection) {
            Text("Supervised").tag(RuntimeMode.approvalRequired)
            Text("Auto-accept edits").tag(RuntimeMode.autoAcceptEdits)
            Text("Auto").tag(RuntimeMode.auto)
            Text("Full access").tag(RuntimeMode.fullAccess)
        }
    }
}

/// Save complete text values so editing does not send a write for every key.
struct BranchNamingTextSetting: View {
    let title: String
    let value: String
    var multiline = false
    let save: (String) -> Void
    @State private var draft = ""

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        TextField(title, text: $draft, axis: multiline ? .vertical : .horizontal)
            .lineLimit(multiline ? 3...6 : 1...1)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel(title)
            .onAppear { draft = value }
            .onChange(of: value) { _, updated in draft = updated }
        if trimmed != value {
            Button("Save \(title.lowercased())") { save(trimmed) }
        }
    }
}

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
    @State private var preferences: FeatureProjectPreferences?
    @State private var busy = false
    @State private var errorMessage: String?

    private var project: FeatureProject? { model.snapshot.projects.first { $0.id == projectID } }
    private var canWriteSettings: Bool {
        guard let project else { return false }
        return model.snapshot.environments.first { $0.id == project.environmentID }?
            .permissions?.grants("settings:write") == true
    }
    private var wireID: String { project?.wireID ?? projectID }
    private var providers: [FeatureProvider] {
        DailyUXCreationContext.providers(for: project, in: model.snapshot)
    }
    private var settings: ServerSettingsSnapshot? { preferences?.environment }
    private var effective: ServerSettingsSnapshot? { preferences?.effective }
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
                if settings?.supportsDefaultRuntimeMode == true {
                    projectSetting(.defaultRuntimeMode) {
                        DefaultRuntimeModePicker(selection: Binding(
                            get: { effective.defaultRuntimeMode },
                            set: { save(.defaultRuntimeMode, value: .string($0.rawValue)) }
                        ))
                        .accessibilityIdentifier("project-default-runtime")
                    }
                }
                projectSetting(.defaultThreadEnvMode) {
                    Picker("New threads", selection: Binding(
                        get: { effective.defaultThreadEnvMode },
                        set: { save(.defaultThreadEnvMode, value: $0.map { .string($0.rawValue) }) }
                    )) {
                        if effective.defaultThreadEnvMode == nil {
                            Text("Project configuration").tag(nil as ServerThreadEnvironmentMode?)
                        }
                        Text("Local workspace").tag(ServerThreadEnvironmentMode.local as ServerThreadEnvironmentMode?)
                        Text("New worktree").tag(ServerThreadEnvironmentMode.worktree as ServerThreadEnvironmentMode?)
                    }
                    .accessibilityIdentifier("project-default-workspace")
                }
                projectSetting(.newWorktreesStartFromOrigin) {
                    Toggle("Start worktrees from origin", isOn: booleanBinding(
                        .newWorktreesStartFromOrigin, value: effective.newWorktreesStartFromOrigin
                    ))
                }
                if settings?.supportsWorktreeSubmodules == true {
                    projectSetting(.worktreeSubmodules) {
                        Picker("Submodules", selection: Binding(
                            get: { effective.worktreeSubmodules?.rawValue ?? "" },
                            set: { save(.worktreeSubmodules, value: $0.isEmpty ? nil : .string($0)) }
                        )) {
                            Text("Project configuration").tag("")
                            ForEach(WorktreeSubmodules.allCases, id: \.self) { Text($0.label).tag($0.rawValue) }
                        }
                    }
                }
                if settings?.storageCleanup != nil {
                    projectSetting(.worktreeCleanup) {
                        let cleanup = settings?.projectSettingsOverrides[wireID]?["worktreeCleanup"]
                        Picker("Worktree cleanup", selection: Binding(
                            get: { cleanup?["mode"]?.stringValue ?? "inherit" },
                            set: { mode in
                                if mode == "inherit" { save(.worktreeCleanup, value: nil) }
                                else if mode == "off" { save(.worktreeCleanup, value: .object(["mode": .string("off")])) }
                                else {
                                    save(.worktreeCleanup, value: .object([
                                        "mode": .string("custom"),
                                        "rules": .object([
                                            "worktreeAfterDays": .null, "worktreeOnMerge": .bool(false),
                                            "worktreeOnDelete": .bool(false), "worktreeUnchanged": .bool(false),
                                        ]),
                                    ]))
                                }
                            }
                        )) {
                            Text("Use environment setting").tag("inherit")
                            Text("Disabled").tag("off")
                            Text("Custom").tag("custom")
                        }
                        if cleanup?["mode"]?.stringValue == "custom", case let .object(rules) = cleanup?["rules"] {
                            StorageCleanupControls(rules: rules, includesLogs: false) { key, value in
                                var updated = rules
                                updated[key] = value
                                save(.worktreeCleanup, value: .object(["mode": .string("custom"), "rules": .object(updated)]))
                            }
                        }
                    }
                }
                projectSetting(.defaultAutoPull) {
                    Toggle("Automatically pull default branch", isOn: booleanBinding(.defaultAutoPull, value: effective.defaultAutoPull))
                }
                if let removeCredits = effective.removeAgentCreditsOnMerge, settings?.removeAgentCreditsOnMerge != nil {
                    projectSetting(.removeAgentCreditsOnMerge) {
                        Toggle("Remove agent credits on merge", isOn: booleanBinding(
                            .removeAgentCreditsOnMerge, value: removeCredits
                        ))
                        .accessibilityIdentifier("project-remove-agent-credits")
                    }
                }
                if let mode = effective.branchNamingMode, settings?.branchNamingMode != nil {
                    projectSetting(.branchNamingMode) {
                        Picker("Branch naming", selection: Binding(
                            get: { mode },
                            set: { save(.branchNamingMode, value: .string($0.rawValue)) }
                        )) {
                            ForEach(BranchNamingMode.allCases, id: \.self) { Text($0.label).tag($0) }
                        }
                        .accessibilityIdentifier("project-branch-naming")
                    }
                    if mode == .static, let prefix = effective.branchNamePrefix, settings?.branchNamePrefix != nil {
                        projectSetting(.branchNamePrefix) {
                            BranchNamingTextSetting(title: "Branch prefix", value: prefix) {
                                save(.branchNamePrefix, value: .string($0))
                            }
                        }
                    }
                    if mode == .custom, let instructions = effective.branchNameInstructions, settings?.branchNameInstructions != nil {
                        projectSetting(.branchNameInstructions) {
                            BranchNamingTextSetting(title: "Branch naming instructions", value: instructions, multiline: true) {
                                save(.branchNameInstructions, value: .string($0))
                            }
                        }
                    }
                }
                if let browserAccess = effective.enableAgentBrowserAccess, settings?.enableAgentBrowserAccess != nil {
                    projectSetting(.enableAgentBrowserAccess) {
                        Toggle("Agent browser access", isOn: booleanBinding(.enableAgentBrowserAccess, value: browserAccess))
                            .accessibilityIdentifier("project-agent-browser-access")
                    }
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
                        get: { effective.sidebarAutoSettleAfterDays ?? 0 },
                        set: { save(.sidebarAutoSettleAfterDays, value: $0 == 0 ? .null : .number($0)) }
                    )) {
                        Text("Never").tag(0.0)
                        ForEach(settlementDays(effective.sidebarAutoSettleAfterDays), id: \.self) { days in
                            Text(days == 1 ? "1 day" : "\(days.formatted()) days").tag(days)
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
            if !canWriteSettings { Text("This connection cannot change settings.") }
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
        .task(id: project?.supportsProjectSettingsOverrides) { await load() }
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
        .disabled(!canWriteSettings)
        .listRowBackground(T3Colors.background)
    }

    private func booleanBinding(_ key: ServerProjectSettingKey, value: Bool) -> Binding<Bool> {
        Binding(get: { value }, set: { save(key, value: .bool($0)) })
    }

    private func settlementDays(_ current: Double?) -> [Double] {
        Array(Set([1, 3, 7, 14, 30, 90] + (current.map { [$0] } ?? []))).sorted()
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
            preferences = try await model.client.projectPreferences(projectID: projectID)
            errorMessage = nil
        } catch { errorMessage = "Could not load project settings. Check this connection." }
    }

    private func save(_ key: ServerProjectSettingKey, value: JSONValue?) {
        guard !busy, canWriteSettings else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await model.client.updateProjectPreferences(
                    projectID: projectID, change: .init(key: key, value: value)
                )
                await load()
            } catch { errorMessage = error.localizedDescription }
        }
    }
}

struct StorageCleanupControls: View {
    let rules: [String: JSONValue]
    let includesLogs: Bool
    let save: (String, JSONValue) -> Void

    var body: some View {
        retention("Inactive worktrees", key: "worktreeAfterDays")
        Toggle("Remove worktrees after merge", isOn: boolean("worktreeOnMerge"))
        Toggle("Remove worktrees after thread deletion", isOn: boolean("worktreeOnDelete"))
        Toggle("Include unchanged worktrees", isOn: boolean("worktreeUnchanged"))
        if includesLogs {
            retention("Browser artifacts", key: "browserArtifactsAfterDays")
            retention("Logs", key: "logsAfterDays")
        }
    }

    private func boolean(_ key: String) -> Binding<Bool> {
        Binding(get: { rules[key]?.boolValue ?? false }, set: { save(key, .bool($0)) })
    }

    private func retention(_ title: String, key: String) -> some View {
        let current = (try? rules[key]?.decode(Int.self)) ?? 0
        return Picker(title, selection: Binding(
            get: { current }, set: { save(key, $0 == 0 ? .null : .number(Double($0))) }
        )) {
            Text("Never").tag(0)
            ForEach(Array(Set([1, 3, 7, 14, 30, 90, 365] + (current > 0 ? [current] : []))).sorted(), id: \.self) { days in
                Text(days == 1 ? "After 1 day" : "After \(days) days").tag(days)
            }
        }
    }
}
