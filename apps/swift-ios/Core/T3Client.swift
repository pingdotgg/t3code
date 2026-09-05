import Foundation

enum MobileClientMetadata {
    static var osMajorVersion: Int {
        ProcessInfo.processInfo.operatingSystemVersion.majorVersion
    }

    static var deviceModel: String {
        if let simulatedModel = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"],
           !simulatedModel.isEmpty {
            return simulatedModel
        }
        var system = utsname()
        uname(&system)
        let machineSize = MemoryLayout.size(ofValue: system.machine)
        return withUnsafePointer(to: &system.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: machineSize) {
                String(cString: $0)
            }
        }
    }
}

public actor T3Client {
    public let environment: Environment
    private let api: EnvironmentAPI
    private let rpc: WebSocketRPCClient
    private let configSnapshotWaitTimeout: Duration
    private var latestServerEnvironment: EnvironmentDescriptor?
    private var serverConfigCache: ServerConfigSnapshot?
    private var serverConfigGeneration: UInt64 = 0
    private var serverConfigTask: Task<Void, Never>?
    private var serverConfigWaiters: [UUID: CheckedContinuation<ServerConfigSnapshot, any Error>] = [:]
    private var serverConfigListeners: [UUID: AsyncThrowingStream<ServerConfigStreamEvent, any Error>.Continuation] = [:]

    public init(
        environment: Environment,
        credentialStore: any CredentialStore,
        httpTransport: any HTTPTransport = URLSessionHTTPTransport(),
        webSocketConnector: any WebSocketConnecting = URLSessionWebSocketConnector(),
        managedAuthorization: (any ManagedEnvironmentAuthorizing)? = nil,
        rpcConnectionWaitTimeout: Duration = .seconds(4)
    ) {
        self.environment = environment
        let api = EnvironmentAPI(
            transport: httpTransport,
            credentials: credentialStore,
            managedAuthorization: managedAuthorization
        )
        self.api = api
        self.configSnapshotWaitTimeout = rpcConnectionWaitTimeout
        self.rpc = WebSocketRPCClient(
            connector: webSocketConnector,
            connectionWaitTimeout: rpcConnectionWaitTimeout
        ) {
            let ticket = try await api.webSocketTicket(for: environment)
            var components = URLComponents(
                url: environment.webSocketBaseURL,
                resolvingAgainstBaseURL: false
            )!
            if components.path.isEmpty || components.path == "/" {
                components.path = "/ws"
            }
            var query = components.queryItems ?? []
            query.removeAll {
                $0.name == "wsTicket"
                    || $0.name == "clientSurface"
                    || $0.name == "clientAppVersion"
                    || $0.name == "clientOs"
                    || $0.name == "clientOsMajorVersion"
                    || $0.name == "clientDeviceModel"
            }
            query.append(URLQueryItem(name: "wsTicket", value: ticket.ticket))
            query.append(URLQueryItem(name: "clientSurface", value: "mobile"))
            query.append(URLQueryItem(name: "clientOs", value: "iOS"))
            query.append(URLQueryItem(
                name: "clientOsMajorVersion",
                value: String(MobileClientMetadata.osMajorVersion)
            ))
            let deviceModel = MobileClientMetadata.deviceModel
            if !deviceModel.isEmpty {
                query.append(URLQueryItem(name: "clientDeviceModel", value: deviceModel))
            }
            if let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
               !appVersion.isEmpty {
                query.append(URLQueryItem(name: "clientAppVersion", value: appVersion))
            }
            components.queryItems = query
            guard let url = components.url else { throw PairingURLError.invalidURL }
            return url
        }
    }

    public func connect() async {
        await rpc.start()
    }

    public func disconnect() async {
        stopServerConfigSubscription(error: RPCError.disconnected)
        await rpc.stop()
    }

    public func reconnect() async {
        await rpc.reconnect()
    }

    public func liveConnectionActive() async -> Bool {
        await rpc.isConnected()
    }

    public func currentConnectionID() async -> UUID? {
        await rpc.currentConnectionID()
    }

    public func shellSnapshot(
        timeoutInterval: TimeInterval? = nil
    ) async throws -> OrchestrationShellSnapshot {
        try await api.shellSnapshot(
            for: environment,
            timeoutInterval: timeoutInterval
        )
    }

    public func readModel() async throws -> OrchestrationReadModel {
        try await api.readModel(for: environment)
    }

    public func archivedShellSnapshot() async throws -> OrchestrationShellSnapshot {
        try await rpc.request(
            RPCMethod.getArchivedShellSnapshot.rawValue,
            as: OrchestrationShellSnapshot.self
        )
    }

    public func threadSnapshot(
        id: String,
        turnLimit: Int? = nil,
        beforeCursor: String? = nil,
        timeoutInterval: TimeInterval? = nil
    ) async throws -> OrchestrationThreadDetailSnapshot {
        try await api.threadSnapshot(
            id: id,
            environment: environment,
            turnLimit: turnLimit,
            beforeCursor: beforeCursor,
            timeoutInterval: timeoutInterval
        )
    }

    public func serverConfig() async throws -> ServerConfigSnapshot {
        if let serverConfigCache { return serverConfigCache }
        startServerConfigSubscriptionIfNeeded()
        return try await withThrowingTaskGroup(of: ServerConfigSnapshot.self) { group in
            group.addTask { try await self.waitForServerConfigSnapshot() }
            group.addTask {
                try await Task.sleep(for: self.configSnapshotWaitTimeout)
                throw RPCError.responseTimedOut
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    public func updateSettings(_ change: ServerSettingsChange) async throws
        -> ServerSettingsSnapshot
    {
        return try await rpc.request(
            RPCMethod.serverUpdateSettings.rawValue,
            payload: .object(["patch": change.jsonValue]),
            as: ServerSettingsSnapshot.self
        )
    }

    public func refreshProviders(cwd: String? = nil, instanceID: String? = nil, refreshModels: Bool = true) async throws -> ServerConfigSnapshot {
        let current = try await serverConfig()
        let generation = serverConfigGeneration
        let result: ServerRefreshProvidersResult = try await rpc.request(
            RPCMethod.serverRefreshProviders.rawValue,
            payload: .object([
                "refreshModels": .bool(refreshModels),
            ].merging(cwd.map { ["cwd": .string($0)] } ?? [:]) { _, new in new }
                .merging(instanceID.map { ["instanceId": .string($0)] } ?? [:]) { _, new in new }),
            as: ServerRefreshProvidersResult.self
        )
        guard generation == serverConfigGeneration else { throw CancellationError() }
        let latest = serverConfigCache ?? current
        let config = ServerConfigSnapshot(
            providers: result.providers,
            settings: latest.settings,
            threadSnapshotPagination: latest.threadSnapshotPagination,
            threadResumeCompletionMarker: latest.threadResumeCompletionMarker,
            environment: latest.environment,
            usageLimitSources: latest.usageLimitSources
        )
        cacheServerConfig(config)
        serverConfigListeners.values.forEach { $0.yield(.snapshot(config)) }
        return config
    }

    public func consumeResetCredit(instanceID: String) async throws -> ProviderConsumeResetCreditResult {
        try await rpc.request(
            RPCMethod.providerConsumeResetCredit.rawValue,
            payload: .object(["instanceId": .string(instanceID)]),
            as: ProviderConsumeResetCreditResult.self
        )
    }

    public func usageSummary(_ input: UsageSummaryInput) async throws -> UsageSummary {
        try await rpc.request(
            RPCMethod.serverGetUsageSummary.rawValue,
            payload: try JSONValue.encode(input),
            as: UsageSummary.self
        )
    }

    public func refreshUsageRates() async throws -> UsagePricing {
        try await rpc.request("server.refreshUsageRates", as: UsagePricing.self)
    }

    public func setProviderEnabled(instanceID: String, driver: String, enabled: Bool) async throws {
        let settings = try await rpc.request("server.getSettings", as: JSONValue.self)
        let patch = ProviderSettingsPatch.enabled(settings: settings, instanceID: instanceID, driver: driver, enabled: enabled)
        let _: JSONValue = try await rpc.request("server.updateSettings", payload: .object(["patch": patch]), as: JSONValue.self)
    }

    public func providerSetup(instanceID: String, action: ProviderSetupAction) async throws -> ProviderSetupEvent {
        switch action {
        case .signIn, .completeSignIn, .cancelSignIn, .signOut:
            return .auth(try await rpc.request(action.method, payload: action.payload(instanceID: instanceID), as: ProviderAuthState.self))
        case .install, .cancelInstall, .remove:
            return .install(try await rpc.request(action.method, payload: action.payload(instanceID: instanceID), as: ProviderInstallState.self))
        }
    }

    public func providerAuthEvents(instanceID: String) async -> AsyncThrowingStream<ProviderAuthState, Error> {
        await rpc.subscribe("provider.auth.subscribe", payload: .object(["instanceId": .string(instanceID)]), as: ProviderAuthState.self)
    }

    public func providerInstallEvents(instanceID: String) async -> AsyncThrowingStream<ProviderInstallState, Error> {
        await rpc.subscribe("provider.install.subscribe", payload: .object(["instanceId": .string(instanceID)]), as: ProviderInstallState.self)
    }

    public func pullRequests(_ input: PullRequestListInput) async throws -> PullRequestListResult {
        try await rpc.request(
            RPCMethod.pullRequestsList.rawValue,
            payload: try JSONValue.encode(input),
            as: PullRequestListResult.self
        )
    }

    public func pullRequestDetail(_ reference: PullRequestRef) async throws -> PullRequestDetail {
        try await rpc.request(
            RPCMethod.pullRequestsDetail.rawValue,
            payload: try JSONValue.encode(reference),
            as: PullRequestDetail.self
        )
    }

    public func pullRequestActivity(_ reference: PullRequestRef) async throws
        -> PullRequestActivity
    {
        try await rpc.request(
            RPCMethod.pullRequestsActivity.rawValue,
            payload: try JSONValue.encode(reference),
            as: PullRequestActivity.self
        )
    }

    public func pullRequestDiff(_ input: PullRequestDiffInput) async throws
        -> PullRequestDiffResult
    {
        try await api.pullRequestDiff(input, environment: environment)
    }

    public func runPullRequestAction(
        _ reference: PullRequestRef,
        action: PullRequestAction,
        mergeMethod: PullRequestMergeMethod? = nil,
        updateMethod: PullRequestUpdateMethod? = nil
    ) async throws {
        var payload = try reference.jsonObject
        payload["action"] = .string(action.rawValue)
        if let mergeMethod { payload["mergeMethod"] = .string(mergeMethod.rawValue) }
        if let updateMethod { payload["updateMethod"] = .string(updateMethod.rawValue) }
        try await rpc.request(
            RPCMethod.pullRequestsRunAction.rawValue,
            payload: .object(payload)
        )
    }

    public func updatePullRequest(
        _ reference: PullRequestRef,
        title: String? = nil,
        body: String? = nil
    ) async throws {
        var payload = try reference.jsonObject
        if let title { payload["title"] = .string(title) }
        if let body { payload["body"] = .string(body) }
        try await rpc.request(RPCMethod.pullRequestsUpdate.rawValue, payload: .object(payload))
    }

    public func commentOnPullRequest(_ reference: PullRequestRef, body: String) async throws {
        var payload = try reference.jsonObject
        payload["body"] = .string(body)
        try await rpc.request(RPCMethod.pullRequestsComment.rawValue, payload: .object(payload))
    }

    public func updatePullRequestComment(
        _ reference: PullRequestRef,
        commentID: String,
        kind: PullRequestCommentKind,
        body: String
    ) async throws {
        var payload = try reference.jsonObject
        payload["commentId"] = .string(commentID)
        payload["kind"] = .string(kind.rawValue)
        payload["body"] = .string(body)
        try await rpc.request(
            RPCMethod.pullRequestsUpdateComment.rawValue,
            payload: .object(payload)
        )
    }

    public func submitPullRequestReview(
        _ reference: PullRequestRef,
        verdict: PullRequestReviewVerdict,
        body: String,
        comments: [PullRequestReviewCommentDraft]
    ) async throws {
        var payload = try reference.jsonObject
        payload["verdict"] = .string(verdict.rawValue)
        payload["body"] = .string(body)
        payload["comments"] = try .encode(comments)
        try await rpc.request(
            RPCMethod.pullRequestsSubmitReview.rawValue,
            payload: .object(payload)
        )
    }

    public func replyToPullRequestThread(
        _ reference: PullRequestRef,
        threadID: String,
        body: String
    ) async throws {
        var payload = try reference.jsonObject
        payload["threadId"] = .string(threadID)
        payload["body"] = .string(body)
        try await rpc.request(
            RPCMethod.pullRequestsReplyToThread.rawValue,
            payload: .object(payload)
        )
    }

    public func setPullRequestThreadResolved(
        _ reference: PullRequestRef,
        threadID: String,
        resolved: Bool
    ) async throws {
        var payload = try reference.jsonObject
        payload["threadId"] = .string(threadID)
        payload["resolved"] = .bool(resolved)
        try await rpc.request(
            RPCMethod.pullRequestsSetThreadResolution.rawValue,
            payload: .object(payload)
        )
    }

    public func setPullRequestReaction(
        _ reference: PullRequestRef,
        subjectID: String?,
        content: PullRequestReactionContent,
        reacted: Bool
    ) async throws {
        var payload = try reference.jsonObject
        if let subjectID { payload["subjectId"] = .string(subjectID) }
        payload["content"] = .string(content.rawValue)
        payload["reacted"] = .bool(reacted)
        try await rpc.request(
            RPCMethod.pullRequestsSetReaction.rawValue,
            payload: .object(payload)
        )
    }

    public func pullRequestReviewerCandidates(_ reference: PullRequestRef) async throws
        -> PullRequestReviewerCandidateList
    {
        try await rpc.request(
            RPCMethod.pullRequestsReviewerCandidates.rawValue,
            payload: try JSONValue.encode(reference),
            as: PullRequestReviewerCandidateList.self
        )
    }

    public func requestPullRequestReviewers(
        _ reference: PullRequestRef,
        reviewers: [PullRequestReviewerCandidate],
        requested: Bool
    ) async throws {
        var payload = try reference.jsonObject
        payload["reviewers"] = .array(reviewers.map {
            .object(["id": .string($0.id), "kind": .string($0.kind)])
        })
        payload["requested"] = .bool(requested)
        try await rpc.request(
            RPCMethod.pullRequestsRequestReviewers.rawValue,
            payload: .object(payload)
        )
    }

    public func invalidatePullRequests(_ reference: PullRequestRef? = nil) async throws {
        var payload: [String: JSONValue] = [:]
        if let reference { payload["reference"] = try JSONValue.encode(reference) }
        try await rpc.request(
            RPCMethod.pullRequestsInvalidate.rawValue,
            payload: .object(payload)
        )
    }

    public func serverConfigEvents() async
        -> AsyncThrowingStream<ServerConfigStreamEvent, Error>
    {
        let id = UUID()
        let stream = AsyncThrowingStream<ServerConfigStreamEvent, Error> { continuation in
            serverConfigListeners[id] = continuation
            if let serverConfigCache { continuation.yield(.snapshot(serverConfigCache)) }
            continuation.onTermination = { @Sendable _ in
                Task { await self.removeServerConfigListener(id) }
            }
        }
        startServerConfigSubscriptionIfNeeded()
        return stream
    }

    private func startServerConfigSubscriptionIfNeeded() {
        guard serverConfigTask == nil else { return }
        serverConfigGeneration &+= 1
        let generation = serverConfigGeneration
        serverConfigTask = Task { [weak self] in
            guard let self else { return }
            let stream = await rpc.subscribe(
                RPCMethod.subscribeServerConfig.rawValue,
                payload: .object(["usageLimitSources": .bool(true)]),
                as: ServerConfigStreamEvent.self
            )
            do {
                for try await event in stream {
                    guard !Task.isCancelled else { return }
                    await self.consumeServerConfig(event, generation: generation)
                }
                await self.finishServerConfigSubscription(generation: generation, error: RPCError.disconnected)
            } catch {
                await self.handleServerConfigSubscriptionFailure(error, generation: generation)
            }
        }
    }

    private func consumeServerConfig(_ event: ServerConfigStreamEvent, generation: UInt64) {
        guard generation == serverConfigGeneration else { return }
        var emittedEvent = event
        switch event {
        case var .snapshot(config):
            // Wire snapshots omit sources. Keep them until a capable server
            // publishes its current set. Drop them when source support is gone.
            config.usageLimitSources = config.environment?.capabilities.usageLimitSources == true
                ? serverConfigCache?.usageLimitSources ?? config.usageLimitSources
                : []
            cacheServerConfig(config)
            emittedEvent = .snapshot(config)
        case let .providerStatuses(providers):
            if let current = serverConfigCache {
                cacheServerConfig(.init(
                    providers: providers,
                    settings: current.settings,
                    threadSnapshotPagination: current.threadSnapshotPagination,
                    threadResumeCompletionMarker: current.threadResumeCompletionMarker,
                    environment: current.environment,
                    usageLimitSources: current.usageLimitSources
                ))
            }
        case let .settingsUpdated(settings):
            if let current = serverConfigCache {
                cacheServerConfig(.init(
                    providers: current.providers,
                    settings: settings,
                    threadSnapshotPagination: current.threadSnapshotPagination,
                    threadResumeCompletionMarker: current.threadResumeCompletionMarker,
                    environment: current.environment,
                    usageLimitSources: current.usageLimitSources
                ))
            }
        case let .usageLimitSourcesUpdated(sources):
            guard var current = serverConfigCache,
                  current.environment?.capabilities.usageLimitSources == true else { return }
            current.usageLimitSources = sources
            cacheServerConfig(current)
        case .unrelated: break
        }
        serverConfigListeners.values.forEach { $0.yield(emittedEvent) }
    }

    private func cacheServerConfig(_ config: ServerConfigSnapshot) {
        serverConfigCache = config
        latestServerEnvironment = config.environment
        let waiters = serverConfigWaiters.values
        serverConfigWaiters.removeAll()
        waiters.forEach { $0.resume(returning: config) }
    }

    private func waitForServerConfigSnapshot() async throws -> ServerConfigSnapshot {
        if let serverConfigCache { return serverConfigCache }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                serverConfigWaiters[id] = continuation
            }
        } onCancel: {
            Task { await self.cancelServerConfigWaiter(id) }
        }
    }

    private func cancelServerConfigWaiter(_ id: UUID) {
        serverConfigWaiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    private func removeServerConfigListener(_ id: UUID) { serverConfigListeners[id] = nil }

    private func handleServerConfigSubscriptionFailure(_ error: any Error, generation: UInt64) async {
        guard generation == serverConfigGeneration else { return }
        guard isUnsupportedServerConfigSubscription(error) else {
            finishServerConfigSubscription(generation: generation, error: error)
            return
        }
        do {
            let config: ServerConfigSnapshot = try await rpc.request(
                RPCMethod.serverGetConfig.rawValue,
                as: ServerConfigSnapshot.self
            )
            guard generation == serverConfigGeneration else { return }
            cacheServerConfig(config)
            serverConfigListeners.values.forEach { $0.yield(.snapshot(config)) }
            serverConfigTask = nil
        } catch {
            finishServerConfigSubscription(generation: generation, error: error)
        }
    }

    private func isUnsupportedServerConfigSubscription(_ error: any Error) -> Bool {
        guard case let RPCError.remote(message) = error else { return false }
        let value = message.lowercased()
        guard value.contains(RPCMethod.subscribeServerConfig.rawValue.lowercased()) else {
            return false
        }
        return value.contains("unsupported method") || value.contains("unknown rpc")
            || value.contains("unknown request") || value.contains("method not found")
    }

    private func finishServerConfigSubscription(generation: UInt64, error: any Error) {
        guard generation == serverConfigGeneration else { return }
        serverConfigTask = nil
        serverConfigCache = nil
        latestServerEnvironment = nil
        let waiters = serverConfigWaiters.values
        serverConfigWaiters.removeAll()
        waiters.forEach { $0.resume(throwing: error) }
        let listeners = serverConfigListeners.values
        serverConfigListeners.removeAll()
        listeners.forEach { $0.finish(throwing: error) }
    }

    private func stopServerConfigSubscription(error: any Error) {
        serverConfigGeneration &+= 1
        serverConfigTask?.cancel()
        serverConfigTask = nil
        serverConfigCache = nil
        latestServerEnvironment = nil
        let waiters = serverConfigWaiters.values
        serverConfigWaiters.removeAll()
        waiters.forEach { $0.resume(throwing: error) }
        let listeners = serverConfigListeners.values
        serverConfigListeners.removeAll()
        listeners.forEach { $0.finish(throwing: error) }
    }

    public func clientSessions() async throws -> [AuthClientSession] {
        try await api.clientSessions(for: environment)
    }

    public func authSession() async throws -> AuthSessionState {
        try await api.session(for: environment)
    }

    @discardableResult
    public func revokeClientSession(id: String) async throws -> Bool {
        try await api.revokeClientSession(id: id, environment: environment).revoked
    }

    @discardableResult
    public func revokeOtherClientSessions() async throws -> Int {
        try await api.revokeOtherClientSessions(for: environment).revokedCount
    }

    /// HTTP live-sync fallback. Each iteration is an independent request, so a
    /// transient network loss naturally reconnects without replaying commands.
    public func pollShell(
        every interval: Duration = .seconds(2)
    ) -> AsyncThrowingStream<OrchestrationShellSnapshot, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var lastSequence: Int?
                while !Task.isCancelled {
                    do {
                        let snapshot = try await self.shellSnapshot()
                        if lastSequence != snapshot.snapshotSequence {
                            lastSequence = snapshot.snapshotSequence
                            continuation.yield(snapshot)
                        }
                    } catch is CancellationError {
                        break
                    } catch {
                        // Keep retrying transient HTTP failures. Authentication
                        // failures surface from direct loads and pairing UI.
                    }
                    try? await Task.sleep(for: interval)
                }
                continuation.finish()
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    public func shellEvents(
        after sequence: Int? = nil,
        reconnect: Bool = true
    ) async -> AsyncThrowingStream<ShellStreamItem, Error> {
        var payload: [String: JSONValue] = ["requestCompletionMarker": .bool(true)]
        if let sequence { payload["afterSequence"] = .number(Double(sequence)) }
        return await rpc.subscribe(
            RPCMethod.subscribeShell.rawValue,
            payload: .object(payload),
            reconnect: reconnect,
            as: ShellStreamItem.self
        )
    }

    public func threadEvents(
        threadID: String,
        after sequence: Int? = nil,
        turnLimit: Int? = nil,
        reconnect: Bool = true
    ) async -> AsyncThrowingStream<ThreadStreamItem, Error> {
        var payload: [String: JSONValue] = [
            "threadId": .string(threadID),
            "requestCompletionMarker": .bool(true),
        ]
        if let sequence { payload["afterSequence"] = .number(Double(sequence)) }
        if let turnLimit { payload["turnLimit"] = .number(Double(turnLimit)) }
        return await rpc.subscribe(
            RPCMethod.subscribeThread.rawValue,
            payload: .object(payload),
            reconnect: reconnect,
            as: ThreadStreamItem.self
        )
    }

    @discardableResult
    public func dispatch(_ command: JSONValue) async throws -> DispatchResult {
        guard await rpc.isConnected() else {
            return try await api.dispatch(command, environment: environment)
        }
        do {
            return try await dispatchOverWebSocket(command)
        } catch RPCError.connectionUnavailable {
            // The request provably never crossed the socket, so HTTP is a safe
            // fallback without risking duplicate side effects.
            return try await api.dispatch(command, environment: environment)
        }
    }

    @discardableResult
    public func sendTurn(
        threadID: String,
        text: String,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        model: ModelSelection? = nil,
        attachments: [UploadChatImageAttachment] = [],
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString,
        createdAt: String = OrchestrationCommands.now()
    ) async throws -> DispatchResult {
        let uploadedAttachments = try await prepareTurnAttachments(attachments)
        return try await dispatch(
            try OrchestrationCommands.sendTurn(
                threadID: threadID,
                text: text,
                runtimeMode: runtimeMode,
                interactionMode: interactionMode,
                model: model,
                attachments: attachments,
                uploadedAttachments: uploadedAttachments,
                commandID: commandID,
                messageID: messageID,
                createdAt: createdAt
            )
        )
    }

    @discardableResult
    public func createThread(
        threadID: String = UUID().uuidString,
        projectID: String,
        title: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        branch: String? = nil,
        worktreePath: String? = nil
    ) async throws -> DispatchResult {
        try await dispatch(
            try OrchestrationCommands.createThread(
                threadID: threadID,
                projectID: projectID,
                title: title,
                model: model,
                runtimeMode: runtimeMode,
                interactionMode: interactionMode,
                branch: branch,
                worktreePath: worktreePath
            )
        )
    }

    /// Creates a thread and starts its first turn through the server-supported
    /// message-first bootstrap path.
    @discardableResult
    public func createThreadAndSend(
        threadID: String = UUID().uuidString,
        projectID: String,
        title: String,
        text: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        branch: String? = nil,
        worktreePath: String? = nil,
        worktreePreparation: ThreadWorktreePreparation? = nil,
        attachments: [UploadChatImageAttachment] = [],
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString,
        createdAt: String = OrchestrationCommands.now()
    ) async throws -> DispatchResult {
        let uploadedAttachments = try await prepareTurnAttachments(attachments)
        return try await dispatchOverWebSocket(
            try OrchestrationCommands.createThreadAndSend(
                threadID: threadID,
                projectID: projectID,
                title: title,
                text: text,
                model: model,
                runtimeMode: runtimeMode,
                interactionMode: interactionMode,
                branch: branch,
                worktreePath: worktreePath,
                worktreePreparation: worktreePreparation,
                attachments: attachments,
                uploadedAttachments: uploadedAttachments,
                commandID: commandID,
                messageID: messageID,
                createdAt: createdAt
            )
        )
    }

    private func dispatchOverWebSocket(_ command: JSONValue) async throws -> DispatchResult {
        try await rpc.request(
            RPCMethod.dispatchCommand.rawValue,
            payload: command,
            as: DispatchResult.self
        )
    }

    @discardableResult
    public func createProject(
        projectID: String = UUID().uuidString,
        title: String,
        workspaceRoot: String,
        defaultModel: ModelSelection? = nil,
        createWorkspaceRootIfMissing: Bool = false
    ) async throws -> DispatchResult {
        try await dispatch(
            try OrchestrationCommands.createProject(
                projectID: projectID,
                title: title,
                workspaceRoot: workspaceRoot,
                defaultModel: defaultModel,
                createWorkspaceRootIfMissing: createWorkspaceRootIfMissing
            )
        )
    }

    @discardableResult
    public func archive(threadID: String, archived: Bool) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.archive(threadID: threadID, archived: archived))
    }

    @discardableResult
    public func delete(threadID: String) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.deleteThread(threadID: threadID))
    }

    @discardableResult
    public func rename(threadID: String, title: String) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.rename(threadID: threadID, title: title))
    }

    @discardableResult
    public func regenerateTitle(threadID: String) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.regenerateTitle(threadID: threadID))
    }

    @discardableResult
    public func interrupt(threadID: String, turnID: String? = nil) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.interrupt(threadID: threadID, turnID: turnID)
        )
    }

    @discardableResult
    public func respondToApproval(
        threadID: String,
        requestID: String,
        decision: String
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.respondToApproval(
                threadID: threadID,
                requestID: requestID,
                decision: decision
            )
        )
    }

    @discardableResult
    public func respondToUserInput(
        threadID: String,
        requestID: String,
        answers: [String: JSONValue]
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.respondToUserInput(
                threadID: threadID,
                requestID: requestID,
                answers: answers
            )
        )
    }

    @discardableResult
    public func settle(threadID: String, settled: Bool) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.settle(threadID: threadID, settled: settled))
    }

    @discardableResult
    public func snooze(threadID: String, until: Date?) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.snooze(threadID: threadID, until: until)
        )
    }

    @discardableResult
    public func pin(threadID: String, pinned: Bool) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.pin(threadID: threadID, pinned: pinned))
    }

    @discardableResult
    public func setRuntimeMode(
        threadID: String,
        mode: RuntimeMode
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.setRuntimeMode(threadID: threadID, mode: mode)
        )
    }

    @discardableResult
    public func setInteractionMode(
        threadID: String,
        mode: InteractionMode
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.setInteractionMode(threadID: threadID, mode: mode)
        )
    }

    // MARK: Workspace files

    public func listProjectEntries(cwd: String) async throws -> ProjectEntriesResult {
        try await rpc.request(
            RPCMethod.projectsListEntries.rawValue,
            payload: .object(["cwd": .string(cwd)]),
            as: ProjectEntriesResult.self
        )
    }

    public func searchProjectEntries(
        cwd: String,
        query: String,
        limit: Int = 100
    ) async throws -> ProjectEntriesResult {
        try await rpc.request(
            RPCMethod.projectsSearchEntries.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "query": .string(query),
                "limit": .number(Double(limit)),
            ]),
            as: ProjectEntriesResult.self
        )
    }

    public func readProjectFile(
        cwd: String,
        relativePath: String
    ) async throws -> ProjectReadFileResult {
        try await rpc.request(
            RPCMethod.projectsReadFile.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "relativePath": .string(relativePath),
            ]),
            as: ProjectReadFileResult.self
        )
    }

    public func writeProjectFile(
        cwd: String,
        relativePath: String,
        contents: String
    ) async throws -> ProjectWriteFileResult {
        try await rpc.request(
            RPCMethod.projectsWriteFile.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "relativePath": .string(relativePath),
                "contents": .string(contents),
            ]),
            as: ProjectWriteFileResult.self
        )
    }

    public func browseFilesystem(
        partialPath: String,
        cwd: String? = nil
    ) async throws -> FilesystemBrowseResult {
        var payload: [String: JSONValue] = ["partialPath": .string(partialPath)]
        if let cwd { payload["cwd"] = .string(cwd) }
        return try await rpc.request(
            RPCMethod.filesystemBrowse.rawValue,
            payload: .object(payload),
            as: FilesystemBrowseResult.self
        )
    }

    /// Issues a short-lived authenticated URL for a persisted attachment,
    /// workspace preview, or project favicon.
    public func createAssetURL(resource: AssetResource) async throws -> AssetCreateURLResult {
        try await rpc.request(
            RPCMethod.assetsCreateURL.rawValue,
            payload: .object(["resource": resource.jsonValue]),
            as: AssetCreateURLResult.self
        )
    }

    public func createAttachmentUploadURL(
        type: String? = nil,
        name: String,
        mimeType: String,
        sizeBytes: Int
    ) async throws -> AttachmentCreateUploadURLResult {
        var payload: [String: JSONValue] = [
            "name": .string(name),
            "mimeType": .string(mimeType),
            "sizeBytes": .number(Double(sizeBytes)),
        ]
        if let type { payload["type"] = .string(type) }
        return try await rpc.request(
            RPCMethod.attachmentsCreateUploadURL.rawValue,
            payload: .object(payload),
            as: AttachmentCreateUploadURLResult.self
        )
    }

    public func deleteAttachment(id: String) async throws {
        try await rpc.request(
            RPCMethod.attachmentsDelete.rawValue,
            payload: .object(["attachmentId": .string(id)])
        )
    }

    public func uploadFeedback(
        threadID: String,
        reason: String? = nil
    ) async throws -> ProviderUploadFeedbackResult {
        var payload: [String: JSONValue] = ["threadId": .string(threadID)]
        if let reason {
            payload["reason"] = .string(reason)
        }
        return try await rpc.request(
            RPCMethod.providerUploadFeedback.rawValue,
            payload: .object(payload),
            as: ProviderUploadFeedbackResult.self
        )
    }

    private func prepareTurnAttachments(
        _ attachments: [UploadChatImageAttachment]
    ) async throws -> [JSONValue]? {
        guard !attachments.isEmpty else { return nil }
        guard attachments.count <= 8 else { throw FileAttachmentError.tooMany(maximum: 8) }

        let capabilities = latestServerEnvironment?.capabilities
            ?? environment.descriptor?.capabilities
        let containsFiles = attachments.contains { $0.type == "file" }
        let supportsImageUploads = capabilities?.attachmentUploads == true
        let fileCapability = capabilities?.fileAttachments
        if containsFiles, !supportsImageUploads || fileCapability == nil {
            throw FileAttachmentError.unsupported
        }

        if let fileCapability {
            let maximumBytes = min(
                UploadChatAttachment.maximumFileBytes,
                max(0, fileCapability.maxUploadBytes)
            )
            for attachment in attachments where attachment.type == "file" {
                guard attachment.sizeBytes <= maximumBytes else {
                    throw FileAttachmentError.tooLarge(
                        actualBytes: attachment.sizeBytes,
                        maximumBytes: maximumBytes
                    )
                }
            }
        }
        guard containsFiles || supportsImageUploads else { return nil }

        var prepared: [JSONValue] = []
        for attachment in attachments {
            if let reference = try await prepareAttachment(attachment) {
                prepared.append(attachment.uploadedJSONValue(id: reference.attachmentID))
            } else {
                prepared.append(attachment.jsonValue)
            }
        }
        return prepared
    }

    /// Uploads one attachment for this environment. Older servers keep images
    /// inline, so a nil result means the caller must use the image data URL.
    public func prepareAttachment(
        _ attachment: UploadChatAttachment
    ) async throws -> UploadedAttachmentReference? {
        try Task.checkCancellation()
        let capabilities = latestServerEnvironment?.capabilities
            ?? environment.descriptor?.capabilities
        let supportsUploads = capabilities?.attachmentUploads == true
        if attachment.type == "file" {
            guard supportsUploads, let fileCapability = capabilities?.fileAttachments else {
                throw FileAttachmentError.unsupported
            }
            let maximumBytes = min(
                UploadChatAttachment.maximumFileBytes,
                max(0, fileCapability.maxUploadBytes)
            )
            guard attachment.sizeBytes <= maximumBytes else {
                throw FileAttachmentError.tooLarge(
                    actualBytes: attachment.sizeBytes,
                    maximumBytes: maximumBytes
                )
            }
        } else if !supportsUploads {
            return nil
        }

        if let reference = attachment.uploadedReference,
           reference.environmentID == environment.id,
           !reference.attachmentID.isEmpty {
            do {
                _ = try await createAssetURL(resource: .attachment(id: reference.attachmentID))
                try Task.checkCancellation()
                return reference
            } catch where Self.isAttachmentNotFound(error) {
                // The server expired the attachment. Upload the retained bytes again.
            }
        }

        let upload = try await createAttachmentUploadURL(
            type: attachment.type == "file" ? "file" : nil,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes
        )
        do {
            try Task.checkCancellation()
            guard let url = URL(
                string: upload.relativeUrl,
                relativeTo: environment.httpBaseURL
            )?.absoluteURL else {
                throw RPCError.protocolViolation("The attachment upload URL is invalid.")
            }
            switch attachment.source {
            case let .imageData(data):
                try await api.uploadAttachment(data, mimeType: attachment.mimeType, to: url)
            case let .file(fileURL):
                guard let actualBytes = try? fileURL.resourceValues(
                    forKeys: [.fileSizeKey, .isRegularFileKey]
                ),
                      actualBytes.isRegularFile == true,
                      actualBytes.fileSize == attachment.sizeBytes else {
                    throw FileAttachmentError.invalidFileURL
                }
                try await api.uploadAttachment(
                    fileURL: fileURL,
                    byteCount: attachment.sizeBytes,
                    mimeType: attachment.mimeType,
                    to: url
                )
            }
            try Task.checkCancellation()
            return UploadedAttachmentReference(
                environmentID: environment.id,
                attachmentID: upload.attachmentId
            )
        } catch {
            // Cleanup must not keep the composer in Uploading after the
            // transfer has failed, especially if the WebSocket is offline.
            Task { try? await self.deleteAttachment(id: upload.attachmentId) }
            throw error
        }
    }

    private static func isAttachmentNotFound(_ error: any Error) -> Bool {
        guard case let RPCError.remote(message) = error else { return false }
        let normalized = message.lowercased()
        return normalized.contains("attachment")
            && (normalized.contains("not found") || normalized.contains("does not exist"))
    }

    public func resolvedAssetURL(resource: AssetResource) async throws -> URL {
        try await resolvedAsset(resource: resource).url
    }

    public func resolvedAsset(resource: AssetResource) async throws -> ResolvedAssetURL {
        let result = try await createAssetURL(resource: resource)
        guard let url = URL(
            string: result.relativeUrl,
            relativeTo: environment.httpBaseURL
        )?.absoluteURL else {
            throw RPCError.protocolViolation("The server returned an invalid asset URL.")
        }
        return ResolvedAssetURL(
            url: url,
            expiresAt: Date(timeIntervalSince1970: result.expiresAt / 1_000)
        )
    }

    // MARK: VCS and source control

    public func refreshVCSStatus(cwd: String) async throws -> VCSStatus {
        try await rpc.request(
            RPCMethod.vcsRefreshStatus.rawValue,
            payload: .object(["cwd": .string(cwd)]),
            as: VCSStatus.self
        )
    }

    public func vcsStatusEvents(cwd: String) async
        -> AsyncThrowingStream<VCSStatusEvent, Error>
    {
        await rpc.subscribe(
            RPCMethod.subscribeVCSStatus.rawValue,
            payload: .object(["cwd": .string(cwd)]),
            as: VCSStatusEvent.self
        )
    }

    public func listVCSRefs(
        cwd: String,
        query: String? = nil,
        cursor: Int? = nil,
        kind: String? = nil,
        refresh: Bool = false,
        limit: Int = 100
    ) async throws -> VCSRefsResult {
        var payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "refresh": .bool(refresh),
            "limit": .number(Double(limit)),
        ]
        if let query { payload["query"] = .string(query) }
        if let cursor { payload["cursor"] = .number(Double(cursor)) }
        if let kind { payload["refKind"] = .string(kind) }
        return try await rpc.request(
            RPCMethod.vcsListRefs.rawValue,
            payload: .object(payload),
            as: VCSRefsResult.self
        )
    }

    public func pull(cwd: String) async throws -> VCSPullResult {
        try await rpc.request(
            RPCMethod.vcsPull.rawValue,
            payload: .object(["cwd": .string(cwd)]),
            as: VCSPullResult.self
        )
    }

    public func createVCSRef(
        cwd: String,
        name: String,
        switchToRef: Bool = true
    ) async throws -> VCSCreateRefResult {
        try await rpc.request(
            RPCMethod.vcsCreateRef.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "refName": .string(name),
                "switchRef": .bool(switchToRef),
            ]),
            as: VCSCreateRefResult.self
        )
    }

    public func switchVCSRef(cwd: String, name: String) async throws -> VCSSwitchRefResult {
        try await rpc.request(
            RPCMethod.vcsSwitchRef.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "refName": .string(name),
            ]),
            as: VCSSwitchRefResult.self
        )
    }

    public func createWorktree(
        cwd: String,
        refName: String,
        newRefName: String? = nil,
        baseRefName: String? = nil,
        path: String? = nil
    ) async throws -> VCSCreateWorktreeResult {
        var payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "refName": .string(refName),
            "path": path.map(JSONValue.string) ?? .null,
        ]
        if let newRefName { payload["newRefName"] = .string(newRefName) }
        if let baseRefName { payload["baseRefName"] = .string(baseRefName) }
        return try await rpc.request(
            RPCMethod.vcsCreateWorktree.rawValue,
            payload: .object(payload),
            as: VCSCreateWorktreeResult.self
        )
    }

    public func removeWorktree(cwd: String, path: String, force: Bool = false) async throws {
        try await rpc.request(
            RPCMethod.vcsRemoveWorktree.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "path": .string(path),
                "force": .bool(force),
            ])
        )
    }

    public func initializeVCS(cwd: String, kind: String? = nil) async throws {
        var payload: [String: JSONValue] = ["cwd": .string(cwd)]
        if let kind { payload["kind"] = .string(kind) }
        try await rpc.request(RPCMethod.vcsInitialize.rawValue, payload: .object(payload))
    }

    public func runGitAction(
        cwd: String,
        action: GitStackedAction,
        commitMessage: String? = nil,
        featureBranch: Bool? = nil,
        filePaths: [String]? = nil,
        actionID: String = UUID().uuidString
    ) async throws -> AsyncThrowingStream<GitActionProgressEvent, Error> {
        var payload: [String: JSONValue] = [
            "actionId": .string(actionID),
            "cwd": .string(cwd),
            "action": .string(action.rawValue),
        ]
        if let commitMessage { payload["commitMessage"] = .string(commitMessage) }
        if let featureBranch { payload["featureBranch"] = .bool(featureBranch) }
        if let filePaths { payload["filePaths"] = .array(filePaths.map(JSONValue.string)) }
        // A command stream must fail on disconnect instead of replaying a
        // potentially successful commit or push.
        return await rpc.subscribe(
            RPCMethod.gitRunStackedAction.rawValue,
            payload: .object(payload),
            reconnect: false,
            as: GitActionProgressEvent.self
        )
    }

    public func lookupRepository(
        provider: SourceControlProviderKind,
        repository: String,
        cwd: String? = nil
    ) async throws -> SourceControlRepositoryInfo {
        var payload: [String: JSONValue] = [
            "provider": .string(provider.rawValue),
            "repository": .string(repository),
        ]
        if let cwd { payload["cwd"] = .string(cwd) }
        return try await rpc.request(
            RPCMethod.sourceControlLookup.rawValue,
            payload: .object(payload),
            as: SourceControlRepositoryInfo.self
        )
    }

    public func discoverSourceControl() async throws -> SourceControlDiscoveryResult {
        try await rpc.request(
            RPCMethod.serverDiscoverSourceControl.rawValue,
            payload: .object([:]),
            as: SourceControlDiscoveryResult.self
        )
    }

    public func cloneRepository(
        provider: SourceControlProviderKind? = nil,
        repository: String? = nil,
        remoteURL: String? = nil,
        destinationPath: String,
        cloneProtocol: String? = nil
    ) async throws -> SourceControlCloneResult {
        var payload: [String: JSONValue] = ["destinationPath": .string(destinationPath)]
        if let provider { payload["provider"] = .string(provider.rawValue) }
        if let repository { payload["repository"] = .string(repository) }
        if let remoteURL { payload["remoteUrl"] = .string(remoteURL) }
        if let cloneProtocol { payload["protocol"] = .string(cloneProtocol) }
        return try await rpc.request(
            RPCMethod.sourceControlClone.rawValue,
            payload: .object(payload),
            as: SourceControlCloneResult.self
        )
    }

    public func publishRepository(
        cwd: String,
        provider: SourceControlProviderKind,
        repository: String,
        visibility: String,
        remoteName: String? = nil,
        cloneProtocol: String? = nil
    ) async throws -> SourceControlPublishResult {
        var payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "provider": .string(provider.rawValue),
            "repository": .string(repository),
            "visibility": .string(visibility),
        ]
        if let remoteName { payload["remoteName"] = .string(remoteName) }
        if let cloneProtocol { payload["protocol"] = .string(cloneProtocol) }
        return try await rpc.request(
            RPCMethod.sourceControlPublish.rawValue,
            payload: .object(payload),
            as: SourceControlPublishResult.self
        )
    }

    // MARK: Review

    public func reviewDiffPreview(
        cwd: String,
        baseRef: String? = nil,
        ignoreWhitespace: Bool = false
    ) async throws -> ReviewDiffPreview {
        var payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "ignoreWhitespace": .bool(ignoreWhitespace),
        ]
        if let baseRef { payload["baseRef"] = .string(baseRef) }
        return try await rpc.request(
            RPCMethod.reviewDiffPreview.rawValue,
            payload: .object(payload),
            as: ReviewDiffPreview.self
        )
    }

    public func reviewDiffFileContents(
        cwd: String,
        sourceKind: String,
        changeType: String,
        baseRef: String?,
        headRef: String?,
        oldPath: String,
        newPath: String
    ) async throws -> ReviewDiffFileContents {
        let payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "sourceKind": .string(sourceKind),
            "changeType": .string(changeType),
            "baseRef": baseRef.map(JSONValue.string) ?? .null,
            "headRef": headRef.map(JSONValue.string) ?? .null,
            "oldPath": .string(oldPath),
            "newPath": .string(newPath),
        ]
        return try await rpc.request(
            RPCMethod.reviewDiffFileContents.rawValue,
            payload: .object(payload),
            as: ReviewDiffFileContents.self
        )
    }

    // MARK: Terminal

    public func openTerminal(
        threadID: String,
        terminalID: String,
        cwd: String,
        worktreePath: String? = nil,
        columns: Int? = nil,
        rows: Int? = nil,
        environmentVariables: [String: String]? = nil
    ) async throws -> TerminalSessionSnapshot {
        let payload = try terminalPayload(
            threadID: threadID,
            terminalID: terminalID,
            cwd: cwd,
            worktreePath: worktreePath,
            columns: columns,
            rows: rows,
            environmentVariables: environmentVariables
        )
        return try await rpc.request(
            RPCMethod.terminalOpen.rawValue,
            payload: payload,
            as: TerminalSessionSnapshot.self
        )
    }

    public func attachTerminal(
        threadID: String,
        terminalID: String,
        cwd: String? = nil,
        worktreePath: String? = nil,
        columns: Int? = nil,
        rows: Int? = nil,
        environmentVariables: [String: String]? = nil,
        restartIfNotRunning: Bool = false
    ) async throws -> AsyncThrowingStream<TerminalEvent, Error> {
        var payload = try terminalPayloadObject(
            threadID: threadID,
            terminalID: terminalID,
            cwd: cwd,
            worktreePath: worktreePath,
            columns: columns,
            rows: rows,
            environmentVariables: environmentVariables
        )
        payload["restartIfNotRunning"] = .bool(restartIfNotRunning)
        return await rpc.subscribe(
            RPCMethod.terminalAttach.rawValue,
            payload: .object(payload),
            as: TerminalEvent.self
        )
    }

    public func terminalEvents() async -> AsyncThrowingStream<TerminalEvent, Error> {
        await rpc.subscribe(
            RPCMethod.subscribeTerminalEvents.rawValue,
            as: TerminalEvent.self
        )
    }

    public func terminalMetadataEvents() async
        -> AsyncThrowingStream<TerminalMetadataEvent, Error>
    {
        await rpc.subscribe(
            RPCMethod.subscribeTerminalMetadata.rawValue,
            as: TerminalMetadataEvent.self
        )
    }

    public func writeTerminal(
        threadID: String,
        terminalID: String,
        data: String
    ) async throws {
        try await rpc.request(
            RPCMethod.terminalWrite.rawValue,
            payload: .object([
                "threadId": .string(threadID),
                "terminalId": .string(terminalID),
                "data": .string(data),
            ])
        )
    }

    public func resizeTerminal(
        threadID: String,
        terminalID: String,
        columns: Int,
        rows: Int
    ) async throws {
        try await rpc.request(
            RPCMethod.terminalResize.rawValue,
            payload: .object([
                "threadId": .string(threadID),
                "terminalId": .string(terminalID),
                "cols": .number(Double(columns)),
                "rows": .number(Double(rows)),
            ])
        )
    }

    public func clearTerminal(threadID: String, terminalID: String) async throws {
        try await rpc.request(
            RPCMethod.terminalClear.rawValue,
            payload: terminalIdentity(threadID: threadID, terminalID: terminalID)
        )
    }

    public func restartTerminal(
        threadID: String,
        terminalID: String,
        cwd: String,
        worktreePath: String? = nil,
        columns: Int,
        rows: Int,
        environmentVariables: [String: String]? = nil
    ) async throws -> TerminalSessionSnapshot {
        let payload = try terminalPayload(
            threadID: threadID,
            terminalID: terminalID,
            cwd: cwd,
            worktreePath: worktreePath,
            columns: columns,
            rows: rows,
            environmentVariables: environmentVariables
        )
        return try await rpc.request(
            RPCMethod.terminalRestart.rawValue,
            payload: payload,
            as: TerminalSessionSnapshot.self
        )
    }

    public func closeTerminal(
        threadID: String,
        terminalID: String? = nil,
        deleteHistory: Bool = false
    ) async throws {
        var payload: [String: JSONValue] = [
            "threadId": .string(threadID),
            "deleteHistory": .bool(deleteHistory),
        ]
        if let terminalID { payload["terminalId"] = .string(terminalID) }
        try await rpc.request(RPCMethod.terminalClose.rawValue, payload: .object(payload))
    }

    private func terminalIdentity(threadID: String, terminalID: String) -> JSONValue {
        .object([
            "threadId": .string(threadID),
            "terminalId": .string(terminalID),
        ])
    }

    private func terminalPayload(
        threadID: String,
        terminalID: String,
        cwd: String?,
        worktreePath: String?,
        columns: Int?,
        rows: Int?,
        environmentVariables: [String: String]?
    ) throws -> JSONValue {
        .object(
            try terminalPayloadObject(
                threadID: threadID,
                terminalID: terminalID,
                cwd: cwd,
                worktreePath: worktreePath,
                columns: columns,
                rows: rows,
                environmentVariables: environmentVariables
            )
        )
    }

    private func terminalPayloadObject(
        threadID: String,
        terminalID: String,
        cwd: String?,
        worktreePath: String?,
        columns: Int?,
        rows: Int?,
        environmentVariables: [String: String]?
    ) throws -> [String: JSONValue] {
        var payload: [String: JSONValue] = [
            "threadId": .string(threadID),
            "terminalId": .string(terminalID),
        ]
        if let cwd { payload["cwd"] = .string(cwd) }
        if let worktreePath {
            payload["worktreePath"] = .string(worktreePath)
        } else if cwd != nil {
            payload["worktreePath"] = .null
        }
        if let columns { payload["cols"] = .number(Double(columns)) }
        if let rows { payload["rows"] = .number(Double(rows)) }
        if let environmentVariables {
            payload["env"] = try JSONValue.encode(environmentVariables)
        }
        return payload
    }
}

