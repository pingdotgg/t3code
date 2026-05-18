import Foundation

enum MobileConnectionState: Equatable, Sendable {
    case idle
    case notConfigured
    case connecting
    case connected
    case failed(String)

    var summary: String {
        switch self {
        case .idle:
            "Ready"
        case .notConfigured:
            "Pair this iPhone with your T3 Code server to sync."
        case .connecting:
            "Connecting"
        case .connected:
            "Connected"
        case let .failed(message):
            message
        }
    }
}
