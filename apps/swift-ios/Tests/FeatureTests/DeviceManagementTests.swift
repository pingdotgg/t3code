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

    @Test @MainActor
    func staleReloadCannotRestoreRevokedDevice() async {
        let current = session(id: "current", at: .now, isCurrent: true)
        let laptop = session(id: "laptop", at: .now)
        let manager = HeldDeviceManager()
        let model = DevicesModel(manager: manager)
        await load([current, laptop], into: model, from: manager)

        let reload = Task { await model.reload() }
        await manager.waitForLoad()
        await model.revoke(laptop)
        manager.finishLoad(.success([current, laptop]))
        await reload.value

        #expect(manager.revokedIDs == ["laptop"])
        #expect(model.sessions.map(\.id) == ["current"])
        #expect(model.isLoading == false)
        #expect(model.isRevoking == false)
    }

    @Test @MainActor
    func staleReloadKeepsNewerRevocationFeedback() async {
        let current = session(id: "current", at: .now, isCurrent: true)
        let laptop = session(id: "laptop", at: .now)
        let manager = HeldDeviceManager()
        manager.revokeError = URLError(.notConnectedToInternet)
        let model = DevicesModel(manager: manager)

        let reload = Task { await model.reload() }
        await manager.waitForLoad()
        await model.revoke(laptop)
        let feedback = model.errorMessage
        manager.finishLoad(.success([current, laptop]))
        await reload.value

        #expect(feedback != nil)
        #expect(model.errorMessage == feedback)
    }

    @Test @MainActor
    func staleReloadFailureDoesNotReplaceRevocationSuccess() async {
        let laptop = session(id: "laptop", at: .now)
        let manager = HeldDeviceManager()
        let model = DevicesModel(manager: manager)

        let reload = Task { await model.reload() }
        await manager.waitForLoad()
        await model.revoke(laptop)
        manager.finishLoad(.failure(URLError(.timedOut)))
        await reload.value

        #expect(model.errorMessage == nil)
    }

    @Test @MainActor
    func currentReloadStillAppliesAfterRevocation() async {
        let current = session(id: "current", at: .now, isCurrent: true)
        let laptop = session(id: "laptop", at: .now)
        let manager = HeldDeviceManager()
        let model = DevicesModel(manager: manager)

        await model.revoke(laptop)
        let reload = Task { await model.reload() }
        await manager.waitForLoad()
        manager.finishLoad(.success([current]))
        await reload.value

        #expect(model.sessions.map(\.id) == ["current"])
        #expect(model.isLoading == false)
    }

    @Test @MainActor
    func secondRevocationWaitsForFirstAndKeepsItsFeedback() async {
        let laptop = session(id: "laptop", at: .now)
        let tablet = session(id: "tablet", at: .now)
        let manager = HeldDeviceManager()
        manager.holdsNextRevocation = true
        let model = DevicesModel(manager: manager)

        let first = Task { await model.revoke(laptop) }
        await manager.revocations.waitForCall()
        await model.revoke(tablet)
        manager.revocations.finish(.failure(URLError(.notConnectedToInternet)))
        await first.value

        #expect(manager.revokedIDs == ["laptop"])
        #expect(model.errorMessage != nil)
        #expect(model.isRevoking == false)
    }

    @MainActor
    private func load(
        _ sessions: [FeatureDeviceSession],
        into model: DevicesModel,
        from manager: HeldDeviceManager
    ) async {
        let reload = Task { await model.reload() }
        await manager.waitForLoad()
        manager.finishLoad(.success(sessions))
        await reload.value
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

/// Holds each device list read, and optionally the next revocation, open
/// until the test releases it.
@MainActor
private final class HeldDeviceManager: FeatureDeviceManaging {
    var revokeError: Error?
    var holdsNextRevocation = false
    private(set) var revokedIDs: [String] = []
    let loads = HeldCalls<[FeatureDeviceSession]>()
    let revocations = HeldCalls<Void>()

    func loadDeviceSessions() async throws -> [FeatureDeviceSession] {
        try await loads.call()
    }

    func waitForLoad() async {
        await loads.waitForCall()
    }

    func finishLoad(_ result: Result<[FeatureDeviceSession], Error>) {
        loads.finish(result)
    }

    func revokeDeviceSession(id: String) async throws {
        revokedIDs.append(id)
        if holdsNextRevocation {
            holdsNextRevocation = false
            try await revocations.call()
        }
        if let revokeError { throw revokeError }
    }

    func revokeOtherDeviceSessions() async throws {
        if let revokeError { throw revokeError }
    }
}

@MainActor
private final class HeldCalls<Value> {
    private var pending: [CheckedContinuation<Value, Error>] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func call() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            pending.append(continuation)
            let ready = waiters
            waiters = []
            ready.forEach { $0.resume() }
        }
    }

    func waitForCall() async {
        guard pending.isEmpty else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func finish(_ result: Result<Value, Error>) {
        pending.removeFirst().resume(with: result)
    }
}
