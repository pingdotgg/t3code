import Observation
import SwiftUI

/// Device access state. One access change runs at a time, and reloads that
/// overlap it are discarded, so a slow read cannot restore a removed device or
/// replace newer feedback.
@MainActor
@Observable
final class DevicesModel {
    private(set) var sessions: [FeatureDeviceSession] = []
    private(set) var isLoading = true
    private(set) var isRevoking = false
    private(set) var errorMessage: String?
    var revokeTarget: FeatureDeviceSession?

    let manager: any FeatureDeviceManaging
    private var loadGeneration: UInt64 = 0

    init(manager: any FeatureDeviceManaging) {
        self.manager = manager
    }

    var currentSession: FeatureDeviceSession? {
        sessions.first(where: \.isCurrent)
    }

    var otherSessions: [FeatureDeviceSession] {
        sessions.filter { !$0.isCurrent }
    }

    func reload() async {
        guard !isRevoking else { return }
        loadGeneration &+= 1
        let generation = loadGeneration
        isLoading = true
        do {
            let loaded = FeatureDeviceSession.sortedForDisplay(
                try await manager.loadDeviceSessions()
            )
            guard loadGeneration == generation else { return }
            sessions = loaded
            errorMessage = nil
        } catch {
            guard loadGeneration == generation else { return }
            errorMessage = DeviceManagementErrorCopy.message(for: error)
        }
        isLoading = false
    }

    func revoke(_ session: FeatureDeviceSession) async {
        await updateAccess(removing: { $0.id == session.id }) {
            try await manager.revokeDeviceSession(id: session.id)
        }
        revokeTarget = nil
    }

    func revokeOthers() async {
        await updateAccess(removing: { !$0.isCurrent }) {
            try await manager.revokeOtherDeviceSessions()
        }
    }

    private func updateAccess(
        removing shouldRemove: (FeatureDeviceSession) -> Bool,
        _ operation: () async throws -> Void
    ) async {
        guard !isRevoking else { return }
        // Reloads cannot start while access is changing, so only earlier reads are stale.
        loadGeneration &+= 1
        isLoading = false
        isRevoking = true
        defer { isRevoking = false }
        do {
            try await operation()
            sessions.removeAll(where: shouldRemove)
            errorMessage = nil
        } catch {
            errorMessage = DeviceManagementErrorCopy.message(for: error)
        }
    }
}

public struct DevicesView: View {
    @State private var model: DevicesModel
    @State private var showingRevokeOthers = false

    public init(manager: any FeatureDeviceManaging) {
        _model = State(initialValue: DevicesModel(manager: manager))
    }

    public var body: some View {
        Group {
            if model.isLoading, model.sessions.isEmpty {
                Text("Loading devices")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            } else if let errorMessage = model.errorMessage, model.sessions.isEmpty {
                ContentUnavailableView {
                    Label("Couldn’t load devices", systemImage: "exclamationmark.circle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try again") {
                        Task { await model.reload() }
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else if model.sessions.isEmpty {
                ContentUnavailableView {
                    Label("No devices found", systemImage: "laptopcomputer.and.iphone")
                } description: {
                    Text("Device sessions will appear here when this server supports access management.")
                }
            } else {
                deviceList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Devices")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !model.otherSessions.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button(role: .destructive) {
                            showingRevokeOthers = true
                        } label: {
                            Label("Remove all other devices", systemImage: "rectangle.stack.badge.minus")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(model.isRevoking)
                    .accessibilityLabel("Device actions")
                }
            }
        }
        .task {
            await model.reload()
        }
        .alert(
            "Remove this device?",
            isPresented: Binding(
                get: { model.revokeTarget != nil },
                set: { if !$0 { model.revokeTarget = nil } }
            ),
            presenting: model.revokeTarget
        ) { device in
            Button(model.manager.managesServerSessions ? "Remove access" : "Remove device", role: .destructive) {
                Task { await model.revoke(device) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { device in
            Text(
                model.manager.managesServerSessions
                    ? "\(device.displayName) will need a new pairing code to reconnect."
                    : "\(device.displayName) will stop receiving T3 Connect notifications."
            )
        }
        .confirmationDialog(
            "Remove all other devices?",
            isPresented: $showingRevokeOthers,
            titleVisibility: .visible
        ) {
            Button("Remove \(model.otherSessions.count) devices", role: .destructive) {
                Task { await model.revokeOthers() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                model.manager.managesServerSessions
                    ? "Every other phone, tablet, browser, and desktop will be signed out."
                    : "Other registered devices will stop receiving T3 Connect notifications."
            )
        }
    }

    private var deviceList: some View {
        List {
            if let currentSession = model.currentSession {
                Section {
                    DeviceSessionRow(session: currentSession)
                } header: {
                    sectionHeader("This device")
                }
            }

            if !model.otherSessions.isEmpty {
                Section {
                    ForEach(model.otherSessions) { session in
                        DeviceSessionRow(session: session)
                            .contentShape(Rectangle())
                            .swipeActions {
                                Button("Remove", role: .destructive) {
                                    model.revokeTarget = session
                                }
                                .disabled(model.isRevoking)
                            }
                            .contextMenu {
                                Button(role: .destructive) {
                                    model.revokeTarget = session
                                } label: {
                                    Label("Remove access", systemImage: "trash")
                                }
                                .disabled(model.isRevoking)
                            }
                    }
                } header: {
                    sectionHeader("Other devices")
                }
            }

            if let errorMessage = model.errorMessage {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(errorMessage, systemImage: "exclamationmark.circle")
                            .font(T3Typography.control)
                            .foregroundStyle(T3Colors.warning)
                        Button("Try again") {
                            Task { await model.reload() }
                        }
                        .font(T3Typography.control.weight(.semibold))
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .refreshable {
            await model.reload()
        }
        .overlay(alignment: .top) {
            if model.isRevoking {
                Text("Updating device access")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.top, 12)
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(T3Typography.navigationTitle)
            .foregroundStyle(T3Colors.textPrimary)
            .textCase(nil)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct DeviceSessionRow: View {
    let session: FeatureDeviceSession

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: session.deviceType.systemImage)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(session.isCurrent ? T3Colors.success : T3Colors.textSecondary)
                .frame(width: 26, height: 26)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(session.displayName)
                        .font(T3Typography.homeTitle)
                        .foregroundStyle(T3Colors.textPrimary)
                    if session.isCurrent {
                        Text("Current")
                            .font(T3Typography.supportingStrong)
                            .foregroundStyle(T3Colors.success)
                    } else if session.isConnected {
                        Text("Online")
                            .font(T3Typography.supportingStrong)
                            .foregroundStyle(T3Colors.success)
                    }
                }

                if !session.platformDescription.isEmpty {
                    Text(session.platformDescription)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }

                Text(lastSeenDescription)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)

                if let ipAddress = session.ipAddress, !ipAddress.isEmpty {
                    Text(ipAddress)
                        .font(T3Typography.tool)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
            Spacer(minLength: 8)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private var lastSeenDescription: String {
        if session.isConnected {
            return "Active now"
        }
        return "Last seen \(session.lastSeenAt.formatted(.relative(presentation: .named)))"
    }
}
