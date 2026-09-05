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

private struct T3ConnectManagedCleanupError: LocalizedError {
    let failureCount: Int

    var errorDescription: String? {
        "Couldn’t remove \(failureCount) managed T3 Connect "
            + (failureCount == 1 ? "environment." : "environments.")
    }
}

/// Composes the transport-focused Core layer with the UI-focused Features layer.
@MainActor
final class NativeFeatureClient: FeatureClient, FeatureDeviceManaging,
    FeatureProjectCreationClient, FeatureWorkspaceAssetResolving,
    FeatureFeedbackSubmitting, T3ConnectCapable
{
    private static let maximumRetainedThreadDetails = 6
    private static let t3ConnectLogger = Logger(
        subsystem: "codes.t3.swift-ios",
        category: "T3Connect"
    )
    private static let initialThreadUserTurnLimit = 10
    private static let olderThreadPageUserTurnLimit = 20
    private static let projectFaviconRefreshInterval: TimeInterval = 15 * 60
    private static let projectFaviconFallbackMarker = "project-favicon-missing"

    private let runtime: EnvironmentRuntime
    let t3ConnectController: T3ConnectController
    private let t3ConnectDeviceManager: any T3ConnectDeviceManaging
    private let hasMatchingT3ConnectController: Bool
    private let settingsStore: UserDefaults
    private let projectFaviconStore: FeatureProjectFaviconStore
    private let fallbackPollingInitialDelay: Duration
    private let fallbackPollingInterval: Duration
    private let aggregateRefreshInterval: Duration
    private let environmentShellTimeoutInterval: TimeInterval
    private let threadSnapshotTimeoutInterval: TimeInterval
    private let catchUpDelay: @Sendable () async throws -> Void
    private let aggregateEnvironmentLoader: @Sendable (EnvironmentRuntime) async throws -> [Environment]
    private let stream: AsyncStream<FeatureEvent>
    private let continuation: AsyncStream<FeatureEvent>.Continuation

    private var activeEnvironment: Environment?
    private var client: T3Client?
    private var latestShell: OrchestrationShellSnapshot?
    private var environmentClients: [String: T3Client] = [:]
    private var shellsByEnvironmentID: [String: OrchestrationShellSnapshot] = [:]
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
    private var latestServerConfig: ServerConfigSnapshot?
    private var serverConfigsByEnvironmentID: [String: ServerConfigSnapshot] = [:]
    private var latestSnapshot: FeatureSnapshot?
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
    private var attachmentHydrationTasks: [
        String: (id: UUID, task: Task<Void, Never>)
    ] = [:]
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
    private var environmentGeneration = 0
    private var lastShellEventAt: Date?
    private var activeRawThread: OrchestrationThread?
    private var activeThreadSequence: Int?
    private var activeThreadPage: FeatureThreadPage?
    private var threadHistoryEpoch = 0
    private var detailSnapshotRequiredAfterEpoch: Int?
    private var pendingOlderThreadPage: PendingOlderThreadPage?

    init(
        runtime: EnvironmentRuntime? = nil,
        t3ConnectController: T3ConnectController? = nil,
        t3ConnectDeviceManager: (any T3ConnectDeviceManaging)? = nil,
        settingsStore: UserDefaults = .standard,
        projectFaviconStore: FeatureProjectFaviconStore = FeatureProjectFaviconStore(),
        fallbackPollingInitialDelay: Duration = .seconds(3),
        fallbackPollingInterval: Duration = .seconds(2),
        aggregateRefreshInterval: Duration = .seconds(20),
        environmentShellTimeoutInterval: TimeInterval = 6,
        threadSnapshotTimeoutInterval: TimeInterval = 8,
        catchUpDelay: @escaping @Sendable () async throws -> Void = {
            try await Task.sleep(for: .seconds(2))
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
        self.projectFaviconStore = projectFaviconStore
        self.fallbackPollingInitialDelay = fallbackPollingInitialDelay
        self.fallbackPollingInterval = fallbackPollingInterval
        self.aggregateRefreshInterval = aggregateRefreshInterval
        self.environmentShellTimeoutInterval = environmentShellTimeoutInterval
        self.threadSnapshotTimeoutInterval = threadSnapshotTimeoutInterval
        self.catchUpDelay = catchUpDelay
        self.aggregateEnvironmentLoader = aggregateEnvironmentLoader
        let pair = AsyncStream<FeatureEvent>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
    }

    deinit {
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
        attachmentHydrationTasks.values.forEach { $0.task.cancel() }
        projectFaviconRefreshTasks.values.forEach { $0.cancel() }
        continuation.finish()
    }

    func initialSnapshot() async throws -> FeatureSnapshot {
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
        let environment = activeClient.environment

        await adoptEnvironment(environment, client: activeClient)
        let generation = environmentGeneration
        let loads = await loadEnvironmentShells(environments.filter(\.isEnabled))
        guard isCurrentSession(client: activeClient, generation: generation) else {
            throw CancellationError()
        }
        reconcileEnvironmentLoads(loads, savedEnvironments: environments)
        latestShell = shellsByEnvironmentID[environment.id]
        startPolling(activeClient)
        let activeIsReachable = loads.contains {
            $0.environment.id == environment.id && $0.shell != nil
        }
        if activeIsReachable {
            scheduleArchivedRefresh(client: activeClient, environment: environment)
        }
        let snapshot = makeSnapshot(
            environments: environments,
            activeEnvironment: environment,
            connectionState: activeIsReachable ? .connected : .disconnected,
            connectionDetail: activeIsReachable ? nil : "That server is currently unreachable."
        )
        latestSnapshot = snapshot
        return snapshot
    }

    func resumeAfterBackground(reconnect: Bool) async {
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
        let environments = try await runtime.environments()
        guard let activeClient = try await runtime.activeClient() else {
            return disconnectedSnapshot(environments: environments)
        }
        let environment = activeClient.environment
        let generation = environmentGeneration
        let loads = await loadEnvironmentShells(environments.filter(\.isEnabled))
        guard let currentClient = try await runtime.activeClient(),
              currentClient === activeClient,
              generation == environmentGeneration else {
            throw CancellationError()
        }

        reconcileEnvironmentLoads(loads, savedEnvironments: environments)
        let activeIsReachable = loads.contains {
            $0.environment.id == environment.id && $0.shell != nil
        }
        let snapshot = makeSnapshot(
            environments: environments,
            activeEnvironment: environment,
            connectionState: activeIsReachable ? .connected : .disconnected,
            connectionDetail: activeIsReachable ? nil : "That server is currently unreachable."
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

        let environment = Environment(
            id: descriptor.environmentId,
            label: descriptor.label,
            httpBaseURL: httpBaseURL,
            webSocketBaseURL: webSocketBaseURL,
            kind: .managedDPoP,
            descriptor: descriptor
        )
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
        // Clear the account and relay-token cache even when Clerk's remote
        // sign-out fails, then revoke every locally minted managed credential.
        // Manual pairings are device-owned and deliberately survive sign-out.
        await t3ConnectController.signOut()
        do {
            let managedIDs = try await runtime.environments()
                .filter { $0.kind == .managedDPoP }
                .map(\.id)
            var failureCount = 0
            for id in managedIDs {
                var cleanupFailed = false
                do {
                    try await runtime.revokeCredential(id: id)
                } catch {
                    cleanupFailed = true
                    Self.t3ConnectLogger.error(
                        "Managed credential revocation failed: \(error.localizedDescription, privacy: .private)"
                    )
                }
                do {
                    try await removeEnvironment(id: id)
                    // `remove` retries credential deletion, so its success
                    // supersedes an earlier revocation error.
                    cleanupFailed = false
                } catch {
                    cleanupFailed = true
                    Self.t3ConnectLogger.error(
                        "Managed environment removal failed: \(error.localizedDescription, privacy: .private)"
                    )
                }
                if cleanupFailed {
                    failureCount += 1
                }
            }
            guard failureCount == 0 else {
                throw T3ConnectManagedCleanupError(failureCount: failureCount)
            }
            Self.t3ConnectLogger.info("Cleared managed T3 Connect runtime state")
        } catch {
            Self.t3ConnectLogger.error(
                "Managed T3 Connect cleanup failed: \(error.localizedDescription, privacy: .private)"
            )
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
            serverConfigsByEnvironmentID[id] = nil
            providerCatalogCache[id] = nil
            archivedThreadsByEnvironmentID[id] = nil
            archivedShellThreadsByEnvironmentID[id] = nil
        }
    }

    func removeEnvironment(id: String) async throws {
        let removesActiveEnvironment = activeEnvironment?.id == id
        let environment = try await runtime.environments().first { $0.id == id }
        if environment?.kind == .managedDPoP {
            try await runtime.revokeCredential(id: id)
        }
        try await runtime.remove(id: id)
        if removesActiveEnvironment {
            await clearActiveEnvironment(disconnectClient: false)
        }
    }

    func disconnect() async {
        await clearActiveEnvironment()
    }

    func usageSummaries(_ input: UsageSummaryInput) async throws -> [FeatureEnvironmentUsage] {
        try await usageSummaries(input, refreshPricing: false)
    }

    func usageSummaries(_ input: UsageSummaryInput, refreshPricing: Bool) async throws -> [FeatureEnvironmentUsage] {
        var result: [FeatureEnvironmentUsage] = []
        for try await update in usageSummaryUpdates(input, refreshPricing: refreshPricing) {
            result = update
        }
        return result
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
        instanceID: String
    ) async throws -> ProviderConsumeResetCreditResult {
        guard try await runtime.environments().contains(where: { $0.id == environmentID && $0.isEnabled }) else {
            throw NativeFeatureClientError.environmentNotFound
        }
        let client = try await projectCreationClient(environmentID: environmentID)
        return try await client.consumeResetCredit(instanceID: instanceID)
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

    func pullRequestDetail(_ target: FeaturePullRequestTarget) async throws -> PullRequestDetail {
        try await projectCreationClient(environmentID: target.environmentID)
            .pullRequestDetail(target.reference)
    }

    func pullRequestActivity(_ target: FeaturePullRequestTarget) async throws
        -> PullRequestActivity
    {
        try await projectCreationClient(environmentID: target.environmentID)
            .pullRequestActivity(target.reference)
    }

    func pullRequestDiff(_ target: FeaturePullRequestTarget, cursor: String?) async throws
        -> PullRequestDiffResult
    {
        try await projectCreationClient(environmentID: target.environmentID).pullRequestDiff(
            PullRequestDiffInput(
                projectId: target.reference.projectId,
                repository: target.reference.repository,
                number: target.reference.number,
                cursor: cursor,
                commit: nil
            )
        )
    }

    func runPullRequestAction(
        _ target: FeaturePullRequestTarget,
        action: PullRequestAction,
        mergeMethod: PullRequestMergeMethod?,
        updateMethod: PullRequestUpdateMethod?
    ) async throws {
        try await projectCreationClient(environmentID: target.environmentID).runPullRequestAction(
            target.reference,
            action: action,
            mergeMethod: mergeMethod,
            updateMethod: updateMethod
        )
    }

    func updatePullRequest(
        _ target: FeaturePullRequestTarget,
        title: String?,
        body: String?
    ) async throws {
        try await projectCreationClient(environmentID: target.environmentID).updatePullRequest(
            target.reference,
            title: title,
            body: body
        )
    }

    func commentOnPullRequest(_ target: FeaturePullRequestTarget, body: String) async throws {
        try await projectCreationClient(environmentID: target.environmentID)
            .commentOnPullRequest(target.reference, body: body)
    }

    func submitPullRequestReview(
        _ target: FeaturePullRequestTarget,
        verdict: PullRequestReviewVerdict,
        body: String,
        comments: [PullRequestReviewCommentDraft]
    ) async throws {
        try await projectCreationClient(environmentID: target.environmentID)
            .submitPullRequestReview(
                target.reference,
                verdict: verdict,
                body: body,
                comments: comments
            )
    }

    func replyToPullRequestThread(
        _ target: FeaturePullRequestTarget,
        threadID: String,
        body: String
    ) async throws {
        try await projectCreationClient(environmentID: target.environmentID)
            .replyToPullRequestThread(target.reference, threadID: threadID, body: body)
    }

    func setPullRequestThreadResolved(
        _ target: FeaturePullRequestTarget,
        threadID: String,
        resolved: Bool
    ) async throws {
        try await projectCreationClient(environmentID: target.environmentID)
            .setPullRequestThreadResolved(
                target.reference,
                threadID: threadID,
                resolved: resolved
            )
    }

    func setPullRequestReaction(
        _ target: FeaturePullRequestTarget,
        subjectID: String?,
        content: PullRequestReactionContent,
        reacted: Bool
    ) async throws {
        try await projectCreationClient(environmentID: target.environmentID)
            .setPullRequestReaction(
                target.reference,
                subjectID: subjectID,
                content: content,
                reacted: reacted
            )
    }

    func pullRequestReviewerCandidates(_ target: FeaturePullRequestTarget) async throws
        -> PullRequestReviewerCandidateList
    {
        try await projectCreationClient(environmentID: target.environmentID)
            .pullRequestReviewerCandidates(target.reference)
    }

    func requestPullRequestReviewers(
        _ target: FeaturePullRequestTarget,
        reviewers: [PullRequestReviewerCandidate],
        requested: Bool
    ) async throws {
        try await projectCreationClient(environmentID: target.environmentID)
            .requestPullRequestReviewers(
                target.reference,
                reviewers: reviewers,
                requested: requested
            )
    }

    func invalidatePullRequests(_ target: FeaturePullRequestTarget?) async throws {
        if let target {
            try await projectCreationClient(environmentID: target.environmentID)
                .invalidatePullRequests(target.reference)
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
        environmentGeneration &+= 1
        resetDetailRefresh()
        resetDetailStream()
        attachmentHydrationTasks.values.forEach { $0.task.cancel() }
        attachmentHydrationTasks.removeAll()
        archivedRefreshTask?.cancel()
        archivedRefreshTask = nil
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = nil
        lastShellEventAt = nil
        latestServerConfig = nil
        if !preserveEnvironmentSnapshots {
            environmentClients.removeAll()
            shellsByEnvironmentID.removeAll()
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

    func addProject(environmentID: String, path: String) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await createProject(client: client, path: path)
    }

    func browseProjectFolders(
        environmentID: String,
        partialPath: String
    ) async throws -> FilesystemBrowseResult {
        let client = try await projectCreationClient(environmentID: environmentID)
        return try await client.browseFilesystem(partialPath: partialPath)
    }

    func workspaceAssetURL(threadID: String, path: String) async throws -> URL {
        let route = try threadRoute(for: threadID)
        return try await route.client.resolvedAssetURL(
            resource: .workspaceFile(threadID: route.wireID, path: path)
        )
    }

    func nativeAppIconURL(threadID: String, app: ToolNativeAppReference) async throws -> URL {
        let route = try threadRoute(for: threadID)
        return try await route.client.resolvedAssetURL(resource: .nativeAppIcon(app))
    }

    func mediaAssetURL(threadID: String, path: String) async throws -> URL {
        let route = try threadRoute(for: threadID)
        do {
            return try await route.client.resolvedAssetURL(
                resource: .mediaFile(threadID: route.wireID, path: path)
            )
        } catch let RPCError.remote(message)
            where message.localizedCaseInsensitiveContains("media-file")
                && (message.localizedCaseInsensitiveContains("schema")
                    || message.localizedCaseInsensitiveContains("unsupported")
                    || message.localizedCaseInsensitiveContains("unknown tag")
                    || message.localizedCaseInsensitiveContains("unknown discriminator")) {
            return try await route.client.resolvedAssetURL(
                resource: .workspaceFile(threadID: route.wireID, path: path)
            )
        }
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
        let cached = try? await projectFaviconStore.value(for: key)
        if let cached,
           Date.now.timeIntervalSince(cached.lastCheckedAt)
               < Self.projectFaviconRefreshInterval {
            return cached.data
        }
        if let task = projectFaviconRefreshTasks[key] {
            return await task.value
        }

        guard let client = environmentClients[environmentID] else {
            try? await projectFaviconStore.record(
                data: nil,
                revision: nil,
                for: key
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
                    try await store.record(data: nil, revision: nil, for: key)
                    return cached?.data
                }
                if cached?.revision == revision, cached?.data != nil {
                    try await store.record(data: nil, revision: revision, for: key)
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
                try await store.record(data: renderable, revision: revision, for: key)
                return renderable
            } catch {
                try? await store.record(data: nil, revision: nil, for: key)
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
        do {
            return try await client.cloneRepository(
                remoteURL: remoteURL,
                destinationPath: destinationPath
            )
        } catch let error as RPCError {
            switch error {
            case .connectionUnavailable, .disconnected, .responseTimedOut:
                // The clone RPC is not receipt-bearing, so a lost reply is
                // ambiguous. Confirm the requested destination became a Git
                // repository with a primary remote before moving on to the
                // independently retryable project-registration step.
                if let refs = try? await client.listVCSRefs(
                    cwd: destinationPath,
                    refresh: true,
                    limit: 1
                ), refs.isRepo, refs.hasPrimaryRemote {
                    return SourceControlCloneResult(
                        cwd: destinationPath,
                        remoteUrl: remoteURL,
                        repository: nil
                    )
                }
                throw error
            case .remote, .protocolViolation:
                throw error
            }
        }
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
            providerName: providerDisplayName(model.instanceId),
            modelID: model.model
        )
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        try await createThreadAndSend(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            workspaceMode: .local,
            branch: nil,
            worktreePath: nil,
            startFromOrigin: false,
            attachments: attachments
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
        attachments: [FeatureUploadAttachment]
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
            submissionIdentity: nil
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
        identity: FeatureSubmissionIdentity
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
            submissionIdentity: identity
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
        submissionIdentity: FeatureSubmissionIdentity?
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
        let uploads = try makeUploadAttachments(attachments)
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
            attachments: attachments
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
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID,
                createdAt: pending.identity.createdAt
            )
        } catch {
            // A connection can disappear after the server accepted the command
            // but before its reply reaches us. Bootstrap expansion creates the
            // thread before dispatching the stable final turn, so recover an
            // interrupted empty thread by sending only that original turn.
            let recovered = try await recoverBootstrap(
                client: client,
                pending: pending,
                projectID: route.wireID,
                text: prompt,
                model: model,
                runtimeMode: runtime,
                interactionMode: interaction,
                attachments: uploads
            )
            guard recovered else {
                await resetFailedBootstrapIfConfirmed(
                    client: client,
                    pending: pending,
                    projectCwd: routedProject.workspaceRoot
                )
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
            providerName: providerDisplayName(model.instanceId),
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
        attachments: [UploadChatImageAttachment]
    ) async throws -> Bool {
        guard let snapshot = try? await client.threadSnapshot(id: pending.threadID) else {
            return false
        }
        if snapshot.thread.messages.contains(where: {
            $0.id == pending.identity.messageID
        }) {
            return true
        }
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

    /// A failed bootstrap can leave its generated worktree behind after the
    /// server rolls back the thread. Only reset the retry identity after a
    /// fresh shell confirms the thread is absent; ambiguous network failures
    /// keep the stable IDs so the normal recovery path remains idempotent.
    private func resetFailedBootstrapIfConfirmed(
        client: T3Client,
        pending: PendingBootstrapSubmission,
        projectCwd: String
    ) async {
        guard let shell = try? await client.shellSnapshot(),
              !shell.threads.contains(where: { $0.id == pending.threadID }) else {
            return
        }

        if let branch = pending.worktreeBranchName,
           let refs = try? await client.listVCSRefs(
               cwd: projectCwd,
               query: branch,
               refresh: true,
               limit: 100
           ),
           let path = refs.refs.first(where: {
               $0.name == branch && $0.isRemote != true
           })?.worktreePath {
            // Never force-remove: setup scripts may have left useful changes.
            // A clean orphan is safe to reclaim; a dirty one remains visible
            // through normal worktree management.
            try? await client.removeWorktree(cwd: projectCwd, path: path)
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
        if let error = error as? RPCError {
            switch error {
            case .connectionUnavailable, .disconnected, .responseTimedOut:
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

    func setThreadSnoozed(id: String, until: Date?) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.snooze(threadID: route.wireID, until: until)
        try? await refresh(client: route.client)
    }

    func setThreadPinned(id: String, pinned: Bool) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.pin(threadID: route.wireID, pinned: pinned)
        try? await refresh(client: route.client)
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
        archivedThreadsByEnvironmentID[route.environmentID]?.removeAll {
            $0.id == route.uiID
        }
        if let shell = shellsByEnvironmentID[route.environmentID] {
            shellsByEnvironmentID[route.environmentID] = OrchestrationShellSnapshot(
                snapshotSequence: shell.snapshotSequence,
                projects: shell.projects,
                threads: shell.threads.filter { $0.id != route.wireID },
                updatedAt: shell.updatedAt
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

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        try await loadThread(id: id, fresh: false)
    }

    func loadThread(id: String, fresh: Bool) async throws -> FeatureThreadDetail {
        let route = try threadRoute(for: id)
        let client = route.client
        let environment = client.environment
        let generation = environmentGeneration
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
        scheduleAttachmentHydration(
            in: detail,
            threadID: route.uiID,
            client: client,
            environmentID: environment.id
        )
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
        selection: FeatureSelection?
    ) async throws {
        try await sendMessage(
            threadID: threadID,
            text: text,
            selection: selection,
            attachments: []
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment]
    ) async throws {
        try await sendMessageResolved(
            threadID: threadID,
            text: text,
            selection: selection,
            runtimeMode: nil,
            attachments: attachments,
            submissionIdentity: nil
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws {
        try await sendMessageResolved(
            threadID: threadID,
            text: text,
            selection: selection,
            runtimeMode: nil,
            attachments: attachments,
            submissionIdentity: identity
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws {
        try await sendMessageResolved(
            threadID: threadID,
            text: text,
            selection: selection,
            runtimeMode: runtimeMode,
            attachments: attachments,
            submissionIdentity: identity
        )
    }

    private func sendMessageResolved(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode requestedRuntimeMode: FeatureRuntimeMode?,
        attachments: [FeatureUploadAttachment],
        submissionIdentity: FeatureSubmissionIdentity?
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
        let uploads = try makeUploadAttachments(attachments)
        if !uploads.isEmpty { _ = try await client.serverConfig() }
        let runtimeMode = coreRuntimeMode(
            requestedRuntimeMode ?? mapRuntimeMode(shellThread.runtimeMode)
        )
        let interactionMode = InteractionMode.default
        let signature = TurnSubmissionSignature(
            text: text,
            model: model,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            attachments: attachments
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
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID,
                createdAt: pending.identity.createdAt
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
        return snapshot.thread.messages.contains { $0.id == messageID }
    }

    func cancelTurn(threadID: String) async throws {
        let route = try threadRoute(for: threadID)
        let turnID = shellsByEnvironmentID[route.environmentID]?.threads
            .first(where: { $0.id == route.wireID })?
            .latestTurn?
            .turnId
        _ = try await route.client.interrupt(threadID: route.wireID, turnID: turnID)
        try? await refresh(client: route.client)
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
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    func resolveUserInput(id: String, answers: [String: FeatureInputAnswer]) async throws {
        guard let request = inputRoutes[id] else {
            throw NativeFeatureClientError.inputRequestNotFound
        }
        let route = try threadRoute(for: request.threadID)
        _ = try await route.client.respondToUserInput(
            threadID: route.wireID,
            requestID: request.wireID,
            answers: answers.mapValues(\.jsonValue)
        )
        inputRoutes[id] = nil
        removeCachedInput(id: id, threadID: route.uiID)
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    func saveSettings(_ settings: FeatureSettings) async throws {
        let data = try JSONEncoder().encode(settings)
        settingsStore.set(data, forKey: Self.settingsKey)
    }

    func setProviderEnabled(environmentID: String, instanceID: String, enabled: Bool) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await requireScope("orchestration:operate", client: client)
        let config = try await client.serverConfig()
        guard let provider = config.providers.first(where: { $0.instanceId == instanceID }), provider.driver == "antigravity" else {
            throw FeatureCapabilityUnavailable("Provider settings")
        }
        try await client.setProviderEnabled(instanceID: instanceID, driver: provider.driver, enabled: enabled)
    }

    func providerSetup(environmentID: String, instanceID: String, action: ProviderSetupAction) async throws -> ProviderSetupEvent {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await requireScope("orchestration:operate", client: client)
        return try await client.providerSetup(instanceID: instanceID, action: action)
    }

    func providerSetupEvents(environmentID: String, instanceID: String) -> AsyncThrowingStream<ProviderSetupEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let client = try await projectCreationClient(environmentID: environmentID)
                    try await requireScope("orchestration:operate", client: client)
                    let config = try await client.serverConfig()
                    let setup = config.providers.first { $0.instanceId == instanceID }?.setup
                    try await withThrowingTaskGroup(of: Void.self) { group in
                        if setup?.canAuthenticate == true {
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
        if let config = serverConfigsByEnvironmentID[environmentID],
           config.providers.first(where: { $0.instanceId == instanceID })?.workspaceSnapshots?.contains(where: { $0.cwd == cwd }) == true {
            return mapConfigProviders(config.providers)
        }
        return try await refreshProviderCatalog(environmentID: environmentID, cwd: cwd, instanceID: instanceID, refreshModels: false)
    }

    private func refreshProviderCatalog(environmentID: String, cwd: String?, instanceID: String? = nil, refreshModels: Bool) async throws -> [FeatureProvider] {
        let client = try await projectCreationClient(environmentID: environmentID)
        let generation = environmentGeneration
        let config = try await client.refreshProviders(cwd: cwd, instanceID: instanceID, refreshModels: refreshModels)
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
            return source.sharedPatch(supportsRestartContinuation: supportsRestart)
                != target.sharedPatch(supportsRestartContinuation: supportsRestart)
        }.map { id in latestSnapshot?.environments.first { $0.id == id }?.name ?? id }
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
            supportsRestartContinuation: supportsRestartContinuation(environmentID: environmentID)
        ) else { throw FeatureCapabilityUnavailable("Restart continuation") }
        _ = try await saveServerPreferences(client: client, environmentID: environmentID, change: supportedChange)
        if case .environmentIcon = supportedChange { return }
        await fanOutSharedPreferences(from: environmentID, change: supportedChange)
    }

    private func fanOutSharedPreferences(from sourceID: String, change: ServerSettingsChange) async {
        let sourceSupportsRestart = supportsRestartContinuation(environmentID: sourceID)
        for id in sharedPreferenceTargetIDs where id != sourceID {
            guard let targetChange = NativeSharedPreferenceChange.filter(
                change,
                supportsRestartContinuation: sourceSupportsRestart
                    && supportsRestartContinuation(environmentID: id)
            ) else { continue }
            do {
                let client = try await projectCreationClient(environmentID: id)
                _ = try await saveServerPreferences(client: client, environmentID: id, change: targetChange)
            } catch {
                // Keep the last real settings so the mismatch remains visible and can be retried.
            }
        }
    }

    private func saveServerPreferences(client: T3Client, environmentID: String, change: ServerSettingsChange) async throws -> ServerSettingsSnapshot {
        let generation = environmentGeneration
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        let settings = try await client.updateSettings(change)
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        let previous = serverConfigsByEnvironmentID[environmentID]
        let config = ServerConfigSnapshot(
            providers: previous?.providers ?? [],
            settings: settings,
            threadSnapshotPagination: previous?.threadSnapshotPagination,
            threadResumeCompletionMarker: previous?.threadResumeCompletionMarker,
            environment: previous?.environment,
            usageLimitSources: previous?.usageLimitSources ?? []
        )
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
        let context = try workspaceContext(route: route)
        let result = try await route.client.listProjectEntries(cwd: context.cwd)
        return NativeWorkspaceMapper.files(result.entries, directory: path)
    }

    func searchProjectFiles(
        projectID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        let route = try projectRoute(for: projectID)
        let project = try project(for: route)
        let result = try await route.client.searchProjectEntries(
            cwd: project.workspaceRoot,
            query: query,
            limit: limit
        )
        return result.entries.map(Self.mapSearchEntry)
    }

    func searchThreadFiles(
        threadID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let result = try await route.client.searchProjectEntries(
            cwd: context.cwd,
            query: query,
            limit: limit
        )
        return result.entries.map(Self.mapSearchEntry)
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
        let context = try workspaceContext(route: route)
        let result = try await route.client.readProjectFile(
            cwd: context.cwd,
            relativePath: path
        )
        return FeatureFileContent(
            path: result.relativePath,
            text: result.contents,
            language: NativeWorkspaceMapper.language(for: result.relativePath),
            isTruncated: result.truncated,
            totalBytes: result.byteLength
        )
    }

    func loadReview(threadID: String) async throws -> FeatureReview {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let preview = try await route.client.reviewDiffPreview(cwd: context.cwd)
        return NativeWorkspaceMapper.review(preview)
    }

    func loadReviewFileContents(
        threadID: String,
        file: FeatureReviewFile
    ) async throws -> FeatureReviewFileContents? {
        guard file.change != .binary, let sourceKind = file.sourceKind else { return nil }
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let changeType: String = switch file.change {
        case .added: "new"
        case .deleted: "deleted"
        case .renamed: file.additions == 0 && file.deletions == 0
            ? "rename-pure"
            : "rename-changed"
        case .modified, .binary: "change"
        }
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

    func sourceControlStatusEvents(threadID: String) -> AsyncStream<FeatureSourceControlStatus> {
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
            workingDirectory: URL(fileURLWithPath: context.cwd).standardizedFileURL.path
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
        let events = await client.vcsStatusEvents(cwd: key.workingDirectory)
        var local: VCSLocalStatus?
        var remote: VCSRemoteStatus?

        do {
            for try await event in events {
                guard !Task.isCancelled,
                      sourceControlMonitors[key]?.id == monitorID else {
                    break
                }

                switch event {
                case let .snapshot(nextLocal, nextRemote):
                    local = nextLocal
                    remote = nextRemote
                case let .localUpdated(nextLocal):
                    if local?.refName != nextLocal.refName {
                        remote = nil
                    }
                    local = nextLocal
                case let .remoteUpdated(nextRemote):
                    remote = nextRemote
                }

                guard let local else { continue }
                let status = NativeWorkspaceMapper.sourceControl(
                    local: local,
                    remote: remote
                )
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
        threadID: String,
        action: FeatureSourceControlAction,
        message: String?
    ) async throws -> FeatureSourceControlStatus {
        let route = try threadRoute(for: threadID)
        let client = route.client
        let context = try workspaceContext(route: route)

        if action == .pull {
            _ = try await client.pull(cwd: context.cwd)
        } else {
            let progress = try await client.runGitAction(
                cwd: context.cwd,
                action: NativeWorkspaceMapper.gitAction(action),
                commitMessage: message
            )
            for try await event in progress {
                if event.kind == "action_failed" {
                    throw RPCError.remote(event.message ?? "The source-control action failed.")
                }
            }
        }

        return NativeWorkspaceMapper.sourceControl(
            try await client.refreshVCSStatus(cwd: context.cwd)
        )
    }

    func terminalSnapshot(
        threadID: String,
        terminalID: String
    ) async throws -> FeatureTerminalSnapshot {
        let route = try threadRoute(for: threadID)
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
        guard let route = try? threadRoute(for: threadID),
              let context = try? workspaceContext(route: route) else {
            return AsyncStream { continuation in continuation.finish() }
        }
        let environmentID = route.environmentID
        let client = route.client
        let uiThreadID = route.uiID
        let wireThreadID = route.wireID
        let key = TerminalKey(threadID: uiThreadID, terminalID: terminalID)
        let generation = environmentGeneration
        return AsyncStream { continuation in
            if let snapshot = terminalSnapshots[key] {
                continuation.yield(snapshot)
            }
            let task = Task { [weak self] in
                do {
                    let events = try await client.attachTerminal(
                        threadID: wireThreadID,
                        terminalID: terminalID,
                        cwd: context.cwd,
                        worktreePath: context.worktreePath,
                        columns: 80,
                        rows: 24
                    )
                    for try await event in events {
                        guard !Task.isCancelled else { break }
                        guard let self else { break }
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
                            terminalID: terminalID,
                            workingDirectory: context.cwd
                        )
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
                    for try await event in await client.terminalMetadataEvents() {
                        guard !Task.isCancelled else { break }
                        guard let self else { break }
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

    func openTerminal(
        threadID: String,
        terminalID: String,
        columns: Int,
        rows: Int
    ) async throws {
        let route = try threadRoute(for: threadID)
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
        try await route.client.resizeTerminal(
            threadID: route.wireID,
            terminalID: terminalID,
            columns: columns,
            rows: rows
        )
    }

    func clearTerminal(threadID: String, terminalID: String) async throws {
        let route = try threadRoute(for: threadID)
        try await route.client.clearTerminal(
            threadID: route.wireID,
            terminalID: terminalID
        )
    }

    func closeTerminal(threadID: String, terminalID: String) async throws {
        let route = try threadRoute(for: threadID)
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
        let prepared = try await client.prepareAttachment(
            makeUploadAttachments([attachment])[0]
        )
        return prepared.map {
            FeatureUploadedAttachmentReference(
                environmentID: $0.environmentID,
                attachmentID: $0.attachmentID
            )
        }
    }

    private func projectCreationClient(environmentID: String) async throws -> T3Client {
        if let client = environmentClients[environmentID] {
            return client
        }
        guard let environment = try await runtime.environments().first(where: {
            $0.id == environmentID
        }) else {
            throw NativeFeatureClientError.environmentNotFound
        }
        let client = await runtime.client(for: environment)
        environmentClients[environmentID] = client
        return client
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

    private func threadRoute(for threadID: String) throws -> NativeThreadRoute {
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
                    updatedAt: shell.updatedAt
                )
            } else if let previouslyArchivedShell {
                var threads = shell.threads.filter { $0.id != route.wireID }
                threads.append(Self.unarchived(previouslyArchivedShell))
                shellsByEnvironmentID[route.environmentID] = OrchestrationShellSnapshot(
                    snapshotSequence: shell.snapshotSequence,
                    projects: shell.projects,
                    threads: threads,
                    updatedAt: shell.updatedAt
                )
            }
        }
        archivedShellThreadsByEnvironmentID[route.environmentID] = archivedShellThreads
    }

    private static func unarchived(
        _ thread: OrchestrationThreadShell
    ) -> OrchestrationThreadShell {
        OrchestrationThreadShell(
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            linkedPullRequest: thread.linkedPullRequest,
            latestTurn: thread.latestTurn,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            archivedAt: nil,
            settledOverride: thread.settledOverride,
            settledAt: thread.settledAt,
            unsettledAt: thread.unsettledAt,
            snoozedUntil: thread.snoozedUntil,
            snoozedAt: thread.snoozedAt,
            pinnedAt: thread.pinnedAt,
            session: thread.session,
            latestUserMessageAt: thread.latestUserMessageAt,
            hasPendingApprovals: thread.hasPendingApprovals,
            hasPendingUserInput: thread.hasPendingUserInput,
            hasActionableProposedPlan: thread.hasActionableProposedPlan,
            backgroundLiveness: thread.backgroundLiveness
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
        guard let shell = shellsByEnvironmentID[route.environmentID],
              let thread = shell.threads.first(where: { $0.id == route.wireID }),
              let project = shell.projects.first(where: { $0.id == thread.projectId }) else {
            throw NativeFeatureClientError.workspaceNotFound
        }
        return (
            cwd: thread.worktreePath ?? project.workspaceRoot,
            worktreePath: thread.worktreePath
        )
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

        var snapshot = terminalSnapshots[key]
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
    private static let terminalBufferLimit = 512 * 1024

    private static func cappedTerminalBuffer(_ buffer: String) -> String {
        let utf8 = buffer.utf8
        guard utf8.count > terminalBufferLimit else { return buffer }
        // Slice in UTF-8 bytes (the unit the limit is defined in), then snap
        // forward to a character boundary so multibyte output cannot blow
        // past the cap or tear a scalar.
        let byteStart = utf8.index(utf8.endIndex, offsetBy: -terminalBufferLimit)
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
                    let sequence = self?.latestShell?.snapshotSequence
                    let events = await activeClient.shellEvents(after: sequence, reconnect: false)
                    // Re-bind self per event instead of holding it strongly across
                    // the indefinite stream, so the client can deinit mid-stream.
                    for try await item in events {
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
                        self.emitConnection(.connected)
                        switch item {
                        case let .snapshot(shell):
                            await self.consume(
                                shell: shell,
                                client: activeClient,
                                generation: generation,
                                refreshActiveThread: true
                            )
                        case .projectUpserted, .projectRemoved, .threadUpserted, .threadRemoved:
                            await self.consume(delta: item, client: activeClient, generation: generation)
                        case .refreshRequired:
                            if let shell = try? await activeClient.shellSnapshot() {
                                await self.consume(
                                    shell: shell,
                                    client: activeClient,
                                    generation: generation,
                                    refreshActiveThread: true
                                )
                            }
                        case .synchronized:
                            break
                        }
                    }
                } catch is CancellationError {
                    return
                } catch {
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
                let socketIsSynchronized =
                    await activeClient.liveConnectionActive()
                    && self.lastShellEventAt != nil
                if !socketIsSynchronized {
                    self.emitConnection(
                        .reconnecting,
                        detail: "Live updates reconnecting. Refreshing over HTTP."
                    )
                    do {
                        let shell = try await activeClient.shellSnapshot()
                        guard !Task.isCancelled,
                              self.isCurrentSession(
                                  client: activeClient,
                                  generation: generation
                              ) else {
                            return
                        }
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
                        let config = ServerConfigSnapshot(
                            providers: providers,
                            settings: previous?.settings,
                            threadSnapshotPagination: previous?.threadSnapshotPagination,
                            threadResumeCompletionMarker: previous?.threadResumeCompletionMarker,
                            environment: previous?.environment
                                ?? self.latestServerConfig?.environment,
                            usageLimitSources: previous?.usageLimitSources
                                ?? self.latestServerConfig?.usageLimitSources ?? []
                        )
                        self.latestServerConfig = config
                        self.setServerConfig(config, environmentID: activeClient.environment.id)
                    case let .settingsUpdated(settings):
                        let previous = self.serverConfigsByEnvironmentID[
                            activeClient.environment.id
                        ]
                        let providers = previous?.providers
                            ?? self.latestServerConfig?.providers ?? []
                        let config = ServerConfigSnapshot(
                            providers: providers,
                            settings: settings,
                            threadSnapshotPagination: previous?.threadSnapshotPagination
                                ?? self.latestServerConfig?.threadSnapshotPagination,
                            threadResumeCompletionMarker: previous?.threadResumeCompletionMarker
                                ?? self.latestServerConfig?.threadResumeCompletionMarker,
                            environment: previous?.environment
                                ?? self.latestServerConfig?.environment,
                            usageLimitSources: previous?.usageLimitSources
                                ?? self.latestServerConfig?.usageLimitSources ?? []
                        )
                        self.latestServerConfig = config
                        self.setServerConfig(config, environmentID: activeClient.environment.id)
                    case let .usageLimitSourcesUpdated(sources):
                        guard let previous = self.serverConfigsByEnvironmentID[activeClient.environment.id]
                            ?? self.latestServerConfig else { continue }
                        let config = ServerConfigSnapshot(
                            providers: previous.providers,
                            settings: previous.settings,
                            threadSnapshotPagination: previous.threadSnapshotPagination,
                            threadResumeCompletionMarker: previous.threadResumeCompletionMarker,
                            environment: previous.environment,
                            usageLimitSources: sources
                        )
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
        let interval = aggregateRefreshInterval
        let loadEnvironments = aggregateEnvironmentLoader
        aggregateRefreshID = refreshID
        aggregateRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: interval)
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
                do {
                    environments = try await loadEnvironments(self.runtime)
                } catch is CancellationError where Task.isCancelled {
                    return
                } catch {
                    // Persistence can be briefly unavailable while another
                    // actor atomically replaces the environment document.
                    // Keep the low-frequency loop alive for the next cadence.
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
                guard !passiveEnvironments.isEmpty else { continue }
                let loads = await self.loadEnvironmentShells(passiveEnvironments)
                guard !Task.isCancelled,
                      self.aggregateRefreshID == refreshID,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ) else {
                    return
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
            }
        }
    }

    private func consume(
        shell: OrchestrationShellSnapshot,
        client: T3Client,
        generation: Int,
        refreshActiveThread: Bool
    ) async {
        guard !Task.isCancelled,
              isCurrentSession(client: client, generation: generation),
              shell.snapshotSequence >= (latestShell?.snapshotSequence ?? .min) else {
            return
        }
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = shell
        shellsByEnvironmentID[client.environment.id] = shell
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

    private func consume(delta: ShellStreamItem, client: T3Client, generation: Int) async {
        guard !Task.isCancelled,
              isCurrentSession(client: client, generation: generation) else { return }
        guard let current = latestShell else {
            if let shell = try? await client.shellSnapshot() {
                await consume(
                    shell: shell, client: client, generation: generation, refreshActiveThread: true
                )
            }
            return
        }

        let sequence: Int

        switch delta {
        case let .projectUpserted(nextSequence, _):
            sequence = nextSequence
        case let .projectRemoved(nextSequence, _):
            sequence = nextSequence
        case let .threadUpserted(nextSequence, _):
            sequence = nextSequence
        case let .threadRemoved(nextSequence, _):
            sequence = nextSequence
        case .snapshot, .synchronized, .refreshRequired:
            return
        }

        // Replayed deltas are expected after reconnect. They must be entirely
        // side-effect free, including for cached detail and selection state.
        guard sequence > current.snapshotSequence else { return }

        var projects = current.projects
        var threads = current.threads
        var changedThreadID: String?
        var shouldRefreshArchived = false

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
            changedThreadID = FeatureScopedID.thread(
                environmentID: client.environment.id, wireID: thread.id
            )
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
            changedThreadID = uiThreadID
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
        case .snapshot, .synchronized, .refreshRequired:
            return
        }

        let shell = OrchestrationShellSnapshot(
            snapshotSequence: sequence,
            projects: projects,
            threads: threads,
            updatedAt: current.updatedAt
        )
        latestShell = shell
        // Keep the source cache current during the coalesced UI publish. A
        // concurrent config or HTTP refresh must not restore an older shell.
        shellsByEnvironmentID[client.environment.id] = shell
        scheduleShellPublish(client)
        if shouldRefreshArchived {
            scheduleArchivedRefresh(client: client, environment: client.environment)
        }
        if let changedThreadID, activeThreadID == changedThreadID {
            scheduleDetailRefresh(threadID: changedThreadID, client: client)
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
        detailStreamTask = Task { [weak self] in
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
                do {
                    let connectionBeforeSubscribe = await route.client.currentConnectionID()
                    guard !Task.isCancelled,
                          self?.isCurrentDetail(route, generation: streamGeneration) == true,
                          self?.environmentGeneration == sessionGeneration else { return }
                    let events = await route.client.threadEvents(
                        threadID: route.wireID,
                        after: sequence,
                        turnLimit: supportsPagination ? Self.initialThreadUserTurnLimit : nil,
                        reconnect: false
                    )
                    let connectionAfterSubscribe = await route.client.currentConnectionID()
                    guard !Task.isCancelled,
                          self?.isCurrentDetail(route, generation: streamGeneration) == true,
                          self?.environmentGeneration == sessionGeneration else { return }
                    // A socket that changed during subscription cannot prove
                    // which connection produced already-buffered events.
                    let subscriptionConnectionID = connectionBeforeSubscribe == connectionAfterSubscribe
                        ? connectionBeforeSubscribe
                        : nil
                    if self?.detailWasSynchronized == true,
                       subscriptionConnectionID == nil || subscriptionConnectionID != self?.activeDetailConnectionID {
                        self?.detailWasSynchronized = false
                        self?.continuation.yield(.threadSync(id: route.uiID, state: .catchingUp))
                    }
                    self?.activeDetailConnectionID = subscriptionConnectionID
                    for try await item in events {
                        if case .synchronized = item {
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
                        self.consumeDetailStreamItem(
                            item, route: route, subscriptionEpoch: subscriptionEpoch
                        )
                    }
                } catch is CancellationError {
                    return
                } catch {
                    // A bounded HTTP read runs alongside socket recovery.
                }
                guard !Task.isCancelled,
                      self?.isCurrentDetail(route, generation: streamGeneration) == true else { return }
                self?.detailCompletionReceived = false
                self?.detailWasSynchronized = false
                self?.activeDetailConnectionID = nil
                self?.continuation.yield(.threadSync(id: route.uiID, state: .reconnecting))
                self?.ensureDetailCatchUpFallback(route, generation: streamGeneration)
                do { try await Task.sleep(for: .milliseconds(250)) }
                catch { return }
            }
        }
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

    private func consumeDetailStreamItem(
        _ item: ThreadStreamItem,
        route: NativeThreadRoute,
        subscriptionEpoch: Int
    ) {
        switch item {
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
            let reduction = NativeThreadDetailReducer.apply(event, to: current)
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
        if serverConfigsByEnvironmentID[route.environmentID]?.threadResumeCompletionMarker != true {
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
        scheduleAttachmentHydration(
            in: detail, threadID: route.uiID, client: route.client,
            environmentID: route.environmentID
        )
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
        _ environments: [Environment]
    ) async -> [EnvironmentShellLoad] {
        let activeEnvironmentID = activeEnvironment?.id
        let environmentsWithCachedConfig = Set(serverConfigsByEnvironmentID.keys)
        let shellTimeoutInterval = environmentShellTimeoutInterval
        let runtime = runtime
        var clients: [(environment: Environment, client: T3Client)] = []
        clients.reserveCapacity(environments.count)
        for environment in environments {
            clients.append(
                (environment, await runtime.client(for: environment))
            )
        }

        return await withTaskGroup(of: EnvironmentShellLoad.self) { group in
            for pair in clients {
                group.addTask {
                    let shell = try? await pair.client.shellSnapshot(
                        timeoutInterval: shellTimeoutInterval
                    )
                    guard shell != nil else {
                        return EnvironmentShellLoad(
                            environment: pair.environment,
                            client: pair.client,
                            shell: nil,
                            config: nil
                        )
                    }

                    let isActive = pair.environment.id == activeEnvironmentID
                    let shouldFetchConfig = isActive
                        || !environmentsWithCachedConfig.contains(pair.environment.id)
                    var config: ServerConfigSnapshot?
                    if shouldFetchConfig {
                        if isActive {
                            config = try? await pair.client.serverConfig()
                        } else {
                            // A passive catalogue is a bounded one-shot RPC on
                            // an uncached client. Never disconnect the shared
                            // client because the environment may become active
                            // while this aggregate load is in flight.
                            let probe = await runtime.ephemeralClient(
                                for: pair.environment
                            )
                            config = try? await probe.serverConfig()
                            await probe.disconnect()
                        }
                    }
                    return EnvironmentShellLoad(
                        environment: pair.environment,
                        client: pair.client,
                        shell: shell,
                        config: config
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
        shellsByEnvironmentID = shellsByEnvironmentID.filter { savedIDs.contains($0.key) }
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
            environmentClients[load.environment.id] = load.client
            if let config = load.config {
                setServerConfig(config, environmentID: load.environment.id)
                if load.environment.id == activeEnvironment?.id {
                    latestServerConfig = config
                }
            }
            if let shell = load.shell {
                if shell.snapshotSequence
                    >= (shellsByEnvironmentID[load.environment.id]?.snapshotSequence ?? .min) {
                    shellsByEnvironmentID[load.environment.id] = shell
                }
                environmentConnectionStates[load.environment.id] = .connected
                environmentConnectionDetails[load.environment.id] = nil
            } else {
                environmentConnectionStates[load.environment.id] = .disconnected
                environmentConnectionDetails[load.environment.id] =
                    "That server is currently unreachable."
            }
        }
        rebuildEntityIndexes(savedEnvironments)
    }

    private func newestShell(
        _ candidate: OrchestrationShellSnapshot,
        for environment: Environment
    ) -> OrchestrationShellSnapshot {
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

    private func rebuildEntityIndexes(_ environments: [Environment]) {
        let savedIDs = Set(environments.map(\.id))
        provisionalThreadRoutes = provisionalThreadRoutes.filter {
            savedIDs.contains($0.value.environmentID)
        }

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
    }

    private func refresh(client: T3Client, includeArchived: Bool = false) async throws {
        let environment = client.environment
        let generation = environmentGeneration
        let shell = try await client.shellSnapshot()
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
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
        scheduleAttachmentHydration(
            in: detail,
            threadID: route.uiID,
            client: client,
            environmentID: environment.id
        )
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
            applySettlementAuthority(from: shellThread, to: &detail.thread)
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
        synchronizeRenderedMessages: Bool = false,
        delta: FeatureDetailDelta? = nil
    ) {
        if renderCacheIsSource {
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
        let next = latestDetails[threadID].map { current in
            mergedDetail(current: current, incoming: detail)
        } ?? detail
        guard latestDetails[threadID] != next else { return }
        latestDetails[threadID] = next
        if let cache = detailRenderCaches[threadID] {
            cache.approvals = next.approvals
            cache.userInputs = next.userInputs
            if synchronizeRenderedMessages {
                for message in next.messages {
                    if let index = cache.mergedIndexByID[message.id] {
                        cache.mergedMessages[index] = message
                    }
                    if cache.messagesByID[message.id] != nil {
                        cache.messagesByID[message.id] = message
                    }
                }
            }
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

        var changedIDs = Set(mutations.messages.map(\.id))
        for activity in mutations.activities {
            if NativeActivityNotice.accepts(activity) {
                changedIDs.insert("activity-\(activity.id)")
            } else if NativeWorkLogAccumulator.accepts(activity) {
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

    private func mergedDetail(
        current: FeatureThreadDetail,
        incoming: FeatureThreadDetail
    ) -> FeatureThreadDetail {
        FeatureThreadDetail(
            thread: incoming.thread,
            messages: replacingChangedSuffix(current.messages, with: incoming.messages),
            approvals: replacingChangedSuffix(current.approvals, with: incoming.approvals),
            userInputs: replacingChangedSuffix(current.userInputs, with: incoming.userInputs),
            page: incoming.page,
            activeSubagentCount: incoming.activeSubagentCount,
            backgroundWorkIsActive: incoming.backgroundWorkIsActive,
            isCompacting: incoming.isCompacting == true
        )
    }

    private func replacingChangedSuffix<Element: Equatable>(
        _ current: [Element],
        with incoming: [Element]
    ) -> [Element] {
        guard current != incoming else { return current }
        let prefixCount = zip(current, incoming).prefix { pair in
            pair.0 == pair.1
        }.count
        var result = current
        result.replaceSubrange(prefixCount..., with: incoming.dropFirst(prefixCount))
        return result
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
        environmentConnectionDetails[environment.id] = detail
        let connection = FeatureConnection(
            state: state,
            environmentName: environment.label,
            endpoint: environment.httpBaseURL.absoluteString,
            detail: detail
        )
        if var snapshot = latestSnapshot {
            snapshot.connection = connection
            if let index = snapshot.environments.firstIndex(where: { $0.id == environment.id }) {
                snapshot.environments[index].connectionState = state
                snapshot.environments[index].connectionDetail = detail
            }
            latestSnapshot = snapshot
            continuation.yield(.snapshot(snapshot))
            return
        }
        continuation.yield(.connection(connection))
    }

    private func makeSnapshot(
        environments: [Environment],
        activeEnvironment: Environment,
        connectionState: FeatureConnection.State,
        connectionDetail: String? = nil
    ) -> FeatureSnapshot {
        let enabledEnvironments = environments.filter(\.isEnabled)
        let threads = enabledEnvironments.flatMap { environment in
            let live = shellsByEnvironmentID[environment.id]?.threads.map {
                mapThread($0, environment: environment)
            } ?? []
            let liveIDs = Set(live.map(\.id))
            let cached = (archivedThreadsByEnvironmentID[environment.id] ?? []).filter {
                !liveIDs.contains($0.id)
            }
            return live + cached
        }
        let threadCountByProjectID = threads.reduce(into: [String: Int]()) {
            $0[$1.projectID, default: 0] += 1
        }
        let projects = enabledEnvironments.flatMap { environment in
            (shellsByEnvironmentID[environment.id]?.projects ?? []).map { project in
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
                    threadCount: threadCountByProjectID[uiID, default: 0],
                    defaultSelection: project.defaultModelSelection.map(mapSelection),
                    repositoryIdentity: project.repositoryIdentity.map {
                        FeatureRepositoryIdentity(
                            canonicalKey: $0.canonicalKey,
                            rootPath: $0.rootPath,
                            displayName: $0.displayName,
                            name: $0.name
                        )
                    },
                    createdAt: project.createdAt,
                    updatedAt: project.updatedAt
                )
                mapped.projectIcon = project.projectIcon
                return mapped
            }
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
            let defaultWorkspaceMode: FeatureWorkspaceMode =
                switch serverSettings.defaultThreadEnvMode {
                case .local: .local
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
                    : nil
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
        mapped.machineIcon = serverConfigsByEnvironmentID[environment.id]?.settings?.environmentIcon
            ?? environment.descriptor?.platform.machine
        mapped.canCustomizeIcon = serverConfigsByEnvironmentID[environment.id]?.environment?.capabilities.environmentIcon
            ?? environment.descriptor?.capabilities.environmentIcon
        return mapped
    }

    private func mapThread(
        _ thread: OrchestrationThreadShell,
        environment: Environment
    ) -> FeatureThread {
        let backgroundLiveness = thread.backgroundLiveness
        let backgroundWorkIsActive = backgroundLiveness == .working
        return FeatureThread(
            id: FeatureScopedID.thread(environmentID: environment.id, wireID: thread.id),
            wireID: thread.id,
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
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            state: Self.resolveThreadState(
                latestTurn: thread.latestTurn,
                session: thread.session,
                hasApprovals: thread.hasPendingApprovals,
                hasUserInput: thread.hasPendingUserInput,
                backgroundLiveness: backgroundLiveness
            ),
            providerID: thread.modelSelection.instanceId,
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
            settledAt: thread.settledAt.map(parseDate),
            unsettledAt: thread.unsettledAt.flatMap(parseValidDate),
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.latestUserMessageAt,
                latestTurn: thread.latestTurn
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            pinnedAt: thread.pinnedAt.map(parseDate),
            supportsSettlement: environment.descriptor?.capabilities.threadSettlement,
            supportsSnooze: environment.descriptor?.capabilities.threadSnooze,
            supportsPinning: environment.descriptor?.capabilities.threadPinning,
            supportsTitleRegeneration: environment.descriptor?.capabilities.threadTitleRegeneration,
            supportsPullRequestLinking: environment.descriptor?.capabilities.threadPullRequestLinking,
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
            latestTurnCompletedAt: thread.latestTurn?.completedAt.map(parseDate),
            settlementFacts: settlementFacts(
                override: thread.settledOverride,
                session: thread.session,
                hasApprovals: thread.hasPendingApprovals,
                hasUserInput: thread.hasPendingUserInput,
                latestUserMessageAt: thread.latestUserMessageAt,
                latestTurn: thread.latestTurn
            ),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode)
        )
    }

    private func mapThread(
        _ thread: OrchestrationThread,
        environment: Environment
    ) -> FeatureThread {
        let backgroundLiveness = backgroundLiveness(
            threadID: thread.id,
            environmentID: environment.id
        )
        let backgroundWorkIsActive = backgroundLiveness == .working
        return FeatureThread(
            id: FeatureScopedID.thread(environmentID: environment.id, wireID: thread.id),
            wireID: thread.id,
            projectID: FeatureScopedID.project(
                environmentID: environment.id,
                wireID: thread.projectId
            ),
            environmentID: environment.id,
            environmentName: environment.label,
            title: thread.title,
            preview: previewText(thread.messages.last?.text),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            linkedPullRequest: thread.linkedPullRequest,
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            state: Self.resolveThreadState(
                latestTurn: thread.latestTurn,
                session: thread.session,
                hasApprovals: false,
                hasUserInput: false,
                backgroundLiveness: backgroundLiveness
            ),
            providerID: thread.modelSelection.instanceId,
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
            settledAt: thread.settledAt.map(parseDate),
            unsettledAt: thread.unsettledAt.flatMap(parseValidDate),
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.messages.last(where: { $0.role == "user" })?.createdAt,
                latestTurn: thread.latestTurn
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            pinnedAt: thread.pinnedAt.map(parseDate),
            supportsSettlement: environment.descriptor?.capabilities.threadSettlement,
            supportsSnooze: environment.descriptor?.capabilities.threadSnooze,
            supportsPinning: environment.descriptor?.capabilities.threadPinning,
            supportsTitleRegeneration: environment.descriptor?.capabilities.threadTitleRegeneration,
            supportsPullRequestLinking: environment.descriptor?.capabilities.threadPullRequestLinking,
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
            latestTurnCompletedAt: thread.latestTurn?.completedAt.map(parseDate),
            settlementFacts: settlementFacts(
                override: thread.settledOverride,
                session: thread.session,
                hasApprovals: false,
                hasUserInput: false,
                latestUserMessageAt: thread.messages.last(where: { $0.role == "user" })?.createdAt,
                latestTurn: thread.latestTurn
            ),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode)
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

        if !cache.isInitialized || mutations == nil || mutations?.requiresFullRebuild == true {
            cache.compaction = NativeContextCompactionState()
            cache.messagesByID = thread.messages.reduce(into: [:]) { result, raw in
                result[raw.id] = mapMessage(raw, environmentID: environment.id)
                cache.compaction.apply(raw, createdAt: parseDate(raw.createdAt))
            }
            cache.approvals = pendingApprovals(thread, environment: environment)
            cache.userInputs = pendingUserInputs(thread, environment: environment)
            let notices = thread.activities.compactMap { activity in
                cache.compaction.apply(activity)
                return NativeActivityNotice.message(activity, createdAt: parseDate(activity.createdAt))
            }
            let sessionIsLive = thread.session?.status == "starting"
                || thread.session?.status == "running"
            let activityMessages = (notices + collapsedWorkLogs(
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

        var mappedThread = mapThread(thread, environment: environment)
        let backgroundLiveness = backgroundLiveness(
            threadID: thread.id,
            environmentID: environment.id
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
            hasApprovals: !cache.approvals.isEmpty,
            hasUserInput: !cache.userInputs.isEmpty,
            backgroundLiveness: backgroundLiveness
        )
        mappedThread.settlementFacts?.hasPendingApprovals = !cache.approvals.isEmpty
        mappedThread.settlementFacts?.hasPendingUserInput = !cache.userInputs.isEmpty
        if let shell = shellsByEnvironmentID[environment.id],
           let shellThread = shell.threads.first(where: { $0.id == thread.id }),
           shell.snapshotSequence >= sourceSequence {
            applySettlementAuthority(from: shellThread, to: &mappedThread)
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
            )
        )
    }

    private func backgroundLiveness(
        threadID: String,
        environmentID: String
    ) -> OrchestrationBackgroundLiveness? {
        if let live = shellsByEnvironmentID[environmentID]?.threads
            .first(where: { $0.id == threadID })?.backgroundLiveness {
            return live
        }
        return archivedShellThreadsByEnvironmentID[environmentID]?[threadID]?
            .backgroundLiveness
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
            if let hydration = attachmentHydrationTasks.removeValue(forKey: threadID) {
                hydration.task.cancel()
            }
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
            isCompacting: currentDetail.isCompacting == true
        )
        publish(detail, threadID: route.uiID, renderCacheIsSource: true)
        scheduleAttachmentHydration(
            in: detail,
            threadID: route.uiID,
            client: route.client,
            environmentID: route.environmentID
        )
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
            id: loaded.id,
            projectId: loaded.projectId,
            title: loaded.title,
            modelSelection: loaded.modelSelection,
            runtimeMode: loaded.runtimeMode,
            interactionMode: loaded.interactionMode,
            branch: loaded.branch,
            worktreePath: loaded.worktreePath,
            linkedPullRequest: loaded.linkedPullRequest,
            latestTurn: loaded.latestTurn,
            createdAt: loaded.createdAt,
            updatedAt: loaded.updatedAt,
            archivedAt: loaded.archivedAt,
            settledOverride: loaded.settledOverride,
            settledAt: loaded.settledAt,
            unsettledAt: loaded.unsettledAt,
            snoozedUntil: loaded.snoozedUntil,
            snoozedAt: loaded.snoozedAt,
            pinnedAt: loaded.pinnedAt,
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
        guard NativeWorkLogAccumulator.accepts(activity),
              cache.workLogActivityIDs.insert(activity.id).inserted else {
            return
        }
        let groupID = activity.turnId ?? "unscoped"
        var accumulator = cache.workLogsByGroupID[groupID] ?? NativeWorkLogAccumulator()
        accumulator.append(
            activity,
            preview: previewText(activity.payload["detail"]?.stringValue),
            createdAt: parseDate(activity.createdAt)
        )
        cache.workLogsByGroupID[groupID] = accumulator
        guard accumulator.hasContent else { return }
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
                preview: previewText(activity.payload["detail"]?.stringValue),
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
                options: Self.approvalOptions(activity.payload)
            )
            cache.approvals.removeAll { $0.id == uiRequestID }
            cache.approvals.append(approval)
            cache.approvals.sort { $0.id < $1.id }
            approvalRoutes[uiRequestID] = PendingRequestRoute(
                threadID: threadID,
                wireID: requestID
            )
        case "approval.resolved":
            cache.approvals.removeAll { $0.id == uiRequestID }
            approvalRoutes[uiRequestID] = nil
        case "provider.approval.respond.failed":
            let detail = activity.payload["detail"]?.stringValue?.lowercased() ?? ""
            guard detail.contains("stale") || detail.contains("unknown") else { return }
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
            guard let questions = parseInputQuestions(activity.payload), !questions.isEmpty else {
                return
            }
            let request = FeatureUserInput(
                id: uiRequestID,
                wireID: requestID,
                threadID: threadID,
                questions: questions
            )
            cache.userInputs.removeAll { $0.id == uiRequestID }
            cache.userInputs.append(request)
            cache.userInputs.sort { $0.id < $1.id }
            inputRoutes[uiRequestID] = PendingRequestRoute(
                threadID: threadID,
                wireID: requestID
            )
        case "user-input.resolved":
            cache.userInputs.removeAll { $0.id == uiRequestID }
            inputRoutes[uiRequestID] = nil
        case "provider.user-input.respond.failed":
            let detail = activity.payload["detail"]?.stringValue?.lowercased() ?? ""
            guard detail.contains("stale") || detail.contains("unknown") else { return }
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
            attachments: (message.attachments ?? []).map {
                FeatureMessageAttachment(
                    id: $0.id,
                    name: $0.name,
                    mimeType: $0.mimeType,
                    sizeBytes: $0.sizeBytes,
                    url: cachedAttachmentURL(for: $0.id, environmentID: environmentID)
                )
            }
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
                    preview: previewText(activity.payload["detail"]?.stringValue),
                    createdAt: parseDate(activity.createdAt)
                )
            }
            if !sessionIsLive { accumulator.clearActiveWork() }
            return accumulator.hasContent ? accumulator.message(groupID: groupID) : nil
        }
    }

    private func pendingApprovals(
        _ thread: OrchestrationThread,
        environment: Environment
    ) -> [FeatureApproval] {
        var open: [String: FeatureApproval] = [:]
        let threadID = FeatureScopedID.thread(
            environmentID: environment.id,
            wireID: thread.id
        )
        for activity in sortedByCreation(thread.activities) {
            let requestID = activity.payload["requestId"]?.stringValue
            let uiRequestID = requestID.map {
                FeatureScopedID.approval(environmentID: environment.id, wireID: $0)
            }
            if activity.kind == "approval.requested", let requestID {
                let kind = Self.approvalKind(activity.payload)
                let detail = activity.payload["detail"]?.stringValue ?? activity.summary
                let appName = activity.payload["appName"]?.stringValue
                let uiRequestID = FeatureScopedID.approval(
                    environmentID: environment.id,
                    wireID: requestID
                )
                open[uiRequestID] = FeatureApproval(
                    id: uiRequestID,
                    wireID: requestID,
                    threadID: threadID,
                    kind: kind,
                    title: appName ?? activity.summary,
                    detail: detail,
                    appName: appName,
                    options: Self.approvalOptions(activity.payload)
                )
                approvalRoutes[uiRequestID] = PendingRequestRoute(
                    threadID: threadID,
                    wireID: requestID
                )
            } else if activity.kind == "approval.resolved", let uiRequestID {
                open[uiRequestID] = nil
                approvalRoutes[uiRequestID] = nil
            } else if activity.kind == "provider.approval.respond.failed", let uiRequestID {
                let detail = activity.payload["detail"]?.stringValue?.lowercased() ?? ""
                if detail.contains("stale") || detail.contains("unknown") {
                    open[uiRequestID] = nil
                    approvalRoutes[uiRequestID] = nil
                }
            }
        }
        return open.values.sorted { $0.id < $1.id }
    }

    private static func approvalKind(_ payload: JSONValue) -> FeatureApprovalKind {
        switch payload["requestKind"]?.stringValue {
        case "command": .command
        case "file-read": .fileRead
        case "file-change": .fileChange
        case "mcp-elicitation": .mcpElicitation
        default: .other
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
            return FeatureApprovalOption(decision: decision, label: label)
        }
        return options.isEmpty ? nil : options
    }

    private func pendingUserInputs(
        _ thread: OrchestrationThread,
        environment: Environment
    ) -> [FeatureUserInput] {
        var open: [String: FeatureUserInput] = [:]
        let threadID = FeatureScopedID.thread(
            environmentID: environment.id,
            wireID: thread.id
        )
        for activity in sortedByCreation(thread.activities) {
            let requestID = activity.payload["requestId"]?.stringValue
            let uiRequestID = requestID.map {
                FeatureScopedID.input(environmentID: environment.id, wireID: $0)
            }
            if activity.kind == "user-input.requested",
               let requestID,
               let questions = parseInputQuestions(activity.payload),
               !questions.isEmpty {
                let uiRequestID = FeatureScopedID.input(
                    environmentID: environment.id,
                    wireID: requestID
                )
                open[uiRequestID] = FeatureUserInput(
                    id: uiRequestID,
                    wireID: requestID,
                    threadID: threadID,
                    questions: questions
                )
                inputRoutes[uiRequestID] = PendingRequestRoute(
                    threadID: threadID,
                    wireID: requestID
                )
            } else if activity.kind == "user-input.resolved", let uiRequestID {
                open[uiRequestID] = nil
                inputRoutes[uiRequestID] = nil
            } else if activity.kind == "provider.user-input.respond.failed", let uiRequestID {
                let detail = activity.payload["detail"]?.stringValue?.lowercased() ?? ""
                if detail.contains("stale") || detail.contains("unknown") {
                    open[uiRequestID] = nil
                    inputRoutes[uiRequestID] = nil
                }
            }
        }
        return open.values.sorted { $0.id < $1.id }
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
                        detail: option["description"]?.stringValue ?? ""
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
            return FeatureInputQuestion(
                id: id,
                header: header,
                question: text,
                options: options,
                allowsMultiple: allowsMultiple
            )
        }
    }

    nonisolated static func resolveThreadState(
        latestTurn: OrchestrationLatestTurn?,
        session: OrchestrationSession?,
        hasApprovals: Bool,
        hasUserInput: Bool,
        backgroundLiveness: OrchestrationBackgroundLiveness?
    ) -> FeatureThreadState {
        if hasApprovals { return .waitingForApproval }
        if hasUserInput { return .waitingForInput }
        if session?.status == "starting" { return .queued }
        if session?.status == "running" || latestTurn?.state == "running" { return .working }
        if session?.status == "error" || latestTurn?.state == "error" { return .failed }
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

    private func applySettlementAuthority(
        from shell: OrchestrationThreadShell,
        to thread: inout FeatureThread
    ) {
        thread.isSettled = isSettled(shell.settledOverride, settledAt: shell.settledAt)
        thread.keepsActive = shell.settledOverride == "active"
        thread.settledAt = shell.settledAt.flatMap(parseValidDate)
        thread.unsettledAt = shell.unsettledAt.flatMap(parseValidDate)
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

    private func mapInteractionMode(_: InteractionMode) -> FeatureInteractionMode {
        .standard
    }

    private func coreInteractionMode(_: FeatureInteractionMode) -> InteractionMode {
        .default
    }

    /// Reuse mapped models across shell and settings updates. The config
    /// setter invalidates an entry only when its provider snapshots change.
    private var providerCatalogCache: [String: [FeatureProvider]] = [:]

    /// Single write path for server configs so the provider catalog cache can
    /// never go stale against the config that feeds it.
    private func setServerConfig(_ config: ServerConfigSnapshot, environmentID: String) {
        if serverConfigsByEnvironmentID[environmentID]?.providers != config.providers {
            providerCatalogCache[environmentID] = nil
        }
        serverConfigsByEnvironmentID[environmentID] = config
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
                    name: provider.displayName ?? providerDisplayName(provider.driver),
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
                        return FeatureModel(
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
                mapped.setup = provider.setup
                mapped.isEnabled = provider.enabled
                mapped.isInstalled = provider.installed
                mapped.authStatus = provider.auth.status
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
                name: providerDisplayName(providerID),
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
        if let projectDefault = shell?.projects
            .first(where: { $0.id == projectID })?
            .defaultModelSelection {
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
                defaultValue: defaultValue.map(FeatureModelOptionValue.string)
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

    private func providerDisplayName(_ id: String) -> String {
        switch id {
        case "codex": "Codex"
        case "claudeAgent", "claude": "Claude"
        case "cursor": "Cursor"
        case "grok": "Grok"
        case "opencode": "OpenCode"
        case "antigravity": "Antigravity"
        default: id
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
            return provider.displayName ?? providerDisplayName(provider.driver)
        }
        return providerDisplayName(providerID)
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

    private func scheduleAttachmentHydration(
        in detail: FeatureThreadDetail,
        threadID: String,
        client: T3Client,
        environmentID: String
    ) {
        guard detail.messages.contains(where: { message in
            message.attachments.contains { $0.url == nil }
        }) else {
            return
        }
        // Streaming activity can publish many detail revisions per second. Let the
        // current asset resolution finish instead of continuously restarting it.
        guard attachmentHydrationTasks[threadID] == nil else { return }
        let generation = environmentGeneration
        let workID = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            let hydrated = await self.hydratedAttachmentURLs(
                in: detail,
                client: client,
                environmentID: environmentID,
                generation: generation
            )
            guard self.isKnownClient(
                client,
                environmentID: environmentID,
                generation: generation
            ),
                  self.latestDetails[threadID] == detail,
                  hydrated != detail else {
                self.finishAttachmentHydration(threadID: threadID, workID: workID)
                if let latest = self.latestDetails[threadID], latest != detail {
                    self.scheduleAttachmentHydration(
                        in: latest,
                        threadID: threadID,
                        client: client,
                        environmentID: environmentID
                    )
                }
                return
            }
            self.publish(
                hydrated,
                threadID: threadID,
                synchronizeRenderedMessages: true
            )
            self.finishAttachmentHydration(threadID: threadID, workID: workID)
        }
        attachmentHydrationTasks[threadID] = (workID, task)
    }

    private func finishAttachmentHydration(threadID: String, workID: UUID) {
        guard attachmentHydrationTasks[threadID]?.id == workID else { return }
        attachmentHydrationTasks[threadID] = nil
    }

    private func hydratedAttachmentURLs(
        in detail: FeatureThreadDetail,
        client: T3Client,
        environmentID: String,
        generation: Int
    ) async -> FeatureThreadDetail {
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            return detail
        }
        let attachmentMetadata = detail.messages.flatMap(\.attachments).reduce(
            into: [String: (name: String, mimeType: String)]()
        ) { metadata, attachment in
            metadata[attachment.id] = (attachment.name, attachment.mimeType)
        }
        // Threads without attachments refresh every couple of seconds. Skip
        // the resolve pass and full message walk when there is nothing to hydrate.
        guard !attachmentMetadata.isEmpty else { return detail }
        let missingIDs = Array(attachmentMetadata.keys.filter {
            cachedAttachmentURL(for: $0, environmentID: environmentID) == nil
        })

        await withTaskGroup(of: (String, ResolvedAssetURL?).self) { group in
            var iterator = missingIDs.makeIterator()
            for _ in 0..<min(4, missingIDs.count) {
                guard let id = iterator.next() else { break }
                group.addTask {
                    (
                        id,
                        try? await client.resolvedAsset(
                            resource: .attachment(
                                id: id,
                                fileName: attachmentMetadata[id]?.name,
                                mimeType: attachmentMetadata[id]?.mimeType
                            )
                        )
                    )
                }
            }
            while let (id, resolved) = await group.next() {
                if let resolved,
                   isKnownClient(
                       client,
                       environmentID: environmentID,
                       generation: generation
                   ) {
                    let key = AttachmentCacheKey(
                        environmentID: environmentID,
                        attachmentID: id
                    )
                    attachmentURLs[key] = CachedAttachmentURL(
                        url: resolved.url,
                        expiresAt: resolved.expiresAt
                    )
                }
                if isKnownClient(
                    client,
                    environmentID: environmentID,
                    generation: generation
                ),
                   let nextID = iterator.next() {
                    group.addTask {
                        (
                            nextID,
                            try? await client.resolvedAsset(
                                resource: .attachment(
                                    id: nextID,
                                    fileName: attachmentMetadata[nextID]?.name,
                                    mimeType: attachmentMetadata[nextID]?.mimeType
                                )
                            )
                        )
                    }
                }
            }
        }

        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            return detail
        }
        var hydrated = detail
        for messageIndex in hydrated.messages.indices {
            for attachmentIndex in hydrated.messages[messageIndex].attachments.indices {
                let id = hydrated.messages[messageIndex].attachments[attachmentIndex].id
                hydrated.messages[messageIndex].attachments[attachmentIndex].url =
                    cachedAttachmentURL(for: id, environmentID: environmentID)
            }
        }
        return hydrated
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
            || latestTurn?.state == "running"
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
    ) throws -> [UploadChatAttachment] {
        guard attachments.count <= 8 else {
            throw NativeFeatureClientError.tooManyAttachments
        }
        return try attachments.map {
            let reference = $0.uploadedReference.map {
                UploadedAttachmentReference(
                    environmentID: $0.environmentID,
                    attachmentID: $0.attachmentID
                )
            }
            if let ownedFile = $0.ownedFile {
                return try UploadChatAttachment(
                    id: $0.id,
                    fileURL: ownedFile.url,
                    name: $0.name,
                    mimeType: $0.mimeType,
                    sizeBytes: ownedFile.byteCount,
                    uploadedReference: reference
                )
            }
            return try UploadChatAttachment(
                id: $0.id,
                data: $0.data,
                name: $0.name,
                mimeType: $0.mimeType,
                uploadedReference: reference
            )
        }
    }

    private func requireScope(_ scope: String, client: T3Client) async throws {
        let session = try await client.authSession()
        guard session.scopes?.contains(scope) == true else {
            throw NativeFeatureClientError.missingScope(scope)
        }
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

    private func previewText(_ text: String?) -> String? {
        guard let text else { return nil }
        let compact = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !compact.isEmpty else { return nil }
        return compact.count > 160 ? "\(compact.prefix(157))..." : compact
    }

    private func loadSettings() -> FeatureSettings {
        guard let data = settingsStore.data(forKey: Self.settingsKey),
              let settings = try? JSONDecoder().decode(FeatureSettings.self, from: data) else {
            return FeatureSettings()
        }
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
    var isInitialized = false
    var messagesByID: [String: FeatureMessage] = [:]
    var mergedMessages: [FeatureMessage] = []
    var mergedIndexByID: [String: Int] = [:]
    var workLogsByGroupID: [String: NativeWorkLogAccumulator] = [:]
    var workLogActivityIDs: Set<String> = []
    var approvals: [FeatureApproval] = []
    var userInputs: [FeatureUserInput] = []
    var subagents = FeatureActiveSubagentTracker()
    var compaction = NativeContextCompactionState()
}

enum NativeActivityNotice {
    static func accepts(_ activity: OrchestrationActivity) -> Bool {
        activity.tone == "error" || activity.kind == "runtime.warning"
            || activity.kind == "context-compaction"
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

/// The latest compaction request and its matching result survive live updates
/// without scanning the retained activity history for each streamed token.
struct NativeContextCompactionState {
    private var requestID: String?
    private var requestedAt: Date?
    private var settled = false

    mutating func apply(_ message: OrchestrationMessage, createdAt: Date) {
        guard message.role == "user",
              FeatureContextCompaction.isCommand(
                message.text, hasAttachments: message.attachments?.isEmpty == false
              ) else { return }
        if let requestedAt, createdAt < requestedAt { return }
        if requestID != message.id {
            requestID = message.id
            requestedAt = createdAt
            settled = false
        }
    }

    mutating func apply(_ activity: OrchestrationActivity) {
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
        supportsRestartContinuation: Bool
    ) -> ServerSettingsChange? {
        guard !supportsRestartContinuation else { return change }
        switch change {
        case .continueThreadsAfterServerUpdate:
            return nil
        case let .sharedPreferences(.object(fields)):
            var fields = fields
            fields.removeValue(forKey: "continueThreadsAfterServerUpdate")
            return fields.isEmpty ? nil : .sharedPreferences(.object(fields))
        default:
            return change
        }
    }
}

struct NativeWorkLogAccumulator {
    private static let terminalKinds = Set([
        "tool.completed", "task.completed", "turn.plan.updated",
    ])
    private static let activeKinds = Set(["tool.started", "tool.updated"])
    private static let imageExtensions = Set([
        "avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp",
    ])

    private(set) var count = 0
    private var visibleLines: [String] = []
    private var createdAt = Date.distantPast
    private var activeEntries: [String: String] = [:]
    private var activeOrder: [String] = []
    private var imagePaths: [String] = []
    private var toolPresentation: ToolActivityPresentation?
    private var activePresentations: [String: ToolActivityPresentation] = [:]

    var hasActiveWork: Bool { !activeEntries.isEmpty }
    var hasContent: Bool { count > 0 || hasActiveWork || !imagePaths.isEmpty }

    static func accepts(_ activity: OrchestrationActivity) -> Bool {
        activeKinds.contains(activity.kind)
            || (activity.tone != "error" && terminalKinds.contains(activity.kind))
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
            guard activity.tone != "error" else { return }
            count += 1
            visibleLines.append("• \(preview ?? activity.summary)")
            if visibleLines.count > 40 {
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
        to thread: OrchestrationThread
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

        let result: NativeThreadDetailReductionResult
        var renderMutation = NativeDetailRenderMutation.metadata
        switch type {
        case "thread.settled":
            result = reduceSettled(payload: payload, thread: thread)
        case "thread.unsettled":
            result = reduceUnsettled(payload: payload, thread: thread)
        case "thread.meta-updated":
            result = reduceMetadata(payload: payload, occurredAt: occurredAt, thread: thread)
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
        return .updated(
            replacing(
                thread,
                settlement: SettlementReplacement(
                    override: "settled",
                    settledAt: settledAt,
                    unsettledAt: nil
                ),
                updatedAt: updatedAt
            )
        )
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

    private static func reduceMetadata(
        payload: JSONValue,
        occurredAt: String,
        thread: OrchestrationThread
    ) -> NativeThreadDetailReductionResult {
        guard case let .object(values) = payload,
              let rawLink = values["linkedPullRequest"] else {
            return .refresh
        }
        guard !["title", "modelSelection", "branch", "worktreePath"].contains(where: {
            values[$0] != nil
        }) else {
            return .refresh
        }
        let linkedPullRequest: ThreadLinkedPullRequest?
        if rawLink == .null {
            linkedPullRequest = nil
        } else {
            guard let decoded = try? rawLink.decode(ThreadLinkedPullRequest.self) else {
                return .refresh
            }
            linkedPullRequest = decoded
        }
        var updated = replacing(
            thread,
            updatedAt: payload["updatedAt"]?.stringValue ?? occurredAt
        )
        updated.linkedPullRequest = linkedPullRequest
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
                updatedAt: streaming ? existing.updatedAt : updatedAt
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
                updatedAt: updatedAt
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
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            linkedPullRequest: thread.linkedPullRequest,
            latestTurn: latestTurn ?? thread.latestTurn,
            createdAt: thread.createdAt,
            updatedAt: updatedAt,
            archivedAt: thread.archivedAt,
            settledOverride: settlement == nil ? thread.settledOverride : settlement?.override,
            settledAt: settlement == nil ? thread.settledAt : settlement?.settledAt,
            unsettledAt: settlement == nil ? thread.unsettledAt : settlement?.unsettledAt,
            snoozedUntil: thread.snoozedUntil,
            snoozedAt: thread.snoozedAt,
            pinnedAt: thread.pinnedAt,
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

private struct NativeThreadRoute {
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
}

@MainActor
private final class NativeSourceControlMonitor {
    let id = UUID()
    var latestStatus: FeatureSourceControlStatus?
    var continuations: [UUID: AsyncStream<FeatureSourceControlStatus>.Continuation] = [:]
    var task: Task<Void, Never>?
}

private struct ProvisionalThreadRoute {
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
    case missingScope(String)
    case tooManyAttachments
    case invalidAutomaticSettlementDays

    var errorDescription: String? {
        switch self {
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
        case .missingScope: "This connection does not have permission to manage devices."
        case .tooManyAttachments: "You can attach up to 8 files per message."
        case .invalidAutomaticSettlementDays: "Choose a value from 1 to 90 days."
        }
    }
}
