import Testing
@testable import T3Code

@Suite("Thread title regeneration menu")
struct ThreadTitleRegenerationMenuTests {
    @Test
    func hidesWithoutCapabilityOrWhenArchived() {
        let unsupported = FeatureThread(id: "thread", projectID: "project", title: "Title")
        var archived = supportedThread()
        archived.isArchived = true

        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: unsupported,
            isArchived: false,
            regeneratingThreadIDs: []
        ) == .hidden)
        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: archived,
            isArchived: true,
            regeneratingThreadIDs: []
        ) == .hidden)
    }

    @Test
    func exposesAvailableAndRegeneratingStates() {
        let thread = supportedThread()

        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: thread,
            isArchived: false,
            regeneratingThreadIDs: []
        ) == .available)
        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: thread,
            isArchived: false,
            regeneratingThreadIDs: [thread.id]
        ) == .regenerating)

        var serverPending = thread
        serverPending.isRegeneratingTitle = true
        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: serverPending,
            isArchived: false,
            regeneratingThreadIDs: []
        ) == .regenerating)
    }

    private func supportedThread() -> FeatureThread {
        FeatureThread(
            id: "thread",
            projectID: "project",
            title: "Title",
            supportsTitleRegeneration: true
        )
    }
}