/// Owns persisted environment selection and constructs scoped clients without
/// introducing UI-framework state into Core.
public struct EnvironmentPersistenceError: LocalizedError, Sendable {
    public let operationError: String
    public let rollbackErrors: [String]

    public var errorDescription: String? {
        "\(operationError) Recovery also failed: \(rollbackErrors.joined(separator: "; "))"
    }
}

public actor EnvironmentRuntime {
    public let environmentStore: EnvironmentStore
    public let credentialStore: any CredentialStore
    public nonisolated let supportsManagedAuthorization: Bool
    private let httpTransport: any HTTPTransport
    private let webSocketConnector: any WebSocketConnecting
    private let managedAuthorization: (any ManagedEnvironmentAuthorizing)?
    private let rpcConnectionWaitTimeout: Duration
    private var clients: [String: T3Client] = [:]

    public init(
        environmentStore: EnvironmentStore = EnvironmentStore(),
        credentialStore: any CredentialStore = KeychainCredentialStore(),
        httpTransport: any HTTPTransport = URLSessionHTTPTransport(),
        webSocketConnector: any WebSocketConnecting = URLSessionWebSocketConnector(),
        managedAuthorization: (any ManagedEnvironmentAuthorizing)? = nil,
        rpcConnectionWaitTimeout: Duration = .seconds(4)
    ) {
        self.environmentStore = environmentStore
        self.credentialStore = credentialStore
        self.httpTransport = httpTransport
        self.webSocketConnector = webSocketConnector
        self.managedAuthorization = managedAuthorization
        self.rpcConnectionWaitTimeout = rpcConnectionWaitTimeout
        supportsManagedAuthorization = managedAuthorization != nil
    }

    public func environments() async throws -> [Environment] {
        try await environmentStore.load()
    }

    public func activeEnvironment() async throws -> Environment? {
        let environments = try await environmentStore.load()
        let enabled = environments.filter(\.isEnabled)
        guard !enabled.isEmpty else { return nil }
        let activeID = try await environmentStore.activeEnvironmentID()
        return enabled.first(where: { $0.id == activeID }) ?? enabled[0]
    }

    @discardableResult
    public func activate(id: String) async throws -> T3Client {
        let environments = try await environmentStore.load()
        guard let environment = environments.first(where: { $0.id == id }) else {
            throw RPCError.remote("Environment \(id) is not saved.")
        }
        guard environment.isEnabled else {
            throw RPCError.remote("Environment \(id) is disabled.")
        }
        try await environmentStore.setActiveEnvironment(id: id)
        return await client(for: environment)
    }

    public func setEnabled(id: String, enabled: Bool) async throws {
        let environments = try await environmentStore.setEnabled(id: id, enabled: enabled)
        guard environments.contains(where: { $0.id == id }) else {
            throw RPCError.remote("Environment \(id) is not saved.")
        }
        if !enabled, let client = clients[id] {
            await client.disconnect()
        }
    }

    public func activeClient() async throws -> T3Client? {
        guard let environment = try await activeEnvironment() else { return nil }
        return await client(for: environment)
    }

    @discardableResult
    public func pair(url: String, clientLabel: String? = nil) async throws -> T3Client {
        let service = PairingService(
            transport: httpTransport,
            environmentStore: environmentStore,
            credentialStore: credentialStore
        )
        let environment = try await service.pair(url: url, label: clientLabel)
        try await environmentStore.setActiveEnvironment(id: environment.id)
        return await client(for: environment)
    }

    @discardableResult
    public func pair(
        host: String,
        code: String,
        clientLabel: String? = nil
    ) async throws -> T3Client {
        let service = PairingService(
            transport: httpTransport,
            environmentStore: environmentStore,
            credentialStore: credentialStore
        )
        let environment = try await service.pair(host: host, code: code, label: clientLabel)
        try await environmentStore.setActiveEnvironment(id: environment.id)
        return await client(for: environment)
    }

    public func descriptor(at httpBaseURL: URL) async throws -> EnvironmentDescriptor {
        let api = EnvironmentAPI(transport: httpTransport, credentials: credentialStore)
        return try await api.descriptor(at: httpBaseURL)
    }

    /// Persists a fully validated managed environment. Both the environment
    /// metadata and the tagged DPoP credential must agree before either can
    /// replace an existing manual connection with the same server identity.
    @discardableResult
    public func saveManagedEnvironment(
        _ environment: Environment,
        credential: EnvironmentCredential
    ) async throws -> T3Client {
        guard environment.kind == .managedDPoP,
              environment.descriptor?.environmentId == environment.id,
              credential.authorizationMethod == .dpop,
              credential.managedEnvironmentID == environment.id,
              credential.proofKeyThumbprint?.isEmpty == false else {
            throw HTTPError.incompatibleCredential
        }

        let previousEnvironment = try await environmentStore.load()
            .first(where: { $0.id == environment.id })
        let previousActiveID = try await environmentStore.activeEnvironmentID()
        let previousCredential = try await credentialStore.swapCredential(
            credential,
            for: environment.id
        )
        do {
            try await environmentStore.upsert(environment)
            try await environmentStore.setActiveEnvironment(id: environment.id)
        } catch {
            let operationError = error
            var rollbackErrors: [String] = []
            do {
                if let previousCredential {
                    _ = try await credentialStore.replaceCredential(
                        previousCredential,
                        ifMatching: credential,
                        for: environment.id
                    )
                } else {
                    _ = try await credentialStore.removeCredential(
                        ifMatching: credential,
                        for: environment.id
                    )
                }
            } catch {
                rollbackErrors.append("credential: \(error.localizedDescription)")
            }
            // EnvironmentStore's individual mutations are actor-atomic. Undo
            // only this record so a concurrent save for another environment
            // cannot be lost while this actor is reentrant across awaits.
            do {
                if let previousEnvironment {
                    _ = try await environmentStore.upsert(previousEnvironment)
                } else {
                    _ = try await environmentStore.remove(id: environment.id)
                }
            } catch {
                rollbackErrors.append("environment catalog: \(error.localizedDescription)")
            }
            do {
                let activeIDAfterFailure = try await environmentStore.activeEnvironmentID()
                if activeIDAfterFailure == environment.id {
                    try await environmentStore.setActiveEnvironment(id: previousActiveID)
                }
            } catch {
                rollbackErrors.append("active environment: \(error.localizedDescription)")
            }
            guard rollbackErrors.isEmpty else {
                throw EnvironmentPersistenceError(
                    operationError: operationError.localizedDescription,
                    rollbackErrors: rollbackErrors
                )
            }
            throw operationError
        }
        return await client(for: environment)
    }

    public func remove(id: String) async throws {
        let previousEnvironment = try await environmentStore.load()
            .first(where: { $0.id == id })
        let previousActiveID = try await environmentStore.activeEnvironmentID()
        // Never leave a catalog entry pointing at a credential that was
        // already destroyed when the catalog write itself fails.
        try await environmentStore.remove(id: id)
        do {
            try await credentialStore.removeCredential(for: id)
        } catch {
            let operationError = error
            var rollbackErrors: [String] = []
            if let previousEnvironment {
                do {
                    _ = try await environmentStore.upsert(previousEnvironment)
                } catch {
                    rollbackErrors.append("environment catalog: \(error.localizedDescription)")
                }
            }
            do {
                try await environmentStore.setActiveEnvironment(id: previousActiveID)
            } catch {
                rollbackErrors.append("active environment: \(error.localizedDescription)")
            }
            guard rollbackErrors.isEmpty else {
                throw EnvironmentPersistenceError(
                    operationError: operationError.localizedDescription,
                    rollbackErrors: rollbackErrors
                )
            }
            throw operationError
        }
        if let client = clients.removeValue(forKey: id) {
            await client.disconnect()
        }
    }

    /// Revokes local access before best-effort catalog cleanup. Account
    /// sign-out uses this so a failed file write cannot leave a managed DPoP
    /// credential usable.
    public func revokeCredential(id: String) async throws {
        try await credentialStore.removeCredential(for: id)
        if let client = clients.removeValue(forKey: id) {
            await client.disconnect()
        }
    }

    /// Returns the cached client for a saved environment without changing the
    /// environment used for new projects and threads.
    public func client(for environment: Environment) async -> T3Client {
        if let existing = clients[environment.id] {
            if existing.environment == environment {
                return existing
            }
            // Publish the replacement before disconnecting the stale client.
            // Actor methods are reentrant across that await; removing first
            // allowed a concurrent caller to construct a second replacement.
            let replacement = T3Client(
                environment: environment,
                credentialStore: credentialStore,
                httpTransport: httpTransport,
                webSocketConnector: webSocketConnector,
                managedAuthorization: managedAuthorization,
                rpcConnectionWaitTimeout: rpcConnectionWaitTimeout
            )
            clients[environment.id] = replacement
            Task { await existing.disconnect() }
            return replacement
        }
        let client = T3Client(
            environment: environment,
            credentialStore: credentialStore,
            httpTransport: httpTransport,
            webSocketConnector: webSocketConnector,
            managedAuthorization: managedAuthorization,
            rpcConnectionWaitTimeout: rpcConnectionWaitTimeout
        )
        clients[environment.id] = client
        return client
    }

    /// Creates an uncached client for bounded one-shot WebSocket RPCs. Passive
    /// environment probes must not stop or mutate the shared client if that
    /// environment becomes active while the probe is in flight.
    public func ephemeralClient(for environment: Environment) -> T3Client {
        T3Client(
            environment: environment,
            credentialStore: credentialStore,
            httpTransport: httpTransport,
            webSocketConnector: webSocketConnector,
            managedAuthorization: managedAuthorization,
            rpcConnectionWaitTimeout: rpcConnectionWaitTimeout
        )
    }
}

