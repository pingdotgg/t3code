import SwiftUI

struct AppRootView: View {
    @State private var credentialStore = MobileConnectionCredentialStore()
    @State private var configuration: MobileServerConfiguration?
    @State private var setupErrorMessage: String?
    @State private var isShowingSetup = false

    init() {
        let credentialStore = MobileConnectionCredentialStore()
        _credentialStore = State(initialValue: credentialStore)
        do {
            _configuration = State(initialValue: try credentialStore.loadConfiguration())
        } catch {
            _configuration = State(initialValue: nil)
            _setupErrorMessage = State(initialValue: error.localizedDescription)
        }
    }

    var body: some View {
        if let configuration {
            ShellView(
                configuration: configuration,
                onAuthenticatedBearerToken: rememberAuthenticatedSession,
                onConfigureConnection: {
                    isShowingSetup = true
                }
            )
            .sheet(isPresented: $isShowingSetup) {
                MobileConnectionSetupView(
                    initialServerURLString: credentialStore.savedServerURLString,
                    onConnect: applyPairingConfiguration,
                    onForget: forgetConnection
                )
            }
        } else {
            MobileConnectionSetupView(
                initialServerURLString: credentialStore.savedServerURLString,
                onConnect: applyPairingConfiguration
            )
            .overlay(alignment: .bottom) {
                if let setupErrorMessage {
                    Text(setupErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding()
                }
            }
        }
    }

    @MainActor
    private func applyPairingConfiguration(_ configuration: MobileServerConfiguration) async throws {
        try credentialStore.rememberPendingPairing(baseURL: configuration.baseURL)
        self.configuration = configuration
        setupErrorMessage = nil
        isShowingSetup = false
    }

    @MainActor
    private func rememberAuthenticatedSession(bearerToken: String, baseURL: URL) async throws {
        try credentialStore.rememberAuthenticatedSession(baseURL: baseURL, bearerToken: bearerToken)
        configuration = MobileServerConfiguration(baseURL: baseURL, bearerSessionToken: bearerToken)
    }

    @MainActor
    private func forgetConnection() async throws {
        try credentialStore.forget()
        configuration = nil
        setupErrorMessage = nil
        isShowingSetup = false
    }
}
