import SwiftUI

struct MobileConnectionSetupView: View {
    @State private var serverURLString: String
    @State private var pairingToken: String = ""
    @State private var errorMessage: String?
    @State private var isConnecting = false

    let onConnect: (MobileServerConfiguration) async throws -> Void
    let onForget: (() async throws -> Void)?

    init(
        initialServerURLString: String = "",
        onConnect: @escaping (MobileServerConfiguration) async throws -> Void,
        onForget: (() async throws -> Void)? = nil
    ) {
        _serverURLString = State(initialValue: initialServerURLString)
        self.onConnect = onConnect
        self.onForget = onForget
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://macbook.local:3773", text: $serverURLString)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    SecureField("One-time pairing token", text: $pairingToken)
                        .textContentType(.oneTimeCode)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Connect to your Mac")
                } footer: {
                    Text("From this repo, run `bun apps/server/src/bin.ts auth pairing create --label \"iPhone\"` on your Mac, then paste the token here. If you installed the packaged CLI, `t3 auth pairing create --label \"iPhone\"` works too.")
                        .textSelection(.enabled)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await connect() }
                    } label: {
                        if isConnecting {
                            ProgressView()
                        } else {
                            Text("Pair and Sync")
                        }
                    }
                    .disabled(isConnecting)

                    if onForget != nil {
                        Button("Forget Saved Connection", role: .destructive) {
                            Task { await forget() }
                        }
                        .disabled(isConnecting)
                    }
                }
            }
            .navigationTitle("Set Up T3 Mobile")
        }
    }

    @MainActor
    private func connect() async {
        let trimmedServerURL = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPairingToken = pairingToken.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let baseURL = URL(string: trimmedServerURL), baseURL.scheme != nil, baseURL.host != nil else {
            errorMessage = "Enter the T3 Code server URL from your Mac, for example http://macbook.local:3773."
            return
        }
        guard !trimmedPairingToken.isEmpty else {
            errorMessage = "Paste a one-time pairing token from `bun apps/server/src/bin.ts auth pairing create --label \"iPhone\"`."
            return
        }

        isConnecting = true
        errorMessage = nil
        do {
            try await onConnect(
                MobileServerConfiguration(
                    baseURL: baseURL,
                    bootstrapCredential: trimmedPairingToken
                )
            )
        } catch {
            errorMessage = error.localizedDescription
        }
        isConnecting = false
    }

    @MainActor
    private func forget() async {
        guard let onForget else {
            return
        }
        isConnecting = true
        errorMessage = nil
        do {
            try await onForget()
        } catch {
            errorMessage = error.localizedDescription
        }
        isConnecting = false
    }
}

#Preview {
    MobileConnectionSetupView(
        initialServerURLString: "http://macbook.local:3773",
        onConnect: { _ in },
        onForget: {}
    )
}
