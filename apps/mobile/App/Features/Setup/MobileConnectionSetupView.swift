import SwiftUI

struct MobileConnectionSetupView: View {
    @State private var serverURLString: String
    @State private var pairingToken: String = ""
    @State private var errorMessage: String?
    @State private var scannerErrorMessage: String?
    @State private var isConnecting = false
    @State private var isShowingScanner = false

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
                    Button {
                        isShowingScanner = true
                    } label: {
                        Label("Connect", systemImage: "qrcode.viewfinder")
                    }
                    .disabled(isConnecting)
                } footer: {
                    Text("In T3 Code desktop, open Settings > Connections > Connect new device, then scan the QR code.")
                }

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
                    Text("Manual fallback")
                } footer: {
                    Text("Paste the fallback payload from the QR dialog, or enter the server URL and one-time token manually.")
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
        .sheet(isPresented: $isShowingScanner) {
            MobilePairingScannerSheet(
                onCancel: { isShowingScanner = false },
                scannerErrorMessage: scannerErrorMessage,
                onScannerSetupFailure: { message in
                    scannerErrorMessage = message
                },
                onScan: { payload in
                    isShowingScanner = false
                    scannerErrorMessage = nil
                    Task { await connect(scannedPayload: payload) }
                }
            )
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
    private func connect(scannedPayload: String) async {
        isConnecting = true
        errorMessage = nil
        do {
            let configuration = try MobilePairingPayload.configuration(from: scannedPayload)
            serverURLString = configuration.baseURL.absoluteString
            pairingToken = configuration.bootstrapCredential ?? ""
            try await onConnect(configuration)
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

private struct MobilePairingScannerSheet: View {
    let onCancel: () -> Void
    let scannerErrorMessage: String?
    let onScannerSetupFailure: (String) -> Void
    let onScan: (String) -> Void

    var body: some View {
        NavigationStack {
            ZStack {
                MobileQRCodeScannerView(
                    onScan: onScan,
                    onSetupFailure: onScannerSetupFailure
                )
                    .ignoresSafeArea()
                VStack {
                    Spacer()
                    VStack(spacing: 10) {
                        if let scannerErrorMessage {
                            Text(scannerErrorMessage)
                                .font(.callout)
                                .multilineTextAlignment(.center)
                                .foregroundStyle(.white)
                            Button("Enter manually", action: onCancel)
                                .buttonStyle(.borderedProminent)
                        } else {
                            Text("Scan the QR code from Settings > Connections.")
                                .font(.callout)
                                .foregroundStyle(.white)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 18))
                        .padding(.bottom, 32)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
    }
}

#Preview {
    MobileConnectionSetupView(
        initialServerURLString: "http://macbook.local:3773",
        onConnect: { _ in },
        onForget: {}
    )
}
