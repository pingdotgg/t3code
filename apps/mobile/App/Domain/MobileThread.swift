import Foundation

struct MobileThread: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let projectID: MobileProject.ID
    let title: String
    let status: String
    let latestSummary: String
}
