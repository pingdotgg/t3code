import Foundation
import Observation

/// Android serials repeat across hosts and environments. Keep all three parts.
struct FeatureRemoteDeviceID: Hashable, Sendable {
    let environmentID: String
    let hostID: String
    let deviceID: String
}

struct FeatureRemoteDevicePreview: Identifiable, Equatable, Sendable {
    let id: FeatureRemoteDeviceID
    let session: RemoteDeviceSession
    let name: String
    let detail: String
}

struct FeatureRemoteDeviceSnapshot: Equatable, Sendable {
    let environmentID: String
    let threadID: String
    let state: RemoteDeviceServiceState

    var previews: [FeatureRemoteDevicePreview] {
        state.sessions.filter { $0.threadId == threadID }.map { session in
            let device = state.devices.first { $0.hostId == session.hostId && $0.id == session.deviceId }
            let host = state.hosts.first { $0.id == session.hostId }
            return FeatureRemoteDevicePreview(
                id: .init(environmentID: environmentID, hostID: session.hostId, deviceID: session.deviceId),
                session: session,
                name: device?.name ?? (session.platform == .ios ? "iOS Simulator" : "Android Emulator"),
                detail: [device?.version, host?.label].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            )
        }
    }

    func selected(_ id: FeatureRemoteDeviceID?) -> FeatureRemoteDevicePreview? {
        previews.first { $0.id == id } ?? previews.first
    }
}

@MainActor
protocol FeatureRemoteDeviceManaging: AnyObject {
    func remoteDeviceStates(threadID: String) async throws -> AsyncThrowingStream<FeatureRemoteDeviceSnapshot, Error>
    func refreshRemoteDevices(threadID: String, retryHostID: String?, inspectOnly: Bool) async throws -> FeatureRemoteDeviceSnapshot
    func remoteDeviceHubAccess(threadID: String, device: FeatureRemoteDeviceID, hubBasePath: String) async throws -> RemoteDeviceHubAccess
    func shutDownRemoteDevice(threadID: String, device: FeatureRemoteDevicePreview) async throws
}

struct FeatureRemoteDeviceConnection: Identifiable, Equatable {
    let id = UUID()
    let preview: FeatureRemoteDevicePreview
    let access: RemoteDeviceHubAccess
}

@MainActor @Observable
final class FeatureRemoteDevicesModel {
    private(set) var snapshot: FeatureRemoteDeviceSnapshot?
    private(set) var connection: FeatureRemoteDeviceConnection?
    private(set) var error: String?
    private(set) var streamError: String?
    private(set) var inputConnected = false
    private(set) var streaming = false
    private(set) var shuttingDown = false
    private(set) var refreshing = false
    private(set) var unsupported = false
    var controlsVisible = true
    var selectedID: FeatureRemoteDeviceID?
    private(set) var attempt = 0
    @ObservationIgnored private var accessGeneration = 0
    @ObservationIgnored private var watchGeneration = 0
    @ObservationIgnored private var recoveredProcess = false
    @ObservationIgnored private var refreshedAuthorization = false
    @ObservationIgnored private let client: any FeatureRemoteDeviceManaging
    let threadID: String

    init(threadID: String, client: any FeatureRemoteDeviceManaging) {
        self.threadID = threadID
        self.client = client
    }

    var previews: [FeatureRemoteDevicePreview] { snapshot?.previews ?? [] }
    var selected: FeatureRemoteDevicePreview? { snapshot?.selected(selectedID) }

    private func apply(_ state: FeatureRemoteDeviceSnapshot) {
        let previous = selected?.id
        snapshot = state
        if previous != selected?.id {
            accessGeneration += 1
            connection = nil
            inputConnected = false
            streaming = false
            streamError = nil
            recoveredProcess = false
            refreshedAuthorization = false
        }
    }

