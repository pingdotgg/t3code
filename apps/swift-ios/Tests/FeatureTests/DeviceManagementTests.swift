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
