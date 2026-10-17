import Foundation
import Observation

public struct FeatureFileSearchResult: Sendable, Equatable {
    public var entries: [FeatureFileEntry]
    public var isTruncated: Bool

    public init(entries: [FeatureFileEntry], isTruncated: Bool = false) {
        self.entries = entries
        self.isTruncated = isTruncated
    }
}

/// Preserves the server's truncation flag without changing composer file search.
@MainActor
public protocol FeatureWorkspaceSearching: AnyObject {
    func searchWorkspaceFiles(threadID: String, query: String, limit: Int) async throws -> FeatureFileSearchResult
}

extension NativeFeatureClient: FeatureWorkspaceSearching {}

@MainActor
@Observable
final class FeatureFileSearchState {
    struct Request: Hashable {
        let threadID: String
        let workspaceRoot: String?
        let query: String

        init(threadID: String, workspaceRoot: String?, query: String) {
            self.threadID = threadID
            self.workspaceRoot = workspaceRoot
            self.query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(256))
        }
    }

    static let limit = 200
    private(set) var request: Request?
    private(set) var result: FeatureFileSearchResult?
    private(set) var errorMessage: String?
    private(set) var isLoading = false
    private var generation = 0

    func search(
        _ request: Request,
        debounce: () async throws -> Void = { try await Task.sleep(for: .milliseconds(200)) },
        fetch: (String, Int) async throws -> FeatureFileSearchResult
    ) async {
        generation += 1
        let generation = generation
        self.request = request
        result = nil
        errorMessage = nil
        isLoading = !request.query.isEmpty
        guard !request.query.isEmpty else { return }
        defer {
            if self.generation == generation { isLoading = false }
        }
        do {
            try await debounce()
            try Task.checkCancellation()
            guard self.generation == generation else { return }
            let result = try await fetch(request.query, Self.limit)
            try Task.checkCancellation()
            guard self.generation == generation else { return }
            self.result = result
        } catch {
            guard self.generation == generation, !Task.isCancelled,
                  !(error is CancellationError) else { return }
            errorMessage = error.localizedDescription
        }
    }
}

enum FeatureFileSearchMapping {
    static func entry(_ entry: ProjectEntry, workspaceRoot: String) -> FeatureFileEntry {
        let path = NativeWorkspaceMapper.directoryPath(entry.path, workspaceRoot: workspaceRoot)
        return FeatureFileEntry(
            path: path,
            name: path.split(separator: "/").last.map(String.init) ?? path,
            kind: entry.kind == .directory ? .directory : .file,
            isHidden: path.split(separator: "/").contains { $0.hasPrefix(".") },
            isIgnored: entry.ignored == true
        )
    }
}
