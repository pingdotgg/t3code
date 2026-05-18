import Foundation

struct MobileThreadDetailSnapshotDTO: Equatable {
    let snapshotSequence: Int
    let thread: MobileThreadDetailDTO
}

struct MobileThreadDetailDTO: Equatable {
    let id: String
    let title: String
    let messages: [MobileChatMessageDTO]
    let activities: [MobileThreadActivityDTO]
    let proposedPlans: [MobileProposedPlanDTO]
    let checkpoints: [MobileCheckpointSummaryDTO]
    let session: MobileThreadDTO.Session?
}

struct MobileChatMessageDTO: Equatable {
    let id: String
    let role: String
    let text: String
    let streaming: Bool
    let createdAt: String
}

struct MobileThreadActivityDTO: Equatable {
    let id: String
    let tone: String
    let kind: String
    let summary: String
    let createdAt: String
    let requestID: String?
    let interactionKind: MobileActivityInteractionKind
}

struct MobileProposedPlanDTO: Equatable {
    let id: String
    let turnID: String?
    let markdown: String
    let implementedAt: String?
    let createdAt: String
}

struct MobileCheckpointSummaryDTO: Equatable {
    let turnID: String
    let turnCount: Int
    let status: String
    let completedAt: String
    let files: [MobileCheckpointFileDTO]
}

struct MobileCheckpointFileDTO: Equatable {
    let path: String
    let additions: Int
    let deletions: Int
}
