import SwiftUI

struct FeatureRemoteDevicesView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @State private var model: FeatureRemoteDevicesModel
    @State private var controller = RemoteDeviceStreamController()
    @State private var watchAttempt = 0
    @State private var showsToolVersions = false

    init(threadID: String, client: any FeatureRemoteDeviceManaging) {
        _model = State(initialValue: FeatureRemoteDevicesModel(threadID: threadID, client: client))
    }

    private struct StreamIdentity: Hashable {
        let device: FeatureRemoteDeviceID?
        let hubBasePath: String?
        let attempt: Int
        let foreground: Bool
    }

    private var isForeground: Bool { scenePhase != .background }

    private var streamIdentity: StreamIdentity {
        .init(device: model.selected?.id, hubBasePath: model.snapshot?.state.hubBasePath,
              attempt: model.attempt, foreground: isForeground)
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            stream
            if model.controlsVisible || model.selected == nil {
                controls
            } else {
                Button {
                    model.controlsVisible = true
                } label: {
                    Image(systemName: "chevron.compact.down")
                        .font(.title2).frame(width: 64, height: 36)
                }
                .accessibilityLabel("Show device controls")
                .accessibilityHint("Shaking the phone also shows them")
                .foregroundStyle(.white)
                .background(.black.opacity(0.7))
            }
        }
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .toolbar(.hidden, for: .navigationBar)
        .statusBarHidden(!model.controlsVisible && model.selected != nil)
        .interactiveDismissDisabled()
        .task(id: "\(isForeground)-\(watchAttempt)") {
            if isForeground { await model.watch() }
        }
        .task(id: streamIdentity) {
            if isForeground { await model.connect() }
        }
        .onChange(of: isForeground) { _, foreground in
            if !foreground {
                controller.stop()
                model.suspend()
            }
        }
        .onChange(of: model.snapshot?.previews.isEmpty) { wasEmpty, empty in
            if wasEmpty == false && empty == true { dismiss() }
        }
        .onChange(of: model.streamError) { _, error in
            if error != nil { controller.stop() }
        }
        .onDisappear {
            controller.stop()
            model.suspend()
        }
        .alert("Device tool versions", isPresented: $showsToolVersions) {
            Button("OK", role: .cancel) {}
        } message: { Text(toolVersionDescription) }
    }

    @ViewBuilder private var stream: some View {
        if isForeground, let connection = model.connection {
            RemoteDeviceStreamWebView(
                connection: connection, controller: controller,
                onMessage: { model.receive($0, connectionID: connection.id) },
                onProcessTerminated: { model.processTerminated(connectionID: connection.id) },
                onShake: { model.controlsVisible.toggle() }
            )
            .id(connection.id)
            .overlay {
                if !model.streaming {
                    status(message: model.streamError ?? "Connecting to device…", retry: model.streamError != nil)
                }
            }
        } else if model.selected != nil {
            status(message: model.streamError ?? "Connecting to device…", retry: model.streamError != nil)
        } else if let error = model.error {
            status(message: error, retry: !model.unsupported)
        } else if model.snapshot != nil {
            status(message: "No devices are open in this thread.", retry: false)
        } else {
            status(message: "Loading devices…", retry: false)
        }
    }

    private func status(message: String, retry: Bool) -> some View {
        VStack(spacing: 16) {
            Text(message).multilineTextAlignment(.center).textSelection(.enabled)
            if retry {
                Button("Reconnect") {
                    model.reload()
                    watchAttempt += 1
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
        .background(.black)
    }

    private var controls: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").frame(width: 36, height: 44)
                }.accessibilityLabel("Close device preview")
                Text(model.selected?.name ?? "Devices")
                    .font(.headline).lineLimit(1).frame(maxWidth: .infinity)
                Button { controller.send(.home) } label: {
                    Image(systemName: "house").frame(width: 36, height: 44)
                }
                .accessibilityLabel("Home")
                .disabled(!model.inputConnected)
                options
            }
            if let error = model.error, model.selected != nil {
                Text(error).font(.caption).textSelection(.enabled)
                Button("Retry") {
                    watchAttempt += 1
                }
            }
            if let host = selectedHost,
               let status = model.snapshot?.state.hostStatuses[host.id],
               status.status != "ready" && status.status != "idle" {
                Text(status.detail ?? "\(host.label): \(status.status)").font(.caption)
            }
        }
        .padding(.horizontal, 12)
        .background(.black.opacity(0.85))
    }

    private var options: some View {
        Menu {
            if model.previews.count > 1 {
                Section("Devices") {
                    ForEach(model.previews) { preview in
                        Button {
                            model.selectedID = preview.id
                            model.reload()
                        } label: {
                            Label(
                                preview.detail.isEmpty ? preview.name : "\(preview.name) · \(preview.detail)",
                                systemImage: preview.id == model.selected?.id ? "checkmark" : "iphone"
                            )
                        }
                    }
                }
            }
            if model.snapshot?.state.supportsHostRetry == true {
                ForEach(model.snapshot?.state.hosts ?? []) { host in
                    if model.snapshot?.state.hostStatuses[host.id]?.status == "failed" {
                        Button("Retry \(host.label)", systemImage: "arrow.clockwise") {
                            Task { await model.refresh(retryHostID: host.id) }
                        }.disabled(model.refreshing)
                    }
                }
            }
            if model.snapshot?.state.supportsToolInspection == true {
                Button("Check device tool versions", systemImage: "arrow.clockwise") {
                    Task { await model.refresh(inspectOnly: true) }
                }.disabled(model.refreshing)
            }
            Button("Device tool versions", systemImage: "info.circle") { showsToolVersions = true }
            Button("Reload stream", systemImage: "arrow.clockwise") { model.reload() }
                .disabled(model.selected == nil || model.shuttingDown)
            if model.selected?.session.platform == .android {
                Button("Back", systemImage: "arrow.left") { controller.send(.back) }
                    .disabled(!model.inputConnected)
            }
            Button("App switcher", systemImage: "square.on.square") { controller.send(.appSwitcher) }
                .disabled(!model.inputConnected)
            if model.selected?.session.platform == .ios {
                Button("Rotate device", systemImage: "rotate.right") { controller.send(.rotate) }
                    .disabled(!model.inputConnected)
            }
            Button(model.shuttingDown ? "Shutting down…" : "Shut down device", systemImage: "power", role: .destructive) {
                Task { await model.shutDown() }
            }.disabled(model.selected == nil || model.shuttingDown)
        } label: {
            Image(systemName: "ellipsis").frame(width: 36, height: 44)
        }.accessibilityLabel("Device options")
    }

    private var selectedHost: RemoteDeviceHost? {
        model.snapshot?.state.hosts.first { $0.id == model.selected?.id.hostID }
    }

    private var toolVersionDescription: String {
        let tools = selectedHost?.tools
        let policy: String
        if tools == nil {
            policy = "Versions have not been checked. Reconnect the host and check versions."
        } else if tools?.updatePending == true {
            policy = "Update pending. Required tools will install automatically when next used. The host needs network access."
        } else {
            policy = "Required tools install automatically when needed. Checking versions does not install or start anything."
        }
        return ([
            "This environment's T3 server chooses device tool versions for itself and its SSH hosts. Update that server to receive newer tools.",
            policy,
        ] + (tools?.labels ?? ["Device tool versions have not been checked."]) + [
            selectedHost?.toolInspectionError
                ?? model.snapshot?.state.hostStatuses[model.selected?.id.hostID ?? ""]?.detail ?? "",
        ]).filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
}
