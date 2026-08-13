import SwiftUI
import UIKit

public struct ConnectionOnboardingView: View {
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @Bindable private var model: FeatureRootModel

    private let readinessChecker: any ConnectionReadinessChecking
    private let onConnected: @MainActor () -> Void
    private let onCancel: (@MainActor () -> Void)?

    @State private var stage = ConnectionStage.welcome
    @State private var endpoint = ""
    @State private var pairingCode = ""
    @State private var errorMessage: String?
    @State private var showsPermissionAction = false
    @State private var showingScanner = false
    @State private var entryHeading = "Connect manually"
    @State private var connectionTask: Task<Void, Never>?
    @State private var connectionAttemptID: UUID?
    @FocusState private var focusedField: ConnectionField?

    public init(
        model: FeatureRootModel,
        onConnected: @escaping @MainActor () -> Void = {},
        onCancel: (@MainActor () -> Void)? = nil
    ) {
        self.model = model
        readinessChecker = LocalNetworkAccessChecker()
        self.onConnected = onConnected
        self.onCancel = onCancel
    }

    init(
        model: FeatureRootModel,
        readinessChecker: any ConnectionReadinessChecking,
        onConnected: @escaping @MainActor () -> Void = {},
        onCancel: (@MainActor () -> Void)? = nil
    ) {
        self.model = model
        self.readinessChecker = readinessChecker
        self.onConnected = onConnected
        self.onCancel = onCancel
    }

