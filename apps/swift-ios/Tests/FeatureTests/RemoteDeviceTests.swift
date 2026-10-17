import Foundation
import Testing
@testable import T3Code

@Suite("Remote device sessions")
struct RemoteDeviceTests {
    @Test func separatesHostsEnvironmentsAndThreads() throws {
        let state = try fixture()
        let first = FeatureRemoteDeviceSnapshot(environmentID: "one", threadID: "thread", state: state)
        let second = FeatureRemoteDeviceSnapshot(environmentID: "two", threadID: "thread", state: state)
        #expect(first.previews.map(\.name) == ["Pixel 9", "Pixel 8"])
        #expect(Set(first.previews.map(\.id) + second.previews.map(\.id)).count == 4)
        #expect(first.previews[1].detail == "Android 15 · Mac mini")
        #expect(FeatureRemoteDeviceSnapshot(environmentID: "one", threadID: "empty", state: state).previews.isEmpty)
    }

    @Test func selectionFallsBackAfterSessionClosesAndBeforeInventoryArrives() throws {
        let state = try fixture()
        let initial = FeatureRemoteDeviceSnapshot(environmentID: "one", threadID: "thread", state: state)
        let selected = initial.previews[1].id
        let changed = FeatureRemoteDeviceSnapshot(
            environmentID: "one", threadID: "thread", state: try fixture(includeRemoteSession: false, inventory: false)
        )
        #expect(changed.selected(selected)?.id.hostID == "local")
        #expect(changed.selected(selected)?.name == "Android Emulator")
        #expect(changed.selected(selected)?.detail == "")
        #expect(changed.state.supportsHostRetry == nil)
        #expect(changed.state.supportsToolInspection == nil)
    }

    @Test @MainActor func lateTicketCannotRestoreOldSelection() async throws {
        let manager = try RemoteDeviceManagerStub(state: fixture())
        manager.holdAccess = true
        let model = FeatureRemoteDevicesModel(threadID: "scoped-thread", client: manager)
        await model.watch()
        let oldID = try #require(model.selected?.id)
        let pending = Task { await model.connect() }
        await manager.waitForAccess()
        model.selectedID = model.previews[1].id
        manager.finishAccess()
        await pending.value
        #expect(model.connection == nil)
        #expect(manager.requestedDevices == [oldID])
        manager.holdAccess = false
        await model.connect()
        #expect(model.connection?.preview.id == model.selectedID)
        #expect(model.connection?.access.query["hostId"] == "remote")
    }

    @Test @MainActor func suspendDiscardsPendingTicketAndResetsInput() async throws {
        let manager = try RemoteDeviceManagerStub(state: fixture())
        let model = FeatureRemoteDevicesModel(threadID: "scoped-thread", client: manager)
        await model.watch()
        await model.connect()
        let connection = try #require(model.connection)
        model.receive(.input(true), connectionID: connection.id)
        #expect(model.inputConnected)
        manager.holdAccess = true
        let pending = Task { await model.connect() }
        await manager.waitForAccess()
        model.suspend()
        manager.finishAccess()
        await pending.value
        #expect(model.connection == nil)
        #expect(!model.inputConnected)
        model.receive(.input(true), connectionID: connection.id)
        #expect(!model.inputConnected)
    }

    @Test @MainActor func subscriptionRetryKeepsStreamWithoutStartingHostHelpers() async throws {
        let manager = try RemoteDeviceManagerStub(state: fixture())
        let model = FeatureRemoteDevicesModel(threadID: "scoped-thread", client: manager)
        await model.watch()
        await model.connect()
        let connection = try #require(model.connection)
        model.receive(.input(true), connectionID: connection.id)
        model.receive(.status(.streaming, nil), connectionID: connection.id)

        manager.watchError = RPCError.disconnected
        await model.watch()
        #expect(model.error != nil)
        #expect(model.connection == connection)

        manager.watchError = nil
        await model.watch()
        #expect(model.error == nil)
        #expect(model.connection == connection)
        #expect(model.inputConnected)
        #expect(model.streaming)
        #expect(manager.watchRequests == 3)
        #expect(manager.requestedDevices.count == 1)
        #expect(manager.refreshes == 0)
    }

    @Test @MainActor func emptySnapshotsLoadAndLastSessionClosureClearsStream() async throws {
        let manager = try RemoteDeviceManagerStub(state: fixture(includeThreadSessions: false))
        let model = FeatureRemoteDevicesModel(threadID: "scoped-thread", client: manager)
        #expect(model.snapshot == nil)
        await model.watch()
        #expect(model.snapshot != nil)
        #expect(model.previews.isEmpty)
        #expect(model.error == nil)
        await model.connect()
        #expect(manager.requestedDevices.isEmpty)

        manager.state = try fixture()
        await model.watch()
        await model.connect()
        let connection = try #require(model.connection)
        model.receive(.input(true), connectionID: connection.id)
        model.receive(.status(.streaming, nil), connectionID: connection.id)

        manager.state = try fixture(includeThreadSessions: false)
        await model.watch()
        #expect(model.snapshot?.state.sessions.count == 1)
        #expect(model.previews.isEmpty)
        #expect(model.selected == nil)
        #expect(model.connection == nil)
        #expect(!model.inputConnected)
        #expect(!model.streaming)
    }

