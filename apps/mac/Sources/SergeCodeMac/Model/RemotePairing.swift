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

        guard let host = target.httpBaseURL.host else {
            throw PairingClientError.invalidURL(pairingURL)
        }
        let port = target.httpBaseURL.port
            ?? (target.httpBaseURL.scheme == "https" ? 443 : 80)
        let device = RemoteDevice(
            id: redemption.descriptor.environmentId,
            name: redemption.descriptor.label,
            host: host,
            port: port,
            pairedAt: Date(),
            sessionExpiresAt: Date().addingTimeInterval(TimeInterval(redemption.expiresIn)),
            scheme: target.httpBaseURL.scheme ?? "http")

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
        try keychain.deleteToken(deviceID: id)
        deviceStore.remove(id: id)
    }

    private static func localClientLabel() -> String {
        let host = Host.current()
        let label = host.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? host.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return label.flatMap { $0.isEmpty ? nil : $0 } ?? "SergeCode"
    }
}
