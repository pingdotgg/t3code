import Foundation

protocol MobileWebSocketSession: Sendable {
    func send(_ data: Data) async throws
    func receive() async throws -> Data
    func ping() async throws
    func close() async
}
