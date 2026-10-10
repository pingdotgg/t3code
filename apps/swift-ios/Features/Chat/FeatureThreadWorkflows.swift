import Foundation

/// Wire identity of a response. Inherited replies keep the original thread, item and run.
public struct FeatureThreadWorkflowSource: Sendable, Equatable, Hashable, Codable {
    public let itemID: String
    public let threadID: String
    public let runID: String

    public init(itemID: String, threadID: String, runID: String) {
        self.itemID = itemID
        self.threadID = threadID
        self.runID = runID
    }

    public init?(projectedItem: OrchestrationV2ProjectedTurnItem) {
        guard projectedItem.item.type == "assistant_message", let runID = projectedItem.item.runId else { return nil }
        self.init(itemID: projectedItem.sourceItemId, threadID: projectedItem.sourceThreadId, runID: runID)
    }
}

@MainActor
public protocol FeatureThreadWorkflowClient {
    /// Returns the target's environment-scoped ID after dispatch. The caller refreshes the shell before navigation.
    func forkThread(threadID: String, source: FeatureThreadWorkflowSource) async throws -> String
    func mergeBackThread(threadID: String) async throws -> String
}

public struct FeatureThreadAgent: Identifiable, Sendable, Equatable, Codable {
    public enum Status: String, Sendable, Codable {
        case pending, running, waiting, idle, completed, failed, cancelled, interrupted, unknown

        public var isActive: Bool { self == .pending || self == .running || self == .waiting }
        public var isTerminal: Bool {
            self == .completed || self == .failed || self == .cancelled || self == .interrupted
        }
        public var label: String { self == .unknown ? "Unknown" : rawValue.capitalized }
    }

    public let id: String
    public let runID: String?
    /// Navigation identity, scoped to the owning environment. Nil for agents without a child thread.
    public let childThreadID: String?
    public let origin: String
    public let title: String
    public let prompt: String
    public let driver: String
    public let providerInstanceID: String
    public let model: String?
    public let status: Status
    public let progress: String?
    public let result: String?
    public let startedAt: Date?
    public let completedAt: Date?
    public let updatedAt: Date

    public var detail: String? { status.isActive ? progress ?? result : result ?? progress }

    public init(_ agent: OrchestrationV2Subagent, environmentID: String) {
        id = agent.id
        runID = agent.runId
        childThreadID = agent.childThreadId.map { FeatureScopedID.thread(environmentID: environmentID, wireID: $0) }
        origin = agent.origin
        title = Self.displayTitle(agent.title, prompt: agent.prompt)
        prompt = agent.prompt
        driver = agent.driver
        providerInstanceID = agent.providerInstanceId
        model = agent.model
        status = Status(rawValue: agent.status) ?? .unknown
        progress = agent.progress
        result = agent.result
        startedAt = Self.date(agent.startedAt)
        completedAt = Self.date(agent.completedAt)
        updatedAt = Self.date(agent.updatedAt) ?? .distantPast
    }

    /// Historical transcript rows can remain after their roster entity is no longer loaded.
    public init?(projectedItem: OrchestrationV2ProjectedTurnItem, environmentID: String) {
        let item = projectedItem.item
        guard case let .subagent(subagentID, childID, prompt, progress, result) = item.content else { return nil }
        id = subagentID
        runID = item.runId
        childThreadID = childID.map { FeatureScopedID.thread(environmentID: environmentID, wireID: $0) }
        origin = item.raw["origin"]?.stringValue ?? "provider"
        title = Self.displayTitle(item.title, prompt: prompt)
        self.prompt = prompt
        driver = item.raw["driver"]?.stringValue ?? ""
        providerInstanceID = item.raw["providerInstanceId"]?.stringValue ?? ""
        model = item.raw["model"]?.stringValue
        status = Status(rawValue: item.status) ?? .unknown
        self.progress = progress
        self.result = result
        startedAt = Self.date(item.startedAt)
        completedAt = Self.date(item.completedAt)
        updatedAt = Self.date(item.updatedAt) ?? .distantPast
    }

    private static func displayTitle(_ title: String?, prompt: String) -> String {
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return title }
        let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return prompt.isEmpty ? "Agent" : String(prompt.prefix(80))
    }

    private static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value))
    }
}

public struct FeatureThreadAgentRoster: Sendable, Equatable, Codable {
    public let runID: String?
    public let turnActive: Bool
    public let agents: [FeatureThreadAgent]
    public var liveCount: Int { agents.filter { $0.status.isActive }.count }
    public var settledCount: Int { agents.filter { $0.status.isTerminal }.count }
}

public struct FeatureThreadMergeBack: Sendable, Equatable, Codable {
    public let targetThreadID: String
    public let runID: String
}

/// The RN thread workflow policy, derived from V2 control state. V1 remains unavailable.
public struct FeatureThreadWorkflows: Sendable, Equatable, Codable {
    public let isAvailable: Bool
    public let agents: [FeatureThreadAgent]
    public let agentRoster: FeatureThreadAgentRoster?
    public let mergeBack: FeatureThreadMergeBack?
    /// RN's read-only provider-child composer links back to its owning parent.
    public let providerParentThreadID: String?
    private let forkableSources: Set<FeatureThreadWorkflowSource>

    public static let unavailable = FeatureThreadWorkflows()

    private init() {
        isAvailable = false
        agents = []
        agentRoster = nil
        mergeBack = nil
        providerParentThreadID = nil
        forkableSources = []
    }