public enum RPCMethod: String, Sendable {
    case serverProbe = "server.probe"
    case serverGetConfig = "server.getConfig"
    case serverRefreshProviders = "server.refreshProviders"
    case serverUpdateSettings = "server.updateSettings"
    case serverGetUsageSummary = "server.getUsageSummary"
    case pullRequestsList = "pullRequests.list"
    case pullRequestsDetail = "pullRequests.detail"
    case pullRequestsActivity = "pullRequests.activity"
    case pullRequestsRunAction = "pullRequests.runAction"
    case pullRequestsUpdate = "pullRequests.update"
    case pullRequestsComment = "pullRequests.comment"
    case pullRequestsUpdateComment = "pullRequests.updateComment"
    case pullRequestsSubmitReview = "pullRequests.submitReview"
    case pullRequestsReplyToThread = "pullRequests.replyToThread"
    case pullRequestsSetThreadResolution = "pullRequests.setThreadResolution"
    case pullRequestsSetReaction = "pullRequests.setReaction"
    case pullRequestsInvalidate = "pullRequests.invalidate"
    case pullRequestsReviewerCandidates = "pullRequests.reviewerCandidates"
    case pullRequestsRequestReviewers = "pullRequests.requestReviewers"
    case dispatchCommand = "orchestration.dispatchCommand"
    case getArchivedShellSnapshot = "orchestration.getArchivedShellSnapshot"
    case subscribeShell = "orchestration.subscribeShell"
    case subscribeThread = "orchestration.subscribeThread"
    case projectsListEntries = "projects.listEntries"
    case projectsSearchEntries = "projects.searchEntries"
    case projectsReadFile = "projects.readFile"
    case projectsWriteFile = "projects.writeFile"
    case filesystemBrowse = "filesystem.browse"
    case assetsCreateURL = "assets.createUrl"
    case attachmentsCreateUploadURL = "attachments.createUploadUrl"
    case attachmentsDelete = "attachments.delete"
    case providerUploadFeedback = "provider.uploadFeedback"
    case providerConsumeResetCredit = "provider.consumeResetCredit"
    case subscribeServerConfig
    case serverDiscoverSourceControl = "server.discoverSourceControl"
    case subscribeVCSStatus = "subscribeVcsStatus"
    case vcsPull = "vcs.pull"
    case vcsRefreshStatus = "vcs.refreshStatus"
    case vcsListRefs = "vcs.listRefs"
    case vcsCreateRef = "vcs.createRef"
    case vcsSwitchRef = "vcs.switchRef"
    case vcsCreateWorktree = "vcs.createWorktree"
    case vcsRemoveWorktree = "vcs.removeWorktree"
    case vcsInitialize = "vcs.init"
    case gitRunStackedAction = "git.runStackedAction"
    case sourceControlLookup = "sourceControl.lookupRepository"
    case sourceControlClone = "sourceControl.cloneRepository"
    case sourceControlPublish = "sourceControl.publishRepository"
    case reviewDiffPreview = "review.getDiffPreview"
    case reviewDiffFileContents = "review.getDiffFileContents"
    case terminalOpen = "terminal.open"
    case terminalAttach = "terminal.attach"
    case terminalWrite = "terminal.write"
    case terminalResize = "terminal.resize"
    case terminalClear = "terminal.clear"
    case terminalRestart = "terminal.restart"
    case terminalClose = "terminal.close"
    case subscribeTerminalEvents
    case subscribeTerminalMetadata
}

