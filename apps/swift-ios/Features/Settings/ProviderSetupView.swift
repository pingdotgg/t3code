import SwiftUI

struct ProviderSetupContext {
    let model: FeatureRootModel
    let environmentID: String
}

struct FeatureProviderAccountActions {
    let provider: FeatureProvider
    let auth: ProviderAuthState?

    var isSignedIn: Bool {
        provider.authStatus == "authenticated"
            || (provider.authStatus == "unknown" && auth?.phase == "succeeded")
    }

    var canChangeAccount: Bool {
        isSignedIn && auth?.isActive != true && provider.setup?.canAuthenticate != false
    }

    var canSignOut: Bool {
        isSignedIn && auth?.isActive != true && (provider.canLogout ?? provider.setup?.canAuthenticate) == true
    }
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
    @State private var credentialValues: [String: String] = [:]
    @State private var terminalInput = ""
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var confirmSignOut = false
    @State private var confirmRemove = false
    @State private var subscriptionRevision = 0
    @State private var authSubscriptionFailed = false

    private var provider: FeatureProvider? {
        model.snapshot.providersByEnvironment?[environmentID]?.first { $0.id == instanceID }
    }

    var body: some View {
        Form {
            if let provider {
                let accountActions = FeatureProviderAccountActions(provider: provider, auth: auth)
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
                if let advisory = provider.versionAdvisory {
                    Section("Updates") {
                        if let version = advisory.currentVersion { LabeledContent("Installed", value: version) }
                        if let message = provider.compatibilityAdvisory?.message { Text(message).font(.footnote) }
                        if let state = provider.updateState, state.status != "idle" {
                            Text(state.message ?? state.status.capitalized)
                        }
                        if provider.canUpdate {
                            Button("Update to \(advisory.latestVersion ?? "latest")") {
                                Task {
                                    busy = true
                                    defer { busy = false }
                                    do { try await model.client.updateProvider(environmentID: environmentID, instanceID: instanceID) }
                                    catch { errorMessage = "Could not update this provider. Refresh its status and try again." }
                                }
                            }
                        }
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
                if ProviderAccountDiscovery.isSupported(driver: provider.driver, installed: provider.isInstalled, setup: provider.setup) {
                    Section("Account") {
                        if let auth, auth.isActive {
                            if let rawURL = auth.interaction?.url ?? auth.authorizationUrl, let url = URL(string: rawURL), url.scheme == "https" {
                                Button("Open sign-in page") { openURL(url) }
                            }
                            if let interaction = auth.interaction, let flowID = auth.flowId {
                                authInteraction(interaction, flowID: flowID)
                            }
                            if let flowID = auth.flowId {
                                if auth.interaction?.acceptsCallback == true || (auth.interaction == nil && auth.authorizationUrl != nil) {
                                TextField("Paste the return URL", text: $callbackURL, axis: .vertical)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .privacySensitive()
                                Button("Finish sign-in") {
                                    let url = callbackURL.trimmingCharacters(in: .whitespacesAndNewlines)
                                    callbackURL = ""
                                    run(.completeSignIn(flowID: flowID, callbackURL: url))
                                }.disabled(callbackURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                }
                                Button("Cancel sign-in") { callbackURL = ""; run(.cancelSignIn(flowID: flowID)) }
                            }
                        } else if accountActions.isSignedIn {
                            Text("Signed in")
                            if accountActions.canChangeAccount {
                                if let methods = auth?.methods, methods.count > 1 {
                                    Menu("Change account") {
                                        ForEach(methods) { method in
                                            Button(method.name) { run(.signInMethod(method.id)) }
                                        }
                                    }
                                    .disabled(auth == nil || authSubscriptionFailed || provider.isEnabled == false || provider.isInstalled == false)
                                } else {
                                    Button("Change account") { run(.signIn) }
                                        .disabled(auth == nil || authSubscriptionFailed || provider.isEnabled == false || provider.isInstalled == false)
                                }
                            }
                            if accountActions.canSignOut {
                                Button("Sign out", role: .destructive) { confirmSignOut = true }
                                    .disabled(auth == nil || authSubscriptionFailed)
                            }
                            if authSubscriptionFailed {
                                Button("Retry sign-in discovery") { subscriptionRevision += 1 }
                            }
                        } else if authSubscriptionFailed {
                            Button("Retry sign-in discovery") { subscriptionRevision += 1 }
                        } else if ProviderAccountDiscovery.isDiscovering(driver: provider.driver, auth: auth) {
                            Text("Discovering sign-in methods…")
                        } else if ProviderAccountDiscovery.needsExternalSetup(driver: provider.driver, setup: provider.setup, auth: auth) {
                            Text("No in-app sign-in is available. Follow the provider’s setup instructions on this environment.")
                            if let rawURL = provider.setup?.documentationUrl,
                               let url = URL(string: rawURL), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                                Link("Open provider docs", destination: url)
                            }
                        } else {
                            if let methods = auth?.methods, !methods.isEmpty {
                                ForEach(methods) { method in
                                    Button(method.name) { run(.signInMethod(method.id)) }
                                }
                                .disabled(provider.isEnabled == false || provider.isInstalled == false)
                            } else {
                                Button("Sign in") { run(.signIn) }
                                    .disabled(provider.isEnabled == false || provider.isInstalled == false)
                            }
                        }
                        if auth?.phase != "succeeded", let message = auth?.message { Text(message).font(.footnote) }
                    }
                }
                if provider.setup == nil && !ProviderAccountDiscovery.isSupported(driver: provider.driver, installed: provider.isInstalled, setup: provider.setup) {
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
        .task(id: subscriptionKey) {
            auth = nil
            install = nil
            authSubscriptionFailed = false
            errorMessage = nil
            callbackURL = ""
            credentialValues = [:]
            terminalInput = ""
            do {
                for try await event in model.client.providerSetupEvents(environmentID: environmentID, instanceID: instanceID) {
                    try Task.checkCancellation()
                    receive(event)
                }
            } catch is CancellationError {} catch {
                guard !Task.isCancelled else { return }
                authSubscriptionFailed = true
                errorMessage = "Could not load provider setup. Check this connection and its permissions."
            }
        }
        .onDisappear { callbackURL = ""; credentialValues = [:]; terminalInput = "" }
        .onChange(of: auth?.interaction?.id) { callbackURL = ""; credentialValues = [:]; terminalInput = "" }
        .confirmationDialog("Sign out on this environment?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { run(.signOut) }
        }
        .confirmationDialog("Remove the runtime from this environment?", isPresented: $confirmRemove) {
            Button("Remove runtime", role: .destructive) { run(.remove) }
        }
    }

    private var subscriptionKey: String {
        "\(environmentID.utf8.count):\(environmentID)\(instanceID):\(provider?.isInstalled == true):\(subscriptionRevision)"
    }

    @ViewBuilder
    private func authInteraction(_ interaction: ProviderAuthInteraction, flowID: String) -> some View {
        switch interaction.type {
        case "deviceCode":
            if let code = interaction.userCode {
                LabeledContent("Sign-in code", value: code).textSelection(.enabled)
            }
        case "browser":
            if interaction.requiresConsent == true {
                Button("Continue sign-in") {
                    run(.respond(flowID: flowID, interactionID: interaction.id, response: .object([
                        "type": .string("browser"), "action": .string("accept"),
                    ])))
                }
            }
        case "credentials":
            ForEach(interaction.fields ?? []) { field in
                let value = Binding(get: { credentialValues[field.name] ?? "" }, set: { credentialValues[field.name] = $0 })
                if field.secret { SecureField(field.label, text: value) }
                else { TextField(field.label, text: value).textInputAutocapitalization(.never).autocorrectionDisabled() }
            }
            Button("Sign in") {
                let values = credentialValues.mapValues(JSONValue.string)
                credentialValues = [:]
                run(.respond(flowID: flowID, interactionID: interaction.id, response: .object([
                    "type": .string("credentials"), "values": .object(values),
                ])))
            }
        case "terminal":
            if let output = interaction.output { Text(output).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
            SecureField("Terminal response", text: $terminalInput)
            Button("Send response") {
                let data = terminalInput + "\n"
                terminalInput = ""
                run(.respond(flowID: flowID, interactionID: interaction.id, response: .object([
                    "type": .string("terminal"), "data": .string(data),
                ])))
            }
        default:
            Text("This sign-in method needs a newer app.")
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
