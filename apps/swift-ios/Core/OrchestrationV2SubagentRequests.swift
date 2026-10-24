import Foundation

public enum OrchestrationV2PendingSubagentRequest: String, Codable, Hashable, Sendable {
    case approval
    case userInput = "user_input"
}

/// Retains only the shell facts needed to surface hidden child requests.
public struct OrchestrationV2SubagentRequestSource: Codable, Hashable, Sendable {
    public let threadID: String
    public let title: String
    public var parentThreadID: String? = nil
    public var relationshipToParent: String? = nil
    public var request: OrchestrationV2PendingSubagentRequest? = nil
    public let isClosed: Bool

    public init(shell: OrchestrationV2ThreadShell) {
        threadID = shell.id
        title = shell.thread.title
        parentThreadID = shell.thread.lineage.parentThreadId
        relationshipToParent = shell.thread.lineage.relationshipToParent
        isClosed = shell.thread.archivedAt != nil || shell.thread.deletedAt != nil
        // Explicit null means the activity ended, even if a queued follow-up
        // still carries a question. Older servers omit this field entirely.
        let live = shell.raw["activityRunStatus"] != nil
            ? shell.activityRunStatus != nil
            : ["preparing", "starting", "running", "waiting"].contains(shell.status)
        if !isClosed, live, relationshipToParent == "subagent",
           shell.thread.creationSource != "provider",
           let kind = shell.pendingRuntimeRequest?.kind, kind != "auth_refresh" {
            request = kind == "user_input" ? .userInput : .approval
        }
    }
}

public struct OrchestrationV2SubagentRequestTarget: Codable, Hashable, Sendable {
    public let environmentID: String
    public let threadID: String
    public let title: String
    public let request: OrchestrationV2PendingSubagentRequest
}

/// Build once per environment shell snapshot; row lookups do not walk lineage.
public struct OrchestrationV2SubagentRequests: Sendable {
    private var requestsByThread: [String: OrchestrationV2PendingSubagentRequest] = [:]
    private var inputsByThread: [String: [OrchestrationV2SubagentRequestTarget]] = [:]

    public init(environmentID: String, sources: [OrchestrationV2SubagentRequestSource]) {
        let byID = Dictionary(sources.filter { !$0.isClosed }.map { ($0.threadID, $0) },
                              uniquingKeysWith: { _, last in last })
        for child in sources where !child.isClosed {
            guard let request = child.request else { continue }
            let target = OrchestrationV2SubagentRequestTarget(environmentID: environmentID,
                threadID: child.threadID, title: child.title, request: request)
            var current = child
            var seen: Set<String> = [child.threadID]
            while current.relationshipToParent == "subagent",
                  let parentID = current.parentThreadID,
                  seen.insert(parentID).inserted, let parent = byID[parentID] {
                if requestsByThread[parentID] != .approval { requestsByThread[parentID] = request }
                inputsByThread[parentID, default: []].append(target)
                current = parent
            }
        }
    }

    public func pendingRequest(for threadID: String) -> OrchestrationV2PendingSubagentRequest? {
        requestsByThread[threadID]
    }

    public func childInputs(for threadID: String) -> [OrchestrationV2SubagentRequestTarget] {
        inputsByThread[threadID] ?? []
    }

    public static func childInputsTitle(_ children: [OrchestrationV2SubagentRequestTarget]) -> String {
        let approvals = children.filter { $0.request == .approval }.count
        let need = approvals == 0 ? "input" : approvals == children.count ? "approval" : "you"
        return children.count == 1 ? "Subagent needs \(need)" : "\(children.count) subagents need \(need)"
    }
}
