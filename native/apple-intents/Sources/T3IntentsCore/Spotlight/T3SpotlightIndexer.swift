import AppIntents
import CoreSpotlight
import Foundation

/// Synchronizes T3 Code's IndexedEntity instances with Core Spotlight using OS 27.3 App Entity APIs.
public enum T3SpotlightIndexer {
  public static func apply(diff: T3SpotlightDiff) async {
    guard #available(iOS 27.3, macOS 27.3, *) else { return }
    let index = CSSearchableIndex.default()

    if !diff.removedThreadIds.isEmpty {
      try? await index.deleteAppEntities(
        identifiedBy: diff.removedThreadIds,
        ofType: ThreadEntity.self
      )
    }
    if !diff.removedProjectIds.isEmpty {
      try? await index.deleteAppEntities(
        identifiedBy: diff.removedProjectIds,
        ofType: ProjectEntity.self
      )
    }

    if !diff.upsertedProjects.isEmpty {
      let entities = diff.upsertedProjects.map(ProjectEntity.init(record:))
      try? await index.indexAppEntities(entities)
    }
    if !diff.upsertedThreads.isEmpty {
      let entities = diff.upsertedThreads.map(ThreadEntity.init(record:))
      try? await index.indexAppEntities(entities)
    }
  }

  public static func reindexAll(from store: T3IndexStore) async {
    guard #available(iOS 27.3, macOS 27.3, *) else { return }
    let index = CSSearchableIndex.default()
    let projects = store.allProjects().map(ProjectEntity.init(record:))
    let threads = store.allThreads().map(ThreadEntity.init(record:))
    if !projects.isEmpty {
      try? await index.indexAppEntities(projects)
    }
    if !threads.isEmpty {
      try? await index.indexAppEntities(threads)
    }
  }

  public static func clearAll() async {
    let index = CSSearchableIndex.default()
    try? await index.deleteAllSearchableItems()
  }
}
