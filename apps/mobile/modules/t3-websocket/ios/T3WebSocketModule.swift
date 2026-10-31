import ExpoModulesCore
import Foundation

// URLSessionWebSocketTask offers permessage-deflate in its handshake, which
// React Native's SocketRocket socket never does. Exposes only what Effect's
// Socket.fromWebSocket drives, with events routed by a JS-assigned id.
public final class T3WebSocketModule: Module {
  private let connections = T3WebSocketConnections()

  public func definition() -> ModuleDefinition {
    Name("T3WebSocket")

    Events("onOpen", "onMessage", "onClose", "onError")

    Function("connect") { (id: Int, url: String, protocols: [String]) throws in
      guard let parsedUrl = URL(string: url) else {
        throw Exception(name: "InvalidUrl", description: "Invalid WebSocket URL: \(url)")
      }
      self.connections.open(id: id, url: parsedUrl, protocols: protocols) { [weak self] event, payload in
        self?.sendEvent(event, payload)
      }
    }

    Function("sendText") { (id: Int, text: String) in
      self.connections.send(id: id, message: .string(text))
    }

    Function("sendBinary") { (id: Int, base64: String) in
      guard let data = Data(base64Encoded: base64) else { return }
      self.connections.send(id: id, message: .data(data))
    }

    Function("close") { (id: Int, code: Int, reason: String) in
      self.connections.close(id: id, code: code, reason: reason)
    }

    OnDestroy {
      self.connections.cancelAll()
    }
  }
}

private typealias T3WebSocketEmitter = (_ event: String, _ payload: [String: Any]) -> Void

private final class T3WebSocketConnections: NSObject, URLSessionWebSocketDelegate {
  // URLSession's default receive cap is 1 MB, and thread snapshots can be larger.
  private static let maximumMessageSize = 128 * 1024 * 1024

  private let queue = DispatchQueue(label: "com.t3tools.t3code.websocket")
  private var tasksById: [Int: URLSessionWebSocketTask] = [:]
  private var idsByTaskIdentifier: [Int: Int] = [:]
  private var emittersById: [Int: T3WebSocketEmitter] = [:]
  // URLSession retains its delegate until invalidated, so teardown must
  // invalidate it. Only touched from `queue`.
  private var activeSession: URLSession?

  private var session: URLSession {
    if let activeSession { return activeSession }
    let configuration = URLSessionConfiguration.default
    // Dev clients and network debuggers register URLProtocol classes that do
    // not understand the upgrade and drop the socket right after the 101.
    configuration.protocolClasses = []
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    activeSession = session
    return session
  }

  func open(id: Int, url: URL, protocols: [String], emitter: @escaping T3WebSocketEmitter) {
    queue.async {
      let task = protocols.isEmpty
        ? self.session.webSocketTask(with: url)
        : self.session.webSocketTask(with: url, protocols: protocols)
      task.maximumMessageSize = Self.maximumMessageSize
      self.tasksById[id] = task
      self.idsByTaskIdentifier[task.taskIdentifier] = id
      self.emittersById[id] = emitter
      task.resume()
      self.receiveLoop(id: id, task: task)
    }
  }

  func send(id: Int, message: URLSessionWebSocketTask.Message) {
    queue.async {
      guard let task = self.tasksById[id] else { return }
      task.send(message) { [weak self] error in
        guard let self, let error else { return }
        self.queue.async {
          self.emitLocked(id: id, event: "onError", payload: ["message": error.localizedDescription])
        }
      }
    }
  }

  func close(id: Int, code: Int, reason: String) {
    queue.async {
      guard let task = self.tasksById[id] else { return }
      let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
      task.cancel(with: closeCode, reason: reason.data(using: .utf8))
    }
  }

  func cancelAll() {
    queue.async {
      for task in self.tasksById.values {
        task.cancel(with: .goingAway, reason: nil)
      }
      self.tasksById.removeAll()
      self.idsByTaskIdentifier.removeAll()
      self.emittersById.removeAll()
      self.activeSession?.invalidateAndCancel()
      self.activeSession = nil
    }
  }

  private func receiveLoop(id: Int, task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      self.queue.async {
        // Failures are reported by the delegate callbacks; the loop just stops.
        guard case .success(let message) = result else { return }
        switch message {
        case .string(let text):
          self.emitLocked(id: id, event: "onMessage", payload: ["data": text, "binary": false])
        case .data(let data):
          self.emitLocked(id: id, event: "onMessage", payload: ["data": data.base64EncodedString(), "binary": true])
        @unknown default:
          break
        }
        guard self.tasksById[id] != nil else { return }
        self.receiveLoop(id: id, task: task)
      }
    }
  }

  // Must be called on `queue`.
  private func emitLocked(id: Int, event: String, payload: [String: Any]) {
    guard let emitter = emittersById[id] else { return }
    var enriched = payload
    enriched["id"] = id
    emitter(event, enriched)
  }

  private func remove(id: Int, taskIdentifier: Int) {
    tasksById.removeValue(forKey: id)
    idsByTaskIdentifier.removeValue(forKey: taskIdentifier)
    emittersById.removeValue(forKey: id)
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    queue.async {
      guard let id = self.idsByTaskIdentifier[webSocketTask.taskIdentifier] else { return }
      self.emitLocked(id: id, event: "onOpen", payload: ["protocol": `protocol` ?? ""])
    }
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    queue.async {
      guard let id = self.idsByTaskIdentifier[webSocketTask.taskIdentifier] else { return }
      let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      self.emitLocked(id: id, event: "onClose", payload: ["code": closeCode.rawValue, "reason": reasonText])
      self.remove(id: id, taskIdentifier: webSocketTask.taskIdentifier)
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    queue.async {
      guard let id = self.idsByTaskIdentifier[task.taskIdentifier] else { return }
      if let error {
        // No close frame arrived. A browser reports 1006 here, which the
        // connection supervisor treats as a transport error and reconnects.
        self.emitLocked(id: id, event: "onError", payload: ["message": error.localizedDescription])
        self.emitLocked(id: id, event: "onClose", payload: ["code": 1006, "reason": error.localizedDescription])
      } else {
        // A task can finish cleanly without a didCloseWith callback, and the JS
        // socket must still leave CLOSING.
        self.emitLocked(id: id, event: "onClose", payload: ["code": 1005, "reason": ""])
      }
      self.remove(id: id, taskIdentifier: task.taskIdentifier)
    }
  }
}
