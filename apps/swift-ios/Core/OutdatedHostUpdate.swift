import Foundation

public enum OutdatedHostUpdateError: LocalizedError, Equatable, Sendable {
    case manualUpdateRequired
    case hostAlreadyCompatible
    case incompleteProgress
    case recoveryTimedOut
    case invalidTargetVersion

    public var errorDescription: String? {
        switch self {
        case .manualUpdateRequired: "Update T3 Code on this computer manually."
        case .hostAlreadyCompatible: "This host now supports this app. Reconnect and check for updates again."
        case .incompleteProgress: "The host did not confirm that the update finished. Check its installed version before retrying."
        case .recoveryTimedOut: "The host did not return on a compatible T3 Code version. Check the host before retrying."
        case .invalidTargetVersion: "Choose an exact T3 Code release version."
        }
    }
}

/// The normal client remains V2-only. This private session can send only the
/// unchanged host-update RPCs, and never retries a socket or update command.
public struct OutdatedHostUpdate: Sendable {
    public enum Stage: String, Sendable {
        case downloading, installing, resuming
    }

    private let api: EnvironmentAPI
    private let transport: any HTTPTransport
    private let connector: any WebSocketConnecting
    private let recoveryTimeout: Duration
    private let recoveryPollInterval: Duration

    public init(
        api: EnvironmentAPI,
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        connector: any WebSocketConnecting = URLSessionWebSocketConnector(),
        recoveryTimeout: Duration = .seconds(240),
        recoveryPollInterval: Duration = .seconds(1)
    ) {
        self.api = api
        self.transport = transport
        self.connector = connector
        self.recoveryTimeout = recoveryTimeout
        self.recoveryPollInterval = recoveryPollInterval
    }

    public static func requiresHostUpdate(_ descriptor: EnvironmentDescriptor) -> Bool {
        (descriptor.orchestrationProtocolVersion ?? 1) < OrchestrationProtocolVersion.v2.rawValue
    }

    public static func canSelfUpdate(_ descriptor: EnvironmentDescriptor) -> Bool {
        switch descriptor.capabilities.serverSelfUpdate {
        case "boot-service", "respawn": true
        case "desktop-managed": descriptor.capabilities.desktopAppUpdate == true
        default: false
        }
    }

    /// Works from a saved, disconnected environment without loading orchestration.
    public func descriptor(for environment: Environment) async throws -> EnvironmentDescriptor {
        let verified = try await verifiedEnvironment(environment)
        guard let descriptor = verified.descriptor else { throw HTTPError.invalidResponse }
        return descriptor
    }

