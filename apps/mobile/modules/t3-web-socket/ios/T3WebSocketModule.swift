import ExpoModulesCore
import Foundation

private final class Connection {
  let id: Int
  var task: URLSessionWebSocketTask?
  var finished = false
  var requestedCloseCode: Int?
  var failure: String?

  init(id: Int) {
    self.id = id
  }
}

/// A WebSocket client that offers permessage-deflate. React Native's SocketRocket never does,
/// so a large snapshot reached an iPhone uncompressed. URLSession offers the extension on every
/// handshake with no public switch, which is what we want here.
public final class T3WebSocketModule: Module {
  private var connections: [Int: Connection] = [:]
  private var nextId = 1
  private let lock = NSLock()
  private var session: URLSession?
  private let delegateQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return queue
  }()

  public func definition() -> ModuleDefinition {
    Name("T3WebSocket")
    Events("open", "message", "close", "error")

    Function("connect") { (url: URL, protocols: [String]) -> Int in
      let connection = self.withLock { () -> Connection in
        let connection = Connection(id: self.nextId)
        self.nextId += 1
        self.connections[connection.id] = connection
        return connection
      }
      let session = self.session ?? self.makeSession()
      self.session = session
      let task = protocols.isEmpty
        ? session.webSocketTask(with: url)
        : session.webSocketTask(with: url, protocols: protocols)
      // The app splits frames at 48 KiB, but older servers and the outdated-host probe send whole
      // messages, so stay well above URLSession's 1 MiB default.
      task.maximumMessageSize = 128 * 1024 * 1024
      self.withLock { connection.task = task }
      task.resume()
      self.receive(on: connection, task: task)
      return connection.id
    }

    Function("sendText") { (id: Int, text: String) in
      guard let connection = self.connection(id), let task = connection.task else { return }
      task.send(.string(text)) { [weak self] error in
        if let error { self?.fail(connection, task: task, error: error) }
      }
    }

    Function("sendBinary") { (id: Int, bytes: Uint8Array) in
      guard let connection = self.connection(id), let task = connection.task else { return }
      let data = Data(bytes: bytes.rawPointer, count: bytes.byteLength)
      task.send(.data(data)) { [weak self] error in
        if let error { self?.fail(connection, task: task, error: error) }
      }
    }

    Function("close") { (id: Int, code: Int, reason: String) in
      guard let connection = self.connection(id) else { return }
      // URLSession can only send the codes it names; anything else goes out as a normal closure.
      let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code).flatMap { $0 == .invalid ? nil : $0 } ?? .normalClosure
      let task = self.withLock { () -> URLSessionWebSocketTask? in
        connection.requestedCloseCode = closeCode.rawValue
        return connection.task
      }
      task?.cancel(with: closeCode, reason: reason.isEmpty ? nil : reason.data(using: .utf8))
    }

    OnDestroy {
      self.session?.invalidateAndCancel()
    }
  }

  private func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.default
    // Dev clients register URLProtocol classes that intercept the upgrade and drop the socket.
    configuration.protocolClasses = []
    return URLSession(configuration: configuration, delegate: SessionDelegate(module: self), delegateQueue: delegateQueue)
  }

  private func connection(_ id: Int) -> Connection? {
    withLock { connections[id] }
  }

  private func connection(for task: URLSessionTask) -> Connection? {
    withLock { connections.values.first { $0.task === task } }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private func receive(on connection: Connection, task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(.string(let text)):
        self.sendEvent("message", ["id": connection.id, "text": text])
        self.receive(on: connection, task: task)
      case .success(.data(let data)):
        self.sendEvent("message", ["id": connection.id, "data": data])
        self.receive(on: connection, task: task)
      case .success:
        self.receive(on: connection, task: task)
      case .failure(let error):
        self.fail(connection, task: task, error: error)
      }
    }
  }

  /// Every ending is reported once, from the delegate. A receive or send failure on a task that is
  /// still running (an oversized message, for one) gets no delegate callback until it is cancelled.
  private func fail(_ connection: Connection, task: URLSessionWebSocketTask, error: Error) {
    let live = withLock { () -> Bool in
      guard !connection.finished else { return false }
      if connection.failure == nil { connection.failure = error.localizedDescription }
      return true
    }
    guard live, task.state == .running else { return }
    task.cancel()
  }

  fileprivate func didOpen(task: URLSessionWebSocketTask) {
    guard let connection = connection(for: task) else { return }
    sendEvent("open", ["id": connection.id])
  }

  fileprivate func didClose(task: URLSessionWebSocketTask, code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    guard let connection = connection(for: task) else { return }
    finish(connection, code: code.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "", clean: true)
  }

  fileprivate func didComplete(task: URLSessionTask, error: Error?) {
    guard let connection = connection(for: task) else { return }
    let (requested, failure) = withLock { (connection.requestedCloseCode, connection.failure) }
    if requested == nil, let message = failure ?? error?.localizedDescription {
      sendEvent("error", ["id": connection.id, "message": message])
    }
    // A task that ends without a close frame is an abnormal closure, as in browsers; one we
    // cancelled ourselves reports the code we asked for.
    finish(connection, code: requested ?? (error == nil && failure == nil ? 1005 : 1006), reason: "", clean: requested != nil)
  }

  private func finish(_ connection: Connection, code: Int, reason: String, clean: Bool) {
    let first = withLock { () -> Bool in
      if connection.finished { return false }
      connection.finished = true
      connections.removeValue(forKey: connection.id)
      return true
    }
    guard first else { return }
    sendEvent("close", ["id": connection.id, "code": code, "reason": reason, "wasClean": clean])
  }
}

private final class SessionDelegate: NSObject, URLSessionWebSocketDelegate {
  weak var module: T3WebSocketModule?

  init(module: T3WebSocketModule) {
    self.module = module
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    module?.didOpen(task: webSocketTask)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    module?.didClose(task: webSocketTask, code: closeCode, reason: reason)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    module?.didComplete(task: task, error: error)
  }
}
