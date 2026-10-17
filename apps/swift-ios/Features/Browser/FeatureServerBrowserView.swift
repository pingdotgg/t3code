import SwiftUI

struct FeatureServerBrowserView: View {
    let threadID: String
    let client: any FeatureClient
    var initialTabID: String? = nil

    var body: some View {
        if let browserClient = client as? any FeatureServerBrowserManaging {
            ServerBrowserViewer(threadID: threadID, client: browserClient, initialTabID: initialTabID)
        } else {
            Text("Browser viewing is unavailable.").foregroundStyle(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(.black)
        }
    }
}

private struct ServerBrowserViewer: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @State private var model: FeatureServerBrowserModel
    @State private var controller = ServerBrowserStreamController()
    @State private var address: String?
    @State private var prompt = ""
    @State private var watchAttempt = 0

    init(threadID: String, client: any FeatureServerBrowserManaging, initialTabID: String?) {
        _model = State(initialValue: .init(threadID: threadID, client: client, initialTabID: initialTabID))
    }

    private struct StreamIdentity: Hashable {
        let tabID: String?
        let epoch: String?
        let active: Bool
        let attempt: Int
    }

    private var active: Bool { scenePhase == .active }
    private var identity: StreamIdentity {
        .init(tabID: model.selectedID, epoch: model.state?.serverEpoch, active: active, attempt: model.attempt)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let tab = model.selected {
                addressBar(tab)
                HStack {
                    Text(controlLabel).font(.caption)
                    Spacer()
                    if model.stream.canTakeControl {
                        Button("Take control") { send(.takeControl) }
                    } else if model.stream.ready {
                        Button("Release control") { send(.releaseControl) }
                    }
                }.padding(.horizontal).padding(.bottom, 8)
                if let dialog = model.stream.control?.dialog {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(dialog.message)
                        if dialog.type == "prompt" {
                            TextField("Response", text: $prompt).disabled(!model.stream.ready)
                        }
                        HStack {
                            Button("Dismiss") { send(.dialog(accept: false, text: "")) }
                            Button("Accept") { send(.dialog(accept: true, text: prompt)) }
                        }.disabled(!model.stream.ready)
                    }.padding().onChange(of: dialog) { _, next in prompt = next.defaultValue }
                        .onAppear { prompt = dialog.defaultValue }
                }
            }
            ZStack {
                Color.black
                if active, let connection = model.connection {
                    ServerBrowserStreamWebView(connection: connection, controller: controller) { message in
                        model.receive(message, connectionID: connection.id)
                    }.id(connection.id)
                }
                if let error = model.stream.error ?? model.error {
                    VStack(spacing: 12) {
                        Text(error)
                        if let setup = model.stream.hostSetup {
                            Text(setup.command).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                            Button("Copy command") { UIPasteboard.general.string = setup.command }
                        }
                        Button("Reconnect") { model.reload(); watchAttempt += 1 }
                    }.multilineTextAlignment(.center).padding().frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(.black)
                } else if !model.stream.streaming {
                    Text(model.loaded && model.count == 0 ? "No server browser tabs." : "Connecting to browser…")
                        .font(.callout)
                }
            }
        }
        .background(.black).foregroundStyle(.white).preferredColorScheme(.dark)
        .navigationTitle(model.selected?.title ?? "Browser").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if model.count > 1 {
                    Menu {
                        ForEach(model.tabs) { tab in
                            Button { address = nil; model.select(tab.id) } label: {
                                if model.selectedID == tab.id { Label(tab.title, systemImage: "checkmark") }
                                else { Text(tab.title) }
                            }
                        }
                    } label: { Label("\(model.count) tabs", systemImage: "square.on.square") }
                }
            }
        }
        .task(id: "\(active)-\(watchAttempt)") { if active { await model.watch() } }
        .task(id: identity) { if active { await model.connect() } }
        .onChange(of: active) { _, active in if !active { controller.stop(); model.suspend() } }
        .onChange(of: model.count) { _, count in if model.loaded && count == 0 { dismiss() } }
        .onChange(of: model.loaded) { _, loaded in if loaded && model.count == 0 { dismiss() } }
        .onChange(of: model.selectedID) { _, _ in address = nil }
        .onChange(of: model.stream.error) { _, error in if error != nil { controller.stop() } }
        .onChange(of: model.stream.gone) { _, gone in if gone { watchAttempt += 1 } }
        .onDisappear { controller.stop(); model.suspend() }
    }

    private var controlLabel: String {
        guard let control = model.stream.control else { return "Connecting…" }
        if !control.canOperate { return "Read-only" }
        switch control.controller {
        case .you: return "You have control"
        case .agent: return "Agent has control"
        case .anotherViewer: return "Another viewer has control"
        case .unclaimed: return "Watching"
        }
    }

    private func send(_ command: ServerBrowserStreamCommand) {
        controller.send(command, state: model.stream)
    }

    private func addressBar(_ tab: ServerBrowserTab) -> some View {
        HStack(spacing: 12) {
            Button { send(.history(-1)) } label: { Image(systemName: "chevron.left") }
                .accessibilityLabel("Back").disabled(!model.stream.ready || !tab.canGoBack)
            Button { send(.history(1)) } label: { Image(systemName: "chevron.right") }
                .accessibilityLabel("Forward").disabled(!model.stream.ready || !tab.canGoForward)
            TextField("Address", text: Binding(get: { address ?? tab.url }, set: { address = $0 }))
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.go).disabled(!model.stream.ready)
                .onSubmit {
                    let value = (address ?? tab.url).trimmingCharacters(in: .whitespacesAndNewlines)
                    let candidate = value.contains("://") ? value : "https://\(value)"
                    if let url = URL(string: candidate), let scheme = url.scheme,
                       ["http", "https"].contains(scheme), url.host != nil {
                        send(.navigate(url.absoluteString)); address = nil
                    }
                }
            Button { send(.reload) } label: { Image(systemName: "arrow.clockwise") }
                .accessibilityLabel("Reload").disabled(!model.stream.ready)
        }.padding()
    }
}
