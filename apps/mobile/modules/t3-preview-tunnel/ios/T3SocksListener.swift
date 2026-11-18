import Foundation
import Network

/// A SOCKS5 listener on 127.0.0.1 that carries each loopback CONNECT over one WebSocket to the
/// environment's /api/preview/tunnel. It never connects anywhere on this device, so a tunnel
/// that fails is a connection error, never one of this device's own servers.
final class T3SocksListener {
  typealias AccessRequest = (@escaping (String?) -> Void) -> Void

  private let queue = DispatchQueue(label: "com.t3tools.preview-tunnel")
  private let requestAccess: AccessRequest
  private var listener: NWListener?
  private var connections: [ObjectIdentifier: T3SocksConnection] = [:]

  init(requestAccess: @escaping AccessRequest) {
    self.requestAccess = requestAccess
  }

  var isListening: Bool { listener?.state == .ready }

  /// `port` asks for a specific port, so a restarted listener keeps the address WebKit was given.
  /// `onFailed` runs when iOS tears the socket down, as it can while the app is in the background.
  func start(
    port: UInt16? = nil,
    onReady: @escaping (UInt16) -> Void,
    onFailed: @escaping () -> Void = {}
  ) {
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    parameters.requiredLocalEndpoint = .hostPort(
      host: "127.0.0.1", port: port.flatMap(NWEndpoint.Port.init(rawValue:)) ?? .any
    )
    guard let listener = try? NWListener(using: parameters) else { return }
    self.listener = listener
    listener.stateUpdateHandler = { [weak listener] state in
      switch state {
      case .ready: if let port = listener?.port?.rawValue { onReady(port) }
      case .failed: onFailed()
      default: break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      T3TunnelDiagnostics.shared.note { $0.accepted += 1 }
      guard let self else { return connection.cancel() }
      let socks = T3SocksConnection(
        connection: connection, queue: queue, requestAccess: requestAccess
      ) { [weak self] socks in
        self?.connections.removeValue(forKey: ObjectIdentifier(socks))
      }
      connections[ObjectIdentifier(socks)] = socks
      socks.start()
    }
    listener.start(queue: queue)
  }

  func stop() {
    queue.async { [self] in
      listener?.cancel()
      for socks in connections.values { socks.close() }
      connections.removeAll()
    }
  }
}

private let replySucceeded: UInt8 = 0
private let replyFailure: UInt8 = 1
private let replyNotAllowed: UInt8 = 2
private let replyCommandNotSupported: UInt8 = 7
private let replyAddressNotSupported: UInt8 = 8

private func socksReply(_ code: UInt8) -> Data { Data([5, code, 0, 1, 0, 0, 0, 0, 0, 0]) }

// The webview names the host as typed, so IP literals can also arrive as domain names.
private func isLoopbackName(_ name: String) -> Bool {
  let name = name.lowercased()
  if name == "localhost" || name.hasSuffix(".localhost") { return true }
  if name == T3Loopback.standInHost { return true }
  if let address = IPv4Address(name) { return address.rawValue.first == 127 }
  if let address = IPv6Address(name) { return address.isLoopback }
  return false
}

private enum SocksRequest {
  case connect(port: UInt16, consumed: Int)
  case refuse(UInt8)
}

/// Nil until the whole request has arrived.
private func parseConnect(_ data: [UInt8]) -> SocksRequest? {
  guard data.count >= 5 else { return nil }
  let hostLength: Int
  switch data[3] {
  case 1: hostLength = 4
  case 4: hostLength = 16
  case 3: hostLength = 1 + Int(data[4])
  default: return .refuse(replyAddressNotSupported)
  }
  let end = 4 + hostLength + 2
  guard data.count >= end else { return nil }
  guard data[0] == 5, data[1] == 1 else { return .refuse(replyCommandNotSupported) }
  let host = Array(data[4..<(4 + hostLength)])
  let loopback: Bool
  switch data[3] {
  case 1: loopback = host[0] == 127
  case 4: loopback = IPv6Address(Data(host))?.isLoopback ?? false
  default: loopback = isLoopbackName(String(decoding: host.dropFirst(), as: UTF8.self))
  }
  guard loopback else { return .refuse(replyNotAllowed) }
  let port = UInt16(data[end - 2]) << 8 | UInt16(data[end - 1])
  return .connect(port: port, consumed: end)
}

private final class T3SocksConnection {
  private let connection: NWConnection
  private let queue: DispatchQueue
  private let requestAccess: T3SocksListener.AccessRequest
  private let onClose: (T3SocksConnection) -> Void
  private var received: [UInt8] = []
  private var greeted = false
  private var tunnel: URLSessionWebSocketTask?
  private var closed = false
  // Plain HTTP only: the page names the stand-in host, the environment's servers expect localhost.
  private var toServer = T3HostSwap(from: T3Loopback.standInHost, to: "localhost")
  private var toPage = T3HostSwap(from: "localhost", to: T3Loopback.standInHost)

