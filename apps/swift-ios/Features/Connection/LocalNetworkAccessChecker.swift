import Foundation
import Network

enum ConnectionReadiness: Equatable, Sendable {
    case ready
    case localNetworkDenied
    case unreachable
}

protocol ConnectionReadinessChecking: Sendable {
    func check(endpoint: String) async -> ConnectionReadiness
}

struct LocalNetworkAccessChecker: ConnectionReadinessChecking {
    func check(endpoint: String) async -> ConnectionReadiness {
        guard EndpointNetworkScope.isLocal(endpoint) else { return .ready }
        guard let components = URLComponents(string: endpoint),
              let hostname = components.host
        else {
            return .unreachable
        }
        let portNumber = components.port
            ?? (components.scheme?.lowercased() == "https" ? 443 : 80)
        guard
              let rawPort = UInt16(exactly: portNumber),
              let port = NWEndpoint.Port(rawValue: rawPort)
        else {
            return .unreachable
        }

        return await withCheckedContinuation { continuation in
            let connection = NWConnection(
                host: NWEndpoint.Host(hostname),
                port: port,
                using: .tcp
            )
            let completion = ConnectionProbeCompletion(
                connection: connection,
                continuation: continuation
            )

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    completion.finish(.ready)
                case .waiting(let error), .failed(let error):
                    if connection.currentPath?.unsatisfiedReason == .localNetworkDenied
                        || error.indicatesPermissionDenied {
                        completion.finish(.localNetworkDenied)
                    } else if case .failed = state {
                        completion.finish(.unreachable)
                    }
                case .cancelled:
                    completion.finish(.unreachable)
                default:
                    break
                }
            }

            connection.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 6) {
                if connection.currentPath?.unsatisfiedReason == .localNetworkDenied {
                    completion.finish(.localNetworkDenied)
                } else {
                    completion.finish(.unreachable)
                }
            }
        }
    }
}

private final class ConnectionProbeCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var didFinish = false
    private let connection: NWConnection
    private var continuation: CheckedContinuation<ConnectionReadiness, Never>?

    init(
        connection: NWConnection,
        continuation: CheckedContinuation<ConnectionReadiness, Never>
    ) {
        self.connection = connection
        self.continuation = continuation
    }

    func finish(_ result: ConnectionReadiness) {
        lock.lock()
        guard !didFinish else {
            lock.unlock()
            return
        }
        didFinish = true
        let continuation = continuation
        self.continuation = nil
        lock.unlock()

        connection.stateUpdateHandler = nil
        connection.cancel()
        continuation?.resume(returning: result)
    }
}

private extension NWError {
    var indicatesPermissionDenied: Bool {
        switch self {
        case .posix(.EACCES), .posix(.EPERM):
            true
        default:
            false
        }
    }
}
