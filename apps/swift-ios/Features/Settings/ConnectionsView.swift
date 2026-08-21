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
                LazyVStack(alignment: .leading, spacing: 28) {
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Text("DIRECT CONNECTIONS")
                    .font(T3Typography.eyebrow)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 0)
                Button("Add") { showingAddConnection = true }
                    .font(T3Typography.control)
                    .accessibilityIdentifier("connections-add-button")
            }

            if directEnvironments.isEmpty {
                emptyRow("No direct connections")
            } else {
                VStack(spacing: 0) {
                    Divider().overlay(T3Colors.separator)
                    ForEach(directEnvironments) { environment in
                        directConnectionRow(environment)
                        Divider().overlay(T3Colors.separator)
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

                    environmentLabel(
                        name: environment.name,
                        isOnline: environment.connectionState == .connected
                    )

                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Toggle("Enabled", isOn: enabledBinding(for: environment))
                .labelsHidden()
                .tint(T3Colors.success)
                .disabled(pendingEnabledValues[environment.id] != nil)
                .accessibilityLabel("Enable \(environment.name)")
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Text("T3 CONNECT")
                    .font(T3Typography.eyebrow)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 0)
                Button("Manage") { showingT3Connect = true }
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
                    .frame(minHeight: 58)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .top) { Divider().overlay(T3Colors.separator) }
                    .overlay(alignment: .bottom) { Divider().overlay(T3Colors.separator) }
                } else if t3ConnectController?.account == nil {
                    emptyRow("Sign in to access your T3 Connect machines")
                } else {
                    emptyRow("No linked machines")
                }
            } else {
                VStack(spacing: 0) {
                    Divider().overlay(T3Colors.separator)
                    ForEach(t3ConnectRows) { item in
                        t3ConnectConnectionRow(item)
                        Divider().overlay(T3Colors.separator)
                    }
                }
            }

            Text("Turn on any online machine to use it on this iPhone.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
                .padding(.top, 2)
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
                } else {
                    t3ConnectEnvironmentLabel(item)
                }
            }

            Toggle("Enabled", isOn: t3ConnectEnabledBinding(for: item))
                .labelsHidden()
                .tint(T3Colors.success)
                .disabled(isT3ConnectToggleDisabled(item))
                .accessibilityLabel("Enable \(item.name)")
        }
        .frame(minHeight: 70)
    }

    private func t3ConnectEnvironmentLabel(
        _ item: T3ConnectEnvironmentPresentation
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: 25)

            environmentLabel(name: item.name, isOnline: item.isOnline)
            Spacer(minLength: 8)
        }
        .contentShape(Rectangle())
    }

    private func environmentLabel(name: String, isOnline: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(name)
                .font(T3Typography.homeTitle)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)

            HStack(spacing: 6) {
                Circle()
                    .fill(isOnline ? T3Colors.success : T3Colors.danger)
                    .frame(width: 7, height: 7)
                Text(isOnline ? "Online" : "Offline")
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
        }
    }

    private func emptyRow(_ message: String) -> some View {
        Text(message)
            .font(T3Typography.threadBody)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: 58)
            .overlay(alignment: .top) { Divider().overlay(T3Colors.separator) }
            .overlay(alignment: .bottom) { Divider().overlay(T3Colors.separator) }
    }

    private var accessSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ACCESS")
                .font(T3Typography.eyebrow)
                .foregroundStyle(T3Colors.textSecondary)
            Button {
                showingDevices = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(T3Colors.accent)
                        .frame(width: 25)
                    Text("Devices and sessions")
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                }
                .frame(minHeight: 54)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .overlay(alignment: .top) { Divider().overlay(T3Colors.separator) }
            .overlay(alignment: .bottom) { Divider().overlay(T3Colors.separator) }
        }
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
                    LabeledContent("Status", value: environment.status.title)
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

private extension FeatureEnvironment {
    var status: ConnectionStatusPresentation {
        guard isEnabled else {
            return ConnectionStatusPresentation(title: "Off", color: T3Colors.textTertiary)
        }
        switch connectionState {
        case .connected:
            return ConnectionStatusPresentation(title: "Online", color: T3Colors.success)
        case .connecting, .reconnecting:
            return ConnectionStatusPresentation(title: "Connecting", color: T3Colors.warning)
        case .disconnected:
            return ConnectionStatusPresentation(title: "Unreachable", color: T3Colors.danger)
        case nil:
            return ConnectionStatusPresentation(title: "Checking", color: T3Colors.textTertiary)
        }
    }
}

private struct ConnectionStatusPresentation {
    let title: String
    let color: Color
}
