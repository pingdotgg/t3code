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
    guard #available(iOS 27.3, macOS 27.3, *) else { return }
    try await withDeadline {
      let index = CSSearchableIndex.default()
      if !threadIds.isEmpty {
        try await index.deleteAppEntities(identifiedBy: threadIds, ofType: ThreadEntity.self)
      }
      if !projectIds.isEmpty {
        try await index.deleteAppEntities(identifiedBy: projectIds, ofType: ProjectEntity.self)
      }
    }
  }

  public static func indexEntities(projects: [T3ProjectRecord], threads: [T3ThreadRecord]) async throws {
    guard #available(iOS 27.3, macOS 27.3, *) else { return }
    try await withDeadline {
      try await indexAppEntities(projects: projects.map(ProjectEntity.init(record:)), threads: threads.map(ThreadEntity.init(record:)))
    }
  }

  @available(iOS 27.3, macOS 27.3, *)
  static func indexAppEntities(projects: [ProjectEntity] = [], threads: [ThreadEntity] = []) async throws {
    let index = CSSearchableIndex.default()
    if !projects.isEmpty {
      try await index.indexAppEntities(projects)
    }
    if !threads.isEmpty {
      try await index.indexAppEntities(threads)
    }
  }

  /// System reindex callbacks can run in the extension while the host clears the shared store, and
  /// the in-process queue cannot order the two. A clear empties the store before Spotlight, so
  /// re-reading the store after writing finds, and deletes, anything that landed after that clear.
  public static func reindex(
    projects: [T3ProjectRecord] = [],
    threads: [T3ThreadRecord] = [],
    store: T3IndexStore
  ) async throws {
    try await indexEntities(projects: projects, threads: threads)
    let missing = missingRecordIds(
      projectIds: projects.map(\.id),
      threadIds: threads.map(\.id),
      in: store
    )
    try await removeEntities(threadIds: missing.threadIds, projectIds: missing.projectIds)
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
  /// is cancelled and left to finish on its own; nothing waits on it any longer.
  static func withDeadline<T: Sendable>(
    seconds: TimeInterval = deadline,
    _ operation: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      let gate = ResumeOnce(continuation)
      let work = Task {
        do {
          gate.resume(with: .success(try await operation()))
        } catch {
          gate.resume(with: .failure(error))
        }
      }
      let timer = Task {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        work.cancel()
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
