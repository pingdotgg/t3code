import Testing
@testable import T3Code

@Suite("Thread title regeneration menu")
struct ThreadTitleRegenerationMenuTests {
    @Test
    func hidesUnsupportedThreadsAndKeepsArchivedThreadsAvailable() {
        let unsupported = FeatureThread(id: "thread", projectID: "project", title: "Title")
        var archived = supportedThread()
        archived.isArchived = true

        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: unsupported,
            regeneratingThreadIDs: []
        ) == .hidden)
        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: archived,
            regeneratingThreadIDs: []
        ) == .available)
    }

    @Test
    func exposesAvailableAndRegeneratingStates() {
        let thread = supportedThread()

        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: thread,
            regeneratingThreadIDs: []
        ) == .available)
        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: thread,
            regeneratingThreadIDs: [thread.id]
        ) == .regenerating)

        var serverPending = thread
        serverPending.isRegeneratingTitle = true
        #expect(ThreadTitleRegenerationMenuState.resolve(
            thread: serverPending,
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
