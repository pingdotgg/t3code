import SwiftUI

struct ConnectionsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel

    @State private var pendingEnabledValues: [String: Bool] = [:]
    @State private var showingAddConnection = false
    @State private var showingDevices = false
    @State private var showingT3Connect = false
    @State private var detailEnvironmentID: String?
    @State private var removalTarget: FeatureEnvironment?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(T3Colors.border)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    connectionList
                    accountSection
                    accessSection
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 20)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(T3Colors.background)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showingAddConnection) {
            ConnectionOnboardingView(
                model: model,
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
                        onConnected: { await model.reloadAfterConnection() }
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
            Text("\(environment.name) will need a new pairing code to be added again.")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                dismiss()
            } label: {
                Label("Settings", systemImage: "chevron.left")
                    .labelStyle(.titleAndIcon)
            }
            .frame(width: 92, alignment: .leading)

            Spacer(minLength: 0)

            Text("Connections")
                .font(T3Typography.navigationTitle)
                .foregroundStyle(T3Colors.textPrimary)

            Spacer(minLength: 0)

            Button("Add") { showingAddConnection = true }
                .frame(width: 92, alignment: .trailing)
                .accessibilityIdentifier("connections-add-button")
        }
        .font(T3Typography.control)
        .foregroundStyle(T3Colors.accent)
        .padding(.horizontal, 20)
        .frame(minHeight: 54)
    }

    private var connectionList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(connectionSummary.uppercased())
                .font(T3Typography.eyebrow)
                .foregroundStyle(T3Colors.textSecondary)

            if model.snapshot.environments.isEmpty {
                Button {
                    showingAddConnection = true
                } label: {
                    Label("Add your first connection", systemImage: "plus")
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: 58)
                }
                .buttonStyle(.plain)
                .overlay(alignment: .bottom) { Divider().overlay(T3Colors.separator) }
            } else {
                VStack(spacing: 0) {
                    Divider().overlay(T3Colors.separator)
                    ForEach(model.snapshot.environments) { environment in
                        connectionRow(environment)
                        Divider().overlay(T3Colors.separator)
                    }
                }
            }

            Text("Disabled connections stay saved but stop network activity and disappear from new-task choices.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
                .padding(.top, 2)
        }
    }

    private func connectionRow(_ environment: FeatureEnvironment) -> some View {
        HStack(spacing: 12) {
            Button {
                detailEnvironmentID = environment.id
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: environment.source.systemImage)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(environment.source == .t3Connect
                            ? T3Colors.accent
                            : T3Colors.textSecondary)
                        .frame(width: 25)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(environment.name)
                            .font(T3Typography.homeTitle)
                            .foregroundStyle(T3Colors.textPrimary)
                            .lineLimit(1)

                        HStack(spacing: 6) {
                            Circle()
                                .fill(environment.status.color)
                                .frame(width: 7, height: 7)
                            Text(environment.status.title)
                            Text("·")
                            Text(environment.source.title)
                                .foregroundStyle(environment.source == .t3Connect
                                    ? T3Colors.accent
                                    : T3Colors.textSecondary)
                        }
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                    }

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

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("T3 CONNECT ACCOUNT")
                .font(T3Typography.eyebrow)
                .foregroundStyle(T3Colors.textSecondary)

            Button {
                showingT3Connect = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "cloud")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(T3Colors.accent)
                        .frame(width: 25)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(t3ConnectAccountTitle)
                            .font(T3Typography.threadBody)
                            .foregroundStyle(T3Colors.textPrimary)
                        Text(t3ConnectAccountDetail)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                }
                .frame(minHeight: 58)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.client is any T3ConnectCapable == false)
            .overlay(alignment: .top) { Divider().overlay(T3Colors.separator) }
            .overlay(alignment: .bottom) { Divider().overlay(T3Colors.separator) }
        }
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

    private var connectionSummary: String {
        let environments = model.snapshot.environments
        let online = environments.count {
            $0.isEnabled && $0.connectionState == .connected
        }
        return "\(environments.count) saved · \(online) online"
    }

    private var t3ConnectController: T3ConnectController? {
        (model.client as? any T3ConnectCapable)?.t3ConnectController
    }

    private var t3ConnectAccountTitle: String {
        t3ConnectController?.account?.email ?? "T3 Connect"
    }

    private var t3ConnectAccountDetail: String {
        guard let controller = t3ConnectController else { return "Unavailable in this build" }
        guard controller.account != nil else { return "Sign in or manage cloud connections" }
        let count = model.snapshot.environments.count { $0.source == .t3Connect }
        return "Signed in · \(count) \(count == 1 ? "connection" : "connections")"
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
            Text("A new pairing code will be required to add it again.")
        }
    }

    private var environment: FeatureEnvironment? {
        model.snapshot.environments.first { $0.id == environmentID }
    }

    private var projectCount: Int {
        model.snapshot.projects.count { $0.environmentID == environmentID }
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

    var systemImage: String {
        switch self {
        case .direct: "desktopcomputer"
        case .t3Connect: "cloud"
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
