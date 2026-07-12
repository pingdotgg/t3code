import Foundation

public struct RemoteDevice: Sendable, Codable, Equatable, Identifiable {
    public let id: String
    public var name: String
    public var host: String
    public var port: Int
    public var pairedAt: Date
    public var sessionExpiresAt: Date?

    public init(
        id: String,
        name: String,
        host: String,
        port: Int,
        pairedAt: Date,
        sessionExpiresAt: Date?
    ) {
        self.id = id
        self.name = name
        self.host = host
        self.port = port
        self.pairedAt = pairedAt
        self.sessionExpiresAt = sessionExpiresAt
    }
}

public struct RemoteDeviceStore: @unchecked Sendable {
    public static let defaultsKey = "remoteDevices"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func all() -> [RemoteDevice] {
        guard let data = defaults.data(forKey: Self.defaultsKey),
            let devices = try? JSONDecoder().decode([RemoteDevice].self, from: data)
        else {
            return []
        }
        return devices
    }

    public func upsert(_ device: RemoteDevice) {
        var devices = all()
        if let index = devices.firstIndex(where: { $0.id == device.id }) {
            devices[index] = device
        } else {
            devices.append(device)
        }
        save(devices)
    }

    public func remove(id: String) {
        var devices = all()
        devices.removeAll { $0.id == id }
        save(devices)
    }

    private func save(_ devices: [RemoteDevice]) {
        guard let data = try? JSONEncoder().encode(devices) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}