    public init(projection raw: JSONValue, environmentID: String) throws {
        // Live updates can contain a large transcript. Decode only the keys
        // Projection reads, so messages and full turn items are skipped.
        let keys = ["thread", "runs", "subagents", "providerThreads", "providerSessions", "visibleTurnItems"]
        let projection = try JSONValue.object(Dictionary(uniqueKeysWithValues: keys.compactMap { key in
            raw[key].map { (key, $0) }
        })).decode(Projection.self)
        isAvailable = true
        if projection.thread.creationSource == "provider",
           projection.thread.lineage.relationshipToParent == "subagent",
           let parentID = projection.thread.lineage.parentThreadId, parentID != projection.thread.id {
            providerParentThreadID = FeatureScopedID.thread(environmentID: environmentID, wireID: parentID)
        } else {
            providerParentThreadID = nil
        }
        let allAgents = projection.subagents.map { FeatureThreadAgent($0, environmentID: environmentID) }
        agents = allAgents.sorted {
            let lhs = $0.startedAt ?? $0.updatedAt
            let rhs = $1.startedAt ?? $1.updatedAt
            return lhs == rhs ? $0.id < $1.id : lhs < rhs
        }
        let activeRun = projection.runs.last { ["preparing", "starting", "running", "waiting"].contains($0.status) }
        let latestAgent = allAgents.reduce(nil as FeatureThreadAgent?) { latest, agent in
            guard let latest else { return agent }
            return agent.updatedAt > latest.updatedAt ? agent : latest
        }
        let rosterRunID = activeRun?.id ?? latestAgent?.runID
        let rosterAgents = agents.filter { $0.runID == rosterRunID }
        agentRoster = rosterAgents.isEmpty ? nil : FeatureThreadAgentRoster(
            runID: rosterRunID, turnActive: activeRun != nil, agents: rosterAgents
        )
        if let targetID = projection.mergeBackTargetID, let run = projection.latestMergeBackRun {
            mergeBack = FeatureThreadMergeBack(
                targetThreadID: FeatureScopedID.thread(environmentID: environmentID, wireID: targetID), runID: run.id
            )
        } else {
            mergeBack = nil
        }
        forkableSources = Set(projection.visibleTurnItems.compactMap { row in
            guard let source = row.source,
                  Self.canFork(itemType: row.item.type, status: row.item.status, runID: row.item.runId,
                               capabilities: projection.capabilities(for: row)) else { return nil }
            return source
        })
    }

    public func canFork(_ source: FeatureThreadWorkflowSource) -> Bool {
        isAvailable && forkableSources.contains(source)
    }

    static func canFork(itemType: String, status: String, runID: String?, capabilities: JSONValue?) -> Bool {
        guard itemType == "assistant_message", status == "completed", let runID, !runID.isEmpty else { return false }
        // Historical replies may outlive their session. Let the server choose a portable fallback.
        guard let capabilities else { return true }
        return (capabilities["threads"]?["canForkThread"]?.boolValue == true
            && capabilities["threads"]?["canForkFromTurn"]?.boolValue == true
            && capabilities["identity"]?["nativeThreadIds"]?.stringValue == "strong")
            || capabilities["context"]?["supportsFullThreadHandoff"]?.boolValue == true
    }
}

extension FeatureThreadWorkflows {
    /// Decodes both full projections and compact native controls without copying transcript text.
    struct Projection: Decodable {
        struct Thread: Decodable {
            struct Lineage: Decodable {
                let relationshipToParent: String?
                let parentThreadId: String?
            }
            struct ForkSource: Decodable {
                let type: String
                let threadId: String?
            }
            let id: String
            let title: String
            let creationSource: String
            let lineage: Lineage
            let forkedFrom: ForkSource?
        }
        struct Run: Decodable {
            let id: String
            let ordinal: Int
            let status: String
        }
        struct ProviderThread: Decodable {
            let id: String
            let providerSessionId: String?
        }
        struct Session: Decodable {
            let id: String
            let capabilities: JSONValue
        }
        struct Row: Decodable {
            struct Item: Decodable {
                let type: String
                let runId: String?
                let status: String
                let providerThreadId: String?
            }
            let sourceThreadId: String
            let sourceItemId: String
            let item: Item
            var source: FeatureThreadWorkflowSource? {
                guard item.type == "assistant_message", let runID = item.runId else { return nil }
                return FeatureThreadWorkflowSource(itemID: sourceItemId, threadID: sourceThreadId, runID: runID)
            }
        }
        let thread: Thread
        let runs: [Run]
        let subagents: [OrchestrationV2Subagent]
        let providerThreads: [ProviderThread]
        let providerSessions: [Session]
        let visibleTurnItems: [Row]

        var mergeBackTargetID: String? {
            guard thread.lineage.relationshipToParent == "fork" else { return nil }
            let target = thread.forkedFrom?.type == "run"
                ? thread.forkedFrom?.threadId : thread.lineage.parentThreadId
            guard let target, !target.isEmpty, target != thread.id else { return nil }
            return target
        }

        var latestMergeBackRun: Run? {
            guard let latest = runs.filter({ $0.status == "waiting" || $0.status == "completed" })
                .max(by: { $0.ordinal < $1.ordinal }),
                  !runs.contains(where: {
                      $0.ordinal > latest.ordinal && ["preparing", "starting", "running"].contains($0.status)
                  }) else { return nil }
            return latest
        }

        func capabilities(for row: Row) -> JSONValue? {
            // Provider IDs in the destination projection do not describe an inherited source row.
            guard row.sourceThreadId == thread.id,
                  let providerID = row.item.providerThreadId,
                  let sessionID = providerThreads.first(where: { $0.id == providerID })?.providerSessionId else { return nil }
            return providerSessions.first { $0.id == sessionID }?.capabilities
        }
    }
}
