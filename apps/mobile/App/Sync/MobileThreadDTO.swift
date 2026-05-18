import Foundation

struct MobileThreadDTO: Decodable, Equatable {
    struct LatestTurn: Decodable, Equatable {
        let state: String
    }

    struct Session: Decodable, Equatable {
        let status: String
        let activeTurnId: String?
        let lastError: String?
    }

    let id: String
    let projectId: String
    let title: String
    let latestTurn: LatestTurn?
    let session: Session?
    let hasPendingApprovals: Bool
    let hasPendingUserInput: Bool
    let hasActionableProposedPlan: Bool
}
