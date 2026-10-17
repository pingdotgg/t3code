import Foundation

public enum FeatureUsageLimitRecoveryChoice: String, Sendable, Equatable {
    case autoResume, snooze
}

public enum FeatureThreadRecoveryAction: Sendable, Equatable {
    case retryWorkspacePreparation(runID: String)
    case setUsageLimit(runID: String, resetAt: String, choice: FeatureUsageLimitRecoveryChoice, enabled: Bool)
}

@MainActor
public protocol FeatureThreadRecoveryClient {
    func updateThreadRecovery(threadID: String, action: FeatureThreadRecoveryAction) async throws
    /// Copies retained server attachments so a recovered edit is a normal, durable draft.
    func queuedRunEditRecoveryDraft(threadID: String, edit: FeatureQueuedRunEdit) async throws -> FeatureComposerDraft
}

struct FeatureThreadRecoveryError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

public struct FeatureUsageLimitRecovery: Sendable, Equatable, Codable {
    public let runID: String
    public let resetAt: String?
    public let failedAt: String
    public let autoResume: Bool
    public let snooze: Bool

    public var resetDate: Date? { Self.date(resetAt) }
    public var canSchedule: Bool {
        guard let resetDate, let failureDate = Self.date(failedAt) else { return false }
        return resetDate > failureDate
    }

    public func action(_ choice: FeatureUsageLimitRecoveryChoice, enabled: Bool) -> FeatureThreadRecoveryAction? {
        guard let resetAt else { return nil }
        return .setUsageLimit(runID: runID, resetAt: resetAt, choice: choice, enabled: enabled)
    }

    public func canChange(_ choice: FeatureUsageLimitRecoveryChoice, enabled: Bool, now: Date = Date()) -> Bool {
        guard canSchedule, let resetDate else { return false }
        // Both choices can be reversed after the reset time while the failure is still current.
        return !enabled || resetDate > now
    }

    /// A partial update leaves the other recovery choice unchanged on the server.
    public func metadataUpdate(
        choice: FeatureUsageLimitRecoveryChoice, enabled: Bool, now: Date = Date()
    ) throws -> JSONValue {
        guard let resetAt, canChange(choice, enabled: enabled, now: now) else {
            throw FeatureThreadRecoveryError("The reset time is unavailable or has passed. Retry the thread manually.")
        }
        return .object([
            "runId": .string(runID), "resetAt": .string(resetAt), choice.rawValue: .bool(enabled),
        ])
    }

    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value))
    }
}

/// Uses local control records and raw error items. It does not change timeline mapping.
public struct FeatureThreadRecovery: Sendable, Equatable, Codable {
    public let usageLimit: FeatureUsageLimitRecovery?

    public init?(thread: OrchestrationThread) {
        guard let control = thread.orchestrationV2Control else { return nil }
        self.init(projection: control, errorItems: control["recoveryTurnItems"]?.v2Array ?? thread.activities.compactMap { activity in
            guard activity.v2Timeline?.sourceThreadID == thread.id else { return nil }
            return activity.v2Item
        })
    }

    public init(projection: JSONValue, errorItems: [JSONValue]? = nil) {
        usageLimit = Self.usageLimit(projection: projection,
            errorItems: errorItems ?? projection["recoveryTurnItems"]?.v2Array ?? projection["turnItems"]?.v2Array ?? [])
    }

    /// The caller passes the current thread's wire ID, never an inherited row's source ID.
    public static func canRetryWorkspacePreparation(
        item: JSONValue, threadID: String, execution: FeatureThreadExecution
    ) -> Bool {
        guard item["threadId"]?.stringValue == threadID,
              item["type"]?.stringValue == "error", item["status"]?.stringValue == "failed",
              item["failure"]?["code"]?.stringValue == "workspace_preparation_failed",
              let runID = item["runId"]?.stringValue else { return false }
        return execution.canRetryWorkspacePreparation(runID: runID)
    }

    private static func usageLimit(projection: JSONValue, errorItems: [JSONValue]) -> FeatureUsageLimitRecovery? {
        let thread = projection["thread"]
        let runs = projection["runs"]?.v2Array ?? []
        // Queued and never-started cancelled follow-ups do not conceal the failed run.
        let executed = runs.filter {
            $0["status"]?.stringValue != "queued"
                && !($0["status"]?.stringValue == "cancelled" && $0["startedAt"]?.stringValue == nil)
        }.max { left, right in
            let leftEnd = FeatureUsageLimitRecovery.date(left["completedAt"]?.stringValue) ?? .distantFuture
            let rightEnd = FeatureUsageLimitRecovery.date(right["completedAt"]?.stringValue) ?? .distantFuture
            return leftEnd == rightEnd ? ordinal(left) < ordinal(right) : leftEnd < rightEnd
        }
        guard let run = executed, run["status"]?.stringValue == "failed",
              let runID = run["id"]?.stringValue else { return nil }
        let error = errorItems.filter {
            $0["type"]?.stringValue == "error" && $0["status"]?.stringValue == "failed"
                && $0["runId"]?.stringValue == runID && $0["nodeId"] == run["rootNodeId"]
        }.max { left, right in
            let leftDate = FeatureUsageLimitRecovery.date(left["updatedAt"]?.stringValue) ?? .distantPast
            let rightDate = FeatureUsageLimitRecovery.date(right["updatedAt"]?.stringValue) ?? .distantPast
            if leftDate != rightDate { return leftDate < rightDate }
            if ordinal(left) != ordinal(right) { return ordinal(left) < ordinal(right) }
            return (left["id"]?.stringValue ?? "") < (right["id"]?.stringValue ?? "")
        }
        guard let failure = error?["failure"], failure["class"]?.stringValue == "usage_limit" else { return nil }
        let providerSession = projection["providerSessions"]?.v2Array?.filter {
            $0["providerInstanceId"] == thread?["providerInstanceId"]
        }.max {
            (FeatureUsageLimitRecovery.date($0["updatedAt"]?.stringValue) ?? .distantPast)
                < (FeatureUsageLimitRecovery.date($1["updatedAt"]?.stringValue) ?? .distantPast)
        }
        if let sessionError = providerSession?["lastError"]?.stringValue,
           sessionError != failure["message"]?.stringValue { return nil }
        let resetAt = failure["resetAt"]?.stringValue
        let recovery = thread?["limitRecovery"]
        let sameFailure = recovery?["runId"]?.stringValue == runID
            && recovery?["resetAt"]?.stringValue == resetAt
        let snoozedUntil = FeatureUsageLimitRecovery.date(thread?["snoozedUntil"]?.stringValue)
        let resetDate = FeatureUsageLimitRecovery.date(resetAt)
        return FeatureUsageLimitRecovery(
            runID: runID, resetAt: resetAt,
            failedAt: run["completedAt"]?.stringValue ?? thread?["updatedAt"]?.stringValue ?? "",
            autoResume: sameFailure && recovery?["autoResume"]?.boolValue == true,
            snooze: sameFailure && recovery?["snooze"]?.boolValue == true
                && resetDate != nil && snoozedUntil == resetDate
        )
    }

    private static func ordinal(_ value: JSONValue) -> Double {
        guard case let .number(number)? = value["ordinal"] else { return 0 }
        return number
    }
}
