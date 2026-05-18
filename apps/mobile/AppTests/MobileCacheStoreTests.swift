import Foundation
import Testing
import T3MobileProtocol
@testable import T3Mobile

struct MobileCacheStoreTests {
    @Test func persistsAndLoadsShellCache() async throws {
        let store = try MobileCacheStore(databaseURL: temporaryDatabaseURL())
        let environment = MobileEnvironment(
            id: "environment-cache",
            title: "Cached Mac",
            connectionSummary: "darwin / arm64",
            isConnected: true
        )
        let shellState = MobileShellState(
            snapshotSequence: 42,
            projects: [
                MobileProject(
                    id: "project-cache",
                    title: "Cached Project",
                    workspaceRoot: "/tmp/cache"
                ),
            ],
            threads: [
                MobileThread(
                    id: "thread-cache",
                    projectID: "project-cache",
                    title: "Cached Thread",
                    status: "Ready",
                    latestSummary: "Loaded from SQLite."
                ),
            ]
        )

        try store.saveShell(environment: environment, shellState: shellState)
        let cachedShell = try store.loadShell()

        #expect(cachedShell?.environment == environment)
        #expect(cachedShell?.shellState == shellState)
        #expect(cachedShell?.protocolVersion == mobileProtocolVersion)
        #expect(cachedShell?.snapshotSchemaVersion == MobileCacheStore.shellSnapshotSchemaVersion)
    }

    @Test @MainActor func shellViewModelLoadsCacheBeforeNetworkConfiguration() async throws {
        let store = try MobileCacheStore(databaseURL: temporaryDatabaseURL())
        try store.saveShell(
            environment: MobileEnvironment(
                id: "environment-cache",
                title: "Cached Mac",
                connectionSummary: "darwin / arm64",
                isConnected: true
            ),
            shellState: MobileShellState(
                snapshotSequence: 5,
                projects: [
                    MobileProject(
                        id: "project-cache",
                        title: "Cached Project",
                        workspaceRoot: "/tmp/cache"
                    ),
                ],
                threads: [
                    MobileThread(
                        id: "thread-cache",
                        projectID: "project-cache",
                        title: "Cached Thread",
                        status: "Ready",
                        latestSummary: "Loaded before network."
                    ),
                ]
            )
        )
        let viewModel = ShellViewModel(environments: [], projects: [], threads: [])

        await viewModel.loadInitialSync(configuration: nil, cacheService: MobileCacheService(store: store))

        #expect(viewModel.connectionState == .notConfigured)
        #expect(viewModel.environments.first?.title == "Cached Mac")
        #expect(viewModel.environments.first?.isConnected == false)
        #expect(viewModel.projects.first?.title == "Cached Project")
        #expect(viewModel.selectedThread?.title == "Cached Thread")
    }

    @Test func persistsReplayGapsPendingCommandsCursorsAndAttachments() async throws {
        let store = try MobileCacheStore(databaseURL: temporaryDatabaseURL())
        let replayGap = MobileReplayEnvelope(
            status: "cursor-too-old",
            fromSequenceExclusive: 1,
            returnedFromSequenceExclusive: 1,
            returnedToSequenceInclusive: 0,
            serverHighWaterSequence: 9,
            events: [],
            resnapshot: ["all"],
            error: MobileErrorPayload(
                code: "replay-gap",
                message: "Fixture gap"
            )
        )

        try store.saveEventCursor(name: "shell", sequence: 9)
        try store.saveSubscriptionCursor(scope: "thread", aggregateID: "thread-cache", sequence: 9)
        try store.saveReplayGap(scope: "all", envelope: replayGap)
        try store.savePendingCommand(
            commandID: "command-cache",
            commandType: "thread.session.stop",
            payloadJSON: Data(#"{"type":"thread.session.stop"}"#.utf8),
            status: .created
        )
        try store.updatePendingCommand(
            commandID: "command-cache",
            receipt: MobileCommandReceipt(
                status: "accepted",
                commandId: "command-cache",
                payloadHash: "hash",
                acceptedAt: "2026-05-10T00:00:00.000Z",
                sequence: 10,
                error: nil
            )
        )
        try store.saveAttachmentMetadata(
            id: "attachment-cache",
            metadataJSON: Data(#"{"type":"image"}"#.utf8),
            localPath: nil
        )

        #expect(try store.loadShell() == nil)
    }

    @Test func persistsThreadSnapshotAndCursorTogether() throws {
        let store = try MobileCacheStore(databaseURL: temporaryDatabaseURL())
        let snapshot = Data(#"{"snapshotSequence":12,"thread":{"id":"thread-cache"}}"#.utf8)

        try store.saveThreadSnapshotAndCursor(
            threadID: "thread-cache",
            snapshotJSON: snapshot,
            snapshotSequence: 12
        )

        let cached = try #require(try store.loadThreadSnapshot(threadID: "thread-cache"))
        #expect(cached.json == snapshot)
        #expect(cached.sequence == 12)
        #expect(try store.loadEventCursor(name: "thread:thread-cache") == 12)
    }
}

private func temporaryDatabaseURL() -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString)
        .appendingPathExtension("sqlite3")
}
