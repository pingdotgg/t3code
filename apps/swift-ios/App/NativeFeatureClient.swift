import Foundation
import OSLog

extension FeatureInputAnswer {
    var jsonValue: JSONValue {
        switch self {
        case let .text(value):
            .string(value)
        case let .selections(values):
            .array(values.map(JSONValue.string))
        }
    }
}

/// Composes the transport-focused Core layer with the UI-focused Features layer.
@MainActor
final class NativeFeatureClient: FeatureClient, FeatureDeviceManaging,
    FeatureProjectCreationClient, FeatureWorkspaceAssetResolving, FeatureAttachmentAssetResolving,
    FeatureFeedbackSubmitting, FeatureContextAttachmentResolving, T3ConnectCapable, FeatureThreadQueueManaging,
    FeatureMessageDeliveryManaging, FeatureThreadUsageLimitsProviding, FeatureThreadNavigating, FeatureClientStorageManaging
{
    private static let maximumRetainedThreadDetails = 6
    private static let t3ConnectLogger = Logger(
        subsystem: "codes.t3.swift-ios",
        category: "T3Connect"
    )
    private static let initialThreadUserTurnLimit = 10
    private static let olderThreadPageUserTurnLimit = 20
    private static let projectFaviconFallbackMarker = "project-favicon-missing"
    private static let sourceControlStatusStreamTimeoutSeconds: TimeInterval = 30

    private let runtime: EnvironmentRuntime
    let t3ConnectController: T3ConnectController
    private let t3ConnectDeviceManager: any T3ConnectDeviceManaging
    private let hasMatchingT3ConnectController: Bool
    private let settingsStore: UserDefaults
    private static let gitHubRoutingKey = "swift-ios.github-routing.v1"
    private var routedPullRequests: [FeaturePullRequestTarget: Set<String>] = [:]
    private var cachedSettings: FeatureSettings?
    private let clientReadCache: ClientReadCache
    private var readCacheLeases: [String: ClientReadCache.Lease] = [:]
    private var readCacheEpoch = 0
    private var revokedCacheEnvironmentIDs: Set<String> = []
    private var restoredShellEnvironmentIDs: Set<String> = []
    private var restoredDetailIDs: Set<String> = []
    private var expandedHistoryIDs: Set<String> = []
    private var cacheStartupRefreshTask: Task<Void, Never>?
    private var cacheWriteTask: Task<Void, Never>?
    private let projectFaviconStore: FeatureProjectFaviconStore
    private let fallbackPollingInitialDelay: Duration
    private let fallbackPollingInterval: Duration
    private let aggregateRefreshInterval: Duration
    private let aggregateIdleRefreshInterval: Duration
    private let aggregateFailureRefreshInterval: Duration
    private let aggregateRefreshSleep: @Sendable (Duration) async throws -> Void
    private let environmentShellTimeoutInterval: TimeInterval
    private let threadSnapshotTimeoutInterval: TimeInterval
    private let catchUpDelay: @Sendable () async throws -> Void
    private let threadRetryDelay: @Sendable (Int) async throws -> Void
    private let aggregateEnvironmentLoader: @Sendable (EnvironmentRuntime) async throws -> [Environment]
    private let stream: AsyncStream<FeatureEvent>
    private let continuation: AsyncStream<FeatureEvent>.Continuation

    private var activeEnvironment: Environment?
    private var client: T3Client?
    private var latestShell: OrchestrationShellSnapshot?
    private var environmentClients: [String: T3Client] = [:]
    private var orchestrationVersions: [String: Int] = [:]
    private var orchestrationPreferenceGenerations: [String: Int] = [:]
    private var shellsByEnvironmentID: [String: OrchestrationShellSnapshot] = [:]
    private var shellProjectionCache: [String: NativeShellProjection] = [:]
    private var indexedShellMembership: [NativeShellMembership]?
    private var indexedProvisionalRoutes: [String: ProvisionalThreadRoute] = [:]
    private var archivedThreadsByEnvironmentID: [String: [FeatureThread]] = [:]
    private var archivedShellThreadsByEnvironmentID: [
        String: [String: OrchestrationThreadShell]
    ] = [:]
    private var projectEnvironmentIDs: [String: String] = [:]
    private var projectWireIDs: [String: String] = [:]
    private var threadEnvironmentIDs: [String: String] = [:]
    private var threadWireIDs: [String: String] = [:]
    private var provisionalThreadRoutes: [String: ProvisionalThreadRoute] = [:]
    private var pendingThreadCreations: [PendingThreadCreation] = []
    private var environmentConnectionStates: [String: FeatureConnection.State] = [:]
    private var environmentConnectionDetails: [String: String] = [:]
    private var environmentPermissions: [String: EnvironmentPermissionState] = [:]
    private var workspaceProviderFreshness = FeatureWorkspaceProviderFreshness()
    private var latestServerConfig: ServerConfigSnapshot?
    private var serverConfigsByEnvironmentID: [String: ServerConfigSnapshot] = [:]
    private var latestSnapshot: FeatureSnapshot?
    /// One reorder at a time: a second move planned from the same keys would
    /// land a conflicting write (React Native holds a pending order for this).
    private var threadMoveInFlight = false
    private var activeThreadID: String?
    private var activeThreadEnvironmentID: String?
    private var latestDetails: [String: FeatureThreadDetail] = [:]
    private var threadResumeStates: [String: NativeThreadResumeState] = [:]
    private var detailRenderCaches: [String: NativeDetailRenderCache] = [:]
    private var detailCacheRecency: [String] = []
    private var attachmentURLs: [AttachmentCacheKey: CachedAttachmentURL] = [:]
    private var projectFaviconRefreshTasks: [
        FeatureProjectFaviconCacheKey: Task<Data?, Never>
    ] = [:]
    private var sourceControlMonitors: [
        NativeSourceControlMonitorKey: NativeSourceControlMonitor
    ] = [:]
    private var pendingBootstrapSubmissions: [PendingBootstrapSubmission] = []
    private var pendingTurnSubmissions: [String: PendingTurnSubmission] = [:]
    private var projectSettingsWriteTask: Task<Void, Error>?
    private var projectSettingsWriteGeneration: UInt64 = 0
    private var approvalRoutes: [String: PendingRequestRoute] = [:]
    private var inputRoutes: [String: PendingRequestRoute] = [:]
    private var relayDeviceSessionIDs: Set<String> = []
    private struct TerminalKey: Hashable {
        let threadID: String
        let terminalID: String
    }

    private var terminalSnapshots: [TerminalKey: FeatureTerminalSnapshot] = [:]
    // Keep versions unique when a terminal cache is evicted or an environment reconnects.
    private var terminalLifecycleVersion = 0
    private var pollingTask: Task<Void, Never>?
    private var fallbackPollingTask: Task<Void, Never>?
    private var configurationTask: Task<Void, Never>?
    private var aggregateRefreshTask: Task<Void, Never>?
    private var aggregateRefreshID: UUID?
    private var shellPublishTask: Task<Void, Never>?
    private var archivedRefreshTask: Task<Void, Never>?
    private var detailRefreshTask: Task<Void, Never>?
    private var detailStreamTask: Task<Void, Never>?
    private var detailCatchUpTask: Task<Void, Never>?
    private var detailCatchUpID: UUID?
    private var detailCompletionReceived = false
    private var detailWasSynchronized = false
    private var activeDetailConnectionID: UUID?
    private var detailPublishTask: Task<Void, Never>?
    private var detailRefreshPending = false
    private var detailRefreshGeneration = 0
    private var detailStreamGeneration = 0
    private var pendingDetailRenderMutations = NativeDetailRenderMutations()
    private var routeSnapshotLoads = 0
    private var routeRecoveryAttempts: [String: Date] = [:]
    private var routeRecoveryRejected: [String: Bool] = [:]
    private var environmentGeneration = 0
    private var lastShellEventAt: Date?
    private var activeRawThread: OrchestrationThread?
    private var activeThreadSequence: Int?
    private var activeThreadPage: FeatureThreadPage?
    private var threadHistoryEpoch = 0
    private var detailSnapshotRequiredAfterEpoch: Int?
    private var pendingOlderThreadPage: PendingOlderThreadPage?

    nonisolated static let defaultAggregateRefreshInterval: Duration = .seconds(5)
    nonisolated static let defaultAggregateIdleRefreshInterval: Duration = .seconds(10)
    nonisolated static let defaultAggregateFailureRefreshInterval: Duration = .seconds(20)

    init(
        runtime: EnvironmentRuntime? = nil,
        t3ConnectController: T3ConnectController? = nil,
        t3ConnectDeviceManager: (any T3ConnectDeviceManaging)? = nil,
        settingsStore: UserDefaults = .standard,
        projectFaviconStore: FeatureProjectFaviconStore? = nil,
        clientReadCache: ClientReadCache? = nil,
        fallbackPollingInitialDelay: Duration = .seconds(3),
        fallbackPollingInterval: Duration = .seconds(2),
        aggregateRefreshInterval: Duration = NativeFeatureClient.defaultAggregateRefreshInterval,
        aggregateIdleRefreshInterval: Duration = NativeFeatureClient.defaultAggregateIdleRefreshInterval,
        aggregateFailureRefreshInterval: Duration = NativeFeatureClient.defaultAggregateFailureRefreshInterval,
        aggregateRefreshSleep: @escaping @Sendable (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        },
        environmentShellTimeoutInterval: TimeInterval = 6,
        threadSnapshotTimeoutInterval: TimeInterval = 8,
        catchUpDelay: @escaping @Sendable () async throws -> Void = {
            try await Task.sleep(for: .seconds(2))
        },
        threadRetryDelay: @escaping @Sendable (Int) async throws -> Void = { attempt in
            try await Task.sleep(for: .seconds(min(5, 0.25 * pow(2, Double(min(5, attempt - 1))))))
        },
        aggregateEnvironmentLoader: @escaping @Sendable (EnvironmentRuntime) async throws -> [Environment] = {
            try await $0.environments()
        }
    ) {
        let controller: T3ConnectController
        if let t3ConnectController {
            controller = t3ConnectController
        } else if let runtime {
            controller = T3ConnectController(
                resolution: .unavailable(
                    reason: runtime.supportsManagedAuthorization
                        ? "This client runtime requires its matching T3 Connect controller."
                        : "This client runtime was created without T3 Connect authorization."
                )
            )
        } else {
            controller = T3ConnectController()
        }
        self.t3ConnectController = controller
        self.t3ConnectDeviceManager = t3ConnectDeviceManager ?? controller
        hasMatchingT3ConnectController = t3ConnectController != nil || runtime == nil
        self.runtime = runtime ?? EnvironmentRuntime(
            managedAuthorization: T3ConnectRuntimeAuthorization(controller: controller)
        )
        self.settingsStore = settingsStore
        let catalogURL = self.runtime.environmentStore.fileURL
        let storageRoot = catalogURL.deletingLastPathComponent()
        self.projectFaviconStore = projectFaviconStore ?? FeatureProjectFaviconStore.shared(
            directoryURL: storageRoot.appendingPathComponent("project-favicons", isDirectory: true)
        )
        self.clientReadCache = clientReadCache ?? ClientReadCache.shared(
            directoryURL: storageRoot.appendingPathComponent(
                "client-reads-" + ClientReadCache.Scope.fingerprint(catalogURL.lastPathComponent), isDirectory: true
            )
        )
        self.fallbackPollingInitialDelay = fallbackPollingInitialDelay
        self.fallbackPollingInterval = fallbackPollingInterval
        self.aggregateRefreshInterval = aggregateRefreshInterval
        self.aggregateIdleRefreshInterval = aggregateIdleRefreshInterval
        self.aggregateFailureRefreshInterval = aggregateFailureRefreshInterval
        self.aggregateRefreshSleep = aggregateRefreshSleep
        self.environmentShellTimeoutInterval = environmentShellTimeoutInterval
        self.threadSnapshotTimeoutInterval = threadSnapshotTimeoutInterval
        self.catchUpDelay = catchUpDelay
        self.threadRetryDelay = threadRetryDelay
        self.aggregateEnvironmentLoader = aggregateEnvironmentLoader
        let pair = AsyncStream<FeatureEvent>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
    }

    deinit {
        cacheStartupRefreshTask?.cancel()
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        aggregateRefreshTask?.cancel()
        shellPublishTask?.cancel()
        archivedRefreshTask?.cancel()
        detailRefreshTask?.cancel()
        detailStreamTask?.cancel()
        detailCatchUpTask?.cancel()
        detailPublishTask?.cancel()
        projectFaviconRefreshTasks.values.forEach { $0.cancel() }
        continuation.finish()
    }

    func initialSnapshot() async throws -> FeatureSnapshot {
        routeSnapshotLoads += 1
        defer { routeSnapshotLoads -= 1 }
        let preferenceGenerations = orchestrationPreferenceGenerations
        let environments = try await runtime.environments()
        guard let activeClient = try await runtime.activeClient() else {
            await clearActiveEnvironment()
            let snapshot = disconnectedSnapshot(environments: environments)
            latestSnapshot = snapshot
            return snapshot
        }
        // The runtime actor can change its active selection at any suspension
        // point. Derive both values from one client so the snapshot cannot pair
        // one environment with another environment's connection.
        // Renames preserve that client, so its display label comes from the catalog.
        var environment = activeClient.environment
        environment.label = environments.first(where: { $0.id == environment.id })?.label ?? environment.label

        await adoptEnvironment(environment, client: activeClient)
        let generation = environmentGeneration
        await restoreClientReadCache(environments)
        guard isCurrentSession(client: activeClient, generation: generation) else { throw CancellationError() }
        if !restoredShellEnvironmentIDs.isEmpty {
            let snapshot = makeSnapshot(
                environments: environments, activeEnvironment: environment,
                connectionState: .disconnected, connectionDetail: "Offline. Showing saved lists and history."
            )
            latestSnapshot = snapshot
            startPolling(activeClient)
            cacheStartupRefreshTask?.cancel()
            cacheStartupRefreshTask = Task { [weak self] in
                guard let self else { return }
                self.routeSnapshotLoads += 1
                defer { self.routeSnapshotLoads -= 1 }
                let loads = await self.loadEnvironmentShells(environments.filter(\.isEnabled), preferenceGenerations: preferenceGenerations)
                guard !Task.isCancelled, self.isCurrentSession(client: activeClient, generation: generation) else { return }
                self.reconcileEnvironmentLoads(loads, savedEnvironments: environments)
                self.latestShell = self.shellsByEnvironmentID[environment.id]
                self.publish(self.makeSnapshot(
                    environments: environments, activeEnvironment: environment,
                    connectionState: self.environmentConnectionStates[environment.id] ?? .disconnected,
                    connectionDetail: self.environmentConnectionDetails[environment.id]
                ))
                if loads.first(where: { $0.environment.id == environment.id })?.shell != nil {
                    self.scheduleArchivedRefresh(client: activeClient, environment: environment)
                }
            }
            return snapshot
        }
        let loads = await loadEnvironmentShells(environments.filter(\.isEnabled), preferenceGenerations: preferenceGenerations)
        guard isCurrentSession(client: activeClient, generation: generation) else {
            throw CancellationError()
        }
        reconcileEnvironmentLoads(loads, savedEnvironments: environments)
        latestShell = shellsByEnvironmentID[environment.id]
        startPolling(activeClient)
        let activeLoad = loads.first { $0.environment.id == environment.id }
        let activeIsReachable = activeLoad?.shell != nil
        if activeIsReachable {
            scheduleArchivedRefresh(client: activeClient, environment: environment)
        }
        if activeLoad?.credentialRejected == true, environment.routes.count == 1 {
            markActiveEnvironmentNeedsPairing(detail: activeLoad?.failureDetail)
        }
        let snapshot = makeSnapshot(
            environments: environments,
            activeEnvironment: environment,
            connectionState: environmentConnectionStates[environment.id] ?? .disconnected,
            connectionDetail: environmentConnectionDetails[environment.id]
        )
        latestSnapshot = snapshot
        return snapshot
    }

    func resumeAfterBackground(reconnect: Bool) async {
        let routeEnvironmentIDs = Set([activeEnvironment?.id, activeThreadEnvironmentID].compactMap { $0 })
        for id in routeEnvironmentIDs {
            _ = await recoverEnvironmentRoute(environmentID: id, promote: true, forceCheck: true)
        }
        let sessionGeneration = environmentGeneration
        let selectedRoute = activeThreadID.flatMap { try? threadRoute(for: $0) }
        detailWasSynchronized = false
        activeDetailConnectionID = nil
        for id in threadResumeStates.keys {
            threadResumeStates[id]?.wasSynchronized = false
        }
        if let selectedRoute {
            retainActiveThread()
            continuation.yield(.threadSync(id: selectedRoute.uiID, state: .catchingUp))
        }
        // Only wake the inbox connection and the selected thread's computer.
        // Other saved computers must not delay foreground recovery.
        if reconnect {
            var wakingClients: [T3Client] = []
            if let client { wakingClients.append(client) }
            if let selectedRoute, !wakingClients.contains(where: { $0 === selectedRoute.client }) {
                wakingClients.append(selectedRoute.client)
            }
            await withTaskGroup(of: Void.self) { group in
                for client in wakingClients { group.addTask { await client.reconnect() } }
            }
        }
        guard sessionGeneration == environmentGeneration else { return }
        if let client { startPolling(client) }
        if let selectedRoute, activeThreadID == selectedRoute.uiID,
           isKnownClient(selectedRoute.client, environmentID: selectedRoute.environmentID, generation: sessionGeneration) {
            resetDetailRefresh()
            resetDetailStream()
            startDetailStream(selectedRoute)
        }
    }

    func backgroundSnapshot() async throws -> FeatureSnapshot {
        routeSnapshotLoads += 1
        defer { routeSnapshotLoads -= 1 }
        let preferenceGenerations = orchestrationPreferenceGenerations
        let environments = try await runtime.environments()
        guard let activeClient = try await runtime.activeClient() else {
            return disconnectedSnapshot(environments: environments)
        }
        var environment = activeClient.environment
        environment.label = environments.first(where: { $0.id == environment.id })?.label ?? environment.label
        let generation = environmentGeneration
        let loads = await loadEnvironmentShells(environments.filter(\.isEnabled), preferenceGenerations: preferenceGenerations)
        guard let currentClient = try await runtime.activeClient(),
              currentClient === activeClient,
              generation == environmentGeneration else {
            throw CancellationError()
        }

        reconcileEnvironmentLoads(loads, savedEnvironments: environments)
        let snapshot = makeSnapshot(
            environments: environments,
            activeEnvironment: environment,
            connectionState: environmentConnectionStates[environment.id] ?? .disconnected,
            connectionDetail: environmentConnectionDetails[environment.id]
        )
        latestSnapshot = snapshot
        return snapshot
    }

    func events() -> AsyncStream<FeatureEvent> {
        stream
    }

    func pair(endpoint: String, token: String?) async throws {
        let pairedClient: T3Client
        if let token, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            pairedClient = try await runtime.pair(
                host: endpoint,
                code: token,
                clientLabel: "T3 Code Swift"
            )
        } else {
            pairedClient = try await runtime.pair(url: endpoint, clientLabel: "T3 Code Swift")
        }
        revokedCacheEnvironmentIDs.remove(pairedClient.environment.id)
        await prepareReadCacheLeases([pairedClient.environment])
        await adoptEnvironment(pairedClient.environment, client: pairedClient)
        startPolling(pairedClient)
    }

    func connectT3Environment(
        _ credential: T3ConnectManagedEnvironmentCredential
    ) async throws {
        guard hasMatchingT3ConnectController else {
            throw T3ConnectRelayError.invalidConfiguration(
                "This client runtime requires its matching T3 Connect controller."
            )
        }
        guard runtime.supportsManagedAuthorization else {
            throw T3ConnectRelayError.invalidConfiguration(
                "This client runtime was created without T3 Connect authorization."
            )
        }
        guard credential.environmentID.isEmpty == false,
              let httpBaseURL = credential.endpoint.httpBaseURL,
              let webSocketBaseURL = credential.endpoint.webSocketBaseURL,
              httpBaseURL.scheme?.lowercased() == "https",
              webSocketBaseURL.scheme?.lowercased() == "wss",
              let httpHost = httpBaseURL.host,
              let webSocketHost = webSocketBaseURL.host,
              httpHost.caseInsensitiveCompare(webSocketHost) == .orderedSame,
              (httpBaseURL.port ?? 443) == (webSocketBaseURL.port ?? 443) else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed environment endpoint is invalid."
            )
        }

        let descriptor = try await runtime.descriptor(at: httpBaseURL)
        guard descriptor.environmentId == credential.environmentID else {
            throw T3ConnectRelayError.environmentMismatch
        }
        let authorization = try await t3ConnectController.managedAuthorizer.exchange(
            credential,
            clientLabel: "T3 Code SwiftUI"
        )
        guard authorization.environmentID == descriptor.environmentId,
              authorization.endpoint == credential.endpoint,
              authorization.proofKeyThumbprint == credential.proofKeyThumbprint else {
            throw T3ConnectRelayError.environmentMismatch
        }

        let previousPreference = try await runtime.environments()
            .first { $0.id == descriptor.environmentId }?.orchestrationProtocolPreference ?? .auto
        _ = try OrchestrationProtocolSelection(descriptor: descriptor, preference: previousPreference)
        var environment = Environment(
            id: descriptor.environmentId,
            label: descriptor.label,
            httpBaseURL: httpBaseURL,
            webSocketBaseURL: webSocketBaseURL,
            kind: .managedDPoP,
            descriptor: descriptor
        )
        environment.orchestrationProtocolPreference = previousPreference
        let savedCredential = EnvironmentCredential.managedDPoP(
            accessToken: authorization.accessToken,
            expiresAt: authorization.expiresAt,
            scopes: authorization.scopes,
            environmentID: authorization.environmentID,
            proofKeyThumbprint: authorization.proofKeyThumbprint
        )
        let managedClient = try await runtime.saveManagedEnvironment(
            environment,
            credential: savedCredential
        )
        environment = managedClient.environment
        revokedCacheEnvironmentIDs.remove(environment.id)
        await prepareReadCacheLeases([environment])
        await adoptEnvironment(environment, client: managedClient)
        do {
            try await refresh(client: managedClient)
        } catch {
            let environments = (try? await runtime.environments()) ?? [environment]
            let snapshot = makeSnapshot(
                environments: environments,
                activeEnvironment: environment,
                connectionState: .connecting,
                connectionDetail: "Connected securely. Loading this environment."
            )
            publish(snapshot)
        }
        startPolling(managedClient)
    }

    func signOutT3Connect() async {
        await t3ConnectController.signOut()
        do {
            try await removeManagedEnvironmentRoutes()
            Self.t3ConnectLogger.info("Cleared managed T3 Connect routes")
        } catch {
            Self.t3ConnectLogger.error("Managed route cleanup failed: \(error.localizedDescription, privacy: .private)")
            t3ConnectController.errorMessage = error.localizedDescription
        }
    }

    func setEnvironmentEnabled(id: String, enabled: Bool) async throws {
        try await runtime.setEnabled(id: id, enabled: enabled)
        if !enabled {
            environmentConnectionStates[id] = .disconnected
            environmentConnectionDetails[id] = nil
            environmentClients[id] = nil
            shellsByEnvironmentID[id] = nil
            shellProjectionCache[id] = nil
            serverConfigsByEnvironmentID[id] = nil
            providerCatalogCache[id] = nil
            archivedThreadsByEnvironmentID[id] = nil
            archivedShellThreadsByEnvironmentID[id] = nil
        }
    }

    func orchestrationPreference(environmentID: String) async throws -> OrchestrationProtocolPreference {
        guard let environment = try await runtime.environments().first(where: { $0.id == environmentID }) else {
            throw RPCError.remote("This environment is no longer saved.")
        }
        return environment.orchestrationProtocolPreference
    }

    func updateThreadQueue(threadID: String, action: FeatureThreadQueueAction) async throws {
        let route = try threadRoute(for: threadID)
        guard !restoredDetailIDs.contains(route.uiID) else {
            throw FeatureCapabilityUnavailable("Queue controls require live thread data")
        }
        guard try await route.client.orchestrationVersion() == .v2 else {
            throw FeatureCapabilityUnavailable("Queue controls")
        }
        let threadID = route.wireID
        let command: JSONValue
        switch action {
        case let .cancel(runID):
            command = OrchestrationV2Commands.cancelQueuedRun(threadID: threadID, runID: runID)
        case let .reorder(runID, beforeRunID):
            command = OrchestrationV2Commands.reorderQueuedRun(threadID: threadID, runID: runID, beforeRunID: beforeRunID)
        case let .promoteToSteer(queuedRunID, targetRunID):
            command = OrchestrationV2Commands.promoteQueuedRun(
                threadID: threadID, queuedRunID: queuedRunID, targetRunID: targetRunID
            )
        case .resume:
            command = OrchestrationV2Commands.resumeQueue(threadID: threadID)
        case let .edit(runID, text):
            command = OrchestrationV2Commands.editQueuedRun(threadID: threadID, runID: runID, text: text)
        case let .replace(edit):
            let before = try await route.client.threadSnapshot(id: route.wireID)
            try Self.validateQueuedEdit(edit, control: before.thread.orchestrationV2Control)
            _ = try await route.client.serverConfig()
            let uploads = try await makeUploadAttachments(edit.draft.attachments.map(FeatureUploadAttachment.init))
            try UploadChatAttachment.validateBatch(uploads)
            let imageBytes = edit.existingAttachments.filter { $0.mimeType.hasPrefix("image/") }.map(\.sizeBytes)
                + uploads.filter { $0.type == "image" }.map(\.sizeBytes)
            guard imageBytes.reduce(0, +) <= UploadChatAttachment.maximumTotalImageBytes else {
                throw FileAttachmentError.imageBudgetExceeded
            }
            var prepared: [JSONValue] = []
            for upload in uploads {
                if let reference = try await route.client.prepareAttachment(upload) {
                    prepared.append(upload.uploadedJSONValue(id: reference.attachmentID))
                } else {
                    prepared.append(upload.jsonValue)
                }
            }
            // Uploads can outlive the queued run on another device.
            let current = try await route.client.threadSnapshot(id: route.wireID)
            try Self.validateQueuedEdit(edit, control: current.thread.orchestrationV2Control)
            let payload = try edit.replacementPayload(uploads: uploads, preparedAttachments: prepared)
            command = OrchestrationV2Commands.editQueuedRun(
                threadID: threadID, runID: edit.runID, text: payload.text, messageID: edit.messageID,
                attachments: payload.attachments, context: payload.context
            )
        case let .interrupt(runID, holdQueue):
            command = OrchestrationV2Commands.interruptRun(threadID: threadID, runID: runID, holdQueue: holdQueue)
        }
        _ = try await route.client.dispatch(command)
        await refreshThreadUnlessLive(id: route.uiID, client: route.client)
    }

    static func validateQueuedEdit(_ edit: FeatureQueuedRunEdit, control: JSONValue?) throws {
        guard let control else {
            throw FeatureThreadRecoveryError("Queue controls are unavailable. Your edit is still saved.")
        }
        let execution = try FeatureThreadExecution(projection: control)
        guard let entry = execution.queuedEntries.first(where: {
            $0.id == edit.runID && $0.messageID == edit.messageID
        }) else {
            throw FeatureThreadRecoveryError("This message is no longer queued. Your edit is still saved.")
        }
        let currentIDs = Set(entry.attachments.map(\.id))
        let removed = edit.existingAttachments.filter { !currentIDs.contains($0.id) }
        guard removed.isEmpty else {
            throw FeatureThreadRecoveryError(
                "These attachments were removed on another device: \(removed.map(\.name).joined(separator: ", ")). Remove them from this edit and save again. Your edit is still saved."
            )
        }
        if let message = edit.validationMessage { throw FeatureThreadRecoveryError(message) }
        guard execution.allows(.replace(edit)) else {
            throw FeatureThreadRecoveryError("The queue changed. Your edit is still saved. Try again when queue controls are available.")
        }
    }

    func setOrchestrationPreference(
        environmentID: String, preference: OrchestrationProtocolPreference
    ) async throws {
        _ = try await runtime.environmentStore.setOrchestrationProtocolPreference(
            id: environmentID, preference: preference
        )
        orchestrationPreferenceGenerations[environmentID, default: 0] &+= 1
        try await clearClientStorage(environmentID: environmentID)
        if activeEnvironment?.id == environmentID { await clearActiveEnvironment() }
        if let oldClient = environmentClients.removeValue(forKey: environmentID) {
            await oldClient.disconnect()
        }
        shellsByEnvironmentID[environmentID] = nil
        shellProjectionCache[environmentID] = nil
        serverConfigsByEnvironmentID[environmentID] = nil
        archivedThreadsByEnvironmentID[environmentID] = nil
        archivedShellThreadsByEnvironmentID[environmentID] = nil
        let threadIDs = threadEnvironmentIDs.filter { $0.value == environmentID }.map(\.key)
        for id in threadIDs {
            threadResumeStates[id] = nil
            latestDetails[id] = nil
            detailRenderCaches[id] = nil
        }
    }

    func removeEnvironment(id: String) async throws {
        let removesActiveEnvironment = activeEnvironment?.id == id
        try await runtime.remove(id: id)
        revokedCacheEnvironmentIDs.insert(id)
        orchestrationPreferenceGenerations[id, default: 0] &+= 1
        try await clearClientStorage(environmentID: id)
        readCacheLeases[id] = nil
        discardRestoredEnvironment(id)
        environmentClients[id] = nil
        shellsByEnvironmentID[id] = nil
        saveGitHubRoutingGrants(gitHubRoutingGrants.filter { $0.environmentID != id })
        if removesActiveEnvironment {
            await clearActiveEnvironment(disconnectClient: false)
        }
    }

    func disconnect() async {
        await clearActiveEnvironment()
    }

    func usageSummaryUpdates(
        _ input: UsageSummaryInput,
        refreshPricing: Bool
    ) -> AsyncThrowingStream<[FeatureEnvironmentUsage], Error> {
        let runtime = runtime
        return AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                do {
                    let environments = try await runtime.environments().filter(\.isEnabled)
                    var results = environments.map {
                        FeatureEnvironmentUsage(
                            environmentID: $0.id, label: $0.label,
                            summary: nil, isPending: true
                        )
                    }
                    continuation.yield(results)
                    try await withThrowingTaskGroup(of: (Int, FeatureEnvironmentUsage).self) { group in
                        for (index, environment) in environments.enumerated() {
                            group.addTask {
                                let probe = await runtime.ephemeralClient(for: environment)
                                let result: FeatureEnvironmentUsage
                                do {
                                    var pricingError: String?
                                    if refreshPricing {
                                        do { _ = try await probe.refreshUsageRates() }
                                        catch is CancellationError { throw CancellationError() }
                                        catch { pricingError = "Could not refresh prices. Showing the available rates." }
                                    }
                                    let summary = try await probe.usageSummary(input)
                                    try Task.checkCancellation()
                                    result = FeatureEnvironmentUsage(
                                        environmentID: environment.id, label: environment.label,
                                        summary: summary, errorMessage: pricingError
                                    )
                                } catch is CancellationError {
                                    await probe.disconnect()
                                    throw CancellationError()
                                } catch {
                                    result = FeatureEnvironmentUsage(
                                        environmentID: environment.id, label: environment.label,
                                        summary: nil, errorMessage: "This environment could not report usage."
                                    )
                                }
                                await probe.disconnect()
                                return (index, result)
                            }
                        }
                        for try await (index, result) in group {
                            try Task.checkCancellation()
                            results[index] = result
                            continuation.yield(results)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func threadUsageLimits(threadID: String, providerID: String) -> FeatureEnvironmentUsageLimits? {
        guard let environmentID = threadEnvironmentIDs[threadID],
              let config = serverConfigsByEnvironmentID[environmentID] else { return nil }
        return FeatureThreadUsageLimits.report(FeatureEnvironmentUsageLimits(
            environmentID: environmentID,
            label: environmentClients[environmentID]?.environment.label ?? "Computer",
            providers: config.providers, sources: config.usageLimitSources,
            isConnected: environmentConnectionStates[environmentID] == .connected
        ), providerID: providerID)
    }

    func usageLimitsUpdates() -> AsyncThrowingStream<[FeatureEnvironmentUsageLimits], Error> {
        let runtime = runtime
        return AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                do {
                    let environments = try await runtime.environments().filter(\.isEnabled)
                    let rows = environments.map {
                        FeatureEnvironmentUsageLimits(environmentID: $0.id, label: $0.label, isPending: true)
                    }
                    let collector = NativeUsageLimitsCollector(rows: rows, continuation: continuation)
                    continuation.yield(rows)
                    await withTaskGroup(of: Void.self) { group in
                        for (index, environment) in environments.enumerated() {
                            group.addTask {
                                // This view owns these subscriptions. Closing it releases all
                                // quota streams without disturbing the inbox or thread socket.
                                let probe = await runtime.ephemeralClient(for: environment)
                                do {
                                    let config = try await probe.serverConfig()
                                    try Task.checkCancellation()
                                    await collector.update(index: index, config: config)
                                    for try await event in await probe.serverConfigEvents() {
                                        try Task.checkCancellation()
                                        if case .unrelated = event { continue }
                                        let config = try await probe.serverConfig()
                                        await collector.update(index: index, config: config)
                                    }
                                } catch is CancellationError {
                                    // View or tab changes own cancellation, not a connection failure.
                                } catch {
                                    await collector.fail(index: index, message: error.localizedDescription)
                                }
                                await probe.disconnect()
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func refreshUsageLimits() async throws -> [FeatureEnvironmentUsageLimits] {
        let environments = try await runtime.environments().filter(\.isEnabled)
        let runtime = runtime
        return try await withThrowingTaskGroup(of: (Int, FeatureEnvironmentUsageLimits).self) { group in
            for (index, environment) in environments.enumerated() {
                group.addTask {
                    let probe = await runtime.ephemeralClient(for: environment)
                    let row: FeatureEnvironmentUsageLimits
                    do {
                        let config = try await probe.refreshProviders(refreshModels: false)
                        try Task.checkCancellation()
                        row = FeatureEnvironmentUsageLimits(
                            environmentID: environment.id, label: environment.label,
                            providers: config.providers, sources: config.usageLimitSources
                        )
                    } catch is CancellationError {
                        await probe.disconnect()
                        throw CancellationError()
                    } catch {
                        row = FeatureEnvironmentUsageLimits(
                            environmentID: environment.id, label: environment.label,
                            isConnected: false, errorMessage: error.localizedDescription
                        )
                    }
                    await probe.disconnect()
                    return (index, row)
                }
            }
            var results: [(Int, FeatureEnvironmentUsageLimits)] = []
            for try await row in group { results.append(row) }
            return results.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }

    func consumeResetCredit(
        environmentID: String,
        input: ProviderConsumeResetCreditInput
    ) async throws -> ProviderConsumeResetCreditResult {
        guard try await runtime.environments().contains(where: { $0.id == environmentID && $0.isEnabled }) else {
            throw NativeFeatureClientError.environmentNotFound
        }
        let client = try await projectCreationClient(environmentID: environmentID)
        return try await client.consumeResetCredit(input)
    }

    func pullRequestLists(_ input: PullRequestListInput) async throws
        -> [FeaturePullRequestEnvironmentList]
    {
        try await pullRequestLists(input, inEnvironment: nil)
    }

    func pullRequestLists(
        _ input: PullRequestListInput,
        environmentID: String
    ) async throws -> [FeaturePullRequestEnvironmentList] {
        try await pullRequestLists(input, inEnvironment: environmentID)
    }

    private func pullRequestLists(
        _ input: PullRequestListInput,
        inEnvironment environmentID: String?
    ) async throws -> [FeaturePullRequestEnvironmentList] {
        let environments = try await runtime.environments().filter {
            $0.isEnabled
                && $0.descriptor?.capabilities.pullRequests == true
                && (environmentID == nil || $0.id == environmentID)
        }
        let runtime = runtime
        return await withTaskGroup(of: FeaturePullRequestEnvironmentList.self) { group in
            for environment in environments {
                group.addTask {
                    let probe = await runtime.ephemeralClient(for: environment)
                    do {
                        let result = try await probe.pullRequests(input)
                        await probe.disconnect()
                        return FeaturePullRequestEnvironmentList(
                            environmentID: environment.id,
                            environmentName: environment.label,
                            result: result,
                            errorMessage: nil
                        )
                    } catch {
                        await probe.disconnect()
                        return FeaturePullRequestEnvironmentList(
                            environmentID: environment.id,
                            environmentName: environment.label,
                            result: nil,
                            errorMessage: error.localizedDescription
                        )
                    }
                }
            }
            var results: [FeaturePullRequestEnvironmentList] = []
            for await result in group { results.append(result) }
            return results.sorted { $0.environmentName < $1.environmentName }
        }
    }

    private var gitHubRoutingGrants: [GitHubRoutingGrant] {
        guard let data = settingsStore.data(forKey: Self.gitHubRoutingKey) else { return [] }
        return (try? JSONDecoder().decode([GitHubRoutingGrant].self, from: data)) ?? []
    }

    private func saveGitHubRoutingGrants(_ grants: [GitHubRoutingGrant]) {
        settingsStore.set(try? JSONEncoder().encode(grants), forKey: Self.gitHubRoutingKey)
    }

    func gitHubRoutingPermission(environmentID: String) async throws -> GitHubRoutingPermission {
        guard let environment = try await runtime.environments().first(where: { $0.id == environmentID }) else {
            throw NativeFeatureClientError.environmentNotFound
        }
        return GitHubRoutingGrant.permission(for: environment, grants: gitHubRoutingGrants)
    }

    func setGitHubRoutingPermission(environmentID: String, permission: GitHubRoutingPermission) async throws {
        guard let environment = try await runtime.environments().first(where: { $0.id == environmentID }),
              let key = GitHubRoutingGrant.connectionKey(environment) else {
            throw NativeFeatureClientError.environmentNotFound
        }
        var grants = gitHubRoutingGrants.filter { $0.environmentID != environmentID }
        if permission != .off {
            grants.append(GitHubRoutingGrant(environmentID: environmentID, connectionKey: key, permission: permission))
        }
        saveGitHubRoutingGrants(grants)
    }

    private func routingAllowed(origin: Environment, destination: Environment, write: Bool) async -> Bool {
        guard let current = try? await runtime.environments(),
              let source = current.first(where: { $0.id == origin.id }),
              let target = current.first(where: { $0.id == destination.id }),
              GitHubRoutingGrant.connectionKey(source) == GitHubRoutingGrant.connectionKey(origin),
              GitHubRoutingGrant.connectionKey(target) == GitHubRoutingGrant.connectionKey(destination) else { return false }
        return GitHubRoutingGrant.allowed(origin: source, destination: target, grants: gitHubRoutingGrants, write: write)
    }

    /// Only verified GitHub accounts can route. A dispatched write is never retried elsewhere.
    private func withPullRequestRoute<Result>(
        _ target: FeaturePullRequestTarget, write: Bool = false, allowStaleFallback: Bool = false,
        operation: (T3Client, PullRequestRef, PullRequestRoutingIdentity?) async throws -> Result
    ) async throws -> Result {
        let client = try await projectCreationClient(environmentID: target.environmentID)
        let environments = try await runtime.environments()
        let origin = client.environment
        let alternatives = environments.filter {
            GitHubRoutingGrant.allowed(origin: origin, destination: $0, grants: gitHubRoutingGrants, write: write)
                && environmentConnectionStates[$0.id] == .connected
        }.sorted { left, right in
            let localHosts = ["localhost", "127.0.0.1", "::1"]
            let leftLocal = localHosts.contains(left.httpBaseURL.host ?? "")
            let rightLocal = localHosts.contains(right.httpBaseURL.host ?? "")
            return leftLocal == rightLocal ? left.id < right.id : leftLocal
        }
        guard !alternatives.isEmpty,
              let identity = try? await client.pullRequestRouting(target.reference),
              identity.provider == .github else {
            try Task.checkCancellation()
            if write { try await requireScope("source-control:write", client: client) }
            return try await operation(client, target.reference, nil)
        }
        let reference = PullRequestRef(projectId: target.reference.projectId,
                                       repository: target.reference.repository, number: target.reference.number,
                                       host: identity.host, expectedAccountId: identity.accountId,
                                       allowStale: write ? target.reference.allowStale : false)
        for environment in alternatives {
            try Task.checkCancellation()
            guard await routingAllowed(origin: origin, destination: environment, write: write) else { continue }
            guard let alternate = try? await projectCreationClient(environmentID: environment.id),
                  GitHubRoutingGrant.connectionKey(alternate.environment) == GitHubRoutingGrant.connectionKey(environment),
                  let account = try? await alternate.pullRequestRoutingIdentity(host: identity.host),
                  account.provider == .github, account.accountId == identity.accountId,
                  account.host.caseInsensitiveCompare(identity.host) == .orderedSame,
                  await routingAllowed(origin: origin, destination: environment, write: write) else { continue }
            do {
                if write { try await requireScope("source-control:write", client: alternate) }
                let result = try await operation(alternate, reference, identity)
                if routedPullRequests.count >= 256 { routedPullRequests.removeAll(keepingCapacity: true) }
                routedPullRequests[target, default: []].insert(environment.id)
                if write { try? await invalidatePullRequests(target) }
                return result
            } catch {
                if write || Task.isCancelled { throw error }
            }
        }
        try Task.checkCancellation()
        do {
            if write { try await requireScope("source-control:write", client: client) }
            let result = try await operation(client, reference, identity)
            if write { try? await invalidatePullRequests(target) }
            return result
        } catch {
            try Task.checkCancellation()
            guard allowStaleFallback, !write, target.reference.allowStale != false else { throw error }
            return try await operation(client, target.reference, nil)
        }
    }

    func pullRequestDetail(_ target: FeaturePullRequestTarget) async throws -> PullRequestDetail {
        try await withPullRequestRoute(target, allowStaleFallback: true) { client, reference, identity in
            var detail = try await client.pullRequestDetail(reference)
            detail.projectId = target.reference.projectId
            if let title = identity?.projectTitle { detail.projectTitle = title }
            if let root = identity?.workspaceRoot { detail.workspaceRoot = root }
            return detail
        }
    }

    func pullRequestActivity(_ target: FeaturePullRequestTarget) async throws
        -> PullRequestActivity
    {
        try await withPullRequestRoute(target) { client, reference, _ in
            try await client.pullRequestActivity(reference)
        }
    }

    func pullRequestDiff(_ target: FeaturePullRequestTarget, cursor: String?) async throws
        -> PullRequestDiffResult
    {
        try await withPullRequestRoute(target) { client, reference, _ in
            try await client.pullRequestDiff(PullRequestDiffInput(
                projectId: reference.projectId,
                repository: reference.repository,
                number: reference.number,
                cursor: cursor,
                commit: nil,
                host: reference.host,
                expectedAccountId: reference.expectedAccountId,
                allowStale: reference.allowStale
            ))
        }
    }

    func runPullRequestAction(
        _ target: FeaturePullRequestTarget,
        action: PullRequestAction,
        mergeMethod: PullRequestMergeMethod?,
        updateMethod: PullRequestUpdateMethod?
    ) async throws {
        try await withPullRequestRoute(target, write: true) { client, reference, _ in
            try await client.runPullRequestAction(reference, action: action, mergeMethod: mergeMethod, updateMethod: updateMethod)
        }
    }

    func updatePullRequest(
        _ target: FeaturePullRequestTarget,
        title: String?,
        body: String?
    ) async throws {
        try await withPullRequestRoute(target, write: true) { client, reference, _ in
            try await client.updatePullRequest(reference, title: title, body: body)
        }
    }

    func commentOnPullRequest(_ target: FeaturePullRequestTarget, body: String) async throws {
        try await withPullRequestRoute(target, write: true) { client, reference, _ in
            try await client.commentOnPullRequest(reference, body: body)
        }
    }

    func submitPullRequestReview(
        _ target: FeaturePullRequestTarget,
        verdict: PullRequestReviewVerdict,
        body: String,
        comments: [PullRequestReviewCommentDraft]
    ) async throws {
        try await withPullRequestRoute(target, write: true) { client, reference, _ in
            try await client.submitPullRequestReview(
                reference,
                verdict: verdict,
                body: body,
                comments: comments
            )
        }
    }

    func replyToPullRequestThread(
        _ target: FeaturePullRequestTarget,
        threadID: String,
        body: String
    ) async throws {
        try await withPullRequestRoute(target, write: true) { client, reference, _ in
            try await client.replyToPullRequestThread(reference, threadID: threadID, body: body)
        }
    }

    func setPullRequestThreadResolved(
        _ target: FeaturePullRequestTarget,
        threadID: String,
        resolved: Bool
    ) async throws {
        try await withPullRequestRoute(target, write: true) { client, reference, _ in
            try await client.setPullRequestThreadResolved(
                reference,
                threadID: threadID,
                resolved: resolved
            )
        }
    }

    func setPullRequestReaction(
        _ target: FeaturePullRequestTarget,
        subjectID: String?,
        content: PullRequestReactionContent,
        reacted: Bool
    ) async throws {
        try await withPullRequestRoute(target, write: true) { client, reference, _ in
            try await client.setPullRequestReaction(
                reference,
                subjectID: subjectID,
                content: content,
                reacted: reacted
            )
        }
    }

    func pullRequestReviewerCandidates(_ target: FeaturePullRequestTarget) async throws
        -> PullRequestReviewerCandidateList
    {
        try await withPullRequestRoute(target) { client, reference, _ in
            try await client.pullRequestReviewerCandidates(reference)
        }
    }

    func requestPullRequestReviewers(
        _ target: FeaturePullRequestTarget,
        reviewers: [PullRequestReviewerCandidate],
        requested: Bool
    ) async throws {
        try await withPullRequestRoute(target, write: true) { client, reference, _ in
            try await client.requestPullRequestReviewers(
                reference,
                reviewers: reviewers,
                requested: requested
            )
        }
    }

    func invalidatePullRequests(_ target: FeaturePullRequestTarget?) async throws {
        if let target {
            try await projectCreationClient(environmentID: target.environmentID)
                .invalidatePullRequests(target.reference)
            let environments = try await runtime.environments()
            if let origin = environments.first(where: { $0.id == target.environmentID }) {
                for id in routedPullRequests[target] ?? [] {
                    guard let destination = environments.first(where: { $0.id == id }),
                          await routingAllowed(origin: origin, destination: destination, write: false) else { continue }
                    try? await projectCreationClient(environmentID: id).invalidatePullRequests(target.reference)
                }
            }
            return
        }
        let environments = try await runtime.environments().filter(\.isEnabled)
        for environment in environments {
            try? await projectCreationClient(environmentID: environment.id).invalidatePullRequests()
        }
    }

    private func adoptEnvironment(
        _ environment: Environment,
        client newClient: T3Client
    ) async {
        if activeEnvironment?.id == environment.id, client === newClient {
            activeEnvironment = environment
            environmentClients[environment.id] = newClient
            latestShell = shellsByEnvironmentID[environment.id]
            startAggregateRefresh(newClient)
            return
        }
        let previousClient = client
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        aggregateRefreshTask?.cancel()
        archivedRefreshTask?.cancel()
        pollingTask = nil
        fallbackPollingTask = nil
        configurationTask = nil
        aggregateRefreshTask = nil
        aggregateRefreshID = nil
        archivedRefreshTask = nil
        clearEnvironmentState(preserveEnvironmentSnapshots: true)
        activeEnvironment = environment
        client = newClient
        environmentClients[environment.id] = newClient
        latestShell = shellsByEnvironmentID[environment.id]
        if let previousClient, previousClient !== newClient {
            await previousClient.disconnect()
        }
        startAggregateRefresh(newClient)
    }

    private func clearActiveEnvironment(disconnectClient: Bool = true) async {
        let previousClient = client
        if let id = activeEnvironment?.id { await runtime.cancelRouteResolution(id: id) }
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        aggregateRefreshTask?.cancel()
        archivedRefreshTask?.cancel()
        pollingTask = nil
        fallbackPollingTask = nil
        configurationTask = nil
        aggregateRefreshTask = nil
        aggregateRefreshID = nil
        archivedRefreshTask = nil
        clearEnvironmentState()
        client = nil
        activeEnvironment = nil
        if disconnectClient, let previousClient {
            await previousClient.disconnect()
        }
    }

    private func clearEnvironmentState(preserveEnvironmentSnapshots: Bool = false) {
        cacheStartupRefreshTask?.cancel()
        cacheStartupRefreshTask = nil
        restoredDetailIDs.removeAll()
        expandedHistoryIDs.removeAll()
        environmentGeneration &+= 1
        resetDetailRefresh()
        resetDetailStream()
        archivedRefreshTask?.cancel()
        archivedRefreshTask = nil
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = nil
        lastShellEventAt = nil
        latestServerConfig = nil
        if !preserveEnvironmentSnapshots {
            restoredShellEnvironmentIDs.removeAll()
            environmentClients.removeAll()
        environmentPermissions.removeAll()
            shellsByEnvironmentID.removeAll()
            shellProjectionCache.removeAll()
            indexedShellMembership = nil
            indexedProvisionalRoutes.removeAll()
            serverConfigsByEnvironmentID.removeAll()
            providerCatalogCache.removeAll()
            archivedThreadsByEnvironmentID.removeAll()
            archivedShellThreadsByEnvironmentID.removeAll()
            projectEnvironmentIDs.removeAll()
            projectWireIDs.removeAll()
            threadEnvironmentIDs.removeAll()
            threadWireIDs.removeAll()
            provisionalThreadRoutes.removeAll()
            environmentConnectionStates.removeAll()
            environmentConnectionDetails.removeAll()
        }
        latestSnapshot = nil
        activeThreadID = nil
        activeThreadEnvironmentID = nil
        activeRawThread = nil
        activeThreadSequence = nil
        activeThreadPage = nil
        threadHistoryEpoch &+= 1
        pendingOlderThreadPage = nil
        latestDetails.removeAll()
        threadResumeStates.removeAll()
        detailRenderCaches.removeAll()
        detailCacheRecency.removeAll()
        attachmentURLs.removeAll()
        pendingBootstrapSubmissions.removeAll()
        pendingTurnSubmissions.removeAll()
        approvalRoutes.removeAll()
        inputRoutes.removeAll()
        terminalSnapshots.removeAll()
    }

    private func isCurrentSession(client: T3Client, generation: Int) -> Bool {
        guard generation == environmentGeneration, let currentClient = self.client else {
            return false
        }
        return currentClient === client
    }

    private func isKnownClient(
        _ client: T3Client,
        environmentID: String,
        generation: Int
    ) -> Bool {
        generation == environmentGeneration
            && environmentClients[environmentID] === client
    }

    func addProject(path: String) async throws {
        guard let environmentID = activeEnvironment?.id else {
            throw NativeFeatureClientError.notConnected
        }
        try await addProject(environmentID: environmentID, path: path)
    }

    func environmentDescriptor(environmentID: String) async throws -> EnvironmentDescriptor {
        guard let environment = try await runtime.environments().first(where: { $0.id == environmentID }) else {
            throw RPCError.remote("This environment is no longer saved.")
        }
        // Discovery must still work when a forced protocol choice blocks RPC.
        return try await runtime.descriptor(at: environment.httpBaseURL)
    }

    func updateEnvironment(environmentID: String, targetVersion: String) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await requireScope("environment:maintain", client: client)
        let config = try await client.serverConfig()
        guard let capabilities = config.environment?.capabilities,
              capabilities.serverSelfUpdate != nil,
              capabilities.serverSelfUpdate != "desktop-managed" || capabilities.desktopAppUpdate == true else {
            throw FeatureCapabilityUnavailable("Environment updates")
        }
        try await client.updateEnvironment(targetVersion: targetVersion,
            continueRunningThreads: capabilities.serverUpdateThreadContinuation == true
                && config.settings?.continueThreadsAfterServerUpdate == true)
    }

    func ensureScratchProject(environmentID: String) async throws -> String {
        let client = try await projectCreationClient(environmentID: environmentID)
        let projectID = try await client.ensureScratchProject()
        try await refresh(client: client)
        return FeatureScopedID.project(environmentID: environmentID, wireID: projectID)
    }

    func createNewProject(environmentID: String, name: String) async throws -> ProjectCreateNewResult {
        let client = try await projectCreationClient(environmentID: environmentID)
        let result = try await client.createNewProject(name: name)
        // The server created the project even if the follow-up refresh fails.
        try? await refresh(client: client)
        return result
    }

    func publishNewProject(environmentID: String, cwd: String, repository: String) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await client.publishNewProject(cwd: cwd, repository: repository)
        try? await refresh(client: client)
    }

    func addProject(environmentID: String, path: String) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await createProject(client: client, path: path)
    }

    func browseProjectFolders(
        environmentID: String,
        partialPath: String
    ) async throws -> FilesystemBrowseResult {
        let client = try await projectCreationClient(environmentID: environmentID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(["filesystem:read"], client: client, generation: generation)
        let result = try await client.browseFilesystem(partialPath: partialPath)
        try Task.checkCancellation()
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        return result
    }

    func workspaceAssetURL(threadID: String, path: String) async throws -> URL {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(
            [EnvironmentPermissionRequirements.asset(resourceKind: "workspace-file")],
            client: route.client, generation: generation
        )
        let url = try await route.client.resolvedAssetURL(
            resource: .workspaceFile(threadID: route.wireID, path: path)
        )
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
            throw CancellationError()
        }
        return url
    }

    func nativeAppIconURL(threadID: String, app: ToolNativeAppReference) async throws -> URL {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(
            [EnvironmentPermissionRequirements.asset(resourceKind: "native-app-icon")],
            client: route.client, generation: generation
        )
        let url = try await route.client.resolvedAssetURL(resource: .nativeAppIcon(app))
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
            throw CancellationError()
        }
        return url
    }

    func mediaAssetURL(threadID: String, path: String) async throws -> URL {
        try await mediaAsset(threadID: threadID, path: path).url
    }

    func mediaAsset(threadID: String, path: String) async throws -> ResolvedAssetURL {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(
            [EnvironmentPermissionRequirements.asset(resourceKind: "media-file")],
            client: route.client, generation: generation
        )
        let resolved: ResolvedAssetURL
        do {
            resolved = try await route.client.resolvedAsset(
                resource: .mediaFile(threadID: route.wireID, path: path)
            )
        } catch let RPCError.remote(message)
            where message.localizedCaseInsensitiveContains("media-file")
                && (message.localizedCaseInsensitiveContains("schema")
                    || message.localizedCaseInsensitiveContains("unsupported")
                    || message.localizedCaseInsensitiveContains("unknown tag")
                    || message.localizedCaseInsensitiveContains("unknown discriminator")) {
            try await requireWorkspaceScopes(
                [EnvironmentPermissionRequirements.asset(resourceKind: "workspace-file")],
                client: route.client, generation: generation
            )
            resolved = try await route.client.resolvedAsset(
                resource: .workspaceFile(threadID: route.wireID, path: path)
            )
        }
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
            throw CancellationError()
        }
        return resolved
    }

    func submitCodexFeedback(threadID: String, reason: String?) async throws -> String {
        let route = try threadRoute(for: threadID)
        return try await route.client.uploadFeedback(
            threadID: route.wireID,
            reason: reason
        ).feedbackId
    }

    func cachedProjectFavicon(
        environmentID: String,
        workspaceRoot: String
    ) async -> Data? {
        let key = FeatureProjectFaviconCacheKey(
            environmentID: environmentID,
            workspaceRoot: workspaceRoot
        )
        return try? await projectFaviconStore.value(for: key)?.data
    }

    func refreshProjectFavicon(
        environmentID: String,
        workspaceRoot: String
    ) async -> Data? {
        let key = FeatureProjectFaviconCacheKey(
            environmentID: environmentID,
            workspaceRoot: workspaceRoot
        )
        let generation = await projectFaviconStore.generation(environmentID: environmentID)
        let cached = try? await projectFaviconStore.value(for: key)
        let updatedAt = shellsByEnvironmentID[environmentID]?.projects.first {
            FeatureProjectFaviconCacheKey(environmentID: environmentID, workspaceRoot: $0.workspaceRoot) == key
        }?.updatedAt
        if let cached, !cached.needsRefresh(projectUpdatedAt: updatedAt.flatMap(parseValidDate)) {
            return cached.data
        }
        if let task = projectFaviconRefreshTasks[key] {
            return await task.value
        }

        guard let client = environmentClients[environmentID] else {
            try? await projectFaviconStore.record(
                data: nil,
                revision: nil,
                for: key, generation: generation
            )
            return cached?.data
        }

        let store = projectFaviconStore
        let task = Task<Data?, Never> {
            do {
                let resolved = try await client.resolvedAsset(
                    resource: .projectFavicon(cwd: workspaceRoot)
                )
                let revision = resolved.url.lastPathComponent.removingPercentEncoding
                    ?? resolved.url.lastPathComponent
                if revision == Self.projectFaviconFallbackMarker {
                    try await store.record(data: nil, revision: nil, for: key, generation: generation)
                    return cached?.data
                }
                if cached?.revision == revision, cached?.data != nil {
                    try await store.record(data: nil, revision: revision, for: key, generation: generation)
                    return cached?.data
                }

                let (data, response) = try await URLSession.shared.data(from: resolved.url)
                guard let response = response as? HTTPURLResponse,
                      (200..<300).contains(response.statusCode),
                      !data.isEmpty,
                      data.count <= FeatureProjectFaviconStore.maximumDataSize else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                guard let renderable = await FeatureProjectFaviconImageDecoder.renderableData(
                    from: data
                ) else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                try await store.record(data: renderable, revision: revision, for: key, generation: generation)
                return renderable
            } catch {
                try? await store.record(data: nil, revision: nil, for: key, generation: generation)
                return cached?.data
            }
        }
        projectFaviconRefreshTasks[key] = task
        let value = await task.value
        projectFaviconRefreshTasks[key] = nil
        return value
    }

    func discoverProjectSources(
        environmentID: String
    ) async throws -> SourceControlDiscoveryResult {
        let client = try await projectCreationClient(environmentID: environmentID)
        return try await client.discoverSourceControl()
    }

    func lookupProjectRepository(
        environmentID: String,
        provider: SourceControlProviderKind,
        repository: String
    ) async throws -> SourceControlRepositoryInfo {
        let client = try await projectCreationClient(environmentID: environmentID)
        return try await client.lookupRepository(
            provider: provider,
            repository: repository
        )
    }

    func cloneProjectRepository(
        environmentID: String,
        remoteURL: String,
        destinationPath: String
    ) async throws -> SourceControlCloneResult {
        let client = try await projectCreationClient(environmentID: environmentID)
        // An existing repository does not prove this clone succeeded. A lost
        // reply must remain an error until the server confirms the destination.
        return try await client.cloneRepository(remoteURL: remoteURL, destinationPath: destinationPath)
    }

    func supportsManagedProjectClones(environmentID: String) async throws -> Bool {
        let client = try await projectCreationClient(environmentID: environmentID)
        return try await client.serverConfig().environment?.capabilities.projectCloneTracking == true
    }

    func startManagedProjectClone(environmentID: String, input: ProjectCloneStartInput) async throws -> ProjectCloneStartResult {
        let client = try await managedCloneClient(environmentID: environmentID, requiresWrite: true)
        let result = try await client.startProjectClone(input)
        // A refresh failure must not turn an accepted background clone into another start.
        try? await refresh(client: client)
        return result
    }

    func managedProjectCloneUpdates(environmentID: String) -> AsyncThrowingStream<[FeatureManagedProjectClone], Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                do {
                    let client = try await managedCloneClient(environmentID: environmentID, requiresWrite: false)
                    let generation = environmentGeneration
                    for try await snapshots in await client.projectCloneEvents() {
                        try Task.checkCancellation()
                        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
                            throw CancellationError()
                        }
                        continuation.yield(snapshots.map {
                            FeatureManagedProjectClone(environmentID: environmentID, snapshot: $0)
                        })
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func performManagedProjectCloneAction(_ action: ProjectCloneAction, clone: FeatureManagedProjectClone) async throws -> Bool {
        let client = try await managedCloneClient(environmentID: clone.environmentID, requiresWrite: true)
        return try await client.projectCloneAction(projectID: clone.snapshot.projectId, action: action).applied
    }

    func removeManagedCloneProject(_ clone: FeatureManagedProjectClone) async throws {
        let client = try await managedCloneClient(environmentID: clone.environmentID, requiresWrite: true)
        _ = try await client.dispatch(.object([
            "type": .string("project.delete"), "commandId": .string(UUID().uuidString),
            "projectId": .string(clone.snapshot.projectId),
            "createdAt": .string(Date().ISO8601Format()),
        ]))
        if let lease = readCacheLeases[clone.environmentID] {
            try? await clientReadCache.remove(projectID: clone.snapshot.projectId, lease: lease)
        }
        try? await refresh(client: client)
    }

    private func managedCloneClient(environmentID: String, requiresWrite: Bool) async throws -> T3Client {
        let client = try await projectCreationClient(environmentID: environmentID)
        guard try await client.serverConfig().environment?.capabilities.projectCloneTracking == true else {
            throw FeatureCapabilityUnavailable("Managed repository clones")
        }
        if requiresWrite { try await requireScope("orchestration:operate", client: client) }
        return client
    }

    private func createProject(client: T3Client, path: String) async throws {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NativeFeatureClientError.invalidProjectPath
        }
        let title = ProjectCreationPath.lastPathComponent(trimmed)
        let projectID = UUID().uuidString
        do {
            _ = try await client.createProject(
                projectID: projectID,
                title: title.isEmpty ? "Project" : title,
                workspaceRoot: trimmed,
                defaultModel: client.environment.id == activeEnvironment?.id
                    ? fallbackModelSelection(
                        environmentID: client.environment.id,
                        projectID: nil,
                        shell: shellsByEnvironmentID[client.environment.id]
                    )
                    : nil
            )
        } catch {
            // The dispatch reply may be lost after the server persisted the
            // project. A fresh shell turns that ambiguous failure into success
            // and also makes retrying clone registration idempotent.
            guard await recoverCreatedProject(
                client: client,
                projectID: projectID,
                path: trimmed
            ) else {
                throw error
            }
            return
        }

        do {
            try await refresh(client: client)
        } catch {
            guard await recoverCreatedProject(
                client: client,
                projectID: projectID,
                path: trimmed
            ) else {
                throw error
            }
        }
    }

    private func recoverCreatedProject(
        client: T3Client,
        projectID: String,
        path: String
    ) async -> Bool {
        let environment = client.environment
        let generation = environmentGeneration
        guard let fetchedShell = try? await client.shellSnapshot(),
              isKnownClient(client, environmentID: environment.id, generation: generation) else {
            return false
        }
        let shell = newestShell(fetchedShell, for: environment)
        guard shell.projects.contains(where: {
                  $0.id == projectID
                    || ProjectCreationPath.normalizedForComparison($0.workspaceRoot)
                        == ProjectCreationPath.normalizedForComparison(path)
              }) else {
            return false
        }
        await emitSnapshot(shell, client: client, expectedGeneration: generation)
        return true
    }

    func listWorkspaceBranches(
        projectID: String,
        refresh: Bool
    ) async throws -> [FeatureWorkspaceBranch] {
        let route = try projectRoute(for: projectID)
        let project = try project(for: route)
        var refs: [VCSRef] = []
        var cursor: Int?
        var seenCursors = Set<Int>()
        repeat {
            let result = try await route.client.listVCSRefs(
                cwd: project.workspaceRoot,
                cursor: cursor,
                refresh: refresh && cursor == nil,
                limit: 100
            )
            guard result.isRepo else { return [] }
            refs.append(contentsOf: result.refs)
            guard let nextCursor = result.nextCursor,
                  seenCursors.insert(nextCursor).inserted else {
                break
            }
            cursor = nextCursor
        } while true

        return refs.map { ref in
            FeatureWorkspaceBranch(
                name: ref.name,
                isRemote: ref.isRemote ?? false,
                isCurrent: ref.current,
                isDefault: ref.isDefault,
                worktreePath: ref.worktreePath
            )
        }
    }

    func selectWorkspaceBranch(
        projectID: String, branch: FeatureWorkspaceBranch, mode: FeatureWorkspaceMode
    ) async throws -> FeatureWorkspaceBranch {
        let route = try projectRoute(for: projectID)
        let generation = environmentGeneration
        let project = try project(for: route)
        return try await NewTaskWorkspaceDefaults.selectBranch(branch, mode: mode) { name in
            try await self.requireWorkspaceScopes(["source-control:write"], client: route.client, generation: generation)
            guard try self.project(for: route).workspaceRoot == project.workspaceRoot else { throw CancellationError() }
            let result = try await route.client.switchVCSRef(cwd: project.workspaceRoot, name: name)
            try Task.checkCancellation()
            guard self.isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
                throw CancellationError()
            }
            return result.refName
        }
    }

    func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async throws -> FeatureThread {
        let route = try projectRoute(for: projectID)
        let client = route.client
        let environment = client.environment
        let generation = environmentGeneration
        let model = modelSelection(
            selection,
            projectID: route.wireID,
            environmentID: environment.id,
            shell: shellsByEnvironmentID[environment.id]
        )
        let resolvedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let threadTitle = resolvedTitle?.isEmpty == false ? resolvedTitle! : "New thread"
        let signature = ThreadCreationSignature(
            projectID: projectID,
            title: threadTitle,
            model: model
        )
        let pending: PendingThreadCreation
        if let existing = pendingThreadCreations.first(where: { $0.signature == signature }) {
            pending = existing
        } else {
            pending = PendingThreadCreation(signature: signature, threadID: UUID().uuidString)
            pendingThreadCreations.append(pending)
        }
        var recoveredShell: OrchestrationShellSnapshot?
        do {
            _ = try await client.createThread(
                threadID: pending.threadID,
                projectID: route.wireID,
                title: threadTitle,
                model: model,
                runtimeMode: .fullAccess
            )
        } catch {
            guard Self.isAmbiguousDispatchFailure(error) else {
                removePendingThreadCreation(threadID: pending.threadID)
                throw error
            }
            if let shell = try? await client.shellSnapshot(),
               shell.threads.contains(where: { $0.id == pending.threadID }) {
                recoveredShell = shell
            } else {
                // Keep this ID while the outcome is ambiguous. A retry of the
                // same creation attempt must not make another thread.
                throw error
            }
        }
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        removePendingThreadCreation(threadID: pending.threadID)
        registerProvisionalThread(wireID: pending.threadID, environmentID: environment.id)
        let refreshedShell: OrchestrationShellSnapshot?
        if let recoveredShell {
            refreshedShell = recoveredShell
        } else {
            refreshedShell = try? await client.shellSnapshot()
        }
        if let refreshedShell {
            guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
                throw CancellationError()
            }
            let shell = newestShell(refreshedShell, for: environment)
            await emitSnapshot(shell, client: client, expectedGeneration: generation)
            if let created = shell.threads.first(where: { $0.id == pending.threadID }) {
                provisionalThreadRoutes[FeatureScopedID.thread(
                    environmentID: environment.id,
                    wireID: pending.threadID
                )] = nil
                return mapThread(created, environment: environment)
            }
        }
        return FeatureThread(
            id: FeatureScopedID.thread(
                environmentID: environment.id,
                wireID: pending.threadID
            ),
            wireID: pending.threadID,
            projectID: route.uiID,
            environmentID: environment.id,
            environmentName: environment.label,
            title: threadTitle,
            providerID: model.instanceId,
            providerName: UsageLimitsPresentation.providerLabel(driver: model.instanceId),
            modelID: model.model
        )
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity,
        context: OrchestrationMessageContext? = nil
    ) async throws -> FeatureThread {
        try await createThreadAndSendResolved(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            workspaceMode: workspaceMode,
            branch: branch,
            worktreePath: worktreePath,
            startFromOrigin: startFromOrigin,
            attachments: attachments,
            submissionIdentity: identity,
            context: context
        )
    }

    private func createThreadAndSendResolved(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment],
        submissionIdentity: FeatureSubmissionIdentity?,
        context: OrchestrationMessageContext? = nil
    ) async throws -> FeatureThread {
        let route = try projectRoute(for: projectID)
        let client = route.client
        let environment = client.environment
        let generation = environmentGeneration
        let routedProject = try project(for: route)
        let branch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard workspaceMode != .worktree || branch?.isEmpty == false else {
            throw NativeFeatureClientError.branchRequired
        }
        let worktreePath = workspaceMode == .local ? worktreePath : nil
        let model = modelSelection(
            selection,
            projectID: route.wireID,
            environmentID: environment.id,
            shell: shellsByEnvironmentID[environment.id]
        )
        let title = Self.title(from: prompt, hasAttachments: !attachments.isEmpty)
        let uploads = try await makeUploadAttachments(attachments)
        if !uploads.isEmpty { _ = try await client.serverConfig() }
        let runtime = coreRuntimeMode(runtimeMode)
        let interaction = coreInteractionMode(interactionMode)
        let signature = BootstrapSubmissionSignature(
            projectID: projectID,
            prompt: prompt,
            model: model,
            runtimeMode: runtime,
            interactionMode: interaction,
            workspaceMode: workspaceMode,
            branch: branch,
            worktreePath: worktreePath,
            startFromOrigin: startFromOrigin,
            attachments: attachments,
            context: context
        )
        let pending: PendingBootstrapSubmission
        let explicitIdentity = submissionIdentity.map { commandIdentity($0) }
        if let explicitIdentity,
           let existing = pendingBootstrapSubmissions.first(where: {
               $0.identity == explicitIdentity
           }) {
            pending = existing
        } else if explicitIdentity == nil,
                  let existing = pendingBootstrapSubmissions.first(where: {
                      $0.signature == signature
                  }) {
            pending = existing
        } else {
            pending = PendingBootstrapSubmission(
                signature: signature,
                threadID: submissionIdentity?.threadID ?? UUID().uuidString,
                identity: explicitIdentity ?? CommandIdentity(),
                worktreeBranchName: workspaceMode == .worktree
                    ? Self.temporaryWorktreeBranchName(
                        seed: submissionIdentity?.threadID
                    )
                    : nil
            )
            pendingBootstrapSubmissions.append(pending)
        }

        do {
            _ = try await client.createThreadAndSend(
                threadID: pending.threadID,
                projectID: route.wireID,
                title: title,
                text: prompt,
                model: model,
                runtimeMode: runtime,
                interactionMode: interaction,
                branch: branch,
                worktreePath: worktreePath,
                worktreePreparation: pending.worktreeBranchName.flatMap { worktreeBranch in
                    branch.map {
                        ThreadWorktreePreparation(
                            projectCwd: routedProject.workspaceRoot,
                            baseBranch: $0,
                            branch: worktreeBranch,
                            startFromOrigin: startFromOrigin
                        )
                    }
                },
                attachments: uploads,
                context: context,
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID,
                createdAt: pending.identity.createdAt
            )
        } catch {
            // A connection can disappear after the server accepted the command
            // but before its reply reaches us. Confirm the original message
            // before recovery. An empty worktree thread can still be in setup.
            let recovered = try await recoverBootstrap(
                client: client,
                pending: pending,
                projectID: route.wireID,
                text: prompt,
                model: model,
                runtimeMode: runtime,
                interactionMode: interaction,
                attachments: uploads,
                context: context
            )
            guard recovered else {
                if pending.worktreeBranchName == nil {
                    await resetFailedLocalBootstrapIfConfirmed(
                        client: client,
                        pending: pending
                    )
                }
                throw error
            }
        }

        registerProvisionalThread(wireID: pending.threadID, environmentID: environment.id)
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        removePendingBootstrap(identity: pending.identity)
        // Dispatch acceptance is the commit point. A dropped refresh must not
        // turn a successful first turn into a retry that creates a duplicate.
        if let refreshedShell = try? await client.shellSnapshot() {
            guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
                throw CancellationError()
            }
            let shell = newestShell(refreshedShell, for: environment)
            await emitSnapshot(shell, client: client, expectedGeneration: generation)
            if let created = shell.threads.first(where: { $0.id == pending.threadID }) {
                provisionalThreadRoutes[FeatureScopedID.thread(
                    environmentID: environment.id,
                    wireID: pending.threadID
                )] = nil
                return mapThread(created, environment: environment)
            }
        }
        return FeatureThread(
            id: FeatureScopedID.thread(
                environmentID: environment.id,
                wireID: pending.threadID
            ),
            wireID: pending.threadID,
            projectID: route.uiID,
            environmentID: environment.id,
            environmentName: environment.label,
            title: title,
            branch: workspaceMode == .worktree ? pending.worktreeBranchName : branch,
            worktreePath: worktreePath,
            providerID: model.instanceId,
            providerName: UsageLimitsPresentation.providerLabel(driver: model.instanceId),
            modelID: model.model,
            modelOptions: mapOptionSelections(model.options),
            runtimeMode: runtimeMode,
            interactionMode: interactionMode.mobileNormalized
        )
    }

    private func recoverBootstrap(
        client: T3Client,
        pending: PendingBootstrapSubmission,
        projectID: String,
        text: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode,
        attachments: [UploadChatImageAttachment],
        context: OrchestrationMessageContext? = nil
    ) async throws -> Bool {
        guard let snapshot = try? await client.threadSnapshot(id: pending.threadID) else {
            return false
        }
        if snapshot.thread.messages.contains(where: {
            $0.id == pending.identity.messageID
        }) {
            return true
        }
        // Setup and its cancellation cleanup own the worktree until the first
        // turn is committed. Sending a bare turn can race either operation.
        guard pending.worktreeBranchName == nil else { return false }
        guard snapshot.thread.projectId == projectID,
              snapshot.thread.deletedAt == nil,
              snapshot.thread.messages.isEmpty else {
            return false
        }

        do {
            _ = try await client.sendTurn(
                threadID: pending.threadID,
                text: text,
                runtimeMode: runtimeMode,
                interactionMode: interactionMode,
                model: model,
                attachments: attachments,
                context: context,
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID,
                createdAt: pending.identity.createdAt
            )
        } catch {
            guard await messageWasCommitted(
                client: client,
                threadID: pending.threadID,
                messageID: pending.identity.messageID
            ) else {
                throw error
            }
        }
        return true
    }

    /// Reset a local retry only when a fresh shell confirms its thread is gone.
    /// Worktree setup and cleanup stay server-owned and keep their stable IDs.
    private func resetFailedLocalBootstrapIfConfirmed(
        client: T3Client,
        pending: PendingBootstrapSubmission
    ) async {
        guard let shell = try? await client.shellSnapshot(),
              !shell.threads.contains(where: { $0.id == pending.threadID }) else {
            return
        }

        removePendingBootstrap(identity: pending.identity)
    }

    private func removePendingBootstrap(identity: CommandIdentity) {
        pendingBootstrapSubmissions.removeAll { $0.identity == identity }
    }

    private func removePendingThreadCreation(threadID: String) {
        pendingThreadCreations.removeAll { $0.threadID == threadID }
    }

    private static func isAmbiguousDispatchFailure(_ error: any Error) -> Bool {
        if error is EnvironmentPermissionDeniedError { return false }
        if let error = error as? RPCError {
            switch error {
            case .connectionUnavailable, .disconnected, .responseTimedOut, .remoteDefect:
                return true
            case .remote, .protocolViolation:
                return false
            }
        }
        if let error = error as? HTTPError {
            switch error {
            case .invalidResponse:
                return true
            case .status, .missingCredential, .incompatibleCredential,
                 .managedAuthorizationUnavailable, .unauthenticatedSession:
                return false
            }
        }
        // URL loading errors and cancellation can happen after the request
        // body crossed the network. Reusing the ID is safe in either case.
        return true
    }

    func renameThread(id: String, title: String) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.rename(threadID: route.wireID, title: title)
        updateCachedArchivedThread(id: route.uiID) { $0.title = title }
        try? await refresh(client: route.client)
    }

    func regenerateThreadTitle(id: String) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.regenerateTitle(threadID: route.wireID)
        try? await refresh(client: route.client)
    }

    func setThreadArchived(id: String, archived: Bool) async throws {
        let route = try threadRoute(for: id)
        let cached = cachedThread(id: route.uiID)
        _ = try await route.client.archive(threadID: route.wireID, archived: archived)
        reconcileArchivedCache(thread: cached, route: route, archived: archived)
        await emitCachedSnapshot(for: route.environmentID)
        try? await refresh(client: route.client, includeArchived: true)
    }

    func setThreadSettled(id: String, settled: Bool) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.settle(threadID: route.wireID, settled: settled)
        try? await refresh(client: route.client)
    }

    func setThreadAutoSettle(id: String, enabled: Bool) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.dispatch(OrchestrationCommands.autoSettle(threadID: route.wireID, enabled: enabled))
        try? await refresh(client: route.client)
    }

    func setThreadSnoozed(id: String, until: Date?) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.snooze(threadID: route.wireID, until: until)
        try? await refresh(client: route.client)
    }

    func setThreadPinned(id: String, pinned: Bool) async throws {
        let route = try threadRoute(for: id)
        // Same placement as web and React Native: a fresh pin takes the top of
        // the arranged run. Servers that predate reordering get the bare pin
        // (keyless, sorted by creation order below keyed threads).
        var orderKey: String? = nil
        if pinned, cachedThread(id: route.uiID)?.supportsPinReorder == true {
            let firstKey = latestSnapshot?.threads
                .filter { $0.pinnedAt != nil }
                .compactMap(\.pinOrderKey)
                .min()
            orderKey = ThreadOrderPlanner.orderKeyBetween(before: nil, after: firstKey)
        }
        _ = try await route.client.pin(threadID: route.wireID, pinned: pinned, orderKey: orderKey)
        try? await refresh(client: route.client)
    }

    /// Saves a full-section order. Cross-section moves first clear the source
    /// lifecycle state. Every key write goes to the thread's owning server.
    @discardableResult
    func reorderThread(
        id: String,
        section: FeatureThreadOrderSection,
        orderedIDs: [String]
    ) async throws -> [FeatureThreadOrderAssignment] {
        guard !threadMoveInFlight else { return [] }
        guard let snapshot = latestSnapshot else {
            throw NativeFeatureClientError.threadNotFound
        }
        // Only currently-connected environments are writable; a disconnected
        // server's rows keep their stale keys as anchors but never receive
        // writes, so a spread rewrite cannot half-land on a dead client.
        let connectedEnvironmentIDs = Set(
            snapshot.environments
                .filter { $0.isEnabled && environmentConnectionStates[$0.id] == .connected }
                .map(\.id)
        )
        let threadsByID = Dictionary(
            snapshot.threads.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let now = Date.now
        let canonical = DailyUXSidebarIndex.orderedSection(snapshot.threads, section: section, now: now)
        guard let moved = threadsByID[id],
              ThreadArrangementPlanner.canEnter(moved, section: section, now: now),
              Set(orderedIDs).count == orderedIDs.count,
              Set(orderedIDs) == Set(canonical.map(\.id)).union([id]),
              let assignments = ThreadOrderPlanner.planDrop(
            ordered: orderedIDs.compactMap { threadsByID[$0] },
            all: snapshot.threads,
            section: section,
            connectedEnvironmentIDs: connectedEnvironmentIDs,
            movedID: id
        ) else {
            return []
        }

        threadMoveInFlight = true
        defer { threadMoveInFlight = false }

        var confirmed: [FeatureThreadOrderAssignment] = []
        var touchedEnvironmentIDs = Set<String>()
        var firstError: Error?
        let crossesSection = !canonical.contains(where: { $0.id == id })
        if crossesSection {
            do {
                let route = try threadRoute(for: id)
                touchedEnvironmentIDs.insert(route.environmentID)
                for action in ThreadArrangementPlanner.lifecycle(moved, section: section, now: now) {
                    switch action {
                    case .pin:
                        let key = assignments.first(where: { $0.threadID == id })?.orderKey
                        _ = try await route.client.pin(threadID: route.wireID, pinned: true, orderKey: key)
                    case .unpin:
                        _ = try await route.client.pin(threadID: route.wireID, pinned: false)
                    case .unsettle:
                        _ = try await route.client.settle(threadID: route.wireID, settled: false)
                    case .unsnooze:
                        _ = try await route.client.snooze(threadID: route.wireID, until: nil)
                    }
                }
            } catch {
                firstError = error
            }
        }
        for assignment in assignments {
            guard firstError == nil else { break }
            do {
                let route = try threadRoute(for: assignment.threadID)
                // Refresh even when the transport lost a receipt after the
                // server accepted the write.
                touchedEnvironmentIDs.insert(route.environmentID)
                switch section {
                case .pinned:
                    _ = try await route.client.reorderPinnedThread(
                        threadID: route.wireID,
                        orderKey: assignment.orderKey
                    )
                case .active:
                    _ = try await route.client.reorderActiveThread(
                        threadID: route.wireID,
                        orderKey: assignment.orderKey
                    )
                }
                confirmed.append(assignment)
            } catch {
                // Confirmed writes stand: a later environment rejecting its
                // write leaves the earlier arrangement in place.
                firstError = error
                break
            }
        }
        for environmentID in touchedEnvironmentIDs {
            if let client = environmentClients[environmentID] {
                try? await refresh(client: client)
            }
        }
        if let firstError {
            guard confirmed.isEmpty else {
                throw FeatureThreadMovePartialError(
                    confirmed: confirmed,
                    underlying: firstError
                )
            }
            throw firstError
        }
        return confirmed
    }

    func setThreadPullRequest(id: String, url: String, linked: Bool) async throws {
        let route = try threadRoute(for: id)
        guard let thread = cachedThread(id: route.uiID),
              thread.supportsMultiplePullRequests == true || thread.supportsPullRequestLinking == true else {
            throw NativeFeatureClientError.invalidPullRequestLink
        }
        let existing = thread.pullRequests?.first { $0.url == url }
        let legacyKey = thread.linkedPullRequest.flatMap { link -> ThreadPullRequestKey? in
            guard link.url == url, let host = URL(string: link.url)?.host else { return nil }
            return ThreadPullRequestKey(host: host, repository: link.repository, number: link.number)
        }
        guard let key = existing?.id ?? ThreadPullRequests.parseURL(url) ?? legacyKey else {
            throw NativeFeatureClientError.invalidPullRequestLink
        }
        let project = latestSnapshot?.projects.first {
            $0.environmentID == route.environmentID
                && $0.repositoryIdentity.map { key.matchesRepository($0.canonicalKey) } == true
        }
        guard let command = ThreadPullRequests.mutation(
            threadID: route.wireID, key: key, url: url, linked: linked,
            multiple: thread.supportsMultiplePullRequests == true,
            legacyProjectID: project.flatMap { projectWireIDs[$0.id] },
            legacyRepository: key.host == "dev.azure.com" ? key.repository.components(separatedBy: "/_git/").last : nil
        ) else { throw NativeFeatureClientError.invalidPullRequestLink }
        _ = try await route.client.dispatch(command)
        try? await refresh(client: route.client)
        if activeThreadID == route.uiID { try? await refreshThread(id: route.uiID, client: route.client) }
    }

    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.setRuntimeMode(
            threadID: route.wireID,
            mode: coreRuntimeMode(mode)
        )
        try? await refresh(client: route.client)
        if activeThreadID == route.uiID {
            try? await refreshThread(id: route.uiID, client: route.client)
        }
    }

    func setInteractionMode(id: String, mode: FeatureInteractionMode) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.setInteractionMode(
            threadID: route.wireID,
            mode: coreInteractionMode(mode)
        )
        try? await refresh(client: route.client)
        if activeThreadID == route.uiID {
            try? await refreshThread(id: route.uiID, client: route.client)
        }
    }

    func deleteThread(id: String) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.delete(threadID: route.wireID)
        if let lease = readCacheLeases[route.environmentID] {
            try? await clientReadCache.remove(threadID: route.wireID, lease: lease)
        }
        archivedThreadsByEnvironmentID[route.environmentID]?.removeAll {
            $0.id == route.uiID
        }
        if let shell = shellsByEnvironmentID[route.environmentID] {
            shellsByEnvironmentID[route.environmentID] = OrchestrationShellSnapshot(
                snapshotSequence: shell.snapshotSequence,
                projects: shell.projects,
                threads: shell.threads.filter { $0.id != route.wireID },
                updatedAt: shell.updatedAt,
                orchestrationProtocolVersion: shell.orchestrationProtocolVersion
            )
        }
        provisionalThreadRoutes[route.uiID] = nil
        if activeThreadID == route.uiID {
            resetDetailRefresh()
            resetDetailStream()
            activeThreadID = nil
            activeThreadEnvironmentID = nil
        }
        latestDetails[route.uiID] = nil
        threadResumeStates[route.uiID] = nil
        detailRenderCaches[route.uiID] = nil
        detailCacheRecency.removeAll { $0 == route.uiID }
        await emitCachedSnapshot(for: route.environmentID)
        try? await refresh(client: route.client, includeArchived: true)
    }

    func loadRelatedThread(id: String, from threadID: String) async throws -> FeatureThreadDetail {
        let origin = try threadRoute(for: threadID)
        let prefix = FeatureScopedID.thread(environmentID: origin.environmentID, wireID: "")
        guard id.hasPrefix(prefix), id.count > prefix.count else {
            throw NativeFeatureClientError.threadNotFound
        }
        let wireID = String(id.dropFirst(prefix.count))
        // Archived or provider-owned children need not be in the inbox shell.
        registerProvisionalThread(wireID: wireID, environmentID: origin.environmentID)
        return try await loadThread(id: id, fresh: true)
    }

    func loadThread(id: String, fresh: Bool) async throws -> FeatureThreadDetail {
        if fresh, threadEnvironmentIDs[id] == nil {
            let environments = try await runtime.environments().filter(\.isEnabled)
            for environment in environments {
                let prefix = FeatureScopedID.thread(environmentID: environment.id, wireID: "")
                guard id.hasPrefix(prefix), id.count > prefix.count else { continue }
                _ = try await projectCreationClient(environmentID: environment.id)
                registerProvisionalThread(wireID: String(id.dropFirst(prefix.count)), environmentID: environment.id)
                break
            }
        }
        let route = try threadRoute(for: id)
        let client = route.client
        let environment = client.environment
        let generation = environmentGeneration
        let cacheLease = readCacheLeases[environment.id]
        retainActiveThread()
        resetDetailRefresh()
        resetDetailStream()
        activeThreadID = route.uiID
        activeThreadEnvironmentID = environment.id
        threadHistoryEpoch &+= 1
        let historyEpoch = threadHistoryEpoch
        pendingOlderThreadPage = nil
        activeThreadPage = nil
        activeRawThread = nil
        activeThreadSequence = nil
        let supportsPagination = serverConfigsByEnvironmentID[
            environment.id
        ]?.threadSnapshotPagination == true
        let supportsResume = serverConfigsByEnvironmentID[
            environment.id
        ]?.threadResumeCompletionMarker == true
        if !fresh, supportsResume,
           let cached = threadResumeStates[route.uiID], cached.client === client,
           cached.page == nil || supportsPagination,
           var detail = latestDetails[route.uiID],
           detailRenderCaches[route.uiID]?.isInitialized == true {
            let currentConnectionID = await client.currentConnectionID()
            guard !Task.isCancelled,
                  isKnownClient(client, environmentID: environment.id, generation: generation),
                  threadHistoryEpoch == historyEpoch,
                  activeThreadID == route.uiID,
                  activeThreadEnvironmentID == environment.id else { throw CancellationError() }
            let warmConnectionID = cached.wasSynchronized
                && cached.connectionID != nil && cached.connectionID == currentConnectionID
                ? currentConnectionID
                : nil
            activeRawThread = cached.thread
            activeThreadSequence = cached.sequence
            activeThreadPage = cached.page
            detail.page = cached.page
            markThreadCacheRecentlyUsed(route.uiID)
            startDetailStream(route, warmConnectionID: warmConnectionID)
            return detail
        }
        if latestDetails[route.uiID] == nil || restoredDetailIDs.contains(route.uiID),
           let lease = cacheLease,
           let saved = await clientReadCache.history(threadID: route.wireID, lease: lease),
           (saved.orchestrationProtocolVersion ?? 1) == (orchestrationVersions[environment.id] ?? 1),
           readCacheLeases[environment.id] == lease,
           isKnownClient(client, environmentID: environment.id, generation: generation),
           threadHistoryEpoch == historyEpoch, activeThreadID == route.uiID {
            var detail = mapDetail(saved.thread, environment: environment, sourceSequence: saved.snapshotSequence)
            // Render historical records without registering stale controls or replay cursors.
            for approval in detail.approvals { approvalRoutes[approval.id] = nil }
            for input in detail.userInputs { inputRoutes[input.id] = nil }
            detail.approvals = []
            detail.userInputs = []
            detail.execution = nil
            detail.workflows = nil
            detail.recovery = nil
            detail.page = nil
            detail.activeSubagentCount = 0
            detail.backgroundWorkIsActive = false
            detail.isCompacting = false
            detailRenderCaches[route.uiID] = nil
            latestDetails[route.uiID] = detail
            restoredDetailIDs.insert(route.uiID)
            startDetailStream(route)
            return detail
        }
        continuation.yield(.threadSync(id: route.uiID, state: .catchingUp))
        let snapshot: OrchestrationThreadDetailSnapshot
        do {
            snapshot = try await client.threadSnapshot(
                id: route.wireID,
                turnLimit: supportsPagination ? Self.initialThreadUserTurnLimit : nil,
                timeoutInterval: threadSnapshotTimeoutInterval
            )
        } catch {
            if !Task.isCancelled, threadHistoryEpoch == historyEpoch,
               activeThreadID == route.uiID {
                continuation.yield(.threadSync(id: route.uiID, state: .failed(error.localizedDescription)))
                // A failed HTTP request must not prevent the socket snapshot
                // from recovering this thread when the connection returns.
                startDetailStream(route)
            }
            throw error
        }
        guard isKnownClient(client, environmentID: environment.id, generation: generation),
              threadHistoryEpoch == historyEpoch,
              activeThreadID == route.uiID,
              activeThreadEnvironmentID == environment.id else {
            throw CancellationError()
        }
        restoredDetailIDs.remove(route.uiID)
        expandedHistoryIDs.remove(route.uiID)
        saveReadHistory(snapshot, environmentID: environment.id, lease: cacheLease)
        activeThreadPage = featurePage(snapshot.page)
        let detail = mapDetail(
            snapshot.thread,
            environment: environment,
            sourceSequence: snapshot.snapshotSequence,
            page: activeThreadPage
        )
        activeRawThread = snapshot.thread
        activeThreadSequence = snapshot.snapshotSequence
        latestDetails[route.uiID] = detail
        startDetailStream(route)
        if !supportsResume { markDetailSynchronized(route) }
        return detail
    }

    func loadEarlierThreadTurns(id: String) async throws -> FeatureThreadDetail? {
        let route = try threadRoute(for: id)
        guard activeThreadID == route.uiID,
              activeThreadEnvironmentID == route.environmentID,
              serverConfigsByEnvironmentID[
                  route.environmentID
              ]?.threadSnapshotPagination == true,
              var page = activeThreadPage,
              page.hasMore,
              !page.isLoading,
              let beforeCursor = page.beforeCursor else {
            return latestDetails[id]
        }

        let generation = environmentGeneration
        let epoch = threadHistoryEpoch
        let loadedSequence = activeThreadSequence ?? 0
        expandedHistoryIDs.insert(route.uiID)
        page.isLoading = true
        activeThreadPage = page
        publishActivePageState(threadID: route.uiID)

        do {
            let snapshot = try await route.client.threadSnapshot(
                id: route.wireID,
                turnLimit: Self.olderThreadPageUserTurnLimit,
                beforeCursor: beforeCursor
            )
            guard isKnownClient(
                route.client,
                environmentID: route.environmentID,
                generation: generation
            ), activeThreadID == route.uiID else {
                throw CancellationError()
            }
            guard threadHistoryEpoch == epoch,
                  snapshot.snapshotSequence >= loadedSequence else {
                clearOlderThreadLoading(threadID: route.uiID)
                return latestDetails[route.uiID]
            }

            if snapshot.orchestrationProtocolVersion == 2 {
                consumeDetailStreamItem(.projection(snapshot), route: route,
                                        subscriptionEpoch: epoch, synchronizeLegacy: false)
                flushDetailPublish(route)
                return latestDetails[route.uiID]
            }

            if let watermark = snapshot.page?.threadSequence,
               watermark > (activeThreadSequence ?? 0) {
                pendingOlderThreadPage = PendingOlderThreadPage(
                    snapshot: snapshot,
                    epoch: epoch,
                    threadID: route.uiID,
                    environmentID: route.environmentID
                )
                return latestDetails[route.uiID]
            }
            return mergeOlderThreadPage(snapshot, route: route)
        } catch {
            if activeThreadID == route.uiID, threadHistoryEpoch == epoch {
                clearOlderThreadLoading(threadID: route.uiID)
            }
            throw error
        }
    }

    func releaseThread(id: String) {
        guard activeThreadID == id else { return }
        retainActiveThread()
        resetDetailRefresh()
        resetDetailStream()
        activeThreadID = nil
        activeThreadEnvironmentID = nil
        activeRawThread = nil
        activeThreadSequence = nil
        activeThreadPage = nil
        threadHistoryEpoch &+= 1
        pendingOlderThreadPage = nil
        continuation.yield(.threadSync(id: id, state: nil))
        markThreadCacheRecentlyUsed(id)
        evictOldThreadCachesIfNeeded()
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity,
        context: OrchestrationMessageContext? = nil
    ) async throws {
        try await sendMessage(
            threadID: threadID, text: text, selection: selection, runtimeMode: runtimeMode,
            attachments: attachments, identity: identity, context: context, delivery: .auto
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity,
        context: OrchestrationMessageContext? = nil,
        delivery: FeatureMessageDelivery
    ) async throws {
        try await sendMessage(
            threadID: threadID, text: text, selection: selection, runtimeMode: runtimeMode,
            interactionMode: nil, attachments: attachments, identity: identity,
            context: context, delivery: delivery
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode?,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity,
        context: OrchestrationMessageContext? = nil,
        delivery: FeatureMessageDelivery = .auto
    ) async throws {
        try await sendMessageResolved(
            threadID: threadID,
            text: text,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            attachments: attachments,
            submissionIdentity: identity,
            context: context,
            delivery: delivery
        )
    }

    private func sendMessageResolved(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode requestedRuntimeMode: FeatureRuntimeMode?,
        interactionMode requestedInteractionMode: FeatureInteractionMode? = nil,
        attachments: [FeatureUploadAttachment],
        submissionIdentity: FeatureSubmissionIdentity?,
        context: OrchestrationMessageContext? = nil,
        delivery: FeatureMessageDelivery = .auto
    ) async throws {
        let route = try threadRoute(for: threadID)
        let client = route.client
        let environmentID = route.environmentID
        let generation = environmentGeneration
        guard let shellThread = shellsByEnvironmentID[environmentID]?.threads
            .first(where: { $0.id == route.wireID }) else {
            throw NativeFeatureClientError.threadNotFound
        }
        let model = selection.map(coreModelSelection)
        let uploads = try await makeUploadAttachments(attachments)
        if !uploads.isEmpty { _ = try await client.serverConfig() }
        let runtimeMode = coreRuntimeMode(
            requestedRuntimeMode ?? mapRuntimeMode(shellThread.runtimeMode)
        )
        let interactionMode = requestedInteractionMode.map(coreInteractionMode) ?? shellThread.interactionMode
        let coreDelivery: OrchestrationV2Commands.Delivery = switch delivery {
        case .auto: .auto
        case .queue: .queue
        case .steer: .steer
        case .restart: .restart
        }
        let signature = TurnSubmissionSignature(
            text: text,
            model: model,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            attachments: attachments,
            context: context,
            delivery: delivery
        )
        let pending: PendingTurnSubmission
        let explicitIdentity = submissionIdentity.map { commandIdentity($0) }
        if let explicitIdentity,
           let existing = pendingTurnSubmissions[route.uiID],
           existing.identity == explicitIdentity {
            pending = existing
        } else if explicitIdentity == nil,
                  let existing = pendingTurnSubmissions[route.uiID],
                  existing.signature == signature {
            pending = existing
        } else {
            pending = PendingTurnSubmission(
                signature: signature,
                identity: explicitIdentity ?? CommandIdentity()
            )
            pendingTurnSubmissions[route.uiID] = pending
        }

        do {
            _ = try await client.sendTurn(
                threadID: submissionIdentity?.threadID ?? route.wireID,
                text: text,
                runtimeMode: runtimeMode,
                interactionMode: interactionMode,
                model: model,
                attachments: uploads,
                context: context,
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID,
                createdAt: pending.identity.createdAt,
                delivery: coreDelivery
            )
        } catch {
            guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
                throw CancellationError()
            }
            guard await messageWasCommitted(
                client: client,
                threadID: submissionIdentity?.threadID ?? route.wireID,
                messageID: pending.identity.messageID
            ) else {
                // Keep the stable identity. Retrying the same restored draft
                // cannot enqueue a duplicate turn after an ambiguous failure.
                throw error
            }
        }
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        if pendingTurnSubmissions[route.uiID]?.identity == pending.identity {
            pendingTurnSubmissions[route.uiID] = nil
        }
        // Live sync reconciles these snapshots. Refreshes are opportunistic
        // after the accepted command so transient reads cannot invite a
        // duplicate user turn.
        try? await refreshThread(id: route.uiID, client: client)
        try? await refresh(client: client)
    }

    private func messageWasCommitted(
        client: T3Client,
        threadID: String,
        messageID: String
    ) async -> Bool {
        guard let snapshot = try? await client.threadSnapshot(id: threadID) else {
            return false
        }
        if snapshot.thread.messages.contains(where: { $0.id == messageID }) { return true }
        // V2 holds accepted queue messages outside the shared transcript until they start.
        if case let .array(messages)? = snapshot.thread.orchestrationV2Control?["messages"] {
            return messages.contains { $0["id"]?.stringValue == messageID }
        }
        return false
    }

    func restartAgentSession(threadID: String) async throws {
        let route = try threadRoute(for: threadID)
        guard let thread = shellsByEnvironmentID[route.environmentID]?.threads.first(where: { $0.id == route.wireID }) else {
            throw NativeFeatureClientError.threadNotFound
        }
        let context = try workspaceContext(route: route)
        if let session = thread.session, session.status != "stopped" {
            _ = try await route.client.dispatch(OrchestrationCommands.stopSession(threadID: route.wireID))
        }
        _ = try await refreshProviderCatalog(environmentID: route.environmentID, cwd: context.cwd,
            instanceID: thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
            refreshModels: false, fresh: true)
        try? await refresh(client: route.client)
    }

    func cancelTurn(threadID: String) async throws {
        let route = try threadRoute(for: threadID)
        try await requireScope("orchestration:operate", client: route.client)
        let version = try await route.client.orchestrationVersion()
        let turnID = version == .v2 ? nil : shellsByEnvironmentID[route.environmentID]?.threads
            .first(where: { $0.id == route.wireID })?
            .latestTurn?
            .turnId
        _ = try await route.client.interrupt(threadID: route.wireID, turnID: turnID)
        try? await refresh(client: route.client)
    }

    func canRewindConversation(threadID: String, messageID: String) -> Bool {
        guard let route = try? threadRoute(for: threadID),
              let thread = activeThreadID == route.uiID
                ? activeRawThread : threadResumeStates[route.uiID]?.thread,
              let provider = serverConfigsByEnvironmentID[route.environmentID]?.providers.first(where: {
                  $0.instanceId == (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId)
              }),
              provider.supportsConversationRollback != false,
              provider.driver != "cursor", provider.driver != "grok" else { return false }
        return NativeConversationRewind.canRewind(before: messageID, in: thread)
    }

    func rewindConversation(
        threadID: String, messageID: String,
        prepareRecovery: @MainActor (FeatureRevertedMessage) async throws -> Void
    ) async throws {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        // The visible page can omit checkpoints. Validate against the whole thread.
        let snapshot = try await route.client.fullThreadSnapshot(id: route.wireID)
        guard let provider = serverConfigsByEnvironmentID[route.environmentID]?.providers.first(where: {
            $0.instanceId == (snapshot.thread.session?.providerInstanceId ?? snapshot.thread.modelSelection.instanceId)
        }), provider.supportsConversationRollback != false,
              provider.driver != "cursor", provider.driver != "grok" else {
            throw FeatureCapabilityUnavailable("Conversation rewind for this provider")
        }
        guard snapshot.thread.session?.status != "running",
              snapshot.thread.session?.status != "starting",
              let original = snapshot.thread.messages.first(where: { $0.id == messageID }) else {
            throw FeatureConversationRewindError(message: "Wait for this turn to finish before rewinding.")
        }
        let target = try NativeConversationRewind.target(before: messageID, in: snapshot.thread)
        let message = mapMessage(original, environmentID: route.environmentID)
        let fileStore = ManagedAttachmentFileStore()
        var attachments: [FeatureDraftAttachment] = []
        var recoveryIsStored = false
        defer {
            if !recoveryIsStored {
                for attachment in attachments {
                    if let file = attachment.ownedFile {
                        try? fileStore.removeOwnedFile(fileName: file.fileName)
                    }
                }
            }
        }
        // Rewind removes the old server assets, even when workspace files are kept.
        for attachment in message.attachments {
            let url = try await attachmentAssetURL(threadID: route.uiID, attachment: attachment)
            let (temporaryURL, response) = try await URLSession.shared.download(from: url)
            defer { try? FileManager.default.removeItem(at: temporaryURL) }
            guard let response = response as? HTTPURLResponse,
                  (200..<300).contains(response.statusCode) else {
                throw FeatureConversationRewindError(message: "Could not save \(attachment.name) before rewind.")
            }
            let id = UUID()
            let file = try await Task.detached {
                try fileStore.copyOwnedFile(
                    from: temporaryURL, attachmentID: id, originalFileName: attachment.name
                )
            }.value
            attachments.append(FeatureDraftAttachment(
                id: id, ownedFile: file, filename: attachment.name, mimeType: attachment.mimeType,
                source: attachment.source
            ))
        }
        try await prepareRecovery(FeatureRevertedMessage(message: message, attachments: attachments))
        recoveryIsStored = true
        let subscription: (events: AsyncThrowingStream<[ThreadStreamItem], Error>, connectionID: UUID)
        do {
            try Task.checkCancellation()
            guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
                throw CancellationError()
            }
            subscription = try await route.client.threadEventBatches(
                threadID: route.wireID, after: snapshot.snapshotSequence
            )
        } catch {
            throw FeatureConversationRewindError(message: error.localizedDescription, didNotRevert: true)
        }
        // Keep events that arrive before dispatch replies. The pump owns socket
        // cancellation even when dispatch rejects before completion tracking starts.
        let buffered = AsyncThrowingStream<[ThreadStreamItem], Error>.makeStream(bufferingPolicy: .bufferingOldest(64))
        let pump = Task {
            do {
                for try await batch in subscription.events {
                    if case .dropped = buffered.continuation.yield(batch) {
                        throw FeatureConversationRewindError(message: "Rewind updates fell behind. Reload the thread to check its history.")
                    }
                }
                buffered.continuation.finish()
            } catch {
                buffered.continuation.finish(throwing: error)
            }
        }
        defer {
            pump.cancel()
            buffered.continuation.finish()
        }
        do {
            let accepted: DispatchResult
            let command = target.command(threadID: route.wireID)
            do {
                accepted = try await route.client.dispatch(command)
            } catch let error as RPCError {
                if case .remote = error {
                    throw FeatureConversationRewindError(message: error.localizedDescription, didNotRevert: true)
                }
                throw error
            } catch let error as HTTPError {
                if case let .status(code, _, _) = error, (400..<500).contains(code) {
                    throw FeatureConversationRewindError(message: error.localizedDescription, didNotRevert: true)
                }
                throw error
            } catch let error as EnvironmentPermissionDeniedError {
                throw FeatureConversationRewindError(message: error.localizedDescription, didNotRevert: true)
            } catch let error as OrchestrationV2Commands.AdapterError {
                throw FeatureConversationRewindError(message: error.localizedDescription, didNotRevert: true)
            } catch let error as OrchestrationV2Commands.RollbackError {
                throw FeatureConversationRewindError(message: error.localizedDescription, didNotRevert: true)
            }
            let receiptSequence = try await NativeConversationRewind.waitForCompletion(
                batches: buffered.stream,
                threadID: route.wireID,
                messageID: messageID,
                turnCount: target.turnCount,
                afterSequence: accepted.sequence,
                previousFailureIDs: Set(snapshot.thread.activities.filter {
                    $0.kind == "checkpoint.revert.failed"
                }.map(\.id)),
                rollbackRequestID: command["commandId"]?.stringValue,
                rollbackRunID: target.runID
            )
            let current = try await route.client.fullThreadSnapshot(id: route.wireID)
            guard current.snapshotSequence >= receiptSequence,
                  NativeConversationRewind.isComplete(current.thread, messageID: messageID,
                    turnCount: target.turnCount, rollbackRunID: target.runID) else {
                throw FeatureConversationRewindError(message: "Could not confirm the final rewind state. The prompt remains saved for recovery.")
            }
        } catch {
            if (error as? FeatureConversationRewindError)?.didNotRevert == true { throw error }
            // A lost socket does not mean rollback failed. An HTTP read can
            // confirm completion without submitting the destructive command again.
            guard let current = try? await route.client.fullThreadSnapshot(id: route.wireID),
                  current.snapshotSequence > snapshot.snapshotSequence,
                  NativeConversationRewind.isComplete(current.thread, messageID: messageID,
                    turnCount: target.turnCount, rollbackRunID: target.runID) else {
                throw error
            }
        }
        // Do not turn a failed refresh into a failed rewind. The receipt confirms
        // that history changed, so the recovered prompt must still reach the draft.
        threadResumeStates[route.uiID] = nil
        do {
            try await refreshThread(id: route.uiID, client: route.client)
        } catch {
            continuation.yield(.threadSync(id: route.uiID, state: .failed(error.localizedDescription)))
        }
    }

    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws {
        guard let request = approvalRoutes[id] else {
            throw NativeFeatureClientError.approvalNotFound
        }
        let route = try threadRoute(for: request.threadID)
        _ = try await route.client.respondToApproval(
            threadID: route.wireID,
            requestID: request.wireID,
            decision: decision.wireValue
        )
        approvalRoutes[id] = nil
        removeCachedApproval(id: id, threadID: route.uiID)
        await refreshThreadUnlessLive(id: route.uiID, client: route.client)
    }

    func resolveUserInput(
        id: String, answers: [String: FeatureInputAnswer],
        attachmentsByQuestionID: [String: [FeatureUploadAttachment]]
    ) async throws {
        guard let request = inputRoutes[id] else {
            throw NativeFeatureClientError.inputRequestNotFound
        }
        let route = try threadRoute(for: request.threadID)
        var uploads: [String: [UploadChatAttachment]] = [:]
        for (questionID, attachments) in attachmentsByQuestionID {
            uploads[questionID] = try await makeUploadAttachments(attachments)
        }
        _ = try await route.client.respondToUserInput(
            threadID: route.wireID,
            requestID: request.wireID,
            answers: answers.mapValues(\.jsonValue),
            attachmentsByQuestionID: uploads
        )
        inputRoutes[id] = nil
        removeCachedInput(id: id, threadID: route.uiID)
        await refreshThreadUnlessLive(id: route.uiID, client: route.client)
    }

    func dismissUserInput(id: String) async throws {
        guard let request = inputRoutes[id],
              detailRenderCaches[request.threadID]?.userInputs.first(where: { $0.id == id })?.canDismiss == true else {
            throw NativeFeatureClientError.inputRequestNotFound
        }
        let route = try threadRoute(for: request.threadID)
        _ = try await route.client.dismissUserInput(threadID: route.wireID, requestID: request.wireID)
        inputRoutes[id] = nil
        removeCachedInput(id: id, threadID: route.uiID)
        await refreshThreadUnlessLive(id: route.uiID, client: route.client)
    }

    func saveSettings(_ settings: FeatureSettings) async throws {
        let data = try JSONEncoder().encode(settings)
        settingsStore.set(data, forKey: Self.settingsKey)
        cachedSettings = settings
        latestSnapshot?.settings = settings
    }

    func setProviderEnabled(environmentID: String, instanceID: String, enabled: Bool) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await requireScope("providers:manage", client: client)
        try (environmentPermissions[environmentID] ?? EnvironmentPermissionState()).require("settings:write")
        let config = try await client.serverConfig()
        guard let provider = config.providers.first(where: { $0.instanceId == instanceID }), provider.driver == "antigravity" else {
            throw FeatureCapabilityUnavailable("Provider settings")
        }
        try await client.setProviderEnabled(instanceID: instanceID, driver: provider.driver, enabled: enabled)
    }

    func updateProvider(environmentID: String, instanceID: String) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await requireScope("providers:manage", client: client)
        let config = try await client.serverConfig()
        guard let provider = config.providers.first(where: { $0.instanceId == instanceID }),
              provider.versionAdvisory?.canUpdate == true else {
            throw FeatureCapabilityUnavailable("Provider updates")
        }
        try await client.updateProvider(instanceID: instanceID, driver: provider.driver)
        try await refresh(client: client)
    }

    func providerSetup(environmentID: String, instanceID: String, action: ProviderSetupAction) async throws -> ProviderSetupEvent {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await requireScope("providers:manage", client: client)
        return try await client.providerSetup(instanceID: instanceID, action: action)
    }

    func providerSetupEvents(environmentID: String, instanceID: String) -> AsyncThrowingStream<ProviderSetupEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let client = try await projectCreationClient(environmentID: environmentID)
                    try await requireScope("providers:manage", client: client)
                    let config = try await client.serverConfig()
                    let provider = config.providers.first { $0.instanceId == instanceID }
                    let setup = provider?.setup
                    try await withThrowingTaskGroup(of: Void.self) { group in
                        if let provider, ProviderAccountDiscovery.isSupported(
                            driver: provider.driver, installed: provider.installed, setup: setup
                        ) {
                            group.addTask {
                                for try await state in await client.providerAuthEvents(instanceID: instanceID) {
                                    continuation.yield(.auth(state))
                                }
                            }
                        }
                        if setup?.canInstall == true {
                            group.addTask {
                                for try await state in await client.providerInstallEvents(instanceID: instanceID) {
                                    continuation.yield(.install(state))
                                }
                            }
                        }
                        try await group.waitForAll()
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func refreshProviders(environmentID: String) async throws -> [FeatureProvider] {
        try await refreshProviderCatalog(environmentID: environmentID, cwd: nil, refreshModels: true)
    }

    func refreshWorkspaceProviders(environmentID: String, cwd: String, instanceID: String) async throws -> [FeatureProvider] {
        let key = FeatureWorkspaceProviderFreshness.Key(environmentID: environmentID, cwd: cwd, instanceID: instanceID)
        let config = serverConfigsByEnvironmentID[environmentID]
        let workspace = config?.providers.first(where: { $0.instanceId == instanceID })?
            .workspaceSnapshots?.first(where: { $0.cwd == cwd })
        guard workspaceProviderFreshness.beginRefresh(
            key: key, checkedAt: workspace.flatMap { NativeTimestampParser.parse($0.checkedAt) },
            commandsPending: workspace?.slashCommandsPending == true, now: Date()
        ) else {
            if let config { return mapConfigProviders(config.providers) }
            return providerCatalogCache[environmentID] ?? []
        }
        do {
            let providers = try await refreshProviderCatalog(environmentID: environmentID, cwd: cwd,
                instanceID: instanceID, refreshModels: false)
            let refreshed = serverConfigsByEnvironmentID[environmentID]?.providers
                .first(where: { $0.instanceId == instanceID })?.workspaceSnapshots?.first(where: { $0.cwd == cwd })
            workspaceProviderFreshness.finishRefresh(key: key,
                complete: refreshed != nil && refreshed?.slashCommandsPending != true, now: Date())
            return providers
        } catch {
            workspaceProviderFreshness.finishRefresh(key: key, complete: false, now: Date())
            throw error
        }
    }

    private func refreshProviderCatalog(environmentID: String, cwd: String?, instanceID: String? = nil, refreshModels: Bool, fresh: Bool = false) async throws -> [FeatureProvider] {
        let client = try await projectCreationClient(environmentID: environmentID)
        let generation = environmentGeneration
        let config = try await client.refreshProviders(cwd: cwd, instanceID: instanceID, refreshModels: refreshModels, fresh: fresh)
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        setServerConfig(config, environmentID: environmentID)
        if environmentID == activeEnvironment?.id { latestServerConfig = config }
        let providers = mapConfigProviders(config.providers)
        providerCatalogCache[environmentID] = providers
        if let shell = shellsByEnvironmentID[environmentID] {
            await emitSnapshot(shell, client: client, expectedGeneration: generation)
        }
        return providers
    }

    func updateAutomaticSettlement(
        environmentID: String,
        change: FeatureAutomaticSettlementChange
    ) async throws -> FeatureAutomaticSettlementSettings {
        if case let .afterDays(days) = change,
           let days,
           !(1...90).contains(days) {
            throw NativeFeatureClientError.invalidAutomaticSettlementDays
        }

        let client = try await projectCreationClient(environmentID: environmentID)
        let previous = serverConfigsByEnvironmentID[environmentID]
        let capabilities = previous?.environment?.capabilities
            ?? client.environment.descriptor?.capabilities
        guard capabilities?.threadAutoSettlement == true else {
            throw FeatureCapabilityUnavailable("Automatic settlement settings")
        }

        let serverChange: ServerSettingsChange = switch change {
        case let .onMerge(value): .sidebarAutoSettleOnMerge(value)
        case let .afterDays(value): .sidebarAutoSettleAfterDays(value)
        }
        let settings = try await saveServerPreferences(client: client, environmentID: environmentID, change: serverChange)
        await fanOutSharedPreferences(from: environmentID, change: serverChange)
        return FeatureAutomaticSettlementSettings(
            onMerge: settings.sidebarAutoSettleOnMerge,
            afterDays: settings.sidebarAutoSettleAfterDays
        )
    }

    func serverPreferences(environmentID: String) async throws -> ServerSettingsSnapshot {
        if let settings = serverConfigsByEnvironmentID[environmentID]?.settings { return settings }
        let client = try await projectCreationClient(environmentID: environmentID)
        guard let settings = try await client.serverConfig().settings else {
            throw FeatureCapabilityUnavailable("Server preferences")
        }
        return settings
    }

    func sharedPreferenceMismatches(environmentID: String) -> [String] {
        guard let source = serverConfigsByEnvironmentID[environmentID]?.settings else { return [] }
        return sharedPreferenceTargetIDs.filter { id in
            guard id != environmentID,
                  let target = serverConfigsByEnvironmentID[id]?.settings else { return false }
            let supportsRestart = supportsRestartContinuation(environmentID: environmentID)
                && supportsRestartContinuation(environmentID: id)
            let unsupported = source.unsupportedPreferenceKeys.union(target.unsupportedPreferenceKeys)
            guard case let .object(sourcePatch) = source.sharedPatch(supportsRestartContinuation: supportsRestart),
                  case let .object(targetPatch) = target.sharedPatch(supportsRestartContinuation: supportsRestart) else { return false }
            return sourcePatch.filter { !unsupported.contains($0.key) }
                != targetPatch.filter { !unsupported.contains($0.key) }
        }.map { id in latestSnapshot?.environments.first { $0.id == id }?.name ?? id }
    }

    func projectPreferences(projectID: String) async throws -> FeatureProjectPreferences {
        let route = try projectRoute(for: projectID)
        let settings = try await serverPreferences(environmentID: route.environmentID)
        let project = try project(for: route)
        let providers = serverConfigsByEnvironmentID[route.environmentID]?.providers ?? []
        return FeatureProjectPreferences(
            environment: settings,
            effective: settings.resolvingProject(
                id: route.wireID, legacyModelSelection: project.defaultModelSelection,
                legacyWorkspaceMode: project.defaultThreadEnvMode,
                disabledProviderIDs: Set(providers.filter { !providerCanRun($0) }.map(\.instanceId))
            )
        )
    }

    func updateProjectPreferences(projectID: String, change: ServerProjectSettingChange) async throws {
        // Entries replace the entire project's overrides. Serialize local edits
        // and read the latest entry only after the previous write completes.
        let predecessor = projectSettingsWriteTask
        let write = Task { @MainActor [self] in
            if let predecessor { _ = try? await predecessor.value }
            let route = try projectRoute(for: projectID)
            let generation = environmentGeneration
            let config = try await route.client.serverConfig()
            guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
                throw CancellationError()
            }
            guard config.environment?.capabilities.projectSettingsOverrides == true else {
                throw FeatureCapabilityUnavailable("Project preferences")
            }
            let settings = try await route.client.serverSettings()
            guard !settings.unsupportedPreferenceKeys.contains(change.key.rawValue) else {
                throw FeatureCapabilityUnavailable("This project preference")
            }
            if change.key == .responseStreamingMode, settings.responseStreamingMode == nil {
                throw FeatureCapabilityUnavailable("Response streaming preferences")
            }
            if change.key == .continueThreadsAfterServerUpdate,
               config.environment?.capabilities.threadRestartContinuation != true {
                throw FeatureCapabilityUnavailable("Restart continuation")
            }
            _ = try await saveServerPreferences(
                client: route.client, environmentID: route.environmentID,
                change: change.patch(projectID: route.wireID, settings: settings)
            )
        }
        projectSettingsWriteGeneration &+= 1
        let generation = projectSettingsWriteGeneration
        projectSettingsWriteTask = write
        defer {
            if projectSettingsWriteGeneration == generation { projectSettingsWriteTask = nil }
        }
        try await write.value
    }

    private func supportsRestartContinuation(environmentID: String) -> Bool {
        serverConfigsByEnvironmentID[environmentID]?.environment?.capabilities.threadRestartContinuation == true
    }

    private var sharedPreferenceTargetIDs: [String] {
        serverConfigsByEnvironmentID.keys.filter { id in
            environmentConnectionStates[id] == .connected
                && serverConfigsByEnvironmentID[id]?.environment?.capabilities.threadAutoSettlement == true
                && serverConfigsByEnvironmentID[id]?.settings != nil
        }.sorted()
    }

    func updateServerPreferences(environmentID: String, change: ServerSettingsChange) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        let generation = environmentGeneration
        let config = try await client.serverConfig()
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        setServerConfig(config, environmentID: environmentID)
        switch change {
        case .defaultRuntimeMode, .defaultAutoPull, .branchNamingMode, .branchNamePrefix,
             .branchNameInstructions, .enableAgentBrowserAccess, .enableProviderUpdateChecks,
             .autoResumeLimitedThreads, .snoozeLimitedThreads:
            guard config.settings != nil else { throw FeatureCapabilityUnavailable("Server preferences") }
        case .worktreesDirectory:
            guard config.environment?.capabilities.worktreesDirectory == true,
                  config.settings?.worktreesDirectory != nil else { throw FeatureCapabilityUnavailable("Worktree directory") }
        case .removeAgentCreditsOnMerge:
            guard config.settings?.removeAgentCreditsOnMerge != nil else { throw FeatureCapabilityUnavailable("Merge credits") }
        case .worktreeSubmodules:
            guard config.settings?.supportsWorktreeSubmodules == true else { throw FeatureCapabilityUnavailable("Submodule settings") }
        case .storageCleanup, .worktreeCleanup:
            guard config.settings?.storageCleanup != nil else { throw FeatureCapabilityUnavailable("Storage cleanup settings") }
        case .responseStreamingMode:
            guard config.settings?.responseStreamingMode != nil else {
                throw FeatureCapabilityUnavailable("Response streaming preferences")
            }
        case .projectSettingsOverrides:
            guard config.environment?.capabilities.projectSettingsOverrides == true else {
                throw FeatureCapabilityUnavailable("Project preferences")
            }
        case .environmentIcon:
            guard config.environment?.capabilities.environmentIcon == true else {
                throw FeatureCapabilityUnavailable("Environment icons")
            }
        case .continueThreadsAfterServerUpdate:
            guard config.environment?.capabilities.threadRestartContinuation == true else {
                throw FeatureCapabilityUnavailable("Restart continuation")
            }
        default:
            guard config.environment?.capabilities.threadAutoSettlement == true else {
                throw FeatureCapabilityUnavailable("Shared preferences")
            }
        }
        guard let supportedChange = NativeSharedPreferenceChange.filter(
            change,
            supportsRestartContinuation: supportsRestartContinuation(environmentID: environmentID),
            settings: config.settings
        ) else { throw FeatureCapabilityUnavailable("This server preference") }
        _ = try await saveServerPreferences(client: client, environmentID: environmentID, change: supportedChange)
        switch supportedChange {
        case .environmentIcon, .projectSettingsOverrides, .responseStreamingMode, .worktreeSubmodules, .worktreesDirectory, .storageCleanup, .worktreeCleanup: return
        default: break
        }
        await fanOutSharedPreferences(from: environmentID, change: supportedChange)
    }

    private func fanOutSharedPreferences(from sourceID: String, change: ServerSettingsChange) async {
        let sourceSupportsRestart = supportsRestartContinuation(environmentID: sourceID)
        for id in sharedPreferenceTargetIDs where id != sourceID {
            guard let targetChange = NativeSharedPreferenceChange.filter(
                change,
                supportsRestartContinuation: sourceSupportsRestart
                    && supportsRestartContinuation(environmentID: id),
                settings: serverConfigsByEnvironmentID[id]?.settings
            ) else { continue }
            do {
                let client = try await projectCreationClient(environmentID: id)
                _ = try await saveServerPreferences(client: client, environmentID: id, change: targetChange)
            } catch {
                // Keep the last real settings so the mismatch remains visible and can be retried.
            }
        }
    }

    func saveServerPreferences(client: T3Client, environmentID: String, change: ServerSettingsChange) async throws -> ServerSettingsSnapshot {
        let generation = environmentGeneration
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        for permission in EnvironmentPermissionRequirements.settingsPatch(change.jsonValue.v2Object) {
            try await requireScope(permission, client: client)
        }
        let settings = try await client.updateSettings(change)
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        var config = serverConfigsByEnvironmentID[environmentID] ?? ServerConfigSnapshot(providers: [])
        config.settings = settings
        setServerConfig(config, environmentID: environmentID)
        if environmentID == activeEnvironment?.id {
            latestServerConfig = config
        }
        if let shell = shellsByEnvironmentID[environmentID] {
            await emitSnapshot(shell, client: client, expectedGeneration: generation)
        }
        return settings
    }

    var managesServerSessions: Bool {
        !t3ConnectDeviceManager.hasActiveAccount
    }

    func loadDeviceSessions() async throws -> [FeatureDeviceSession] {
        if t3ConnectDeviceManager.hasActiveAccount {
            let devices = try await t3ConnectDeviceManager.registeredDevices()
            relayDeviceSessionIDs = Set(devices.map(\.deviceId))
            return devices.map {
                FeatureDeviceSession(
                    relayDevice: $0,
                    currentDeviceID: t3ConnectDeviceManager.currentRegisteredDeviceID
                )
            }
        }

        relayDeviceSessionIDs.removeAll()
        let client = try requireClient()
        try await requireScope("access:read", client: client)
        return try await client.clientSessions().map { session in
            FeatureDeviceSession(
                sessionID: session.sessionId,
                label: session.client.label,
                deviceType: FeatureDeviceType(rawValue: session.client.deviceType) ?? .unknown,
                operatingSystem: session.client.os,
                browser: session.client.browser,
                ipAddress: session.client.ipAddress,
                issuedAt: parseDate(session.issuedAt),
                expiresAt: parseDate(session.expiresAt),
                lastConnectedAt: session.lastConnectedAt.map(parseDate),
                isConnected: session.connected,
                isCurrent: session.current
            )
        }
    }

    func revokeDeviceSession(id: String) async throws {
        if relayDeviceSessionIDs.contains(id) {
            try await t3ConnectDeviceManager.unregisterDevice(id: id)
            relayDeviceSessionIDs.remove(id)
            return
        }

        let client = try requireClient()
        try await requireScope("access:write", client: client)
        guard try await client.revokeClientSession(id: id) else {
            throw NativeFeatureClientError.deviceSessionNotFound
        }
    }

    func revokeOtherDeviceSessions() async throws {
        if !relayDeviceSessionIDs.isEmpty {
            guard let currentID = t3ConnectDeviceManager.currentRegisteredDeviceID else {
                throw NativeFeatureClientError.currentDeviceUnknown
            }
            let otherIDs = relayDeviceSessionIDs.filter { $0 != currentID }
            for id in otherIDs {
                try await t3ConnectDeviceManager.unregisterDevice(id: id)
            }
            relayDeviceSessionIDs.subtract(otherIDs)
            return
        }

        let client = try requireClient()
        try await requireScope("access:write", client: client)
        _ = try await client.revokeOtherClientSessions()
    }

    func listFiles(threadID: String, path: String?) async throws -> [FeatureFileEntry] {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(["filesystem:read"], client: route.client, generation: generation)
        let context = try workspaceContext(route: route)
        let directory = NativeWorkspaceMapper.directoryPath(path, workspaceRoot: context.cwd)
        let result = try await route.client.listProjectEntries(
            cwd: context.cwd,
            directoryPath: directory
        )
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation),
              try workspaceContext(route: route).cwd == context.cwd else {
            throw CancellationError()
        }
        return NativeWorkspaceMapper.files(result.entries, directory: directory, workspaceRoot: context.cwd)
    }

    func searchProjectFiles(
        projectID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        let route = try projectRoute(for: projectID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(["filesystem:read"], client: route.client, generation: generation)
        let project = try project(for: route)
        let result = try await route.client.searchProjectEntries(
            cwd: project.workspaceRoot,
            query: query,
            limit: limit
        )
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation),
              try self.project(for: route).workspaceRoot == project.workspaceRoot else {
            throw CancellationError()
        }
        return result.entries.map(Self.mapSearchEntry)
    }

    func searchThreadFiles(
        threadID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        try await searchWorkspaceFiles(threadID: threadID, query: query, limit: limit).entries
    }

    func searchWorkspaceFiles(
        threadID: String,
        query: String,
        limit: Int
    ) async throws -> FeatureFileSearchResult {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(["filesystem:read"], client: route.client, generation: generation)
        let context = try workspaceContext(route: route)
        let result = try await route.client.searchProjectEntries(
            cwd: context.cwd,
            query: query,
            limit: limit
        )
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation),
              try workspaceContext(route: route).cwd == context.cwd else {
            throw CancellationError()
        }
        return FeatureFileSearchResult(
            entries: result.entries.map { FeatureFileSearchMapping.entry($0, workspaceRoot: context.cwd) },
            isTruncated: result.truncated
        )
    }

    private static func mapSearchEntry(_ entry: ProjectEntry) -> FeatureFileEntry {
        let name = URL(fileURLWithPath: entry.path).lastPathComponent
        return FeatureFileEntry(
            path: entry.path,
            name: name,
            kind: entry.kind == .directory ? .directory : .file,
            isHidden: name.hasPrefix(".")
        )
    }

    func readFile(threadID: String, path: String) async throws -> FeatureFileContent {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(["filesystem:read"], client: route.client, generation: generation)
        let context = try workspaceContext(route: route)
        let result = try await route.client.readProjectFile(
            cwd: context.cwd,
            relativePath: path
        )
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation),
              try workspaceContext(route: route).cwd == context.cwd else {
            throw CancellationError()
        }
        return FeatureFileContent(
            path: result.relativePath,
            text: result.contents,
            language: NativeWorkspaceMapper.language(for: result.relativePath),
            isTruncated: result.truncated,
            totalBytes: result.byteLength
        )
    }

    /// Check all grants against the latest session and retain the original destination across awaits.
    private func requireWorkspaceScopes(_ scopes: [String], client: T3Client, generation: Int) async throws {
        try Task.checkCancellation()
        guard isKnownClient(client, environmentID: client.environment.id, generation: generation) else {
            throw CancellationError()
        }
        if let scope = scopes.first {
            try await requireScope(scope, client: client)
            try Task.checkCancellation()
            guard isKnownClient(client, environmentID: client.environment.id, generation: generation) else {
                throw CancellationError()
            }
        }
        let permissions = environmentPermissions[client.environment.id] ?? EnvironmentPermissionState()
        for scope in scopes { try permissions.require(scope) }
    }

    func loadReview(threadID: String) async throws -> FeatureReview {
        try await loadReview(threadID: threadID, target: nil)
    }

    func loadReview(threadID: String, target: FeatureReviewTarget?) async throws -> FeatureReview {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let generation = environmentGeneration
        switch target {
        case .gitSource(let sourceID):
            try await requireWorkspaceScopes(["filesystem:read"], client: route.client, generation: generation)
            let preview = try await route.client.reviewDiffPreview(cwd: context.cwd)
            guard preview.sources.contains(where: { $0.id == sourceID }) else {
                throw RPCError.remote("This review source is no longer available. Reload changes.")
            }
            var review = NativeWorkspaceMapper.review(preview, sourceID: sourceID)
            review.sources = nil
            return review
        case .turn(let checkpointID, let from, let to):
            let diff = try await route.client.reviewCheckpointDiff(threadID: route.wireID, fromTurnCount: from, toTurnCount: to)
            var review = NativeWorkspaceMapper.review(NativeReviewSources.diffSource(diff, id: checkpointID, title: "Turn \(to)"))
            review.sources = nil
            return review
        case .fullThread(let to):
            let diff = try await route.client.reviewCheckpointDiff(threadID: route.wireID, fromTurnCount: nil, toTurnCount: to)
            var review = NativeWorkspaceMapper.review(NativeReviewSources.diffSource(diff, id: "full-thread", title: "All turns"))
            review.sources = nil
            return review
        case nil:
            try await requireWorkspaceScopes(["filesystem:read"], client: route.client, generation: generation)
            let preview = try await route.client.reviewDiffPreview(cwd: context.cwd)
            // A bounded chat page can omit earlier checkpoints. Read once when
            // opening or refreshing review, not whenever the source changes.
            var review = NativeWorkspaceMapper.review(preview)
            do {
                let snapshot = try await route.client.fullThreadSnapshot(id: route.wireID)
                review.sources = (review.sources ?? []) + NativeReviewSources.checkpoints(snapshot.thread)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                review.historyError = "Turn history unavailable. " + error.localizedDescription
            }
            return review
        }
    }

    func loadReviewFileContents(
        threadID: String,
        file: FeatureReviewFile
    ) async throws -> FeatureReviewFileContents? {
        guard file.change != .binary, let sourceKind = file.sourceKind,
              sourceKind == "working-tree" || sourceKind == "branch-range" else { return nil }
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let generation = environmentGeneration
        let changeType: String = switch file.change {
        case .added: "new"
        case .deleted: "deleted"
        case .renamed: file.additions == 0 && file.deletions == 0
            ? "rename-pure"
            : "rename-changed"
        case .modified, .binary: "change"
        }
        try await requireWorkspaceScopes(["filesystem:read"], client: route.client, generation: generation)
        let contents = try await route.client.reviewDiffFileContents(
            cwd: context.cwd,
            sourceKind: sourceKind,
            changeType: changeType,
            baseRef: file.sourceBaseReference,
            headRef: file.sourceHeadReference,
            oldPath: file.previousPath ?? file.path,
            newPath: file.path
        )
        return FeatureReviewFileContents(
            oldContents: contents.oldContents,
            newContents: contents.newContents
        )
    }

    func sourceControlStatus(threadID: String) async throws -> FeatureSourceControlStatus {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        return NativeWorkspaceMapper.sourceControl(
            try await route.client.refreshVCSStatus(cwd: context.cwd)
        )
    }

    func sourceControlStatuses(
        threadID: String
    ) async throws -> AsyncThrowingStream<FeatureSourceControlStatus, Error> {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let client = route.client
        let environmentID = route.environmentID
        let generation = environmentGeneration
        let events = await client.vcsStatusEvents(cwd: context.cwd)
        // Each element is a whole status, so only the newest one is ever useful.
        let (statuses, continuation) = AsyncThrowingStream.makeStream(
            of: FeatureSourceControlStatus.self,
            bufferingPolicy: .bufferingNewest(1)
        )
        let task = Task { [weak self] in
            // The server publishes `remoteUpdated` only when the remote
            // fingerprint changes, and backs off silently when a remote refresh
            // fails, so the remote half may never arrive. Bound the wait rather
            // than leaving the screen loading forever, and say so instead of
            // leaving the status quietly half-known.
            let deadline = Task {
                try? await Task.sleep(
                    for: .seconds(Self.sourceControlStatusStreamTimeoutSeconds)
                )
                guard !Task.isCancelled else { return }
                continuation.finish(throwing: NativeFeatureClientError.remoteStatusUnavailable)
            }
            defer { deadline.cancel() }

            var accumulator = NativeSourceControlStatusAccumulator()
            do {
                for try await event in events {
                    // Superseded by cancellation or an environment switch: the
                    // stream is over, but nothing about it was malformed, so it
                    // must not run the end-of-stream validation below.
                    guard !Task.isCancelled else {
                        continuation.finish()
                        return
                    }
                    guard let self else {
                        continuation.finish()
                        return
                    }
                    guard self.isKnownClient(
                        client,
                        environmentID: environmentID,
                        generation: generation
                    ) else {
                        continuation.finish()
                        return
                    }
                    if let status = accumulator.consume(event) {
                        continuation.yield(status)
                    }
                    if accumulator.isComplete {
                        continuation.finish()
                        return
                    }
                }
                if Task.isCancelled {
                    continuation.finish()
                } else {
                    try accumulator.validateEnd()
                    continuation.finish()
                }
            } catch is CancellationError {
                continuation.finish()
            } catch {
                if Task.isCancelled {
                    continuation.finish()
                } else {
                    continuation.finish(throwing: error)
                }
            }
        }
        continuation.onTermination = { @Sendable _ in task.cancel() }
        return statuses
    }

    func sourceControlStatusEvents(threadID: String) -> AsyncStream<FeatureSourceControlStatus> {
        sourceControlStatusEvents(threadID: threadID, intent: .active)
    }

    func sourceControlStatusEvents(threadID: String, intent: FeatureSourceControlMonitorIntent) -> AsyncStream<FeatureSourceControlStatus> {
        let stream = AsyncStream<FeatureSourceControlStatus>.makeStream(
            bufferingPolicy: .bufferingNewest(1)
        )

        guard let route = try? threadRoute(for: threadID),
              let context = try? workspaceContext(route: route) else {
            stream.continuation.finish()
            return stream.stream
        }

        let key = NativeSourceControlMonitorKey(
            environmentID: route.environmentID,
            workingDirectory: context.cwd,
            intent: intent
        )
        let subscriberID = UUID()
        let monitor: NativeSourceControlMonitor

        if let existing = sourceControlMonitors[key] {
            monitor = existing
        } else {
            monitor = NativeSourceControlMonitor()
            sourceControlMonitors[key] = monitor
        }

        monitor.continuations[subscriberID] = stream.continuation
        if let latest = monitor.latestStatus {
            stream.continuation.yield(latest)
        }
        stream.continuation.onTermination = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.removeSourceControlSubscriber(subscriberID, for: key)
            }
        }

        if monitor.task == nil {
            let monitorID = monitor.id
            monitor.task = Task { [weak self] in
                await self?.observeSourceControlStatus(
                    client: route.client,
                    key: key,
                    monitorID: monitorID
                )
            }
        }

        return stream.stream
    }

    private func observeSourceControlStatus(
        client: T3Client,
        key: NativeSourceControlMonitorKey,
        monitorID: UUID
    ) async {
        let events = await client.vcsStatusEvents(cwd: key.workingDirectory, includeRemote: key.intent.includeRemote)
        var accumulator = NativeSourceControlStatusAccumulator()

        do {
            for try await event in events {
                guard !Task.isCancelled,
                      sourceControlMonitors[key]?.id == monitorID else {
                    break
                }

                guard let status = accumulator.consume(event) else { continue }
                guard let monitor = sourceControlMonitors[key],
                      monitor.id == monitorID,
                      monitor.latestStatus != status else {
                    continue
                }
                monitor.latestStatus = status
                monitor.continuations.values.forEach { $0.yield(status) }
            }
        } catch {
            // Existing rows keep their last known PR until the next subscription.
        }

        guard sourceControlMonitors[key]?.id == monitorID else { return }
        let monitor = sourceControlMonitors.removeValue(forKey: key)
        monitor?.continuations.values.forEach { $0.finish() }
    }

    private func removeSourceControlSubscriber(
        _ subscriberID: UUID,
        for key: NativeSourceControlMonitorKey
    ) {
        guard let monitor = sourceControlMonitors[key] else { return }
        monitor.continuations.removeValue(forKey: subscriberID)
        guard monitor.continuations.isEmpty else { return }
        monitor.task?.cancel()
        sourceControlMonitors.removeValue(forKey: key)
    }

    func performSourceControlAction(
        threadID: String, action: FeatureSourceControlAction, message: String?
    ) async throws {
        try await performSourceControlAction(threadID: threadID, request: .init(action: action, message: message))
    }

    func performSourceControlAction(threadID: String, request: FeatureSourceControlRequest) async throws {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        let context = try workspaceContext(route: route)
        func requireMutationPermissions(featureBranch: Bool) async throws {
            try await requireWorkspaceScopes(
                ["source-control:write"] + (featureBranch ? ["orchestration:operate"] : []),
                client: route.client, generation: generation
            )
            guard try workspaceContext(route: route).cwd == context.cwd else { throw CancellationError() }
        }
        try await requireMutationPermissions(featureBranch: request.featureBranch)
        guard request.filePaths?.isEmpty != true else { throw RPCError.remote("Select at least one file to commit.") }
        guard (request.message?.utf16.count ?? 0) <= 10_000 else { throw RPCError.remote("Commit messages must be at most 10,000 characters.") }
        let status = NativeWorkspaceMapper.sourceControl(try await route.client.refreshVCSStatus(cwd: context.cwd))
        guard status.isRepository else { throw RPCError.remote("This workspace is not a Git repository.") }
        if request.requiresBranchChoice(status) {
            throw FeatureSourceControlBranchChoiceRequired(branch: status.branch ?? "default branch")
        }
        if request.action.usesRemote, status.hasPrimaryRemote == false {
            throw RPCError.remote("This repository has no remote.")
        }
        if request.action == .pull {
            try await requireMutationPermissions(featureBranch: request.featureBranch)
            _ = try await route.client.pull(cwd: context.cwd)
            return
        }

        var effective = request
        if request.featureBranch, !request.action.includesCommit {
            let branches = try await sourceControlBranches(threadID: threadID)
            let name = FeatureGitBranchName.automatic(existing: branches.branches.map(\.name))
            try await requireMutationPermissions(featureBranch: true)
            let created = try await route.client.createVCSRef(cwd: context.cwd, name: name)
            effective.featureBranch = false
            let workspace = FeatureSourceControlWorkspace(branch: created.refName, worktreePath: context.worktreePath)
            do {
                try await syncSourceControlWorkspace(route: route, workspace: workspace, generation: generation)
            } catch {
                throw FeatureSourceControlWorkspaceSyncError(workspace: workspace, pendingRequest: effective, message: error.localizedDescription)
            }
        }
        let result: GitActionResult
        do {
            let actionID = UUID().uuidString
            try await requireMutationPermissions(featureBranch: effective.featureBranch)
            let progress = try await route.client.runGitAction(
                cwd: context.cwd, action: NativeWorkspaceMapper.gitAction(effective.action),
                commitMessage: effective.message, featureBranch: effective.featureBranch ? true : nil,
                filePaths: effective.filePaths, threadID: route.wireID, actionID: actionID
            )
            var completed: GitActionResult?
            for try await event in progress {
                guard event.actionId == actionID, event.cwd == context.cwd else { continue }
                if event.kind == "action_failed" {
                    throw RPCError.remote(event.message ?? "The source-control action failed.")
                }
                if event.kind == "action_finished" { completed = event.result }
            }
            guard let completed else { throw RPCError.remote("The source-control action ended without a result. Refresh status before retrying.") }
            result = completed
        } catch {
            // An explicit feature branch already exists for a push/PR action.
            // Retry the remaining action on it rather than creating another.
            if effective != request {
                throw FeatureSourceControlActionRetryError(request: effective, message: error.localizedDescription)
            }
            throw error
        }
        if result.branch.status == "created", let branch = result.branch.name {
            let workspace = FeatureSourceControlWorkspace(branch: branch, worktreePath: context.worktreePath)
            do {
                try await syncSourceControlWorkspace(route: route, workspace: workspace, generation: generation)
            } catch {
                throw FeatureSourceControlWorkspaceSyncError(workspace: workspace, pendingRequest: nil, message: error.localizedDescription)
            }
        }
    }

    func sourceControlBranches(threadID: String) async throws -> FeatureSourceControlBranches {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        guard let shell = shellsByEnvironmentID[route.environmentID],
              let thread = shell.threads.first(where: { $0.id == route.wireID }),
              let project = shell.projects.first(where: { $0.id == thread.projectId }) else {
            throw NativeFeatureClientError.workspaceNotFound
        }
        let status = try await route.client.refreshVCSStatus(cwd: context.cwd)
        var branches: [FeatureWorkspaceBranch] = []
        var cursor: Int?
        var seen = Set<Int>()
        repeat {
            let result = try await route.client.listVCSRefs(cwd: project.workspaceRoot, cursor: cursor, kind: "local", refresh: cursor == nil)
            branches += result.refs.map {
                FeatureWorkspaceBranch(name: $0.name, isRemote: $0.isRemote ?? false,
                    isCurrent: $0.name == status.refName, isDefault: $0.isDefault, worktreePath: $0.worktreePath)
            }
            guard let next = result.nextCursor, seen.insert(next).inserted else { break }
            cursor = next
        } while true
        return FeatureSourceControlBranches(branches: branches,
            workspace: .init(branch: status.refName, worktreePath: context.worktreePath), workingDirectory: context.cwd)
    }

    func changeSourceControlWorkspace(threadID: String, action: FeatureSourceControlWorkspaceAction) async throws {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        let context = try workspaceContext(route: route)
        func requireMutationPermissions() async throws {
            try await requireWorkspaceScopes(
                ["source-control:write", "orchestration:operate"], client: route.client, generation: generation
            )
            guard try workspaceContext(route: route).cwd == context.cwd else { throw CancellationError() }
        }
        try await requireMutationPermissions()
        let workspace: FeatureSourceControlWorkspace
        switch action {
        case .switchBranch(let name):
            let branches = try await sourceControlBranches(threadID: threadID)
            guard let branch = branches.branches.first(where: { $0.name == name }), branches.isAvailable(branch) else {
                throw RPCError.remote("This branch is unavailable or checked out in another worktree.")
            }
            try await requireMutationPermissions()
            let result = try await route.client.switchVCSRef(cwd: context.cwd, name: name)
            workspace = .init(branch: result.refName, worktreePath: context.worktreePath)
        case .createBranch(let name):
            let name = try FeatureGitBranchName.validated(name)
            let result = try await route.client.createVCSRef(cwd: context.cwd, name: name)
            workspace = .init(branch: result.refName, worktreePath: context.worktreePath)
        case .useProjectDirectory:
            guard let shell = shellsByEnvironmentID[route.environmentID],
                  let thread = shell.threads.first(where: { $0.id == route.wireID }),
                  let project = shell.projects.first(where: { $0.id == thread.projectId }) else {
                throw NativeFeatureClientError.workspaceNotFound
            }
            let status = try await route.client.refreshVCSStatus(cwd: project.workspaceRoot)
            workspace = .init(branch: status.refName, worktreePath: nil)
        case .createWorktree(let base, let name):
            let name = try FeatureGitBranchName.validated(name)
            let base = base.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !base.isEmpty else { throw RPCError.remote("Choose a base branch.") }
            guard let shell = shellsByEnvironmentID[route.environmentID],
                  let thread = shell.threads.first(where: { $0.id == route.wireID }),
                  let project = shell.projects.first(where: { $0.id == thread.projectId }) else {
                throw NativeFeatureClientError.workspaceNotFound
            }
            let result = try await route.client.createWorktree(cwd: project.workspaceRoot, refName: base, newRefName: name)
            workspace = .init(branch: result.worktree.refName, worktreePath: result.worktree.path)
        }
        do {
            try await syncSourceControlWorkspace(route: route, workspace: workspace, generation: generation)
        } catch {
            throw FeatureSourceControlWorkspaceSyncError(workspace: workspace, pendingRequest: nil, message: error.localizedDescription)
        }
    }

    func syncSourceControlWorkspace(threadID: String, workspace: FeatureSourceControlWorkspace) async throws {
        try await syncSourceControlWorkspace(
            route: threadRoute(for: threadID), workspace: workspace, generation: environmentGeneration
        )
    }

    private func syncSourceControlWorkspace(
        route: NativeThreadRoute, workspace: FeatureSourceControlWorkspace, generation: Int
    ) async throws {
        try await requireWorkspaceScopes(["orchestration:operate"], client: route.client, generation: generation)
        try await route.client.updateSourceControlWorkspace(threadID: route.wireID, branch: workspace.branch, worktreePath: workspace.worktreePath)
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
            throw CancellationError()
        }
        try await refresh(client: route.client)
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
            throw CancellationError()
        }
        await refreshThreadUnlessLive(id: route.uiID, client: route.client)
    }

    func terminalSnapshot(
        threadID: String,
        terminalID: String
    ) async throws -> FeatureTerminalSnapshot {
        let route = try threadRoute(for: threadID)
        try await requireTerminalScope("terminal:read", route: route)
        let key = TerminalKey(threadID: route.uiID, terminalID: terminalID)
        if let snapshot = terminalSnapshots[key] {
            return snapshot
        }
        let context = try workspaceContext(route: route)
        let snapshot = FeatureTerminalSnapshot(
            threadID: route.uiID,
            terminalID: terminalID,
            workingDirectory: context.cwd,
            lifecycleVersion: nextTerminalLifecycleVersion()
        )
        terminalSnapshots[key] = snapshot
        return snapshot
    }

    func terminalHostOS(threadID: String) -> String? {
        guard let route = try? threadRoute(for: threadID) else { return nil }
        return serverConfigsByEnvironmentID[route.environmentID]?.environment?.platform.os
            ?? route.client.environment.descriptor?.platform.os
    }

    func terminalEvents(
        threadID: String,
        terminalID: String
    ) -> AsyncStream<FeatureTerminalSnapshot> {
        guard let route = try? threadRoute(for: threadID) else {
            return AsyncStream { continuation in continuation.finish() }
        }
        let environmentID = route.environmentID
        let client = route.client
        let uiThreadID = route.uiID
        let key = TerminalKey(threadID: uiThreadID, terminalID: terminalID)
        let generation = environmentGeneration
        return AsyncStream { continuation in
            let task = Task { [weak self] in
                do {
                    guard let events = try await self?.terminalStream(route: route, terminalID: terminalID) else {
                        continuation.finish()
                        return
                    }
                    for try await event in events {
                        guard !Task.isCancelled, let self else { break }
                        guard self.isKnownClient(
                            client,
                            environmentID: environmentID,
                            generation: generation
                        ) else {
                            break
                        }
                        let snapshot = self.consumeTerminalEvent(
                            event,
                            threadID: uiThreadID,
                            terminalID: terminalID
                        )
                        continuation.yield(snapshot)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    guard let self else {
                        continuation.finish()
                        return
                    }
                    guard self.isKnownClient(
                        client,
                        environmentID: environmentID,
                        generation: generation
                    ) else {
                        continuation.finish()
                        return
                    }
                    var snapshot = self.terminalSnapshots[key]
                        ?? FeatureTerminalSnapshot(
                            threadID: uiThreadID,
                            terminalID: terminalID
                        )
                    if error is EnvironmentPermissionDeniedError { snapshot.buffer = "" }
                    snapshot.state = .failed
                    snapshot.error = error.localizedDescription
                    snapshot.lifecycleVersion = self.nextTerminalLifecycleVersion()
                    self.terminalSnapshots[key] = snapshot
                    continuation.yield(snapshot)
                    continuation.finish()
                }
            }
            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    func terminalSessions(threadID: String) -> AsyncStream<[FeatureTerminalSnapshot]> {
        guard let route = try? threadRoute(for: threadID) else {
            return AsyncStream { continuation in continuation.finish() }
        }
        let environmentID = route.environmentID
        let client = route.client
        let uiThreadID = route.uiID
        let wireThreadID = route.wireID
        let generation = environmentGeneration
        return AsyncStream { continuation in
            let task = Task { [weak self] in
                var summaries = [TerminalSummary]()
                do {
                    guard self != nil else { continuation.finish(); return }
                    try await self?.requireTerminalScope("terminal:read", route: route)
                    for try await event in await client.terminalMetadataEvents() {
                        guard !Task.isCancelled, let self else { break }
                        guard self.isKnownClient(
                            client,
                            environmentID: environmentID,
                            generation: generation
                        ) else {
                            break
                        }

                        switch event.type {
                        case "snapshot":
                            summaries = (event.terminals ?? []).filter {
                                $0.threadId == wireThreadID
                            }
                        case "upsert":
                            if let summary = event.terminal,
                               summary.threadId == wireThreadID {
                                summaries.removeAll { $0.terminalId == summary.terminalId }
                                summaries.append(summary)
                            }
                        case "remove":
                            if event.threadId == wireThreadID,
                               let terminalID = event.terminalId {
                                summaries.removeAll { $0.terminalId == terminalID }
                                let key = TerminalKey(threadID: uiThreadID, terminalID: terminalID)
                                if var cached = self.terminalSnapshots[key] {
                                    cached.state = .stopped
                                    cached.lifecycleVersion = self.nextTerminalLifecycleVersion()
                                    self.terminalSnapshots[key] = cached
                                }
                            }
                        default:
                            break
                        }

                        let sessions = summaries
                            .sorted {
                                $0.terminalId.localizedStandardCompare($1.terminalId)
                                    == .orderedAscending
                            }
                            .map { self.mergeTerminalSummary($0, threadID: uiThreadID) }
                        continuation.yield(sessions)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish()
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    func configuredProjectScripts(threadID: String) async throws -> [ProjectScript] {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        let config = try await route.client.serverConfig()
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation),
              let shell = shellsByEnvironmentID[route.environmentID],
              let thread = shell.threads.first(where: { $0.id == route.wireID }),
              let project = shell.projects.first(where: { $0.id == thread.projectId }) else {
            throw CancellationError()
        }
        return FeatureProjectScriptSettings.resolve(
            settings: config.settings ?? ServerSettingsSnapshot(),
            projectID: project.id, scripts: project.scripts
        )
    }

    func runProjectScript(threadID: String, scriptID: String, columns: Int, rows: Int,
                          hasSessionSnapshot: Bool) async throws -> String {
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(["terminal:operate"], client: route.client, generation: generation)
        let scripts = try await configuredProjectScripts(threadID: threadID)
        guard let script = scripts.first(where: { $0.id == scriptID }),
              !script.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw RPCError.remote("This project script is no longer configured. Reload scripts and try again.")
        }
        try await requireWorkspaceScopes(["terminal:operate"], client: route.client, generation: generation)
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation),
              let shell = shellsByEnvironmentID[route.environmentID],
              let thread = shell.threads.first(where: { $0.id == route.wireID }),
              let project = shell.projects.first(where: { $0.id == thread.projectId }) else {
            throw CancellationError()
        }
        let context = try workspaceContext(route: route)
        let launch = FeatureProjectScriptLaunch(
            projectRoot: project.workspaceRoot, worktreePath: context.worktreePath, command: script.command
        )
        let canReadSessions = hasSessionSnapshot
            && environmentPermissions[route.environmentID]?.grants("terminal:read") == true
        let terminalID = FeatureProjectScriptLaunch.terminalID(
            threadID: route.uiID, sessions: canReadSessions ? Array(terminalSnapshots.values) : nil
        )
        let key = TerminalKey(threadID: route.uiID, terminalID: terminalID)
        // Reserve the session before opening it so another launch cannot send into it.
        terminalSnapshots[key] = FeatureTerminalSnapshot(
            threadID: route.uiID, terminalID: terminalID, state: .starting,
            workingDirectory: launch.cwd, lifecycleVersion: nextTerminalLifecycleVersion()
        )
        do {
            try await launch.execute(validate: {
                try (self.environmentPermissions[route.environmentID] ?? EnvironmentPermissionState()).require("terminal:operate")
                guard self.isKnownClient(route.client, environmentID: route.environmentID, generation: generation),
                      try self.workspaceContext(route: route).cwd == launch.cwd else {
                    throw CancellationError()
                }
            }, open: {
                try await self.requireWorkspaceScopes(["terminal:operate"], client: route.client, generation: generation)
                guard try self.workspaceContext(route: route).cwd == launch.cwd else { throw CancellationError() }
                let snapshot = try await route.client.openTerminal(
                    threadID: route.wireID, terminalID: terminalID, cwd: launch.cwd,
                    worktreePath: launch.worktreePath, columns: columns, rows: rows,
                    environmentVariables: launch.environmentVariables
                )
                try Task.checkCancellation()
                guard self.isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
                    throw CancellationError()
                }
                var scoped = NativeWorkspaceMapper.terminal(snapshot)
                scoped.threadID = route.uiID
                scoped.buffer = Self.cappedTerminalBuffer(scoped.buffer)
                scoped.lifecycleVersion = self.nextTerminalLifecycleVersion()
                self.terminalSnapshots[key] = scoped
            }, write: { chunk in
                try await self.requireWorkspaceScopes(["terminal:operate"], client: route.client, generation: generation)
                guard try self.workspaceContext(route: route).cwd == launch.cwd else { throw CancellationError() }
                try await route.client.writeTerminal(threadID: route.wireID, terminalID: terminalID, data: chunk)
            })
            try Task.checkCancellation()
            guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
                throw CancellationError()
            }
            return terminalID
        } catch {
            if isKnownClient(route.client, environmentID: route.environmentID, generation: generation),
               terminalSnapshots[key]?.state == .starting {
                terminalSnapshots[key]?.state = .failed
                terminalSnapshots[key]?.error = error.localizedDescription
            }
            throw error
        }
    }

    func openTerminal(
        threadID: String,
        terminalID: String,
        columns: Int,
        rows: Int
    ) async throws {
        let route = try threadRoute(for: threadID)
        try await requireTerminalScope("terminal:operate", route: route)
        let client = route.client
        let environmentID = route.environmentID
        let generation = environmentGeneration
        let context = try workspaceContext(route: route)
        let snapshot = try await client.openTerminal(
            threadID: route.wireID,
            terminalID: terminalID,
            cwd: context.cwd,
            worktreePath: context.worktreePath,
            columns: columns,
            rows: rows
        )
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        let mapped = NativeWorkspaceMapper.terminal(snapshot)
        var scoped = mapped
        scoped.threadID = route.uiID
        scoped.buffer = Self.cappedTerminalBuffer(scoped.buffer)
        scoped.lifecycleVersion = nextTerminalLifecycleVersion()
        terminalSnapshots[TerminalKey(threadID: route.uiID, terminalID: terminalID)] = scoped
    }

    func writeTerminal(threadID: String, terminalID: String, data: String) async throws {
        let route = try threadRoute(for: threadID)
        try await requireTerminalScope("terminal:operate", route: route)
        try await route.client.writeTerminal(
            threadID: route.wireID,
            terminalID: terminalID,
            data: data
        )
    }

    func resizeTerminal(
        threadID: String,
        terminalID: String,
        columns: Int,
        rows: Int
    ) async throws {
        let route = try threadRoute(for: threadID)
        try await requireTerminalScope("terminal:operate", route: route)
        try await route.client.resizeTerminal(
            threadID: route.wireID,
            terminalID: terminalID,
            columns: columns,
            rows: rows
        )
    }

    func clearTerminal(threadID: String, terminalID: String) async throws {
        let route = try threadRoute(for: threadID)
        try await requireTerminalScope("terminal:operate", route: route)
        try await route.client.clearTerminal(
            threadID: route.wireID,
            terminalID: terminalID
        )
    }

    func closeTerminal(threadID: String, terminalID: String) async throws {
        let route = try threadRoute(for: threadID)
        try await requireTerminalScope("terminal:operate", route: route)
        let client = route.client
        let environmentID = route.environmentID
        let generation = environmentGeneration
        try await client.closeTerminal(threadID: route.wireID, terminalID: terminalID)
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        let context = try workspaceContext(route: route)
        terminalSnapshots[TerminalKey(threadID: route.uiID, terminalID: terminalID)] =
            FeatureTerminalSnapshot(
                threadID: route.uiID,
                terminalID: terminalID,
                workingDirectory: context.cwd,
                lifecycleVersion: nextTerminalLifecycleVersion()
            )
    }

    private func terminalStream(
        route: NativeThreadRoute, terminalID: String
    ) async throws -> AsyncThrowingStream<TerminalEvent, Error> {
        try await requireTerminalScope("terminal:read", route: route)
        guard environmentPermissions[route.environmentID]?.grants("terminal:operate") == true else {
            return await route.client.observeTerminal(threadID: route.wireID, terminalID: terminalID)
        }
        try await requireTerminalScope("terminal:operate", route: route)
        try (environmentPermissions[route.environmentID] ?? EnvironmentPermissionState()).require("terminal:read")
        let context = try workspaceContext(route: route)
        return try await route.client.attachTerminal(
            threadID: route.wireID, terminalID: terminalID,
            cwd: context.cwd, worktreePath: context.worktreePath, columns: 80, rows: 24
        )
    }

    /// Recheck the destination grant after each suspension before sending PTY commands.
    private func requireTerminalScope(_ scope: String, route: NativeThreadRoute) async throws {
        let generation = environmentGeneration
        try await requireScope(scope, client: route.client)
        try Task.checkCancellation()
        guard isKnownClient(route.client, environmentID: route.environmentID, generation: generation) else {
            throw CancellationError()
        }
    }

    private func requireClient() throws -> T3Client {
        guard let client else { throw NativeFeatureClientError.notConnected }
        return client
    }

    func preuploadAttachment(
        _ attachment: FeatureUploadAttachment,
        environmentID: String
    ) async throws -> FeatureUploadedAttachmentReference? {
        let client = try await projectCreationClient(environmentID: environmentID)
        _ = try await client.serverConfig()
        let uploads = try await makeUploadAttachments([attachment])
        let prepared = try await client.prepareAttachment(uploads[0])
        return prepared.map {
            FeatureUploadedAttachmentReference(
                environmentID: $0.environmentID,
                attachmentID: $0.attachmentID
            )
        }
    }

    func projectCreationClient(environmentID: String) async throws -> T3Client {
        guard let environment = try await runtime.selectedEnvironment(id: environmentID), environment.isEnabled else {
            throw NativeFeatureClientError.environmentNotFound
        }
        let existing = environmentClients[environmentID]
        if let existing, existing.environment.selectedRoute == environment.selectedRoute,
           await existing.liveConnectionActive() { return existing }
        let selected: T3Client
        if environment.routes.count > 1 {
            selected = try await runtime.resolveClient(for: environment)
        } else {
            selected = await runtime.client(for: environment)
        }
        _ = await installResolvedRoute(selected)
        return selected
    }

    private func projectRoute(for projectID: String) throws -> NativeProjectRoute {
        guard let environmentID = projectEnvironmentIDs[projectID],
              let wireID = projectWireIDs[projectID],
              let client = environmentClients[environmentID] else {
            throw NativeFeatureClientError.projectNotFound
        }
        return NativeProjectRoute(
            uiID: FeatureScopedID.project(environmentID: environmentID, wireID: wireID),
            wireID: wireID,
            environmentID: environmentID,
            client: client
        )
    }

    private func project(for route: NativeProjectRoute) throws -> OrchestrationProject {
        guard let project = shellsByEnvironmentID[route.environmentID]?.projects.first(where: {
            $0.id == route.wireID
        }) else {
            throw NativeFeatureClientError.projectNotFound
        }
        return project
    }

    func threadRoute(for threadID: String) throws -> NativeThreadRoute {
        guard let environmentID = threadEnvironmentIDs[threadID],
              let wireID = threadWireIDs[threadID],
              let client = environmentClients[environmentID] else {
            throw NativeFeatureClientError.threadNotFound
        }
        return NativeThreadRoute(
            uiID: FeatureScopedID.thread(environmentID: environmentID, wireID: wireID),
            wireID: wireID,
            environmentID: environmentID,
            client: client
        )
    }

    func environmentServiceClient(environmentID: String) async throws -> T3Client {
        try await projectCreationClient(environmentID: environmentID)
    }

    /// Resolve actions against the owning environment, including passive devices.
    func v2ActionContext(threadID: String) async throws
        -> (client: T3Client, wireID: String, environmentID: String) {
        let route = try threadRoute(for: threadID)
        guard !restoredDetailIDs.contains(route.uiID) else {
            throw FeatureCapabilityUnavailable("Thread controls require live thread data")
        }
        await route.client.connect()
        guard try await route.client.orchestrationVersion() == .v2 else {
            throw FeatureCapabilityUnavailable("Orchestrator V2 controls")
        }
        guard environmentClients[route.environmentID] === route.client,
              threadEnvironmentIDs[threadID] == route.environmentID,
              threadWireIDs[threadID] == route.wireID else {
            throw RPCError.disconnected
        }
        return (route.client, route.wireID, route.environmentID)
    }

    private func registerProvisionalThread(wireID: String, environmentID: String) {
        let uiID = FeatureScopedID.thread(environmentID: environmentID, wireID: wireID)
        provisionalThreadRoutes[uiID] = ProvisionalThreadRoute(
            environmentID: environmentID,
            wireID: wireID
        )
        threadEnvironmentIDs[uiID] = environmentID
        threadWireIDs[uiID] = wireID
    }

    private func cachedThread(id: String) -> FeatureThread? {
        latestSnapshot?.threads.first(where: { $0.id == id })
            ?? archivedThreadsByEnvironmentID.values.lazy
                .flatMap { $0 }
                .first(where: { $0.id == id })
    }

    private func updateCachedArchivedThread(
        id: String,
        update: (inout FeatureThread) -> Void
    ) {
        for environmentID in Array(archivedThreadsByEnvironmentID.keys) {
            guard var threads = archivedThreadsByEnvironmentID[environmentID],
                  let index = threads.firstIndex(where: { $0.id == id }) else {
                continue
            }
            update(&threads[index])
            archivedThreadsByEnvironmentID[environmentID] = threads
            return
        }
    }

    private func reconcileArchivedCache(
        thread: FeatureThread?,
        route: NativeThreadRoute,
        archived: Bool
    ) {
        archivedThreadsByEnvironmentID[route.environmentID, default: []]
            .removeAll { $0.id == route.uiID }
        var archivedShellThreads = archivedShellThreadsByEnvironmentID[
            route.environmentID,
            default: [:]
        ]
        let previouslyArchivedShell = archivedShellThreads.removeValue(
            forKey: route.wireID
        )

        if archived, var thread {
            // Keep the accepted lifecycle transition visible until both live
            // and archived follow-up reads converge, including when the
            // owning passive device drops immediately after the command.
            thread.isArchived = true
            archivedThreadsByEnvironmentID[route.environmentID, default: []].append(thread)
        }

        if let shell = shellsByEnvironmentID[route.environmentID] {
            if archived {
                if let liveThread = shell.threads.first(where: { $0.id == route.wireID }) {
                    archivedShellThreads[route.wireID] = liveThread
                }
                shellsByEnvironmentID[route.environmentID] = OrchestrationShellSnapshot(
                    snapshotSequence: shell.snapshotSequence,
                    projects: shell.projects,
                    threads: shell.threads.filter { $0.id != route.wireID },
                    updatedAt: shell.updatedAt,
                    orchestrationProtocolVersion: shell.orchestrationProtocolVersion
                )
            } else if let previouslyArchivedShell {
                var threads = shell.threads.filter { $0.id != route.wireID }
                threads.append(Self.unarchived(previouslyArchivedShell))
                shellsByEnvironmentID[route.environmentID] = OrchestrationShellSnapshot(
                    snapshotSequence: shell.snapshotSequence,
                    projects: shell.projects,
                    threads: threads,
                    updatedAt: shell.updatedAt,
                    orchestrationProtocolVersion: shell.orchestrationProtocolVersion
                )
            }
        }
        archivedShellThreadsByEnvironmentID[route.environmentID] = archivedShellThreads
    }

    private static func unarchived(
        _ thread: OrchestrationThreadShell
    ) -> OrchestrationThreadShell {
        OrchestrationThreadShell(
            relationshipToParent: thread.relationshipToParent,
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            linkedPullRequest: thread.linkedPullRequest,
            pullRequests: thread.pullRequests,
            branchPullRequest: thread.branchPullRequest,
            latestTurn: thread.latestTurn,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            archivedAt: nil,
            settledOverride: thread.settledOverride,
            settledAt: thread.settledAt,
            unsettledAt: thread.unsettledAt,
            activeOrderKey: thread.activeOrderKey,
            autoSettleDisabledAt: thread.autoSettleDisabledAt,
            snoozedUntil: thread.snoozedUntil,
            snoozedAt: thread.snoozedAt,
            pinnedAt: thread.pinnedAt,
            pinOrderKey: thread.pinOrderKey,
            session: thread.session,
            latestUserMessageAt: thread.latestUserMessageAt,
            hasPendingApprovals: thread.hasPendingApprovals,
            hasPendingUserInput: thread.hasPendingUserInput,
            hasActionableProposedPlan: thread.hasActionableProposedPlan,
            backgroundLiveness: thread.backgroundLiveness,
            latestUserAuthoredMessageAt: thread.latestUserAuthoredMessageAt,
            latestUserAuthoredMessageAtIsPresent: thread.latestUserAuthoredMessageAtIsPresent,
            v2Lifecycle: thread.v2Lifecycle
        )
    }

    private func emitCachedSnapshot(for environmentID: String) async {
        guard let client = environmentClients[environmentID],
              let shell = shellsByEnvironmentID[environmentID] else {
            return
        }
        await emitSnapshot(shell, client: client, expectedGeneration: environmentGeneration)
    }

    private func removeCachedApproval(id: String, threadID: String) {
        guard var detail = latestDetails[threadID] else { return }
        detail.approvals.removeAll { $0.id == id }
        if detail.approvals.isEmpty, detail.thread.state == .waitingForApproval {
            detail.thread.state = detail.userInputs.isEmpty ? .idle : .waitingForInput
        }
        publish(detail, threadID: threadID)
    }

    private func removeCachedInput(id: String, threadID: String) {
        guard var detail = latestDetails[threadID] else { return }
        detail.userInputs.removeAll { $0.id == id }
        if detail.userInputs.isEmpty, detail.thread.state == .waitingForInput {
            detail.thread.state = detail.approvals.isEmpty ? .idle : .waitingForApproval
        }
        publish(detail, threadID: threadID)
    }

    private func workspaceContext(route: NativeThreadRoute) throws -> (
        cwd: String,
        worktreePath: String?
    ) {
        let detailThread = latestDetails[route.uiID]?.thread
        guard let shell = shellsByEnvironmentID[route.environmentID] else {
            throw NativeFeatureClientError.workspaceNotFound
        }
        let thread = shell.threads.first(where: { $0.id == route.wireID })
        guard let project = shell.projects.first(where: {
            $0.id == thread?.projectId || FeatureScopedID.project(environmentID: route.environmentID, wireID: $0.id) == detailThread?.projectID
        }) else {
            throw NativeFeatureClientError.workspaceNotFound
        }
        // Detail is the active thread's freshest workspace. Shells can lag a
        // branch/worktree change while files, Git and terminal open together.
        let worktreePath = detailThread?.worktreePath ?? thread?.worktreePath
        return (cwd: worktreePath ?? project.workspaceRoot, worktreePath: worktreePath)
    }

    private func consumeTerminalEvent(
        _ event: TerminalEvent,
        threadID: String,
        terminalID: String
    ) -> FeatureTerminalSnapshot {
        let key = TerminalKey(threadID: threadID, terminalID: terminalID)
        if let coreSnapshot = event.snapshot {
            var snapshot = NativeWorkspaceMapper.terminal(coreSnapshot)
            snapshot.threadID = threadID
            snapshot.buffer = Self.cappedTerminalBuffer(snapshot.buffer)
            snapshot.lifecycleVersion = nextTerminalLifecycleVersion()
            terminalSnapshots[key] = snapshot
            return snapshot
        }

        // Take the snapshot out of the dictionary so the dictionary does not
        // hold a second reference to the buffer during the append. Every path
        // stores it back before returning.
        var snapshot = terminalSnapshots.removeValue(forKey: key)
            ?? FeatureTerminalSnapshot(threadID: threadID, terminalID: terminalID)
        switch event.type {
        case "started", "restarted":
            snapshot.state = .running
            snapshot.lifecycleVersion = nextTerminalLifecycleVersion()
        case "output":
            snapshot.buffer.append(event.data ?? "")
            snapshot.buffer = Self.cappedTerminalBuffer(snapshot.buffer)
        case "exited":
            snapshot.state = .exited
            snapshot.exitCode = event.exitCode
            snapshot.lifecycleVersion = nextTerminalLifecycleVersion()
        case "closed":
            snapshot.state = .stopped
            snapshot.lifecycleVersion = nextTerminalLifecycleVersion()
        case "error":
            snapshot.state = .failed
            snapshot.error = event.message
            snapshot.lifecycleVersion = nextTerminalLifecycleVersion()
        case "cleared":
            snapshot.buffer = ""
        case "activity":
            snapshot.title = event.label ?? snapshot.title
            snapshot.hasRunningSubprocess = event.hasRunningSubprocess
                ?? snapshot.hasRunningSubprocess
        default:
            break
        }
        terminalSnapshots[key] = snapshot
        return snapshot
    }

    private func mergeTerminalSummary(
        _ summary: TerminalSummary,
        threadID: String
    ) -> FeatureTerminalSnapshot {
        let key = TerminalKey(threadID: threadID, terminalID: summary.terminalId)
        var snapshot = NativeWorkspaceMapper.terminal(summary)
        snapshot.threadID = threadID
        if let cached = terminalSnapshots[key] {
            snapshot.buffer = cached.buffer
            snapshot.error = cached.error
            snapshot.lifecycleVersion = cached.lifecycleVersion
        } else {
            snapshot.lifecycleVersion = nextTerminalLifecycleVersion()
        }
        terminalSnapshots[key] = snapshot
        return snapshot
    }

    private func nextTerminalLifecycleVersion() -> Int {
        terminalLifecycleVersion += 1
        return terminalLifecycleVersion
    }

    /// A verbose command can stream megabytes; the viewer only ever shows the
    /// tail, so cap retained history to keep layout and memory bounded.
    nonisolated static let terminalBufferLimit = 512 * 1024

    /// Bytes kept after a trim. Trimming well below the limit leaves room for
    /// later output to grow the buffer as a plain append, so the terminal view
    /// does not reset and replay the whole buffer on every chunk at the cap.
    nonisolated static let terminalBufferTrimTarget = terminalBufferLimit * 3 / 4

    nonisolated static func cappedTerminalBuffer(_ buffer: String) -> String {
        let utf8 = buffer.utf8
        guard utf8.count > terminalBufferLimit else { return buffer }
        // Slice in UTF-8 bytes (the unit the limit is defined in), then snap
        // forward to a character boundary so multibyte output cannot blow
        // past the cap or tear a scalar.
        let byteStart = utf8.index(utf8.endIndex, offsetBy: -terminalBufferTrimTarget)
        var start = byteStart.samePosition(in: buffer)
        if start == nil {
            var probe = byteStart
            while probe < utf8.endIndex, start == nil {
                probe = utf8.index(after: probe)
                start = probe.samePosition(in: buffer)
            }
        }
        guard let start else { return buffer }
        let tail = buffer[start...]
        // Trim to the next line boundary so the top of the view isn't a torn line.
        if let newline = tail.firstIndex(of: "\n") {
            return String(tail[tail.index(after: newline)...])
        }
        return String(tail)
    }

    private func startPolling(_ activeClient: T3Client) {
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        let generation = environmentGeneration
        pollingTask = Task { [weak self] in
            while !Task.isCancelled,
                self?.isCurrentSession(client: activeClient, generation: generation) == true
            {
                do {
                    await activeClient.connect()
                    guard
                        self?.isCurrentSession(
                            client: activeClient,
                            generation: generation
                        ) == true
                    else {
                        return
                    }
                    let sequence = self?.restoredShellEnvironmentIDs.contains(activeClient.environment.id) == true
                        ? nil : self?.latestShell?.snapshotSequence
                    let events = await activeClient.shellEventBatches(
                        after: sequence,
                        protocolVersion: self?.latestShell?.orchestrationProtocolVersion ?? 1,
                        reconnect: false
                    )
                    // Re-bind self per event instead of holding it strongly across
                    // the indefinite stream, so the client can deinit mid-stream.
                    for try await batch in events {
                        guard !Task.isCancelled,
                            let self,
                            self.isCurrentSession(
                                client: activeClient,
                                generation: generation
                            )
                        else {
                            break
                        }
                        self.lastShellEventAt = .now
                        var deltas: [ShellStreamItem] = []
                        var shellRefreshFailed = false
                        for item in batch {
                            switch item {
                            case let .snapshot(shell):
                                await self.consume(deltas: deltas, client: activeClient, generation: generation)
                                deltas.removeAll(keepingCapacity: true)
                                await self.consume(
                                    shell: shell,
                                    client: activeClient,
                                    generation: generation,
                                    refreshActiveThread: true
                                )
                            case .projectUpserted, .projectRemoved, .threadUpserted, .threadRemoved, .repositoryIdentitiesUpdated:
                                deltas.append(item)
                            case .refreshRequired:
                                await self.consume(deltas: deltas, client: activeClient, generation: generation)
                                deltas.removeAll(keepingCapacity: true)
                                if let shell = try? await activeClient.shellSnapshot() {
                                    await self.consume(
                                        shell: shell,
                                        client: activeClient,
                                        generation: generation,
                                        refreshActiveThread: true
                                    )
                                } else {
                                    shellRefreshFailed = true
                                }
                            case .synchronized:
                                break
                            }
                        }
                        await self.consume(deltas: deltas, client: activeClient, generation: generation)
                        // A connected event wakes the outbox. Publish the
                        // received shell first, including coalesced deltas,
                        // so missing threads are not mistaken for deletions.
                        if !shellRefreshFailed,
                           self.isCurrentSession(client: activeClient, generation: generation),
                           self.environmentConnectionStates[activeClient.environment.id] != .connected,
                           !self.restoredShellEnvironmentIDs.contains(activeClient.environment.id),
                           let shell = self.latestShell {
                            self.shellPublishTask?.cancel()
                            self.shellPublishTask = nil
                            await self.emitSnapshot(shell, client: activeClient, expectedGeneration: generation)
                        }
                    }
                } catch is CancellationError {
                    return
                } catch {
                    if let self, await self.recoverEnvironmentRoute(environmentID: activeClient.environment.id) { return }
                    if error.isRejectedAuthorization,
                       self?.routeRejectionIsFinal(environmentID: activeClient.environment.id) == true,
                       let self,
                       self.isCurrentSession(client: activeClient, generation: generation) {
                        self.markActiveEnvironmentNeedsPairing(detail: error.localizedDescription)
                        return
                    }
                    // The independent HTTP fallback below keeps the workspace
                    // fresh while the socket reconnects.
                }

                guard !Task.isCancelled,
                    let self,
                    self.isCurrentSession(client: activeClient, generation: generation)
                else {
                    return
                }
                self.lastShellEventAt = nil
                self.emitConnection(
                    .reconnecting,
                    detail: "Live updates paused. Refreshing over HTTP."
                )
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            }
        }
        let fallbackPollingInitialDelay = fallbackPollingInitialDelay
        let fallbackPollingInterval = fallbackPollingInterval
        fallbackPollingTask = Task { [weak self] in
            do {
                try await Task.sleep(for: fallbackPollingInitialDelay)
            } catch {
                return
            }
            while !Task.isCancelled {
                guard let self,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ) else {
                    return
                }
                if await self.recoverEnvironmentRoute(environmentID: activeClient.environment.id, promote: true) { return }
                let socketIsSynchronized =
                    await activeClient.liveConnectionActive()
                    && self.lastShellEventAt != nil
                    && !self.restoredShellEnvironmentIDs.contains(activeClient.environment.id)
                if !socketIsSynchronized {
                    self.emitConnection(
                        .reconnecting,
                        detail: "Live updates reconnecting. Refreshing over HTTP."
                    )
                    do {
                        let cacheLease = self.readCacheLeases[activeClient.environment.id]
                        let shell = try await activeClient.shellSnapshot()
                        guard !Task.isCancelled,
                              self.isCurrentSession(
                                  client: activeClient,
                                  generation: generation
                              ) else {
                            return
                        }
                        self.saveReadShell(shell, environmentID: activeClient.environment.id, lease: cacheLease)
                        await self.consumeFallbackShell(
                            shell: shell,
                            client: activeClient,
                            generation: generation
                        )
                    } catch is CancellationError {
                        return
                    } catch {
                        guard !Task.isCancelled,
                              self.isCurrentSession(
                                  client: activeClient,
                                  generation: generation
                              ) else {
                            return
                        }
                        if await self.recoverEnvironmentRoute(environmentID: activeClient.environment.id) { return }
                        if error.isRejectedAuthorization,
                           self.routeRejectionIsFinal(environmentID: activeClient.environment.id) {
                            self.markActiveEnvironmentNeedsPairing(detail: error.localizedDescription)
                            return
                        }
                        self.emitConnection(
                            .reconnecting,
                            detail: "Server unreachable. Retrying automatically."
                        )
                    }
                }
                do {
                    try await Task.sleep(for: fallbackPollingInterval)
                } catch {
                    return
                }
            }
        }
        configurationTask = Task { [weak self] in
            do {
                for try await event in await activeClient.serverConfigEvents() {
                    guard !Task.isCancelled,
                          let self,
                          self.isCurrentSession(
                              client: activeClient,
                              generation: generation
                          ) else {
                        break
                    }
                    switch event {
                    case let .snapshot(config):
                        self.latestServerConfig = config
                        self.setServerConfig(config, environmentID: activeClient.environment.id)
                    case let .providerStatuses(providers):
                        let previous = self.serverConfigsByEnvironmentID[
                            activeClient.environment.id
                        ]
                        var config = previous ?? self.latestServerConfig ?? ServerConfigSnapshot(providers: [])
                        config.providers = providers
                        self.latestServerConfig = config
                        self.setServerConfig(config, environmentID: activeClient.environment.id)
                    case let .settingsUpdated(settings):
                        let previous = self.serverConfigsByEnvironmentID[
                            activeClient.environment.id
                        ]
                        var config = previous ?? self.latestServerConfig ?? ServerConfigSnapshot(providers: [])
                        config.settings = settings
                        self.latestServerConfig = config
                        self.setServerConfig(config, environmentID: activeClient.environment.id)
                    case let .usageLimitSourcesUpdated(sources):
                        guard let previous = self.serverConfigsByEnvironmentID[activeClient.environment.id]
                            ?? self.latestServerConfig else { continue }
                        var config = previous
                        config.usageLimitSources = sources
                        self.latestServerConfig = config
                        self.setServerConfig(config, environmentID: activeClient.environment.id)
                        // Limits have their own subscription. A quota update
                        // does not change home rows or the model catalog.
                        continue
                    case .unrelated:
                        continue
                    }
                    if let shell = self.latestShell {
                        await self.emitSnapshot(
                            shell, client: activeClient, expectedGeneration: generation
                        )
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                // The shell and thread streams remain useful on older servers
                // that do not expose the provider catalogue subscription.
            }
        }
    }

    /// Non-active environments do not hold WebSocket subscriptions. A quiet
    /// HTTP refresh keeps their home rows and reachability useful without
    /// multiplying live streams or creating a high-frequency battery cost.
    private func startAggregateRefresh(_ activeClient: T3Client) {
        aggregateRefreshTask?.cancel()
        let generation = environmentGeneration
        let refreshID = UUID()
        let fastInterval = aggregateRefreshInterval
        let idleInterval = aggregateIdleRefreshInterval
        let failureInterval = aggregateFailureRefreshInterval
        let sleep = aggregateRefreshSleep
        let loadEnvironments = aggregateEnvironmentLoader
        aggregateRefreshID = refreshID
        aggregateRefreshTask = Task { [weak self] in
            var nextInterval = fastInterval
            var failureBackoffs: [String: Duration] = [:]
            while !Task.isCancelled {
                let elapsedInterval = nextInterval
                do {
                    try await sleep(nextInterval)
                } catch {
                    return
                }
                guard let self,
                      self.aggregateRefreshID == refreshID,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ),
                      let activeEnvironment = self.activeEnvironment else {
                    return
                }
                let environments: [Environment]
                let preferenceGenerations = self.orchestrationPreferenceGenerations
                do {
                    environments = try await loadEnvironments(self.runtime)
                } catch is CancellationError where Task.isCancelled {
                    return
                } catch {
                    // Persistence can be briefly unavailable while another
                    // actor atomically replaces the environment document.
                    // Back off while keeping the loop alive for recovery.
                    nextInterval = failureInterval
                    continue
                }
                guard !Task.isCancelled,
                      self.aggregateRefreshID == refreshID,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ) else {
                    return
                }
                let passiveEnvironments = environments.filter {
                    $0.isEnabled && $0.id != activeEnvironment.id
                }
                guard !passiveEnvironments.isEmpty else {
                    nextInterval = idleInterval
                    continue
                }
                let passiveIDs = Set(passiveEnvironments.map(\.id))
                failureBackoffs = failureBackoffs.reduce(into: [:]) { result, entry in
                    guard passiveIDs.contains(entry.key) else { return }
                    result[entry.key] = max(.zero, entry.value - elapsedInterval)
                }
                let refreshableEnvironments = passiveEnvironments.filter {
                    failureBackoffs[$0.id, default: .zero] <= .zero
                }
                guard !refreshableEnvironments.isEmpty else {
                    nextInterval = fastInterval
                    continue
                }
                let loads = await self.loadEnvironmentShells(refreshableEnvironments, preferenceGenerations: preferenceGenerations)
                guard !Task.isCancelled,
                      self.aggregateRefreshID == refreshID,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ) else {
                    return
                }
                let shellsChanged = loads.contains { load in
                    guard let shell = load.shell else { return false }
                    return shell != self.shellsByEnvironmentID[load.environment.id]
                }
                let hasActiveWork = loads.contains { load in
                    load.shell.map(Self.shellNeedsFrequentAggregateRefresh) == true
                }
                for load in loads {
                    if load.credentialRejected {
                        // Only re-pairing changes this. Re-pairing replaces
                        // the runtime client and restarts this loop.
                        failureBackoffs[load.environment.id] = .seconds(24 * 60 * 60)
                    } else if load.shell == nil {
                        failureBackoffs[load.environment.id] = failureInterval
                    } else {
                        failureBackoffs[load.environment.id] = nil
                    }
                }
                self.reconcileEnvironmentLoads(loads, savedEnvironments: environments)
                let currentConnection = self.latestSnapshot?.connection
                    ?? FeatureConnection(
                        state: .disconnected,
                        environmentName: activeEnvironment.label,
                        endpoint: activeEnvironment.httpBaseURL.absoluteString
                    )
                let snapshot = self.makeSnapshot(
                    environments: environments,
                    activeEnvironment: activeEnvironment,
                    connectionState: currentConnection.state,
                    connectionDetail: currentConnection.detail
                )
                self.publish(snapshot)
                if shellsChanged || hasActiveWork {
                    nextInterval = fastInterval
                } else {
                    nextInterval = idleInterval
                }
            }
        }
    }

    nonisolated private static func shellNeedsFrequentAggregateRefresh(
        _ shell: OrchestrationShellSnapshot
    ) -> Bool {
        shell.threads.contains { thread in
            thread.session?.status == "starting"
                || thread.session?.status == "running"
                || thread.latestTurn?.state == "running"
                || thread.hasPendingApprovals
                || thread.hasPendingUserInput
                || thread.backgroundLiveness == .working
                || thread.backgroundLiveness == .monitoring
        }
    }

    private func consume(
        shell: OrchestrationShellSnapshot,
        client: T3Client,
        generation: Int,
        refreshActiveThread: Bool
    ) async {
        guard isCurrentSession(client: client, generation: generation) else { return }
        adoptOrchestrationProtocol(shell, environmentID: client.environment.id)
        guard !Task.isCancelled,
              isCurrentSession(client: client, generation: generation),
              shell.snapshotSequence >= (latestShell?.snapshotSequence ?? .min) else {
            return
        }
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = shell
        shellsByEnvironmentID[client.environment.id] = shell
        saveReadShell(shell, environmentID: client.environment.id, lease: readCacheLeases[client.environment.id])
        await emitSnapshot(shell, client: client, expectedGeneration: generation)
        guard isCurrentSession(client: client, generation: generation) else { return }
        if refreshActiveThread, let threadID = activeThreadID {
            scheduleDetailRefresh(threadID: threadID, client: client)
        }
    }

    /// HTTP fallback refreshes data while preserving the socket's reconnecting
    /// state. The generation travels through the awaited snapshot publish so a
    /// task from a previous environment session cannot publish late results.
    private func consumeFallbackShell(
        shell: OrchestrationShellSnapshot,
        client: T3Client,
        generation: Int
    ) async {
        guard isCurrentSession(client: client, generation: generation) else { return }
        adoptOrchestrationProtocol(shell, environmentID: client.environment.id)
        guard isCurrentSession(client: client, generation: generation),
              shell.snapshotSequence >= (latestShell?.snapshotSequence ?? .min) else {
            return
        }
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = shell
        shellsByEnvironmentID[client.environment.id] = shell
        await emitSnapshot(
            shell,
            client: client,
            expectedGeneration: generation,
            markSourceConnected: false
        )
        guard isCurrentSession(client: client, generation: generation),
              let threadID = activeThreadID else {
            return
        }
        scheduleDetailRefresh(threadID: threadID, client: client)
    }

    private func consume(deltas: [ShellStreamItem], client: T3Client, generation: Int) async {
        guard !deltas.isEmpty, !Task.isCancelled,
              isCurrentSession(client: client, generation: generation) else { return }
        guard !restoredShellEnvironmentIDs.contains(client.environment.id), let current = latestShell else {
            if let shell = try? await client.shellSnapshot() {
                await consume(
                    shell: shell, client: client, generation: generation, refreshActiveThread: true
                )
            }
            return
        }

        var projects = current.projects
        var threads = current.threads
        var sequence = current.snapshotSequence
        var changedThreadIDs: Set<String> = []
        var shouldRefreshArchived = false

        for delta in deltas {
            if case let .repositoryIdentitiesUpdated(updates, resolvedRoots) = delta {
                projects = OrchestrationV2Presentation.mergingRepositoryIdentities(
                    projects, updates: updates, resolvedRoots: resolvedRoots
                )
                continue
            }
            let nextSequence: Int
            switch delta {
            case let .projectUpserted(value, _), let .projectRemoved(value, _),
                 let .threadUpserted(value, _), let .threadRemoved(value, _):
                nextSequence = value
            case .snapshot, .synchronized, .refreshRequired, .repositoryIdentitiesUpdated:
                continue
            }

            // Replayed deltas are expected after reconnect. They must be entirely
            // side-effect free, including for cached detail and selection state.
            guard nextSequence > sequence else { continue }
            sequence = nextSequence

            switch delta {
            case let .projectUpserted(_, project):
                if let index = projects.firstIndex(where: { $0.id == project.id }) {
                    projects[index] = project
                } else {
                    projects.append(project)
                }
            case let .projectRemoved(_, projectID):
                projects.removeAll { $0.id == projectID }
            case let .threadUpserted(_, thread):
                changedThreadIDs.insert(FeatureScopedID.thread(
                    environmentID: client.environment.id, wireID: thread.id
                ))
                archivedThreadsByEnvironmentID[client.environment.id]?.removeAll {
                    ($0.wireID ?? $0.id) == thread.id
                }
                if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                    threads[index] = thread
                } else {
                    threads.append(thread)
                }
            case let .threadRemoved(_, threadID):
                let uiThreadID = FeatureScopedID.thread(
                    environmentID: client.environment.id, wireID: threadID
                )
                changedThreadIDs.insert(uiThreadID)
                shouldRefreshArchived = true
                threads.removeAll { $0.id == threadID }
                latestDetails[uiThreadID] = nil
                detailRenderCaches[uiThreadID] = nil
                detailCacheRecency.removeAll { $0 == uiThreadID }
                if activeThreadID == uiThreadID {
                    resetDetailRefresh()
                    resetDetailStream()
                    activeThreadID = nil
                    activeThreadEnvironmentID = nil
                    activeRawThread = nil
                    activeThreadSequence = nil
                    activeThreadPage = nil
                    threadHistoryEpoch &+= 1
                    pendingOlderThreadPage = nil
                }
            case .snapshot, .synchronized, .refreshRequired, .repositoryIdentitiesUpdated:
                continue
            }
        }
        guard sequence > current.snapshotSequence || projects != current.projects else { return }

        let shell = OrchestrationShellSnapshot(
            snapshotSequence: sequence,
            projects: projects,
            threads: threads,
            updatedAt: current.updatedAt,
            orchestrationProtocolVersion: current.orchestrationProtocolVersion
        )
        latestShell = shell
        // Keep the source cache current during the coalesced UI publish. A
        // concurrent config or HTTP refresh must not restore an older shell.
        shellsByEnvironmentID[client.environment.id] = shell
        saveReadShell(shell, environmentID: client.environment.id, lease: readCacheLeases[client.environment.id])
        scheduleShellPublish(client)
        if shouldRefreshArchived {
            scheduleArchivedRefresh(client: client, environment: client.environment)
        }
        if let activeThreadID, changedThreadIDs.contains(activeThreadID) {
            scheduleDetailRefresh(threadID: activeThreadID, client: client)
        }
    }

    /// Shell streams can emit many metadata updates during one provider turn.
    /// Home only needs the newest row state, so publish at most four times per
    /// second while the selected transcript continues on its dedicated stream.
    private func scheduleShellPublish(_ client: T3Client) {
        guard shellPublishTask == nil else { return }
        let generation = environmentGeneration
        shellPublishTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self else { return }
            guard !Task.isCancelled,
                  self.isCurrentSession(client: client, generation: generation),
                  let shell = self.latestShell else {
                return
            }
            self.shellPublishTask = nil
            await self.emitSnapshot(shell, client: client, expectedGeneration: generation)
        }
    }

    private func scheduleDetailRefresh(
        threadID: String,
        client: T3Client,
        force: Bool = false
    ) {
        guard activeThreadID == threadID,
              activeThreadEnvironmentID == client.environment.id else { return }
        guard force || detailStreamTask == nil else { return }
        if force {
            detailWasSynchronized = false
            // This required read owns recovery now. An older fallback must not
            // replace its loading state with an error from a stale snapshot.
            detailCatchUpTask?.cancel()
            detailCatchUpTask = nil
            detailCatchUpID = nil
            continuation.yield(.threadSync(id: threadID, state: .catchingUp))
        }
        guard detailRefreshTask == nil else {
            detailRefreshPending = true
            return
        }
        detailRefreshPending = false
        detailRefreshGeneration &+= 1
        let generation = detailRefreshGeneration
        let sessionGeneration = environmentGeneration
        detailRefreshTask = Task { [weak self] in
            do {
                // Shell updates can be coalesced. A required replacement cannot
                // apply more thread events until its snapshot arrives.
                if !force {
                    try await Task.sleep(for: .milliseconds(250))
                }
            } catch {
                self?.finishDetailRefresh(generation: generation, client: client)
                return
            }
            guard let self else { return }
            if !Task.isCancelled,
               self.activeThreadID == threadID,
               self.isKnownClient(
                   client,
                   environmentID: client.environment.id,
                   generation: sessionGeneration
               ) {
                do {
                    try await self.refreshThread(id: threadID, client: client)
                } catch is CancellationError {
                    // Closing a thread cancels its read without changing its status.
                } catch {
                    if !Task.isCancelled,
                       self.detailRefreshGeneration == generation,
                       self.activeThreadID == threadID,
                       self.activeRawThread == nil || self.detailStreamTask == nil {
                        self.continuation.yield(.threadSync(
                            id: threadID, state: .failed(error.localizedDescription)
                        ))
                    }
                }
            }
            self.finishDetailRefresh(generation: generation, client: client)
        }
    }

    private func startDetailStream(_ route: NativeThreadRoute, warmConnectionID: UUID? = nil) {
        detailStreamGeneration &+= 1
        detailCompletionReceived = false
        detailWasSynchronized = warmConnectionID != nil
        activeDetailConnectionID = warmConnectionID
        let streamGeneration = detailStreamGeneration
        let sessionGeneration = environmentGeneration
        continuation.yield(.threadSync(
            id: route.uiID, state: warmConnectionID != nil ? .live : .catchingUp
        ))
        ensureDetailCatchUpFallback(route, generation: streamGeneration)
        let retryDelay = threadRetryDelay
        detailStreamTask = Task { [weak self] in
            var failedAttempts = 0
            var recoveringFromFailure = false
            while !Task.isCancelled,
                  self?.isCurrentDetail(route, generation: streamGeneration) == true,
                  self?.environmentGeneration == sessionGeneration {
                // The next connection resumes from applied state, not from
                // the cursor captured when the user first opened the thread.
                let sequence = self?.activeRawThread == nil ? nil : self?.activeThreadSequence
                let supportsPagination = self?.serverConfigsByEnvironmentID[
                    route.environmentID
                ]?.threadSnapshotPagination == true
                let subscriptionEpoch = self?.threadHistoryEpoch ?? 0
                var failedConnectionID: UUID?
                do {
                    guard !Task.isCancelled,
                          self?.isCurrentDetail(route, generation: streamGeneration) == true,
                          self?.environmentGeneration == sessionGeneration else { return }
                    let subscription = try await route.client.threadEventBatches(
                        threadID: route.wireID,
                        after: sequence,
                        turnLimit: supportsPagination ? Self.initialThreadUserTurnLimit : nil
                    )
                    let subscriptionConnectionID = subscription.connectionID
                    failedConnectionID = subscriptionConnectionID
                    guard !Task.isCancelled,
                          self?.isCurrentDetail(route, generation: streamGeneration) == true,
                          self?.environmentGeneration == sessionGeneration else { return }
                    if self?.detailWasSynchronized == true,
                       subscriptionConnectionID != self?.activeDetailConnectionID {
                        self?.detailWasSynchronized = false
                        self?.continuation.yield(.threadSync(id: route.uiID, state: .catchingUp))
                    }
                    self?.activeDetailConnectionID = subscriptionConnectionID
                    for try await items in subscription.events {
                        if items.contains(where: { if case .synchronized = $0 { true } else { false } }) {
                            let connectionID = await route.client.currentConnectionID()
                            guard !Task.isCancelled, let self,
                                  self.isCurrentDetail(route, generation: streamGeneration),
                                  self.environmentGeneration == sessionGeneration else { return }
                            if connectionID != subscriptionConnectionID {
                                self.activeDetailConnectionID = nil
                            }
                        }
                        guard !Task.isCancelled, let self,
                              self.isCurrentDetail(route, generation: streamGeneration),
                              self.environmentGeneration == sessionGeneration else { return }
                        failedAttempts = 0
                        if recoveringFromFailure {
                            recoveringFromFailure = false
                            self.continuation.yield(.threadSync(id: route.uiID, state: .catchingUp))
                            self.ensureDetailCatchUpFallback(route, generation: streamGeneration)
                        }
                        self.consumeDetailStreamBatch(
                            items, route: route, subscriptionEpoch: subscriptionEpoch
                        )
                    }
                    // A thread subscription stays open until its owner leaves.
                    // A clean end is not proof that the thread is still live.
                    throw RPCError.protocolViolation("The live thread stream ended.")
                } catch is CancellationError {
                    return
                } catch {
                    if let self, await self.recoverEnvironmentRoute(environmentID: route.environmentID) { return }
                    guard !Task.isCancelled,
                          self?.isCurrentDetail(route, generation: streamGeneration) == true else { return }
                    if Self.isTerminalThreadStreamFailure(error) {
                        self?.failDetailStream(route, message: "Could not synchronize the thread. Try again.")
                        do {
                            _ = try await route.client.waitForConnection(after: failedConnectionID)
                        } catch { return }
                        guard !Task.isCancelled,
                              self?.isCurrentDetail(route, generation: streamGeneration) == true else { return }
                        self?.continuation.yield(.threadSync(id: route.uiID, state: .catchingUp))
                        self?.ensureDetailCatchUpFallback(route, generation: streamGeneration)
                        continue
                    }
                    switch error {
                    case RPCError.disconnected, RPCError.connectionUnavailable:
                        break
                    default:
                        self?.failDetailStream(route, message: error.localizedDescription)
                        recoveringFromFailure = true
                        failedAttempts = min(6, failedAttempts + 1)
                        do { try await retryDelay(failedAttempts) }
                        catch { return }
                        continue
                    }
                }
                guard !Task.isCancelled,
                      self?.isCurrentDetail(route, generation: streamGeneration) == true else { return }
                self?.detailCompletionReceived = false
                self?.detailWasSynchronized = false
                self?.activeDetailConnectionID = nil
                self?.continuation.yield(.threadSync(id: route.uiID, state: .reconnecting))
                self?.ensureDetailCatchUpFallback(route, generation: streamGeneration)
                do {
                    _ = try await route.client.waitForConnection(after: failedConnectionID)
                }
                catch { return }
            }
        }
    }

    private static func isTerminalThreadStreamFailure(_ error: any Error) -> Bool {
        if error is DecodingError { return true }
        if case RPCError.protocolViolation = error { return true }
        if case RPCError.remoteDefect = error { return true }
        return false
    }

    private func failDetailStream(_ route: NativeThreadRoute, message: String) {
        // Drain applied updates before retaining the diagnostic. An older HTTP
        // read must not replace this failure with an unrelated loading state.
        flushDetailPublish(route)
        resetDetailRefresh()
        detailCatchUpTask?.cancel()
        detailCatchUpTask = nil
        detailCatchUpID = nil
        detailCompletionReceived = false
        detailWasSynchronized = false
        activeDetailConnectionID = nil
        continuation.yield(.threadSync(id: route.uiID, state: .failed(message)))
    }

    private func isCurrentDetail(_ route: NativeThreadRoute, generation: Int) -> Bool {
        detailStreamGeneration == generation
            && activeThreadID == route.uiID
            && environmentClients[route.environmentID] === route.client
    }

    private func ensureDetailCatchUpFallback(_ route: NativeThreadRoute, generation: Int) {
        guard detailCatchUpTask == nil, detailRefreshTask == nil else { return }
        let id = UUID()
        detailCatchUpID = id
        let delay = catchUpDelay
        detailCatchUpTask = Task { [weak self] in
            defer {
                if self?.detailCatchUpID == id {
                    self?.detailCatchUpTask = nil
                    self?.detailCatchUpID = nil
                }
            }
            do {
                try await delay()
                guard !Task.isCancelled,
                      self?.isCurrentDetail(route, generation: generation) == true else { return }
                try await self?.refreshThread(
                    id: route.uiID,
                    client: route.client,
                    expectedStreamGeneration: generation
                )
                guard !Task.isCancelled, let self,
                      self.isCurrentDetail(route, generation: generation),
                      self.activeRawThread != nil,
                      !self.detailRefreshPending else { return }
                if self.serverConfigsByEnvironmentID[route.environmentID]?
                    .threadResumeCompletionMarker == true {
                    self.continuation.yield(.threadSync(id: route.uiID, state: .reconnecting))
                } else {
                    self.markDetailSynchronized(route)
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled,
                      self?.isCurrentDetail(route, generation: generation) == true else { return }
                self?.continuation.yield(.threadSync(id: route.uiID, state: .failed(error.localizedDescription)))
            }
        }
    }

    private func markDetailSynchronized(_ route: NativeThreadRoute) {
        guard activeRawThread != nil, !detailRefreshPending else { return }
        // Flush the final message before publishing the completion state.
        // Otherwise the loading label can vanish one render before the text.
        flushDetailPublish(route)
        detailCatchUpTask?.cancel()
        detailCatchUpTask = nil
        detailCatchUpID = nil
        detailWasSynchronized = true
        continuation.yield(.threadSync(id: route.uiID, state: .live))
    }

    private func beginWarmReplayIfNeeded(_ route: NativeThreadRoute) {
        guard detailWasSynchronized, !detailCompletionReceived,
              serverConfigsByEnvironmentID[route.environmentID]?.threadResumeCompletionMarker == true else { return }
        detailWasSynchronized = false
        continuation.yield(.threadSync(id: route.uiID, state: .catchingUp))
        ensureDetailCatchUpFallback(route, generation: detailStreamGeneration)
    }

    private func consumeDetailStreamBatch(
        _ items: [ThreadStreamItem],
        route: NativeThreadRoute,
        subscriptionEpoch: Int
    ) {
        // Keep snapshot replacement and page-watermark merges at their event
        // positions. Ordinary replay batches share one legacy sync publication.
        let previousSequence = activeThreadSequence
        let needsIndividualUpdates = items.count == 1 || activeRawThread == nil
            || pendingOlderThreadPage != nil || items.contains { item in
                switch item {
                case .snapshot, .projection: true
                case let .event(event):
                    event["type"]?.stringValue == "thread.reverted"
                        || event["type"]?.stringValue == "thread.deleted"
                case .synchronized: false
                }
            }
        for item in items {
            consumeDetailStreamItem(
                item, route: route, subscriptionEpoch: subscriptionEpoch,
                synchronizeLegacy: needsIndividualUpdates
            )
        }
        if !needsIndividualUpdates, activeThreadSequence != previousSequence,
           serverConfigsByEnvironmentID[route.environmentID]?.threadResumeCompletionMarker != true {
            markDetailSynchronized(route)
        }
    }

    private func consumeDetailStreamItem(
        _ item: ThreadStreamItem,
        route: NativeThreadRoute,
        subscriptionEpoch: Int,
        synchronizeLegacy: Bool
    ) {
        switch item {
        case let .projection(snapshot):
            let previous = activeRawThread
            if let revision = snapshot.thread.orchestrationV2Revision,
               let displayed = previous?.orchestrationV2Revision, revision < displayed { return }
            let changedProtocol = previous != nil && previous?.orchestrationV2Control == nil
            guard changedProtocol || snapshot.snapshotSequence >= (activeThreadSequence ?? 0) else { return }
            if changedProtocol {
                threadHistoryEpoch &+= 1
                pendingOlderThreadPage = nil
                detailRenderCaches[route.uiID] = nil
            }
            beginWarmReplayIfNeeded(route)
            resetDetailRefresh()
            detailSnapshotRequiredAfterEpoch = nil
            activeThreadSequence = snapshot.snapshotSequence
            activeRawThread = snapshot.thread
            activeThreadPage = featurePage(snapshot.page)
            if let previous, !changedProtocol,
               Set(previous.messages.map(\.id)).isSubset(of: Set(snapshot.thread.messages.map(\.id))),
               Set(previous.activities.map(\.id)).isSubset(of: Set(snapshot.thread.activities.map(\.id))) {
                let messages = Dictionary(previous.messages.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
                let activities = Dictionary(previous.activities.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
                for message in snapshot.thread.messages where messages[message.id] != message {
                    scheduleRawDetailPublish(route: route, mutation: .message(message))
                }
                for activity in snapshot.thread.activities where activities[activity.id] != activity {
                    scheduleRawDetailPublish(route: route, mutation: .activity(activity))
                }
                scheduleRawDetailPublish(route: route, mutation: .metadata)
            } else {
                scheduleRawDetailPublish(route: route, mutation: .full)
            }
            if detailCompletionReceived { markDetailSynchronized(route) }
        case .synchronized:
            detailCompletionReceived = true
            guard activeRawThread != nil else { return }
            markDetailSynchronized(route)
            return
        case let .snapshot(snapshot):
            // A cursor-less event cannot prove that an already-requested
            // snapshot includes it. Keep the post-event read until it does.
            if let requiredEpoch = detailSnapshotRequiredAfterEpoch,
               subscriptionEpoch < requiredEpoch { return }
            guard snapshot.snapshotSequence >= (activeThreadSequence ?? 0),
                  activeRawThread == nil || snapshot.snapshotSequence > (activeThreadSequence ?? 0) else { return }
            beginWarmReplayIfNeeded(route)
            resetDetailRefresh()
            detailSnapshotRequiredAfterEpoch = nil
            threadHistoryEpoch &+= 1
            pendingOlderThreadPage = nil
            activeThreadSequence = snapshot.snapshotSequence
            activeRawThread = snapshot.thread
            activeThreadPage = featurePage(snapshot.page)
            scheduleRawDetailPublish(route: route, mutation: .full)
            if detailCompletionReceived { markDetailSynchronized(route) }
        case let .event(event):
            guard let current = activeRawThread else {
                // Do not apply later events to a snapshot that missed earlier
                // ones. It must cover every event skipped while replacing it.
                if case let .number(value) = event["sequence"],
                   let sequence = Int(exactly: value), sequence >= 0 {
                    activeThreadSequence = max(activeThreadSequence ?? 0, sequence)
                } else {
                    // An event without a cursor needs a read started after it.
                    threadHistoryEpoch &+= 1
                    detailSnapshotRequiredAfterEpoch = threadHistoryEpoch
                    pendingOlderThreadPage = nil
                }
                scheduleDetailRefresh(threadID: route.uiID, client: route.client, force: true)
                return
            }
            let reduction = NativeThreadDetailReducer.apply(
                event, to: current, afterSequence: activeThreadSequence ?? 0
            )
            if reduction.sequence < 0 {
                threadHistoryEpoch &+= 1
                detailSnapshotRequiredAfterEpoch = threadHistoryEpoch
                pendingOlderThreadPage = nil
                activeRawThread = nil
                discardPendingDetailPublish()
                scheduleDetailRefresh(threadID: route.uiID, client: route.client, force: true)
                return
            }
            guard reduction.sequence > (activeThreadSequence ?? 0) else { return }
            beginWarmReplayIfNeeded(route)
            switch reduction.result {
            case let .updated(thread):
                activeThreadSequence = reduction.sequence
                activeRawThread = thread
                scheduleRawDetailPublish(route: route, mutation: reduction.renderMutation)
                tryMergePendingOlderThreadPage(route: route)
            case .unchanged:
                activeThreadSequence = reduction.sequence
                tryMergePendingOlderThreadPage(route: route)
            case .refresh:
                threadHistoryEpoch &+= 1
                pendingOlderThreadPage = nil
                activeThreadSequence = reduction.sequence
                activeRawThread = nil
                discardPendingDetailPublish()
                scheduleDetailRefresh(threadID: route.uiID, client: route.client, force: true)
            }
        }
        if let thread = activeRawThread, let sequence = activeThreadSequence {
            var saved = OrchestrationThreadDetailSnapshot(snapshotSequence: sequence, thread: thread)
            saved.orchestrationProtocolVersion = thread.orchestrationV2Control == nil ? 1 : 2
            saveReadHistory(saved, environmentID: route.environmentID, lease: readCacheLeases[route.environmentID])
        }
        if synchronizeLegacy,
           serverConfigsByEnvironmentID[route.environmentID]?.threadResumeCompletionMarker != true {
            markDetailSynchronized(route)
        }
    }

    private func scheduleRawDetailPublish(
        route: NativeThreadRoute,
        mutation: NativeDetailRenderMutation
    ) {
        pendingDetailRenderMutations.formUnion(mutation)
        guard detailPublishTask == nil else { return }
        let streamGeneration = detailStreamGeneration
        detailPublishTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(80))
            guard let self else { return }
            guard !Task.isCancelled,
                  self.detailStreamGeneration == streamGeneration,
                  self.activeThreadID == route.uiID,
                  self.activeRawThread != nil else {
                return
            }
            self.detailPublishTask = nil
            self.flushDetailPublish(route)
        }
    }

    private func flushDetailPublish(_ route: NativeThreadRoute) {
        guard pendingDetailRenderMutations.hasUpdates,
              activeThreadID == route.uiID, let rawThread = activeRawThread else { return }
        detailPublishTask?.cancel()
        detailPublishTask = nil
        let mutations = pendingDetailRenderMutations
        pendingDetailRenderMutations = NativeDetailRenderMutations()
        let previousDetail = latestDetails[route.uiID]
        let detail = mapDetail(
            rawThread, environment: route.client.environment,
            sourceSequence: activeThreadSequence ?? 0, mutations: mutations,
            page: activeThreadPage
        )
        let delta = makeDetailDelta(previous: previousDetail, next: detail, mutations: mutations)
        publish(detail, threadID: route.uiID, renderCacheIsSource: true, delta: delta)
    }

    private func retainActiveThread() {
        guard let id = activeThreadID, let route = try? threadRoute(for: id) else { return }
        guard let raw = activeRawThread, let sequence = activeThreadSequence else {
            threadResumeStates[id] = nil
            return
        }
        flushDetailPublish(route)
        var page = activeThreadPage
        page?.isLoading = false
        threadResumeStates[id] = NativeThreadResumeState(
            client: route.client, thread: raw, sequence: sequence, page: page,
            wasSynchronized: detailWasSynchronized,
            connectionID: activeDetailConnectionID
        )
    }

    private func finishDetailRefresh(generation: Int, client: T3Client) {
        guard detailRefreshGeneration == generation else { return }
        detailRefreshTask = nil
        let needsTrailingRefresh = detailRefreshPending
        detailRefreshPending = false
        if needsTrailingRefresh, let threadID = activeThreadID {
            // Events received without a base snapshot cannot be reduced. Read
            // again even when the stream is open so those events are included.
            scheduleDetailRefresh(threadID: threadID, client: client, force: true)
        }
    }

    private func resetDetailRefresh() {
        detailRefreshGeneration &+= 1
        detailRefreshTask?.cancel()
        detailRefreshTask = nil
        detailRefreshPending = false
    }

    private func resetDetailStream() {
        detailStreamGeneration &+= 1
        detailCompletionReceived = false
        detailWasSynchronized = false
        activeDetailConnectionID = nil
        detailSnapshotRequiredAfterEpoch = nil
        detailStreamTask?.cancel()
        detailStreamTask = nil
        detailCatchUpTask?.cancel()
        detailCatchUpTask = nil
        detailCatchUpID = nil
        discardPendingDetailPublish()
    }

    private func discardPendingDetailPublish() {
        detailPublishTask?.cancel()
        detailPublishTask = nil
        pendingDetailRenderMutations = NativeDetailRenderMutations()
    }

    private func loadEnvironmentShells(
        _ environments: [Environment], preferenceGenerations: [String: Int]
    ) async -> [EnvironmentShellLoad] {
        await prepareReadCacheLeases(environments)
        let leases = readCacheLeases
        let activeEnvironmentID = activeEnvironment?.id
        let environmentsWithCachedConfig = Set(serverConfigsByEnvironmentID.keys)
        let shellTimeoutInterval = environmentShellTimeoutInterval
        let runtime = runtime
        var clients: [(environment: Environment, client: T3Client)] = []
        clients.reserveCapacity(environments.count)
        for environment in environments {
            guard !revokedCacheEnvironmentIDs.contains(environment.id),
                  preferenceGenerations[environment.id, default: 0]
                    == orchestrationPreferenceGenerations[environment.id, default: 0] else { continue }
            clients.append(
                (environment, await runtime.client(for: environment))
            )
        }

        return await withTaskGroup(of: EnvironmentShellLoad.self) { group in
            for pair in clients {
                group.addTask {
                    var selectedClient = pair.client
                    var selectedEnvironment = pair.environment
                    let shell: OrchestrationShellSnapshot?
                    do {
                        shell = try await pair.client.shellSnapshot(
                            timeoutInterval: shellTimeoutInterval
                        )
                    } catch {
                        do {
                            guard pair.environment.id != activeEnvironmentID, pair.environment.routes.count > 1,
                                  !Task.isCancelled else { throw error }
                            selectedClient = try await runtime.resolveClient(for: pair.environment, connectSocket: false)
                            selectedEnvironment = selectedClient.environment
                            shell = try await selectedClient.shellSnapshot(timeoutInterval: shellTimeoutInterval)
                        } catch {
                            return EnvironmentShellLoad(
                                environment: selectedEnvironment, client: selectedClient, shell: nil, config: nil,
                                credentialRejected: error.isRejectedAuthorization, failureDetail: error.localizedDescription,
                                preferenceGeneration: preferenceGenerations[pair.environment.id, default: 0]
                            )
                        }
                    }

                    let session = try? await selectedClient.authSession()
                    let isActive = pair.environment.id == activeEnvironmentID
                    let shouldFetchConfig = isActive
                        || !environmentsWithCachedConfig.contains(pair.environment.id)
                    var config: ServerConfigSnapshot?
                    if shouldFetchConfig {
                        if isActive {
                            config = try? await selectedClient.serverConfig()
                        } else {
                            // A passive catalogue is a bounded one-shot RPC on
                            // an uncached client. Never disconnect the shared
                            // client because the environment may become active
                            // while this aggregate load is in flight.
                            let probe = await runtime.ephemeralClient(
                                for: selectedEnvironment
                            )
                            config = try? await probe.serverConfig()
                            await probe.disconnect()
                        }
                    }
                    return EnvironmentShellLoad(
                        environment: selectedEnvironment,
                        client: selectedClient,
                        shell: shell,
                        config: config,
                        session: session,
                        preferenceGeneration: preferenceGenerations[pair.environment.id, default: 0],
                        cacheLease: leases[pair.environment.id]
                    )
                }
            }
            var loads: [EnvironmentShellLoad] = []
            loads.reserveCapacity(environments.count)
            for await load in group {
                loads.append(load)
            }
            return loads
        }
    }

    /// Successful reads replace that environment's cache. Failed reads leave
    /// its last-known rows intact, so one offline machine cannot empty home.
    private func reconcileEnvironmentLoads(
        _ loads: [EnvironmentShellLoad],
        savedEnvironments: [Environment]
    ) {
        let savedIDs = Set(savedEnvironments.map(\.id))
        environmentClients = environmentClients.filter { savedIDs.contains($0.key) }
        environmentPermissions = environmentPermissions.filter { savedIDs.contains($0.key) }
        shellsByEnvironmentID = shellsByEnvironmentID.filter { savedIDs.contains($0.key) }
        shellProjectionCache = shellProjectionCache.filter { savedIDs.contains($0.key) }
        serverConfigsByEnvironmentID = serverConfigsByEnvironmentID.filter {
            savedIDs.contains($0.key)
        }
        providerCatalogCache = providerCatalogCache.filter {
            savedIDs.contains($0.key)
        }
        archivedThreadsByEnvironmentID = archivedThreadsByEnvironmentID.filter {
            savedIDs.contains($0.key)
        }
        archivedShellThreadsByEnvironmentID = archivedShellThreadsByEnvironmentID.filter {
            savedIDs.contains($0.key)
        }
        environmentConnectionStates = environmentConnectionStates.filter {
            savedIDs.contains($0.key)
        }
        environmentConnectionDetails = environmentConnectionDetails.filter {
            savedIDs.contains($0.key)
        }

        for load in loads {
            guard !revokedCacheEnvironmentIDs.contains(load.environment.id),
                  load.preferenceGeneration == orchestrationPreferenceGenerations[load.environment.id, default: 0] else {
                continue
            }
            let routeChanged = environmentClients[load.environment.id].map { $0 !== load.client } ?? false
            environmentClients[load.environment.id] = load.client
            if routeChanged {
                attachmentURLs.removeAll()
                if activeThreadEnvironmentID == load.environment.id,
                   activeEnvironment?.id != load.environment.id,
                   let threadID = activeThreadID, let route = try? threadRoute(for: threadID) {
                    resetDetailRefresh()
                    resetDetailStream()
                    startDetailStream(route)
                }
            }
            if let config = load.config {
                setServerConfig(config, environmentID: load.environment.id)
                if load.environment.id == activeEnvironment?.id {
                    latestServerConfig = config
                }
            }
            environmentPermissions[load.environment.id] = load.shell == nil ? nil
                : EnvironmentPermissionState(session: load.session, serverAuth: serverConfigsByEnvironmentID[load.environment.id]?.auth)
            if let shell = load.shell {
                adoptOrchestrationProtocol(shell, environmentID: load.environment.id)
                if shell.snapshotSequence
                    >= (shellsByEnvironmentID[load.environment.id]?.snapshotSequence ?? .min) {
                    shellsByEnvironmentID[load.environment.id] = shell
                    saveReadShell(shell, environmentID: load.environment.id, lease: load.cacheLease)
                }
                environmentConnectionStates[load.environment.id] = .connected
                environmentConnectionDetails[load.environment.id] = nil
            } else if load.credentialRejected && load.environment.kind != .managedDPoP && load.environment.routes.count == 1 {
                environmentConnectionStates[load.environment.id] = .needsPairing
                environmentConnectionDetails[load.environment.id] = Self.needsPairingDetail
            } else {
                environmentConnectionStates[load.environment.id] = .disconnected
                environmentConnectionDetails[load.environment.id] =
                    load.failureDetail ?? "That server is currently unreachable."
            }
        }
        rebuildEntityIndexes(savedEnvironments)
    }

    static let needsPairingDetail = "This computer no longer accepts the saved pairing. Pair again."

    /// A rejected credential cannot recover on its own. Stop the live
    /// subscription and the HTTP fallback so the app is not minting tickets
    /// and polling a 401 every few seconds until the user pairs again.
    private func markActiveEnvironmentNeedsPairing(detail: String?) {
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        pollingTask = nil
        fallbackPollingTask = nil
        configurationTask = nil
        lastShellEventAt = nil
        if activeEnvironment?.kind == .managedDPoP {
            emitConnection(.disconnected, detail: detail)
        } else {
            emitConnection(.needsPairing, detail: Self.needsPairingDetail)
        }
        if let client {
            Task { await client.disconnect() }
        }
    }

    private func newestShell(
        _ candidate: OrchestrationShellSnapshot,
        for environment: Environment
    ) -> OrchestrationShellSnapshot {
        adoptOrchestrationProtocol(candidate, environmentID: environment.id)
        let latest: OrchestrationShellSnapshot
        if let cached = shellsByEnvironmentID[environment.id],
           cached.snapshotSequence > candidate.snapshotSequence {
            latest = cached
        } else {
            latest = candidate
            shellsByEnvironmentID[environment.id] = candidate
        }
        if activeEnvironment?.id == environment.id {
            latestShell = latest
        }
        return latest
    }

    /// Server upgrades start a different event sequence. Discard versioned
    /// state before comparing cursors, while preserving credentials and drafts.
    private func adoptOrchestrationProtocol(_ shell: OrchestrationShellSnapshot, environmentID: String) {
        // Saved cursors are display metadata, never synchronization authority.
        if restoredShellEnvironmentIDs.remove(environmentID) != nil {
            shellsByEnvironmentID[environmentID] = nil
            shellProjectionCache[environmentID] = nil
            if activeEnvironment?.id == environmentID { latestShell = nil }
        }
        let version = shell.orchestrationProtocolVersion ?? 1
        let previous = orchestrationVersions.updateValue(version, forKey: environmentID)
        guard let previous, previous != version else { return }
        shellsByEnvironmentID[environmentID] = nil
        shellProjectionCache[environmentID] = nil
        archivedThreadsByEnvironmentID[environmentID] = nil
        archivedShellThreadsByEnvironmentID[environmentID] = nil
        serverConfigsByEnvironmentID[environmentID] = nil
        if activeEnvironment?.id == environmentID { latestShell = nil }
        for id in threadEnvironmentIDs.keys where threadEnvironmentIDs[id] == environmentID {
            threadResumeStates[id] = nil
            detailRenderCaches[id] = nil
            latestDetails[id] = nil
        }
        if activeThreadEnvironmentID == environmentID, let id = activeThreadID,
           let route = try? threadRoute(for: id) {
            resetDetailRefresh()
            resetDetailStream()
            activeRawThread = nil
            activeThreadSequence = nil
            activeThreadPage = nil
            threadHistoryEpoch &+= 1
            pendingOlderThreadPage = nil
            continuation.yield(.threadSync(id: id, state: .catchingUp))
            startDetailStream(route)
        }
    }

    private func rebuildEntityIndexes(_ environments: [Environment]) {
        let savedIDs = Set(environments.map(\.id))
        provisionalThreadRoutes = provisionalThreadRoutes.filter {
            savedIDs.contains($0.value.environmentID)
        }

        // Metadata changes do not change routing. Avoid rebuilding scoped IDs
        // and ambiguity sets for every title, activity, or settlement update.
        let membership = environments.map { environment in
            NativeShellMembership(
                environmentID: environment.id,
                projectIDs: shellsByEnvironmentID[environment.id]?.projects.map(\.id) ?? [],
                threadIDs: shellsByEnvironmentID[environment.id]?.threads.map(\.id) ?? [],
                archivedIDs: archivedThreadsByEnvironmentID[environment.id]?.map {
                    $0.wireID ?? $0.id
                } ?? []
            )
        }
        guard membership != indexedShellMembership
            || provisionalThreadRoutes != indexedProvisionalRoutes else { return }

        var nextProjectEnvironments: [String: String] = [:]
        var nextProjectWireIDs: [String: String] = [:]
        var nextThreadEnvironments: [String: String] = [:]
        var nextThreadWireIDs: [String: String] = [:]
        var projectCandidates: [String: Set<EntityWireOwner>] = [:]
        var threadCandidates: [String: Set<EntityWireOwner>] = [:]
        var materializedThreadIDs: Set<String> = []

        for environment in environments {
            let environmentID = environment.id
            for project in shellsByEnvironmentID[environmentID]?.projects ?? [] {
                let uiID = FeatureScopedID.project(
                    environmentID: environmentID,
                    wireID: project.id
                )
                nextProjectEnvironments[uiID] = environmentID
                nextProjectWireIDs[uiID] = project.id
                projectCandidates[project.id, default: []].insert(
                    EntityWireOwner(environmentID: environmentID, wireID: project.id)
                )
            }
            for thread in shellsByEnvironmentID[environmentID]?.threads ?? [] {
                let uiID = FeatureScopedID.thread(
                    environmentID: environmentID,
                    wireID: thread.id
                )
                nextThreadEnvironments[uiID] = environmentID
                nextThreadWireIDs[uiID] = thread.id
                materializedThreadIDs.insert(uiID)
                threadCandidates[thread.id, default: []].insert(
                    EntityWireOwner(environmentID: environmentID, wireID: thread.id)
                )
            }
            for thread in archivedThreadsByEnvironmentID[environmentID] ?? [] {
                let wireID = thread.wireID ?? thread.id
                let uiID = FeatureScopedID.thread(
                    environmentID: environmentID,
                    wireID: wireID
                )
                nextThreadEnvironments[uiID] = environmentID
                nextThreadWireIDs[uiID] = wireID
                materializedThreadIDs.insert(uiID)
                threadCandidates[wireID, default: []].insert(
                    EntityWireOwner(environmentID: environmentID, wireID: wireID)
                )
            }
        }

        provisionalThreadRoutes = provisionalThreadRoutes.filter {
            !materializedThreadIDs.contains($0.key)
        }
        for (uiID, provisional) in provisionalThreadRoutes {
            nextThreadEnvironments[uiID] = provisional.environmentID
            nextThreadWireIDs[uiID] = provisional.wireID
            threadCandidates[provisional.wireID, default: []].insert(
                EntityWireOwner(
                    environmentID: provisional.environmentID,
                    wireID: provisional.wireID
                )
            )
        }

        // Raw IDs remain accepted for source-compatible fixtures only when
        // their owner is unambiguous. Native snapshots always use scoped IDs.
        for (rawID, candidates) in projectCandidates where candidates.count == 1 {
            guard let owner = candidates.first else { continue }
            nextProjectEnvironments[rawID] = owner.environmentID
            nextProjectWireIDs[rawID] = owner.wireID
        }
        for (rawID, candidates) in threadCandidates where candidates.count == 1 {
            guard let owner = candidates.first else { continue }
            nextThreadEnvironments[rawID] = owner.environmentID
            nextThreadWireIDs[rawID] = owner.wireID
        }

        projectEnvironmentIDs = nextProjectEnvironments
        projectWireIDs = nextProjectWireIDs
        threadEnvironmentIDs = nextThreadEnvironments
        threadWireIDs = nextThreadWireIDs
        indexedShellMembership = membership
        indexedProvisionalRoutes = provisionalThreadRoutes
    }

    private func refresh(client: T3Client, includeArchived: Bool = false) async throws {
        let environment = client.environment
        let generation = environmentGeneration
        let shell = try await client.shellSnapshot()
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        adoptOrchestrationProtocol(shell, environmentID: environment.id)
        guard shell.snapshotSequence
            >= (shellsByEnvironmentID[environment.id]?.snapshotSequence ?? .min) else {
            return
        }
        shellsByEnvironmentID[environment.id] = shell
        if activeEnvironment?.id == environment.id {
            latestShell = shell
        }
        if includeArchived,
           let archivedShell = try? await client.archivedShellSnapshot(),
           isKnownClient(client, environmentID: environment.id, generation: generation) {
            archivedThreadsByEnvironmentID[environment.id] = archivedShell.threads.map {
                mapThread($0, environment: environment)
            }
            archivedShellThreadsByEnvironmentID[environment.id] = Dictionary(
                uniqueKeysWithValues: archivedShell.threads.map { ($0.id, $0) }
            )
        }
        await emitSnapshot(shell, client: client, expectedGeneration: generation)
    }

    private func scheduleArchivedRefresh(client: T3Client, environment: Environment) {
        archivedRefreshTask?.cancel()
        let generation = environmentGeneration
        archivedRefreshTask = Task { [weak self] in
            guard let self,
                  let archivedShell = try? await client.archivedShellSnapshot(),
                  !Task.isCancelled,
                  self.isCurrentSession(client: client, generation: generation) else {
                return
            }
            self.archivedThreadsByEnvironmentID[environment.id] = archivedShell.threads.map {
                self.mapThread($0, environment: environment)
            }
            self.archivedShellThreadsByEnvironmentID[environment.id] = Dictionary(
                uniqueKeysWithValues: archivedShell.threads.map { ($0.id, $0) }
            )
            if let shell = self.latestShell {
                await self.emitSnapshot(shell, client: client, expectedGeneration: generation)
            }
        }
    }

    /// After a request is answered, the detail stream delivers the matching
    /// `approval.resolved` or `user-input.resolved` event. Re-reading the
    /// snapshot here would replace `activeRawThread` with the first page and
    /// drop every "Load earlier" page the user opened. Only fall back to a
    /// read when the stream is not synchronized for this thread.
    private func refreshThreadUnlessLive(id: String, client: T3Client) async {
        if activeThreadID == id, detailWasSynchronized { return }
        try? await refreshThread(id: id, client: client)
    }

    private func refreshThread(
        id: String, client: T3Client, expectedStreamGeneration: Int? = nil
    ) async throws {
        let route = try threadRoute(for: id)
        guard route.client === client else {
            throw NativeFeatureClientError.threadNotFound
        }
        let environment = route.client.environment
        let generation = environmentGeneration
        let historyEpoch = threadHistoryEpoch
        let cacheLease = readCacheLeases[environment.id]
        let supportsPagination = serverConfigsByEnvironmentID[
            environment.id
        ]?.threadSnapshotPagination == true
        let snapshot = try await client.threadSnapshot(
            id: route.wireID,
            turnLimit: supportsPagination ? Self.initialThreadUserTurnLimit : nil,
            timeoutInterval: threadSnapshotTimeoutInterval
        )
        guard !Task.isCancelled,
              isKnownClient(client, environmentID: environment.id, generation: generation),
              expectedStreamGeneration.map({ isCurrentDetail(route, generation: $0) }) ?? true else {
            throw CancellationError()
        }
        saveReadHistory(snapshot, environmentID: environment.id, lease: cacheLease)
        if activeThreadID == route.uiID {
            if activeRawThread == nil, historyEpoch != threadHistoryEpoch {
                return
            }
            guard snapshot.snapshotSequence >= (activeThreadSequence ?? 0) else {
                if activeRawThread == nil {
                    if !detailRefreshPending {
                        throw NativeFeatureClientError.threadSnapshotOutdated
                    }
                } else if detailCompletionReceived
                            || serverConfigsByEnvironmentID[environment.id]?.threadResumeCompletionMarker != true {
                    markDetailSynchronized(route)
                }
                return
            }
            discardPendingDetailPublish()
            // This snapshot includes the skipped events, so their pending
            // request is satisfied without another HTTP read.
            detailRefreshPending = false
            detailSnapshotRequiredAfterEpoch = nil
            threadHistoryEpoch &+= 1
            pendingOlderThreadPage = nil
            activeRawThread = snapshot.thread
            activeThreadSequence = snapshot.snapshotSequence
            activeThreadPage = featurePage(snapshot.page)
        } else if let cached = threadResumeStates[route.uiID],
                  snapshot.snapshotSequence < cached.sequence {
            return
        }
        let detail = mapDetail(
            snapshot.thread,
            environment: environment,
            sourceSequence: snapshot.snapshotSequence,
            page: activeThreadID == route.uiID ? activeThreadPage : featurePage(snapshot.page)
        )
        publish(detail, threadID: route.uiID)
        threadResumeStates[route.uiID] = NativeThreadResumeState(
            client: client, thread: snapshot.thread, sequence: snapshot.snapshotSequence,
            page: featurePage(snapshot.page),
            wasSynchronized: false,
            connectionID: nil
        )
        if activeThreadID == route.uiID,
           detailCompletionReceived
            || serverConfigsByEnvironmentID[environment.id]?.threadResumeCompletionMarker != true {
            markDetailSynchronized(route)
        }
    }

    /// Snapshots belong to the client that read them, not the selected inbox
    /// connection. Keep that source and its session through the awaited read.
    private func emitSnapshot(
        _ shell: OrchestrationShellSnapshot,
        client sourceClient: T3Client,
        expectedGeneration: Int,
        markSourceConnected: Bool = true
    ) async {
        let sourceEnvironment = sourceClient.environment
        guard !Task.isCancelled,
              let environment = activeEnvironment,
              isKnownClient(
                  sourceClient, environmentID: sourceEnvironment.id, generation: expectedGeneration
              ) else { return }
        let environments = (try? await runtime.environments()) ?? [environment]
        guard !Task.isCancelled,
              isKnownClient(
                  sourceClient, environmentID: sourceEnvironment.id, generation: expectedGeneration
              ),
              activeEnvironment?.id == environment.id,
              environments.contains(where: { $0.id == sourceEnvironment.id && $0.isEnabled }),
              shell.snapshotSequence
                  >= (shellsByEnvironmentID[sourceEnvironment.id]?.snapshotSequence ?? .min) else {
            return
        }
        shellsByEnvironmentID[sourceEnvironment.id] = shell
        let markSourceConnected = markSourceConnected && !restoredShellEnvironmentIDs.contains(sourceEnvironment.id)
        if markSourceConnected {
            environmentConnectionStates[sourceEnvironment.id] = .connected
            environmentConnectionDetails[sourceEnvironment.id] = nil
        }
        if sourceEnvironment.id == environment.id {
            latestShell = shell
        }
        rebuildEntityIndexes(environments)
        synchronizeActiveDetail(
            with: shell,
            environment: sourceEnvironment
        )
        let connectionState: FeatureConnection.State
        let connectionDetail: String?
        if sourceEnvironment.id == environment.id, markSourceConnected {
            connectionState = .connected
            connectionDetail = nil
        } else {
            connectionState = latestSnapshot?.connection.state
                ?? environmentConnectionStates[environment.id]
                ?? .disconnected
            connectionDetail = latestSnapshot?.connection.detail
        }
        let snapshot = makeSnapshot(
            environments: environments,
            activeEnvironment: environment,
            connectionState: connectionState,
            connectionDetail: connectionDetail
        )
        publish(snapshot)
    }

    /// The detail stream does not carry shell-only background liveness. Merge
    /// that small state directly so a settled parent turn still reads as live.
    private func synchronizeActiveDetail(
        with shell: OrchestrationShellSnapshot,
        environment: Environment
    ) {
        guard activeThreadEnvironmentID == environment.id,
              let threadID = activeThreadID,
              let wireID = threadWireIDs[threadID],
              let shellThread = shell.threads.first(where: { $0.id == wireID }),
              var detail = latestDetails[threadID] else {
            return
        }

        let backgroundLiveness = shellThread.backgroundLiveness
        let backgroundWorkIsActive = backgroundLiveness == .working
        let capabilities = threadCapabilities(for: environment)
        detail.thread.supportsSettlement = capabilities?.threadSettlement
        detail.thread.supportsAutoSettleOptOut = capabilities?.threadAutoSettleOptOut
        detail.thread.supportsSnooze = capabilities?.threadSnooze
        detail.thread.supportsPinning = capabilities?.threadPinning
        detail.thread.supportsTitleRegeneration = capabilities?.threadTitleRegeneration
        detail.thread.supportsPullRequestLinking = capabilities?.threadPullRequestLinking
        detail.thread.supportsMultiplePullRequests = capabilities?.threadPullRequests
        let sessionIsLive = shellThread.session?.status == "starting"
            || shellThread.session?.status == "running"
        detail.thread.state = Self.resolveThreadState(
            latestTurn: shellThread.latestTurn,
            session: shellThread.session,
            hasApprovals: !detail.approvals.isEmpty,
            hasUserInput: !detail.userInputs.isEmpty,
            backgroundLiveness: backgroundLiveness
        )
        detail.thread.workingStartedAt = workingStartedAt(
            latestTurn: shellThread.latestTurn,
            session: shellThread.session,
            backgroundWorkIsActive: backgroundWorkIsActive,
            fallbackUpdatedAt: shellThread.updatedAt
        )
        if shell.snapshotSequence >= (activeThreadSequence ?? .min) {
            applyShellMetadataAuthority(from: shellThread, to: &detail.thread)
            if let compaction = detailRenderCaches[threadID]?.compaction {
                detail.isCompacting = compaction.isActive(
                    sessionStatus: shellThread.session?.status,
                    latestTurnState: shellThread.latestTurn?.state,
                    latestTurnRequestedAt: (shellThread.latestTurn?.requestedAt).flatMap(parseValidDate)
                )
            }
        }
        detail.backgroundWorkIsActive = backgroundWorkIsActive
        detail.activeSubagentCount = backgroundWorkIsActive || sessionIsLive
            ? detailRenderCaches[threadID]?.subagents.activeCount ?? 0
            : 0
        guard latestDetails[threadID] != detail else { return }
        publish(detail, threadID: threadID, renderCacheIsSource: true)
    }

    /// Thread-only shell changes stay granular so Home does not replace and
    /// diff the aggregate snapshot for every active turn update. Structural
    /// changes retain the canonical snapshot event as a safe fallback.
    private func publish(_ snapshot: FeatureSnapshot) {
        guard let previous = latestSnapshot else {
            latestSnapshot = snapshot
            continuation.yield(.snapshot(snapshot))
            return
        }
        guard previous != snapshot else { return }
        latestSnapshot = snapshot

        guard canPublishThreadDelta(from: previous, to: snapshot) else {
            continuation.yield(.snapshot(snapshot))
            return
        }

        let previousByID = previous.threads.reduce(into: [String: FeatureThread]()) {
            $0[$1.id] = $1
        }
        let nextByID = snapshot.threads.reduce(into: [String: FeatureThread]()) {
            $0[$1.id] = $1
        }
        let removedIDs = previous.threads.compactMap { thread in
            nextByID[thread.id] == nil ? thread.id : nil
        }
        let changedThreads = snapshot.threads.filter { previousByID[$0.id] != $0 }

        guard !removedIDs.isEmpty || !changedThreads.isEmpty else {
            // A count-only project correction has no corresponding thread
            // event that could reproduce it in the feature model.
            continuation.yield(.snapshot(snapshot))
            return
        }
        for id in removedIDs {
            continuation.yield(.threadRemoved(id: id))
        }
        for thread in changedThreads {
            continuation.yield(.thread(thread))
        }
    }

    private func canPublishThreadDelta(
        from previous: FeatureSnapshot,
        to next: FeatureSnapshot
    ) -> Bool {
        previous.connection == next.connection
            && previous.environments == next.environments
            && previous.providers == next.providers
            && previous.providersByEnvironment == next.providersByEnvironment
            && previous.preferencesByEnvironment == next.preferencesByEnvironment
            && previous.settings == next.settings
            && projectsMatchIgnoringThreadCounts(previous.projects, next.projects)
    }

    private func projectsMatchIgnoringThreadCounts(
        _ lhs: [FeatureProject],
        _ rhs: [FeatureProject]
    ) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).allSatisfy { left, right in
            left.id == right.id
                && left.wireID == right.wireID
                && left.environmentID == right.environmentID
                && left.name == right.name
                && left.path == right.path
                && left.defaultSelection == right.defaultSelection
                && left.repositoryIdentity == right.repositoryIdentity
                && left.projectIcon == right.projectIcon
                && left.createdAt == right.createdAt
                && left.updatedAt == right.updatedAt
        }
    }

    /// Preserve the unchanged transcript prefix when a streaming update only
    /// replaces the tail message. The public event remains authoritative and
    /// backwards compatible for non-native FeatureClient implementations.
    private func publish(
        _ detail: FeatureThreadDetail,
        threadID: String,
        renderCacheIsSource: Bool = false,
        delta: FeatureDetailDelta? = nil
    ) {
        if renderCacheIsSource {
            restoredDetailIDs.remove(threadID)
            // Reducer-provided mutations already updated the authoritative
            // cache. Avoid a prefix comparison across the entire transcript.
            latestDetails[threadID] = detail
            if let delta {
                continuation.yield(.detailDelta(detail, delta))
            } else {
                continuation.yield(.detail(detail))
            }
            return
        }
        if restoredDetailIDs.remove(threadID) != nil { latestDetails[threadID] = nil }
        let next = latestDetails[threadID].map { current in
            current.mergingChangedSuffix(from: detail)
        } ?? detail
        guard latestDetails[threadID] != next else { return }
        latestDetails[threadID] = next
        if let cache = detailRenderCaches[threadID] {
            cache.approvals = next.approvals
            cache.userInputs = next.userInputs
        }
        continuation.yield(.detail(next))
    }

    private func makeDetailDelta(
        previous: FeatureThreadDetail?,
        next: FeatureThreadDetail,
        mutations: NativeDetailRenderMutations
    ) -> FeatureDetailDelta? {
        guard !mutations.requiresFullRebuild,
              let previous,
              next.messages.count >= previous.messages.count else {
            return nil
        }

        if let cache = detailRenderCaches[next.thread.id], cache.v2Timeline.hasTimeline {
            guard !cache.v2Timeline.rebuilt else { return nil }
            let changedIDs = cache.v2Timeline.changedMessageIDs
            let changedMessages = changedIDs.compactMap { id in
                cache.v2Timeline.messageIndexByID[id].map { cache.mergedMessages[$0] }
            }
            return FeatureDetailDelta(changedMessages: changedMessages, appendedMessageIDs: [])
        }

        var changedIDs = Set(mutations.messages.map(\.id))
        for activity in mutations.activities {
            if activity.kind == "user-input.answer-submitted" {
                changedIDs.formUnion(NativeQuestionAnswerHistory.messages(
                    activity, createdAt: parseDate(activity.createdAt)
                ).map(\.id))
            }
            if NativeActivityNotice.accepts(activity) {
                changedIDs.insert("activity-\(activity.id)")
            }
            if NativeWorkLogAccumulator.accepts(activity) {
                changedIDs.insert("work-log-\(activity.turnId ?? "unscoped")")
            }
        }

        guard let cache = detailRenderCaches[next.thread.id] else { return nil }
        let changedMessages = changedIDs.compactMap { id in
            cache.mergedIndexByID[id].map { cache.mergedMessages[$0] }
        }
        let appendedCount = next.messages.count - previous.messages.count
        let appendedMessageIDs = appendedCount == 0
            ? []
            : next.messages.suffix(appendedCount).map(\.id)

        // A newly rendered entity with an older timestamp can be inserted into
        // history. That rare path takes one authoritative diff instead of
        // applying an invalid append-only delta.
        guard appendedMessageIDs.allSatisfy(changedIDs.contains) else { return nil }
        return FeatureDetailDelta(
            changedMessages: changedMessages,
            appendedMessageIDs: appendedMessageIDs
        )
    }

    private func disconnectedSnapshot(
        environments: [Environment],
        detail: String? = nil
    ) -> FeatureSnapshot {
        FeatureSnapshot(
            connection: .init(state: .disconnected, detail: detail),
            environments: environments.map { mapEnvironment($0, activeID: nil) },
            settings: loadSettings()
        )
    }

    private func emitConnection(
        _ state: FeatureConnection.State,
        detail: String? = nil
    ) {
        guard let environment = activeEnvironment else { return }
        // Shell event loops call this per event; only publish real transitions.
        guard environmentConnectionStates[environment.id] != state
            || environmentConnectionDetails[environment.id] != detail else { return }
        environmentConnectionStates[environment.id] = state
        if state == .disconnected || state == .needsPairing { environmentPermissions[environment.id] = nil }
        environmentConnectionDetails[environment.id] = detail
        let connection = FeatureConnection(
            state: state,
            environmentName: environment.label,
            endpoint: environment.httpBaseURL.absoluteString,
            detail: detail
        )
        if latestSnapshot != nil {
            latestSnapshot?.connection = connection
            if let index = latestSnapshot?.environments.firstIndex(where: { $0.id == environment.id }) {
                latestSnapshot?.environments[index].connectionState = state
                latestSnapshot?.environments[index].connectionDetail = detail
            }
        }
        // A reconnect blip used to republish the whole snapshot twice; the
        // model patches the connection and environment row from this event.
        continuation.yield(.connection(connection, environmentID: environment.id))
    }

    private func makeSnapshot(
        environments: [Environment],
        activeEnvironment: Environment,
        connectionState: FeatureConnection.State,
        connectionDetail: String? = nil
    ) -> FeatureSnapshot {
        var activeEnvironment = activeEnvironment
        activeEnvironment.label = environments.first(where: { $0.id == activeEnvironment.id })?.label ?? activeEnvironment.label
        let enabledEnvironments = environments.filter(\.isEnabled)
        let enabledIDs = Set(enabledEnvironments.map(\.id))
        shellProjectionCache = shellProjectionCache.filter { enabledIDs.contains($0.key) }
        var threads: [FeatureThread] = []
        var projects: [FeatureProject] = []
        for environment in enabledEnvironments {
            // Take ownership while updating so the cache does not copy its
            // retained arrays when one row changes.
            var projection = shellProjectionCache.removeValue(forKey: environment.id)
                ?? NativeShellProjection()
            let providerNames = (serverConfigsByEnvironmentID[environment.id]?.providers ?? [])
                .reduce(into: [String: String]()) { names, provider in
                    // Match threadProviderName's first matching instance.
                    if names[provider.instanceId] == nil {
                        names[provider.instanceId] = provider.displayName
                            ?? UsageLimitsPresentation.providerLabel(driver: provider.driver)
                    }
                }
            let live = projection.mapThreads(
                shellsByEnvironmentID[environment.id]?.threads ?? [],
                environment: environment,
                providerNames: providerNames
            ) { mapThread($0, environment: environment) }
            let liveIDs = Set(live.map(\.id))
            let cached = (archivedThreadsByEnvironmentID[environment.id] ?? []).filter {
                !liveIDs.contains($0.id)
            }
            threads.append(contentsOf: live)
            threads.append(contentsOf: cached)
            var threadCountByProjectID: [String: Int] = [:]
            for thread in live { threadCountByProjectID[thread.projectID, default: 0] += 1 }
            for thread in cached { threadCountByProjectID[thread.projectID, default: 0] += 1 }
            let projectConfig = serverConfigsByEnvironmentID[environment.id]
            let projectSettings = projectConfig?.settings ?? ServerSettingsSnapshot()
            let disabledProviderIDs = Set((projectConfig?.providers ?? []).filter { !providerCanRun($0) }.map(\.instanceId))
            let supportsProjectSettings = projectConfig?.environment?.capabilities.projectSettingsOverrides == true
            let mappedProjects = projection.mapProjects(
                shellsByEnvironmentID[environment.id]?.projects ?? [],
                settings: projectSettings,
                disabledProviderIDs: disabledProviderIDs,
                supportsProjectSettings: supportsProjectSettings
            ) { project in
                let effective = projectSettings.resolvingProject(
                    id: project.id, legacyModelSelection: project.defaultModelSelection,
                    legacyWorkspaceMode: project.defaultThreadEnvMode,
                    disabledProviderIDs: disabledProviderIDs
                )
                let uiID = FeatureScopedID.project(
                    environmentID: environment.id,
                    wireID: project.id
                )
                var mapped = FeatureProject(
                    id: uiID,
                    wireID: project.id,
                    environmentID: environment.id,
                    name: project.title,
                    path: project.workspaceRoot,
                    threadCount: 0,
                    defaultSelection: effective.defaultModelSelection.map(mapSelection),
                    repositoryIdentity: project.repositoryIdentity.map {
                        FeatureRepositoryIdentity(
                            canonicalKey: $0.canonicalKey,
                            rootPath: $0.rootPath,
                            displayName: $0.displayName,
                            name: $0.name,
                            origin: $0.origin
                        )
                    },
                    createdAt: project.createdAt,
                    updatedAt: project.updatedAt
                )
                mapped.projectIcon = project.projectIcon
                mapped.defaultWorkspaceMode = effective.defaultThreadEnvMode == .worktree ? .worktree : .local
                mapped.defaultRuntimeMode = switch effective.defaultRuntimeMode {
                case .approvalRequired: .approvalRequired
                case .autoAcceptEdits: .autoAcceptEdits
                case .auto: .automatic
                case .fullAccess: .fullAccess
                }
                mapped.newWorktreesStartFromOrigin = effective.newWorktreesStartFromOrigin
                mapped.supportsProjectSettingsOverrides = supportsProjectSettings
                return mapped
            }
            // These are server paths. `isDirectory` skips a useless local file system check.
            let scratchRoot = projectConfig?.scratchWorkspaceRoot.map {
                URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL.path
            }
            for var project in mappedProjects {
                project.isScratch = scratchRoot.map {
                    $0 == URL(fileURLWithPath: project.path, isDirectory: true).standardizedFileURL.path
                } ?? false
                if project.isScratch == true { project.defaultWorkspaceMode = .local }
                project.threadCount = threadCountByProjectID[project.id, default: 0]
                projects.append(project)
            }
            shellProjectionCache[environment.id] = projection
        }
        let providersByEnvironment = enabledEnvironments.reduce(
            into: [String: [FeatureProvider]]()
        ) { catalogues, environment in
            guard let shell = shellsByEnvironmentID[environment.id] else { return }
            catalogues[environment.id] = mapProviders(
                environmentID: environment.id,
                shell: shell,
                config: serverConfigsByEnvironmentID[environment.id]
            )
        }
        let preferencesByEnvironment = enabledEnvironments.reduce(
            into: [String: FeatureEnvironmentPreferences]()
        ) { preferences, environment in
            guard let config = serverConfigsByEnvironmentID[environment.id],
                  let serverSettings = config.settings else {
                return
            }
            let defaultRuntimeMode: FeatureRuntimeMode = switch serverSettings.defaultRuntimeMode {
            case .approvalRequired: .approvalRequired
            case .autoAcceptEdits: .autoAcceptEdits
            case .auto: .automatic
            case .fullAccess: .fullAccess
            }
            let defaultWorkspaceMode: FeatureWorkspaceMode =
                switch serverSettings.defaultThreadEnvMode {
                case .local, nil: .local
                case .worktree: .worktree
                }
            let groupingMode: FeatureEnvironmentPreferences.ProjectGroupingMode =
                switch serverSettings.sidebarProjectGroupingMode {
                case .repositoryPath: .repositoryPath
                case .separate: .separate
                case .repository, nil: .repository
                }
            let groupingOverrides = serverSettings.sidebarProjectGroupingOverrides?
                .mapValues { mode -> FeatureEnvironmentPreferences.ProjectGroupingMode in
                    switch mode {
                    case .repository: return .repository
                    case .repositoryPath: return .repositoryPath
                    case .separate: return .separate
                    }
                } ?? [:]
            let capabilities = config.environment?.capabilities
                ?? environment.descriptor?.capabilities
            let supportsAutomaticSettlement = capabilities?.threadAutoSettlement == true
            let supportsImageUploads = capabilities?.attachmentUploads == true
            let maxFileAttachmentBytes = supportsImageUploads
                ? capabilities?.fileAttachments.map {
                    min(ManagedAttachmentFileStore.maximumBytes, max(0, $0.maxUploadBytes))
                }
                : nil
            preferences[environment.id] = FeatureEnvironmentPreferences(
                defaultWorkspaceMode: defaultWorkspaceMode,
                newWorktreesStartFromOrigin: serverSettings.newWorktreesStartFromOrigin,
                projectGroupingMode: groupingMode,
                projectGroupingOverrides: groupingOverrides,
                automaticSettlement: supportsAutomaticSettlement
                    ? FeatureAutomaticSettlementSettings(
                        onMerge: serverSettings.sidebarAutoSettleOnMerge,
                        afterDays: serverSettings.sidebarAutoSettleAfterDays
                    )
                    : nil,
                supportsImageUploads: supportsImageUploads,
                maxFileAttachmentBytes: maxFileAttachmentBytes,
                continueThreadsAfterServerUpdate: capabilities?.threadRestartContinuation == true
                    ? serverSettings.continueThreadsAfterServerUpdate
                    : nil,
                defaultRuntimeMode: defaultRuntimeMode
            )
        }
        return FeatureSnapshot(
            connection: FeatureConnection(
                state: connectionState,
                environmentName: activeEnvironment.label,
                endpoint: activeEnvironment.httpBaseURL.absoluteString,
                detail: connectionDetail
            ),
            environments: environments.map {
                mapEnvironment($0, activeID: activeEnvironment.id)
            },
            projects: projects,
            threads: threads,
            providers: providersByEnvironment[activeEnvironment.id] ?? [],
            providersByEnvironment: providersByEnvironment,
            preferencesByEnvironment: preferencesByEnvironment,
            settings: loadSettings()
        )
    }

    private func mapEnvironment(_ environment: Environment, activeID: String?) -> FeatureEnvironment {
        var mapped = FeatureEnvironment(
            id: environment.id,
            name: environment.label,
            endpoint: environment.httpBaseURL.absoluteString,
            isActive: environment.id == activeID,
            isEnabled: environment.isEnabled,
            source: environment.kind == .managedDPoP ? .t3Connect : .direct,
            connectionState: environment.isEnabled
                ? environmentConnectionStates[environment.id]
                : .disconnected,
            connectionDetail: environment.isEnabled
                ? environmentConnectionDetails[environment.id]
                : nil
        )
        mapped.permissions = environment.isEnabled && environmentConnectionStates[environment.id] == .connected
            ? environmentPermissions[environment.id] : nil
        mapped.supportsWorktreesDirectory = threadCapabilities(for: environment)?.worktreesDirectory
        mapped.supportsServerBrowser = threadCapabilities(for: environment)?.serverBrowser
        mapped.machineIcon = serverConfigsByEnvironmentID[environment.id]?.settings?.environmentIcon
            ?? environment.descriptor?.platform.machine
        mapped.newProjectsRoot = serverConfigsByEnvironmentID[environment.id]?.newProjectsRoot
        mapped.supportsScratch = serverConfigsByEnvironmentID[environment.id]?.scratchWorkspaceRoot != nil
        mapped.canCustomizeIcon = serverConfigsByEnvironmentID[environment.id]?.environment?.capabilities.environmentIcon
            ?? environment.descriptor?.capabilities.environmentIcon
        return mapped
    }

    /// The live server config is the source of truth for capabilities, the
    /// same way the web sidebar reads them. The pair-time descriptor only
    /// covers the window before the first config subscription lands, so a
    /// server upgrade takes effect without re-pairing.
    private func threadCapabilities(for environment: Environment) -> EnvironmentDescriptor.Capabilities? {
        serverConfigsByEnvironmentID[environment.id]?.environment?.capabilities
            ?? environment.descriptor?.capabilities
    }

    private func mapThread(
        _ thread: OrchestrationThreadShell,
        environment: Environment
    ) -> FeatureThread {
        let backgroundLiveness = thread.backgroundLiveness
        let backgroundWorkIsActive = backgroundLiveness == .working
        let capabilities = threadCapabilities(for: environment)
        return FeatureThread(
            id: FeatureScopedID.thread(environmentID: environment.id, wireID: thread.id),
            wireID: thread.id,
            relationshipToParent: thread.relationshipToParent,
            projectID: FeatureScopedID.project(
                environmentID: environment.id,
                wireID: thread.projectId
            ),
            environmentID: environment.id,
            environmentName: environment.label,
            title: thread.title,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            linkedPullRequest: thread.linkedPullRequest,
            pullRequests: thread.pullRequests,
            branchPullRequest: thread.branchPullRequest,
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            rawUpdatedAt: thread.v2Lifecycle?.runtimeUpdatedAt,
            state: Self.resolveThreadState(
                latestTurn: thread.latestTurn,
                session: thread.session,
                hasApprovals: thread.hasPendingApprovals,
                hasUserInput: thread.hasPendingUserInput,
                backgroundLiveness: backgroundLiveness,
                v2Lifecycle: thread.v2Lifecycle
            ),
            providerID: thread.modelSelection.instanceId,
            sessionProviderID: thread.session?.providerInstanceId,
            providerName: threadProviderName(
                session: thread.session,
                modelSelection: thread.modelSelection,
                environmentID: environment.id
            ),
            modelID: thread.modelSelection.model,
            modelOptions: mapOptionSelections(thread.modelSelection.options),
            isArchived: thread.archivedAt != nil,
            isSettled: isSettled(thread.settledOverride, settledAt: thread.settledAt),
            keepsActive: thread.settledOverride == "active",
            settledAt: thread.settledAt.flatMap(parseValidDate),
            unsettledAt: thread.unsettledAt.flatMap(parseValidDate),
            activeOrderKey: thread.activeOrderKey,
            autoSettleDisabledAt: thread.autoSettleDisabledAt,
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.latestUserMessageAt,
                latestTurn: thread.latestTurn
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            pinnedAt: thread.pinnedAt.map(parseDate),
            pinOrderKey: thread.pinOrderKey,
            supportsSettlement: capabilities?.threadSettlement,
            supportsAutoSettleOptOut: capabilities?.threadAutoSettleOptOut,
            supportsSnooze: capabilities?.threadSnooze,
            supportsPinning: capabilities?.threadPinning,
            supportsPinReorder: capabilities?.threadPinReorder,
            supportsActiveReorder: capabilities?.threadActiveReorder,
            supportsTitleRegeneration: capabilities?.threadTitleRegeneration,
            supportsPullRequestLinking: capabilities?.threadPullRequestLinking,
            supportsMultiplePullRequests: capabilities?.threadPullRequests,
            isRegeneratingTitle: thread.titleRegeneration != nil,
            attentionAt: failureDate(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            workingStartedAt: workingStartedAt(
                latestTurn: thread.latestTurn,
                session: thread.session,
                backgroundWorkIsActive: backgroundWorkIsActive,
                fallbackUpdatedAt: thread.updatedAt
            ),
            latestTurnCompletedAt: thread.v2Lifecycle.map { $0.latestRunCompletedAt.flatMap(parseValidDate) }
                ?? thread.latestTurn?.completedAt.flatMap(parseValidDate),
            settlementFacts: settlementFacts(
                override: thread.settledOverride,
                session: thread.session,
                hasApprovals: thread.hasPendingApprovals,
                hasUserInput: thread.hasPendingUserInput,
                latestUserMessageAt: thread.latestUserMessageAt,
                latestTurn: thread.latestTurn
            ),
            inboxFacts: inboxFacts(for: thread),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode),
            goal: thread.v2Lifecycle?.goal
        )
    }

    private func mapThread(
        _ thread: OrchestrationThread,
        environment: Environment
    ) -> FeatureThread {
        mapThread(
            thread,
            environment: environment,
            shell: shellsByEnvironmentID[environment.id]?.threads.first { $0.id == thread.id },
            controlLifecycle: thread.orchestrationV2Control.flatMap {
                try? $0["lifecycle"]?.decode(OrchestrationV2ThreadLifecycle.self)
            }
        )
    }

    /// mapDetail passes its own shell lookup and lifecycle decode so each detail
    /// flush does them once.
    private func mapThread(
        _ thread: OrchestrationThread,
        environment: Environment,
        shell: OrchestrationThreadShell?,
        controlLifecycle: OrchestrationV2ThreadLifecycle?
    ) -> FeatureThread {
        let backgroundLiveness = backgroundLiveness(
            threadID: thread.id,
            environmentID: environment.id,
            shellThread: shell
        )
        let backgroundWorkIsActive = backgroundLiveness == .working
        let capabilities = threadCapabilities(for: environment)
        // mapDetail applies shell authority only after comparing snapshot sequences.
        let lifecycle = controlLifecycle ?? shell?.v2Lifecycle
        return FeatureThread(
            id: FeatureScopedID.thread(environmentID: environment.id, wireID: thread.id),
            wireID: thread.id,
            relationshipToParent: thread.relationshipToParent,
            projectID: FeatureScopedID.project(
                environmentID: environment.id,
                wireID: thread.projectId
            ),
            environmentID: environment.id,
            environmentName: environment.label,
            title: thread.title,
            preview: Self.previewText(thread.messages.last?.text),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            linkedPullRequest: thread.linkedPullRequest,
            pullRequests: thread.pullRequests,
            branchPullRequest: thread.branchPullRequest,
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(lifecycle?.runtimeUpdatedAt ?? thread.updatedAt),
            rawUpdatedAt: lifecycle?.runtimeUpdatedAt,
            state: Self.resolveThreadState(
                latestTurn: thread.latestTurn,
                session: thread.session,
                hasApprovals: lifecycle?.hasPendingApprovals ?? false,
                hasUserInput: lifecycle?.hasPendingUserInput ?? false,
                backgroundLiveness: backgroundLiveness,
                v2Lifecycle: lifecycle
            ),
            providerID: thread.modelSelection.instanceId,
            sessionProviderID: thread.session?.providerInstanceId,
            providerName: threadProviderName(
                session: thread.session,
                modelSelection: thread.modelSelection,
                environmentID: environment.id
            ),
            modelID: thread.modelSelection.model,
            modelOptions: mapOptionSelections(thread.modelSelection.options),
            isArchived: thread.archivedAt != nil,
            isSettled: isSettled(thread.settledOverride, settledAt: thread.settledAt),
            keepsActive: thread.settledOverride == "active",
            settledAt: thread.settledAt.flatMap(parseValidDate),
            unsettledAt: thread.unsettledAt.flatMap(parseValidDate),
            activeOrderKey: thread.activeOrderKey,
            autoSettleDisabledAt: thread.autoSettleDisabledAt,
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.messages.last(where: { $0.role == "user" })?.createdAt,
                latestTurn: thread.latestTurn
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            pinnedAt: thread.pinnedAt.map(parseDate),
            pinOrderKey: thread.pinOrderKey,
            supportsSettlement: capabilities?.threadSettlement,
            supportsAutoSettleOptOut: capabilities?.threadAutoSettleOptOut,
            supportsSnooze: capabilities?.threadSnooze,
            supportsPinning: capabilities?.threadPinning,
            supportsPinReorder: capabilities?.threadPinReorder,
            supportsActiveReorder: capabilities?.threadActiveReorder,
            supportsTitleRegeneration: capabilities?.threadTitleRegeneration,
            supportsPullRequestLinking: capabilities?.threadPullRequestLinking,
            supportsMultiplePullRequests: capabilities?.threadPullRequests,
            isRegeneratingTitle: thread.titleRegeneration != nil,
            attentionAt: failureDate(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            workingStartedAt: workingStartedAt(
                latestTurn: thread.latestTurn,
                session: thread.session,
                backgroundWorkIsActive: backgroundWorkIsActive,
                fallbackUpdatedAt: thread.updatedAt
            ),
            latestTurnCompletedAt: lifecycle.map { $0.latestRunCompletedAt.flatMap(parseValidDate) }
                ?? thread.latestTurn?.completedAt.flatMap(parseValidDate),
            settlementFacts: settlementFacts(
                override: thread.settledOverride,
                session: thread.session,
                hasApprovals: lifecycle?.hasPendingApprovals ?? false,
                hasUserInput: lifecycle?.hasPendingUserInput ?? false,
                latestUserMessageAt: lifecycle == nil
                    ? thread.messages.last(where: { $0.role == "user" })?.createdAt
                    : lifecycle?.latestUserMessageAt,
                latestTurn: thread.latestTurn
            ),
            inboxFacts: lifecycle.map { inboxFacts(lifecycle: $0) } ?? inboxFacts(
                latestTurn: thread.latestTurn, session: thread.session,
                backgroundLiveness: backgroundLiveness,
                hasPlan: shell?.hasActionableProposedPlan ?? false,
                authoredAt: shell?.latestUserAuthoredMessageAt,
                authoredFieldIsPresent: shell?.latestUserAuthoredMessageAtIsPresent == true
            ),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode),
            goal: lifecycle?.goal
        )
    }

    private func mapDetail(
        _ thread: OrchestrationThread,
        environment: Environment,
        sourceSequence: Int,
        mutations: NativeDetailRenderMutations? = nil,
        page: FeatureThreadPage? = nil
    ) -> FeatureThreadDetail {
        let threadID = FeatureScopedID.thread(
            environmentID: environment.id,
            wireID: thread.id
        )
        let cache = detailRenderCaches[threadID] ?? NativeDetailRenderCache()
        detailRenderCaches[threadID] = cache
        markThreadCacheRecentlyUsed(threadID)

        if thread.v2Timeline != nil {
            let full = !cache.isInitialized || mutations == nil || mutations?.requiresFullRebuild == true
            if full {
                cache.compaction = NativeContextCompactionState()
                resetPendingRequests(thread, environment: environment, cache: cache)
                cache.subagents.reset(with: thread.activities)
            }
            for message in full ? thread.messages : (mutations?.messages ?? []) {
                cache.compaction.apply(message, createdAt: parseDate(message.createdAt))
            }
            for activity in full ? thread.activities : (mutations?.activities ?? []) {
                cache.compaction.apply(activity)
                cache.subagents.apply(activity)
                if !full {
                    applyApprovalActivity(activity, threadID: threadID, environment: environment, cache: cache)
                    applyUserInputActivity(activity, threadID: threadID, environment: environment, cache: cache)
                }
            }
            cache.mergedMessages = cache.v2Timeline.update(
                thread: thread,
                changedMessages: full ? nil : mutations?.messages,
                changedActivities: full ? nil : mutations?.activities,
                mapMessage: { self.mapMessage($0, environmentID: environment.id) },
                date: { self.parseDate($0) }
            )
            cache.mergedIndexByID = cache.v2Timeline.messageIndexByID
            cache.isInitialized = true
        } else if !cache.isInitialized || mutations == nil || mutations?.requiresFullRebuild == true {
            cache.compaction = NativeContextCompactionState()
            cache.messagesByID = thread.messages.reduce(into: [:]) { result, raw in
                result[raw.id] = mapMessage(raw, environmentID: environment.id)
                cache.compaction.apply(raw, createdAt: parseDate(raw.createdAt))
            }
            resetPendingRequests(thread, environment: environment, cache: cache)
            let notices = thread.activities.compactMap { activity in
                cache.compaction.apply(activity)
                return NativeActivityNotice.message(activity, createdAt: parseDate(activity.createdAt))
            }
            let sessionIsLive = thread.session?.status == "starting"
                || thread.session?.status == "running"
            let answers = thread.activities.flatMap {
                NativeQuestionAnswerHistory.messages($0, createdAt: parseDate($0.createdAt))
            }
            let activityMessages = (notices + answers + collapsedWorkLogs(
                thread.activities,
                sessionIsLive: sessionIsLive
            ))
                .sorted { $0.createdAt < $1.createdAt }
            seedWorkLogs(thread.activities, sessionIsLive: sessionIsLive, cache: cache)
            cache.subagents.reset(with: thread.activities)
            let messages = thread.messages.compactMap { cache.messagesByID[$0.id] }
            cache.mergedMessages = (messages + activityMessages)
                .sorted { $0.createdAt < $1.createdAt }
            rebuildMergedIndexes(cache)
            cache.isInitialized = true
        } else if let mutations {
            for message in mutations.messages {
                let mapped = mapMessage(message, environmentID: environment.id)
                cache.messagesByID[message.id] = mapped
                cache.compaction.apply(message, createdAt: mapped.createdAt)
                upsertMergedMessage(mapped, cache: cache)
            }
            for activity in mutations.activities {
                applyActivityMutation(
                    activity,
                    threadID: threadID,
                    environment: environment,
                    cache: cache
                )
            }
        } else {
            assertionFailure("Initialized detail caches require an incremental mutation")
        }

        let shell = shellsByEnvironmentID[environment.id]
        let shellThread = shell?.threads.first { $0.id == thread.id }
        // Thread state uses the control lifecycle only; mapThread adds the shell fallback.
        let controlLifecycle = thread.orchestrationV2Control.flatMap {
            try? $0["lifecycle"]?.decode(OrchestrationV2ThreadLifecycle.self)
        }
        var mappedThread = mapThread(
            thread,
            environment: environment,
            shell: shellThread,
            controlLifecycle: controlLifecycle
        )
        let backgroundLiveness = backgroundLiveness(
            threadID: thread.id,
            environmentID: environment.id,
            shellThread: shellThread
        )
        let backgroundWorkIsActive = backgroundLiveness == .working
        let sessionIsLive = thread.session?.status == "starting"
            || thread.session?.status == "running"
        if !sessionIsLive {
            for (groupID, var accumulator) in cache.workLogsByGroupID
            where accumulator.hasActiveWork {
                accumulator.clearActiveWork()
                cache.workLogsByGroupID[groupID] = accumulator
                upsertMergedMessage(accumulator.message(groupID: groupID), cache: cache)
            }
        }
        mappedThread.state = Self.resolveThreadState(
            latestTurn: thread.latestTurn,
            session: thread.session,
            hasApprovals: !cache.approvals.isEmpty || mappedThread.settlementFacts?.hasPendingApprovals == true,
            hasUserInput: !cache.userInputs.isEmpty || mappedThread.settlementFacts?.hasPendingUserInput == true,
            backgroundLiveness: backgroundLiveness,
            v2Lifecycle: controlLifecycle
        )
        if var facts = mappedThread.settlementFacts {
            facts.hasPendingApprovals = !cache.approvals.isEmpty || facts.hasPendingApprovals
            facts.hasPendingUserInput = !cache.userInputs.isEmpty || facts.hasPendingUserInput
            mappedThread.settlementFacts = facts
        }
        if let shell, let shellThread, shell.snapshotSequence >= sourceSequence {
            applyShellMetadataAuthority(from: shellThread, to: &mappedThread)
        }
        return FeatureThreadDetail(
            thread: mappedThread,
            messages: cache.mergedMessages,
            approvals: cache.approvals,
            userInputs: cache.userInputs,
            page: page,
            activeSubagentCount: backgroundWorkIsActive || sessionIsLive
                ? cache.subagents.activeCount
                : 0,
            backgroundWorkIsActive: backgroundWorkIsActive,
            isCompacting: cache.compaction.isActive(
                sessionStatus: thread.session?.status,
                latestTurnState: thread.latestTurn?.state,
                latestTurnRequestedAt: (thread.latestTurn?.requestedAt).flatMap(parseValidDate)
            ),
            execution: thread.orchestrationV2Control.flatMap { try? FeatureThreadExecution(projection: $0) },
            workflows: thread.orchestrationV2Control.flatMap { try? FeatureThreadWorkflows(projection: $0, environmentID: environment.id) },
            allowsProviderSwitch: FeatureProviderHandoffPolicy.allowsProviderSwitch(projection: thread.orchestrationV2Control),
            recovery: FeatureThreadRecovery(thread: thread)
        )
    }

    private func backgroundLiveness(
        threadID: String,
        environmentID: String
    ) -> OrchestrationBackgroundLiveness? {
        backgroundLiveness(
            threadID: threadID,
            environmentID: environmentID,
            shellThread: shellsByEnvironmentID[environmentID]?.threads.first { $0.id == threadID }
        )
    }

    /// Use when the caller already looked up the live shell thread.
    private func backgroundLiveness(
        threadID: String,
        environmentID: String,
        shellThread: OrchestrationThreadShell?
    ) -> OrchestrationBackgroundLiveness? {
        shellThread?.backgroundLiveness
            ?? archivedShellThreadsByEnvironmentID[environmentID]?[threadID]?.backgroundLiveness
    }

    private func markThreadCacheRecentlyUsed(_ threadID: String) {
        detailCacheRecency.removeAll { $0 == threadID }
        detailCacheRecency.append(threadID)
    }

    private func evictOldThreadCachesIfNeeded() {
        while detailCacheRecency.count > Self.maximumRetainedThreadDetails {
            let threadID = detailCacheRecency.removeFirst()
            guard threadID != activeThreadID else {
                detailCacheRecency.append(threadID)
                break
            }
            latestDetails[threadID] = nil
            threadResumeStates[threadID] = nil
            detailRenderCaches[threadID] = nil
            terminalSnapshots = terminalSnapshots.filter { $0.key.threadID != threadID }
        }
    }

    private func featurePage(
        _ page: OrchestrationThreadDetailPage?,
        isLoading: Bool = false
    ) -> FeatureThreadPage? {
        page.map {
            FeatureThreadPage(
                beforeCursor: $0.beforeCursor,
                hasMore: $0.hasMore,
                isLoading: isLoading
            )
        }
    }

    private func publishActivePageState(threadID: String) {
        guard var detail = latestDetails[threadID] else { return }
        detail.page = activeThreadPage
        publish(detail, threadID: threadID, renderCacheIsSource: true)
    }

    private func clearOlderThreadLoading(threadID: String) {
        pendingOlderThreadPage = nil
        activeThreadPage?.isLoading = false
        publishActivePageState(threadID: threadID)
    }

    private func tryMergePendingOlderThreadPage(route: NativeThreadRoute) {
        guard let pending = pendingOlderThreadPage,
              pending.threadID == route.uiID,
              pending.environmentID == route.environmentID else { return }
        guard pending.epoch == threadHistoryEpoch else {
            clearOlderThreadLoading(threadID: route.uiID)
            return
        }
        if let watermark = pending.snapshot.page?.threadSequence,
           watermark > (activeThreadSequence ?? 0) {
            return
        }
        pendingOlderThreadPage = nil
        _ = mergeOlderThreadPage(pending.snapshot, route: route)
    }

    @discardableResult
    private func mergeOlderThreadPage(
        _ snapshot: OrchestrationThreadDetailSnapshot,
        route: NativeThreadRoute
    ) -> FeatureThreadDetail? {
        guard activeThreadID == route.uiID,
              let loadedThread = activeRawThread,
              let currentDetail = latestDetails[route.uiID] else {
            clearOlderThreadLoading(threadID: route.uiID)
            return latestDetails[route.uiID]
        }

        expandedHistoryIDs.insert(route.uiID)
        let mergedThread = mergingOlderHistory(snapshot.thread, into: loadedThread)
        let olderMessages = renderedHistoryMessages(
            snapshot.thread,
            environmentID: route.environmentID
        )
        let loadedMessageIDs = Set(currentDetail.messages.map(\.id))
        let mergedMessages = (
            olderMessages.filter { !loadedMessageIDs.contains($0.id) }
                + currentDetail.messages
        ).sorted { $0.createdAt < $1.createdAt }

        activeRawThread = mergedThread
        activeThreadPage = featurePage(snapshot.page)

        if let cache = detailRenderCaches[route.uiID] {
            for rawMessage in snapshot.thread.messages where cache.messagesByID[rawMessage.id] == nil {
                cache.messagesByID[rawMessage.id] = mapMessage(
                    rawMessage,
                    environmentID: route.environmentID
                )
            }
            cache.mergedMessages = mergedMessages
            rebuildMergedIndexes(cache)
        }

        let detail = FeatureThreadDetail(
            thread: currentDetail.thread,
            messages: mergedMessages,
            approvals: currentDetail.approvals,
            userInputs: currentDetail.userInputs,
            page: activeThreadPage,
            activeSubagentCount: currentDetail.activeSubagentCount,
            backgroundWorkIsActive: currentDetail.backgroundWorkIsActive,
            isCompacting: currentDetail.isCompacting == true,
            execution: currentDetail.execution,
            workflows: currentDetail.workflows,
            allowsProviderSwitch: currentDetail.allowsProviderSwitch,
            recovery: currentDetail.recovery
        )
        publish(detail, threadID: route.uiID, renderCacheIsSource: true)
        return detail
    }

    private func renderedHistoryMessages(
        _ thread: OrchestrationThread,
        environmentID: String
    ) -> [FeatureMessage] {
        let messages = thread.messages.map {
            mapMessage($0, environmentID: environmentID)
        }
        let workIsLive = thread.session?.status == "starting"
            || thread.session?.status == "running"
            || backgroundLiveness(threadID: thread.id, environmentID: environmentID) == .working
        let activities = thread.activities.compactMap {
            NativeActivityNotice.message($0, createdAt: parseDate($0.createdAt))
        }
            + collapsedWorkLogs(thread.activities, sessionIsLive: workIsLive)
        return (messages + activities).sorted { $0.createdAt < $1.createdAt }
    }

    private func mergingOlderHistory(
        _ older: OrchestrationThread,
        into loaded: OrchestrationThread
    ) -> OrchestrationThread {
        func prependByID<Element: Identifiable>(
            _ olderRows: [Element],
            _ loadedRows: [Element]
        ) -> [Element] where Element.ID: Hashable {
            let loadedIDs = Set(loadedRows.map(\.id))
            return olderRows.filter { !loadedIDs.contains($0.id) } + loadedRows
        }

        let loadedCheckpointTurns = Set(loaded.checkpoints.map(\.turnId))
        return OrchestrationThread(
            relationshipToParent: loaded.relationshipToParent,
            id: loaded.id,
            projectId: loaded.projectId,
            title: loaded.title,
            modelSelection: loaded.modelSelection,
            runtimeMode: loaded.runtimeMode,
            interactionMode: loaded.interactionMode,
            branch: loaded.branch,
            worktreePath: loaded.worktreePath,
            linkedPullRequest: loaded.linkedPullRequest,
            pullRequests: loaded.pullRequests,
            branchPullRequest: loaded.branchPullRequest,
            latestTurn: loaded.latestTurn,
            createdAt: loaded.createdAt,
            updatedAt: loaded.updatedAt,
            archivedAt: loaded.archivedAt,
            settledOverride: loaded.settledOverride,
            settledAt: loaded.settledAt,
            unsettledAt: loaded.unsettledAt,
            activeOrderKey: loaded.activeOrderKey,
            autoSettleDisabledAt: loaded.autoSettleDisabledAt,
            snoozedUntil: loaded.snoozedUntil,
            snoozedAt: loaded.snoozedAt,
            pinnedAt: loaded.pinnedAt,
            pinOrderKey: loaded.pinOrderKey,
            titleRegeneration: loaded.titleRegeneration,
            deletedAt: loaded.deletedAt,
            messages: prependByID(older.messages, loaded.messages),
            activities: prependByID(older.activities, loaded.activities),
            checkpoints: older.checkpoints.filter {
                !loadedCheckpointTurns.contains($0.turnId)
            } + loaded.checkpoints,
            session: loaded.session
        )
    }

    private func rebuildMergedIndexes(_ cache: NativeDetailRenderCache) {
        cache.mergedIndexByID = cache.mergedMessages.enumerated().reduce(into: [:]) {
            $0[$1.element.id] = $1.offset
        }
    }

    /// Known stream events are chronological, so new render entities land at
    /// the tail and existing streaming/work-log entities patch in constant time.
    private func upsertMergedMessage(
        _ message: FeatureMessage,
        cache: NativeDetailRenderCache
    ) {
        if let index = cache.mergedIndexByID[message.id] {
            cache.mergedMessages[index] = message
            return
        }
        if let last = cache.mergedMessages.last, last.createdAt > message.createdAt {
            // Out-of-order events are rare; preserve correctness while keeping
            // the normal append path independent of transcript size.
            cache.mergedMessages.append(message)
            cache.mergedMessages.sort { $0.createdAt < $1.createdAt }
            rebuildMergedIndexes(cache)
            return
        }
        cache.mergedIndexByID[message.id] = cache.mergedMessages.count
        cache.mergedMessages.append(message)
    }

    private func applyActivityMutation(
        _ activity: OrchestrationActivity,
        threadID: String,
        environment: Environment,
        cache: NativeDetailRenderCache
    ) {
        cache.compaction.apply(activity)
        cache.subagents.apply(activity)
        applyApprovalActivity(
            activity,
            threadID: threadID,
            environment: environment,
            cache: cache
        )
        applyUserInputActivity(
            activity,
            threadID: threadID,
            environment: environment,
            cache: cache
        )
        if let notice = NativeActivityNotice.message(activity, createdAt: parseDate(activity.createdAt)) {
            upsertMergedMessage(notice, cache: cache)
        }
        for answer in NativeQuestionAnswerHistory.messages(activity, createdAt: parseDate(activity.createdAt)) {
            upsertMergedMessage(answer, cache: cache)
        }
        guard NativeWorkLogAccumulator.accepts(activity) else { return }
        let isNewActivity = cache.workLogActivityIDs.insert(activity.id).inserted
        // V2 updates the same durable tool record in place.
        guard isNewActivity || activity.kind == "tool.updated" else { return }
        let groupID = activity.turnId ?? "unscoped"
        var accumulator = cache.workLogsByGroupID[groupID] ?? NativeWorkLogAccumulator()
        accumulator.append(
            activity,
            preview: Self.previewText(activity.payload["detail"]?.stringValue),
            createdAt: parseDate(activity.createdAt)
        )
        cache.workLogsByGroupID[groupID] = accumulator
        guard accumulator.hasContent else {
            cache.mergedMessages.removeAll { $0.id == "work-log-\(groupID)" }
            rebuildMergedIndexes(cache)
            return
        }
        let message = accumulator.message(groupID: groupID)
        upsertMergedMessage(message, cache: cache)
    }

    /// Decorate-sort so each timestamp is parsed once (via the memoized date
    /// cache) instead of inside an O(n log n) comparator. Raw string order is
    /// not safe here: the wire can mix fractional and non-fractional ISO8601
    /// representations, which sort lexicographically wrong. Ties keep wire
    /// order so a request and its resolution never swap.
    private func sortedByCreation(
        _ activities: [OrchestrationActivity]
    ) -> [OrchestrationActivity] {
        var decorated: [(index: Int, date: Date, activity: OrchestrationActivity)] = []
        decorated.reserveCapacity(activities.count)
        for (index, activity) in activities.enumerated() {
            decorated.append((index, parseDate(activity.createdAt), activity))
        }
        decorated.sort { lhs, rhs in
            lhs.date != rhs.date ? lhs.date < rhs.date : lhs.index < rhs.index
        }
        return decorated.map(\.activity)
    }

    private func seedWorkLogs(
        _ activities: [OrchestrationActivity],
        sessionIsLive: Bool,
        cache: NativeDetailRenderCache
    ) {
        cache.workLogsByGroupID.removeAll(keepingCapacity: true)
        cache.workLogActivityIDs.removeAll(keepingCapacity: true)
        for activity in sortedByCreation(activities)
        where NativeWorkLogAccumulator.accepts(activity) {
            cache.workLogActivityIDs.insert(activity.id)
            let groupID = activity.turnId ?? "unscoped"
            var accumulator = cache.workLogsByGroupID[groupID] ?? NativeWorkLogAccumulator()
            accumulator.append(
                activity,
                preview: Self.previewText(activity.payload["detail"]?.stringValue),
                createdAt: parseDate(activity.createdAt)
            )
            cache.workLogsByGroupID[groupID] = accumulator
        }
        if !sessionIsLive {
            for groupID in cache.workLogsByGroupID.keys {
                cache.workLogsByGroupID[groupID]?.clearActiveWork()
            }
        }
    }

    private func applyApprovalActivity(
        _ activity: OrchestrationActivity,
        threadID: String,
        environment: Environment,
        cache: NativeDetailRenderCache
    ) {
        guard let requestID = activity.payload["requestId"]?.stringValue else { return }
        let uiRequestID = FeatureScopedID.approval(
            environmentID: environment.id,
            wireID: requestID
        )
        switch activity.kind {
        case "approval.requested":
            guard !cache.closedApprovalRequestIDs.contains(requestID),
                  activity.payload["requestType"]?.stringValue != "tool_user_input",
                  activity.payload["requestType"]?.stringValue != "auth_tokens_refresh" else {
                return
            }
            let kind = Self.approvalKind(activity.payload)
            let appName = activity.payload["appName"]?.stringValue
            let approval = FeatureApproval(
                id: uiRequestID,
                wireID: requestID,
                threadID: threadID,
                kind: kind,
                title: appName ?? activity.summary,
                detail: activity.payload["detail"]?.stringValue ?? activity.summary,
                appName: appName,
                options: Self.approvalOptions(activity.payload),
                responseCapability: activity.payload["responseCapability"]?["type"]?.stringValue
                    ?? activity.payload["responseCapability"]?.stringValue
            )
            cache.approvals.removeAll { $0.id == uiRequestID }
            cache.approvals.append(approval)
            cache.approvals.sort { $0.id < $1.id }
            approvalRoutes[uiRequestID] = PendingRequestRoute(
                threadID: threadID,
                wireID: requestID
            )
        case "approval.resolved":
            cache.closedApprovalRequestIDs.insert(requestID)
            cache.approvals.removeAll { $0.id == uiRequestID }
            approvalRoutes[uiRequestID] = nil
        case "provider.approval.respond.failed":
            guard Self.isTerminalRequestFailure(activity) else { return }
            cache.closedApprovalRequestIDs.insert(requestID)
            cache.approvals.removeAll { $0.id == uiRequestID }
            approvalRoutes[uiRequestID] = nil
        default:
            return
        }
    }

    private func applyUserInputActivity(
        _ activity: OrchestrationActivity,
        threadID: String,
        environment: Environment,
        cache: NativeDetailRenderCache
    ) {
        guard let requestID = activity.payload["requestId"]?.stringValue else { return }
        let uiRequestID = FeatureScopedID.input(
            environmentID: environment.id,
            wireID: requestID
        )
        switch activity.kind {
        case "user-input.requested":
            guard !cache.closedUserInputRequestIDs.contains(requestID),
                  let questions = parseInputQuestions(activity.payload), !questions.isEmpty else {
                return
            }
            var request = FeatureUserInput(
                id: uiRequestID,
                wireID: requestID,
                threadID: threadID,
                questions: questions
            )
            request.dismissible = activity.payload["responseMode"]?.stringValue == "message"
            request.responseCapability = activity.payload["responseCapability"]?["type"]?.stringValue
                ?? activity.payload["responseCapability"]?.stringValue
            request.supportsAttachments = (serverConfigsByEnvironmentID[environment.id]?.environment
                ?? environment.descriptor)?.capabilities.questionAttachments == true
            cache.userInputs.removeAll { $0.id == uiRequestID }
            cache.userInputs.append(request)
            cache.userInputs.sort { $0.id < $1.id }
            inputRoutes[uiRequestID] = PendingRequestRoute(
                threadID: threadID,
                wireID: requestID
            )
        case "user-input.resolved":
            cache.closedUserInputRequestIDs.insert(requestID)
            cache.userInputs.removeAll { $0.id == uiRequestID }
            inputRoutes[uiRequestID] = nil
        case "provider.user-input.respond.failed":
            guard Self.isTerminalRequestFailure(activity) else { return }
            cache.closedUserInputRequestIDs.insert(requestID)
            cache.userInputs.removeAll { $0.id == uiRequestID }
            inputRoutes[uiRequestID] = nil
        default:
            return
        }
    }

    private func mapMessage(
        _ message: OrchestrationMessage,
        environmentID: String
    ) -> FeatureMessage {
        FeatureMessage(
            id: message.id,
            role: mapRole(message.role),
            text: message.text,
            createdAt: parseDate(message.createdAt),
            state: message.streaming ? .streaming : .complete,
            toolName: message.role == "reasoning" ? "Thinking" : nil,
            attachments: (message.attachments ?? []).map {
                FeatureMessageAttachment(
                    id: $0.id,
                    name: $0.name,
                    mimeType: $0.mimeType,
                    sizeBytes: $0.sizeBytes,
                    url: cachedAttachmentURL(for: $0.id, environmentID: environmentID),
                    source: $0.source.flatMap { try? $0.decode(PastedTextAttachmentSource.self) }
                )
            },
            context: message.context
        )
    }

    /// Lifecycle updates can number in the thousands on a long turn. Keep the
    /// primary transcript message-sized while preserving a bounded, expandable
    /// summary for each turn.
    private func collapsedWorkLogs(
        _ activities: [OrchestrationActivity],
        sessionIsLive: Bool
    ) -> [FeatureMessage] {
        let groups = Dictionary(grouping: sortedByCreation(activities).filter {
            NativeWorkLogAccumulator.accepts($0)
        }) { activity in
            activity.turnId ?? "unscoped"
        }
        return groups.compactMap { groupID, group in
            var accumulator = NativeWorkLogAccumulator()
            for activity in group {
                accumulator.append(
                    activity,
                    preview: Self.previewText(activity.payload["detail"]?.stringValue),
                    createdAt: parseDate(activity.createdAt)
                )
            }
            if !sessionIsLive { accumulator.clearActiveWork() }
            return accumulator.hasContent ? accumulator.message(groupID: groupID) : nil
        }
    }

    /// Snapshot replay and live updates share terminal request rules. Request IDs
    /// are unique, so a late requested activity must not reopen a resolved request.
    private func resetPendingRequests(
        _ thread: OrchestrationThread,
        environment: Environment,
        cache: NativeDetailRenderCache
    ) {
        for approval in cache.approvals { approvalRoutes[approval.id] = nil }
        for input in cache.userInputs { inputRoutes[input.id] = nil }
        cache.approvals.removeAll(keepingCapacity: true)
        cache.userInputs.removeAll(keepingCapacity: true)
        cache.closedApprovalRequestIDs.removeAll(keepingCapacity: true)
        cache.closedUserInputRequestIDs.removeAll(keepingCapacity: true)
        let threadID = FeatureScopedID.thread(
            environmentID: environment.id,
            wireID: thread.id
        )
        for activity in sortedByCreation(thread.activities) {
            applyApprovalActivity(activity, threadID: threadID, environment: environment, cache: cache)
            applyUserInputActivity(activity, threadID: threadID, environment: environment, cache: cache)
        }
    }

    private static func isTerminalRequestFailure(_ activity: OrchestrationActivity) -> Bool {
        let fragments: [String]
        switch activity.kind {
        case "provider.approval.respond.failed":
            fragments = [
                "stale pending approval request",
                "unknown pending approval request",
                "unknown pending permission request",
                "unknown pending codex approval request",
            ]
        case "provider.user-input.respond.failed":
            fragments = [
                "stale pending user-input request",
                "unknown pending user-input request",
                "unknown pending user input request",
                "unknown pending codex user input request",
            ]
        default:
            return false
        }
        let detail = activity.payload["detail"]?.stringValue?.lowercased() ?? ""
        return fragments.contains { detail.contains($0) }
    }

    private static func approvalKind(_ payload: JSONValue) -> FeatureApprovalKind {
        switch payload["requestKind"]?.stringValue {
        case "command": return .command
        case "file-read": return .fileRead
        case "file-change": return .fileChange
        case "mcp-elicitation", "permission": return .mcpElicitation
        default: break
        }
        switch payload["requestType"]?.stringValue {
        case "file_read_approval": return .fileRead
        case "file_change_approval", "apply_patch_approval": return .fileChange
        case "mcp_elicitation_approval", "permission_approval": return .mcpElicitation
        default: return .command
        }
    }

    private static func approvalOptions(_ payload: JSONValue) -> [FeatureApprovalOption]? {
        guard case let .array(values)? = payload["options"] else { return nil }
        let options = values.compactMap { value -> FeatureApprovalOption? in
            guard let wireDecision = value["decision"]?.stringValue,
                  let decision = FeatureApprovalDecision(wireValue: wireDecision),
                  let label = value["label"]?.stringValue,
                  !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return nil
            }
            return FeatureApprovalOption(
                decision: decision, label: label, warning: value["warning"]?.stringValue
            )
        }
        return options
    }

    private func parseInputQuestions(_ payload: JSONValue) -> [FeatureInputQuestion]? {
        guard case let .array(rawQuestions)? = payload["questions"] else { return nil }
        return rawQuestions.compactMap { rawQuestion in
            guard case let .object(question) = rawQuestion,
                  let id = question["id"]?.stringValue,
                  let header = question["header"]?.stringValue,
                  let text = question["question"]?.stringValue else {
                return nil
            }
            let options: [FeatureInputOption]
            if case let .array(rawOptions)? = question["options"] {
                options = rawOptions.compactMap { rawOption in
                    guard case let .object(option) = rawOption,
                          let label = option["label"]?.stringValue else {
                        return nil
                    }
                    return FeatureInputOption(
                        label: label,
                        detail: option["description"]?.stringValue ?? "",
                        value: option["value"]?.stringValue
                    )
                }
            } else {
                options = []
            }
            let allowsMultiple: Bool
            if case let .bool(value)? = question["multiSelect"] {
                allowsMultiple = value
            } else {
                allowsMultiple = false
            }
            guard !options.isEmpty || question["allowCustomAnswer"] != .bool(false) else { return nil }
            var mapped = FeatureInputQuestion(
                id: id,
                header: header,
                question: text,
                options: options,
                allowsMultiple: allowsMultiple
            )
            if case let .bool(value)? = question["allowCustomAnswer"] { mapped.allowCustomAnswer = value }
            mapped.initialAnswer = question["initialAnswer"]?.stringValue
            return mapped
        }
    }

    nonisolated static func resolveThreadState(
        latestTurn: OrchestrationLatestTurn?,
        session: OrchestrationSession?,
        hasApprovals: Bool,
        hasUserInput: Bool,
        backgroundLiveness: OrchestrationBackgroundLiveness?,
        v2Lifecycle: OrchestrationV2ThreadLifecycle? = nil
    ) -> FeatureThreadState {
        // Same rules as the web sidebar (resolveSidebarThreadStatus): the
        // session owns working and failed. `latestTurn.state` is not consulted
        // because a session that died mid-turn leaves the turn "running"
        // forever, and a recovered session leaves an old turn "error".
        if hasApprovals { return .waitingForApproval }
        if hasUserInput { return .waitingForInput }
        if let v2Lifecycle {
            switch v2Lifecycle.runtimeStatus {
            case "preparing", "queued", "starting": return .queued
            case "running", "waiting": return .working
            case "failed": return .failed
            case "completed": return .completed
            default: return .idle
            }
        }
        if session?.status == "starting" { return .queued }
        if session?.status == "running" { return .working }
        if session?.status == "error" { return .failed }
        if backgroundLiveness == .working { return .working }
        if backgroundLiveness == .monitoring { return .monitoring }
        if latestTurn?.state == "completed" { return .completed }
        return .idle
    }

    private func mapRole(_ role: String) -> FeatureMessageRole {
        switch role {
        case "user": .user
        case "assistant": .assistant
        case "system": .system
        default: .tool
        }
    }

    private func isSettled(_ override: String?, settledAt: String?) -> Bool {
        if override == "active" { return false }
        return override == "settled" || settledAt != nil
    }

    private func settlementFacts(
        override: String?,
        session: OrchestrationSession?,
        hasApprovals: Bool,
        hasUserInput: Bool,
        latestUserMessageAt: String?,
        latestTurn: OrchestrationLatestTurn?
    ) -> FeatureThreadSettlementFacts {
        return FeatureThreadSettlementFacts(
            settlementOverride: override.flatMap(FeatureThreadSettlementOverride.init(rawValue:)),
            sessionStatus: session?.status,
            hasPendingApprovals: hasApprovals,
            hasPendingUserInput: hasUserInput,
            latestUserMessageAt: latestUserMessageAt.flatMap(parseValidDate),
            latestTurn: latestTurn.map {
                FeatureThreadSettlementFacts.LatestTurn(
                    requestedAt: parseValidDate($0.requestedAt),
                    startedAt: $0.startedAt.flatMap(parseValidDate),
                    completedAt: $0.completedAt.flatMap(parseValidDate),
                    requestedAtIsInvalid: parseValidDate($0.requestedAt) == nil,
                    startedAtIsInvalid: $0.startedAt.map { parseValidDate($0) == nil } ?? false,
                    completedAtIsInvalid: $0.completedAt.map { parseValidDate($0) == nil } ?? false
                )
            }
        )
    }

    private func inboxFacts(for shell: OrchestrationThreadShell) -> FeatureThreadInboxFacts {
        if let facts = shell.v2Lifecycle {
            return inboxFacts(lifecycle: facts)
        }
        return inboxFacts(
            latestTurn: shell.latestTurn, session: shell.session,
            backgroundLiveness: shell.backgroundLiveness,
            hasPlan: shell.hasActionableProposedPlan,
            authoredAt: shell.latestUserAuthoredMessageAt,
            authoredFieldIsPresent: shell.latestUserAuthoredMessageAtIsPresent == true
        )
    }

    private func inboxFacts(lifecycle facts: OrchestrationV2ThreadLifecycle) -> FeatureThreadInboxFacts {
        FeatureThreadInboxFacts(
            runtimeStatus: facts.runtimeStatus,
            activeRunID: facts.activeRunID,
            latestRunID: facts.latestRunID,
            latestRunStatus: facts.latestRunStatus,
            latestRunRequestedAt: facts.latestRunRequestedAt.flatMap(parseValidDate),
            latestRunCompletedAt: facts.latestRunCompletedAt.flatMap(parseValidDate),
            hasActionableProposedPlan: facts.hasActionableProposedPlan,
            latestUserAuthoredMessageAt: facts.latestUserAuthoredMessageAt.flatMap(parseValidDate),
            latestUserAuthoredMessageAtIsPresent: facts.latestUserAuthoredMessageAtIsPresent,
            orchestrationVersion: 2,
            runtimeUpdatedAt: parseValidDate(facts.runtimeUpdatedAt),
            latestRunStartedAt: facts.latestRunStartedAt.flatMap(parseValidDate),
            latestRunHasInvalidTimestamp: [facts.latestRunRequestedAt, facts.latestRunStartedAt, facts.latestRunCompletedAt]
                .compactMap { $0 }.contains { parseValidDate($0) == nil },
            lastErrorClass: facts.lastErrorClass,
            usageLimitResetAt: facts.usageLimitResetAt.flatMap(parseValidDate),
            lastVisitedAt: facts.lastVisitedAt,
            lastVisitedAtIsPresent: facts.lastVisitedAtIsPresent
        )
    }

    private func inboxFacts(
        latestTurn: OrchestrationLatestTurn?, session: OrchestrationSession?,
        backgroundLiveness: OrchestrationBackgroundLiveness?, hasPlan: Bool,
        authoredAt: String?, authoredFieldIsPresent: Bool
    ) -> FeatureThreadInboxFacts {
        // V1's idle session also means a completed turn. Only background work
        // parks the V2 runtime at idle for the Working section.
        let runtimeStatus: String?
        if backgroundLiveness != nil, session?.status != "error" {
            runtimeStatus = "idle"
        } else if ["idle", "ready", "stopped"].contains(session?.status ?? "") {
            runtimeStatus = latestTurn?.state == "completed" ? "completed" : nil
        } else {
            runtimeStatus = session?.status
        }
        return FeatureThreadInboxFacts(
            runtimeStatus: runtimeStatus, activeRunID: session?.activeTurnId,
            latestRunID: latestTurn?.turnId, latestRunStatus: latestTurn?.state,
            latestRunRequestedAt: latestTurn.flatMap { parseValidDate($0.requestedAt) },
            latestRunCompletedAt: latestTurn?.completedAt.flatMap(parseValidDate),
            hasActionableProposedPlan: hasPlan,
            latestUserAuthoredMessageAt: authoredAt.flatMap(parseValidDate),
            latestUserAuthoredMessageAtIsPresent: authoredFieldIsPresent,
            runtimeUpdatedAt: session.flatMap { parseValidDate($0.updatedAt) },
            latestRunStartedAt: latestTurn?.startedAt.flatMap(parseValidDate)
        )
    }

    private func applyShellMetadataAuthority(
        from shell: OrchestrationThreadShell,
        to thread: inout FeatureThread
    ) {
        // The shell is the freshest source for the title. A cached detail can
        // still carry the pre-regeneration title after the server renamed it.
        thread.inboxFacts = inboxFacts(for: shell)
        if let lifecycle = shell.v2Lifecycle {
            thread.state = Self.resolveThreadState(
                latestTurn: shell.latestTurn, session: shell.session,
                hasApprovals: shell.hasPendingApprovals, hasUserInput: shell.hasPendingUserInput,
                backgroundLiveness: shell.backgroundLiveness, v2Lifecycle: lifecycle
            )
            thread.updatedAt = parseDate(shell.updatedAt)
            thread.rawUpdatedAt = lifecycle.runtimeUpdatedAt
            thread.latestTurnCompletedAt = lifecycle.latestRunCompletedAt.flatMap(parseValidDate)
        }
        thread.relationshipToParent = shell.relationshipToParent
        thread.title = shell.title
        thread.isRegeneratingTitle = shell.titleRegeneration != nil
        thread.isSettled = isSettled(shell.settledOverride, settledAt: shell.settledAt)
        thread.keepsActive = shell.settledOverride == "active"
        thread.settledAt = shell.settledAt.flatMap(parseValidDate)
        thread.unsettledAt = shell.unsettledAt.flatMap(parseValidDate)
        thread.activeOrderKey = shell.activeOrderKey
        thread.autoSettleDisabledAt = shell.autoSettleDisabledAt
        thread.snoozedUntil = shell.snoozedUntil.flatMap(parseValidDate)
        thread.snoozedAt = shell.snoozedAt.flatMap(parseValidDate)
        thread.pinnedAt = shell.pinnedAt.flatMap(parseValidDate)
        thread.pinOrderKey = shell.pinOrderKey
        thread.linkedPullRequest = shell.linkedPullRequest
        thread.pullRequests = shell.pullRequests
        thread.branchPullRequest = shell.branchPullRequest
        thread.settlementFacts = settlementFacts(
            override: shell.settledOverride,
            session: shell.session,
            hasApprovals: shell.hasPendingApprovals,
            hasUserInput: shell.hasPendingUserInput,
            latestUserMessageAt: shell.latestUserMessageAt,
            latestTurn: shell.latestTurn
        )
    }

    private func mapRuntimeMode(_ mode: RuntimeMode) -> FeatureRuntimeMode {
        switch mode {
        case .approvalRequired: .approvalRequired
        case .autoAcceptEdits: .autoAcceptEdits
        case .auto: .automatic
        case .fullAccess: .fullAccess
        }
    }

    private func coreRuntimeMode(_ mode: FeatureRuntimeMode) -> RuntimeMode {
        switch mode {
        case .approvalRequired: .approvalRequired
        case .autoAcceptEdits: .autoAcceptEdits
        case .automatic: .auto
        case .fullAccess: .fullAccess
        }
    }

    private func mapInteractionMode(_ mode: InteractionMode) -> FeatureInteractionMode {
        mode == .plan ? .plan : .standard
    }

    private func coreInteractionMode(_ mode: FeatureInteractionMode) -> InteractionMode {
        mode == .plan ? .plan : .default
    }

    /// Reuse mapped models across shell and settings updates. The config
    /// setter invalidates an entry only when its provider snapshots change.
    private var providerCatalogCache: [String: [FeatureProvider]] = [:]

    /// Single write path for server configs so the provider catalog cache can
    /// never go stale against the config that feeds it.
    private func setServerConfig(_ config: ServerConfigSnapshot, environmentID: String) {
        if serverConfigsByEnvironmentID[environmentID]?.environment?.capabilities
            != config.environment?.capabilities {
            shellProjectionCache[environmentID] = nil
        }
        if serverConfigsByEnvironmentID[environmentID]?.providers != config.providers {
            providerCatalogCache[environmentID] = nil
        }
        let endpointsChanged = serverConfigsByEnvironmentID[environmentID]?.directEndpoints != config.directEndpoints
        serverConfigsByEnvironmentID[environmentID] = config
        if endpointsChanged, config.environment?.environmentId == environmentID,
           let route = environmentClients[environmentID]?.environment.selectedRoute {
            Task { [runtime] in
                try? await runtime.recordDiscoveredEndpoints(
                    environmentID: environmentID, endpoints: config.directEndpoints, verifiedRoute: route
                )
            }
        }
    }

    private func mapProviders(
        environmentID: String,
        shell: OrchestrationShellSnapshot,
        config: ServerConfigSnapshot?
    ) -> [FeatureProvider] {
        if let providers = config?.providers, !providers.isEmpty {
            if let cached = providerCatalogCache[environmentID] { return cached }
            let mapped = mapConfigProviders(providers)
            providerCatalogCache[environmentID] = mapped
            return mapped
        }
        return mapShellFallbackProviders(shell)
    }

    private func mapConfigProviders(
        _ providers: [ServerProviderSnapshot]
    ) -> [FeatureProvider] {
        Self.normalizedProviders(providers.map { provider in
                var mapped = FeatureProvider(
                    id: provider.instanceId,
                    name: ProviderInstanceDisplay.name(
                        instanceID: provider.instanceId, driver: provider.driver,
                        displayName: provider.displayName
                    ),
                    isAvailable: provider.enabled
                        && provider.installed
                        && provider.status != "disabled"
                        && provider.status != "error"
                        && provider.auth.status != "unauthenticated"
                        && provider.availability != "unavailable",
                    driver: provider.driver,
                    requiresNewThreadForModelChange:
                        provider.requiresNewThreadForModelChange ?? false,
                    models: provider.models.map { model in
                        let options = (model.capabilities?.optionDescriptors ?? [])
                            .map(mapOptionDescriptor)
                        var mappedModel = FeatureModel(
                            id: model.slug,
                            name: model.name,
                            detail: model.subProvider ?? model.shortName,
                            supportsReasoning: options.contains { descriptor in
                                let searchable = "\(descriptor.id) \(descriptor.label)".lowercased()
                                return searchable.contains("reason")
                                    || searchable.contains("effort")
                                    || searchable.contains("thinking")
                            },
                            isDefault: model.isDefault ?? false,
                            isLegacy: model.isLegacy,
                            options: options
                        )
                        mappedModel.supportedRuntimeModes = model.capabilities?.supportedRuntimeModes?.map(mapRuntimeMode)
                        return mappedModel
                    },
                    slashCommands: (provider.slashCommands ?? []).map { command in
                        FeatureProviderSlashCommand(
                            name: command.name,
                            description: command.description,
                            inputHint: command.input?.hint
                        )
                    },
                    skills: (provider.skills ?? []).map(Self.mapSkill)
                )
                mapped.showInteractionModeToggle = provider.showInteractionModeToggle
                mapped.setup = provider.setup
                mapped.versionAdvisory = provider.versionAdvisory
                mapped.compatibilityAdvisory = provider.compatibilityAdvisory
                mapped.updateState = provider.updateState
                mapped.accentColor = ProviderInstanceDisplay.accentColor(provider.accentColor)
                mapped.isEnabled = provider.enabled
                mapped.isInstalled = provider.installed
                mapped.authStatus = provider.auth.status
                mapped.canLogout = provider.auth.canLogout
                mapped.statusMessage = provider.message
                mapped.workspaceSnapshots = provider.workspaceSnapshots?.map { workspace in
                    FeatureProviderWorkspace(
                        cwd: workspace.cwd,
                        slashCommands: workspace.slashCommands.map {
                            FeatureProviderSlashCommand(name: $0.name, description: $0.description, inputHint: $0.input?.hint)
                        },
                        skills: workspace.skills.map(Self.mapSkill)
                    )
                }
                return mapped
            })
    }

    private static func mapSkill(_ skill: ServerProviderSkillSnapshot) -> FeatureProviderSkill {
        var mapped = FeatureProviderSkill(
            name: skill.name, displayName: skill.displayName,
            description: skill.description, shortDescription: skill.shortDescription,
            path: skill.path, scope: skill.scope, isEnabled: skill.enabled
        )
        mapped.userInvocationOnly = skill.userInvocationOnly
        mapped.userInvocable = skill.userInvocable
        return mapped
    }

    /// Without a server config the catalog is inferred from selections in the
    /// shell, which is cheap enough to rebuild per publish.
    private func mapShellFallbackProviders(
        _ shell: OrchestrationShellSnapshot
    ) -> [FeatureProvider] {
        var modelsByProvider: [String: Set<String>] = [:]
        for selection in shell.projects.compactMap(\.defaultModelSelection)
            + shell.threads.map(\.modelSelection) {
            modelsByProvider[selection.instanceId, default: []].insert(selection.model)
        }
        if modelsByProvider.isEmpty {
            modelsByProvider["codex"] = ["gpt-5.6-sol"]
        }
        return modelsByProvider.keys.sorted().map { providerID in
            FeatureProvider(
                id: providerID,
                name: UsageLimitsPresentation.providerLabel(driver: providerID),
                driver: providerID,
                models: (modelsByProvider[providerID] ?? []).sorted().map {
                    FeatureModel(id: $0, name: $0)
                }
            )
        }
    }

    static func normalizedProviders(
        _ providers: [FeatureProvider]
    ) -> [FeatureProvider] {
        var normalized: [FeatureProvider] = []
        var providerIndexByID: [String: Int] = [:]

        for var provider in providers {
            var seenModelIDs = Set<String>()
            provider.models = provider.models.filter {
                seenModelIDs.insert($0.id).inserted
            }
            if let index = providerIndexByID[provider.id] {
                var existing = normalized[index]
                var existingModelIDs = Set(existing.models.map(\.id))
                existing.models.append(contentsOf: provider.models.filter {
                    existingModelIDs.insert($0.id).inserted
                })
                normalized[index] = existing
            } else {
                providerIndexByID[provider.id] = normalized.count
                normalized.append(provider)
            }
        }
        return normalized
    }

    private func modelSelection(
        _ selection: FeatureSelection?,
        projectID: String,
        environmentID: String,
        shell: OrchestrationShellSnapshot?
    ) -> ModelSelection {
        if let selection {
            return coreModelSelection(selection)
        }
        let project = shell?.projects.first(where: { $0.id == projectID })
        let config = serverConfigsByEnvironmentID[environmentID]
        let settings = config?.settings ?? ServerSettingsSnapshot()
        let effective = settings.resolvingProject(
            id: projectID, legacyModelSelection: project?.defaultModelSelection,
            legacyWorkspaceMode: project?.defaultThreadEnvMode,
            disabledProviderIDs: Set((config?.providers ?? []).filter { !providerCanRun($0) }.map(\.instanceId))
        )
        if let projectDefault = effective.defaultModelSelection {
            return projectDefault
        }
        return fallbackModelSelection(
            environmentID: environmentID,
            projectID: projectID,
            shell: shell
        )
    }

    /// Fallback selection is resolved against the target environment. This
    /// matters when a passive machine exposes a different provider catalogue
    /// than the currently active one.
    private func fallbackModelSelection(
        environmentID: String,
        projectID: String?,
        shell: OrchestrationShellSnapshot?
    ) -> ModelSelection {
        let config = serverConfigsByEnvironmentID[environmentID]
        let appSelection = loadSettings().defaultSelection
        if let selection = appSelection, let config {
            if configSupports(selection, config: config) {
                return coreModelSelection(selection)
            }
        }
        if let configuredDefault = defaultModelSelection(in: config) {
            return configuredDefault
        }
        if let projectID,
           let recentProjectSelection = shell?.threads
            .first(where: { $0.projectId == projectID })?
            .modelSelection {
            return recentProjectSelection
        }
        if let knownSelection = shell?.projects.compactMap(\.defaultModelSelection).first
            ?? shell?.threads.first?.modelSelection {
            return knownSelection
        }
        if let selection = appSelection {
            return coreModelSelection(selection)
        }
        return ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
    }

    private func configSupports(
        _ selection: FeatureSelection,
        config: ServerConfigSnapshot
    ) -> Bool {
        config.providers.contains { provider in
            provider.instanceId == selection.providerID
                && providerCanRun(provider)
                && provider.models.contains { $0.slug == selection.modelID }
        }
    }

    private func defaultModelSelection(
        in config: ServerConfigSnapshot?
    ) -> ModelSelection? {
        guard let providers = config?.providers else { return nil }
        for provider in providers where providerCanRun(provider) {
            if let model = provider.models.first(where: { $0.isDefault == true }) {
                return ModelSelection(instanceId: provider.instanceId, model: model.slug)
            }
        }
        for provider in providers where providerCanRun(provider) {
            if let model = provider.models.first {
                return ModelSelection(instanceId: provider.instanceId, model: model.slug)
            }
        }
        return nil
    }

    private func providerCanRun(_ provider: ServerProviderSnapshot) -> Bool {
        provider.enabled
            && provider.installed
            && provider.status != "disabled"
            && provider.status != "error"
            && provider.auth.status != "unauthenticated"
            && provider.availability != "unavailable"
    }

    private func coreModelSelection(_ selection: FeatureSelection) -> ModelSelection {
        let options = selection.options.map { option in
            ModelSelection.OptionSelection(
                id: option.id,
                value: coreOptionValue(option.value)
            )
        }
        return ModelSelection(
            instanceId: selection.providerID,
            model: selection.modelID,
            options: options.isEmpty ? nil : options
        )
    }

    private func mapSelection(_ selection: ModelSelection) -> FeatureSelection {
        FeatureSelection(
            providerID: selection.instanceId,
            modelID: selection.model,
            options: mapOptionSelections(selection.options)
        )
    }

    private func coreOptionValue(_ value: FeatureModelOptionValue) -> JSONValue {
        switch value {
        case let .string(rawValue):
            return .string(rawValue)
        case let .boolean(rawValue):
            return .bool(rawValue)
        }
    }

    private func mapOptionSelections(
        _ selections: [ModelSelection.OptionSelection]?
    ) -> [FeatureModelOptionSelection] {
        (selections ?? []).compactMap { selection in
            let value: FeatureModelOptionValue
            switch selection.value {
            case let .string(rawValue):
                value = .string(rawValue)
            case let .bool(rawValue):
                value = .boolean(rawValue)
            default:
                return nil
            }
            return FeatureModelOptionSelection(id: selection.id, value: value)
        }
    }

    private func mapOptionDescriptor(
        _ descriptor: ServerProviderOptionDescriptor
    ) -> FeatureModelOptionDescriptor {
        switch descriptor {
        case let .select(value):
            let defaultValue = value.currentValue
                ?? value.options.first(where: { $0.isDefault == true })?.id
            return FeatureModelOptionDescriptor(
                id: value.id,
                label: value.label,
                detail: value.description,
                kind: .select,
                choices: value.options.map {
                    FeatureModelOptionChoice(
                        id: $0.id,
                        label: $0.label,
                        detail: $0.description,
                        isDefault: $0.isDefault ?? false
                    )
                },
                defaultValue: defaultValue.map(FeatureModelOptionValue.string),
                promptInjectedValues: value.promptInjectedValues
            )
        case let .boolean(value):
            return FeatureModelOptionDescriptor(
                id: value.id,
                label: value.label,
                detail: value.description,
                kind: .boolean,
                defaultValue: value.currentValue.map(FeatureModelOptionValue.boolean)
            )
        }
    }

    private func threadProviderName(
        session: OrchestrationSession?,
        modelSelection: ModelSelection,
        environmentID: String
    ) -> String {
        if let name = session?.providerName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            return name
        }
        let providerID = session?.providerInstanceId ?? modelSelection.instanceId
        if let provider = serverConfigsByEnvironmentID[environmentID]?.providers.first(where: {
            $0.instanceId == providerID
        }) {
            return provider.displayName ?? UsageLimitsPresentation.providerLabel(driver: provider.driver)
        }
        return UsageLimitsPresentation.providerLabel(driver: providerID)
    }

    private func cachedAttachmentURL(
        for id: String,
        environmentID: String? = nil
    ) -> URL? {
        guard let environmentID = environmentID ?? activeEnvironment?.id else {
            return nil
        }
        let key = AttachmentCacheKey(environmentID: environmentID, attachmentID: id)
        guard let cached = attachmentURLs[key] else { return nil }
        guard cached.expiresAt > Date().addingTimeInterval(30) else {
            attachmentURLs[key] = nil
            return nil
        }
        return cached.url
    }

    func attachmentAssetURL(
        threadID: String,
        attachment: FeatureMessageAttachment
    ) async throws -> URL {
        try Task.checkCancellation()
        let route = try threadRoute(for: threadID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(
            [EnvironmentPermissionRequirements.asset(resourceKind: "attachment")],
            client: route.client, generation: generation
        )
        if let cached = cachedAttachmentURL(for: attachment.id, environmentID: route.environmentID) {
            return cached
        }
        let resolved = try await route.client.resolvedAsset(
            resource: .attachment(
                id: attachment.id,
                fileName: attachment.name,
                mimeType: attachment.mimeType
            )
        )
        try Task.checkCancellation()
        guard isKnownClient(
            route.client, environmentID: route.environmentID, generation: generation
        ) else { throw CancellationError() }
        let key = AttachmentCacheKey(
            environmentID: route.environmentID, attachmentID: attachment.id
        )
        // URLs are small, but a session can visit thousands of attachments.
        if attachmentURLs.count >= 256 {
            let expiry = Date().addingTimeInterval(30)
            attachmentURLs = attachmentURLs.filter { $0.value.expiresAt > expiry }
            if attachmentURLs.count >= 256, let oldest = attachmentURLs.min(by: {
                $0.value.expiresAt < $1.value.expiresAt
            })?.key {
                attachmentURLs[oldest] = nil
            }
        }
        attachmentURLs[key] = CachedAttachmentURL(
            url: resolved.url, expiresAt: resolved.expiresAt
        )
        return resolved.url
    }

    func contextAttachmentAssetURL(
        environmentID: String, attachment: ComposerContextRecord.Attachment
    ) async throws -> URL {
        try Task.checkCancellation()
        guard try await runtime.environments().contains(where: { $0.id == environmentID && $0.isEnabled }) else {
            throw ComposerContextClipboardError.sourceUnavailable
        }
        let client = try await projectCreationClient(environmentID: environmentID)
        let generation = environmentGeneration
        try await requireWorkspaceScopes(
            [EnvironmentPermissionRequirements.asset(resourceKind: "attachment")],
            client: client, generation: generation
        )
        let resolved = try await client.resolvedAsset(resource: .attachment(
            id: attachment.attachmentId, fileName: attachment.name, mimeType: attachment.mimeType
        ))
        try Task.checkCancellation()
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        return resolved.url
    }

    private func lastActivityDate(
        latestUserMessageAt: String?,
        latestTurn: OrchestrationLatestTurn?
    ) -> Date? {
        [
            latestUserMessageAt,
            latestTurn?.requestedAt,
            latestTurn?.startedAt,
            latestTurn?.completedAt,
        ]
        .compactMap { $0.flatMap(parseValidDate) }
        .max()
    }

    private func failureDate(
        latestTurn: OrchestrationLatestTurn?,
        session: OrchestrationSession?
    ) -> Date? {
        guard session?.status == "error" || latestTurn?.state == "error" else {
            return nil
        }
        return [
            session?.updatedAt,
            latestTurn?.completedAt,
            latestTurn?.startedAt,
            latestTurn?.requestedAt,
        ]
        .compactMap { $0.flatMap(parseValidDate) }
        .max()
    }

    private func workingStartedAt(
        latestTurn: OrchestrationLatestTurn?,
        session: OrchestrationSession?,
        backgroundWorkIsActive: Bool = false,
        fallbackUpdatedAt: String? = nil
    ) -> Date? {
        let directSessionIsLive = session?.status == "starting"
            || session?.status == "running"
        guard directSessionIsLive || backgroundWorkIsActive else {
            return nil
        }
        let candidates: [String?]
        if directSessionIsLive, let latestTurn, latestTurn.completedAt == nil {
            candidates = [
                latestTurn.startedAt,
                latestTurn.requestedAt,
                session?.updatedAt,
            ]
        } else if backgroundWorkIsActive {
            candidates = [
                latestTurn?.startedAt,
                latestTurn?.requestedAt,
                session?.updatedAt,
                fallbackUpdatedAt,
            ]
        } else {
            candidates = [session?.updatedAt]
        }
        return candidates.lazy.compactMap { $0.flatMap(self.parseValidDate) }.first
    }

    private func makeUploadAttachments(
        _ attachments: [FeatureUploadAttachment]
    ) async throws -> [UploadChatAttachment] {
        guard attachments.count <= UploadChatAttachment.maximumCount else {
            throw NativeFeatureClientError.tooManyAttachments
        }
        let uploads = try await Task.detached(priority: .userInitiated) {
            try attachments.map {
                let reference = $0.uploadedReference.map {
                    UploadedAttachmentReference(
                        environmentID: $0.environmentID,
                        attachmentID: $0.attachmentID
                    )
                }
                if let ownedFile = $0.ownedFile {
                    if $0.mimeType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("image/") {
                        return try UploadChatAttachment(
                            id: $0.id, data: Data(contentsOf: ownedFile.url),
                            name: $0.name, mimeType: $0.mimeType, uploadedReference: reference
                        )
                    }
                    return try UploadChatAttachment(
                        id: $0.id,
                        fileURL: ownedFile.url,
                        name: $0.name,
                        mimeType: $0.mimeType,
                        sizeBytes: ownedFile.byteCount,
                        uploadedReference: reference,
                        contextSource: $0.source
                    )
                }
                return try UploadChatAttachment(
                    id: $0.id,
                    data: $0.data,
                    name: $0.name,
                    mimeType: $0.mimeType,
                    uploadedReference: reference,
                    contextSource: $0.source
                )
            }
        }.value
        try Task.checkCancellation()
        try UploadChatAttachment.validateBatch(uploads)
        return uploads
    }

    func requireScope(_ scope: String, client: T3Client) async throws {
        let generation = environmentGeneration
        let environmentID = client.environment.id
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        let session: AuthSessionState
        do { session = try await client.authSession() }
        catch {
            if isKnownClient(client, environmentID: environmentID, generation: generation) {
                environmentPermissions[environmentID] = nil
            }
            throw error
        }
        try Task.checkCancellation()
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        let state = EnvironmentPermissionState(session: session, serverAuth: serverConfigsByEnvironmentID[environmentID]?.auth)
        environmentPermissions[environmentID] = state
        try state.require(scope)
    }

    func permissions(forThreadID threadID: String) -> EnvironmentPermissionState? {
        guard let route = try? threadRoute(for: threadID),
              environmentConnectionStates[route.environmentID] == .connected else { return nil }
        return environmentPermissions[route.environmentID]
    }

    private static func title(from prompt: String, hasAttachments: Bool) -> String {
        let compact = prompt
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        guard !compact.isEmpty else {
            return hasAttachments ? "Image task" : "New thread"
        }
        guard compact.count > 72 else { return compact }
        return "\(compact.prefix(69).trimmingCharacters(in: .whitespacesAndNewlines))..."
    }

    private func commandIdentity(
        _ identity: FeatureSubmissionIdentity
    ) -> CommandIdentity {
        CommandIdentity(
            commandID: identity.commandID,
            messageID: identity.messageID,
            createdAt: Self.fractionalDateFormatter.string(from: identity.createdAt)
        )
    }

    private static func temporaryWorktreeBranchName(seed: String? = nil) -> String {
        let suffix = seed ?? UUID().uuidString
        return "t3code/\(suffix.prefix(8).lowercased())"
    }

    /// Collapses whitespace runs and caps the result at 160 characters. It stops
    /// reading early, so a long streaming reply costs the same as a short one.
    nonisolated static func previewText(_ text: String?) -> String? {
        guard let text else { return nil }
        var compact = ""
        var count = 0
        var needsSpace = false
        for character in text {
            if character.isWhitespace {
                needsSpace = count > 0
                continue
            }
            if needsSpace {
                compact.append(" ")
                count += 1
                needsSpace = false
            }
            compact.append(character)
            count += 1
            if count > 160 { break }
        }
        guard count > 0 else { return nil }
        return count > 160 ? "\(compact.prefix(157))..." : compact
    }

    /// Decoded once per process and on every `saveSettings`. `makeSnapshot`
    /// runs on every publish, so it must not hit UserDefaults and JSONDecoder.
    private func loadSettings() -> FeatureSettings {
        if let cachedSettings { return cachedSettings }
        let settings: FeatureSettings
        if let data = settingsStore.data(forKey: Self.settingsKey),
           let decoded = try? JSONDecoder().decode(FeatureSettings.self, from: data) {
            settings = decoded
        } else {
            settings = FeatureSettings()
        }
        cachedSettings = settings
        return settings
    }

    private func parseDate(_ value: String) -> Date {
        parseValidDate(value) ?? .distantPast
    }

    /// Reuse unchanged timestamps across snapshot mappings. Keep the cache bounded
    /// even when a long session receives many different event times.
    private func parseValidDate(_ value: String) -> Date? {
        if let cached = parsedDates[value] { return cached }
        guard let parsed = NativeTimestampParser.parse(value) else { return nil }
        if parsedDates.count >= 4096 { parsedDates.removeAll(keepingCapacity: true) }
        parsedDates[value] = parsed
        return parsed
    }

    private var parsedDates: [String: Date] = [:]

    private static let settingsKey = "swift-ios.feature-settings.v1"
    private static let fractionalDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

extension FeatureDeviceSession {
    init(relayDevice: T3ConnectRelayDevice, currentDeviceID: String?) {
        let updatedAt = Self.t3ConnectRelayDate(relayDevice.updatedAt)
        self.init(
            sessionID: relayDevice.deviceId,
            label: relayDevice.label,
            deviceType: relayDevice.platform.lowercased().contains("ipad") ? .tablet : .mobile,
            operatingSystem: "iOS \(relayDevice.iosMajorVersion)",
            browser: relayDevice.appVersion.map { "T3 Code \($0)" },
            issuedAt: updatedAt,
            expiresAt: .distantFuture,
            lastConnectedAt: updatedAt,
            isConnected: false,
            isCurrent: relayDevice.deviceId == currentDeviceID
        )
    }

    private static func t3ConnectRelayDate(_ value: String) -> Date {
        (try? Date(value, strategy: .iso8601)) ?? .distantPast
    }
}

enum NativeDetailRenderMutation: Equatable {
    case full
    case message(OrchestrationMessage)
    case activity(OrchestrationActivity)
    case metadata
    case none
}

struct NativeDetailRenderMutations {
    private(set) var hasUpdates = false
    private(set) var requiresFullRebuild = false
    private(set) var messages: [OrchestrationMessage] = []
    private(set) var activities: [OrchestrationActivity] = []

    mutating func formUnion(_ mutation: NativeDetailRenderMutation) {
        if mutation != .none { hasUpdates = true }
        guard !requiresFullRebuild else { return }
        switch mutation {
        case .full:
            requiresFullRebuild = true
            messages.removeAll(keepingCapacity: true)
            activities.removeAll(keepingCapacity: true)
        case let .message(message):
            if let index = messages.firstIndex(where: { $0.id == message.id }) {
                messages[index] = message
            } else {
                messages.append(message)
            }
        case let .activity(activity):
            if let index = activities.firstIndex(where: { $0.id == activity.id }) {
                activities[index] = activity
            } else {
                activities.append(activity)
            }
        case .metadata, .none:
            break
        }
    }
}

private final class NativeDetailRenderCache {
    let v2Timeline = FeatureV2TimelineRenderer()
    var isInitialized = false
    var messagesByID: [String: FeatureMessage] = [:]
    var mergedMessages: [FeatureMessage] = []
    var mergedIndexByID: [String: Int] = [:]
    var workLogsByGroupID: [String: NativeWorkLogAccumulator] = [:]
    var workLogActivityIDs: Set<String> = []
    var approvals: [FeatureApproval] = []
    var userInputs: [FeatureUserInput] = []
    var closedApprovalRequestIDs: Set<String> = []
    var closedUserInputRequestIDs: Set<String> = []
    var subagents = FeatureActiveSubagentTracker()
    var compaction = NativeContextCompactionState()
}

enum NativeQuestionAnswerHistory {
    static func messages(_ activity: OrchestrationActivity, createdAt: Date) -> [FeatureMessage] {
        guard activity.kind == "user-input.answer-submitted",
              case let .object(attachments)? = activity.payload["attachmentsByQuestionId"],
              case let .object(answers)? = activity.payload["answers"] else { return [] }
        let questionText = activity.payload["questionTextById"]
        return Set(answers.keys).union(attachments.keys).sorted().map { questionID in
            let answer: String
            switch answers[questionID] {
            case let .string(text): answer = text
            case let .array(values): answer = values.compactMap(\.stringValue).joined(separator: ", ")
            default: answer = ""
            }
            let text = [questionText?[questionID]?.stringValue, answer]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
            let files: [JSONValue]
            if case let .array(values)? = attachments[questionID] { files = values } else { files = [] }
            return FeatureMessage(
                id: "question-answer:\(activity.id):\(questionID)", role: .user, text: text,
                createdAt: createdAt,
                attachments: files.compactMap { file in
                    guard let file = try? file.decode(ChatAttachment.self) else { return nil }
                    return FeatureMessageAttachment(
                        id: file.id, name: file.name, mimeType: file.mimeType,
                        sizeBytes: file.sizeBytes
                    )
                }
            )
        }
    }
}

enum NativeActivityNotice {
    static func accepts(_ activity: OrchestrationActivity) -> Bool {
        guard activity.tone == "error" || activity.kind == "runtime.warning"
            || activity.kind == "context-compaction" else { return false }
        if NativeActivityFilters.isNoContentRuntimeWarning(activity) { return false }
        if NativeActivityFilters.isAgentInternal(activity) { return false }
        return true
    }

    static func message(_ activity: OrchestrationActivity, createdAt: Date) -> FeatureMessage? {
        guard accepts(activity) else { return nil }
        let text: String
        if activity.kind == "context-compaction" {
            text = activity.summary
        } else if let message = activity.payload["message"]?.stringValue,
                  !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            text = message
        } else if let detail = activity.payload["detail"]?.stringValue,
                  !detail.isEmpty, detail != activity.summary {
            text = "\(activity.summary)\n\(detail)"
        } else {
            text = activity.summary
        }
        return FeatureMessage(
            id: "activity-\(activity.id)",
            role: .system,
            text: text,
            createdAt: createdAt,
            state: .complete,
            toolName: activity.kind
        )
    }
}

/// Row filters shared with the web transcript (apps/web/src/session-logic.ts).
/// Rows owned by a subagent, bypassed lifecycle rows, and adapter warnings with
/// no displayable text belong to the fleet view, not the parent timeline.
enum NativeActivityFilters {
    static func isNoContentRuntimeWarning(_ activity: OrchestrationActivity) -> Bool {
        activity.kind == "runtime.warning"
            && activity.summary.hasSuffix("(no displayable text content)")
    }

    static func isPlanBoundaryTool(_ activity: OrchestrationActivity) -> Bool {
        guard activity.kind == "tool.updated" || activity.kind == "tool.completed" else {
            return false
        }
        return activity.payload["detail"]?.stringValue?.hasPrefix("ExitPlanMode:") == true
    }

    static func isAgentInternal(_ activity: OrchestrationActivity) -> Bool {
        let ownedByAgent = activity.payload["agentId"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        let bypassed = activity.payload["timelineBypass"]?.boolValue == true
        let isTaskRow = activity.kind.hasPrefix("task.")
        if isTaskRow {
            guard ownedByAgent || bypassed else { return false }
            // A nested agent's own task row stays visible as a spawn anchor;
            // its background shell rows and updates do not.
            let isAgentTaskRow = activity.kind != "task.updated"
                && activity.payload["taskId"]?.stringValue != nil
                && activity.payload["agentKind"]?.stringValue == "agent"
            return !isAgentTaskRow
        }
        return bypassed || ownedByAgent
    }
}

/// The latest compaction request and its matching result survive live updates
/// without scanning the retained activity history for each streamed token.
struct NativeContextCompactionState {
    private var requestID: String?
    private var requestedAt: Date?
    private var settled = false
    private var v2RunID: String?

    mutating func apply(_ message: OrchestrationMessage, createdAt: Date) {
        if let source = message.v2Timeline, source.visibility != "local" { return }
        guard message.role == "user",
              FeatureContextCompaction.isCommand(
                message.text, hasAttachments: message.attachments?.isEmpty == false
              ) else { return }
        if let requestedAt, createdAt < requestedAt { return }
        v2RunID = message.v2Timeline?.runID
        if requestID != message.id {
            requestID = message.id
            requestedAt = createdAt
            settled = false
        }
    }

    mutating func apply(_ activity: OrchestrationActivity) {
        if let source = activity.v2Timeline, let v2RunID,
           source.visibility == "local", source.runID == v2RunID {
            if source.itemType == "compaction", ["completed", "failed", "cancelled"].contains(source.status) {
                settled = true
            } else if source.itemType == "error", source.status == "failed" {
                settled = true
            }
            return
        }
        guard activity.kind == "context-compaction" || activity.kind == "provider.turn.start.failed",
              let requestID, activity.payload["requestId"]?.stringValue == requestID else { return }
        settled = true
    }

    func isActive(
        sessionStatus: String?,
        latestTurnState: String?,
        latestTurnRequestedAt: Date?
    ) -> Bool {
        guard !settled, let requestedAt,
              sessionStatus == "starting" || sessionStatus == "running" else { return false }
        let turnRequestedAt = latestTurnRequestedAt ?? requestedAt
        return requestedAt > turnRequestedAt
            || (latestTurnState == "running" && requestedAt == turnRequestedAt)
    }
}

enum NativeSharedPreferenceChange {
    static func filter(
        _ change: ServerSettingsChange,
        supportsRestartContinuation: Bool,
        settings: ServerSettingsSnapshot? = nil
    ) -> ServerSettingsChange? {
        var unsupported = settings?.unsupportedPreferenceKeys ?? []
        if !supportsRestartContinuation { unsupported.insert("continueThreadsAfterServerUpdate") }
        switch change {
        case let .sharedPreferences(.object(fields)):
            let fields = fields.filter { !unsupported.contains($0.key) }
            return fields.isEmpty ? nil : .sharedPreferences(.object(fields))
        default:
            if case let .object(fields) = change.jsonValue,
               fields.keys.contains(where: unsupported.contains) { return nil }
            return change
        }
    }
}

struct NativeWorkLogAccumulator {
    private static let terminalKinds = Set([
        "tool.completed", "task.completed",
    ])
    private static let activeKinds = Set(["tool.started", "tool.updated"])
    private static let imageExtensions = Set([
        "avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp",
    ])

    private(set) var count = 0
    private var visibleLines: [String] = []
    private var visibleLineKeys: [String] = []
    private var completedKeys: Set<String> = []
    private var createdAt = Date.distantPast
    private var activeEntries: [String: String] = [:]
    private var activeOrder: [String] = []
    private var imagePaths: [String] = []
    private var toolPresentation: ToolActivityPresentation?
    private var activePresentations: [String: ToolActivityPresentation] = [:]

    var hasActiveWork: Bool { !activeEntries.isEmpty }
    var hasContent: Bool { count > 0 || hasActiveWork || !imagePaths.isEmpty }

    static func accepts(_ activity: OrchestrationActivity) -> Bool {
        guard activeKinds.contains(activity.kind)
            || (activity.tone != "error" && terminalKinds.contains(activity.kind)) else {
            return false
        }
        if NativeActivityFilters.isPlanBoundaryTool(activity) { return false }
        if NativeActivityFilters.isAgentInternal(activity) { return false }
        return true
    }

    mutating func append(
        _ activity: OrchestrationActivity,
        preview: String?,
        createdAt: Date
    ) {
        if count == 0 && activeEntries.isEmpty {
            self.createdAt = createdAt
        }
        let key = Self.lifecycleKey(activity)
        toolPresentation = ToolActivityPresentation(payload: activity.payload) ?? activePresentations[key]
        let label = activity.payload["title"]?.stringValue ?? activity.summary
        let lifecycleStatus = activity.payload["status"]?.stringValue
        let isTerminalUpdate = activity.kind == "tool.updated"
            && lifecycleStatus.map { $0 != "inProgress" && $0 != "in_progress" } == true
        if Self.activeKinds.contains(activity.kind) && !isTerminalUpdate
            && activity.tone != "error" {
            activeEntries[key] = label
            activePresentations[key] = toolPresentation
            activeOrder.removeAll { $0 == key }
            activeOrder.append(key)
        } else {
            activeEntries[key] = nil
            activePresentations[key] = nil
            activeOrder.removeAll { $0 == key }
            guard activity.tone != "error" else {
                if completedKeys.remove(activity.id) != nil { count -= 1 }
                if let index = visibleLineKeys.firstIndex(of: activity.id) {
                    visibleLineKeys.remove(at: index)
                    visibleLines.remove(at: index)
                }
                return
            }
            if completedKeys.insert(activity.id).inserted { count += 1 }
            if let index = visibleLineKeys.firstIndex(of: activity.id) {
                visibleLines[index] = "• \(preview ?? activity.summary)"
            } else {
                visibleLineKeys.append(activity.id)
                visibleLines.append("• \(preview ?? activity.summary)")
            }
            if visibleLines.count > 40 {
                visibleLineKeys.removeFirst(visibleLines.count - 40)
                visibleLines.removeFirst(visibleLines.count - 40)
            }
        }
        if let path = Self.viewedImagePath(activity), !imagePaths.contains(path) {
            imagePaths.append(path)
            if imagePaths.count > 8 { imagePaths.removeFirst(imagePaths.count - 8) }
        }
    }

    mutating func clearActiveWork() {
        activeEntries.removeAll(keepingCapacity: true)
        activePresentations.removeAll(keepingCapacity: true)
        activeOrder.removeAll(keepingCapacity: true)
    }

    func message(groupID: String) -> FeatureMessage {
        var lines: [String] = []
        if count > visibleLines.count {
            lines.append("\(count - visibleLines.count) earlier updates hidden")
        }
        lines.append(contentsOf: visibleLines)
        var message = FeatureMessage(
            id: "work-log-\(groupID)",
            role: .tool,
            text: lines.joined(separator: "\n"),
            createdAt: createdAt,
            state: .complete,
            toolName: "Work log · \(count)",
            workLogImagePaths: imagePaths.isEmpty ? nil : imagePaths,
            activeWorkLabel: activeOrder.last.flatMap { activeEntries[$0] }
        )
        message.toolPresentation = activeOrder.last.flatMap { activePresentations[$0] } ?? toolPresentation
        return message
    }

    private static func lifecycleKey(_ activity: OrchestrationActivity) -> String {
        if let id = activity.payload["toolCallId"]?.stringValue
            ?? activity.payload["data"]?["toolCallId"]?.stringValue {
            return "id:\(id)"
        }
        let itemType = activity.payload["itemType"]?.stringValue ?? ""
        let title = activity.payload["title"]?.stringValue ?? activity.summary
        let detail = activity.payload["detail"]?.stringValue ?? ""
        return "fallback:\([itemType, title, detail].map(normalizedLifecycleText).joined(separator: "|"))"
    }

    private static func normalizedLifecycleText(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(
                of: #"\s+(complete|completed)$"#,
                with: "",
                options: .regularExpression
            )
    }

    private static func viewedImagePath(_ activity: OrchestrationActivity) -> String? {
        let itemType = normalizedLifecycleText(activity.payload["itemType"]?.stringValue ?? "")
        let title = normalizedLifecycleText(activity.payload["title"]?.stringValue ?? activity.summary)
        let qualifies = activity.payload["requestKind"]?.stringValue == "file-read"
            || itemType == "image_view"
            || (itemType == "dynamic_tool_call" && title == "read file")
        guard qualifies,
              let detail = activity.payload["detail"]?.stringValue,
              !detail.contains("\n"), !detail.contains("\r") else { return nil }
        let path = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let ext = path.split(separator: ".").last?.lowercased(),
              imageExtensions.contains(String(ext)) else { return nil }
        return path
    }
}

enum NativeThreadDetailReductionResult: Equatable {
    case updated(OrchestrationThread)
    case unchanged
    case refresh
}

struct NativeThreadDetailReduction: Equatable {
    let sequence: Int
    let result: NativeThreadDetailReductionResult
    let renderMutation: NativeDetailRenderMutation

    init(
        sequence: Int,
        result: NativeThreadDetailReductionResult,
        renderMutation: NativeDetailRenderMutation = .metadata
    ) {
        self.sequence = sequence
        self.result = result
        self.renderMutation = renderMutation
    }
}

/// Swift counterpart to client-runtime's thread reducer for the detail event
/// subset sent by `subscribeThread`. Destructive and forward-unknown events
/// deliberately request an authoritative snapshot.
enum NativeThreadDetailReducer {
    static func apply(
        _ event: JSONValue,
        to thread: OrchestrationThread,
        afterSequence: Int? = nil
    ) -> NativeThreadDetailReduction {
        guard case let .object(object) = event,
              let type = object["type"]?.stringValue,
              let occurredAt = object["occurredAt"]?.stringValue,
              let sequence = intValue(object["sequence"]),
              let payload = object["payload"],
              payload["threadId"]?.stringValue == thread.id else {
            return NativeThreadDetailReduction(
                sequence: -1,
                result: .refresh,
                renderMutation: .full
            )
        }

        // Validate ownership and the common envelope before skipping replayed events.
        if let afterSequence, sequence >= 0, sequence <= afterSequence {
            return NativeThreadDetailReduction(
                sequence: sequence, result: .unchanged, renderMutation: .none
            )
        }

        let result: NativeThreadDetailReductionResult
        var renderMutation = NativeDetailRenderMutation.metadata
        switch type {
        case "thread.settled":
            result = reduceSettled(payload: payload, thread: thread)
        case "thread.unsettled":
            result = reduceUnsettled(payload: payload, thread: thread)
        case "thread.meta-updated":
            result = reduceMetadata(payload: payload, occurredAt: occurredAt, thread: thread)
        case "thread.auto-settle-set":
            var updated = replacing(thread, updatedAt: payload["updatedAt"]?.stringValue ?? occurredAt)
            updated.autoSettleDisabledAt = payload["autoSettleDisabledAt"]?.stringValue
            result = .updated(updated)
        case "thread.pin-reordered":
            result = reducePinReordered(
                payload: payload,
                occurredAt: occurredAt,
                thread: thread
            )
        case "thread.pull-request-linked", "thread.pull-request-unlinked", "thread.pull-request-synced":
            result = reducePullRequest(type: type, payload: payload, thread: thread)
        case "thread.message-sent":
            result = reduceMessage(
                payload: payload,
                occurredAt: occurredAt,
                thread: thread,
                renderMutation: &renderMutation
            )
        case "thread.activity-appended":
            result = reduceActivity(
                payload: payload,
                occurredAt: occurredAt,
                thread: thread,
                renderMutation: &renderMutation
            )
        case "thread.session-set":
            result = reduceSession(payload: payload, occurredAt: occurredAt, thread: thread)
        case "thread.turn-diff-completed":
            result = reduceTurnDiff(payload: payload, occurredAt: occurredAt, thread: thread)
        case "thread.proposed-plan-upserted":
            // Proposed plans are not rendered by the native detail model yet.
            result = .unchanged
            renderMutation = .none
        case "thread.reverted":
            result = .refresh
            renderMutation = .full
        default:
            result = .refresh
            renderMutation = .full
        }
        return NativeThreadDetailReduction(
            sequence: sequence,
            result: result,
            renderMutation: renderMutation
        )
    }

    private static func reduceSettled(
        payload: JSONValue,
        thread: OrchestrationThread
    ) -> NativeThreadDetailReductionResult {
        guard let settledAt = payload["settledAt"]?.stringValue,
              let updatedAt = payload["updatedAt"]?.stringValue else {
            return .refresh
        }
        var updated = replacing(
            thread,
            settlement: SettlementReplacement(
                override: "settled",
                settledAt: settledAt,
                unsettledAt: nil
            ),
            updatedAt: updatedAt
        )
        updated.activeOrderKey = nil
        return .updated(updated)
    }

    private static func reduceUnsettled(
        payload: JSONValue,
        thread: OrchestrationThread
    ) -> NativeThreadDetailReductionResult {
        guard let reason = payload["reason"]?.stringValue,
              let updatedAt = payload["updatedAt"]?.stringValue else {
            return .refresh
        }
        return .updated(
            replacing(
                thread,
                settlement: SettlementReplacement(
                    override: reason == "user" ? "active" : nil,
                    settledAt: nil,
                    unsettledAt: thread.settledOverride == "active"
                        ? thread.unsettledAt
                        : updatedAt
                ),
                updatedAt: updatedAt
            )
        )
    }

    private static func reducePullRequest(
        type: String, payload: JSONValue, thread: OrchestrationThread
    ) -> NativeThreadDetailReductionResult {
        guard let updatedAt = payload["updatedAt"]?.stringValue else { return .refresh }
        var updated = replacing(thread, updatedAt: updatedAt)
        var links = thread.pullRequests ?? []
        if type == "thread.pull-request-linked" {
            guard let link = try? payload["link"]?.decode(ThreadPullRequestLink.self) else { return .refresh }
            if let index = links.firstIndex(where: { $0.id == link.id }) { links[index] = link }
            else { links.append(link) }
        } else {
            guard let host = payload["host"]?.stringValue,
                  let repository = payload["repository"]?.stringValue,
                  let number = intValue(payload["number"]) else { return .refresh }
            let key = ThreadPullRequestKey(host: host, repository: repository, number: number)
            guard let index = links.firstIndex(where: { $0.id == key }) else { return .unchanged }
            if type == "thread.pull-request-unlinked" {
                links.remove(at: index)
            } else {
                guard let snapshot = try? payload["snapshot"]?.decode(ThreadPullRequestSnapshot.self),
                      let stackValue = payload["stack"] else { return .refresh }
                let stack: ThreadPullRequestStack?
                if stackValue == .null { stack = nil }
                else {
                    guard let decoded = try? stackValue.decode(ThreadPullRequestStack.self) else { return .refresh }
                    stack = decoded
                }
                links[index].snapshot = snapshot
                links[index].stack = stack
            }
        }
        updated.pullRequests = links
        if let legacy = updated.linkedPullRequest,
           !links.contains(where: { $0.isVisible && $0.number == legacy.number && $0.url == legacy.url }) {
            updated.linkedPullRequest = nil
        }
        return .updated(updated)
    }

    private static func reduceMetadata(
        payload: JSONValue,
        occurredAt: String,
        thread: OrchestrationThread
    ) -> NativeThreadDetailReductionResult {
        guard case let .object(values) = payload,
              values["linkedPullRequest"] != nil
                || values["branchPullRequest"] != nil
                || values["activeOrderKey"] != nil else {
            return .refresh
        }
        guard !["title", "modelSelection", "branch", "worktreePath"].contains(where: {
            values[$0] != nil
        }) else {
            return .refresh
        }
        var updated = replacing(
            thread,
            updatedAt: payload["updatedAt"]?.stringValue ?? occurredAt
        )
        if let rawLink = values["linkedPullRequest"] {
            if rawLink == .null {
                updated.linkedPullRequest = nil
            } else {
                guard let decoded = try? rawLink.decode(ThreadLinkedPullRequest.self) else {
                    return .refresh
                }
                updated.linkedPullRequest = decoded
            }
        }
        if let rawBranchLink = values["branchPullRequest"] {
            if rawBranchLink == .null {
                updated.branchPullRequest = nil
            } else {
                guard let decoded = try? rawBranchLink.decode(ThreadLinkedPullRequest.self) else {
                    return .refresh
                }
                updated.branchPullRequest = decoded
            }
        }
        if let rawOrder = values["activeOrderKey"] {
            if rawOrder == .null {
                updated.activeOrderKey = nil
            } else {
                guard let order = rawOrder.stringValue,
                      !order.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return .refresh
                }
                updated.activeOrderKey = order
            }
        }
        return .updated(updated)
    }

    private static func reducePinReordered(
        payload: JSONValue,
        occurredAt: String,
        thread: OrchestrationThread
    ) -> NativeThreadDetailReductionResult {
        guard let orderKey = payload["orderKey"]?.stringValue,
              !orderKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .refresh
        }
        var updated = replacing(
            thread,
            updatedAt: payload["updatedAt"]?.stringValue ?? occurredAt
        )
        updated.pinOrderKey = orderKey
        return .updated(updated)
    }

    private static func reduceMessage(
        payload: JSONValue,
        occurredAt: String,
        thread: OrchestrationThread,
        renderMutation: inout NativeDetailRenderMutation
    ) -> NativeThreadDetailReductionResult {
        guard let id = payload["messageId"]?.stringValue,
              let role = payload["role"]?.stringValue,
              let text = payload["text"]?.stringValue,
              let streaming = boolValue(payload["streaming"]),
              let createdAt = payload["createdAt"]?.stringValue,
              let updatedAt = payload["updatedAt"]?.stringValue else {
            return .refresh
        }
        let turnID = payload["turnId"]?.stringValue
        let context: OrchestrationMessageContext?
        if let rawContext = payload["context"], rawContext != .null {
            guard let decoded = try? rawContext.decode(OrchestrationMessageContext.self) else { return .refresh }
            context = decoded
        } else {
            context = nil
        }
        let attachments: [ChatAttachment]?
        if let rawAttachments = payload["attachments"], rawAttachments != .null {
            guard let decoded = try? rawAttachments.decode([ChatAttachment].self) else {
                return .refresh
            }
            attachments = decoded
        } else {
            attachments = nil
        }

        var messages = thread.messages
        let existingIndex = messages.last?.id == id
            ? messages.indices.last
            : messages.firstIndex(where: { $0.id == id })
        if let index = existingIndex {
            let existing = messages[index]
            messages[index] = OrchestrationMessage(
                id: existing.id,
                role: existing.role,
                text: streaming ? existing.text + text : (text.isEmpty ? existing.text : text),
                attachments: attachments ?? existing.attachments,
                turnId: turnID,
                streaming: streaming,
                createdAt: existing.createdAt,
                updatedAt: streaming ? existing.updatedAt : updatedAt,
                context: context ?? existing.context
            )
            renderMutation = .message(messages[index])
        } else {
            let message = OrchestrationMessage(
                id: id,
                role: role,
                text: text,
                attachments: attachments,
                turnId: turnID,
                streaming: streaming,
                createdAt: createdAt,
                updatedAt: updatedAt,
                context: context
            )
            messages.append(message)
            renderMutation = .message(message)
        }

        var latestTurn = thread.latestTurn
        var checkpoints = thread.checkpoints
        if role == "assistant", let turnID,
           latestTurn == nil || latestTurn?.turnId == turnID {
            let turnStillRunning = thread.session?.status == "running"
                && thread.session?.activeTurnId == turnID
            let settlesTurn = !streaming && !turnStillRunning
            let previous = latestTurn?.turnId == turnID ? latestTurn : nil
            let state = settlesTurn
                ? (previous?.state == "interrupted" || previous?.state == "error"
                    ? previous!.state
                    : "completed")
                : "running"
            latestTurn = OrchestrationLatestTurn(
                turnId: turnID,
                state: state,
                requestedAt: previous?.requestedAt ?? createdAt,
                startedAt: previous?.startedAt ?? createdAt,
                completedAt: settlesTurn ? updatedAt : previous?.completedAt,
                assistantMessageId: id
            )
            checkpoints = checkpoints.map { checkpoint in
                guard checkpoint.turnId == turnID,
                      checkpoint.assistantMessageId == nil else { return checkpoint }
                return CheckpointSummary(
                    turnId: checkpoint.turnId,
                    checkpointTurnCount: checkpoint.checkpointTurnCount,
                    checkpointRef: checkpoint.checkpointRef,
                    status: checkpoint.status,
                    files: checkpoint.files,
                    assistantMessageId: id,
                    completedAt: checkpoint.completedAt
                )
            }
        }
        return .updated(
            replacing(
                thread,
                messages: messages,
                checkpoints: checkpoints,
                latestTurn: latestTurn,
                updatedAt: occurredAt
            )
        )
    }

    private static func reduceActivity(
        payload: JSONValue,
        occurredAt: String,
        thread: OrchestrationThread,
        renderMutation: inout NativeDetailRenderMutation
    ) -> NativeThreadDetailReductionResult {
        guard let raw = payload["activity"],
              let activity = try? raw.decode(OrchestrationActivity.self) else {
            return .refresh
        }
        renderMutation = .activity(activity)
        return .updated(
            // The render cache owns the event tail. Keeping the authoritative
            // snapshot array shared avoids copying tens of thousands of old
            // activities for each append; a resnapshot rebuilds after recovery.
            replacing(thread, updatedAt: occurredAt)
        )
    }

    private static func reduceSession(
        payload: JSONValue,
        occurredAt: String,
        thread: OrchestrationThread
    ) -> NativeThreadDetailReductionResult {
        guard let raw = payload["session"],
              let session = try? raw.decode(OrchestrationSession.self) else {
            return .refresh
        }
        var latestTurn = thread.latestTurn
        if session.status == "running", let activeTurnID = session.activeTurnId {
            let previous = latestTurn?.turnId == activeTurnID ? latestTurn : nil
            latestTurn = OrchestrationLatestTurn(
                turnId: activeTurnID,
                state: "running",
                requestedAt: previous?.requestedAt ?? session.updatedAt,
                startedAt: previous?.startedAt ?? session.updatedAt,
                completedAt: nil,
                assistantMessageId: previous?.assistantMessageId
            )
        } else if latestTurn?.state == "running",
                  let settledState = settledTurnState(session.status),
                  let current = latestTurn {
            latestTurn = OrchestrationLatestTurn(
                turnId: current.turnId,
                state: settledState,
                requestedAt: current.requestedAt,
                startedAt: current.startedAt,
                completedAt: session.updatedAt,
                assistantMessageId: current.assistantMessageId
            )
        }
        return .updated(
            replacing(
                thread,
                latestTurn: latestTurn,
                session: session,
                updatedAt: occurredAt
            )
        )
    }

    private static func reduceTurnDiff(
        payload: JSONValue,
        occurredAt: String,
        thread: OrchestrationThread
    ) -> NativeThreadDetailReductionResult {
        guard let turnID = payload["turnId"]?.stringValue,
              let turnCount = intValue(payload["checkpointTurnCount"]),
              let checkpointRef = payload["checkpointRef"]?.stringValue,
              let status = payload["status"]?.stringValue,
              let completedAt = payload["completedAt"]?.stringValue,
              let rawFiles = payload["files"],
              let files = try? rawFiles.decode([CheckpointFile].self) else {
            return .refresh
        }
        let assistantMessageID = payload["assistantMessageId"]?.stringValue
        let checkpoint = CheckpointSummary(
            turnId: turnID,
            checkpointTurnCount: turnCount,
            checkpointRef: checkpointRef,
            status: status,
            files: files,
            assistantMessageId: assistantMessageID,
            completedAt: completedAt
        )
        if let existing = thread.checkpoints.first(where: { $0.turnId == turnID }),
           existing.status != "missing", status == "missing" {
            return .unchanged
        }
        var checkpoints = thread.checkpoints.filter { $0.turnId != turnID }
        checkpoints.append(checkpoint)
        checkpoints.sort { $0.checkpointTurnCount < $1.checkpointTurnCount }

        var latestTurn = thread.latestTurn
        let stillRunning = thread.session?.status == "running"
            && thread.session?.activeTurnId == turnID
        if !stillRunning, latestTurn == nil || latestTurn?.turnId == turnID {
            latestTurn = OrchestrationLatestTurn(
                turnId: turnID,
                state: status == "error" ? "error" : "completed",
                requestedAt: latestTurn?.requestedAt ?? completedAt,
                startedAt: latestTurn?.startedAt ?? completedAt,
                completedAt: completedAt,
                assistantMessageId: assistantMessageID
            )
        }
        return .updated(
            replacing(
                thread,
                checkpoints: checkpoints,
                latestTurn: latestTurn,
                updatedAt: occurredAt
            )
        )
    }

    private struct SettlementReplacement {
        let override: String?
        let settledAt: String?
        let unsettledAt: String?
    }

    private static func replacing(
        _ thread: OrchestrationThread,
        messages: [OrchestrationMessage]? = nil,
        activities: [OrchestrationActivity]? = nil,
        checkpoints: [CheckpointSummary]? = nil,
        latestTurn: OrchestrationLatestTurn? = nil,
        session: OrchestrationSession? = nil,
        settlement: SettlementReplacement? = nil,
        updatedAt: String
    ) -> OrchestrationThread {
        OrchestrationThread(
            relationshipToParent: thread.relationshipToParent,
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            linkedPullRequest: thread.linkedPullRequest,
            pullRequests: thread.pullRequests,
            branchPullRequest: thread.branchPullRequest,
            latestTurn: latestTurn ?? thread.latestTurn,
            createdAt: thread.createdAt,
            updatedAt: updatedAt,
            archivedAt: thread.archivedAt,
            settledOverride: settlement == nil ? thread.settledOverride : settlement?.override,
            settledAt: settlement == nil ? thread.settledAt : settlement?.settledAt,
            unsettledAt: settlement == nil ? thread.unsettledAt : settlement?.unsettledAt,
            activeOrderKey: thread.activeOrderKey,
            autoSettleDisabledAt: thread.autoSettleDisabledAt,
            snoozedUntil: thread.snoozedUntil,
            snoozedAt: thread.snoozedAt,
            pinnedAt: thread.pinnedAt,
            pinOrderKey: thread.pinOrderKey,
            titleRegeneration: thread.titleRegeneration,
            deletedAt: thread.deletedAt,
            messages: messages ?? thread.messages,
            activities: activities ?? thread.activities,
            checkpoints: checkpoints ?? thread.checkpoints,
            session: session ?? thread.session
        )
    }

    private static func settledTurnState(_ status: String) -> String? {
        switch status {
        case "idle", "ready": "completed"
        case "error": "error"
        case "interrupted", "stopped": "interrupted"
        default: nil
        }
    }

    private static func intValue(_ value: JSONValue?) -> Int? {
        guard case let .number(number)? = value else { return nil }
        return Int(exactly: number)
    }

    private static func boolValue(_ value: JSONValue?) -> Bool? {
        guard case let .bool(boolean)? = value else { return nil }
        return boolean
    }
}

/// Shell metadata often changes for only one row. Keep the mapped values for
/// equal source records, including across a fresh HTTP snapshot or a reorder.
struct NativeShellRowProjection<Source: Identifiable & Equatable, Row> {
    private var sources: [Source] = []
    private var rows: [Row] = []

    mutating func map(_ next: [Source], transform: (Source) -> Row) -> [Row] {
        guard next != sources else { return rows }
        var previousIndexByID: [Source.ID: Int]?
        let nextRows = next.enumerated().map { index, source in
            if index < sources.count, sources[index].id == source.id {
                return sources[index] == source ? rows[index] : transform(source)
            }
            // Most deltas keep order. Only build the lookup after an insert,
            // removal, or reorder moves a row to a different position.
            if previousIndexByID == nil {
                previousIndexByID = sources.enumerated().reduce(into: [:]) {
                    $0[$1.element.id] = $1.offset
                }
            }
            if let oldIndex = previousIndexByID?[source.id], sources[oldIndex] == source {
                return rows[oldIndex]
            }
            return transform(source)
        }
        sources = next
        rows = nextRows
        return nextRows
    }
}

struct NativeShellProjection {
    private struct ThreadContext: Equatable {
        let environment: Environment
        let providerNames: [String: String]
    }

    private var threadContext: ThreadContext?
    private var threads = NativeShellRowProjection<OrchestrationThreadShell, FeatureThread>()
    private var projectSettings: ServerSettingsSnapshot?
    private var disabledProjectProviderIDs: Set<String> = []
    private var supportsProjectSettings = false
    private var projects = NativeShellRowProjection<OrchestrationProject, FeatureProject>()

    mutating func mapProjects(
        _ source: [OrchestrationProject],
        settings: ServerSettingsSnapshot,
        disabledProviderIDs: Set<String> = [],
        supportsProjectSettings: Bool = false,
        transform: (OrchestrationProject) -> FeatureProject
    ) -> [FeatureProject] {
        if projectSettings != settings
            || disabledProjectProviderIDs != disabledProviderIDs || self.supportsProjectSettings != supportsProjectSettings {
            projects = NativeShellRowProjection()
            projectSettings = settings
            disabledProjectProviderIDs = disabledProviderIDs
            self.supportsProjectSettings = supportsProjectSettings
        }
        return projects.map(source, transform: transform)
    }

    mutating func mapThreads(
        _ source: [OrchestrationThreadShell],
        environment: Environment,
        providerNames: [String: String],
        transform: (OrchestrationThreadShell) -> FeatureThread
    ) -> [FeatureThread] {
        let context = ThreadContext(environment: environment, providerNames: providerNames)
        if threadContext != context {
            threads = NativeShellRowProjection()
            threadContext = context
        }
        return threads.map(source, transform: transform)
    }
}

private struct NativeShellMembership: Equatable {
    let environmentID: String
    let projectIDs: [String]
    let threadIDs: [String]
    let archivedIDs: [String]
}

private struct AttachmentCacheKey: Hashable {
    let environmentID: String
    let attachmentID: String
}

private struct CachedAttachmentURL {
    let url: URL
    let expiresAt: Date
}

private struct EnvironmentShellLoad: Sendable {
    let environment: Environment
    let client: T3Client
    let shell: OrchestrationShellSnapshot?
    let config: ServerConfigSnapshot?
    var session: AuthSessionState? = nil
    /// The server answered and refused the saved credential.
    var credentialRejected = false
    var failureDetail: String?
    var preferenceGeneration = 0
    var cacheLease: ClientReadCache.Lease?
}

private struct EntityWireOwner: Hashable {
    let environmentID: String
    let wireID: String
}

private struct NativeProjectRoute {
    let uiID: String
    let wireID: String
    let environmentID: String
    let client: T3Client
}

private struct PendingOlderThreadPage {
    let snapshot: OrchestrationThreadDetailSnapshot
    let epoch: Int
    let threadID: String
    let environmentID: String
}

struct NativeThreadRoute {
    let uiID: String
    let wireID: String
    let environmentID: String
    let client: T3Client
}

private struct NativeThreadResumeState {
    let client: T3Client
    let thread: OrchestrationThread
    let sequence: Int
    let page: FeatureThreadPage?
    var wasSynchronized: Bool
    let connectionID: UUID?
}

private struct NativeSourceControlMonitorKey: Hashable {
    let environmentID: String
    let workingDirectory: String
    let intent: FeatureSourceControlMonitorIntent
}

@MainActor
private final class NativeSourceControlMonitor {
    let id = UUID()
    var latestStatus: FeatureSourceControlStatus?
    var continuations: [UUID: AsyncStream<FeatureSourceControlStatus>.Continuation] = [:]
    var task: Task<Void, Never>?
}

private struct ProvisionalThreadRoute: Equatable {
    let environmentID: String
    let wireID: String
}

private struct PendingRequestRoute {
    let threadID: String
    let wireID: String
}

private struct CommandIdentity: Equatable {
    let commandID: String
    let messageID: String
    let createdAt: String

    init(
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString,
        createdAt: String = OrchestrationCommands.now()
    ) {
        self.commandID = commandID
        self.messageID = messageID
        self.createdAt = createdAt
    }
}

private struct BootstrapSubmissionSignature: Equatable {
    let projectID: String
    let prompt: String
    let model: ModelSelection
    let runtimeMode: RuntimeMode
    let interactionMode: InteractionMode
    let workspaceMode: FeatureWorkspaceMode
    let branch: String?
    let worktreePath: String?
    let startFromOrigin: Bool
    let attachments: [FeatureUploadAttachment]
    var context: OrchestrationMessageContext? = nil
}

private struct PendingBootstrapSubmission {
    let signature: BootstrapSubmissionSignature
    let threadID: String
    let identity: CommandIdentity
    let worktreeBranchName: String?
}

private struct ThreadCreationSignature: Equatable {
    let projectID: String
    let title: String
    let model: ModelSelection
}

private struct PendingThreadCreation {
    let signature: ThreadCreationSignature
    let threadID: String
}

private struct TurnSubmissionSignature: Equatable {
    let text: String
    let model: ModelSelection?
    let runtimeMode: RuntimeMode
    let interactionMode: InteractionMode
    let attachments: [FeatureUploadAttachment]
    var context: OrchestrationMessageContext? = nil
    var delivery: FeatureMessageDelivery = .auto
}

private struct PendingTurnSubmission {
    let signature: TurnSubmissionSignature
    let identity: CommandIdentity
}

private enum NativeFeatureClientError: LocalizedError {
    case notConnected
    case environmentNotFound
    case projectNotFound
    case threadNotFound
    case threadSnapshotOutdated
    case workspaceNotFound
    case approvalNotFound
    case inputRequestNotFound
    case invalidProjectPath
    case branchRequired
    case deviceSessionNotFound
    case currentDeviceUnknown
    case tooManyAttachments
    case invalidAutomaticSettlementDays
    case remoteStatusUnavailable
    case invalidPullRequestLink

    var errorDescription: String? {
        switch self {
        case .invalidPullRequestLink:
            "Use a supported pull request URL. Older servers need a project for its repository."
        case .notConnected: "Connect to a T3 environment first."
        case .environmentNotFound: "That T3 environment is no longer available."
        case .projectNotFound: "The selected project is no longer available."
        case .threadNotFound: "The selected thread is no longer available."
        case .threadSnapshotOutdated: "The computer has not finished updating this thread. Try again."
        case .workspaceNotFound: "The thread workspace is no longer available."
        case .approvalNotFound: "The approval request is no longer active."
        case .inputRequestNotFound: "The input request is no longer active."
        case .invalidProjectPath: "Enter a workspace path on the connected environment."
        case .branchRequired: "Choose a base branch for the new worktree."
        case .deviceSessionNotFound: "That device session is no longer active."
        case .currentDeviceUnknown: "This installation has not registered for device access yet."
        case .tooManyAttachments: "You can attach up to 100 files per message."
        case .invalidAutomaticSettlementDays: "Choose a value from 1 to 90 days."
        case .remoteStatusUnavailable:
            "Couldn't check the remote status. Try reloading."
        }
    }
}

extension NativeFeatureClient: FeatureThreadContentSearching {
    func searchThreadContent(query: String, environmentIDs: [String]) async throws -> [FeatureThreadContentMatch] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (2...200).contains(query.utf16.count) else { return [] }
        let generation = environmentGeneration
        let enabled = Set(latestSnapshot?.environments.filter(\.isEnabled).map(\.id) ?? [])
        return await FeatureThreadSearchFanout.search(
            environmentIDs: environmentIDs.filter { enabled.contains($0) }
        ) { [self] environmentID in
            guard let client = environmentClients[environmentID],
                  await client.liveConnectionActive(),
                  isKnownClient(client, environmentID: environmentID, generation: generation) else {
                return []
            }
            let result = try await client.searchThreadContent(query: query)
            guard isKnownClient(client, environmentID: environmentID, generation: generation),
                  latestSnapshot?.environments.contains(where: { $0.id == environmentID && $0.isEnabled }) == true else {
                throw CancellationError()
            }
            return result.featureMatches(environmentID: environmentID)
        }
    }
}

extension NativeFeatureClient: FeatureSavedConnectionEditing {
    @discardableResult
    func editSavedConnection(
        environmentID: String, label: String, endpoint: String
    ) async throws -> FeatureSavedConnectionEditResult {
        guard let environment = try await runtime.environments().first(where: { $0.id == environmentID }),
              environment.kind == .bearer else { throw SavedConnectionEditError.unsupportedConnection }
        guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw SavedConnectionEditError.emptyLabel
        }
        let httpURL = try PairingURL.httpBaseURL(for: endpoint)
        var socket = URLComponents(url: httpURL, resolvingAgainstBaseURL: false)!
        socket.scheme = httpURL.scheme == "https" ? "wss" : "ws"
        guard let socketURL = socket.url else { throw PairingURLError.invalidURL }
        try Task.checkCancellation()
        if environment.hasSameConnectionEndpoint(httpBaseURL: httpURL, webSocketBaseURL: socketURL) {
            let updated = try await runtime.environmentStore.renameSavedConnection(expected: environment, label: label)
            if activeEnvironment?.id == environmentID { activeEnvironment?.label = updated.label }
            if var snapshot = latestSnapshot {
                if let index = snapshot.environments.firstIndex(where: { $0.id == environmentID }) {
                    snapshot.environments[index].name = updated.label
                    if snapshot.environments[index].isActive { snapshot.connection.environmentName = updated.label }
                }
                for index in snapshot.threads.indices where snapshot.threads[index].environmentID == environmentID {
                    snapshot.threads[index].environmentName = updated.label
                }
                publish(snapshot)
            }
            return .updatedLabel
        }
        guard let credential = try await runtime.credentialStore.credential(for: environment.credentialID),
              credential.authorizationMethod == .bearer, !credential.accessToken.isEmpty else {
            throw HTTPError.missingCredential
        }
        let descriptor = try await runtime.descriptor(at: httpURL)
        try Task.checkCancellation()
        let updated = try await runtime.environmentStore.editSavedConnection(
            expected: environment, label: label, httpBaseURL: httpURL,
            webSocketBaseURL: socketURL, descriptor: descriptor
        )
        if activeEnvironment?.id == environmentID { await clearActiveEnvironment() }
        if let oldClient = environmentClients.removeValue(forKey: environmentID) {
            await oldClient.disconnect()
        }
        shellsByEnvironmentID[environmentID] = nil
        shellProjectionCache[environmentID] = nil
        serverConfigsByEnvironmentID[environmentID] = nil
        orchestrationPreferenceGenerations[environmentID, default: 0] &+= 1
        try await clearClientStorage(environmentID: environmentID)
        discardRestoredEnvironment(environmentID)
        let replacement = await runtime.client(for: updated)
        environmentClients[environmentID] = replacement
        if updated.isEnabled { await replacement.reconnect() }
        return .updatedEndpoint
    }
}

extension NativeFeatureClient: FeatureLiveActivitySetup {
    func setUpLiveActivityUpdates(
        enabled: Bool, previousEnabled: Bool, environmentIDs: [String]
    ) async throws {
        let settings = loadSettings()
        guard settings.liveActivitiesEnabled == enabled else {
            throw T3ConnectRelayError.invalidConfiguration("Live Activity preferences changed. Retry setup.")
        }
        try await PlatformCloudDeliveryCoordinator.shared.setUpLiveActivityUpdates(
            controller: hasMatchingT3ConnectController ? t3ConnectController : nil,
            environments: { [runtime] in
                let saved = try await runtime.environments()
                var selected: [T3ConnectLocalEnvironment] = []
                var seen: Set<String> = []
                for id in environmentIDs where seen.insert(id).inserted {
                    guard let environment = saved.first(where: { $0.id == id }),
                          let credential = try await runtime.credentialStore.credential(for: environment.credentialID) else {
                        throw HTTPError.missingCredential
                    }
                    selected.append(try T3ConnectLocalEnvironment(environment: environment, credential: credential))
                }
                return selected
            }, settings: settings,
            enabled: enabled, previousEnabled: previousEnabled
        )
    }
}

extension NativeFeatureClient {
    private func prepareReadCacheLeases(_ environments: [Environment]) async {
        let epoch = readCacheEpoch
        for environment in environments where !revokedCacheEnvironmentIDs.contains(environment.id) {
            let scope = ClientReadCache.Scope(environment)
            if let previous = readCacheLeases[environment.id], previous.scope != scope {
                discardRestoredEnvironment(environment.id)
                readCacheLeases[environment.id] = nil
                try? await projectFaviconStore.clear(environmentID: environment.id)
            }
            guard let lease = try? await clientReadCache.activate(scope), epoch == readCacheEpoch else { continue }
            readCacheLeases[environment.id] = lease
        }
    }

    private func restoreClientReadCache(_ environments: [Environment]) async {
        let epoch = readCacheEpoch
        try? await clientReadCache.retainEnvironments(environments.map(ClientReadCache.Scope.init))
        guard epoch == readCacheEpoch else { return }
        await prepareReadCacheLeases(environments)
        for environment in environments where environment.isEnabled && shellsByEnvironmentID[environment.id] == nil {
            guard let lease = readCacheLeases[environment.id],
                  let shell = await clientReadCache.shell(for: lease), epoch == readCacheEpoch,
                  readCacheLeases[environment.id] == lease else { continue }
            environmentClients[environment.id] = await runtime.client(for: environment)
            guard epoch == readCacheEpoch else { return }
            shellsByEnvironmentID[environment.id] = shell
            orchestrationVersions[environment.id] = shell.orchestrationProtocolVersion ?? 1
            restoredShellEnvironmentIDs.insert(environment.id)
            environmentConnectionStates[environment.id] = .disconnected
            environmentConnectionDetails[environment.id] = "Offline. Showing saved lists and history."
        }
        latestShell = activeEnvironment.flatMap { shellsByEnvironmentID[$0.id] }
        rebuildEntityIndexes(environments)
    }

    private func saveReadShell(
        _ shell: OrchestrationShellSnapshot, environmentID: String, lease: ClientReadCache.Lease?
    ) {
        guard let lease, readCacheLeases[environmentID] == lease else { return }
        let previous = cacheWriteTask
        let cache = clientReadCache
        cacheWriteTask = Task {
            await previous?.value
            await cache.record(shell: shell, lease: lease)
        }
    }

    private func saveReadHistory(
        _ snapshot: OrchestrationThreadDetailSnapshot, environmentID: String, lease: ClientReadCache.Lease?
    ) {
        // The cache drops running threads anyway. Check here so streaming
        // updates do not queue a write task per item.
        guard let lease, readCacheLeases[environmentID] == lease,
              snapshot.thread.deletedAt != nil || ClientReadCache.isEligible(snapshot) else { return }
        let threadID = FeatureScopedID.thread(environmentID: environmentID, wireID: snapshot.thread.id)
        let expanded = expandedHistoryIDs.contains(threadID)
        let previous = cacheWriteTask
        let cache = clientReadCache
        cacheWriteTask = Task {
            await previous?.value
            await cache.record(history: snapshot, lease: lease, expanded: expanded)
        }
    }

    /// Waits for this client's queued mutations, then flushes its coalesced writes.
    /// Tests use this boundary instead of timers.
    func flushClientReadCache() async throws {
        await cacheWriteTask?.value
        try await clientReadCache.flush()
    }

    func clientStorageSummary() async throws -> FeatureClientStorageSummary {
        let environments = try await runtime.environments()
        let reads = await clientReadCache.summary()
        let icons = try await projectFaviconStore.storageSummary()
        let ids = Set(environments.map(\.id)).union(reads.map(\.environmentID)).union(icons.keys)
        return FeatureClientStorageSummary(environments: ids.map { id in
            let read = reads.first { $0.environmentID == id }
            let icon = icons[id]
            return FeatureEnvironmentStorageSummary(
                environmentID: id, label: environments.first { $0.id == id }?.label ?? "Removed environment",
                shellCount: read?.shellCount ?? 0, threadCount: read?.threadCount ?? 0,
                faviconCount: icon?.count ?? 0, totalBytes: (read?.bytes ?? 0) + (icon?.bytes ?? 0)
            )
        }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending })
    }

    func clearClientStorage(environmentID: String?) async throws {
        readCacheEpoch &+= 1
        let affected = environmentID.map { Set([$0]) } ?? Set(readCacheLeases.keys)
        for id in affected { readCacheLeases[id] = nil }
        for (key, task) in projectFaviconRefreshTasks where environmentID == nil || key.environmentID == environmentID {
            task.cancel()
            projectFaviconRefreshTasks[key] = nil
        }
        // Both stores revoke their write tokens before removing any file. Already
        // loaded views may stay visible; none of those values are saved again here.
        var failure: (any Error)?
        do { try await clientReadCache.clear(environmentID: environmentID) } catch { failure = error }
        do { try await projectFaviconStore.clear(environmentID: environmentID) } catch { failure = failure ?? error }
        let saved = (try? await runtime.environments()) ?? []
        await prepareReadCacheLeases(saved.filter { environmentID == nil || $0.id == environmentID })
        if let failure { throw failure }
    }

    private func discardRestoredEnvironment(_ environmentID: String) {
        restoredShellEnvironmentIDs.remove(environmentID)
        for id in threadEnvironmentIDs.keys where threadEnvironmentIDs[id] == environmentID {
            restoredDetailIDs.remove(id)
            threadResumeStates[id] = nil
            latestDetails[id] = nil
            detailRenderCaches[id] = nil
        }
        approvalRoutes = approvalRoutes.filter { threadEnvironmentIDs[$0.value.threadID] != environmentID }
        inputRoutes = inputRoutes.filter { threadEnvironmentIDs[$0.value.threadID] != environmentID }
        shellsByEnvironmentID[environmentID] = nil
        shellProjectionCache[environmentID] = nil
        archivedThreadsByEnvironmentID[environmentID] = nil
        archivedShellThreadsByEnvironmentID[environmentID] = nil
        if activeEnvironment?.id == environmentID { latestShell = nil }
        if activeThreadEnvironmentID == environmentID {
            resetDetailStream()
            resetDetailRefresh()
            activeRawThread = nil
            activeThreadSequence = nil
        }
    }
}

// Route changes keep environment/cache identity and never repeat an operation.
extension NativeFeatureClient: FeatureEnvironmentRoutesManaging {
    func managedOnlyEnvironmentIDs() async throws -> [String] {
        try await runtime.environments().filter { $0.hasManagedRoutes && $0.removingManagedRoutes() == nil }.map(\.id)
    }

    func removeManagedEnvironmentRoutes() async throws {
            let previous = try await runtime.environments()
            let remaining = try await runtime.removeManagedRoutes()
            let remainingIDs = Set(remaining.map(\.id))
            for environment in previous where environment.hasManagedRoutes {
                environmentPermissions[environment.id] = nil
                if remainingIDs.contains(environment.id) {
                    guard let saved = remaining.first(where: { $0.id == environment.id }) else { continue }
                    let replacement = await runtime.client(for: saved)
                    _ = await installResolvedRoute(replacement)
                } else {
                    revokedCacheEnvironmentIDs.insert(environment.id)
                    orchestrationPreferenceGenerations[environment.id, default: 0] &+= 1
                    try? await clearClientStorage(environmentID: environment.id)
                    discardRestoredEnvironment(environment.id)
                    environmentClients[environment.id] = nil
                    if activeEnvironment?.id == environment.id { await clearActiveEnvironment(disconnectClient: false) }
                }
            }
        await publishRouteChange()
    }

    func environmentRoutes(environmentID: String) async throws -> FeatureEnvironmentRoutes {
        guard let environment = try await runtime.selectedEnvironment(id: environmentID) else {
            throw EnvironmentRouteError.missingEnvironment
        }
        let isConnected = environmentConnectionStates[environmentID] == .connected
        return FeatureEnvironmentRoutes(routes: environment.routes, activeRouteID: isConnected ? environment.activeRouteID : nil)
    }

    func addEnvironmentRoute(environmentID: String, pairingURL: String) async throws {
        let saved = try await runtime.addRoute(environmentID: environmentID, pairingURL: pairingURL)
        let replacement = await runtime.client(for: saved)
        _ = await installResolvedRoute(replacement)
        await publishRouteChange()
    }

    func reorderEnvironmentRoutes(environmentID: String, routeIDs: [String]) async throws {
        try await runtime.reorderRoutes(environmentID: environmentID, routeIDs: routeIDs)
        routeRecoveryAttempts[environmentID] = nil
        _ = await recoverEnvironmentRoute(environmentID: environmentID, promote: true, forceCheck: true)
        await publishRouteChange()
    }

    func removeEnvironmentRoute(environmentID: String, routeID: String) async throws {
        let saved = try await runtime.removeRoute(environmentID: environmentID, routeID: routeID)
        let replacement = await runtime.client(for: saved)
        _ = await installResolvedRoute(replacement)
        await publishRouteChange()
    }

    private func publishRouteChange() async {
        guard let environments = try? await runtime.environments() else { return }
        if let environment = activeEnvironment {
            publish(makeSnapshot(
                environments: environments, activeEnvironment: environment,
                connectionState: environmentConnectionStates[environment.id] ?? .disconnected,
                connectionDetail: environmentConnectionDetails[environment.id]
            ))
        } else {
            publish(disconnectedSnapshot(environments: environments))
        }
    }

    private func routeRejectionIsFinal(environmentID: String) -> Bool {
        routeRecoveryRejected[environmentID] ?? ((environmentClients[environmentID]?.environment.routes.count ?? 1) == 1)
    }

    /// Defer active switching until snapshot callers finish using their local
    /// client references. Passive reads only resolve on failure and use HTTP.
    @discardableResult
    private func recoverEnvironmentRoute(
        environmentID: String, promote: Bool = false, forceCheck: Bool = false
    ) async -> Bool {
        guard routeSnapshotLoads == 0, !Task.isCancelled,
              let environment = try? await runtime.selectedEnvironment(id: environmentID),
              environment.isEnabled, environment.routes.count > 1 else { return false }
        let now = Date()
        if !forceCheck, let last = routeRecoveryAttempts[environmentID], now.timeIntervalSince(last) < 15 { return false }
        routeRecoveryAttempts[environmentID] = now
        let generation = environmentGeneration
        let original = environmentClients[environmentID]
        do {
            let replacement = try await runtime.resolveClient(for: environment, promote: promote, forceCheck: forceCheck)
            guard !Task.isCancelled, generation == environmentGeneration,
                  environmentClients[environmentID] === original else { return false }
            routeRecoveryRejected[environmentID] = nil
            return await installResolvedRoute(replacement)
        } catch {
            routeRecoveryRejected[environmentID] = error.isRejectedAuthorization
            // One unreachable direct route must not revoke its shared token or
            // replace a working fallback. The existing read loop reports failure.
            return false
        }
    }

    /// Bind every URL consumer before restarting subscriptions. Keep thread
    /// history and drafts, but discard origin-bound assets and session grants.
    @discardableResult
    private func installResolvedRoute(_ replacement: T3Client) async -> Bool {
        let environment = replacement.environment
        let id = environment.id
        guard environmentClients[id] !== replacement else {
            if activeEnvironment?.id == id { activeEnvironment = environment }
            return false
        }
        let previous = environmentClients[id]
        let session: AuthSessionState?
        if environment.isEnabled { session = try? await replacement.authSession() }
        else { session = nil }
        guard environmentClients[id] === previous else { return false }
        let isActive = activeEnvironment?.id == id
        let selectedThreadID = activeThreadID
        if isActive {
            retainActiveThread()
            environmentGeneration &+= 1
            pollingTask?.cancel()
            fallbackPollingTask?.cancel()
            configurationTask?.cancel()
            aggregateRefreshTask?.cancel()
            archivedRefreshTask?.cancel()
            shellPublishTask?.cancel()
            activeEnvironment = environment
            client = replacement
            latestShell = shellsByEnvironmentID[id]
            lastShellEventAt = nil
        }
        environmentClients[id] = replacement
        orchestrationPreferenceGenerations[id, default: 0] &+= 1
        environmentPermissions[id] = nil
        attachmentURLs.removeAll()
        terminalSnapshots.removeAll()
        let resetsDetail = isActive || activeThreadEnvironmentID == id
        if resetsDetail {
            resetDetailRefresh()
            resetDetailStream()
            detailWasSynchronized = false
            activeDetailConnectionID = nil
        }
        environmentPermissions[id] = EnvironmentPermissionState(session: session, serverAuth: serverConfigsByEnvironmentID[id]?.auth)
        environmentConnectionStates[id] = session?.authenticated == true ? .connected : .disconnected
        environmentConnectionDetails[id] = nil
        if isActive, environment.isEnabled {
            startAggregateRefresh(replacement)
            startPolling(replacement)
        }
        if resetsDetail, let selectedThreadID, activeThreadID == selectedThreadID,
           let route = try? threadRoute(for: selectedThreadID), environment.isEnabled {
            startDetailStream(route)
        }
        return true
    }
}