public enum OrchestrationCommands {
    public static func createThread(
        threadID: String = UUID().uuidString,
        projectID: String,
        title: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        branch: String? = nil,
        worktreePath: String? = nil,
        commandID: String = UUID().uuidString,
        createdAt: String = now()
    ) throws -> JSONValue {
        .object([
            "type": .string("thread.create"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "projectId": .string(projectID),
            "title": .string(title),
            "modelSelection": try .encode(model),
            "runtimeMode": .string(runtimeMode.rawValue),
            "interactionMode": .string(interactionMode.rawValue),
            "branch": branch.map(JSONValue.string) ?? .null,
            "worktreePath": worktreePath.map(JSONValue.string) ?? .null,
            "createdAt": .string(createdAt),
        ])
    }

    public static func createProject(
        projectID: String = UUID().uuidString,
        title: String,
        workspaceRoot: String,
        defaultModel: ModelSelection? = nil,
        createWorkspaceRootIfMissing: Bool = false,
        commandID: String = UUID().uuidString,
        createdAt: String = now()
    ) throws -> JSONValue {
        var value: [String: JSONValue] = [
            "type": .string("project.create"),
            "commandId": .string(commandID),
            "projectId": .string(projectID),
            "title": .string(title),
            "workspaceRoot": .string(workspaceRoot),
            "createWorkspaceRootIfMissing": .bool(createWorkspaceRootIfMissing),
            "createdAt": .string(createdAt),
        ]
        if let defaultModel {
            value["defaultModelSelection"] = try JSONValue.encode(defaultModel)
        } else {
            value["defaultModelSelection"] = .null
        }
        return .object(value)
    }

    public static func sendTurn(
        threadID: String,
        text: String,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        model: ModelSelection? = nil,
        attachments: [UploadChatImageAttachment] = [],
        uploadedAttachments: [JSONValue]? = nil,
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString,
        createdAt: String = now()
    ) throws -> JSONValue {
        var command: [String: JSONValue] = [
            "type": .string("thread.turn.start"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "message": .object([
                "messageId": .string(messageID),
                "role": .string("user"),
                "text": .string(text),
                "attachments": .array(uploadedAttachments ?? attachments.map(\.jsonValue)),
            ]),
            "runtimeMode": .string(runtimeMode.rawValue),
            "interactionMode": .string(interactionMode.rawValue),
            "createdAt": .string(createdAt),
        ]
        if let model {
            command["modelSelection"] = try .encode(model)
        }
        return .object(command)
    }

    public static func createThreadAndSend(
        threadID: String = UUID().uuidString,
        projectID: String,
        title: String,
        text: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        branch: String? = nil,
        worktreePath: String? = nil,
        worktreePreparation: ThreadWorktreePreparation? = nil,
        attachments: [UploadChatImageAttachment] = [],
        uploadedAttachments: [JSONValue]? = nil,
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString,
        createdAt: String = now()
    ) throws -> JSONValue {
        var create: [String: JSONValue] = [
            "projectId": .string(projectID),
            "title": .string(title),
            "modelSelection": try .encode(model),
            "runtimeMode": .string(runtimeMode.rawValue),
            "interactionMode": .string(interactionMode.rawValue),
            "branch": branch.map(JSONValue.string) ?? .null,
            "worktreePath": worktreePath.map(JSONValue.string) ?? .null,
            "createdAt": .string(createdAt),
        ]
        create["createdAt"] = .string(createdAt)
        var bootstrap: [String: JSONValue] = ["createThread": .object(create)]
        if let worktreePreparation {
            var prepareWorktree: [String: JSONValue] = [
                "projectCwd": .string(worktreePreparation.projectCwd),
                "baseBranch": .string(worktreePreparation.baseBranch),
                "branch": .string(worktreePreparation.branch),
            ]
            if worktreePreparation.startFromOrigin {
                prepareWorktree["startFromOrigin"] = .bool(true)
            }
            bootstrap["prepareWorktree"] = .object(prepareWorktree)
            bootstrap["runSetupScript"] = .bool(true)
        }
        return .object([
            "type": .string("thread.turn.start"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "message": .object([
                "messageId": .string(messageID),
                "role": .string("user"),
                "text": .string(text),
                "attachments": .array(uploadedAttachments ?? attachments.map(\.jsonValue)),
            ]),
            "modelSelection": try .encode(model),
            "titleSeed": .string(title),
            "runtimeMode": .string(runtimeMode.rawValue),
            "interactionMode": .string(interactionMode.rawValue),
            "bootstrap": .object(bootstrap),
            "createdAt": .string(createdAt),
        ])
    }

    public static func archive(
        threadID: String,
        archived: Bool,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        basic(
            type: archived ? "thread.archive" : "thread.unarchive",
            threadID: threadID,
            commandID: commandID
        )
    }

    public static func deleteThread(
        threadID: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        basic(type: "thread.delete", threadID: threadID, commandID: commandID)
    }

    public static func rename(
        threadID: String,
        title: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("thread.meta.update"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "title": .string(title),
        ])
    }

    public static func regenerateTitle(
        threadID: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("thread.meta.update"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "regenerateTitle": .bool(true),
        ])
    }

    public static func interrupt(
        threadID: String,
        turnID: String?,
        commandID: String = UUID().uuidString,
        createdAt: String = now()
    ) -> JSONValue {
        var value: [String: JSONValue] = [
            "type": .string("thread.turn.interrupt"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "createdAt": .string(createdAt),
        ]
        if let turnID { value["turnId"] = .string(turnID) }
        return .object(value)
    }

    public static func respondToApproval(
        threadID: String,
        requestID: String,
        decision: String,
        commandID: String = UUID().uuidString,
        createdAt: String = now()
    ) -> JSONValue {
        .object([
            "type": .string("thread.approval.respond"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "requestId": .string(requestID),
            "decision": .string(decision),
            "createdAt": .string(createdAt),
        ])
    }

    public static func respondToUserInput(
        threadID: String,
        requestID: String,
        answers: [String: JSONValue],
        commandID: String = UUID().uuidString,
        createdAt: String = now()
    ) -> JSONValue {
        .object([
            "type": .string("thread.user-input.respond"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "requestId": .string(requestID),
            "answers": .object(answers),
            "createdAt": .string(createdAt),
        ])
    }

    public static func settle(
        threadID: String,
        settled: Bool,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        var value = basic(
            type: settled ? "thread.settle" : "thread.unsettle",
            threadID: threadID,
            commandID: commandID
        )
        if !settled, case var .object(object) = value {
            object["reason"] = .string("user")
            value = .object(object)
        }
        return value
    }

    public static func snooze(
        threadID: String,
        until: Date?,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        if let until {
            return .object([
                "type": .string("thread.snooze"),
                "commandId": .string(commandID),
                "threadId": .string(threadID),
                "snoozedUntil": .string(iso8601.format(until)),
            ])
        }
        return .object([
            "type": .string("thread.unsnooze"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "reason": .string("user"),
        ])
    }

    public static func pin(
        threadID: String,
        pinned: Bool,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        basic(
            type: pinned ? "thread.pin" : "thread.unpin",
            threadID: threadID,
            commandID: commandID
        )
    }

    public static func setRuntimeMode(
        threadID: String,
        mode: RuntimeMode,
        commandID: String = UUID().uuidString,
        createdAt: String = now()
    ) -> JSONValue {
        .object([
            "type": .string("thread.runtime-mode.set"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "runtimeMode": .string(mode.rawValue),
            "createdAt": .string(createdAt),
        ])
    }

    public static func setInteractionMode(
        threadID: String,
        mode: InteractionMode,
        commandID: String = UUID().uuidString,
        createdAt: String = now()
    ) -> JSONValue {
        .object([
            "type": .string("thread.interaction-mode.set"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "interactionMode": .string(mode.rawValue),
            "createdAt": .string(createdAt),
        ])
    }

    private static func basic(type: String, threadID: String, commandID: String) -> JSONValue {
        .object([
            "type": .string(type),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
        ])
    }

    public static func now() -> String {
        iso8601.format(Date())
    }

    /// Commands are built on several actors, so their shared formatter must be Sendable.
    private static let iso8601 = Date.ISO8601FormatStyle()
}
