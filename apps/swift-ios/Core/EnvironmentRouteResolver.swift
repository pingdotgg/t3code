import Foundation

public struct ResolvedEnvironmentRoute<Connection: Sendable>: Sendable {
    public let environment: Environment
    public let connection: Connection
}

/// Selects transport only. Authorization belongs to the supplied connection
/// factory, which must close a failed candidate and must never replay commands.
public actor EnvironmentRouteResolver {
    private let transport: any HTTPTransport
    private var lastPromotionCheck: [String: Date] = [:]
    private var failedPromotions: [String: Date] = [:]
    private var promoting = Set<String>()
    public static let promotionInterval: TimeInterval = 60
    public static let promotionCooldown: TimeInterval = 300

    public init(transport: any HTTPTransport = URLSessionHTTPTransport()) {
        self.transport = transport
    }

    public func connect<Connection: Sendable>(
        environment: Environment,
        authenticate: @Sendable (Environment) async throws -> Connection
    ) async throws -> ResolvedEnvironmentRoute<Connection> {
        var firstError: (any Error)?
        var retryableError: (any Error)?
        for route in environment.routes {
            try Task.checkCancellation()
            do {
                let candidate = try await verified(environment.selectingRoute(route))
                let connection = try await authenticate(candidate)
                return ResolvedEnvironmentRoute(environment: candidate, connection: connection)
            } catch {
                if error is CancellationError || Task.isCancelled { throw CancellationError() }
                if firstError == nil { firstError = error }
                if Self.isRetryable(error), retryableError == nil { retryableError = error }
            }
        }
        throw retryableError ?? firstError ?? EnvironmentRouteError.noAvailableRoute
    }

    /// A failed promotion returns nil and leaves the caller's live connection
    /// intact. Resume/network signals may bypass the interval, not cooldowns.
    public func promote<Connection: Sendable>(
        environment: Environment, now: Date = Date(), forceCheck: Bool = false,
        authenticate: @Sendable (Environment) async throws -> Connection
    ) async throws -> ResolvedEnvironmentRoute<Connection>? {
        guard !promoting.contains(environment.id),
              let activeIndex = environment.routes.firstIndex(where: { $0.id == environment.activeRouteID }),
              activeIndex > 0 else { return nil }
        if !forceCheck, let last = lastPromotionCheck[environment.id],
           now.timeIntervalSince(last) < Self.promotionInterval { return nil }
        lastPromotionCheck[environment.id] = now
        promoting.insert(environment.id)
        defer { promoting.remove(environment.id) }
        for route in environment.routes.prefix(activeIndex) {
            try Task.checkCancellation()
            let key = environment.id + ":" + route.id
            if let failed = failedPromotions[key], now.timeIntervalSince(failed) < Self.promotionCooldown { continue }
            do {
                let candidate = try await verified(environment.selectingRoute(route))
                let connection = try await authenticate(candidate)
                failedPromotions.removeValue(forKey: key)
                return ResolvedEnvironmentRoute(environment: candidate, connection: connection)
            } catch {
                if error is CancellationError || Task.isCancelled { throw CancellationError() }
                failedPromotions[key] = now
            }
        }
        return nil
    }

    /// Never send an access token to a host based only on a discovery hint.
    private func verified(_ environment: Environment) async throws -> Environment {
        let request = URLRequest(
            url: endpoint(environment.httpBaseURL, path: "/.well-known/t3/environment"),
            timeoutInterval: 2.5
        )
        let (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        guard (200..<300).contains(response.statusCode) else {
            throw HTTPError.status(response.statusCode, message: "Route identity could not be checked.", traceID: nil)
        }
        let descriptor = try JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: data)
        guard descriptor.environmentId == environment.id else { throw EnvironmentRouteError.identityMismatch }
        _ = try OrchestrationProtocolSelection(descriptor: descriptor, preference: environment.orchestrationProtocolPreference)
        var verified = environment
        verified.descriptor = descriptor
        return verified
    }

    private static func isRetryable(_ error: any Error) -> Bool {
        if error is URLError || error is T3ConnectNetworkError { return true }
        if case let HTTPError.status(code, _, _) = error { return code >= 500 || code == 408 || code == 429 }
        if let rpc = error as? RPCError {
            switch rpc {
            case .connectionUnavailable, .disconnected, .responseTimedOut: return true
            default: return false
            }
        }
        return false
    }
}
