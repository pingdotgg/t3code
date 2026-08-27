import SwiftUI

struct ConnectionsView: View {
    @Bindable var model: FeatureRootModel

    @State private var pendingEnabledValues: [String: Bool] = [:]
    @State private var showingAddConnection = false
    @State private var showingDevices = false
    @State private var showingT3Connect = false
    @State private var detailEnvironmentID: String?
    @State private var removalTarget: FeatureEnvironment?
    @State private var connectingEnvironmentID: String?
    @State private var connectionErrorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 32) {
                    directConnectionsSection
                    t3ConnectSection
                    accessSection
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 20)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(T3Colors.background)
        .navigationTitle("Environments")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .t3NavigationChrome()
        .task {
            await t3ConnectController?.refresh()
        }
        .sheet(isPresented: $showingAddConnection) {
            ConnectionOnboardingView(
                model: model,
                showsT3ConnectOption: false,
                onConnected: {
                    showingAddConnection = false
                    Task { await model.reloadAfterConnection() }
                },
                onCancel: { showingAddConnection = false }
            )
        }
        .sheet(isPresented: $showingDevices) {
            NavigationStack {
                DevicesView(manager: deviceManager)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showingDevices = false }
                        }
                    }
            }
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingT3Connect) {
            if let capability = model.client as? any T3ConnectCapable {
                NavigationStack {
                    T3ConnectView(
                        capability: capability,
                        model: model,
                        purpose: .manage,
                        onUnlinked: { id in
                            await model.removeEnvironment(id)
                        }
                    )
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showingT3Connect = false }
                        }
                    }
                }
                .presentationDragIndicator(.visible)
            }
        }
        .sheet(
            isPresented: Binding(
                get: { detailEnvironmentID != nil },
                set: { if !$0 { detailEnvironmentID = nil } }
            )
        ) {
            if let id = detailEnvironmentID {
                NavigationStack {
                    ConnectionDetailView(
                        model: model,
                        environmentID: id,
                        pendingEnabledValues: $pendingEnabledValues,
                        onRemove: {
                            detailEnvironmentID = nil
                            Task { await model.removeEnvironment(id) }
                        }
                    )
                }
                .presentationDragIndicator(.visible)
            }
        }
        .alert(
            "Remove connection?",
            isPresented: Binding(
                get: { removalTarget != nil },
                set: { if !$0 { removalTarget = nil } }
            ),
            presenting: removalTarget
        ) { environment in
            Button("Remove", role: .destructive) {
                Task {
                    await model.removeEnvironment(environment.id)
                    removalTarget = nil
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { environment in
            Text(removalMessage(for: environment))
        }
        .alert(
            "T3 Connect",
            isPresented: Binding(
                get: { connectionErrorMessage != nil },
                set: { if !$0 { connectionErrorMessage = nil } }
            )
        ) {
            Button("OK") { connectionErrorMessage = nil }
        } message: {
            Text(connectionErrorMessage ?? "Something went wrong.")
        }
    }

    private var directConnectionsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text("Direct")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 0)
                Button("Add") { showingAddConnection = true }
                    .font(T3Typography.control)
                    .accessibilityIdentifier("connections-add-button")
            }

            if directEnvironments.isEmpty {
                emptyRow("No paired environments")
            } else {
                VStack(spacing: 0) {
                    ForEach(directEnvironments) { environment in
                        directConnectionRow(environment)
                    }
                }
            }
        }
    }

    private func directConnectionRow(_ environment: FeatureEnvironment) -> some View {
        HStack(spacing: 12) {
            Button {
                detailEnvironmentID = environment.id
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(width: 25)
                        .accessibilityHidden(true)

                    environmentLabel(
                        name: environment.name,
                        status: ConnectionHubPresentation.status(
                            for: environment,
                            pendingEnabled: pendingEnabledValues[environment.id]
                        ),
                        endpoint: directEndpointLabel(for: environment)
                    )

                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows connection details")

            Toggle("Enabled", isOn: enabledBinding(for: environment))
                .labelsHidden()
                .tint(T3Colors.success)
                .disabled(pendingEnabledValues[environment.id] != nil)
                .accessibilityLabel(
                    toggleAccessibilityLabel(
                        name: environment.name,
                        endpoint: directEndpointLabel(for: environment)
                    )
                )
        }
        .frame(minHeight: 70)
        .contextMenu {
            Button(role: .destructive) {
                removalTarget = environment
            } label: {
                Label("Remove connection", systemImage: "trash")
            }
        }
    }

    private var t3ConnectSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text("T3 Connect")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 0)
                Button(t3ConnectController?.account == nil ? "Sign in" : "Manage") {
                    showingT3Connect = true
                }
                .font(T3Typography.control)
                .disabled(t3ConnectCapability == nil)
                .accessibilityIdentifier("connections-manage-t3-connect-button")
            }

            if t3ConnectRows.isEmpty {
                if t3ConnectController?.isRefreshing == true {
                    HStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Checking T3 Connect")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    .frame(minHeight: 44)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else if t3ConnectCapability == nil {
                    emptyRow("T3 Connect unavailable")
                } else if t3ConnectController?.account == nil {
                    emptyRow("Sign in to see your environments")
                } else {
                    emptyRow("No linked environments")
                }
            } else {
                VStack(spacing: 0) {
                    ForEach(t3ConnectRows) { item in
                        t3ConnectConnectionRow(item)
                    }
                }
            }
        }
    }

    private func t3ConnectConnectionRow(
        _ item: T3ConnectEnvironmentPresentation
    ) -> some View {
        HStack(spacing: 12) {
            Group {
                if let environment = item.savedEnvironment {
                    Button {
                        detailEnvironmentID = environment.id
                    } label: {
                        t3ConnectEnvironmentLabel(item)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Shows connection details")
                } else {
                    t3ConnectEnvironmentLabel(item)
                }
            }

            Toggle("Enabled", isOn: t3ConnectEnabledBinding(for: item))
                .labelsHidden()
                .tint(T3Colors.success)
                .disabled(isT3ConnectToggleDisabled(item))
                .accessibilityHint(
                    item.savedEnvironment == nil && item.status == .offline
                        ? "Environment is offline"
                        : ""
                )
                .accessibilityLabel(
                    toggleAccessibilityLabel(
                        name: item.name,
                        endpoint: t3ConnectEndpointLabel(for: item)
                    )
                )
        }
        .frame(minHeight: 70)
    }

    private func t3ConnectEnvironmentLabel(
        _ item: T3ConnectEnvironmentPresentation
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "cloud")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: 25)
                .accessibilityHidden(true)

            environmentLabel(
                name: item.name,
                status: item.connectionStatus(
                    pendingEnabled: pendingEnabledValues[item.id],
                    isConnecting: connectingEnvironmentID == item.id
                        || t3ConnectController?.busyEnvironmentID == item.id
                ),
                endpoint: t3ConnectEndpointLabel(for: item)
            )
            Spacer(minLength: 8)
        }
        .contentShape(Rectangle())
    }

    private func environmentLabel(
        name: String,
        status: ConnectionHubStatus,
        endpoint: String?
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(name)
                .font(T3Typography.homeTitle)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)

            HStack(spacing: 7) {
                Circle()
                    .fill(status.color)
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)

                Text(status.title)
                    .fixedSize(horizontal: true, vertical: false)

                if let endpoint {
                    Text(endpoint)
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func emptyRow(_ message: String) -> some View {
        Text(message)
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: 38)
    }

    private var accessSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Access")
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textSecondary)
            Button {
                showingDevices = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(T3Colors.accent)
                        .frame(width: 25)
                        .accessibilityHidden(true)
                    Text("Devices and sessions")
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 54)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func directEndpointLabel(for environment: FeatureEnvironment) -> String? {
        ConnectionHubPresentation.disambiguatingEndpoint(
            environment.endpoint,
            for: environment.name,
            among: directEnvironments.map(\.name)
        )
    }

    private func t3ConnectEndpointLabel(
        for item: T3ConnectEnvironmentPresentation
    ) -> String? {
        guard let endpoint = item.endpoint else { return nil }
        return ConnectionHubPresentation.disambiguatingEndpoint(
            endpoint,
            for: item.name,
            among: t3ConnectRows.map(\.name)
        )
    }

    private func toggleAccessibilityLabel(name: String, endpoint: String?) -> String {
        guard let endpoint else { return "Enable \(name)" }
        return "Enable \(name), \(endpoint)"
    }

    private func enabledBinding(for environment: FeatureEnvironment) -> Binding<Bool> {
        Binding(
            get: { pendingEnabledValues[environment.id] ?? environment.isEnabled },
            set: { enabled in
                pendingEnabledValues[environment.id] = enabled
                Task {
                    _ = await model.setEnvironmentEnabled(environment.id, enabled: enabled)
                    pendingEnabledValues[environment.id] = nil
                }
            }
        )
    }

    private func t3ConnectEnabledBinding(
        for item: T3ConnectEnvironmentPresentation
    ) -> Binding<Bool> {
        Binding(
            get: { pendingEnabledValues[item.id] ?? item.isEnabled },
            set: { enabled in
                pendingEnabledValues[item.id] = enabled
                Task { await setT3ConnectEnvironment(item, enabled: enabled) }
            }
        )
    }

    private func setT3ConnectEnvironment(
        _ item: T3ConnectEnvironmentPresentation,
        enabled: Bool
    ) async {
        defer {
            pendingEnabledValues[item.id] = nil
            if connectingEnvironmentID == item.id {
                connectingEnvironmentID = nil
            }
        }

        if let savedEnvironment = item.savedEnvironment {
            _ = await model.setEnvironmentEnabled(savedEnvironment.id, enabled: enabled)
            return
        }

        guard enabled,
              let linkedEnvironment = item.linkedEnvironment,
              let capability = t3ConnectCapability else { return }

        connectingEnvironmentID = item.id
        do {
            let credential = try await capability.t3ConnectController.credential(
                for: linkedEnvironment.environment
            )
            try await capability.connectT3Environment(credential)
            await model.reloadAfterConnection()
        } catch {
            connectionErrorMessage = error.localizedDescription
        }
    }

    private func isT3ConnectToggleDisabled(
        _ item: T3ConnectEnvironmentPresentation
    ) -> Bool {
        pendingEnabledValues[item.id] != nil
            || (connectingEnvironmentID != nil && connectingEnvironmentID != item.id)
            || t3ConnectController?.busyEnvironmentID != nil
            || (item.savedEnvironment == nil && item.status == .offline)
    }

    private var directEnvironments: [FeatureEnvironment] {
        ConnectionHubPresentation.directEnvironments(in: model.snapshot.environments)
    }

    private var t3ConnectRows: [T3ConnectEnvironmentPresentation] {
        ConnectionHubPresentation.t3ConnectEnvironments(
            saved: model.snapshot.environments,
            linked: t3ConnectController?.environments ?? []
        )
    }

    private var t3ConnectCapability: (any T3ConnectCapable)? {
        model.client as? any T3ConnectCapable
    }

    private var t3ConnectController: T3ConnectController? {
        t3ConnectCapability?.t3ConnectController
    }

    private func removalMessage(for environment: FeatureEnvironment) -> String {
        switch environment.source {
        case .direct:
            "\(environment.name) will need a new pairing code to be added again."
        case .t3Connect:
            "\(environment.name) will remain linked to your T3 Connect account."
        }
    }

    private var deviceManager: any FeatureDeviceManaging {
        (model.client as? any FeatureDeviceManaging) ?? EmptyFeatureDeviceManager.shared
    }
}

