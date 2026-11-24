import AppIntents
import CoreSpotlight
import Foundation

/// Mirrors index changes into Core Spotlight. Failures throw so the host keeps its sync baseline and retries.
public enum T3SpotlightIndexer {
  public static func removeEntities(threadIds: [String], projectIds: [String]) async throws {
    guard #available(iOS 27.3, macOS 27.3, *) else { return }
    let index = CSSearchableIndex.default()
    if !threadIds.isEmpty {
      try await index.deleteAppEntities(identifiedBy: threadIds, ofType: ThreadEntity.self)
    }
    if !projectIds.isEmpty {
      try await index.deleteAppEntities(identifiedBy: projectIds, ofType: ProjectEntity.self)
    }
  }

  public static func indexEntities(projects: [T3ProjectRecord], threads: [T3ThreadRecord]) async throws {
    guard #available(iOS 27.3, macOS 27.3, *) else { return }
    let index = CSSearchableIndex.default()
    if !projects.isEmpty {
      try await index.indexAppEntities(projects.map(ProjectEntity.init(record:)))
    }
    if !threads.isEmpty {
      try await index.indexAppEntities(threads.map(ThreadEntity.init(record:)))
    }
  }

  public static func clearAll() async throws {
    try await CSSearchableIndex.default().deleteAllSearchableItems()
  }
}
