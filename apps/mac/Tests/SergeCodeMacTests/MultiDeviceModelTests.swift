import Testing

@testable import SergeCodeMac

@Suite("Multi-device model")
@MainActor
struct MultiDeviceModelTests {
    private func makeSession(_ rawID: String) -> RemoteDeviceSession {
        let id = DeviceID(rawValue: rawID)
        let descriptor = RemoteDeviceDescriptor(
            id: id, name: rawID, host: rawID + ".local")
        let model = AppModel(
            backend: MockBackend(), deviceID: id, deviceName: rawID, capabilities: .remote)
        return RemoteDeviceSession(descriptor: descriptor, model: model)
    }

    @Test("selection routing clears every other model")
    func selectionRouting() {
        let local = AppModel(backend: MockBackend())
        let first = makeSession("remote-one")
        let second = makeSession("remote-two")
        let multi = MultiDeviceModel(local: local)
        multi.addSession(first)
        multi.addSession(second)

        multi.selection = ThreadSelection(deviceID: first.id, threadID: "remote-thread")
        #expect(first.model.selectedThreadID == "remote-thread")
        #expect(local.selectedThreadID == nil)
        #expect(second.model.selectedThreadID == nil)

        multi.selection = ThreadSelection(deviceID: .local, threadID: "local-thread")
        #expect(local.selectedThreadID == "local-thread")
        #expect(first.model.selectedThreadID == nil)
        #expect(second.model.selectedThreadID == nil)

        multi.selection = nil
        #expect(local.selectedThreadID == nil)
        #expect(first.model.selectedThreadID == nil)
        #expect(second.model.selectedThreadID == nil)
    }

    @Test("model lookup resolves local and remote device ids")
    func modelLookup() {
        let local = AppModel(backend: MockBackend())
        let session = makeSession("remote")
        let multi = MultiDeviceModel(local: local)
        multi.addSession(session)

        #expect(multi.model(for: .local) === local)
        #expect(multi.model(for: session.id) === session.model)
        #expect(multi.model(for: DeviceID(rawValue: "missing")) == nil)
    }

    @Test("select helper writes through to the owning model")
    func selectHelper() {
        let local = AppModel(backend: MockBackend())
        let session = makeSession("remote")
        let multi = MultiDeviceModel(local: local)
        multi.addSession(session)

        multi.select(threadID: "thread-a", on: session.id)
        #expect(multi.selection == ThreadSelection(deviceID: session.id, threadID: "thread-a"))
        #expect(multi.activeModel === session.model)
        #expect(multi.selectedThread == nil)

        multi.select(threadID: "thread-b", on: .local)
        #expect(multi.selection == ThreadSelection(deviceID: .local, threadID: "thread-b"))
        #expect(session.model.selectedThreadID == nil)
    }

    @Test("shutdown fans out across local and remote mock backends")
    func shutdownFanout() async {
        let local = AppModel(backend: MockBackend())
        let first = makeSession("remote-one")
        let second = makeSession("remote-two")
        let multi = MultiDeviceModel(local: local)
        multi.addSession(first)
        multi.addSession(second)
        multi.start()

        await multi.shutdown()

        // The important contract here is that all three async stop calls
        // complete through the task group; the models remain mounted for a
        // later reconnect or test assertion.
        #expect(multi.allModels.count == 3)
        #expect(multi.remoteSessions.count == 2)
    }
}
