import Foundation

struct MobileProject: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let workspaceRoot: String
}
