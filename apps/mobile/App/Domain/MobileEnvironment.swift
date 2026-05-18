import Foundation

struct MobileEnvironment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let connectionSummary: String
    let isConnected: Bool
}
