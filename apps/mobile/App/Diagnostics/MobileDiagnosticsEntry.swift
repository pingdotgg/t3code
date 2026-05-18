import Foundation

struct MobileDiagnosticsEntry: Identifiable, Equatable, Sendable {
    let id: UUID
    let createdAt: String
    let level: MobileDiagnosticsLevel
    let message: String

    init(
        id: UUID = UUID(),
        createdAt: String = Date().ISO8601Format(),
        level: MobileDiagnosticsLevel,
        message: String
    ) {
        self.id = id
        self.createdAt = createdAt
        self.level = level
        self.message = message
    }
}

enum MobileDiagnosticsLevel: String, Equatable, Sendable {
    case info
    case warning
    case error
}
