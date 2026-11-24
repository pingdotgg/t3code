import AppIntents
import CoreSpotlight
import Foundation

public struct T3SpotlightTimeoutError: Error, Equatable {}

/// Mirrors index changes into Core Spotlight. Failures throw so the host keeps its sync baseline and retries.
public enum T3SpotlightIndexer {
  /// Spotlight calls can stall indefinitely; past this the operation fails so the serialized index
  /// queue and the host's blocked worker are released and a later sync can retry.
  static let deadline: TimeInterval = 20

  public static func removeEntities(threadIds: [String], projectIds: [String]) async throws {
    try await withDeadline {
      try await deleteAppEntities(projectIds: projectIds, threadIds: threadIds)
    }
  }

  /// Writes each kind under its own deadline, then re-reads the store and deletes anything no
  /// longer in it. A clear empties the store before Spotlight, so a write that outlives its
  /// deadline and lands after a clear (in this process or another) is removed again.
  public static func indexEntities(
    projects: [T3ProjectRecord] = [],
    threads: [T3ThreadRecord] = [],
    store: T3IndexStore
  ) async throws {
    guard #available(iOS 27.3, macOS 27.3, *) else { return }
    if !projects.isEmpty {
      let entities = projects.map(ProjectEntity.init(record:))
      try await writeThenReconcile(projectIds: entities.map(\.id), threadIds: [], store: store) {
        try await CSSearchableIndex.default().indexAppEntities(entities)
      }
    }
    if !threads.isEmpty {
      let entities = threads.map(ThreadEntity.init(record:))
      try await writeThenReconcile(projectIds: [], threadIds: entities.map(\.id), store: store) {
        try await CSSearchableIndex.default().indexAppEntities(entities)
      }
    }
  }

  static func writeThenReconcile(
    projectIds: [String],
    threadIds: [String],
    store: T3IndexStore,
    seconds: TimeInterval = deadline,
    remove: @escaping @Sendable (_ projectIds: [String], _ threadIds: [String]) async throws -> Void = deleteAppEntities,
    write: @escaping @Sendable () async throws -> Void
  ) async throws {
    try await withDeadline(seconds: seconds) {
      try await write()
      // Runs even after the deadline has passed, whenever a stalled write finally returns.
      let missing = missingRecordIds(projectIds: projectIds, threadIds: threadIds, in: store)
      if !missing.projectIds.isEmpty || !missing.threadIds.isEmpty {
        try await remove(missing.projectIds, missing.threadIds)
      }
    }
  }

  static func deleteAppEntities(projectIds: [String], threadIds: [String]) async throws {
    guard #available(iOS 27.3, macOS 27.3, *) else { return }
    let index = CSSearchableIndex.default()
    if !threadIds.isEmpty {
      try await index.deleteAppEntities(identifiedBy: threadIds, ofType: ThreadEntity.self)
    }
    if !projectIds.isEmpty {
      try await index.deleteAppEntities(identifiedBy: projectIds, ofType: ProjectEntity.self)
    }
  }

  static func missingRecordIds(
    projectIds: [String],
    threadIds: [String],
    in store: T3IndexStore
  ) -> (projectIds: [String], threadIds: [String]) {
    let keptProjects = Set(store.projects(for: projectIds).map(\.id))
    let keptThreads = Set(store.threads(for: threadIds).map(\.id))
    return (
      projectIds.filter { !keptProjects.contains($0) },
      threadIds.filter { !keptThreads.contains($0) }
    )
  }

  public static func clearAll() async throws {
    try await withDeadline {
      try await CSSearchableIndex.default().deleteAllSearchableItems()
    }
  }

  /// Resumes with the operation's result or a timeout, whichever comes first. A stalled operation
  /// is left to finish on its own, uncancelled, so whatever follows its write still runs.
  static func withDeadline<T: Sendable>(
    seconds: TimeInterval = deadline,
    _ operation: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      let gate = ResumeOnce(continuation)
      Task {
        do {
          gate.resume(with: .success(try await operation()))
        } catch {
          gate.resume(with: .failure(error))
        }
      }
      let timer = Task {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        gate.resume(with: .failure(T3SpotlightTimeoutError()))
      }
      gate.onResume { timer.cancel() }
    }
  }
}

private final class ResumeOnce<T: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<T, any Error>?
  private var resumed = false
  private var cleanup: (@Sendable () -> Void)?

  init(_ continuation: CheckedContinuation<T, any Error>) {
    self.continuation = continuation
  }

  func onResume(_ action: @escaping @Sendable () -> Void) {
    let runNow = lock.withLock { () -> Bool in
      if resumed { return true }
      cleanup = action
      return false
    }
    if runNow { action() }
  }

  func resume(with result: Result<T, any Error>) {
    let pending = lock.withLock { () -> (CheckedContinuation<T, any Error>, (@Sendable () -> Void)?)? in
      guard !resumed, let continuation else { return nil }
      resumed = true
      self.continuation = nil
      defer { cleanup = nil }
      return (continuation, cleanup)
    }
    guard let (continuation, cleanup) = pending else { return }
    continuation.resume(with: result)
    cleanup?()
  }
}
