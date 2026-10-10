import SwiftUI
import Observation

@MainActor
public protocol FeatureCloudPreferencesManaging: AnyObject {
    func cloudLinkState(environmentID: String) async throws -> EnvironmentCloudLinkState
    func setHoldWebhooksWhileOffline(environmentID: String, enabled: Bool) async throws -> EnvironmentCloudLinkState
}

@MainActor
@Observable
final class FeatureCloudWebhookPreferencesModel {
    let environmentID: String
    private let client: any FeatureCloudPreferencesManaging
    private var revision = 0
    private(set) var state: EnvironmentCloudLinkState?
    private(set) var saving = false
    private(set) var error: String?

    init(environmentID: String, client: any FeatureCloudPreferencesManaging) {
        self.environmentID = environmentID
        self.client = client
    }

    func load() async {
        guard !saving else { return }
        let revision = self.revision
        do {
            let result = try await client.cloudLinkState(environmentID: environmentID)
            try Task.checkCancellation()
            guard self.revision == revision else { return }
            state = result
            error = nil
        } catch {
            if !Task.isCancelled, self.revision == revision { self.error = error.localizedDescription }
        }
    }

    func setEnabled(_ enabled: Bool) async {
        guard !saving, state?.holdWebhooksWhileOffline != nil else { return }
        saving = true
        revision += 1
        defer { saving = false }
        do {
            state = try await client.setHoldWebhooksWhileOffline(environmentID: environmentID, enabled: enabled)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Mount inside the destination environment's Settings form.
public struct CloudWebhookPreferencesView: View {
    @Bindable private var root: FeatureRootModel
    private let environmentID: String

    public init(model: FeatureRootModel, environmentID: String) {
        root = model
        self.environmentID = environmentID
    }

    public var body: some View {
        if let client = root.client as? any FeatureCloudPreferencesManaging {
            CloudWebhookPreferencesSection(root: root, environmentID: environmentID, client: client)
                .id(environmentID)
        }
    }
}

private struct CloudWebhookPreferencesSection: View {
    @Bindable var root: FeatureRootModel
    let environmentID: String
    @State private var model: FeatureCloudWebhookPreferencesModel

    init(root: FeatureRootModel, environmentID: String, client: any FeatureCloudPreferencesManaging) {
        self.root = root
        self.environmentID = environmentID
        _model = State(initialValue: .init(environmentID: environmentID, client: client))
    }

    var body: some View {
        Section("Webhook delivery") {
            if let state = model.state {
                if let enabled = state.holdWebhooksWhileOffline {
                    Toggle("Hold webhooks while offline", isOn: Binding(
                        get: { enabled }, set: { value in Task { await model.setEnabled(value) } }
                    ))
                    .disabled(model.saving || !canWrite || !state.linked)
                    Text(state.linked
                         ? "T3 Connect can hold requests for up to 24 hours. Each task can set a shorter age limit."
                         : "Link this environment to T3 Connect to hold requests while offline.")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    Text("Update this environment to configure offline webhook delivery.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else if model.error == nil {
                Text("Loading webhook preferences…").foregroundStyle(.secondary)
            }
            if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(.red)
                Button("Retry") { Task { await model.load() } }.disabled(model.saving)
            }
        }
        .listRowBackground(Color.black)
        .task { await model.load() }
    }

    private var canWrite: Bool {
        guard let environment = root.snapshot.environments.first(where: { $0.id == environmentID }) else { return false }
        return environment.isEnabled && environment.connectionState != .disconnected
            && environment.connectionState != .needsPairing
            && environment.permissions?.grants("relay:write") == true
    }
}
