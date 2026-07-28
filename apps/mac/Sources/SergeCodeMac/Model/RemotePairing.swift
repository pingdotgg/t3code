import Foundation
import T3Kit

public enum RemotePairing {
    @MainActor
    public static func pair(
        pairingURL: String,
        deviceStore: RemoteDeviceStore = .init(),
        keychain: any KeychainStoreProtocol = KeychainStore()
    ) async throws -> RemoteDevice {
        let target = try PairingTarget.parse(pairingURL: pairingURL)
        let redemption = try await PairingClient.redeem(
            target: target,
            clientLabel: localClientLabel())

        // A link copied while both devices share a LAN may still advertise a
        // stable managed tunnel. Adopt it only after it independently answers
        // as the same environment, matching the mobile client's healing rule.
        let persistedBaseURL = await preferredReachableBaseURL(
            descriptor: redemption.descriptor,
            fallback: target.httpBaseURL)

        guard let host = persistedBaseURL.host else {
            throw PairingClientError.invalidURL(pairingURL)
        }
        let port = persistedBaseURL.port
            ?? (persistedBaseURL.scheme == "https" ? 443 : 80)
        let device = RemoteDevice(
            id: redemption.descriptor.environmentId,
            name: redemption.descriptor.label,
            host: host,
            port: port,
            pairedAt: Date(),
            sessionExpiresAt: Date().addingTimeInterval(TimeInterval(redemption.expiresIn)),
            scheme: persistedBaseURL.scheme ?? "http")

        try keychain.writeToken(
            redemption.accessToken,
            deviceID: device.id,
            label: "SergeCode remote: \(device.name)")
        deviceStore.upsert(device)
        return device
    }

    @MainActor
    public static func unpair(
        id: String,
        deviceStore: RemoteDeviceStore = .init(),
        keychain: any KeychainStoreProtocol = KeychainStore()
    ) throws {
        defer { deviceStore.remove(id: id) }
        try keychain.deleteToken(deviceID: id)
    }

    private static func localClientLabel() -> String {
        let host = Host.current()
        let label = host.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? host.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return label.flatMap { $0.isEmpty ? nil : $0 } ?? "SergeCode"
    }

    private static func preferredReachableBaseURL(
        descriptor: EnvironmentDescriptor,
        fallback: URL
    ) async -> URL {
        guard let endpoint = PairingEndpointSelection.preferredRemoteEndpoint(
            descriptor.advertisedEndpoints),
            let candidate = URL(string: endpoint.httpBaseUrl),
            candidate != fallback,
            let candidateDescriptor = try? await PairingClient.fetchDescriptor(
                httpBaseURL: candidate,
                requestTimeout: 3),
            candidateDescriptor.environmentId == descriptor.environmentId
        else { return fallback }
        return candidate
    }
}
