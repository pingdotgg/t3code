import SwiftUI

public struct DevicesView: View {
    private let manager: any FeatureDeviceManaging

    @State private var sessions: [FeatureDeviceSession] = []
    @State private var isLoading = true
    @State private var isRevoking = false
    @State private var errorMessage: String?
    @State private var revokeTarget: FeatureDeviceSession?
    @State private var showingRevokeOthers = false

    public init(manager: any FeatureDeviceManaging) {
        self.manager = manager
    }

    public var body: some View {
        Group {
            if isLoading, sessions.isEmpty {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading devices")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            } else if let errorMessage, sessions.isEmpty {
                ContentUnavailableView {
                    Label("Couldn’t load devices", systemImage: "exclamationmark.circle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try again") {
                        Task { await reload() }
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else if sessions.isEmpty {
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
            if !otherSessions.isEmpty {
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
                    .disabled(isRevoking)
                    .accessibilityLabel("Device actions")
                }
            }
        }
        .task {
            await reload()
        }
        .alert(
            "Remove this device?",
            isPresented: Binding(
                get: { revokeTarget != nil },
                set: { if !$0 { revokeTarget = nil } }
            ),
            presenting: revokeTarget
        ) { device in
            Button("Remove access", role: .destructive) {
                Task { await revoke(device) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { device in
            Text("\(device.displayName) will need a new pairing code to reconnect.")
        }
        .confirmationDialog(
            "Remove all other devices?",
            isPresented: $showingRevokeOthers,
            titleVisibility: .visible
        ) {
            Button("Remove \(otherSessions.count) devices", role: .destructive) {
                Task { await revokeOthers() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every other phone, tablet, browser, and desktop will be signed out.")
        }
    }

    private var deviceList: some View {
        List {
            if let currentSession {
                Section("THIS DEVICE") {
                    DeviceSessionRow(session: currentSession)
                }
            }

            if !otherSessions.isEmpty {
                Section("OTHER DEVICES") {
                    ForEach(otherSessions) { session in
                        DeviceSessionRow(session: session)
                            .contentShape(Rectangle())
                            .swipeActions {
                                Button("Remove", role: .destructive) {
                                    revokeTarget = session
                                }
                            }
                            .contextMenu {
                                Button(role: .destructive) {
                                    revokeTarget = session
                                } label: {
                                    Label("Remove access", systemImage: "trash")
                                }
                            }
                    }
                }
            }

            if let errorMessage {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(errorMessage, systemImage: "exclamationmark.circle")
                            .font(T3Typography.control)
                            .foregroundStyle(.orange)
                        Button("Try again") {
                            Task { await reload() }
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
            await reload()
        }
        .overlay(alignment: .top) {
            if isRevoking {
                ProgressView()
                    .padding(.top, 12)
                    .accessibilityLabel("Updating device access")
            }
        }
    }

    private var currentSession: FeatureDeviceSession? {
        sessions.first(where: \.isCurrent)
    }

    private var otherSessions: [FeatureDeviceSession] {
        sessions.filter { !$0.isCurrent }
    }

    @MainActor
    private func reload() async {
        isLoading = true
        defer { isLoading = false }
        do {
            sessions = FeatureDeviceSession.sortedForDisplay(
                try await manager.loadDeviceSessions()
            )
            errorMessage = nil
        } catch {
            errorMessage = DeviceManagementErrorCopy.message(for: error)
        }
    }

    @MainActor
    private func revoke(_ session: FeatureDeviceSession) async {
        isRevoking = true
        defer {
            isRevoking = false
            revokeTarget = nil
        }
        do {
            try await manager.revokeDeviceSession(id: session.id)
            sessions.removeAll { $0.id == session.id }
            errorMessage = nil
        } catch {
            errorMessage = DeviceManagementErrorCopy.message(for: error)
        }
    }

    @MainActor
    private func revokeOthers() async {
        isRevoking = true
        defer { isRevoking = false }
        do {
            try await manager.revokeOtherDeviceSessions()
            sessions.removeAll { !$0.isCurrent }
            errorMessage = nil
        } catch {
            errorMessage = DeviceManagementErrorCopy.message(for: error)
        }
    }
}

private struct DeviceSessionRow: View {
    let session: FeatureDeviceSession

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: session.deviceType.systemImage)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(session.isCurrent ? .green : .secondary)
                .frame(width: 26, height: 26)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(session.displayName)
                        .font(T3Typography.homeTitle)
                    if session.isCurrent {
                        Text("Current")
                            .font(T3Typography.supportingStrong)
                            .foregroundStyle(.green)
                    } else if session.isConnected {
                        Text("Online")
                            .font(T3Typography.supportingStrong)
                            .foregroundStyle(.green)
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
