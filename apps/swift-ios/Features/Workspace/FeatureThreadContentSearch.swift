import Foundation
import Observation

public struct FeatureThreadContentMatch: Equatable, Sendable {
    public let environmentID: String
    public let threadID: String
    public let projectID: String
    public let snippet: String

    /// Scope wire IDs before results reach any merged environment list.
    public init(environmentID: String, threadID: String, projectID: String, snippet: String) {
        self.environmentID = environmentID
        self.threadID = FeatureScopedID.thread(environmentID: environmentID, wireID: threadID)
        self.projectID = FeatureScopedID.project(environmentID: environmentID, wireID: projectID)
        self.snippet = String(snippet.prefix(240))
    }
}

extension ThreadContentSearchResult {
    func featureMatches(environmentID: String) -> [FeatureThreadContentMatch] {
        matches.filter { $0.source == "user" || $0.source == "assistant" }.prefix(50).map {
            FeatureThreadContentMatch(
                environmentID: environmentID, threadID: $0.threadId,
                projectID: $0.projectId, snippet: $0.snippet
            )
        }
    }
}

@MainActor
public protocol FeatureThreadContentSearching: AnyObject {
    func searchThreadContent(query: String, environmentIDs: [String]) async throws -> [FeatureThreadContentMatch]
}

struct FeatureThreadSearchRequest: Equatable, Sendable {
    let query: String
    let environmentIDs: [String]
    let connectedEnvironmentIDs: [String]

    init(query: String, environmentIDs: [String], connectedEnvironmentIDs: [String]? = nil) {
        self.query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        self.environmentIDs = Array(Set(environmentIDs)).sorted()
        self.connectedEnvironmentIDs = Array(
            Set(connectedEnvironmentIDs ?? environmentIDs).intersection(environmentIDs)
        ).sorted()
    }

    init(query: String, snapshot: FeatureSnapshot, projectID: String?) {
        let project = snapshot.projects.first { $0.id == projectID }
        let environments = snapshot.environments.filter {
            $0.isEnabled && (projectID == nil || $0.id == project?.environmentID)
        }
        self.init(
            query: query,
            environmentIDs: environments.map(\.id),
            connectedEnvironmentIDs: environments.filter {
                $0.connectionState == .connected
            }.map(\.id)
        )
    }

    var canSearchContent: Bool {
        (2...200).contains(query.utf16.count) && !connectedEnvironmentIDs.isEmpty
    }
}

/// The task belongs to the caller. Generation and request checks also cover
/// transports that finish after cancellation or after a query changes away and back.
@MainActor @Observable
final class FeatureThreadContentSearch {
    private(set) var isSearching = false
    private var request: FeatureThreadSearchRequest?
    private var generation: UInt64 = 0
    private var results: [FeatureThreadContentMatch] = []
    @ObservationIgnored private let debounce: @MainActor () async throws -> Void

    init(debounce: @escaping @MainActor () async throws -> Void = {
        try await Task.sleep(for: .milliseconds(250))
    }) {
        self.debounce = debounce
    }

    func matches(for request: FeatureThreadSearchRequest) -> [FeatureThreadContentMatch] {
        self.request == request ? results : []
    }

    func search(_ request: FeatureThreadSearchRequest, using client: (any FeatureThreadContentSearching)?) async {
        generation &+= 1
        let startedGeneration = generation
        self.request = request
        results = []
        isSearching = request.canSearchContent && client != nil
        guard isSearching, let client else { return }
        defer {
            if generation == startedGeneration { isSearching = false }
        }
        do {
            try await debounce()
            try Task.checkCancellation()
            guard generation == startedGeneration else { return }
            let matches = try await client.searchThreadContent(
                query: request.query, environmentIDs: request.connectedEnvironmentIDs
            )
            try Task.checkCancellation()
            guard generation == startedGeneration else { return }
            let selected = Set(request.connectedEnvironmentIDs)
            results = matches.filter { selected.contains($0.environmentID) }
        } catch {
            // Local title, project, preview and PR matches stay usable offline.
        }
    }
}

enum FeatureThreadSearchFanout {
    static let maximumConcurrentRequests = 3

    /// Keep at most three server searches in flight, with one bounded response
    /// per server. A failed or unsupported server contributes no content matches.
    @MainActor
    static func search(
        environmentIDs: [String],
        request: @escaping @MainActor @Sendable (String) async throws -> [FeatureThreadContentMatch]
    ) async -> [FeatureThreadContentMatch] {
        await withTaskGroup(of: [FeatureThreadContentMatch].self) { group in
            var remaining = Array(Set(environmentIDs)).sorted().makeIterator()
            let load: @Sendable (String) async -> [FeatureThreadContentMatch] = { id in
                guard !Task.isCancelled else { return [] }
                return (try? await request(id)) ?? []
            }
            for _ in 0..<maximumConcurrentRequests {
                if let id = remaining.next() {
                    _ = group.addTaskUnlessCancelled { await load(id) }
                }
            }
            var matches: [FeatureThreadContentMatch] = []
            for await result in group {
                guard !Task.isCancelled else {
                    group.cancelAll()
                    return []
                }
                matches.append(contentsOf: result.prefix(50))
                if let id = remaining.next() {
                    _ = group.addTaskUnlessCancelled { await load(id) }
                }
            }
            return matches.sorted {
                if $0.environmentID != $1.environmentID { return $0.environmentID < $1.environmentID }
                return $0.threadID < $1.threadID
            }
        }
    }
}
