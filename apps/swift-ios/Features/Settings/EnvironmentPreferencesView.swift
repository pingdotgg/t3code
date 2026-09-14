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
            if let settings {
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
                            get: { settings.defaultThreadEnvMode.rawValue },
                            set: { save(.defaultThreadEnvMode($0 == "worktree" ? .worktree : .local)) }
                        )) {
                            Text("Local workspace").tag("local")
                            Text("New worktree").tag("worktree")
                        }
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
        busy = true
        Task {
            defer { busy = false }
            do {
                try await model.client.updateServerPreferences(environmentID: environmentID, change: change)
                await load()
            } catch { errorMessage = "Could not save preferences. Check this connection and try again." }
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
