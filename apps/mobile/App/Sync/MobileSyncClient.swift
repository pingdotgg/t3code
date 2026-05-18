import Foundation
import T3MobileProtocol

struct MobileSyncClient: Sendable {
    static let readChatCapabilities: Set<MobileServerCapability> = [
        .authWebSocketToken,
        .orchestrationShell,
        .orchestrationThreadDetail,
        .orchestrationReplayEnvelope,
        .orchestrationCommandReceipts,
        .diffTurn,
        .diffFullThread,
    ]

    private let httpClient: MobileHTTPClient
    private let webSocketTransport: any MobileWebSocketTransport
    private let mapper: MobileSyncProjectionMapper
    private let webSocketConnectTimeoutNanoseconds: UInt64

    init(
        httpClient: MobileHTTPClient = MobileHTTPClient(),
        webSocketTransport: any MobileWebSocketTransport = URLSessionMobileWebSocketTransport(),
        mapper: MobileSyncProjectionMapper = MobileSyncProjectionMapper(),
        webSocketConnectTimeoutNanoseconds: UInt64 = 15_000_000_000
    ) {
        self.httpClient = httpClient
        self.webSocketTransport = webSocketTransport
        self.mapper = mapper
        self.webSocketConnectTimeoutNanoseconds = webSocketConnectTimeoutNanoseconds
    }

    func connect(_ configuration: MobileServerConfiguration) async throws -> MobileSyncSession {
        let descriptor = try await httpClient.descriptor(baseURL: configuration.baseURL)
        try validateProtocolEnvelope(
            protocolVersion: descriptor.protocolVersion,
            minSupportedProtocolVersion: descriptor.minSupportedProtocolVersion,
            serverCapabilities: descriptor.serverCapabilities,
            requiredCapabilities: Self.readChatCapabilities
        )
        let bearerToken = try await bearerSessionToken(for: configuration)
        let webSocketToken = try await httpClient.webSocketToken(
            baseURL: configuration.baseURL,
            bearerToken: bearerToken
        ).result
        let webSocketURL = try makeWebSocketURL(
            endpoint: descriptor.endpoints.websocket,
            baseURL: configuration.baseURL,
            token: webSocketToken.token
        )
        let session = try await withTimeout(
            nanoseconds: webSocketConnectTimeoutNanoseconds,
            message: "Timed out connecting mobile WebSocket."
        ) {
            try await webSocketTransport.connect(to: webSocketURL)
        }
        let webSocket = MobileWebSocketClient(session: session)
        let hello: MobileHelloResponse
        do {
            hello = try await withTimeout(
                nanoseconds: webSocketConnectTimeoutNanoseconds,
                message: "Timed out waiting for mobile WebSocket hello."
            ) {
                try await webSocket.hello()
            }
        } catch {
            await webSocket.close()
            throw error
        }
        try validateProtocolEnvelope(
            protocolVersion: hello.protocolVersion,
            minSupportedProtocolVersion: mobileProtocolVersion,
            serverCapabilities: hello.serverCapabilities,
            requiredCapabilities: Self.readChatCapabilities
        )
        return MobileSyncSession(
            descriptor: descriptor,
            bearerSessionToken: bearerToken,
            webSocketToken: webSocketToken,
            serverCapabilities: Set(hello.serverCapabilities),
            webSocket: webSocket
        )
    }

    func loadInitialShell(
        _ configuration: MobileServerConfiguration,
        reconnectPolicy: MobileReconnectPolicy = .appDefault
    ) async throws -> MobileInitialSyncResult {
        let attempts = max(1, reconnectPolicy.maxAttempts)
        var latestError: Error?
        for attempt in 1...attempts {
            do {
                return try await loadInitialShellOnce(configuration)
            } catch {
                latestError = error
                if attempt < attempts {
                    try await Task.sleep(nanoseconds: reconnectPolicy.retryDelayNanoseconds)
                }
            }
        }
        throw latestError ?? MobileSyncError.unexpectedMessage("Mobile sync failed without an error.")
    }

