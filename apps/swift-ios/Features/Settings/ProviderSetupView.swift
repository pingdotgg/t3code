import SwiftUI

struct ProviderSetupContext {
    let model: FeatureRootModel
    let environmentID: String
}

private struct ProviderSetupContextKey: EnvironmentKey {
    static let defaultValue: ProviderSetupContext? = nil
}

extension EnvironmentValues {
    var providerSetupContext: ProviderSetupContext? {
        get { self[ProviderSetupContextKey.self] }
        set { self[ProviderSetupContextKey.self] = newValue }
    }
}

struct ProvidersSettingsView: View {
    @Bindable var model: FeatureRootModel
    var environmentID: String?

    var body: some View {
        List {
            ForEach(model.snapshot.environments.filter { environmentID == nil || $0.id == environmentID }) { environment in
                Section(environment.name) {
                    let providers = model.snapshot.providersByEnvironment?[environment.id] ?? []
                    if providers.isEmpty { Text("Connect this environment to load providers.") }
                    ForEach(providers) { provider in
                        NavigationLink {
                            ProviderSetupView(model: model, environmentID: environment.id, instanceID: provider.id)
                        } label: {
                            HStack(spacing: 12) {
                                ProviderIcon(driver: provider.driver, providerID: provider.id, fallbackName: provider.name, size: 24)
                                VStack(alignment: .leading) {
                                    Text(provider.name)
                                    Text(provider.isAvailable ? "Ready" : provider.statusMessage ?? "Setup needed")
                                        .font(.caption).foregroundStyle(T3Colors.textSecondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Providers")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ProviderSetupView: View {
    @SwiftUI.Environment(\.openURL) private var openURL
    @Bindable var model: FeatureRootModel
    let environmentID: String
    let instanceID: String
    @State private var auth: ProviderAuthState?
    @State private var install: ProviderInstallState?
    @State private var callbackURL = ""
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var confirmSignOut = false
    @State private var confirmRemove = false

    private var provider: FeatureProvider? {
        model.snapshot.providersByEnvironment?[environmentID]?.first { $0.id == instanceID }
    }

    var body: some View {
        Form {
            if let provider {
                Section {
                    Text(provider.statusMessage ?? (provider.isAvailable ? "Ready" : "Setup needed"))
                    if provider.driver == "antigravity" {
                        Toggle("Enabled", isOn: Binding(
                            get: { provider.isEnabled == true },
                            set: { enabled in
                                Task {
                                    busy = true
                                    defer { busy = false }
                                    do {
                                        try await model.client.setProviderEnabled(environmentID: environmentID, instanceID: instanceID, enabled: enabled)
                                        _ = await model.refreshProviders(environmentID: environmentID)
                                    } catch { errorMessage = "Could not change provider settings." }
                                }
                            }
                        ))
                    }
                }
                if provider.setup?.canInstall == true {
                    Section("Runtime") {
                        if let install, install.isActive {
                            Text(install.phase.capitalized)
                            if let total = install.totalBytes, total > 0 {
                                ProgressView(value: Double(install.downloadedBytes), total: Double(total))
                            }
                            if let operationID = install.operationId {
                                Button("Cancel installation") { run(.cancelInstall(operationID: operationID)) }
                            }
                        } else {
                            Button(provider.isInstalled == true ? "Reinstall runtime" : "Install runtime") { run(.install) }
                            if install?.canRemove == true {
                                Button("Remove runtime", role: .destructive) { confirmRemove = true }
                            }
                        }
                        if let message = install?.message { Text(message).font(.footnote) }
                    }
                }
                if provider.setup?.canAuthenticate == true {
                    Section("Account") {
                        if provider.authStatus == "authenticated"
                            || (provider.isEnabled == false && provider.authStatus == "unknown") {
                            if provider.authStatus == "authenticated" { Text("Signed in") }
                            Button("Sign out", role: .destructive) { confirmSignOut = true }
                        } else if let auth, auth.isActive {
                            if let rawURL = auth.authorizationUrl, let url = URL(string: rawURL), url.scheme == "https" {
                                Button("Open sign-in page") { openURL(url) }
                            }
                            if let flowID = auth.flowId {
                                TextField("Paste the return URL", text: $callbackURL, axis: .vertical)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .privacySensitive()
                                Button("Finish sign-in") {
                                    let url = callbackURL.trimmingCharacters(in: .whitespacesAndNewlines)
                                    callbackURL = ""
                                    run(.completeSignIn(flowID: flowID, callbackURL: url))
                                }.disabled(callbackURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                Button("Cancel sign-in") { callbackURL = ""; run(.cancelSignIn(flowID: flowID)) }
                            }
                        } else {
                            Button("Sign in") { run(.signIn) }
                                .disabled(provider.isEnabled == false || provider.isInstalled == false)
                        }
                        if auth?.phase != "succeeded", let message = auth?.message { Text(message).font(.footnote) }
                    }
                }
                if provider.setup == nil {
                    Section { Text("Configure this provider on its computer.") }
                }
                Section { Button("Refresh models") { Task { _ = await model.refreshProviders(environmentID: environmentID) } } }
                Section { Text("Runtime and credentials stay on this environment.").font(.footnote) }
            }
            if let errorMessage { Section { Text(errorMessage).foregroundStyle(T3Colors.textSecondary) } }
        }
        .disabled(busy)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle(provider?.name ?? "Provider")
        .navigationBarTitleDisplayMode(.inline)
        .tint(T3Colors.accent)
        .task(id: instanceID) {
            do {
                for try await event in model.client.providerSetupEvents(environmentID: environmentID, instanceID: instanceID) {
                    receive(event)
                }
            } catch is CancellationError {} catch { errorMessage = "Could not load provider setup. Check this connection and its permissions." }
        }
        .onDisappear { callbackURL = "" }
        .confirmationDialog("Sign out on this environment?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { run(.signOut) }
        }
        .confirmationDialog("Remove the runtime from this environment?", isPresented: $confirmRemove) {
            Button("Remove runtime", role: .destructive) { run(.remove) }
        }
    }

    private func receive(_ event: ProviderSetupEvent) {
        switch event {
        case let .auth(state): auth = state
        case let .install(state): install = state
        }
    }

    private func run(_ action: ProviderSetupAction) {
        Task {
            busy = true
            errorMessage = nil
            defer { busy = false }
            do {
                receive(try await model.client.providerSetup(environmentID: environmentID, instanceID: instanceID, action: action))
            } catch {
                // Provider errors can contain callback URLs. Do not display or persist them.
                errorMessage = "Provider setup failed. Check the connection and try again."
            }
        }
    }
}