    @Test @MainActor func unauthorizedRefreshIsBoundedUntilAFrameArrives() async throws {
        let manager = try RemoteDeviceManagerStub(state: fixture())
        let model = FeatureRemoteDevicesModel(threadID: "scoped-thread", client: manager)
        await model.watch()
        await model.connect()
        let first = try #require(model.connection)
        model.receive(.unauthorized, connectionID: first.id)
        #expect(model.connection == nil)
        #expect(model.attempt == 1)
        await model.connect()
        let second = try #require(model.connection)
        model.receive(.status(.streaming, nil), connectionID: second.id)
        model.receive(.unauthorized, connectionID: second.id)
        #expect(model.attempt == 1)
        #expect(model.streamError != nil)
        model.reload()
        await model.connect()
        let third = try #require(model.connection)
        model.receive(.input(true), connectionID: third.id)
        model.receive(.status(.streaming, nil), connectionID: third.id)
        model.receive(.unauthorized, connectionID: third.id)
        #expect(model.streamError == nil)
        #expect(model.connection == nil)
        #expect(manager.requestedDevices.count == 3)
    }

    @Test @MainActor func repeatedWebContentCrashesRequireManualRecovery() async throws {
        let manager = try RemoteDeviceManagerStub(state: fixture())
        let model = FeatureRemoteDevicesModel(threadID: "scoped-thread", client: manager)
        await model.watch()
        await model.connect()
        model.processTerminated(connectionID: try #require(model.connection?.id))
        #expect(model.attempt == 1)
        await model.connect()
        model.processTerminated(connectionID: try #require(model.connection?.id))
        #expect(model.attempt == 1)
        #expect(model.streamError != nil)
        #expect(!model.inputConnected)
    }

    @Test @MainActor func missingCapabilitiesDoNotIssueUnsupportedMutations() async throws {
        let manager = try RemoteDeviceManagerStub(state: fixture())
        let model = FeatureRemoteDevicesModel(threadID: "scoped-thread", client: manager)
        await model.watch()
        await model.refresh(retryHostID: "local")
        await model.refresh(inspectOnly: true)
        #expect(manager.refreshes == 0)
        await model.shutDown()
        #expect(manager.shutdown?.id.environmentID == "one")
        #expect(manager.shutdown?.id.hostID == "local")
        #expect(manager.shutdown?.session.threadId == "thread")
    }

    @Test @MainActor func inventoryRefreshRequiresAnExplicitHostOrInspection() async throws {
        let manager = try RemoteDeviceManagerStub(state: fixture(supportsRefreshActions: true))
        let model = FeatureRemoteDevicesModel(threadID: "scoped-thread", client: manager)
        await model.watch()
        await model.refresh()
        #expect(manager.refreshes == 0)
        await model.refresh(retryHostID: "remote")
        await model.refresh(inspectOnly: true)
        #expect(manager.refreshInputs.map(\.retryHostID) == ["remote", nil])
        #expect(manager.refreshInputs.map(\.inspectOnly) == [false, true])
    }

    @Test @MainActor func oldServerShowsUnsupportedWithoutPretendingThereAreNoSessions() async throws {
        let manager = try RemoteDeviceManagerStub(state: fixture())
        manager.watchError = RPCError.remote("Unknown RPC: subscribeDeviceState")
        let model = FeatureRemoteDevicesModel(threadID: "scoped-thread", client: manager)
        await model.watch()
        #expect(model.unsupported)
        #expect(model.snapshot == nil)
        #expect(model.error == RemoteDeviceError.unsupported.localizedDescription)
    }

    @Test func documentKeepsTicketsAndDeviceNamesAsData() throws {
        let preview = FeatureRemoteDeviceSnapshot(environmentID: "one", threadID: "thread", state: try fixture()).previews[0]
        let access = try RemoteDeviceHubAccess.ticketed(
            environmentURL: URL(string: "https://relay.example")!, hubBasePath: "/api/device-hub",
            hostID: "remote", ticket: "</script><script>unexpected()</script>"
        )
        let html = try RemoteDeviceStreamDocument.html(
            connection: .init(preview: preview, access: access), script: "window.T3DeviceStream={start(){}};"
        )
        #expect(!html.contains("<script>unexpected()"))
        #expect(html.components(separatedBy: "</script>").count == 2)
        #expect(html.contains("\\u003c"))
    }

    @Test func streamBridgeRejectsMalformedInput() {
        #expect(RemoteDeviceStreamMessage(data: #"{"type":"input","connected":true}"#) == .input(true))
        #expect(RemoteDeviceStreamMessage(data: #"{"type":"input","connected":1}"#) == nil)
        #expect(RemoteDeviceStreamMessage(data: #"{"type":"status","status":"streaming"}"#) == .status(.streaming, nil))
        #expect(RemoteDeviceStreamMessage(data: #"{"type":"status","status":"made-up"}"#) == nil)
        #expect(RemoteDeviceStreamMessage(data: #"{"type":"status","status":"error","detail":42}"#) == nil)
        #expect(RemoteDeviceStreamMessage(data: "not JSON") == nil)
    }

    private func fixture(
        includeRemoteSession: Bool = true, inventory: Bool = true,
        includeThreadSessions: Bool = true, supportsRefreshActions: Bool = false
    ) throws -> RemoteDeviceServiceState {
        var value = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {
          "hosts": [
            {"id":"local","kind":"local","label":"Local","platforms":[],"hubInstalled":true,"agentDeviceInstalled":true},
            {"id":"remote","kind":"ssh","label":"Mac mini","platforms":[],"hubInstalled":true,"agentDeviceInstalled":true}
          ],
          "hostStatus":"ready", "hostStatuses":{},
          "devices":[
            {"hostId":"local","id":"emulator-5554","platform":"android","name":"Pixel 9","version":"Android 16","booted":true,"physical":false},
            {"hostId":"remote","id":"emulator-5554","platform":"android","name":"Pixel 8","version":"Android 15","booted":true,"physical":false}
          ],
          "sessions":[
            {"threadId":"thread","hostId":"local","deviceId":"emulator-5554","platform":"android","openedAt":"2026-10-04T00:00:00Z"},
            {"threadId":"thread","hostId":"remote","deviceId":"emulator-5554","platform":"android","openedAt":"2026-10-04T00:01:00Z"},
            {"threadId":"other","hostId":"local","deviceId":"iphone","platform":"ios","openedAt":"2026-10-04T00:02:00Z"}
          ],
          "onboardingCompleted":true, "agentAccessEnabled":true,
          "hubBasePath":"/api/device-hub", "revision":1
        }
        """#.utf8))
        if case var .object(fields) = value {
            if !inventory { fields["hosts"] = .array([]); fields["devices"] = .array([]) }
            if !includeRemoteSession, case let .array(sessions) = fields["sessions"] {
                fields["sessions"] = .array([sessions[0]])
            }
            if !includeThreadSessions, case let .array(sessions) = fields["sessions"] {
                fields["sessions"] = .array(sessions.filter { $0["threadId"] != .string("thread") })
            }
            if supportsRefreshActions {
                fields["supportsHostRetry"] = .bool(true)
                fields["supportsToolInspection"] = .bool(true)
            }
            value = .object(fields)
        }
        return try value.decode(RemoteDeviceServiceState.self)
    }
}

@MainActor
private final class RemoteDeviceManagerStub: FeatureRemoteDeviceManaging {
    var state: RemoteDeviceServiceState
    var watchError: (any Error)?
    var watchRequests = 0
    var holdAccess = false
    var requestedDevices: [FeatureRemoteDeviceID] = []
    var refreshInputs: [(retryHostID: String?, inspectOnly: Bool)] = []
    var refreshes: Int { refreshInputs.count }
    var shutdown: FeatureRemoteDevicePreview?
    private var access: CheckedContinuation<Void, Never>?
    private var accessWaiter: CheckedContinuation<Void, Never>?

    init(state: RemoteDeviceServiceState) { self.state = state }

    func remoteDeviceStates(threadID: String) async throws -> AsyncThrowingStream<FeatureRemoteDeviceSnapshot, Error> {
        watchRequests += 1
        if let watchError { throw watchError }
        return AsyncThrowingStream { continuation in
            continuation.yield(.init(environmentID: "one", threadID: "thread", state: state))
            continuation.finish()
        }
    }

    func refreshRemoteDevices(threadID: String, retryHostID: String?, inspectOnly: Bool) async throws -> FeatureRemoteDeviceSnapshot {
        refreshInputs.append((retryHostID, inspectOnly))
        return .init(environmentID: "one", threadID: "thread", state: state)
    }

    func remoteDeviceHubAccess(threadID: String, device: FeatureRemoteDeviceID, hubBasePath: String) async throws -> RemoteDeviceHubAccess {
        requestedDevices.append(device)
        if holdAccess {
            await withCheckedContinuation { continuation in
                access = continuation
                accessWaiter?.resume()
                accessWaiter = nil
            }
        }
        return try .ticketed(environmentURL: URL(string: "https://relay.example")!, hubBasePath: hubBasePath,
                             hostID: device.hostID, ticket: "ticket-\(requestedDevices.count)")
    }

    func waitForAccess() async {
        guard access == nil else { return }
        await withCheckedContinuation { accessWaiter = $0 }
    }

    func finishAccess() { access?.resume(); access = nil }

    func shutDownRemoteDevice(threadID: String, device: FeatureRemoteDevicePreview) async throws { shutdown = device }
}
