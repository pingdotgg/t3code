import Foundation

/// Shell facts used by the Working beta. Preserve the authored field's presence:
/// an explicit null means no user send, while an absent field needs the old-server fallback.
public struct FeatureThreadInboxFacts: Sendable, Equatable, Hashable, Codable {
    public var runtimeStatus: String?
    public var activeRunID: String?
    public var latestRunID: String?
    public var latestRunStatus: String?
    public var latestRunRequestedAt: Date?
    public var latestRunCompletedAt: Date?
    public var hasActionableProposedPlan: Bool
    public var latestUserAuthoredMessageAt: Date?
    public var latestUserAuthoredMessageAtIsPresent: Bool
    // Optional additions keep snapshots written before lifecycle parity decodable.
    public var orchestrationVersion: Int?
    public var runtimeUpdatedAt: Date?
    public var latestRunStartedAt: Date?
    public var latestRunHasInvalidTimestamp: Bool?
    public var lastErrorClass: String?
    public var usageLimitResetAt: Date?
    public var lastVisitedAt: String?
    public var lastVisitedAtIsPresent: Bool?

    public init(
        runtimeStatus: String? = nil,
        activeRunID: String? = nil,
        latestRunID: String? = nil,
        latestRunStatus: String? = nil,
        latestRunRequestedAt: Date? = nil,
        latestRunCompletedAt: Date? = nil,
        hasActionableProposedPlan: Bool = false,
        latestUserAuthoredMessageAt: Date? = nil,
        latestUserAuthoredMessageAtIsPresent: Bool = false,
        orchestrationVersion: Int? = nil,
        runtimeUpdatedAt: Date? = nil,
        latestRunStartedAt: Date? = nil,
        latestRunHasInvalidTimestamp: Bool? = nil,
        lastErrorClass: String? = nil,
        usageLimitResetAt: Date? = nil,
        lastVisitedAt: String? = nil,
        lastVisitedAtIsPresent: Bool? = nil
    ) {
        self.runtimeStatus = runtimeStatus
        self.activeRunID = activeRunID
        self.latestRunID = latestRunID
        self.latestRunStatus = latestRunStatus
        self.latestRunRequestedAt = latestRunRequestedAt
        self.latestRunCompletedAt = latestRunCompletedAt
        self.hasActionableProposedPlan = hasActionableProposedPlan
        self.latestUserAuthoredMessageAt = latestUserAuthoredMessageAt
        self.latestUserAuthoredMessageAtIsPresent = latestUserAuthoredMessageAtIsPresent
        self.orchestrationVersion = orchestrationVersion
        self.runtimeUpdatedAt = runtimeUpdatedAt
        self.latestRunStartedAt = latestRunStartedAt
        self.latestRunHasInvalidTimestamp = latestRunHasInvalidTimestamp
        self.lastErrorClass = lastErrorClass
        self.usageLimitResetAt = usageLimitResetAt
        self.lastVisitedAt = lastVisitedAt
        self.lastVisitedAtIsPresent = lastVisitedAtIsPresent
    }
}

/// Mirrors client-runtime/threadInbox.ts for both legacy and V2 environments.
enum FeatureInboxPolicy {
    private static let activeStatuses: Set<String> = [
        "preparing", "queued", "starting", "running", "waiting",
    ]

    static func isWorking(_ thread: FeatureThread) -> Bool {
        if thread.settlementFacts?.hasPendingApprovals == true
            || thread.settlementFacts?.hasPendingUserInput == true { return false }
        switch thread.state {
        case .waitingForApproval, .waitingForInput, .failed: return false
        default: break
        }
        guard let facts = thread.inboxFacts else {
            // Older persisted feature snapshots only have the presentation state.
            return [.queued, .working, .monitoring].contains(thread.state)
        }
        guard let status = facts.runtimeStatus,
              activeStatuses.contains(status) || status == "idle" else { return false }
        let runSettled = facts.latestRunID != nil
            && !activeStatuses.contains(facts.latestRunStatus ?? "")
            && facts.activeRunID != facts.latestRunID
        return !(thread.interactionMode == .plan && facts.hasActionableProposedPlan && runSettled)
    }

    static func sortWorking(_ threads: [FeatureThread]) -> [FeatureThread] {
        newestFirst(threads) { thread in
            let facts = thread.inboxFacts
            let sentAt = facts?.latestUserAuthoredMessageAtIsPresent == true
                ? facts?.latestUserAuthoredMessageAt
                : requestedAt(thread)
            return max(thread.createdAt, sentAt ?? .init(timeIntervalSince1970: 0))
        }
    }

    static func sortInbox(
        _ threads: [FeatureThread],
        returns: FeatureInboxReturnTracker = .init()
    ) -> [FeatureThread] {
        newestFirst(threads) { thread in
            [thread.createdAt, thread.unsettledAt, requestedAt(thread),
             completedAt(thread), returns.returnedAt(for: thread)]
                .compactMap { $0 }.max() ?? .init(timeIntervalSince1970: 0)
        }
    }

    private static func requestedAt(_ thread: FeatureThread) -> Date? {
        if let facts = thread.inboxFacts { return facts.latestRunRequestedAt }
        return thread.settlementFacts?.latestTurn?.requestedAt
    }

    private static func completedAt(_ thread: FeatureThread) -> Date? {
        if let facts = thread.inboxFacts { return facts.latestRunCompletedAt }
        return thread.settlementFacts?.latestTurn?.completedAt ?? thread.latestTurnCompletedAt
    }

    private static func newestFirst(
        _ threads: [FeatureThread],
        timestamp: (FeatureThread) -> Date
    ) -> [FeatureThread] {
        threads.map { (thread: $0, date: timestamp($0)) }.sorted { left, right in
            if left.date != right.date { return left.date > right.date }
            let leftID = left.thread.wireID ?? left.thread.id
            let rightID = right.thread.wireID ?? right.thread.id
            if leftID != rightID { return leftID < rightID }
            return (left.thread.environmentID ?? "") < (right.thread.environmentID ?? "")
        }.map { $0.thread }
    }
}

/// Owned by FeatureRootModel, not a view. Observe every shell update before
/// publishing it; pass nil while disabled. The first observation is only a baseline.
struct FeatureInboxReturnTracker {
    private struct Key: Hashable {
        let environmentID: String?
        let threadID: String

        init(_ thread: FeatureThread) {
            environmentID = thread.environmentID
            threadID = thread.wireID ?? thread.id
        }
    }

    private var lastWorking: Set<Key>?
    private var returns: [Key: Date] = [:]
    private(set) var revision: UInt64 = 0

    @discardableResult
    mutating func observe(_ threads: [FeatureThread]?, at now: Date = .now) -> Bool {
        guard let threads else {
            lastWorking = nil
            guard !returns.isEmpty else { return false }
            returns.removeAll()
            revision &+= 1
            return true
        }
        let present = Set(threads.map(Key.init))
        let working = Set(threads.filter(FeatureInboxPolicy.isWorking).map(Key.init))
        var changed = false
        for key in Array(returns.keys) where !present.contains(key) {
            returns.removeValue(forKey: key)
            changed = true
        }
        for key in lastWorking ?? [] where present.contains(key) && !working.contains(key) {
            returns[key] = now
            changed = true
        }
        lastWorking = working
        if changed { revision &+= 1 }
        return changed
    }

    func returnedAt(for thread: FeatureThread) -> Date? {
        returns[Key(thread)]
    }
}
