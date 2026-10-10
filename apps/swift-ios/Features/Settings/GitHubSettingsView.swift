import SwiftUI

struct GitHubSettingsView: View {
    @Bindable var model: FeatureRootModel
    let environmentID: String
    @State private var settings: ServerGitHubSettings?
    @State private var auth: SourceControlProviderAuth?
    @State private var tokenDrafts: [String: String] = [:]
    @State private var newHost = ""
    @State private var newToken = ""
    @State private var busy = false
    @State private var errorMessage: String?

    private var canWrite: Bool {
        model.snapshot.environments.first { $0.id == environmentID }?
            .permissions?.grants("settings:write") == true
    }

    var body: some View {
        Form {
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(T3Colors.danger) }
            }
            if let settings {
                ForEach(GitHubSettingsHosts.groups(settings: settings, auth: auth)) { host in
                    Section(host.host) {
                        Toggle("Enabled", isOn: Binding(
                            get: { host.settings.enabled },
                            set: { save(.host(host.host, .enabled($0))) }
                        ))
                        Picker("CLI account", selection: Binding(
                            get: { host.settings.account ?? "" },
                            set: { save(.host(host.host, .account($0.isEmpty ? nil : $0))) }
                        )) {
                            Text(host.activeAccount.map { "Default (\($0))" } ?? "Default")
                                .tag("")
                            ForEach(host.selectableAccounts, id: \.self) { account in
                                Text(account).tag(account)
                            }
                            if let pinned = host.settings.account,
                               !host.selectableAccounts.contains(pinned) {
                                Text("\(pinned) (unavailable)").tag(pinned)
                            }
                        }
                        if let pinned = host.settings.account,
                           !host.selectableAccounts.contains(pinned) {
                            Text("The selected login is unavailable. The server may use the active CLI login.")
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                        ForEach(Array(host.brokenAccounts.enumerated()), id: \.offset) { _, account in
                            Text("\(account.account): \(account.error ?? "Login failed")")
                                .foregroundStyle(T3Colors.danger)
                        }
                        if let variable = host.environmentVariable {
                            Text("\(variable) overrides the CLI account. A saved token takes priority.")
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                        if host.hasSavedToken {
                            LabeledContent("Token", value: "Saved on environment")
                            Button("Remove token", role: .destructive) {
                                save(.token(host: host.host, token: ""))
                            }
                        }
                        SecureField(host.hasSavedToken ? "Replacement token" : "GitHub token", text: Binding(
                            get: { tokenDrafts[host.host] ?? "" },
                            set: { tokenDrafts[host.host] = $0 }
                        ))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        Button("Save token") {
                            save(.token(host: host.host, token: tokenDrafts[host.host] ?? ""))
                        }
                        .disabled((tokenDrafts[host.host] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .disabled(busy || !canWrite)
                    .listRowBackground(T3Colors.background)
                }
                Section {
                    TextField("github.example.com", text: $newHost)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Token", text: $newToken)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Save token") { save(.token(host: newHost, token: newToken)) }
                        .disabled(GitHubSettingsHosts.normalize(newHost).isEmpty
                            || newToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: {
                    Text("Add host token")
                } footer: {
                    Text("Tokens are stored on this environment and work without the GitHub CLI. Disabled hosts do not use any credential.")
                }
                .disabled(busy || !canWrite)
                .listRowBackground(T3Colors.background)
                if !canWrite {
                    Section { Text("This connection has read-only GitHub settings.") }
                        .listRowBackground(T3Colors.background)
                }
            } else if busy {
                Text("Loading GitHub settings…")
            }
        }
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("GitHub")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .onDisappear {
            tokenDrafts.removeAll()
            newToken = ""
        }
    }

    private func load() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await reload()
            errorMessage = nil
        } catch is CancellationError {} catch { errorMessage = error.localizedDescription }
    }

    private func reload() async throws {
        settings = try await model.client.serverPreferences(environmentID: environmentID).github
        guard settings != nil else { throw FeatureCapabilityUnavailable("GitHub settings") }
        // Token settings still work when CLI discovery is unavailable.
        do {
            guard let projectClient = model.client as? any FeatureProjectCreationClient else {
                auth = nil
                return
            }
            let discovery = try await projectClient.discoverProjectSources(environmentID: environmentID)
            auth = discovery.sourceControlProviders.first { $0.kind == .github }?.auth
        } catch is CancellationError { throw CancellationError() } catch {
            auth = nil
        }
    }

    private func save(_ change: FeatureGitHubSettingsChange) {
        guard !busy, canWrite else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                try await model.client.updateGitHubSettings(environmentID: environmentID, change: change)
                // Never copy token drafts into settings, preferences, or model snapshots.
                if case let .token(host, _) = change {
                    tokenDrafts.removeValue(forKey: GitHubSettingsHosts.normalize(host))
                    newToken = ""
                    newHost = ""
                }
                try await reload()
                errorMessage = nil
            } catch is CancellationError {} catch { errorMessage = error.localizedDescription }
        }
    }
}