  init(
    connection: NWConnection,
    queue: DispatchQueue,
    requestAccess: @escaping T3SocksListener.AccessRequest,
    onClose: @escaping (T3SocksConnection) -> Void
  ) {
    self.connection = connection
    self.queue = queue
    self.requestAccess = requestAccess
    self.onClose = onClose
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.close()
      default: break
      }
    }
    connection.start(queue: queue)
    readHandshake()
  }

  func close() {
    guard !closed else { return }
    closed = true
    tunnel?.cancel(with: .normalClosure, reason: nil)
    connection.cancel()
    onClose(self)
  }

  /// Sends the final bytes, then closes once they are written.
  private func finish(_ data: Data?) {
    connection.send(
      content: data, contentContext: .finalMessage, isComplete: true,
      completion: .contentProcessed { [weak self] _ in self?.queue.async { self?.close() } }
    )
  }

  private func readHandshake() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) {
      [weak self] data, _, isComplete, error in
      guard let self, !closed else { return }
      if let data { received.append(contentsOf: data) }
      if !greeted {
        guard received.count >= 2, received.count >= 2 + Int(received[1]) else {
          return isComplete || error != nil ? close() : readHandshake()
        }
        let methods = received[2..<(2 + Int(received[1]))]
        guard received[0] == 5, methods.contains(0) else { return finish(Data([5, 0xff])) }
        connection.send(content: Data([5, 0]), completion: .idempotent)
        received.removeFirst(2 + Int(received[1]))
        greeted = true
      }
      switch parseConnect(received) {
      case nil:
        if isComplete || error != nil { close() } else { readHandshake() }
      case .refuse(let code):
        T3TunnelDiagnostics.shared.note { $0.refused = "\(code)" }
        finish(socksReply(code))
      case .connect(let port, let consumed):
        received.removeFirst(consumed)
        T3TunnelDiagnostics.shared.note { $0.asked += 1 }
        requestAccess { [weak self] url in
          T3TunnelDiagnostics.shared.note { url == nil ? ($0.denied += 1) : ($0.granted += 1) }
          self?.queue.async { self?.openTunnel(base: url, port: port) }
        }
      }
    }
  }

  private func openTunnel(base: String?, port: UInt16) {
    guard !closed else { return }
    guard let base, var components = URLComponents(string: base) else {
      return finish(socksReply(replyFailure))
    }
    components.queryItems = (components.queryItems ?? []) + [
      URLQueryItem(name: "port", value: String(port))
    ]
    guard let url = components.url else { return finish(socksReply(replyFailure)) }
    let tunnel = URLSession.shared.webSocketTask(with: url)
    tunnel.maximumMessageSize = 16 * 1024 * 1024
    self.tunnel = tunnel
    tunnel.resume()
    // A pong is the first sign the handshake succeeded; until then the page gets no reply.
    tunnel.sendPing { [weak self] error in
      if let error { T3TunnelDiagnostics.shared.note { $0.tunnelError = error.localizedDescription } }
      self?.queue.async {
        guard let self, !self.closed else { return }
        if error != nil { return self.finish(socksReply(replyFailure)) }
        self.connection.send(content: socksReply(replySucceeded), completion: .idempotent)
        if !self.received.isEmpty {
          let early = Data(self.received)
          self.received = []
          tunnel.send(.data(self.swapToServer(early))) { _ in }
        }
        self.pumpToTunnel(tunnel)
        self.pumpFromTunnel(tunnel)
      }
    }
  }

  /// The page's first bytes decide: a TLS handshake is left alone, anything else is plain HTTP.
  private func swapToServer(_ data: Data) -> Data {
    if !toServer.isDecided {
      let plain = data.first != 0x16
      toServer.decide(plain)
      toPage.decide(plain)
    }
    return toServer.isEnabled ? toServer.apply(data) : data
  }

  // Each direction asks for the next chunk only after the previous one is written, so a slow
  // side slows the other instead of piling up in memory.
  private func pumpToTunnel(_ tunnel: URLSessionWebSocketTask) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, isComplete, error in
      guard let self, !closed else { return }
      if let data, !data.isEmpty {
        let data = swapToServer(data)
        tunnel.send(.data(data)) { [weak self] error in
          self?.queue.async {
            guard let self, !self.closed else { return }
            if error != nil { self.close() } else if isComplete { self.close() } else {
              self.pumpToTunnel(tunnel)
            }
          }
        }
      } else if isComplete || error != nil {
        close()
      } else {
        pumpToTunnel(tunnel)
      }
    }
  }

  private func pumpFromTunnel(_ tunnel: URLSessionWebSocketTask) {
    tunnel.receive { [weak self] result in
      self?.queue.async {
        guard let self, !self.closed else { return }
        switch result {
        case .failure:
          // The environment closed its side; flush what the page has not read yet.
          self.finish(nil)
        case .success(let message):
          let data: Data
          switch message {
          case .data(let bytes): data = bytes
          case .string(let text): data = Data(text.utf8)
          @unknown default: data = Data()
          }
          self.connection.send(
            content: self.toPage.isEnabled ? self.toPage.apply(data) : data,
            completion: .contentProcessed { [weak self] error in
              self?.queue.async {
                guard let self, !self.closed else { return }
                if error != nil { self.close() } else { self.pumpFromTunnel(tunnel) }
              }
            }
          )
        }
      }
    }
  }
}

