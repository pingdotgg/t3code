import Foundation
import Network
import Testing
@testable import T3Code

@Suite("Local network readiness probe")
@MainActor
struct LocalNetworkAccessCheckerTests {
    @Test func connectsToBracketedIPv6Loopback() async throws {
        let listener = try IPv6ProbeListener()
        defer { listener.stop() }
        var ports = listener.ready.makeAsyncIterator()
        let port = try #require(try await ports.next())

        let result = await LocalNetworkAccessChecker().check(endpoint: "http://[::1]:\(port)")

        #expect(result == .ready)
    }
}

@MainActor
private final class IPv6ProbeListener {
    let ready: AsyncThrowingStream<UInt16, Error>
    private let listener: NWListener
    private var connections: [NWConnection] = []
    private var stopped = false

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv6(.loopback), port: .any)
        let listener = try NWListener(using: parameters, on: .any)
        self.listener = listener
        let (ready, continuation) = AsyncThrowingStream.makeStream(of: UInt16.self)
        self.ready = ready
        listener.stateUpdateHandler = { [weak listener] state in
            switch state {
            case .ready:
                if let port = listener?.port {
                    continuation.yield(port.rawValue)
                    continuation.finish()
                }
            case let .failed(error):
                continuation.finish(throwing: error)
            case .cancelled:
                continuation.finish(throwing: CancellationError())
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor [weak self] in
                guard let self, !self.stopped else {
                    connection.cancel()
                    return
                }
                self.connections.append(connection)
                connection.start(queue: .global(qos: .userInitiated))
            }
        }
        listener.start(queue: .global(qos: .userInitiated))
    }

    func stop() {
        stopped = true
        listener.cancel()
        connections.forEach { $0.cancel() }
        connections.removeAll()
    }
}
