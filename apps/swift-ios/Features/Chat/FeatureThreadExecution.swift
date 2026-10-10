import Foundation

/// V2 queue commands. IDs identify wire runs; the client resolves the scoped thread ID.
public enum FeatureThreadQueueAction: Sendable, Equatable {
    case cancel(runID: String)
    case reorder(runID: String, beforeRunID: String?)
    case promoteToSteer(queuedRunID: String, targetRunID: String)
    case resume
    /// Omitting attachments and context from the command preserves both on the server.
    case edit(runID: String, text: String)
    /// Replaces text, attachments and context using the original message identity.
    case replace(FeatureQueuedRunEdit)
    case interrupt(runID: String, holdQueue: Bool)
}

@MainActor
public protocol FeatureThreadQueueManaging {
    func updateThreadQueue(threadID: String, action: FeatureThreadQueueAction) async throws
}

/// Execution and queue controls derived from a V2 projection, never from legacy thread status.
public struct FeatureThreadExecution: Sendable, Equatable, Codable {
    public enum RunStatus: String, Sendable, Equatable, Codable, CaseIterable {
        case preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled
        case rolledBack = "rolled_back"

        public var isActive: Bool {
            switch self {
            case .preparing, .starting, .running, .waiting: true
            default: false
            }
        }

        public var isInterruptible: Bool {
            switch self {
            case .preparing, .starting, .running: true
            default: false
            }
        }
    }

    public struct Run: Identifiable, Sendable, Equatable, Codable {
        public let id: String
        public let ordinal: Int
        public let status: RunStatus
        public let userMessageID: String
        public let providerThreadID: String?
        public let activeAttemptID: String?
        public let rootNodeID: String?
        public let queuePosition: Int?
        public let queueHeld: Bool?
        public let requestedAt: String
        public let startedAt: String?
        public let completedAt: String?
        public let workStartedAt: String?
        public let workspacePreparation: JSONValue?

        public var activityStartedAt: String { workStartedAt ?? startedAt ?? requestedAt }

        private enum CodingKeys: String, CodingKey {
            case id, ordinal, status, queuePosition, queueHeld, requestedAt, startedAt, completedAt
            case workStartedAt, workspacePreparation
            case userMessageID = "userMessageId"
            case providerThreadID = "providerThreadId"
            case activeAttemptID = "activeAttemptId"
            case rootNodeID = "rootNodeId"
        }
    }

    public struct Attachment: Identifiable, Sendable, Equatable, Codable {
        public let id: String
        public let name: String
        public let mimeType: String
        public let sizeBytes: Int
        public var type: String? = nil
        public var source: JSONValue? = nil

        public var wireValue: JSONValue {
            var value: [String: JSONValue] = [
                "id": .string(id), "name": .string(name), "mimeType": .string(mimeType),
                "sizeBytes": .number(Double(sizeBytes)),
                "type": .string(type ?? (mimeType.hasPrefix("image/") ? "image" : "file")),
            ]
            value["source"] = source
            return .object(value)
        }
    }

    public struct QueuedEntry: Identifiable, Sendable, Equatable, Codable {
        public let run: Run
        public let text: String
        public let attachments: [Attachment]
        public let hasMessage: Bool
        public var context: OrchestrationMessageContext? = nil

        public var id: String { run.id }
        public var messageID: String { run.userMessageID }
    }

    public let activeRun: Run?
    public let interruptibleRun: Run?
    public let queuedEntries: [QueuedEntry]
    public let isQueueHeld: Bool
    public let canManageQueue: Bool
    public let isReadOnly: Bool
    public let canReorder: Bool
    public let canPromoteToSteer: Bool
    public let canSteer: Bool
    public let canRestart: Bool
    public let canInterrupt: Bool
    /// Separate from a run interrupt: a never-run thread can still watch PRs.
    public var watchedPullRequests: [ThreadPullRequestLink]? = nil
    public var canStopThread: Bool {
        // Watching is thread work even when queue editing is unavailable. The
        // caller checks the destination environment's permission before Stop.
        canInterrupt || watchedPullRequests?.isEmpty == false
    }
    /// A timeline error must also have the workspace failure code before showing Retry.
    public var failedWorkspaceRunIDs: Set<String>? = nil