    @discardableResult
    public func update(
        environment: Environment,
        targetVersion: String,
        continueRunningThreads: Bool = false,
        onStage: @Sendable (Stage) async -> Void = { _ in }
    ) async throws -> EnvironmentDescriptor {
        guard targetVersion.range(
            of: #"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$"#, options: .regularExpression
        ) != nil else { throw OutdatedHostUpdateError.invalidTargetVersion }
        let verified = try await verifiedEnvironment(environment)
        guard let descriptor = verified.descriptor else { throw HTTPError.invalidResponse }
        guard Self.requiresHostUpdate(descriptor) else { throw OutdatedHostUpdateError.hostAlreadyCompatible }
        guard Self.canSelfUpdate(descriptor) else { throw OutdatedHostUpdateError.manualUpdateRequired }

        // Reuse the authenticated HTTP path, including DPoP refresh and exact
        // permissions. No saved credential is read until identity/version pass.
        try Task.checkCancellation()
        let session = try await api.session(for: verified)
        try EnvironmentPermissionState(session: session, serverAuth: session.auth).require("environment:maintain")
        try Task.checkCancellation()
        let ticket = try await api.webSocketTicket(for: verified)
        let socketURL = try Self.socketURL(environment: verified, ticket: ticket.ticket)
        let rpc = WebSocketRPCClient(
            connector: SingleUseUpdateConnector(base: connector),
            connectionWaitTimeout: .seconds(15),
            endpointProvider: { socketURL }
        )
        do {
            await rpc.start()
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { _ = try await rpc.waitForConnection(after: nil) }
                group.addTask {
                    try await Task.sleep(for: .seconds(15))
                    throw RPCError.responseTimedOut
                }
                defer { group.cancelAll() }
                _ = try await group.next()
            }
            try Task.checkCancellation()
            await onStage(.downloading)
            let payload: JSONValue = .object([
                "targetVersion": .string(targetVersion),
                "continueRunningThreads": .bool(
                    continueRunningThreads && descriptor.capabilities.serverUpdateThreadContinuation == true
                ),
            ])
            let result = try await install(
                rpc: rpc, descriptor: descriptor, payload: payload,
                targetVersion: targetVersion, onStage: onStage
            )
            if result.method == "desktop-app", let token = result.desktopUpdateToken {
                do {
                    let _: JSONValue = try await rpc.request(
                        "server.commitDesktopUpdate", payload: .object(["requestId": .string(token)]),
                        as: JSONValue.self
                    )
                } catch {
                    try Task.checkCancellation()
                    guard Self.isHandoffLoss(error) else { throw error }
                }
            }
            await rpc.stop()
        } catch {
            await rpc.stop()
            throw error
        }
        try Task.checkCancellation()
        await onStage(.resuming)
        return try await awaitRecovery(environment: environment)
    }

    private func install(
        rpc: WebSocketRPCClient, descriptor: EnvironmentDescriptor, payload: JSONValue,
        targetVersion: String, onStage: @Sendable (Stage) async -> Void
    ) async throws -> UpdateResult {
        if descriptor.capabilities.serverSelfUpdateProgress == true {
            var terminal: UpdateResult?
            do {
                let events = await rpc.subscribe(
                    "server.updateServerWithProgress", payload: payload, reconnect: false, as: ProgressEvent.self
                )
                for try await event in events {
                    switch event {
                    case let .progress(stage): await onStage(stage)
                    case let .complete(result): terminal = result
                    }
                }
            } catch {
                try Task.checkCancellation()
                guard terminal != nil, Self.isHandoffLoss(error) else { throw error }
            }
            try Task.checkCancellation()
            guard let terminal else { throw OutdatedHostUpdateError.incompleteProgress }
            return terminal
        }
        do {
            return try await rpc.request(
                "server.updateServer", payload: payload, responseDeadline: .none, as: UpdateResult.self
            )
        } catch {
            try Task.checkCancellation()
            guard let method = descriptor.capabilities.serverSelfUpdate,
                  ["boot-service", "respawn"].contains(method), Self.isHandoffLoss(error) else { throw error }
            // Some old hosts restart before acknowledging. Recovery must still
            // prove that this same host now runs V2 before reporting success.
            return UpdateResult(targetVersion: targetVersion, method: method, desktopUpdateToken: nil)
        }
    }

    private func verifiedEnvironment(_ environment: Environment) async throws -> Environment {
        var firstError: (any Error)?
        for route in environment.routes {
            let descriptor: EnvironmentDescriptor
            do {
                descriptor = try await freshDescriptor(at: route.httpBaseURL)
                guard descriptor.environmentId == environment.id else { throw EnvironmentRouteError.identityMismatch }
            } catch {
                try Task.checkCancellation()
                if firstError == nil { firstError = error }
                continue
            }
            // An unknown newer host must never receive credentials on this path.
            try Self.rejectNewerHost(descriptor)
            var selected = environment.selectingRoute(route)
            selected.descriptor = descriptor
            return selected
        }
        throw firstError ?? EnvironmentRouteError.noAvailableRoute
    }

    private func awaitRecovery(environment: Environment) async throws -> EnvironmentDescriptor {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: recoveryTimeout)
        while clock.now < deadline {
            for route in environment.routes {
                try Task.checkCancellation()
                let remaining = clock.now.duration(to: deadline)
                guard remaining > .zero else { throw OutdatedHostUpdateError.recoveryTimedOut }
                let descriptor: EnvironmentDescriptor
                do {
                    descriptor = try await freshDescriptor(at: route.httpBaseURL, timeout: min(.seconds(8), remaining))
                } catch {
                    try Task.checkCancellation()
                    continue
                }
                try Task.checkCancellation()
                guard descriptor.environmentId == environment.id else { continue }
                try Self.rejectNewerHost(descriptor)
                if !Self.requiresHostUpdate(descriptor) { return descriptor }
            }
            let remaining = clock.now.duration(to: deadline)
            if remaining > .zero { try await Task.sleep(for: min(recoveryPollInterval, remaining)) }
        }
        throw OutdatedHostUpdateError.recoveryTimedOut
    }

    private func freshDescriptor(at baseURL: URL, timeout: Duration = .seconds(8)) async throws -> EnvironmentDescriptor {
        try Task.checkCancellation()
        let seconds = Double(timeout.components.seconds) + Double(timeout.components.attoseconds) / 1e18
        var request = URLRequest(
            url: endpoint(baseURL, path: "/.well-known/t3/environment"),
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: seconds
        )
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        let (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        guard (200..<300).contains(response.statusCode) else {
            throw HTTPError.status(response.statusCode, message: "Could not check this host.", traceID: nil)
        }
        return try JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: data)
    }

    private static func rejectNewerHost(_ descriptor: EnvironmentDescriptor) throws {
        let version = descriptor.orchestrationProtocolVersion ?? 1
        if version > OrchestrationProtocolVersion.v2.rawValue {
            throw OrchestrationProtocolError.unsupportedServerVersion(version)
        }
    }

    private static func socketURL(environment: Environment, ticket: String) throws -> URL {
        guard var parts = URLComponents(url: environment.webSocketBaseURL, resolvingAgainstBaseURL: false) else {
            throw PairingURLError.invalidURL
        }
        if parts.path.isEmpty || parts.path == "/" { parts.path = "/ws" }
        var query = parts.queryItems ?? []
        query.removeAll { ["orchestrationProtocol", "wsTicket", "clientSurface", "connectionMethod"].contains($0.name) }
        query.append(contentsOf: [
            URLQueryItem(name: "wsTicket", value: ticket),
            URLQueryItem(name: "clientSurface", value: "mobile"),
            URLQueryItem(name: "connectionMethod", value: environment.kind == .managedDPoP ? "relay" : "direct"),
        ])
        parts.queryItems = query
        guard let url = parts.url else { throw PairingURLError.invalidURL }
        return url
    }

    private static func isHandoffLoss(_ error: any Error) -> Bool {
        if case RPCError.disconnected = error { return true }
        return false
    }

    private struct UpdateResult: Decodable, Sendable {
        let targetVersion: String
        let method: String
        let desktopUpdateToken: String?
    }

    private enum ProgressEvent: Decodable, Sendable {
        case progress(Stage)
        case complete(UpdateResult)

        private enum CodingKeys: String, CodingKey { case type, stage, result }

        init(from decoder: any Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            switch try values.decode(String.self, forKey: .type) {
            case "progress":
                let raw = try values.decode(String.self, forKey: .stage)
                guard let stage = Stage(rawValue: raw), stage != .resuming else {
                    throw DecodingError.dataCorruptedError(forKey: .stage, in: values, debugDescription: "Unknown update stage.")
                }
                self = .progress(stage)
            case "complete": self = .complete(try values.decode(UpdateResult.self, forKey: .result))
            default:
                throw DecodingError.dataCorruptedError(forKey: .type, in: values, debugDescription: "Unknown update event.")
            }
        }
    }
}

private actor SingleUseUpdateConnector: WebSocketConnecting {
    private let base: any WebSocketConnecting
    private var used = false

    init(base: any WebSocketConnecting) { self.base = base }

    func connect(to url: URL) async throws -> any WebSocketConnection {
        guard !used else { throw RPCError.disconnected }
        used = true
        return try await base.connect(to: url)
    }
}