/// Swaps one string for another of the same length within each chunk. Holding back a partial
/// match could stall a reply ending in its first letters, so one split across chunks is missed;
/// the Host header always arrives whole.
struct T3HostSwap {
  private let from: [UInt8]
  private let to: [UInt8]
  private(set) var isDecided = false
  private(set) var isEnabled = false

  init(from: String, to: String) {
    self.from = Array(from.utf8)
    self.to = Array(to.utf8)
    precondition(self.from.count == self.to.count, "a swap must keep message lengths")
  }

  mutating func decide(_ enabled: Bool) {
    isDecided = true
    isEnabled = enabled
  }

  func apply(_ data: Data) -> Data {
    var bytes = [UInt8](data)
    var index = 0
    while index + from.count <= bytes.count {
      if bytes[index..<(index + from.count)].elementsEqual(from) {
        bytes.replaceSubrange(index..<(index + from.count), with: to)
        index += from.count
      } else {
        index += 1
      }
    }
    return Data(bytes)
  }
}

// TEMPORARY: what the proxy saw, shown on the error screen while we debug real devices.
final class T3TunnelDiagnostics {
  struct Counts {
    var accepted = 0
    var asked = 0
    var granted = 0
    var denied = 0
    var refused = "-"
    var tunnelError = "-"
  }

  static let shared = T3TunnelDiagnostics()
  private let lock = NSLock()
  private var counts = Counts()

  func note(_ update: (inout Counts) -> Void) { lock.withLock { update(&counts) } }
  var summary: String {
    lock.withLock {
      "accepted \(counts.accepted), asked \(counts.asked), granted \(counts.granted), denied \(counts.denied), refused \(counts.refused), tunnel \(counts.tunnelError)"
    }
  }
}