    /// Reads the full V2 projection after transport decoding. Unknown fields are ignored.
    public init(projection raw: JSONValue) throws {
        // Live updates can contain a large transcript. Decode control records only;
        // do not encode all turn items and assistant text again on each update.
        let keys = ["thread", "runs", "messages", "providerThreads", "providerSessions", "providerTurns", "nodes", "attempts"]
        var fields = Dictionary(uniqueKeysWithValues: keys.compactMap { key in
            raw[key].map { (key, $0) }
        })
        fields["backgroundTurnItems"] = raw["backgroundTurnItems"]
            ?? .array((raw["turnItems"]?.v2Array ?? []).compactMap(OrchestrationV2Presentation.backgroundControlItem))
        if case let .array(runs)? = raw["runs"], case let .array(messages)? = raw["messages"] {
            let queuedMessageIDs = Set(runs.compactMap { run -> String? in
                guard run["status"]?.stringValue == "queued" else { return nil }
                return run["userMessageId"]?.stringValue
            })
            fields["messages"] = .array(messages.filter {
                guard let id = $0["id"]?.stringValue else { return false }
                return queuedMessageIDs.contains(id)
            })
        }
        let projection = try JSONValue.object(fields).decode(Projection.self)
        watchedPullRequests = projection.thread.pullRequests?.filter(\.isWatched)
        failedWorkspaceRunIDs = Set(projection.runs.filter {
            $0.status == .failed && $0.workspacePreparation != nil
        }.map(\.id))
        // Submission order also includes queued runs. Select live work independently,
        // as threadExecution.ts does, including preparation before startedAt exists.
        activeRun = projection.runs.filter { $0.status.isActive }.max { $0.ordinal < $1.ordinal }
        let foregroundRun = projection.runs.filter { $0.status.isInterruptible }
            .max { $0.ordinal < $1.ordinal }
        // The server accepts a settled run only when it is the newest run and
        // still owns thread-wide background work. Queued runs do not qualify.
        let latestRun = projection.runs.max { $0.ordinal < $1.ordinal }
        let hasBackgroundWork = foregroundRun == nil && projection.hasPendingBackgroundWork(after: latestRun)
        interruptibleRun = foregroundRun ?? (hasBackgroundWork ? latestRun : nil)

        let messages = Dictionary(projection.messages.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        queuedEntries = projection.runs.filter { run in
            guard run.status == .queued else { return false }
            let message = messages[run.userMessageID]
            return message?.delegatedCompletion == nil && message?.notification == nil
        }.sorted {
            let left = $0.queuePosition ?? $0.ordinal
            let right = $1.queuePosition ?? $1.ordinal
            return left == right ? $0.ordinal < $1.ordinal : left < right
        }.map { run in
            let message = messages[run.userMessageID]
            return QueuedEntry(
                run: run,
                text: message?.text ?? "Queued message",
                attachments: message?.attachments ?? [],
                hasMessage: message != nil,
                context: message?.context
            )
        }
        // Automatic deliveries are hidden from the list, but can still hold the queue.
        isQueueHeld = projection.runs.contains { $0.status == .queued && $0.queueHeld == true }
        isReadOnly = projection.thread.creationSource == "provider"
            && projection.thread.lineage?.relationshipToParent == "subagent"
        canManageQueue = projection.thread.archivedAt == nil && projection.thread.deletedAt == nil && !isReadOnly

        let session = projection.session(for: activeRun)
        let capabilities = session?.capabilities.turns
        canReorder = canManageQueue && capabilities?.supportsQueuedMessages == true
        let hasRunningTurn = activeRun?.status == .running
            && projection.hasRunningProviderTurn(for: activeRun)
        canSteer = canManageQueue && hasRunningTurn && session?.isLive == true
            && capabilities?.supportsActiveSteering == true
        canRestart = canManageQueue && hasRunningTurn && session?.isLive == true
            && capabilities?.supportsSteeringByInterruptRestart == true
        canPromoteToSteer = canSteer || canRestart

        if let run = interruptibleRun,
           projection.nodes.contains(where: { $0.id == run.rootNodeID }),
           let providerThread = projection.providerThreads.first(where: { $0.id == run.providerThreadID }) {
            let providerTurn = projection.providerTurns.last {
                run.activeAttemptID != nil && $0.runAttemptId == run.activeAttemptID
                    && ($0.status == "running" || hasBackgroundWork)
            }
            let interruptSession = projection.providerSessions.first { $0.id == providerThread.providerSessionId }
            if let providerTurn {
                if hasBackgroundWork && providerTurn.status != "running" && interruptSession?.isLive != true {
                    // A released session can leave background work in the
                    // projection. The server settles it without a provider call.
                    canInterrupt = canManageQueue
                } else {
                    canInterrupt = canManageQueue && interruptSession?.isLive == true
                        && interruptSession?.capabilities.turns.supportsInterrupt == true
                }
            } else {
                // The orchestrator cancels preparation/startup before a provider turn
                // exists, so this does not require a provider interrupt capability.
                canInterrupt = canManageQueue && !hasBackgroundWork
                    && projection.attempts.contains { $0.id == run.activeAttemptID }
            }
        } else {
            canInterrupt = false
        }
    }

    /// Rechecks actions against the latest detail before the UI submits a command.
    public func allows(_ action: FeatureThreadQueueAction) -> Bool {
        guard canManageQueue else { return false }
        switch action {
        case let .cancel(runID):
            return queuedEntries.contains { $0.id == runID }
        case let .edit(runID, text):
            return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && queuedEntries.contains { $0.id == runID && $0.hasMessage }
        case let .replace(edit):
            return edit.validationMessage == nil && queuedEntries.contains {
                $0.id == edit.runID && $0.messageID == edit.messageID && $0.hasMessage
                    && Set(edit.existingAttachments.map(\.id)).isSubset(of: Set($0.attachments.map(\.id)))
            }
        case let .reorder(runID, beforeRunID):
            return canReorder && queuedEntries.contains { $0.id == runID }
                && runID != beforeRunID
                && (beforeRunID == nil || queuedEntries.contains { $0.id == beforeRunID })
        case let .promoteToSteer(queuedRunID, targetRunID):
            return canPromoteToSteer && activeRun?.id == targetRunID
                && queuedEntries.contains { $0.id == queuedRunID && $0.hasMessage }
        case .resume:
            return isQueueHeld
        case let .interrupt(runID, _):
            return canInterrupt && interruptibleRun?.id == runID
        }
    }

    public func canRetryWorkspacePreparation(runID: String) -> Bool {
        canManageQueue && failedWorkspaceRunIDs?.contains(runID) == true
    }
}

private extension FeatureThreadExecution {
    /// Only the projection fields needed by execution controls, from orchestrationV2.ts.
    struct Projection: Decodable, Sendable {
        let thread: Thread
        let runs: [Run]
        let messages: [Message]
        let providerThreads: [ProviderThread]
        let providerSessions: [ProviderSession]
        let providerTurns: [ProviderTurn]
        let nodes: [RecordID]
        let attempts: [RecordID]
        let backgroundTurnItems: [BackgroundTurnItem]

