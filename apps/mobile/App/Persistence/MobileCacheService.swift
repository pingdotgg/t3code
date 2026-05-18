import Foundation
import T3MobileProtocol

actor MobileCacheService {
    private let store: MobileCacheStore
    private let queue = DispatchQueue(label: "tools.t3.mobile.cache", qos: .utility)

    init(store: MobileCacheStore) {
        self.store = store
    }

    func loadShell() async throws -> MobileCachedShell? {
        try await awaitOnQueue { [self] in
            try self.store.loadShell()
        }
    }

    func saveInitialSync(_ result: MobileInitialSyncResult) async throws {
        try await awaitOnQueue { [self] in
            try self.store.saveInitialSync(result)
        }
    }

    func saveShell(environment: MobileEnvironment, shellState: MobileShellState) async throws {
        try await awaitOnQueue { [self] in
            try self.store.saveShell(environment: environment, shellState: shellState)
        }
    }

    func loadThreadSnapshot(threadID: String) async throws -> (json: Data, sequence: Int)? {
        try await awaitOnQueue { [self] in
            try self.store.loadThreadSnapshot(threadID: threadID)
        }
    }

    func saveThreadSnapshot(threadID: String, snapshotJSON: Data, snapshotSequence: Int) async throws {
        try await awaitOnQueue { [self] in
            try self.store.saveThreadSnapshot(
                threadID: threadID,
                snapshotJSON: snapshotJSON,
                snapshotSequence: snapshotSequence
            )
        }
    }

    func saveThreadSnapshotAndCursor(threadID: String, snapshotJSON: Data, snapshotSequence: Int) async throws {
        try await awaitOnQueue { [self] in
            try self.store.saveThreadSnapshotAndCursor(
                threadID: threadID,
                snapshotJSON: snapshotJSON,
                snapshotSequence: snapshotSequence
            )
        }
    }

    func loadEventCursor(name: String) async throws -> Int? {
        try await awaitOnQueue { [self] in
            try self.store.loadEventCursor(name: name)
        }
    }

    func saveEventCursor(name: String, sequence: Int) async throws {
        try await awaitOnQueue { [self] in
            try self.store.saveEventCursor(name: name, sequence: sequence)
        }
    }

    func saveReplayGap(scope: String, envelope: MobileReplayEnvelope) async throws {
        try await awaitOnQueue { [self] in
            try self.store.saveReplayGap(scope: scope, envelope: envelope)
        }
    }

    private func awaitOnQueue<Value: Sendable>(
        _ operation: @escaping @Sendable () throws -> Value
    ) async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    continuation.resume(returning: try operation())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}
