import SwiftUI

enum EnvironmentReleaseIndex {
    struct Release: Decodable {
        let tag_name: String
        let draft: Bool?
    }

    static func channel(_ version: String) -> String {
        if version.range(of: #"^[^-+]+-(nightly|preview)\.\d{8}\.\d+$"#, options: .regularExpression) != nil {
            return version.contains("-nightly.") ? "nightly" : "preview"
        }
        return "stable"
    }

    static func newest(_ releases: [Release], for current: String) -> String? {
        releases.lazy.filter { $0.draft != true }.compactMap { release -> String? in
            guard release.tag_name.range(of: #"^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil else { return nil }
            let version = String(release.tag_name.dropFirst())
            return channel(version) == channel(current) ? version : nil
        }.first
    }

    static func findUpdate(for current: String) async throws -> String? {
        var page = 1
        while true {
            try Task.checkCancellation()
            let url = URL(string: "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100&page=\(page)")!
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let releases = try JSONDecoder().decode([Release].self, from: data)
            if let version = newest(releases, for: current) {
                return version.compare(current, options: .numeric) == .orderedDescending ? version : nil
            }
            if releases.count < 100 { throw URLError(.cannotParseResponse) }
            page += 1
        }
    }
}

struct EnvironmentUpdatesView: View {
    @Bindable var model: FeatureRootModel
    let environmentID: String
    @State private var descriptor: EnvironmentDescriptor?
    @State private var targetVersion: String?
    @State private var busy = false
    @State private var notice: String?
    @State private var confirmUpdate = false

    private var supported: Bool {
        guard let descriptor else { return false }
        return (descriptor.orchestrationProtocolVersion ?? 1) <= OrchestrationProtocolVersion.v2.rawValue
            && OutdatedHostUpdate.canSelfUpdate(descriptor)
    }

    var body: some View {
        Form {
            Section("T3 Code") {
                if let descriptor { LabeledContent("Installed", value: descriptor.serverVersion) }
                if busy { Label("Updating status…", systemImage: "arrow.clockwise") }
                if let targetVersion, supported {
                    Button("Update to \(targetVersion)") { confirmUpdate = true }
                }
                Button("Check for updates") { Task { await check() } }
                if let descriptor, !supported,
                   (descriptor.orchestrationProtocolVersion ?? 1) <= OrchestrationProtocolVersion.v2.rawValue {
                    Text("Update T3 Code on this computer.")
                }
                if let notice { Text(notice).font(.footnote) }
            }
            Section {
                NavigationLink("Provider updates") {
                    ProvidersSettingsView(model: model, environmentID: environmentID)
                }
                .disabled(descriptor?.orchestrationProtocolVersion != OrchestrationProtocolVersion.v2.rawValue)
            }
        }
        .disabled(busy)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Software updates")
        .navigationBarTitleDisplayMode(.inline)
        .task { await check() }
        .confirmationDialog("Update this environment?", isPresented: $confirmUpdate, titleVisibility: .visible) {
            Button("Update") { Task { await update() } }
        } message: {
            Text("The server or desktop app will restart. Running threads may be interrupted.")
        }
    }

    private func check() async {
        guard !busy else { return }
        busy = true
        notice = nil
        targetVersion = nil
        defer { busy = false }
        do {
            let current = try await model.client.environmentDescriptor(environmentID: environmentID)
            descriptor = current
            if let version = current.orchestrationProtocolVersion,
               version > OrchestrationProtocolVersion.v2.rawValue {
                throw OrchestrationProtocolError.unsupportedServerVersion(version)
            }
            targetVersion = try await EnvironmentReleaseIndex.findUpdate(for: current.serverVersion)
            if OutdatedHostUpdate.requiresHostUpdate(current) {
                notice = "Update T3 Code on this host to connect."
            } else if targetVersion == nil {
                notice = "Up to date."
            }
        } catch is CancellationError {} catch { notice = error.localizedDescription }
    }

    private func update() async {
        guard !busy, let targetVersion, supported else { return }
        busy = true
        notice = "Installing update and waiting for the host to return…"
        defer { busy = false }
        do {
            try await model.client.updateEnvironment(environmentID: environmentID, targetVersion: targetVersion)
            self.targetVersion = nil
            descriptor = try? await model.client.environmentDescriptor(environmentID: environmentID)
            notice = "Update installed."
            await model.reloadAfterConnection()
        } catch is CancellationError {} catch { notice = error.localizedDescription }
    }
}
