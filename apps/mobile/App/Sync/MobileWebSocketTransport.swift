import Foundation

protocol MobileWebSocketTransport: Sendable {
    func connect(to url: URL) async throws -> any MobileWebSocketSession
}