    public var body: some View {
        NavigationStack {
            Group {
                switch stage {
                case .welcome:
                    welcomeView
                case .details:
                    detailsView
                case .checking, .connecting:
                    progressView
                case .success:
                    successView
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T3Colors.background)
            .animation(.snappy(duration: 0.24), value: stage)
        }
        .toolbar {
            if stage == .welcome, let onCancel {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", action: onCancel)
                }
            } else if stage == .checking {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        cancelConnectionAttempt()
                        model.errorMessage = nil
                        stage = .details
                    }
                }
            }
        }
        .fullScreenCover(isPresented: $showingScanner) {
            QRCodeScannerView(
                onScan: { value in
                    showingScanner = false
                    applyConnectionString(
                        value,
                        heading: "Confirm connection",
                        connectAutomatically: true
                    )
                },
                onCancel: {
                    showingScanner = false
                },
                onPaste: {
                    showingScanner = false
                    pasteConnectionLink()
                }
            )
        }
        .onOpenURL { url in
            applyConnectionString(url.absoluteString, heading: "Confirm connection")
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active, showsPermissionAction {
                showsPermissionAction = false
                errorMessage = nil
            }
        }
        .interactiveDismissDisabled(stage == .connecting)
        .onDisappear {
            cancelConnectionAttempt()
        }
    }

    private var welcomeView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 48)

                Text("T3")
                    .font(.system(size: 34, weight: .black, design: .rounded))
                    .foregroundStyle(Color(red: 0.02, green: 0.74, blue: 0.5))
                    .accessibilityLabel("T3 Code")

                Text("Your agents,\nwherever you are.")
                    .font(.system(size: 38, weight: .bold, design: .default))
                    .tracking(-1.1)
                    .padding(.top, 24)

                Text("Connect securely to T3 Code running on your computer.")
                    .font(.body)
                    .foregroundStyle(T3Colors.textSecondary)
                    .padding(.top, 12)

                if let capability = model.client as? any T3ConnectCapable,
                   capability.t3ConnectController.unavailableReason == nil {
                    NavigationLink {
                        T3ConnectView(capability: capability) {
                            await model.reloadAfterConnection()
                            onConnected()
                        }
                    } label: {
                        Label("Continue with T3 Connect", systemImage: "cloud")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(ConnectionPrimaryButtonStyle())
                    .padding(.top, 36)
                    .accessibilityHint("Sign in to connect an environment linked to your T3 account")
                }

                VStack(spacing: 0) {
                    connectionAction(
                        title: "Scan QR code",
                        subtitle: "Pair directly with a computer nearby",
                        systemImage: "qrcode.viewfinder"
                    ) {
                        showingScanner = true
                    }

                    Divider().overlay(T3Colors.border)

                    connectionAction(
                        title: "Paste connection link",
                        subtitle: "Copy it from T3 Code on your computer",
                        systemImage: "doc.on.clipboard"
                    ) {
                        pasteConnectionLink()
                    }

                    Divider().overlay(T3Colors.border)

                    connectionAction(
                        title: "Enter details manually",
                        subtitle: "Use the server address and pairing code",
                        systemImage: "keyboard"
                    ) {
                        entryHeading = "Connect manually"
                        errorMessage = nil
                        stage = .details
                    }
                }
                .padding(.top, 12)

                knownEnvironments
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 40)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder
    private var knownEnvironments: some View {
        if !model.snapshot.environments.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text("KNOWN SERVERS")
                    .font(T3Typography.eyebrow)
                    .foregroundStyle(T3Colors.textSecondary)
                    .padding(.top, 34)
                    .padding(.bottom, 8)

                ForEach(model.snapshot.environments) { environment in
                    Button {
                        connect(
                            .activate(
                                id: environment.id,
                                endpoint: environment.endpoint
                            )
                        )
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "desktopcomputer")
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(environment.name)
                                    .font(T3Typography.threadBody)
                                    .foregroundStyle(.primary)
                                Text(environment.endpoint)
                                    .font(T3Typography.supporting)
                                    .foregroundStyle(T3Colors.textSecondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: "arrow.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                        .padding(.vertical, 12)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Reconnects to this server")

                    if environment.id != model.snapshot.environments.last?.id {
                        Divider().overlay(T3Colors.border)
                    }
                }
            }
        }
    }

    private var detailsView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(entryHeading)
                        .font(.largeTitle.bold())
                        .tracking(-0.6)
                    Text("Both values are shown in T3 Code when you create a mobile connection.")
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textSecondary)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("SERVER ADDRESS")
                        .font(T3Typography.eyebrow)
                        .foregroundStyle(T3Colors.textSecondary)

                    TextField("http://192.168.1.5:3773", text: $endpoint)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .endpoint)
                        .connectionInput()
                        .accessibilityLabel("Server address")
                        .onChange(of: endpoint) { _, value in
                            autofillIfPairingLink(value)
                        }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("PAIRING CODE")
                        .font(T3Typography.eyebrow)
                        .foregroundStyle(T3Colors.textSecondary)

                    TextField("12-character code", text: $pairingCode)
                        .textInputAutocapitalization(.never)
                        .textContentType(.oneTimeCode)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .pairingCode)
                        .connectionInput()
                        .accessibilityLabel("Pairing code")
                }

                Button {
                    pasteConnectionLink()
                } label: {
                    Label("Paste a connection link instead", systemImage: "doc.on.clipboard")
                        .font(T3Typography.control.weight(.semibold))
                }
                .buttonStyle(.plain)

                if let errorMessage {
                    connectionError(message: errorMessage)
                }

                Button {
                    submitDetails()
                } label: {
                    Text("Connect")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ConnectionPrimaryButtonStyle())
                .disabled(!canSubmit)
                .opacity(canSubmit ? 1 : 0.45)
            }
            .padding(.horizontal, 24)
            .padding(.top, 24)
            .padding(.bottom, 40)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Connect")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button {
                    errorMessage = nil
                    showsPermissionAction = false
                    focusedField = nil
                    stage = .welcome
                } label: {
                    Label("Back", systemImage: "chevron.left")
                }
            }
        }
    }

    private var progressView: some View {
        VStack(alignment: .leading, spacing: 34) {
            Spacer()

            Text(stage == .checking ? "Finding your T3" : "Connecting securely")
                .font(.largeTitle.bold())
                .tracking(-0.7)

            VStack(alignment: .leading, spacing: 20) {
                progressRow(
                    title: "Server details",
                    state: .complete
                )
                progressRow(
                    title: EndpointNetworkScope.isLocal(endpoint)
                        ? "Local network access"
                        : "Network access",
                    state: stage == .checking ? .active : .complete
                )
                progressRow(
                    title: "Secure pairing",
                    state: stage == .connecting ? .active : .waiting
                )
            }

            Spacer()

            Text("Keep T3 Code open on your computer.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .padding(.horizontal, 32)
        .padding(.vertical, 28)
        .frame(maxWidth: 520)
        .accessibilityElement(children: .contain)
    }

    private var successView: some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 54))
                .foregroundStyle(.green)
            Text("You're connected")
                .font(.title.bold())
            Text("Loading your projects and threads.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func connectionAction(
        title: String,
        subtitle: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.body.weight(.semibold))
                    Text(subtitle)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .foregroundStyle(.primary)
            .contentShape(Rectangle())
            .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
    }

    private func connectionError(message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message, systemImage: showsPermissionAction ? "network.slash" : "exclamationmark.circle")
                .font(T3Typography.control)
                .foregroundStyle(Color(red: 1, green: 0.58, blue: 0.2))

            if showsPermissionAction {
                Button("Open Settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                }
                .font(T3Typography.control.weight(.semibold))
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func progressRow(title: String, state: ProgressRowState) -> some View {
        HStack(spacing: 14) {
            Group {
                switch state {
                case .complete:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                case .active:
                    ProgressView()
                        .controlSize(.small)
                case .waiting:
                    Image(systemName: "circle")
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(width: 22)

            Text(title)
                .font(.body.weight(state == .active ? .semibold : .regular))
                .foregroundStyle(state == .waiting ? .secondary : .primary)
        }
    }

    private var canSubmit: Bool {
        !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @MainActor
    private func submitDetails() {
        do {
            let normalized = try ConnectionDetailsParser.normalizedEndpoint(endpoint)
            endpoint = normalized
            errorMessage = nil
            showsPermissionAction = false
            focusedField = nil
            connect(
                .pair(
                    endpoint: normalized,
                    code: pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
                )
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func pasteConnectionLink() {
        guard let value = UIPasteboard.general.string, !value.isEmpty else {
            entryHeading = "Connect manually"
            stage = .details
            errorMessage = "Copy a T3 pairing link first, or enter the details below."
            focusedField = .endpoint
            return
        }
        applyConnectionString(value, heading: "Confirm connection")
    }

    @MainActor
    private func applyConnectionString(
        _ value: String,
        heading: String,
        connectAutomatically: Bool = false
    ) {
        cancelConnectionAttempt()
        do {
            let details = try ConnectionDetailsParser.parse(value)
            endpoint = details.endpoint
            pairingCode = details.pairingCode ?? ""
            entryHeading = heading
            errorMessage = details.pairingCode == nil
                ? "The link did not include a pairing code. Enter it below."
                : nil
            showsPermissionAction = false
            if connectAutomatically, let code = details.pairingCode {
                focusedField = nil
                connect(.pair(endpoint: details.endpoint, code: code))
            } else {
                stage = .details
                focusedField = details.pairingCode == nil ? .pairingCode : nil
            }
        } catch {
            entryHeading = "Connect manually"
            errorMessage = error.localizedDescription
            stage = .details
            focusedField = .endpoint
        }
    }

    @MainActor
    private func autofillIfPairingLink(_ value: String) {
        guard let details = try? ConnectionDetailsParser.parse(value),
              let code = details.pairingCode
        else {
            return
        }
        endpoint = details.endpoint
        pairingCode = code
        errorMessage = nil
        focusedField = nil
    }

    @MainActor
    private func connect(_ action: ConnectionAction) {
        cancelConnectionAttempt()
        let attemptID = UUID()
        connectionAttemptID = attemptID
        endpoint = action.endpoint
        errorMessage = nil
        showsPermissionAction = false
        stage = .checking

        connectionTask = Task {
            let readiness = await readinessChecker.check(endpoint: action.endpoint)
            guard !Task.isCancelled, connectionAttemptID == attemptID else { return }
            switch readiness {
            case .ready:
                stage = .connecting
            case .localNetworkDenied:
                errorMessage = "Allow Local Network access so this iPhone can find T3 Code on your computer."
                showsPermissionAction = true
                stage = .details
                return
            case .unreachable:
                errorMessage = "This iPhone cannot reach that server. Confirm the address and that both devices are on the same network."
                stage = .details
                return
            }

            model.errorMessage = nil
            let didConnect: Bool
            switch action {
            case let .pair(endpoint, code):
                didConnect = await model.pair(endpoint: endpoint, token: code)
            case let .activate(id, _):
                didConnect = await model.setEnvironmentEnabled(id, enabled: true)
            }
            guard !Task.isCancelled, connectionAttemptID == attemptID else { return }

            if didConnect {
                connectionAttemptID = nil
                connectionTask = nil
                stage = .success
                onConnected()
            } else {
                let rawError = model.errorMessage
                model.errorMessage = nil
                errorMessage = ConnectionErrorCopy.message(for: rawError)
                connectionAttemptID = nil
                connectionTask = nil
                stage = .details
            }
        }
    }

    @MainActor
    private func cancelConnectionAttempt() {
        connectionTask?.cancel()
        connectionTask = nil
        connectionAttemptID = nil
    }
}

private enum ConnectionStage: Equatable {
    case welcome
    case details
    case checking
    case connecting
    case success
}

private enum ConnectionField: Hashable {
    case endpoint
    case pairingCode
}

private enum ProgressRowState {
    case complete
    case active
    case waiting
}

private enum ConnectionAction {
    case pair(endpoint: String, code: String)
    case activate(id: String, endpoint: String)

    var endpoint: String {
        switch self {
        case let .pair(endpoint, _), let .activate(_, endpoint):
            endpoint
        }
    }
}

private extension View {
    func connectionInput() -> some View {
        self
            .font(.body.monospaced())
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .background(T3Colors.input)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(T3Colors.inputBorder)
                    .frame(height: 1)
            }
    }
}

private struct ConnectionPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(T3Colors.primaryActionForeground)
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .background(
                configuration.isPressed
                    ? T3Colors.primaryAction.opacity(0.76)
                    : T3Colors.primaryAction
            )
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
