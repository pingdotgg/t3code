import SwiftUI

struct EnvironmentPreferencesView: View {
    @Bindable var model: FeatureRootModel
    let environmentID: String
    @State private var settings: ServerSettingsSnapshot?
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var mismatches: [String] = []
    @State private var routingPermission = GitHubRoutingPermission.off

    private var environment: FeatureEnvironment? {
        model.snapshot.environments.first { $0.id == environmentID }
    }

    private var canWriteSettings: Bool {
        environment?.permissions?.grants("settings:write") == true
    }

    private var supportsRestartContinuation: Bool {
        model.snapshot.preferencesByEnvironment?[environmentID]?.continueThreadsAfterServerUpdate != nil
    }

    var body: some View {
        Form {
            Section {
                Picker("GitHub sharing", selection: Binding(
                    get: { routingPermission }, set: { saveRoutingPermission($0) }
                )) {
                    ForEach(GitHubRoutingPermission.allCases, id: \.self) { Text($0.label).tag($0) }
                }
            } footer: {
                Text("Enable both environments to share PR data through the same GitHub account. Write access permits PR changes. Credentials stay on each environment.")
            }
            CloudWebhookPreferencesView(model: model, environmentID: environmentID)
            if let settings {
                if settings.github != nil {
                    Section {
                        NavigationLink("GitHub accounts and tokens") {
                            GitHubSettingsView(model: model, environmentID: environmentID)
                        }
                    }
                }
                Group {
                    if settings.supportsDefaultRuntimeMode {
                        Section("New threads") {
                            DefaultRuntimeModePicker(selection: Binding(
                                get: { settings.defaultRuntimeMode },
                                set: { save(.defaultRuntimeMode($0)) }
                            ))
                            .accessibilityIdentifier("environment-default-runtime")
                        }
                    }
                    Section("Source control") {
                        if let removeCredits = settings.removeAgentCreditsOnMerge {
                            Toggle("Remove agent credits on merge", isOn: Binding(
                                get: { removeCredits },
                                set: { save(.removeAgentCreditsOnMerge($0)) }
                            ))
                            .accessibilityIdentifier("environment-remove-agent-credits")
                        }
                        Toggle("Automatically pull default branch", isOn: Binding(
                            get: { settings.defaultAutoPull },
                            set: { save(.defaultAutoPull($0)) }
                        ))
                        .accessibilityIdentifier("environment-default-auto-pull")
                        if let branchNamingMode = settings.branchNamingMode {
                            Picker("Branch naming", selection: Binding(
                                get: { branchNamingMode },
                                set: { save(.branchNamingMode($0)) }
                            )) {
                                ForEach(BranchNamingMode.allCases, id: \.self) { Text($0.label).tag($0) }
                            }
                            .accessibilityIdentifier("environment-branch-naming")
                            if branchNamingMode == .static, let prefix = settings.branchNamePrefix {
                                BranchNamingTextSetting(title: "Branch prefix", value: prefix) {
                                    save(.branchNamePrefix($0))
                                }
                            }
                            if branchNamingMode == .custom, let instructions = settings.branchNameInstructions {
                                BranchNamingTextSetting(title: "Branch naming instructions", value: instructions, multiline: true) {
                                    save(.branchNameInstructions($0))
                                }
                            }
                        }
                    }
                    if let browserAccess = settings.enableAgentBrowserAccess {
                        Section("Agent behavior") {
                            Toggle("Agent browser access", isOn: Binding(
                                get: { browserAccess },
                                set: { save(.enableAgentBrowserAccess($0)) }
                            ))
                            .accessibilityIdentifier("environment-agent-browser-access")
                        }
                    }
                    if let updateChecks = settings.enableProviderUpdateChecks {
                        Section("Updates") {
                            Toggle("Check provider updates", isOn: Binding(
                                get: { updateChecks },
                                set: { save(.enableProviderUpdateChecks($0)) }
                            ))
                            .accessibilityIdentifier("environment-provider-update-checks")
                        }
                    }
                    if settings.autoResumeLimitedThreads != nil || settings.snoozeLimitedThreads != nil {
                        Section("Usage limits") {
                            if let autoResume = settings.autoResumeLimitedThreads {
                                Toggle("Auto-resume limited threads", isOn: Binding(
                                    get: { autoResume },
                                    set: { save(.autoResumeLimitedThreads($0)) }
                                ))
                                .accessibilityIdentifier("environment-auto-resume-limited-threads")
                            }
                            if let snooze = settings.snoozeLimitedThreads {
                                Toggle("Snooze limited threads", isOn: Binding(
                                    get: { snooze },
                                    set: { save(.snoozeLimitedThreads($0)) }
                                ))
                                .accessibilityIdentifier("environment-snooze-limited-threads")
                            }
                        }
                    }
                    if settings.storageCleanup != nil {
                        Section("Automatic storage cleanup") {
                            StorageCleanupControls(rules: settings.storageCleanupRules, includesLogs: true) { key, value in
                                if key.hasPrefix("worktree") {
                                    save(.worktreeCleanup(.object(["mode": .string("custom"), "rules": .object([key: value])])))
                                } else { save(.storageCleanup([key: value])) }
                            }
                        }
                    }
                    if environment?.supportsWorktreesDirectory == true, let directory = settings.worktreesDirectory {
                        Section {
                            BranchNamingTextSetting(title: "Worktrees directory", value: directory) {
                                save(.worktreesDirectory($0))
                            }
                            .accessibilityIdentifier("environment-worktrees-directory")
                        } header: {
                            Text("Worktree storage")
                        } footer: {
                            Text("Path on this environment. Leave empty to use its default worktrees folder. Existing worktrees stay in their current locations.")
                        }
                    }
                    if settings.supportsWorktreeSubmodules {
                        Section("Worktrees") {
                            Picker("Submodules", selection: Binding(
                                get: { settings.worktreeSubmodules?.rawValue ?? "" },
                                set: { save(.worktreeSubmodules(WorktreeSubmodules(rawValue: $0))) }
                            )) {
                                Text("Project configuration").tag("")
                                ForEach(WorktreeSubmodules.allCases, id: \.self) { Text($0.label).tag($0.rawValue) }
                            }
                        }
                    }
                    if let streamingMode = settings.responseStreamingMode {
                        Section {
                            ResponseStreamingPicker(title: "Streaming", selection: Binding(
                                get: { streamingMode },
                                set: { save(.responseStreamingMode($0)) }
                            ))
                            .accessibilityIdentifier("environment-response-streaming")
                        } header: {
                            Text("Responses")
                        } footer: {
                            if streamingMode == .token {
                                Text("Token streaming updates more often and can use more battery.")
                            }
                        }
                    }
                    if environment?.canCustomizeIcon == true {
                        Section("Environment") {
                            Picker("Icon", selection: Binding(
                                get: { settings.environmentIcon ?? "" },
                                set: { save(.environmentIcon($0.isEmpty ? nil : $0)) }
                            )) {
                                Text("Detected").tag("")
                                Text("Server").tag("server")
                                Text("Cloud").tag("cloud")
                                Text("Desktop").tag("desktop")
                                Text("Laptop").tag("laptop")
                                Text("Mac mini").tag("mac-mini")
                                Text("Mac Studio").tag("mac-studio")
                            }
                        }
                    }
                    if model.snapshot.preferencesByEnvironment?[environmentID]?.automaticSettlement != nil {
                        Section {
                            Picker("New threads", selection: Binding(
                                get: { settings.defaultThreadEnvMode },
                                set: { save(.defaultThreadEnvMode($0)) }
                            )) {
                                Text("Inherit from project").tag(nil as ServerThreadEnvironmentMode?)
                                Text("Local workspace").tag(ServerThreadEnvironmentMode.local as ServerThreadEnvironmentMode?)
                                Text("New worktree").tag(ServerThreadEnvironmentMode.worktree as ServerThreadEnvironmentMode?)
                            }
                            .accessibilityIdentifier("environment-default-workspace")
                            Toggle("Start worktrees from origin", isOn: Binding(
                                get: { settings.newWorktreesStartFromOrigin },
                                set: { save(.newWorktreesStartFromOrigin($0)) }
                            ))
                            if supportsRestartContinuation {
                                Toggle("Continue threads after restarts", isOn: Binding(
                                    get: { settings.continueThreadsAfterServerUpdate },
                                    set: { save(.continueThreadsAfterServerUpdate($0)) }
                                ))
                            }
                        } footer: {
                            Text("These preferences and automatic settlement apply to connected environments that support them. Projects, models and providers remain separate.")
                        }
                        if !mismatches.isEmpty {
                            Section("Different preferences") {
                                ForEach(mismatches, id: \.self) { Text($0) }
                                Button("Use this environment’s preferences") {
                                    save(.sharedPreferences(settings.sharedPatch(
                                        supportsRestartContinuation: supportsRestartContinuation
                                    )))
                                }
                            }
                        }
                    }
                }
                .disabled(!canWriteSettings)
                if !canWriteSettings {
                    Text("This connection cannot change settings.")
                }
            } else if errorMessage == nil {
                Text("Loading preferences…")
            }
            if let errorMessage {
                Section {
                    Text(errorMessage)
                    Button("Try again") { Task { await load() } }
                }
            }
        }
        .disabled(busy)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Preferences")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            routingPermission = try await model.client.gitHubRoutingPermission(environmentID: environmentID)
            settings = try await model.client.serverPreferences(environmentID: environmentID)
            mismatches = model.client.sharedPreferenceMismatches(environmentID: environmentID)
            errorMessage = nil
        } catch { errorMessage = "Could not load preferences. Check this connection." }
    }

    private func save(_ change: ServerSettingsChange) {
        guard !busy, canWriteSettings else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await model.client.updateServerPreferences(environmentID: environmentID, change: change)
                await load()
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private func saveRoutingPermission(_ permission: GitHubRoutingPermission) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await model.client.setGitHubRoutingPermission(environmentID: environmentID, permission: permission)
                routingPermission = permission
            } catch { errorMessage = "Could not save GitHub sharing." }
        }
    }
}