    func watch() async {
        watchGeneration += 1
        let generation = watchGeneration
        error = nil
        unsupported = false
        do {
            let states = try await client.remoteDeviceStates(threadID: threadID)
            for try await state in states {
                guard !Task.isCancelled, watchGeneration == generation else { return }
                apply(state)
                error = nil
            }
        } catch {
            guard !Task.isCancelled, watchGeneration == generation else { return }
            unsupported = RemoteDeviceError.isUnsupported(error)
            self.error = unsupported ? RemoteDeviceError.unsupported.localizedDescription : error.localizedDescription
        }
    }

    /// A new ticket is acquired after selection, reload, foregrounding or rejection.
    /// Cancelled requests cannot restore a previous device's stream.
    func connect() async {
        accessGeneration += 1
        let generation = accessGeneration
        connection = nil
        inputConnected = false
        streaming = false
        streamError = nil
        guard let selected, let snapshot else { return }
        do {
            let access = try await client.remoteDeviceHubAccess(
                threadID: threadID, device: selected.id, hubBasePath: snapshot.state.hubBasePath
            )
            guard !Task.isCancelled, accessGeneration == generation, self.selected?.id == selected.id else { return }
            connection = .init(preview: selected, access: access)
        } catch {
            guard !Task.isCancelled, accessGeneration == generation else { return }
            streamError = error.localizedDescription
        }
    }

    func suspend() {
        accessGeneration += 1
        watchGeneration += 1
        connection = nil
        inputConnected = false
        streaming = false
    }

    func reload() {
        recoveredProcess = false
        refreshedAuthorization = false
        controlsVisible = true
        invalidateStream()
    }

    private func invalidateStream() {
        accessGeneration += 1
        connection = nil
        inputConnected = false
        streaming = false
        streamError = nil
        attempt += 1
    }

    func receive(_ message: RemoteDeviceStreamMessage, connectionID: UUID) {
        guard connection?.id == connectionID, streamError == nil else { return }
        switch message {
        case let .input(connected):
            inputConnected = connected
            if connected {
                controlsVisible = false
                if streaming { refreshedAuthorization = false }
            }
        case let .status(status, detail):
            streaming = status == .streaming
            if status == .streaming {
                recoveredProcess = false
                // A read-only session can receive video while input is refused.
                // Do not mint tickets forever for a missing operate scope.
                if inputConnected { refreshedAuthorization = false }
            } else if status == .error {
                failStream(detail ?? "Device stream failed.")
            }
        case .unauthorized:
            guard !refreshedAuthorization else {
                failStream("Device access was refused. Reconnect to try again.")
                return
            }
            refreshedAuthorization = true
            invalidateStream()
        case .retry: reload()
        }
    }

    func processTerminated(connectionID: UUID) {
        guard connection?.id == connectionID, streamError == nil else { return }
        guard !recoveredProcess else {
            failStream("Device viewer stopped. Reconnect to try again.")
            return
        }
        recoveredProcess = true
        invalidateStream()
    }

    func failStream(_ message: String) {
        inputConnected = false
        streaming = false
        streamError = message
        controlsVisible = true
    }

    func refresh(retryHostID: String? = nil, inspectOnly: Bool = false) async {
        guard !refreshing else { return }
        // An unscoped device.list can start helpers on every host.
        guard retryHostID != nil || inspectOnly else { return }
        if retryHostID != nil && snapshot?.state.supportsHostRetry != true { return }
        if inspectOnly && snapshot?.state.supportsToolInspection != true { return }
        refreshing = true
        defer { refreshing = false }
        do {
            let next = try await client.refreshRemoteDevices(
                threadID: threadID, retryHostID: retryHostID, inspectOnly: inspectOnly
            )
            guard !Task.isCancelled else { return }
            // A later subscription update can arrive before the command reply.
            if snapshot == nil || next.state.revision >= (snapshot?.state.revision ?? 0) { apply(next) }
            error = nil
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    func shutDown() async {
        guard let selected, !shuttingDown else { return }
        shuttingDown = true
        defer { shuttingDown = false }
        do {
            try await client.shutDownRemoteDevice(threadID: threadID, device: selected)
        } catch {
            if !Task.isCancelled { self.error = "Could not shut down device. \(error.localizedDescription)" }
        }
    }
}
