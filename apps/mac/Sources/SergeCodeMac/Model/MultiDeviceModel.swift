import Observation

@Observable
@MainActor
public final class RemoteDeviceSession: @MainActor Identifiable {
    public let descriptor: RemoteDeviceDescriptor
    public let model: AppModel

    public var id: DeviceID { descriptor.id }
    public var connection: ConnectionPhase { model.connection }

    public init(descriptor: RemoteDeviceDescriptor, model: AppModel) {
        self.descriptor = descriptor
        self.model = model
    }
}

@Observable
@MainActor
public final class MultiDeviceModel {
    public let local: AppModel
    public private(set) var remoteSessions: [RemoteDeviceSession]

    private let remoteDeviceStore: RemoteDeviceStore
    private let keychain: any KeychainStoreProtocol
    @ObservationIgnored private var hasStarted = false

    public init(
        local: AppModel,
        remoteSessions: [RemoteDeviceSession] = [],
        remoteDeviceStore: RemoteDeviceStore = .init(),
        keychain: any KeychainStoreProtocol = KeychainStore()
    ) {
        self.local = local
        self.remoteSessions = remoteSessions.filter { $0.id != .local }
        self.remoteDeviceStore = remoteDeviceStore
        self.keychain = keychain
    }

    /// The one selection shared by all device models. The getter derives the
    /// composite identity from the owning AppModel so its LRU and detail
    /// transition semantics remain entirely local to that model.
    public var selection: ThreadSelection? {
        get {
            if let threadID = local.selectedThreadID {
                return ThreadSelection(deviceID: .local, threadID: threadID)
            }
            for session in remoteSessions {
                if let threadID = session.model.selectedThreadID {
                    return ThreadSelection(deviceID: session.id, threadID: threadID)
                }
            }
            return nil
        }
        set {
            let selectedDeviceID = newValue?.deviceID
            local.selectedThreadID = selectedDeviceID == .local ? newValue?.threadID : nil
            for session in remoteSessions {
                session.model.selectedThreadID =
                    selectedDeviceID == session.id ? newValue?.threadID : nil
            }
        }
    }

    public var activeModel: AppModel {
        selection.flatMap { model(for: $0.deviceID) } ?? local
    }

    public var selectedThread: ChatThread? {
        activeModel.selectedThread
    }

    /// Snapshot of all models for lifecycle and shared-store wiring.
    public var allModels: [AppModel] {
        [local] + remoteSessions.map(\.model)
    }

    public func model(for deviceID: DeviceID) -> AppModel? {
        if deviceID == .local { return local }
        return remoteSessions.first { $0.id == deviceID }?.model
    }

    public func addSession(_ session: RemoteDeviceSession) {
        guard session.id != .local, model(for: session.id) == nil else { return }
        remoteSessions.append(session)
        if hasStarted {
            session.model.start()
        }
    }

    public func removeSession(id: DeviceID) async {
        guard id != .local, let index = remoteSessions.firstIndex(where: { $0.id == id }) else {
            return
        }
        if selection?.deviceID == id {
            selection = nil
        }
        let session = remoteSessions.remove(at: index)
        await session.model.shutdown()
    }

    /// Restart one already-mounted backend session.
    public func reconnect(id: DeviceID) async {
        guard hasStarted, let session = remoteSessions.first(where: { $0.id == id }) else {
            return
        }
        await session.model.shutdown()
        session.model.start()
    }

    public func start() {
        guard !hasStarted else { return }
        hasStarted = true
        local.start()
        restoreRemoteSessions()
        for session in remoteSessions {
            session.model.start()
        }
    }

    public func shutdown() async {
        hasStarted = false
        let models = allModels
        await withTaskGroup(of: Void.self) { group in
            for model in models {
                group.addTask {
                    await model.shutdown()
                }
            }
        }
    }

    /// Route a thread selection to its owning model and clear every other
    /// model's selection in the same MainActor transaction.
    public func select(threadID: String, on deviceID: DeviceID) {
        selection = ThreadSelection(deviceID: deviceID, threadID: threadID)
    }

    public func addRemoteDevice(pairingLink: String) async throws -> RemoteDeviceSession {
        let device = try await RemotePairing.pair(
            pairingURL: pairingLink,
            deviceStore: remoteDeviceStore,
            keychain: keychain)
        let session = makeRemoteSession(for: device)

        if let index = remoteSessions.firstIndex(where: { $0.id == session.id }) {
            if selection?.deviceID == session.id {
                selection = nil
            }
            let oldSession = remoteSessions[index]
            remoteSessions[index] = session
            await oldSession.model.shutdown()
        } else {
            remoteSessions.append(session)
        }

        if hasStarted {
            session.model.start()
        }
        return session
    }

    public func removeRemoteDevice(id: DeviceID) async {
        guard id != .local, let index = remoteSessions.firstIndex(where: { $0.id == id }) else {
            return
        }
        if selection?.deviceID == id {
            selection = nil
        }
        let session = remoteSessions.remove(at: index)
        await session.model.shutdown()
        try? RemotePairing.unpair(
            id: id.rawValue,
            deviceStore: remoteDeviceStore,
            keychain: keychain)
    }

    private func restoreRemoteSessions() {
        for device in remoteDeviceStore.all() {
            let id = DeviceID(rawValue: device.id)
            guard id != .local, model(for: id) == nil else { continue }
            remoteSessions.append(makeRemoteSession(for: device))
        }
    }

    private func makeRemoteSession(for device: RemoteDevice) -> RemoteDeviceSession {
        let id = DeviceID(rawValue: device.id)
        let descriptor = RemoteDeviceDescriptor(
            id: id,
            name: device.name,
            host: device.host,
            port: device.port,
            sessionExpiresAt: device.sessionExpiresAt)
        let backend = LiveBackend(mode: .remote(device: device, keychain: keychain))
        let model = AppModel(
            backend: backend,
            deviceID: id,
            deviceName: device.name,
            capabilities: .remote,
            dictation: local.dictation)
        return RemoteDeviceSession(descriptor: descriptor, model: model)
    }
}
