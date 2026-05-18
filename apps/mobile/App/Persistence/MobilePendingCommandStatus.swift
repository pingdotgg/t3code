import Foundation

enum MobilePendingCommandStatus: String, Codable, Sendable {
    case created
    case sent
    case accepted
    case rejected
    case reconciled
    case expired
}
