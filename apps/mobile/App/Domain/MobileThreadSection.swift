import Foundation

struct MobileThreadSection: Codable, Identifiable, Hashable, Sendable {
    let id: MobileProject.ID
    let title: String
    let threads: [MobileThread]
}
