import CryptoKit
import Foundation

/// A cache lease binds reads and delayed writes to one saved connection. Clearing
/// or replacing that connection revokes its lease, including in-flight HTTP reads.
actor ClientReadCache {
    private final class WeakStore {
        weak var value: ClientReadCache?
        init(_ value: ClientReadCache) { self.value = value }
    }
    @MainActor private static var stores: [URL: WeakStore] = [:]

    /// Clients using the same catalog share revocation and pending writes.
    @MainActor static func shared(directoryURL: URL) -> ClientReadCache {
        let url = directoryURL.standardizedFileURL
        if let store = stores[url]?.value { return store }
        stores = stores.filter { $0.value.value != nil }
        let store = ClientReadCache(directoryURL: url)
        stores[url] = WeakStore(store)
        return store
    }
    struct Scope: Codable, Equatable, Sendable {
        let environmentID: String
        let endpointFingerprint: String
        let preference: OrchestrationProtocolPreference
        private var legacyEndpointFingerprints: Set<String>?

        init(_ environment: Environment) {
            environmentID = environment.id
            preference = environment.orchestrationProtocolPreference
            let selected = environment.selectedRoute
            let verifiedCatalog = environment.descriptor?.environmentId == environment.id
                && selected.httpBaseURL == environment.httpBaseURL
                && selected.webSocketBaseURL == environment.webSocketBaseURL && selected.kind == environment.kind
            endpointFingerprint = verifiedCatalog ? Self.fingerprint("environment:" + environment.id)
                : Self.fingerprint([environment.httpBaseURL.absoluteString, environment.webSocketBaseURL.absoluteString,
                                    environment.kind.rawValue].joined(separator: "\u{0}"))
            // Only explicitly paired, identity-checked origins may import a
            // pre-route cache. Learned hints have not proved identity yet.
            if verifiedCatalog {
                legacyEndpointFingerprints = Set(environment.routes.filter { !$0.isLearned }.map {
                    Self.fingerprint([$0.httpBaseURL.absoluteString,
                                      $0.webSocketBaseURL.absoluteString, $0.kind.rawValue].joined(separator: "\u{0}"))
                })
            }

        }

        static func == (lhs: Scope, rhs: Scope) -> Bool {
            lhs.environmentID == rhs.environmentID && lhs.preference == rhs.preference
                && lhs.endpointFingerprint == rhs.endpointFingerprint
        }

        func acceptsLegacy(_ saved: Scope) -> Bool {
            environmentID == saved.environmentID && preference == saved.preference
                && legacyEndpointFingerprints?.contains(saved.endpointFingerprint) == true
        }

        static func fingerprint(_ value: String) -> String {
            SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
        }
    }

    struct Lease: Equatable, Sendable {
        let scope: Scope
        let generation: UUID
    }

    struct Summary: Sendable {
        let environmentID: String
        let shellCount: Int
        let threadCount: Int
        let bytes: Int64
    }

    private struct History: Codable {
        let snapshot: OrchestrationThreadDetailSnapshot
        let savedAt: Date
    }

    private struct Document: Codable {
        var version = 1
        let scope: Scope
        var shell: OrchestrationShellSnapshot?
        var histories: [String: History] = [:]
        var savedAt = Date.now
    }

    static let maximumHistoryBytes = 2 * 1_024 * 1_024
    static let maximumEnvironmentBytes = 8 * 1_024 * 1_024
    static let maximumTotalBytes = 32 * 1_024 * 1_024
    static let maximumHistories = 16
    static let maximumEnvironments = 16

    let directoryURL: URL
    private let writeDelay: Duration
    private var leases: [String: Lease] = [:]
    private var documents: [String: Document] = [:]
    private var writes: [String: Task<Void, Never>] = [:]
    private let clock = ContinuousClock()
    private var lastWrittenAt: [String: ContinuousClock.Instant] = [:]
    private var receivedLiveShell: Set<String> = []
    private var deletedThreadIDs: [String: Set<String>] = [:]
    private var deletedProjectIDs: [String: Set<String>] = [:]

    init(directoryURL: URL? = nil, writeDelay: Duration = .seconds(1)) {
        self.directoryURL = directoryURL ?? FileManager.default.urls(
            for: .cachesDirectory, in: .userDomainMask
        ).first!.appendingPathComponent("T3CodeSwift/client-reads", isDirectory: true)
        self.writeDelay = writeDelay
    }

    func activate(_ scope: Scope) throws -> Lease {
        if let lease = leases[scope.environmentID], lease.scope == scope { return lease }
        let id = scope.environmentID
        writes.removeValue(forKey: id)?.cancel()
        var saved = readDocument(id)
        if let legacy = saved, legacy.scope != scope, scope.acceptsLegacy(legacy.scope) {
            saved = Document(scope: scope, shell: legacy.shell, histories: legacy.histories, savedAt: legacy.savedAt)
        }
        if saved?.scope != scope { try removeFile(id) }
        documents[id] = saved?.scope == scope ? saved : Document(scope: scope)
        receivedLiveShell.remove(id)
        deletedThreadIDs[id] = nil
        deletedProjectIDs[id] = nil
        let lease = Lease(scope: scope, generation: UUID())
        leases[id] = lease
        return lease
    }

    func shell(for lease: Lease) -> OrchestrationShellSnapshot? {
        guard isCurrent(lease) else { return nil }
        return documents[lease.scope.environmentID]?.shell
    }

    func history(threadID: String, lease: Lease) -> OrchestrationThreadDetailSnapshot? {
        guard isCurrent(lease), let document = documents[lease.scope.environmentID],
              document.shell?.threads.contains(where: { $0.id == threadID }) == true else { return nil }
        return document.histories[threadID]?.snapshot
    }

    func record(shell: OrchestrationShellSnapshot, lease: Lease) {
        guard isCurrent(lease), (1...2).contains(shell.orchestrationProtocolVersion ?? 1) else { return }
        let id = lease.scope.environmentID
        var shell = shell
        applyDeletions(to: &shell, environmentID: id)
        var document = documents[id] ?? Document(scope: lease.scope)
        if receivedLiveShell.contains(id), let current = document.shell,
           (current.orchestrationProtocolVersion ?? 1) == (shell.orchestrationProtocolVersion ?? 1),
           current.snapshotSequence > shell.snapshotSequence { return }
        receivedLiveShell.insert(id)
        if (document.shell?.orchestrationProtocolVersion ?? 1) != (shell.orchestrationProtocolVersion ?? 1) {
            document.histories.removeAll()
        }
        document.shell = shell
        let projects = Set(shell.projects.map(\.id))
        let threads = Set(shell.threads.filter { projects.contains($0.projectId) }.map(\.id))
        document.histories = document.histories.filter { threads.contains($0.key) }
        documents[id] = document
        schedule(lease)
    }

    func record(history: OrchestrationThreadDetailSnapshot, lease: Lease, expanded: Bool = false) {
        // A running turn must keep the last readable copy, without encoding its
        // streaming output. Only an explicit deletion invalidates that copy.
        guard isCurrent(lease), !expanded,
              history.thread.deletedAt != nil || Self.isEligible(history),
              var document = documents[lease.scope.environmentID], let shell = document.shell,
              (history.orchestrationProtocolVersion ?? 1) == (shell.orchestrationProtocolVersion ?? 1),
              shell.threads.contains(where: { $0.id == history.thread.id && $0.projectId == history.thread.projectId })
        else { return }
        if history.thread.deletedAt != nil {
            guard document.histories.removeValue(forKey: history.thread.id) != nil else { return }
            documents[lease.scope.environmentID] = document
            schedule(lease)
            return
        }
        guard let data = try? JSONEncoder.t3.encode(history), data.count <= Self.maximumHistoryBytes else {
            guard document.histories.removeValue(forKey: history.thread.id) != nil else { return }
            documents[lease.scope.environmentID] = document
            schedule(lease)
            return
        }
        document.histories[history.thread.id] = History(snapshot: history, savedAt: .now)
        for key in document.histories.sorted(by: { $0.value.savedAt > $1.value.savedAt })
            .dropFirst(Self.maximumHistories).map(\.key) {
            document.histories[key] = nil
        }
        documents[lease.scope.environmentID] = document
        schedule(lease)
    }

    static func isEligible(_ snapshot: OrchestrationThreadDetailSnapshot) -> Bool {
        let thread = snapshot.thread
        guard thread.deletedAt == nil, !thread.messages.contains(where: \.streaming) else { return false }
        if let control = thread.orchestrationV2Control {
            // V2 waiting runs can be read offline. Their normalized legacy
            // session may still say running; use the native run status.
            return !(control["runs"]?.v2Array ?? []).contains {
                ["preparing", "starting", "running"].contains($0["status"]?.stringValue ?? "")
            }
        }
        return !["preparing", "starting", "running"].contains(thread.session?.status ?? "")
            && !["preparing", "starting", "running"].contains(thread.latestTurn?.state ?? "")
    }

    /// Accepted deletions must survive even if the follow-up network read fails.
    func remove(threadID: String? = nil, projectID: String? = nil, lease: Lease) throws {
        guard isCurrent(lease) else { return }
        let id = lease.scope.environmentID
        if let threadID { deletedThreadIDs[id, default: []].insert(threadID) }
        if let projectID { deletedProjectIDs[id, default: []].insert(projectID) }
        guard var document = documents[id], var shell = document.shell else { return }
        applyDeletions(to: &shell, environmentID: id)
        document.shell = shell
        let threads = Set(shell.threads.map(\.id))
        document.histories = document.histories.filter { threads.contains($0.key) }
        documents[id] = document
        try persist(lease)
    }

    private func applyDeletions(to shell: inout OrchestrationShellSnapshot, environmentID: String) {
        shell.projects.removeAll { deletedProjectIDs[environmentID]?.contains($0.id) == true }
        shell.threads.removeAll {
            deletedThreadIDs[environmentID]?.contains($0.id) == true
                || deletedProjectIDs[environmentID]?.contains($0.projectId) == true
        }
    }

    /// Revocation is synchronous within the actor, before touching the filesystem.
    /// Only a newly acquired lease can write data after a clear.
    func clear(environmentID: String?) throws {
        let ids = environmentID.map { [$0] } ?? Array(Set(leases.keys).union(documents.keys))
        for id in ids {
            leases[id] = nil
            documents[id] = nil
            lastWrittenAt[id] = nil
            receivedLiveShell.remove(id)
            deletedThreadIDs[id] = nil
            deletedProjectIDs[id] = nil
            writes.removeValue(forKey: id)?.cancel()
        }
        if let environmentID { try removeFile(environmentID) }
        else if FileManager.default.fileExists(atPath: directoryURL.path) {
            try FileManager.default.removeItem(at: directoryURL)
        }
    }

    func retainEnvironments(_ scopes: [Scope]) throws {
        let allowed = Dictionary(scopes.map { ($0.environmentID, $0) }, uniquingKeysWith: { _, last in last })
        for document in diskDocuments() where allowed[document.scope.environmentID] != document.scope {
            try clear(environmentID: document.scope.environmentID)
        }
        for (id, lease) in leases where allowed[id] != lease.scope { try clear(environmentID: id) }
    }

    func summary() -> [Summary] {
        diskDocuments().map { document in
            let size = (try? fileURL(document.scope.environmentID).resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            return Summary(environmentID: document.scope.environmentID,
                           shellCount: document.shell == nil ? 0 : 1,
                           threadCount: document.histories.count, bytes: Int64(size))
        }
    }

    /// Also used by deterministic tests. No sleep is required to await persistence.
    func flush() throws {
        for lease in Array(leases.values) where writes[lease.scope.environmentID] != nil {
            try persist(lease)
        }
    }

    private func isCurrent(_ lease: Lease) -> Bool { leases[lease.scope.environmentID] == lease }

    private func schedule(_ lease: Lease) {
        let id = lease.scope.environmentID
        guard writes[id] == nil else { return }
        // Save the first read promptly, then coalesce frequent shell updates.
        let cooldown = lastWrittenAt[id].map { Duration.seconds(10) - $0.duration(to: clock.now) } ?? .zero
        let delay = max(writeDelay, cooldown)
        writes[id] = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            try? await self?.persist(lease)
        }
    }

    private func persist(_ lease: Lease) throws {
        guard isCurrent(lease), var document = documents[lease.scope.environmentID] else { return }
        let id = lease.scope.environmentID
        writes.removeValue(forKey: id)?.cancel()
        document.savedAt = .now
        var data = try JSONEncoder.t3.encode(document)
        while data.count > Self.maximumEnvironmentBytes, let oldest = document.histories.min(by: { $0.value.savedAt < $1.value.savedAt }) {
            document.histories[oldest.key] = nil
            data = try JSONEncoder.t3.encode(document)
        }
        guard data.count <= Self.maximumEnvironmentBytes else {
            documents[id] = Document(scope: lease.scope)
            try removeFile(id)
            return
        }
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        var directory = directoryURL
        var attributes = URLResourceValues()
        attributes.isExcludedFromBackup = true
        try directory.setResourceValues(attributes)
        try data.write(to: fileURL(id), options: .atomic)
        lastWrittenAt[id] = clock.now
        documents[id] = document
        try pruneFiles()
    }

    private func pruneFiles() throws {
        // Pruning needs filesystem metadata only. Decoding all saved histories
        // here would put up to 32 MiB of JSON work on every shell write.
        let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
        let files = try FileManager.default.contentsOfDirectory(
            at: directoryURL, includingPropertiesForKeys: Array(keys)
        ).filter { $0.pathExtension == "json" }.compactMap { url -> (URL, Int, Date)? in
            guard let values = try? url.resourceValues(forKeys: keys) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 > $1.2 }
        let environmentIDs = Dictionary(uniqueKeysWithValues: Set(leases.keys).union(documents.keys).map {
            (fileURL($0).lastPathComponent, $0)
        })
        var bytes = 0
        for (index, file) in files.enumerated() {
            let (url, size, _) = file
            bytes += size
            if index >= Self.maximumEnvironments || bytes > Self.maximumTotalBytes {
                if let id = environmentIDs[url.lastPathComponent] {
                    writes.removeValue(forKey: id)?.cancel()
                    documents[id] = nil
                    lastWrittenAt[id] = nil
                    receivedLiveShell.remove(id)
                }
                try FileManager.default.removeItem(at: url)
            }
        }
    }

    private func fileURL(_ id: String) -> URL {
        directoryURL.appendingPathComponent(Scope.fingerprint(id) + ".json")
    }

    private func removeFile(_ id: String) throws {
        let url = fileURL(id)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    private func readDocument(_ id: String) -> Document? { readDocument(at: fileURL(id)) }

    private func readDocument(at url: URL) -> Document? {
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= Self.maximumEnvironmentBytes,
              let data = try? Data(contentsOf: url),
              let document = try? JSONDecoder.t3.decode(Document.self, from: data), document.version == 1,
              document.shell.map({ (1...2).contains($0.orchestrationProtocolVersion ?? 1) }) ?? true else { return nil }
        return document
    }

    private func diskDocuments() -> [Document] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directoryURL, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap { readDocument(at: $0) }
    }
}
