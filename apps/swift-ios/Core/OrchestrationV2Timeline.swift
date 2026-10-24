import Foundation

/// Original wire identity is retained even when native display IDs are scoped for inherited rows.
public struct OrchestrationV2TimelineMetadata: Codable, Equatable, Hashable, Sendable {
    public var projectedID: String
    public var sourceThreadID: String
    public var itemID: String
    public var messageID: String?
    public var runID: String?
    public var providerTurnID: String?
    public var attemptID: String? = nil
    public var inputIntent: String?
    public var createdBy: String?
    public var creationSource: String?
    public var senderThreadID: String?
    public var scheduledTaskID: String?
    public var runStatus: String? = nil
    public var runStartedAt: String? = nil
    public var runCompletedAt: String? = nil
    public var visibility: String
    public var position: Int
    public var itemType: String
    public var status: String
    public var updatedAt: String

    public var detailRevision: String {
        ["idle", "pending", "running", "waiting"].contains(status) ? "live" : updatedAt
    }

    init(_ row: OrchestrationV2ProjectedTurnItem) {
        projectedID = row.id
        sourceThreadID = row.sourceThreadId
        itemID = row.sourceItemId
        messageID = row.item.raw["messageId"]?.stringValue
        runID = row.item.runId
        providerTurnID = row.item.providerTurnId
        inputIntent = row.item.raw["inputIntent"]?.stringValue
        createdBy = row.item.raw["createdBy"]?.stringValue
        creationSource = row.item.raw["creationSource"]?.stringValue
        senderThreadID = row.item.raw["senderThreadId"]?.stringValue
        scheduledTaskID = row.item.raw["scheduledTaskId"]?.stringValue
        visibility = row.visibility
        position = row.position
        itemType = row.item.type
        status = row.item.status
        updatedAt = row.item.updatedAt
    }
}

/// Ordered references, independent of content revisions. Only V2 populates this array.
public struct OrchestrationV2TimelineRow: Codable, Equatable, Sendable {
    public var projectedID: String
    public var messageID: String?
    public var activityIDs: [String]
}