private struct ConnectionDetailView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let environmentID: String
    @Binding var pendingEnabledValues: [String: Bool]
    let onRemove: () -> Void

    @State private var showingRemoval = false

    var body: some View {
        List {
            if let environment {
                Section {
                    Toggle("Enabled", isOn: enabledBinding(for: environment))
                        .tint(T3Colors.success)
                        .disabled(pendingEnabledValues[environment.id] != nil)
                    LabeledContent(
                        "Status",
                        value: ConnectionHubPresentation.status(
                            for: environment,
                            pendingEnabled: pendingEnabledValues[environment.id]
                        ).title
                    )
                    LabeledContent("Connection", value: environment.source.title)
                }

                Section("Server") {
                    Text(environment.endpoint)
                        .textSelection(.enabled)
                    LabeledContent("Projects", value: "\(projectCount)")
                }

                Section {
                    Button("Remove connection", role: .destructive) {
                        showingRemoval = true
                    }
                }
            } else {
                ContentUnavailableView("Connection removed", systemImage: "network.slash")
            }
        }
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle(environment?.name ?? "Connection")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .confirmationDialog(
            "Remove this connection?",
            isPresented: $showingRemoval,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive, action: onRemove)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(removalMessage)
        }
    }

    private var environment: FeatureEnvironment? {
        model.snapshot.environments.first { $0.id == environmentID }
    }

    private var projectCount: Int {
        model.snapshot.projects.count { $0.environmentID == environmentID }
    }

    private var removalMessage: String {
        guard environment?.source == .t3Connect else {
            return "A new pairing code will be required to add it again."
        }
        return "It will remain linked to your T3 Connect account."
    }

    private func enabledBinding(for environment: FeatureEnvironment) -> Binding<Bool> {
        Binding(
            get: { pendingEnabledValues[environment.id] ?? environment.isEnabled },
            set: { enabled in
                pendingEnabledValues[environment.id] = enabled
                Task {
                    _ = await model.setEnvironmentEnabled(environment.id, enabled: enabled)
                    pendingEnabledValues[environment.id] = nil
                }
            }
        )
    }
}

private extension FeatureEnvironment.Source {
    var title: String {
        switch self {
        case .direct: "Direct"
        case .t3Connect: "T3 Connect"
        }
    }

}

private extension ConnectionHubStatus {
    var color: Color {
        switch self {
        case .disabled, .checking: T3Colors.textTertiary
        case .connecting: T3Colors.warning
        case .offline: T3Colors.danger
        case .online: T3Colors.success
        }
    }
}
