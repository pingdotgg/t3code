import Foundation

extension NativeFeatureClient: FeatureRemoteDeviceManaging {
    func remoteDeviceStates(threadID: String) async throws -> AsyncThrowingStream<FeatureRemoteDeviceSnapshot, Error> {
        let route = try threadRoute(for: threadID)
        await route.client.connect()
        let upstream = await route.client.remoteDeviceStates()
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor [weak self] in
                do {
                    for try await state in upstream {
                        try Task.checkCancellation()
                        guard let self else { break }
                        try self.validateRemoteDeviceRoute(threadID: threadID, route: route)
                        continuation.yield(.init(environmentID: route.environmentID, threadID: route.wireID, state: state))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func refreshRemoteDevices(threadID: String, retryHostID: String?, inspectOnly: Bool) async throws -> FeatureRemoteDeviceSnapshot {
        let route = try threadRoute(for: threadID)
        await route.client.connect()
        let state = try await route.client.listRemoteDevices(retryHostID: retryHostID, inspectOnly: inspectOnly)
        try validateRemoteDeviceRoute(threadID: threadID, route: route)
        return .init(environmentID: route.environmentID, threadID: route.wireID, state: state)
    }

    func remoteDeviceHubAccess(threadID: String, device: FeatureRemoteDeviceID, hubBasePath: String) async throws -> RemoteDeviceHubAccess {
        let route = try threadRoute(for: threadID)
        guard route.environmentID == device.environmentID else { throw RemoteDeviceError.sessionClosed }
        let access = try await route.client.remoteDeviceHubAccess(hostID: device.hostID, hubBasePath: hubBasePath)
        try validateRemoteDeviceRoute(threadID: threadID, route: route)
        return access
    }

    func shutDownRemoteDevice(threadID: String, device: FeatureRemoteDevicePreview) async throws {
        let route = try threadRoute(for: threadID)
        guard route.environmentID == device.id.environmentID,
              route.wireID == device.session.threadId else { throw RemoteDeviceError.sessionClosed }
        await route.client.connect()
        try validateRemoteDeviceRoute(threadID: threadID, route: route)
        try await route.client.shutDownRemoteDevice(
            hostID: device.id.hostID, deviceID: device.id.deviceID, platform: device.session.platform
        )
    }

    private func validateRemoteDeviceRoute(threadID: String, route: NativeThreadRoute) throws {
        let current = try threadRoute(for: threadID)
        guard current.environmentID == route.environmentID,
              current.wireID == route.wireID, current.client === route.client else {
            throw RPCError.disconnected
        }
    }
}
