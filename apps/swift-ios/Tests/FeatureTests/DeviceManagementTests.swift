import Foundation
import Testing
@testable import T3Code

@Suite("Device management")
struct DeviceManagementTests {
    @Test
    func sortsCurrentThenOnlineThenRecent() {
        let now = Date()
        let current = session(
            id: "current",
            at: now.addingTimeInterval(-300),
            isCurrent: true
        )
        let online = session(
            id: "online",
            at: now.addingTimeInterval(-600),
            isConnected: true
        )
        let recent = session(id: "recent", at: now.addingTimeInterval(-60))
        let older = session(id: "older", at: now.addingTimeInterval(-3_600))

        let sorted = FeatureDeviceSession.sortedForDisplay([older, recent, online, current])

        #expect(sorted.map(\.id) == ["current", "online", "recent", "older"])
    }

    @Test
    func usesSafeFallbackLabels() {
        let current = session(id: "current", at: .now, isCurrent: true)
        let desktop = session(id: "desktop", at: .now, deviceType: .desktop)

        #expect(current.displayName == "This device")
        #expect(desktop.displayName == "Desktop")
    }

    @Test
    func mapsT3ConnectDeviceAsCurrentInstallation() {
        let relayDevice = T3ConnectRelayDevice(
            deviceId: "phone-1",
            label: "Theo’s iPhone",
            platform: "ios",
            iosMajorVersion: 27,
            appVersion: "1.0 (24)",
            notifications: .init(
                enabled: true,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnCompletion: true,
                notifyOnFailure: true
            ),
            liveActivities: .init(enabled: true),
            updatedAt: "2026-08-10T18:30:00.000Z"
        )

        let session = FeatureDeviceSession(
            relayDevice: relayDevice,
            currentDeviceID: "phone-1"
        )

        #expect(session.id == "phone-1")
        #expect(session.displayName == "Theo’s iPhone")
        #expect(session.deviceType == .mobile)
        #expect(session.operatingSystem == "iOS 27")
        #expect(session.browser == "T3 Code 1.0 (24)")
        #expect(session.isCurrent)
        #expect(session.lastConnectedAt == session.issuedAt)
    }

    @Test @MainActor
    func loadsT3ConnectDevicesWithoutEnvironmentAdminScope() async throws {
        let manager = T3ConnectDeviceManagerStub(
            devices: [relayDevice(id: "phone-1")],
            currentDeviceID: "phone-1"
        )
        let client = NativeFeatureClient(t3ConnectDeviceManager: manager)

        let sessions = try await client.loadDeviceSessions()

        #expect(sessions.map(\.id) == ["phone-1"])
        #expect(sessions[0].isCurrent)
        #expect(manager.loadCount == 1)
    }

    private func relayDevice(id: String) -> T3ConnectRelayDevice {
        T3ConnectRelayDevice(
            deviceId: id,
            label: "Theo’s iPhone",
            platform: "ios",
            iosMajorVersion: 27,
            appVersion: "1.0 (24)",
            notifications: .init(
                enabled: true,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnCompletion: true,
                notifyOnFailure: true
            ),
            liveActivities: .init(enabled: true),
            updatedAt: "2026-08-10T18:30:00.000Z"
        )
    }

    private func session(
        id: String,
        at date: Date,
        deviceType: FeatureDeviceType = .mobile,
        isConnected: Bool = false,
        isCurrent: Bool = false
    ) -> FeatureDeviceSession {
        FeatureDeviceSession(
            sessionID: id,
            deviceType: deviceType,
            issuedAt: date.addingTimeInterval(-100),
            expiresAt: date.addingTimeInterval(86_400),
            lastConnectedAt: date,
            isConnected: isConnected,
            isCurrent: isCurrent
        )
    }
}

@MainActor
private final class T3ConnectDeviceManagerStub: T3ConnectDeviceManaging {
    let hasActiveAccount = true
    let currentRegisteredDeviceID: String?
    private let devices: [T3ConnectRelayDevice]
    private(set) var loadCount = 0

    init(devices: [T3ConnectRelayDevice], currentDeviceID: String?) {
        self.devices = devices
        self.currentRegisteredDeviceID = currentDeviceID
    }

    func registeredDevices() async throws -> [T3ConnectRelayDevice] {
        loadCount += 1
        return devices
    }

    func unregisterDevice(id: String) async throws {}
}