        /// Matches shared/orchestrationV2PendingBackgroundWork.ts. Subagent
        /// entities duplicate turn items and do not add pending work themselves.
        func hasPendingBackgroundWork(after latestRun: Run?) -> Bool {
            guard let latestRun,
                  [.cancelled, .completed, .failed, .interrupted, .waiting].contains(latestRun.status) else { return false }
            if providerThreads.contains(where: { providerThread in
                (thread.activeProviderThreadId == nil || providerThread.id == thread.activeProviderThreadId)
                    && providerThread.pendingBackgroundTasks?.contains { !$0.taskId.isEmpty } == true
            }) { return true }
            let rolledBackRunIDs = Set(runs.filter { $0.status == .rolledBack }.map(\.id))
            return backgroundTurnItems.contains { item in
                ["command_execution", "dynamic_tool", "subagent"].contains(item.type)
                    && ["pending", "running", "waiting"].contains(item.status)
                    && !(item.type == "dynamic_tool" && item.persistent)
                    && !(item.runId.map { rolledBackRunIDs.contains($0) } ?? false)
            }
        }

        func hasRunningProviderTurn(for run: Run?) -> Bool {
            guard let attemptID = run?.activeAttemptID else { return false }
            return providerTurns.contains { $0.runAttemptId == attemptID && $0.status == "running" }
        }

        func session(for run: Run?) -> ProviderSession? {
            let providerThreadID = run?.providerThreadID ?? thread.activeProviderThreadId
            let attached = providerThreads.first { $0.id == providerThreadID }
                ?? providerThreads.first { $0.appThreadId == thread.id && $0.providerSessionId != nil }
            if let sessionID = attached?.providerSessionId {
                return providerSessions.first { $0.id == sessionID }
            }
            return providerSessions.last { $0.isLive }
        }
    }

    struct Thread: Decodable, Sendable {
        let id: String
        let activeProviderThreadId: String?
        let archivedAt: String?
        let deletedAt: String?
        let creationSource: String?
        let lineage: Lineage?
        let pullRequests: [ThreadPullRequestLink]?
    }

    struct Lineage: Decodable, Sendable {
        let relationshipToParent: String?
    }

    struct Message: Decodable, Sendable {
        let id: String
        let text: String
        let attachments: [Attachment]
        let context: OrchestrationMessageContext?
        let delegatedCompletion: JSONValue?
        let notification: JSONValue?
    }

    struct RecordID: Decodable, Sendable {
        let id: String
    }

    struct ProviderThread: Decodable, Sendable {
        let id: String
        let appThreadId: String?
        let providerSessionId: String?
        let pendingBackgroundTasks: [BackgroundTask]?
    }

    struct BackgroundTask: Decodable, Sendable {
        let taskId: String
    }

    struct BackgroundTurnItem: Decodable, Sendable {
        let type: String
        let status: String
        let runId: String?
        let persistent: Bool
    }

    struct ProviderTurn: Decodable, Sendable {
        let runAttemptId: String?
        let status: String
    }

    struct ProviderSession: Decodable, Sendable {
        let id: String
        let status: String
        let capabilities: Capabilities

        var isLive: Bool { status != "stopped" && status != "error" }
    }

    struct Capabilities: Decodable, Sendable {
        let turns: TurnCapabilities
    }

    struct TurnCapabilities: Decodable, Sendable {
        let supportsQueuedMessages: Bool
        let supportsActiveSteering: Bool
        let supportsSteeringByInterruptRestart: Bool
        let supportsInterrupt: Bool
    }
}
