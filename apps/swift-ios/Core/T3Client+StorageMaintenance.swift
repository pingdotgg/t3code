import Foundation

public struct DatabaseStorageStatus: Codable, Equatable, Sendable {
    public let databaseBytes: Double
    public let reclaimableBytes: Double
    public let incrementalVacuumEnabled: Bool
    public let compactCommand: String

    public var shouldRecommendCompaction: Bool {
        !incrementalVacuumEnabled && reclaimableBytes >= 1_073_741_824
    }
}

public struct StorageCleanupReportEntry: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case worktree, browserArtifacts = "browser-artifacts", logs
    }

    public enum Outcome: String, Codable, Sendable {
        case removed, kept, failed
    }

    public let kind: Kind
    public let outcome: Outcome
    public let reason: String
    public let path: String?
    public let threadId: String?
    public let threadTitle: String?
    public let bytes: Double?
    public let files: Double?
}

public struct StorageCleanupReport: Codable, Equatable, Sendable {
    public enum Trigger: String, Codable, Sendable {
        case automatic, manual
    }

    public struct Counts: Codable, Equatable, Sendable {
        public let removed: Double
        public let kept: Double
        public let failed: Double
    }

    public let trigger: Trigger
    public let startedAt: String
    public let finishedAt: String
    public let entries: [StorageCleanupReportEntry]
    public let counts: Counts
    public let omittedCount: Double
    public let bytesFreed: Double

    private enum CodingKeys: String, CodingKey {
        case trigger, startedAt, finishedAt, entries, counts, omittedCount, bytesFreed
    }
}

extension StorageCleanupReport {
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        trigger = try values.decode(Trigger.self, forKey: .trigger)
        startedAt = try values.decode(String.self, forKey: .startedAt)
        finishedAt = try values.decode(String.self, forKey: .finishedAt)
        entries = try values.decode([StorageCleanupReportEntry].self, forKey: .entries)
        counts = try values.decode(Counts.self, forKey: .counts)
        omittedCount = try values.decode(Double.self, forKey: .omittedCount)
        bytesFreed = try values.contains(.bytesFreed) ? values.decode(Double.self, forKey: .bytesFreed) : 0
    }
}

public extension ServerSettingsSnapshot {
    /// Project custom rules can enable cleanup even when the environment defaults are off.
    var hasEnabledStorageCleanupRules: Bool {
        let storage = storageCleanup ?? [:]
        func enabled(_ rules: [String: JSONValue]) -> Bool {
            ["worktreeAfterDays", "worktreeSettledAfterDays"].contains {
                if case .number = rules[$0] { return true }
                return false
            } || ["worktreeOnMerge", "worktreeOnDelete", "worktreeUnchanged"].contains {
                rules[$0]?.boolValue == true
            }
        }

        let worktreeRules: [String: JSONValue]
        switch worktreeCleanup?["mode"]?.stringValue {
        case "off": worktreeRules = [:]
        case "custom":
            if case let .object(rules) = worktreeCleanup?["rules"] { worktreeRules = rules }
            else { worktreeRules = [:] }
        default: worktreeRules = storage
        }
        return ["browserArtifactsAfterDays", "logsAfterDays"].contains {
            if case .number = storage[$0] { return true }
            return false
        } || enabled(worktreeRules) || projectSettingsOverrides.values.contains { entry in
            guard entry["worktreeCleanup"]?["mode"]?.stringValue == "custom",
                  case let .object(rules) = entry["worktreeCleanup"]?["rules"] else { return false }
            return enabled(rules)
        }
    }
}

extension T3Client {
    public func getDatabaseStorage() async -> AsyncThrowingStream<DatabaseStorageStatus?, Error> {
        await rpc.subscribe("server.getDatabaseStorage", payload: .object([:]), as: DatabaseStorageStatus?.self)
    }

    public func getStorageCleanupReport() async -> AsyncThrowingStream<StorageCleanupReport?, Error> {
        await rpc.subscribe("server.getStorageCleanupReport", payload: .object([:]), as: StorageCleanupReport?.self)
    }

    public func runStorageCleanup() async throws -> StorageCleanupReport {
        try await rpc.request("server.runStorageCleanup", payload: .object([:]), as: StorageCleanupReport.self)
    }
}
