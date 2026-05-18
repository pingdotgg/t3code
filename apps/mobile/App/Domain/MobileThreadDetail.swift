import Foundation

struct MobileThreadDetail: Equatable, Sendable {
    let threadID: MobileThread.ID
    var title: String
    var snapshotSequence: Int
    var messages: [MobileChatMessage]
    var activities: [MobileThreadActivity]
    var proposedPlans: [MobileProposedPlan]
    var checkpoints: [MobileCheckpointSummary]
    var timelineItems: [MobileTimelineItem]
    var sessionStatus: String
    var activeTurnID: String?
}

struct MobileProposedPlan: Identifiable, Equatable, Sendable {
    let id: String
    let turnID: String?
    let markdown: String
    let implementedAt: String?
    let createdAt: String
}

struct MobileCheckpointSummary: Identifiable, Equatable, Sendable {
    let id: String
    let turnID: String
    let turnCount: Int
    let status: String
    let completedAt: String
    let files: [MobileCheckpointFile]
}

struct MobileCheckpointFile: Identifiable, Equatable, Sendable {
    var id: String { path }
    let path: String
    let additions: Int
    let deletions: Int
}

struct MobileChatMessage: Identifiable, Equatable, Sendable {
    let id: String
    let role: String
    var text: String
    let streaming: Bool
    let createdAt: String
}

struct MobileThreadActivity: Identifiable, Equatable, Sendable {
    let id: String
    let tone: String
    let kind: String
    let summary: String
    let createdAt: String
    let requestID: String?
    let interactionKind: MobileActivityInteractionKind
}

enum MobileActivityInteractionKind: String, Equatable, Sendable {
    case approvalRequest
    case userInputRequest
    case generic
}

enum MobileTimelineItem: Identifiable, Equatable, Sendable {
    case message(MobileChatMessage)
    case activity(MobileThreadActivity)
    case plan(MobileProposedPlan)
    case checkpoint(MobileCheckpointSummary)

    var id: String {
        switch self {
        case let .message(message):
            "message:\(message.id)"
        case let .activity(activity):
            "activity:\(activity.id)"
        case let .plan(plan):
            "plan:\(plan.id)"
        case let .checkpoint(checkpoint):
            "checkpoint:\(checkpoint.id)"
        }
    }

    var createdAt: String {
        switch self {
        case let .message(message):
            message.createdAt
        case let .activity(activity):
            activity.createdAt
        case let .plan(plan):
            plan.createdAt
        case let .checkpoint(checkpoint):
            checkpoint.completedAt
        }
    }
}