    private func loadInitialShellOnce(_ configuration: MobileServerConfiguration) async throws -> MobileInitialSyncResult {
        let session = try await connect(configuration)
        do {
            let shellSubscription = try await session.webSocket.openShellSubscription()
            let shellState = try mapper.shellState(from: shellSubscription.initial)
            return MobileInitialSyncResult(
                session: session,
                environment: mapper.environment(from: session.descriptor),
                shellState: shellState,
                shellSubscription: shellSubscription
            )
        } catch {
            await session.webSocket.close()
            throw error
        }
    }

    private func bearerSessionToken(for configuration: MobileServerConfiguration) async throws -> String {
        if let token = configuration.bearerSessionToken, !token.isEmpty {
            let session = try await httpClient.session(baseURL: configuration.baseURL, bearerToken: token)
            try validateProtocolEnvelope(
                protocolVersion: session.protocolVersion,
                minSupportedProtocolVersion: mobileProtocolVersion,
                serverCapabilities: session.serverCapabilities,
                requiredCapabilities: [.authWebSocketToken]
            )
            return token
        }
        guard let bootstrapCredential = configuration.bootstrapCredential, !bootstrapCredential.isEmpty else {
            throw MobileSyncError.missingAuthenticationCredential
        }
        let bootstrap = try await httpClient.bootstrapBearer(
            baseURL: configuration.baseURL,
            credential: bootstrapCredential
        )
        try validateProtocolEnvelope(
            protocolVersion: bootstrap.protocolVersion,
            minSupportedProtocolVersion: mobileProtocolVersion,
            serverCapabilities: bootstrap.serverCapabilities,
            requiredCapabilities: [.authBearerBootstrap, .authWebSocketToken]
        )
        return bootstrap.result.sessionToken
    }

    private func makeWebSocketURL(endpoint: String, baseURL: URL, token: String) throws -> URL {
        let endpointURL: URL
        if let absolute = URL(string: endpoint), absolute.scheme != nil {
            endpointURL = absolute
        } else if let relative = URL(string: endpoint, relativeTo: baseURL)?.absoluteURL {
            endpointURL = relative
        } else {
            throw MobileSyncError.invalidEndpoint(endpoint)
        }

        guard var components = URLComponents(url: endpointURL, resolvingAgainstBaseURL: false) else {
            throw MobileSyncError.invalidWebSocketURL(endpointURL)
        }
        if components.scheme == "https" {
            components.scheme = "wss"
        } else if components.scheme == "http" {
            components.scheme = "ws"
        }
        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: "wsToken", value: token))
        components.queryItems = queryItems
        guard let url = components.url, url.scheme == "ws" || url.scheme == "wss" else {
            throw MobileSyncError.invalidWebSocketURL(endpointURL)
        }
        return url
    }

    private func validateProtocolEnvelope(
        protocolVersion: String,
        minSupportedProtocolVersion: String,
        serverCapabilities: [MobileServerCapability],
        requiredCapabilities: Set<MobileServerCapability>
    ) throws {
        guard protocolVersion == mobileProtocolVersion else {
            throw MobileSyncError.incompatibleProtocol(
                "Unsupported mobile protocol version \(protocolVersion). Expected \(mobileProtocolVersion)."
            )
        }
        guard minSupportedProtocolVersion == mobileProtocolVersion else {
            throw MobileSyncError.incompatibleProtocol(
                "Unsupported minimum mobile protocol version \(minSupportedProtocolVersion). Expected \(mobileProtocolVersion)."
            )
        }
        let capabilities = Set(serverCapabilities)
        for capability in requiredCapabilities where !capabilities.contains(capability) {
            throw MobileSyncError.missingCapability(capability.rawValue)
        }
    }

    private func withTimeout<Value: Sendable>(
        nanoseconds: UInt64,
        message: String,
        operation: @escaping @Sendable () async throws -> Value
    ) async throws -> Value {
        try await withThrowingTaskGroup(of: Value.self) { group in
            group.addTask {
                try await operation()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: nanoseconds)
                throw MobileSyncError.timeout(message)
            }
            guard let value = try await group.next() else {
                throw MobileSyncError.timeout(message)
            }
            group.cancelAll()
            return value
        }
    }
}
