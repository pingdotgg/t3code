import Foundation

extension T3Client {
    // These environment services use the same RPCs under V1 and V2.
    func remoteDeviceStates() async -> AsyncThrowingStream<RemoteDeviceServiceState, Error> {
        await rpc.subscribe("subscribeDeviceState", payload: .object([:]), as: RemoteDeviceServiceState.self)
    }

    func listRemoteDevices(retryHostID: String? = nil, inspectOnly: Bool = false) async throws -> RemoteDeviceServiceState {
        var payload: [String: JSONValue] = [:]
        if let retryHostID { payload["retryHostId"] = .string(retryHostID) }
        if inspectOnly { payload["inspectOnly"] = .bool(true) }
        return try await rpc.request("device.list", payload: .object(payload), as: RemoteDeviceServiceState.self)
    }

    func shutDownRemoteDevice(hostID: String, deviceID: String, platform: RemoteDevicePlatform) async throws {
        try await rpc.request("device.shutdown", payload: .object([
            "hostId": .string(hostID), "deviceId": .string(deviceID), "platform": .string(platform.rawValue),
        ]))
    }

    func remoteDeviceHubAccess(hostID: String, hubBasePath: String) async throws -> RemoteDeviceHubAccess {
        // EnvironmentAPI refreshes managed credentials and signs relay requests with DPoP.
        let ticket = try await api.webSocketTicket(for: environment)
        return try .ticketed(
            environmentURL: environment.httpBaseURL, hubBasePath: hubBasePath,
            hostID: hostID, ticket: ticket.ticket
        )
    }
}
