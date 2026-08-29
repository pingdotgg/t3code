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

    @Test
    func retainedRowsReconfigureWhenRegenerationStateChangesDuringAReorder() {
        let thread = supportedThread()
        let item = HomeCollectionItem.thread(
            thread,
            HomeThreadRowContext.fallback,
            .rich,
            false,
            false
        )
        let identifier = item.id
        // Identical item content: regeneration state lives outside the item,
        // so only the external set can force a reconfigure.
        let itemsByID: [HomeCollectionItem.ID: HomeCollectionItem] = [identifier: item]

        #expect(HomeThreadCollectionView.Coordinator.needsReconfiguration(
            identifier: identifier,
            retained: [identifier],
            previousItems: itemsByID,
            itemsByID: itemsByID,
            selectionChanged: [],
            regenerationChanged: [thread.id]
        ))
        #expect(!HomeThreadCollectionView.Coordinator.needsReconfiguration(
            identifier: identifier,
            retained: [identifier],
            previousItems: itemsByID,
            itemsByID: itemsByID,
            selectionChanged: [],
            regenerationChanged: []
        ))
        // Rows entering the collection configure fresh; only retained ones
        // need the explicit reconfigure.
        #expect(!HomeThreadCollectionView.Coordinator.needsReconfiguration(
            identifier: identifier,
            retained: [],
            previousItems: itemsByID,
            itemsByID: itemsByID,
            selectionChanged: [],
            regenerationChanged: [thread.id]
        ))
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
