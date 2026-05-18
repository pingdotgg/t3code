import Foundation

actor URLSessionMobileWebSocketSession: MobileWebSocketSession {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func send(_ data: Data) async throws {
        try await task.send(.data(data))
    }

    func receive() async throws -> Data {
        switch try await task.receive() {
        case let .data(data):
            data
        case let .string(text):
            Data(text.utf8)
        @unknown default:
            throw MobileSyncError.unexpectedMessage("Received unsupported WebSocket message type.")
        }
    }

    func ping() async throws {
        try await task.sendPing()
    }

    func close() async {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

private extension URLSessionWebSocketTask {
    func sendPing() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sendPing { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }
}
