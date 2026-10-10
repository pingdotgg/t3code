import Foundation
import Observation

/// A browser session caches only the folders the user opens, never file contents.
@MainActor
@Observable
final class FeatureFileBrowserState {
    struct Directory: Hashable {
        // Native thread IDs include their environment ID.
        let threadID: String
        let workspaceRoot: String?
        let path: String?
    }

    struct Listing {
        var entries: [FeatureFileEntry]?
        var errorMessage: String?
        var isLoading = false
        fileprivate var requestID: UUID?
    }

    private var listings: [Directory: Listing] = [:]

    func listing(for directory: Directory) -> Listing {
        listings[directory] ?? Listing()
    }

    func load(
        _ directory: Directory,
        refresh: Bool = false,
        fetch: () async throws -> [FeatureFileEntry]
    ) async {
        let previous = listing(for: directory)
        guard refresh || (previous.entries == nil && !previous.isLoading) else { return }
        let requestID = UUID()
        listings[directory, default: Listing()].requestID = requestID
        listings[directory, default: Listing()].isLoading = true
        defer {
            if listings[directory]?.requestID == requestID {
                listings[directory]?.isLoading = false
            }
        }
        do {
            let entries = try await fetch()
            try Task.checkCancellation()
            guard listings[directory]?.requestID == requestID else { return }
            listings[directory]?.entries = entries
            listings[directory]?.errorMessage = nil
            discardRemovedDirectories(in: directory, entries: entries)
        } catch {
            guard !Task.isCancelled, !(error is CancellationError),
                  listings[directory]?.requestID == requestID else { return }
            listings[directory]?.errorMessage = error.localizedDescription
        }
    }

    private func discardRemovedDirectories(in directory: Directory, entries: [FeatureFileEntry]) {
        let prefix = directory.path.map { "\($0)/" } ?? ""
        let childDirectories = Set(entries.filter { $0.kind == .directory }.map(\.path))
        for cached in Array(listings.keys) {
            guard cached.threadID == directory.threadID,
                  cached.workspaceRoot == directory.workspaceRoot,
                  let path = cached.path, path.hasPrefix(prefix) else { continue }
            let relative = path.dropFirst(prefix.count)
            guard let child = relative.split(separator: "/").first else { continue }
            if !childDirectories.contains(prefix + String(child)) {
                listings.removeValue(forKey: cached)
            }
        }
    }
}
