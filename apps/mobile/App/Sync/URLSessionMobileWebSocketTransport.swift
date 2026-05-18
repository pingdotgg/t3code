import Foundation

struct URLSessionMobileWebSocketTransport: MobileWebSocketTransport {
    private let urlSession: URLSession

    init(urlSession: URLSession = .shared) {
        self.urlSession = urlSession
    }

    func connect(to url: URL) async throws -> any MobileWebSocketSession {
        let task = urlSession.webSocketTask(with: url)
        task.resume()
        return URLSessionMobileWebSocketSession(task: task)
    }
}
