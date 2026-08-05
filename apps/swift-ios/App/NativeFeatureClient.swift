import Foundation

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
    FeatureProjectCreationClient, FeatureWorkspaceAssetResolving, T3ConnectCapable
{
    private let runtime: EnvironmentRuntime
    let t3ConnectController: T3ConnectController
    private let hasMatchingT3ConnectController: Bool
    private let settingsStore: UserDefaults
    private let fallbackPollingInitialDelay: Duration
    private let fallbackPollingInterval: Duration
    private let aggregateRefreshInterval: Duration
    private let environmentShellTimeoutInterval: TimeInterval
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
    private var environmentConnectionStates: [String: FeatureConnection.State] = [:]
    private var environmentConnectionDetails: [String: String] = [:]
    private var latestServerConfig: ServerConfigSnapshot?
    private var serverConfigsByEnvironmentID: [String: ServerConfigSnapshot] = [:]
    private var latestSnapshot: FeatureSnapshot?
    private var activeThreadID: String?
    private var activeThreadEnvironmentID: String?
    private var latestDetails: [String: FeatureThreadDetail] = [:]
    private var detailRenderCaches: [String: NativeDetailRenderCache] = [:]
    private var attachmentURLs: [AttachmentCacheKey: CachedAttachmentURL] = [:]
    private var pendingBootstrapSubmissions: [PendingBootstrapSubmission] = []
    private var pendingTurnSubmissions: [String: PendingTurnSubmission] = [:]
    private var attachmentHydrationTasks: [
        String: (id: UUID, task: Task<Void, Never>)
    ] = [:]
    private var approvalRoutes: [String: PendingRequestRoute] = [:]
    private var inputRoutes: [String: PendingRequestRoute] = [:]
    private var terminalIDs: [String: String] = [:]
    private var terminalSnapshots: [String: FeatureTerminalSnapshot] = [:]
    private var terminalContinuations: [
        String: [UUID: AsyncStream<FeatureTerminalSnapshot>.Continuation]
    ] = [:]
    private var pollingTask: Task<Void, Never>?
    private var fallbackPollingTask: Task<Void, Never>?
    private var configurationTask: Task<Void, Never>?
    private var aggregateRefreshTask: Task<Void, Never>?
    private var aggregateRefreshID: UUID?
    private var shellPublishTask: Task<Void, Never>?
    private var archivedRefreshTask: Task<Void, Never>?
    private var detailRefreshTask: Task<Void, Never>?
    private var detailStreamTask: Task<Void, Never>?
    private var detailPublishTask: Task<Void, Never>?
    private var passiveDetailPollingTask: Task<Void, Never>?
    private var detailRefreshPending = false
    private var detailRefreshGeneration = 0
    private var detailStreamGeneration = 0
    private var pendingDetailRenderMutations = NativeDetailRenderMutations()
    private var environmentGeneration = 0
    private var lastShellEventAt: Date?
    private var activeRawThread: OrchestrationThread?
    private var activeThreadSequence: Int?

    init(
        runtime: EnvironmentRuntime? = nil,
        t3ConnectController: T3ConnectController? = nil,
        settingsStore: UserDefaults = .standard,
        fallbackPollingInitialDelay: Duration = .seconds(3),
        fallbackPollingInterval: Duration = .seconds(2),
        aggregateRefreshInterval: Duration = .seconds(20),
        environmentShellTimeoutInterval: TimeInterval = 6,
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
        hasMatchingT3ConnectController = t3ConnectController != nil || runtime == nil
        self.runtime = runtime ?? EnvironmentRuntime(
            managedAuthorization: T3ConnectRuntimeAuthorization(controller: controller)
        )
        self.settingsStore = settingsStore
        self.fallbackPollingInitialDelay = fallbackPollingInitialDelay
        self.fallbackPollingInterval = fallbackPollingInterval
        self.aggregateRefreshInterval = aggregateRefreshInterval
        self.environmentShellTimeoutInterval = environmentShellTimeoutInterval
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
        detailPublishTask?.cancel()
        passiveDetailPollingTask?.cancel()
        attachmentHydrationTasks.values.forEach { $0.task.cancel() }
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
        let loads = await loadEnvironmentShells(environments)
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
              httpBaseURL.host != nil,
              webSocketBaseURL.host != nil else {
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

    func activateEnvironment(id: String) async throws {
        let activated = try await runtime.activate(id: id)
        await adoptEnvironment(activated.environment, client: activated)
        startPolling(activated)
    }

    func removeEnvironment(id: String) async throws {
        if activeEnvironment?.id == id {
            await clearActiveEnvironment(disconnectClient: false)
        }
        try await runtime.remove(id: id)
    }

    func disconnect() async {
        await clearActiveEnvironment()
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
        passiveDetailPollingTask?.cancel()
        pollingTask = nil
        fallbackPollingTask = nil
        configurationTask = nil
        aggregateRefreshTask = nil
        aggregateRefreshID = nil
        archivedRefreshTask = nil
        passiveDetailPollingTask = nil
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
        passiveDetailPollingTask?.cancel()
        pollingTask = nil
        fallbackPollingTask = nil
        configurationTask = nil
        aggregateRefreshTask = nil
        aggregateRefreshID = nil
        archivedRefreshTask = nil
        passiveDetailPollingTask = nil
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
        latestDetails.removeAll()
        detailRenderCaches.removeAll()
        attachmentURLs.removeAll()
        pendingBootstrapSubmissions.removeAll()
        pendingTurnSubmissions.removeAll()
        approvalRoutes.removeAll()
        inputRoutes.removeAll()
        finishTerminalStreams()
        terminalIDs.removeAll()
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
        guard let shell = try? await client.shellSnapshot(),
              isKnownClient(client, environmentID: environment.id, generation: generation),
              shell.projects.contains(where: {
                  $0.id == projectID
                    || ProjectCreationPath.normalizedForComparison($0.workspaceRoot)
                        == ProjectCreationPath.normalizedForComparison(path)
              }) else {
            return false
        }
        shellsByEnvironmentID[environment.id] = shell
        if activeEnvironment?.id == environment.id {
            latestShell = shell
        }
        rebuildEntityIndexes((try? await runtime.environments()) ?? [environment])
        await emitSnapshot(shell, environment: environment)
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
        let threadID = UUID().uuidString
        let model = modelSelection(
            selection,
            projectID: route.wireID,
            environmentID: environment.id,
            shell: shellsByEnvironmentID[environment.id]
        )
        let resolvedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let threadTitle = resolvedTitle?.isEmpty == false ? resolvedTitle! : "New thread"
        _ = try await client.createThread(
            threadID: threadID,
            projectID: route.wireID,
            title: threadTitle,
            model: model,
            runtimeMode: .fullAccess
        )
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        registerProvisionalThread(wireID: threadID, environmentID: environment.id)
        if let shell = try? await client.shellSnapshot() {
            guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
                throw CancellationError()
            }
            shellsByEnvironmentID[environment.id] = shell
            if activeEnvironment?.id == environment.id {
                latestShell = shell
            }
            await emitSnapshot(shell, environment: environment)
            if let created = shell.threads.first(where: { $0.id == threadID }) {
                provisionalThreadRoutes[FeatureScopedID.thread(
                    environmentID: environment.id,
                    wireID: threadID
                )] = nil
                return mapThread(created, environment: environment)
            }
        }
        return FeatureThread(
            id: FeatureScopedID.thread(environmentID: environment.id, wireID: threadID),
            wireID: threadID,
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
        if let shell = try? await client.shellSnapshot() {
            guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
                throw CancellationError()
            }
            shellsByEnvironmentID[environment.id] = shell
            if activeEnvironment?.id == environment.id {
                latestShell = shell
            }
            await emitSnapshot(shell, environment: environment)
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
            runtimeMode: runtimeMode.mobileNormalized,
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

    func renameThread(id: String, title: String) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.rename(threadID: route.wireID, title: title)
        updateCachedArchivedThread(id: route.uiID) { $0.title = title }
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
            passiveDetailPollingTask?.cancel()
            passiveDetailPollingTask = nil
            activeThreadID = nil
            activeThreadEnvironmentID = nil
        }
        latestDetails[route.uiID] = nil
        detailRenderCaches[route.uiID] = nil
        await emitCachedSnapshot(for: route.environmentID)
        try? await refresh(client: route.client, includeArchived: true)
    }

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        let route = try threadRoute(for: id)
        let client = route.client
        let environment = client.environment
        let generation = environmentGeneration
        resetDetailRefresh()
        resetDetailStream()
        passiveDetailPollingTask?.cancel()
        passiveDetailPollingTask = nil
        activeThreadID = route.uiID
        activeThreadEnvironmentID = environment.id
        let snapshot = try await client.threadSnapshot(id: route.wireID)
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        let detail = mapDetail(snapshot.thread, environment: environment)
        activeRawThread = snapshot.thread
        activeThreadSequence = snapshot.snapshotSequence
        latestDetails[route.uiID] = detail
        scheduleAttachmentHydration(
            in: detail,
            threadID: route.uiID,
            client: client,
            environmentID: environment.id
        )
        startDetailStream(route, after: snapshot.snapshotSequence)
        return detail
    }

    func releaseThread(id: String) {
        guard activeThreadID == id else { return }
        resetDetailRefresh()
        resetDetailStream()
        passiveDetailPollingTask?.cancel()
        passiveDetailPollingTask = nil
        activeThreadID = nil
        activeThreadEnvironmentID = nil
        activeRawThread = nil
        activeThreadSequence = nil
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
            attachments: attachments,
            submissionIdentity: identity
        )
    }

    private func sendMessageResolved(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
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
        let runtimeMode = coreRuntimeMode(mapRuntimeMode(shellThread.runtimeMode))
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
        let wireDecision = switch decision {
        case .allowOnce: "accept"
        case .allowForSession: "acceptForSession"
        case .deny: "decline"
        }
        _ = try await route.client.respondToApproval(
            threadID: route.wireID,
            requestID: request.wireID,
            decision: wireDecision
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

    func loadDeviceSessions() async throws -> [FeatureDeviceSession] {
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
        let client = try requireClient()
        try await requireScope("access:write", client: client)
        guard try await client.revokeClientSession(id: id) else {
            throw NativeFeatureClientError.deviceSessionNotFound
        }
    }

    func revokeOtherDeviceSessions() async throws {
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

    func terminalSnapshot(threadID: String) async throws -> FeatureTerminalSnapshot {
        let route = try threadRoute(for: threadID)
        if let snapshot = terminalSnapshots[route.uiID] {
            return snapshot
        }
        let context = try workspaceContext(route: route)
        return FeatureTerminalSnapshot(
            threadID: route.uiID,
            workingDirectory: context.cwd
        )
    }

    func terminalEvents(threadID: String) -> AsyncStream<FeatureTerminalSnapshot> {
        guard let route = try? threadRoute(for: threadID) else {
            return AsyncStream { continuation in continuation.finish() }
        }
        let environmentID = route.environmentID
        let client = route.client
        let uiThreadID = route.uiID
        let generation = environmentGeneration
        return AsyncStream { continuation in
            let subscriptionID = UUID()
            terminalContinuations[uiThreadID, default: [:]][subscriptionID] = continuation
            if let snapshot = terminalSnapshots[uiThreadID] {
                continuation.yield(snapshot)
            }
            let task = Task { [weak self] in
                do {
                    for try await event in await client.terminalEvents() {
                        guard !Task.isCancelled else { break }
                        guard let self else { break }
                        guard self.isKnownClient(
                            client,
                            environmentID: environmentID,
                            generation: generation
                        ) else {
                            break
                        }
                        guard event.threadId == route.wireID else { continue }
                        if let terminalID = self.terminalIDs[uiThreadID],
                           event.terminalId != nil,
                           event.terminalId != terminalID {
                            continue
                        }
                        let snapshot = self.consumeTerminalEvent(event, threadID: uiThreadID)
                        self.publishTerminal(snapshot, threadID: uiThreadID)
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
                    var snapshot = self.terminalSnapshots[uiThreadID]
                        ?? FeatureTerminalSnapshot(threadID: uiThreadID)
                    snapshot.state = .failed
                    snapshot.error = error.localizedDescription
                    self.terminalSnapshots[uiThreadID] = snapshot
                    self.publishTerminal(snapshot, threadID: uiThreadID)
                    continuation.finish()
                }
            }
            continuation.onTermination = { @Sendable [weak self] _ in
                task.cancel()
                Task { @MainActor in
                    self?.terminalContinuations[uiThreadID]?[subscriptionID] = nil
                    if self?.terminalContinuations[uiThreadID]?.isEmpty == true {
                        self?.terminalContinuations[uiThreadID] = nil
                    }
                }
            }
        }
    }

    func openTerminal(threadID: String, columns: Int, rows: Int) async throws {
        let route = try threadRoute(for: threadID)
        let client = route.client
        let environmentID = route.environmentID
        let generation = environmentGeneration
        let context = try workspaceContext(route: route)
        let terminalID = terminalIDs[route.uiID] ?? UUID().uuidString
        terminalIDs[route.uiID] = terminalID
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
        terminalSnapshots[route.uiID] = scoped
        publishTerminal(scoped, threadID: route.uiID)
    }

    func writeTerminal(threadID: String, data: String) async throws {
        let route = try threadRoute(for: threadID)
        let terminalID = try requireTerminalID(threadID: route.uiID)
        try await route.client.writeTerminal(
            threadID: route.wireID,
            terminalID: terminalID,
            data: data
        )
    }

    func resizeTerminal(threadID: String, columns: Int, rows: Int) async throws {
        let route = try threadRoute(for: threadID)
        let terminalID = try requireTerminalID(threadID: route.uiID)
        try await route.client.resizeTerminal(
            threadID: route.wireID,
            terminalID: terminalID,
            columns: columns,
            rows: rows
        )
    }

    func closeTerminal(threadID: String) async throws {
        let route = try threadRoute(for: threadID)
        let client = route.client
        let environmentID = route.environmentID
        let generation = environmentGeneration
        let terminalID = try requireTerminalID(threadID: route.uiID)
        try await client.closeTerminal(threadID: route.wireID, terminalID: terminalID)
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        terminalIDs[route.uiID] = nil
        let snapshot = FeatureTerminalSnapshot(threadID: route.uiID)
        terminalSnapshots[route.uiID] = snapshot
        publishTerminal(snapshot, threadID: route.uiID)
    }

    private func requireClient() throws -> T3Client {
        guard let client else { throw NativeFeatureClientError.notConnected }
        return client
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
            latestTurn: thread.latestTurn,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            archivedAt: nil,
            settledOverride: thread.settledOverride,
            settledAt: thread.settledAt,
            snoozedUntil: thread.snoozedUntil,
            snoozedAt: thread.snoozedAt,
            pinnedAt: thread.pinnedAt,
            session: thread.session,
            latestUserMessageAt: thread.latestUserMessageAt,
            hasPendingApprovals: thread.hasPendingApprovals,
            hasPendingUserInput: thread.hasPendingUserInput,
            hasActionableProposedPlan: thread.hasActionableProposedPlan
        )
    }

    private func emitCachedSnapshot(for environmentID: String) async {
        guard let environment = environmentClients[environmentID]?.environment,
              let shell = shellsByEnvironmentID[environmentID] else {
            return
        }
        await emitSnapshot(shell, environment: environment)
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

    private func requireTerminalID(threadID: String) throws -> String {
        guard let terminalID = terminalIDs[threadID] else {
            throw NativeFeatureClientError.terminalNotOpen
        }
        return terminalID
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
        threadID: String
    ) -> FeatureTerminalSnapshot {
        if let coreSnapshot = event.snapshot {
            var snapshot = NativeWorkspaceMapper.terminal(coreSnapshot)
            snapshot.threadID = threadID
            terminalIDs[threadID] = coreSnapshot.terminalId
            terminalSnapshots[threadID] = snapshot
            return snapshot
        }

        var snapshot = terminalSnapshots[threadID]
            ?? FeatureTerminalSnapshot(threadID: threadID)
        switch event.type {
        case "output":
            snapshot.buffer.append(NativeWorkspaceMapper.terminalText(event.data ?? ""))
        case "exited":
            snapshot.state = .exited
            snapshot.exitCode = event.exitCode
        case "closed":
            snapshot.state = .stopped
        case "error":
            snapshot.state = .failed
            snapshot.error = event.message
        case "cleared":
            snapshot.buffer = ""
        case "activity":
            snapshot.title = event.label ?? snapshot.title
        default:
            break
        }
        terminalSnapshots[threadID] = snapshot
        return snapshot
    }

    private func publishTerminal(
        _ snapshot: FeatureTerminalSnapshot,
        threadID: String
    ) {
        for continuation in terminalContinuations[threadID]?.values ?? [:].values {
            continuation.yield(snapshot)
        }
    }

    private func finishTerminalStreams() {
        for continuations in terminalContinuations.values {
            for continuation in continuations.values {
                continuation.finish()
            }
        }
        terminalContinuations.removeAll()
    }

    private func startPolling(_ activeClient: T3Client) {
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        let generation = environmentGeneration
        pollingTask = Task { [weak self] in
            do {
                await activeClient.connect()
                guard let self,
                      self.isCurrentSession(client: activeClient, generation: generation) else {
                    return
                }
                let sequence = self.latestShell?.snapshotSequence
                for try await item in await activeClient.shellEvents(after: sequence) {
                    guard !Task.isCancelled,
                          self.isCurrentSession(
                              client: activeClient,
                              generation: generation
                          ) else {
                        break
                    }
                    self.lastShellEventAt = .now
                    self.emitConnection(.connected)
                    switch item {
                    case let .snapshot(shell):
                        await self.consume(
                            shell: shell,
                            client: activeClient,
                            refreshActiveThread: true
                        )
                    case .projectUpserted, .projectRemoved, .threadUpserted, .threadRemoved:
                        await self.consume(delta: item, client: activeClient)
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
                  self.isCurrentSession(client: activeClient, generation: generation) else {
                return
            }
            self.emitConnection(
                .reconnecting,
                detail: "Live updates paused. Refreshing over HTTP."
            )
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
                        self.serverConfigsByEnvironmentID[activeClient.environment.id] = config
                    case let .providerStatuses(providers):
                        let settings = self.serverConfigsByEnvironmentID[
                            activeClient.environment.id
                        ]?.settings
                        let config = ServerConfigSnapshot(
                            providers: providers,
                            settings: settings
                        )
                        self.latestServerConfig = config
                        self.serverConfigsByEnvironmentID[activeClient.environment.id] = config
                    case let .settingsUpdated(settings):
                        let providers = self.serverConfigsByEnvironmentID[
                            activeClient.environment.id
                        ]?.providers ?? self.latestServerConfig?.providers ?? []
                        let config = ServerConfigSnapshot(
                            providers: providers,
                            settings: settings
                        )
                        self.latestServerConfig = config
                        self.serverConfigsByEnvironmentID[activeClient.environment.id] = config
                    case .unrelated:
                        continue
                    }
                    if let shell = self.latestShell {
                        await self.emitSnapshot(shell)
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
                    $0.id != activeEnvironment.id
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
        refreshActiveThread: Bool
    ) async {
        guard let currentClient = self.client, currentClient === client else { return }
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = shell
        await emitSnapshot(shell)
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
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = shell
        await emitSnapshot(
            shell,
            markSourceConnected: false,
            expectedGeneration: generation
        )
        guard isCurrentSession(client: client, generation: generation),
              let threadID = activeThreadID else {
            return
        }
        scheduleDetailRefresh(threadID: threadID, client: client)
    }

    private func consume(delta: ShellStreamItem, client: T3Client) async {
        guard let currentClient = self.client, currentClient === client else { return }
        guard let current = latestShell else {
            if let shell = try? await client.shellSnapshot() {
                await consume(shell: shell, client: client, refreshActiveThread: true)
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
        case .snapshot, .synchronized:
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
            changedThreadID = activeEnvironment.map {
                FeatureScopedID.thread(environmentID: $0.id, wireID: thread.id)
            }
            if let environmentID = activeEnvironment?.id {
                archivedThreadsByEnvironmentID[environmentID]?.removeAll {
                    ($0.wireID ?? $0.id) == thread.id
                }
            }
            if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                threads[index] = thread
            } else {
                threads.append(thread)
            }
        case let .threadRemoved(_, threadID):
            let uiThreadID = activeEnvironment.map {
                FeatureScopedID.thread(environmentID: $0.id, wireID: threadID)
            }
            changedThreadID = uiThreadID
            shouldRefreshArchived = true
            threads.removeAll { $0.id == threadID }
            if let uiThreadID {
                latestDetails[uiThreadID] = nil
                detailRenderCaches[uiThreadID] = nil
            }
            if activeThreadID == uiThreadID {
                resetDetailRefresh()
                resetDetailStream()
                activeThreadID = nil
                activeThreadEnvironmentID = nil
                activeRawThread = nil
                activeThreadSequence = nil
            }
        case .snapshot, .synchronized:
            return
        }

        let shell = OrchestrationShellSnapshot(
            snapshotSequence: sequence,
            projects: projects,
            threads: threads,
            updatedAt: current.updatedAt
        )
        latestShell = shell
        scheduleShellPublish(client)
        if shouldRefreshArchived, let environment = activeEnvironment {
            scheduleArchivedRefresh(client: client, environment: environment)
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
            self.shellPublishTask = nil
            guard !Task.isCancelled,
                  self.isCurrentSession(client: client, generation: generation),
                  let shell = self.latestShell else {
                return
            }
            await self.emitSnapshot(shell)
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
                // Four updates per second keeps streaming text responsive while
                // coalescing bursty shell events into one detail snapshot.
                try await Task.sleep(for: .milliseconds(250))
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
                try? await self.refreshThread(id: threadID, client: client)
            }
            self.finishDetailRefresh(generation: generation, client: client)
        }
    }

    private func startDetailStream(_ route: NativeThreadRoute, after sequence: Int) {
        detailStreamGeneration &+= 1
        let streamGeneration = detailStreamGeneration
        let sessionGeneration = environmentGeneration
        detailStreamTask = Task { [weak self] in
            do {
                for try await item in await route.client.threadEvents(
                    threadID: route.wireID,
                    after: sequence
                ) {
                    guard !Task.isCancelled,
                          let self,
                          self.detailStreamGeneration == streamGeneration,
                          self.activeThreadID == route.uiID,
                          self.isKnownClient(
                              route.client,
                              environmentID: route.environmentID,
                              generation: sessionGeneration
                          ) else {
                        break
                    }
                    self.consumeDetailStreamItem(item, route: route)
                }
            } catch is CancellationError {
                return
            } catch {
                // Shell-driven HTTP refresh remains the compatibility fallback.
            }
            guard let self else { return }
            self.finishDetailStream(
                generation: streamGeneration,
                route: route,
                sessionGeneration: sessionGeneration
            )
        }
    }

    private func consumeDetailStreamItem(
        _ item: ThreadStreamItem,
        route: NativeThreadRoute
    ) {
        switch item {
        case .synchronized:
            return
        case let .snapshot(snapshot):
            guard snapshot.snapshotSequence > (activeThreadSequence ?? 0) else { return }
            activeThreadSequence = snapshot.snapshotSequence
            activeRawThread = snapshot.thread
            scheduleRawDetailPublish(route: route, mutation: .full)
        case let .event(event):
            guard let current = activeRawThread else {
                scheduleDetailRefresh(threadID: route.uiID, client: route.client, force: true)
                return
            }
            let reduction = NativeThreadDetailReducer.apply(event, to: current)
            if reduction.sequence < 0 {
                activeRawThread = nil
                discardPendingDetailPublish()
                scheduleDetailRefresh(threadID: route.uiID, client: route.client, force: true)
                return
            }
            guard reduction.sequence > (activeThreadSequence ?? 0) else { return }
            switch reduction.result {
            case let .updated(thread):
                activeThreadSequence = reduction.sequence
                activeRawThread = thread
                scheduleRawDetailPublish(route: route, mutation: reduction.renderMutation)
            case .unchanged:
                activeThreadSequence = reduction.sequence
            case .refresh:
                activeThreadSequence = reduction.sequence
                activeRawThread = nil
                discardPendingDetailPublish()
                scheduleDetailRefresh(threadID: route.uiID, client: route.client, force: true)
            }
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
            self.detailPublishTask = nil
            guard !Task.isCancelled,
                  self.detailStreamGeneration == streamGeneration,
                  self.activeThreadID == route.uiID,
                  let rawThread = self.activeRawThread else {
                return
            }
            let mutations = self.pendingDetailRenderMutations
            self.pendingDetailRenderMutations = NativeDetailRenderMutations()
            let previousDetail = self.latestDetails[route.uiID]
            let detail = self.mapDetail(
                rawThread,
                environment: route.client.environment,
                mutations: mutations
            )
            let delta = self.makeDetailDelta(
                previous: previousDetail,
                next: detail,
                mutations: mutations
            )
            self.publish(
                detail,
                threadID: route.uiID,
                renderCacheIsSource: true,
                delta: delta
            )
            self.scheduleAttachmentHydration(
                in: detail,
                threadID: route.uiID,
                client: route.client,
                environmentID: route.environmentID
            )
        }
    }

    private func finishDetailStream(
        generation: Int,
        route: NativeThreadRoute,
        sessionGeneration: Int
    ) {
        guard detailStreamGeneration == generation,
              activeThreadID == route.uiID,
              isKnownClient(
                  route.client,
                  environmentID: route.environmentID,
                  generation: sessionGeneration
              ) else {
            return
        }
        detailStreamTask = nil
        scheduleDetailRefresh(threadID: route.uiID, client: route.client)
        startPassiveDetailPolling(route)
    }

    /// Passive environments intentionally avoid full shell WebSocket streams.
    /// A selected passive thread is still live enough to drive remotely.
    private func startPassiveDetailPolling(_ route: NativeThreadRoute) {
        passiveDetailPollingTask?.cancel()
        passiveDetailPollingTask = nil
        guard route.environmentID != activeEnvironment?.id else { return }
        let generation = environmentGeneration
        passiveDetailPollingTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(2))
                } catch {
                    return
                }
                guard let self,
                      self.activeThreadID == route.uiID,
                      self.isKnownClient(
                          route.client,
                          environmentID: route.environmentID,
                          generation: generation
                      ) else {
                    return
                }
                try? await self.refreshThread(id: route.uiID, client: route.client)
            }
        }
    }

    private func finishDetailRefresh(generation: Int, client: T3Client) {
        guard detailRefreshGeneration == generation else { return }
        detailRefreshTask = nil
        let needsTrailingRefresh = detailRefreshPending
        detailRefreshPending = false
        if needsTrailingRefresh, let threadID = activeThreadID {
            scheduleDetailRefresh(threadID: threadID, client: client)
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
        detailStreamTask?.cancel()
        detailStreamTask = nil
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
                serverConfigsByEnvironmentID[load.environment.id] = config
                if load.environment.id == activeEnvironment?.id {
                    latestServerConfig = config
                }
            }
            if let shell = load.shell {
                shellsByEnvironmentID[load.environment.id] = shell
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
        shellsByEnvironmentID[environment.id] = shell
        if activeEnvironment?.id == environment.id {
            latestShell = shell
        }
        rebuildEntityIndexes(
            (try? await runtime.environments()) ?? [environment]
        )
        if includeArchived,
           let archivedShell = try? await client.archivedShellSnapshot(),
           isKnownClient(client, environmentID: environment.id, generation: generation) {
            archivedThreadsByEnvironmentID[environment.id] = archivedShell.threads.map {
                mapThread($0, environment: environment)
            }
            archivedShellThreadsByEnvironmentID[environment.id] = Dictionary(
                uniqueKeysWithValues: archivedShell.threads.map { ($0.id, $0) }
            )
            rebuildEntityIndexes((try? await runtime.environments()) ?? [environment])
        }
        await emitSnapshot(shell, environment: environment)
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
            self.rebuildEntityIndexes(
                (try? await self.runtime.environments()) ?? [environment]
            )
            if let shell = self.latestShell {
                await self.emitSnapshot(shell)
            }
        }
    }

    private func refreshThread(id: String, client: T3Client) async throws {
        let route = try threadRoute(for: id)
        guard route.client === client else {
            throw NativeFeatureClientError.threadNotFound
        }
        let environment = route.client.environment
        let generation = environmentGeneration
        let snapshot = try await client.threadSnapshot(id: route.wireID)
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        if activeThreadID == route.uiID {
            guard snapshot.snapshotSequence >= (activeThreadSequence ?? 0) else { return }
            activeRawThread = snapshot.thread
            activeThreadSequence = snapshot.snapshotSequence
        }
        let detail = mapDetail(snapshot.thread, environment: environment)
        publish(detail, threadID: route.uiID)
        let hydrationBase = latestDetails[route.uiID] ?? detail
        let hydrated = await hydratedAttachmentURLs(
            in: hydrationBase,
            client: client,
            environmentID: environment.id,
            generation: generation
        )
        guard isKnownClient(client, environmentID: environment.id, generation: generation),
              latestDetails[route.uiID] == hydrationBase,
              hydrated != hydrationBase else {
            return
        }
        publish(hydrated, threadID: route.uiID, synchronizeRenderedMessages: true)
    }

    private func emitSnapshot(
        _ shell: OrchestrationShellSnapshot,
        environment sourceEnvironment: Environment? = nil,
        markSourceConnected: Bool = true,
        expectedGeneration: Int? = nil
    ) async {
        guard let environment = activeEnvironment else { return }
        let sourceEnvironment = sourceEnvironment ?? environment
        let generation = environmentGeneration
        guard expectedGeneration == nil || expectedGeneration == generation else { return }
        let environments = (try? await runtime.environments()) ?? [environment]
        guard generation == environmentGeneration,
              expectedGeneration == nil || expectedGeneration == environmentGeneration,
              activeEnvironment?.id == environment.id else {
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
            if activity.tone == "error" {
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
            userInputs: replacingChangedSuffix(current.userInputs, with: incoming.userInputs)
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
        }
        continuation.yield(
            .connection(connection)
        )
    }

    private func makeSnapshot(
        environments: [Environment],
        activeEnvironment: Environment,
        connectionState: FeatureConnection.State,
        connectionDetail: String? = nil
    ) -> FeatureSnapshot {
        let threads = environments.flatMap { environment in
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
        let projects = environments.flatMap { environment in
            (shellsByEnvironmentID[environment.id]?.projects ?? []).map { project in
                let uiID = FeatureScopedID.project(
                    environmentID: environment.id,
                    wireID: project.id
                )
                return FeatureProject(
                    id: uiID,
                    wireID: project.id,
                    environmentID: environment.id,
                    name: project.title,
                    path: project.workspaceRoot,
                    threadCount: threadCountByProjectID[uiID, default: 0],
                    defaultSelection: project.defaultModelSelection.map(mapSelection)
                )
            }
        }
        let providersByEnvironment = environments.reduce(
            into: [String: [FeatureProvider]]()
        ) { catalogues, environment in
            guard let shell = shellsByEnvironmentID[environment.id] else { return }
            catalogues[environment.id] = mapProviders(
                shell,
                config: serverConfigsByEnvironmentID[environment.id]
            )
        }
        let preferencesByEnvironment = environments.reduce(
            into: [String: FeatureEnvironmentPreferences]()
        ) { preferences, environment in
            guard let serverSettings = serverConfigsByEnvironmentID[environment.id]?.settings else {
                return
            }
            let defaultWorkspaceMode: FeatureWorkspaceMode =
                switch serverSettings.defaultThreadEnvMode {
                case .local: .local
                case .worktree: .worktree
                }
            preferences[environment.id] = FeatureEnvironmentPreferences(
                defaultWorkspaceMode: defaultWorkspaceMode,
                newWorktreesStartFromOrigin: serverSettings.newWorktreesStartFromOrigin
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
        FeatureEnvironment(
            id: environment.id,
            name: environment.label,
            endpoint: environment.httpBaseURL.absoluteString,
            isActive: environment.id == activeID,
            connectionState: environmentConnectionStates[environment.id],
            connectionDetail: environmentConnectionDetails[environment.id]
        )
    }

    private func mapThread(
        _ thread: OrchestrationThreadShell,
        environment: Environment
    ) -> FeatureThread {
        FeatureThread(
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
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            state: mapThreadState(
                latestTurn: thread.latestTurn,
                session: thread.session,
                hasApprovals: thread.hasPendingApprovals,
                hasUserInput: thread.hasPendingUserInput
            ),
            providerID: thread.modelSelection.instanceId,
            providerName: threadProviderName(
                session: thread.session,
                modelSelection: thread.modelSelection
            ),
            modelID: thread.modelSelection.model,
            modelOptions: mapOptionSelections(thread.modelSelection.options),
            isArchived: thread.archivedAt != nil,
            isSettled: isSettled(thread.settledOverride, settledAt: thread.settledAt),
            keepsActive: thread.settledOverride == "active",
            settledAt: thread.settledAt.map(parseDate),
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.latestUserMessageAt,
                latestTurn: thread.latestTurn
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            pinnedAt: thread.pinnedAt.map(parseDate),
            supportsPinning: environment.descriptor?.capabilities.threadPinning,
            attentionAt: failureDate(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            workingStartedAt: workingStartedAt(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            latestTurnCompletedAt: thread.latestTurn?.completedAt.map(parseDate),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode)
        )
    }

    private func mapThread(
        _ thread: OrchestrationThread,
        environment: Environment
    ) -> FeatureThread {
        FeatureThread(
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
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            state: mapThreadState(
                latestTurn: thread.latestTurn,
                session: thread.session,
                hasApprovals: false,
                hasUserInput: false
            ),
            providerID: thread.modelSelection.instanceId,
            providerName: threadProviderName(
                session: thread.session,
                modelSelection: thread.modelSelection
            ),
            modelID: thread.modelSelection.model,
            modelOptions: mapOptionSelections(thread.modelSelection.options),
            isArchived: thread.archivedAt != nil,
            isSettled: isSettled(thread.settledOverride, settledAt: thread.settledAt),
            keepsActive: thread.settledOverride == "active",
            settledAt: thread.settledAt.map(parseDate),
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.messages.last(where: { $0.role == "user" })?.createdAt,
                latestTurn: thread.latestTurn
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            pinnedAt: thread.pinnedAt.map(parseDate),
            supportsPinning: environment.descriptor?.capabilities.threadPinning,
            attentionAt: failureDate(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            workingStartedAt: workingStartedAt(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            latestTurnCompletedAt: thread.latestTurn?.completedAt.map(parseDate),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode)
        )
    }

    private func mapDetail(
        _ thread: OrchestrationThread,
        environment: Environment,
        mutations: NativeDetailRenderMutations? = nil
    ) -> FeatureThreadDetail {
        let threadID = FeatureScopedID.thread(
            environmentID: environment.id,
            wireID: thread.id
        )
        let cache = detailRenderCaches[threadID] ?? NativeDetailRenderCache()
        detailRenderCaches[threadID] = cache

        if !cache.isInitialized || mutations == nil || mutations?.requiresFullRebuild == true {
            cache.messagesByID = thread.messages.reduce(into: [:]) { result, raw in
                result[raw.id] = mapMessage(raw, environmentID: environment.id)
            }
            cache.approvals = pendingApprovals(thread, environment: environment)
            cache.userInputs = pendingUserInputs(thread, environment: environment)
            let errors = thread.activities.compactMap(mapErrorActivity)
            let activityMessages = (errors + collapsedWorkLogs(thread.activities))
                .sorted { $0.createdAt < $1.createdAt }
            seedWorkLogs(thread.activities, cache: cache)
            let messages = thread.messages.compactMap { cache.messagesByID[$0.id] }
            cache.mergedMessages = (messages + activityMessages)
                .sorted { $0.createdAt < $1.createdAt }
            rebuildMergedIndexes(cache)
            cache.isInitialized = true
        } else if let mutations {
            for message in mutations.messages {
                let mapped = mapMessage(message, environmentID: environment.id)
                cache.messagesByID[message.id] = mapped
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
        mappedThread.state = mapThreadState(
            latestTurn: thread.latestTurn,
            session: thread.session,
            hasApprovals: !cache.approvals.isEmpty,
            hasUserInput: !cache.userInputs.isEmpty
        )
        return FeatureThreadDetail(
            thread: mappedThread,
            messages: cache.mergedMessages,
            approvals: cache.approvals,
            userInputs: cache.userInputs
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
        if let error = mapErrorActivity(activity) {
            upsertMergedMessage(error, cache: cache)
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
        let message = accumulator.message(groupID: groupID)
        upsertMergedMessage(message, cache: cache)
    }

    private func seedWorkLogs(
        _ activities: [OrchestrationActivity],
        cache: NativeDetailRenderCache
    ) {
        cache.workLogsByGroupID.removeAll(keepingCapacity: true)
        cache.workLogActivityIDs.removeAll(keepingCapacity: true)
        for activity in activities.sorted(by: { $0.createdAt < $1.createdAt })
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
            let kind: FeatureApprovalKind = switch activity.payload["requestKind"]?.stringValue {
            case "command": .command
            case "file-read": .fileRead
            case "file-change": .fileChange
            default: .other
            }
            let approval = FeatureApproval(
                id: uiRequestID,
                wireID: requestID,
                threadID: threadID,
                kind: kind,
                title: activity.summary,
                detail: activity.payload["detail"]?.stringValue ?? activity.summary
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

    private func mapErrorActivity(_ activity: OrchestrationActivity) -> FeatureMessage? {
        guard activity.tone == "error" else { return nil }
        let detail = activity.payload["detail"]?.stringValue
        let text = detail.map { "\(activity.summary)\n\($0)" } ?? activity.summary
        return FeatureMessage(
            id: "activity-\(activity.id)",
            role: .system,
            text: text,
            createdAt: parseDate(activity.createdAt),
            state: .complete,
            toolName: activity.kind
        )
    }

    /// Lifecycle updates can number in the thousands on a long turn. Keep the
    /// primary transcript message-sized while preserving a bounded, expandable
    /// summary for each turn.
    private func collapsedWorkLogs(
        _ activities: [OrchestrationActivity]
    ) -> [FeatureMessage] {
        let terminalKinds = Set(["tool.completed", "task.completed", "turn.plan.updated"])
        let completed = activities.filter {
            $0.tone != "error" && terminalKinds.contains($0.kind)
        }
        let groups = Dictionary(grouping: completed) { activity in
            activity.turnId ?? "unscoped"
        }

        return groups.values.compactMap { unsorted in
            let group = unsorted.sorted { $0.createdAt < $1.createdAt }
            guard let first = group.first else { return nil }
            let visible = group.suffix(40)
            var lines: [String] = []
            let hiddenCount = group.count - visible.count
            if hiddenCount > 0 {
                lines.append("\(hiddenCount) earlier updates hidden")
            }
            lines.append(
                contentsOf: visible.map { activity in
                    let detail = previewText(activity.payload["detail"]?.stringValue)
                    return "• \(detail ?? activity.summary)"
                }
            )
            return FeatureMessage(
                id: "work-log-\(first.turnId ?? "unscoped")",
                role: .tool,
                text: lines.joined(separator: "\n"),
                createdAt: parseDate(first.createdAt),
                state: .complete,
                toolName: "Work log · \(group.count)"
            )
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
        for activity in thread.activities.sorted(by: {
            parseDate($0.createdAt) < parseDate($1.createdAt)
        }) {
            let requestID = activity.payload["requestId"]?.stringValue
            let uiRequestID = requestID.map {
                FeatureScopedID.approval(environmentID: environment.id, wireID: $0)
            }
            if activity.kind == "approval.requested", let requestID {
                let requestKind = activity.payload["requestKind"]?.stringValue
                let kind: FeatureApprovalKind = switch requestKind {
                case "command": .command
                case "file-read": .fileRead
                case "file-change": .fileChange
                default: .other
                }
                let detail = activity.payload["detail"]?.stringValue ?? activity.summary
                let uiRequestID = FeatureScopedID.approval(
                    environmentID: environment.id,
                    wireID: requestID
                )
                open[uiRequestID] = FeatureApproval(
                    id: uiRequestID,
                    wireID: requestID,
                    threadID: threadID,
                    kind: kind,
                    title: activity.summary,
                    detail: detail
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

    private func pendingUserInputs(
        _ thread: OrchestrationThread,
        environment: Environment
    ) -> [FeatureUserInput] {
        var open: [String: FeatureUserInput] = [:]
        let threadID = FeatureScopedID.thread(
            environmentID: environment.id,
            wireID: thread.id
        )
        for activity in thread.activities.sorted(by: {
            parseDate($0.createdAt) < parseDate($1.createdAt)
        }) {
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

    private func mapThreadState(
        latestTurn: OrchestrationLatestTurn?,
        session: OrchestrationSession?,
        hasApprovals: Bool,
        hasUserInput: Bool
    ) -> FeatureThreadState {
        if hasApprovals { return .waitingForApproval }
        if hasUserInput { return .waitingForInput }
        if session?.status == "starting" { return .queued }
        if session?.status == "running" || latestTurn?.state == "running" { return .working }
        if session?.status == "error" || latestTurn?.state == "error" { return .failed }
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

    private func mapRuntimeMode(_ mode: RuntimeMode) -> FeatureRuntimeMode {
        switch mode {
        case .approvalRequired, .autoAcceptEdits, .auto: .automatic
        case .fullAccess: .fullAccess
        }
    }

    private func coreRuntimeMode(_ mode: FeatureRuntimeMode) -> RuntimeMode {
        mode.mobileNormalized == .fullAccess ? .fullAccess : .auto
    }

    private func mapInteractionMode(_: InteractionMode) -> FeatureInteractionMode {
        .standard
    }

    private func coreInteractionMode(_: FeatureInteractionMode) -> InteractionMode {
        .default
    }

    private func mapProviders(
        _ shell: OrchestrationShellSnapshot,
        config: ServerConfigSnapshot?
    ) -> [FeatureProvider] {
        if let providers = config?.providers, !providers.isEmpty {
            return Self.normalizedProviders(providers.map { provider in
                FeatureProvider(
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
                    skills: (provider.skills ?? []).map { skill in
                        FeatureProviderSkill(
                            name: skill.name,
                            displayName: skill.displayName,
                            description: skill.description,
                            shortDescription: skill.shortDescription,
                            path: skill.path,
                            scope: skill.scope,
                            isEnabled: skill.enabled
                        )
                    }
                )
            })
        }

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
        default: id
        }
    }

    private func threadProviderName(
        session: OrchestrationSession?,
        modelSelection: ModelSelection
    ) -> String {
        if let name = session?.providerName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            return name
        }
        let providerID = session?.providerInstanceId ?? modelSelection.instanceId
        if let provider = latestServerConfig?.providers.first(where: {
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
            message.attachments.contains {
                $0.mimeType.hasPrefix("image/") && $0.url == nil
            }
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
        let imageIDs = Set(
            detail.messages.flatMap(\.attachments)
                .filter { $0.mimeType.hasPrefix("image/") }
                .map(\.id)
        )
        let missingIDs = Array(imageIDs.filter {
            cachedAttachmentURL(for: $0, environmentID: environmentID) == nil
        })

        await withTaskGroup(of: (String, ResolvedAssetURL?).self) { group in
            var iterator = missingIDs.makeIterator()
            for _ in 0..<min(4, missingIDs.count) {
                guard let id = iterator.next() else { break }
                group.addTask {
                    (
                        id,
                        try? await client.resolvedAsset(resource: .attachment(id: id))
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
                                resource: .attachment(id: nextID)
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
        session: OrchestrationSession?
    ) -> Date? {
        guard session?.status == "starting"
                || session?.status == "running"
                || latestTurn?.state == "running" else {
            return nil
        }
        let candidates: [String?]
        if let latestTurn, latestTurn.completedAt == nil {
            candidates = [
                latestTurn.startedAt,
                latestTurn.requestedAt,
                session?.updatedAt,
            ]
        } else {
            candidates = [session?.updatedAt]
        }
        return candidates.lazy.compactMap { $0.flatMap(self.parseValidDate) }.first
    }

    private func makeUploadAttachments(
        _ attachments: [FeatureUploadAttachment]
    ) throws -> [UploadChatImageAttachment] {
        guard attachments.count <= 8 else {
            throw NativeFeatureClientError.tooManyAttachments
        }
        return try attachments.map {
            try UploadChatImageAttachment(
                data: $0.data,
                name: $0.name,
                mimeType: $0.mimeType
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

    private func parseValidDate(_ value: String) -> Date? {
        Self.fractionalDateFormatter.date(from: value)
            ?? Self.dateFormatter.date(from: value)
    }

    private static let settingsKey = "swift-ios.feature-settings.v1"
    private static let fractionalDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let dateFormatter = ISO8601DateFormatter()
}

enum NativeDetailRenderMutation: Equatable {
    case full
    case message(OrchestrationMessage)
    case activity(OrchestrationActivity)
    case metadata
    case none
}

struct NativeDetailRenderMutations {
    private(set) var requiresFullRebuild = false
    private(set) var messages: [OrchestrationMessage] = []
    private(set) var activities: [OrchestrationActivity] = []

    mutating func formUnion(_ mutation: NativeDetailRenderMutation) {
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
}

private struct NativeWorkLogAccumulator {
    private static let terminalKinds = Set([
        "tool.completed", "task.completed", "turn.plan.updated",
    ])

    private(set) var count = 0
    private var visibleLines: [String] = []
    private var createdAt = Date.distantPast

    static func accepts(_ activity: OrchestrationActivity) -> Bool {
        activity.tone != "error" && terminalKinds.contains(activity.kind)
    }

    mutating func append(
        _ activity: OrchestrationActivity,
        preview: String?,
        createdAt: Date
    ) {
        if count == 0 {
            self.createdAt = createdAt
        }
        count += 1
        visibleLines.append("• \(preview ?? activity.summary)")
        if visibleLines.count > 40 {
            visibleLines.removeFirst(visibleLines.count - 40)
        }
    }

    func message(groupID: String) -> FeatureMessage {
        var lines: [String] = []
        if count > visibleLines.count {
            lines.append("\(count - visibleLines.count) earlier updates hidden")
        }
        lines.append(contentsOf: visibleLines)
        return FeatureMessage(
            id: "work-log-\(groupID)",
            role: .tool,
            text: lines.joined(separator: "\n"),
            createdAt: createdAt,
            state: .complete,
            toolName: "Work log · \(count)"
        )
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
        }
        return .updated(
            replacing(thread, messages: messages, latestTurn: latestTurn, updatedAt: occurredAt)
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

    private static func replacing(
        _ thread: OrchestrationThread,
        messages: [OrchestrationMessage]? = nil,
        activities: [OrchestrationActivity]? = nil,
        checkpoints: [CheckpointSummary]? = nil,
        latestTurn: OrchestrationLatestTurn? = nil,
        session: OrchestrationSession? = nil,
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
            latestTurn: latestTurn ?? thread.latestTurn,
            createdAt: thread.createdAt,
            updatedAt: updatedAt,
            archivedAt: thread.archivedAt,
            settledOverride: thread.settledOverride,
            settledAt: thread.settledAt,
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

private struct NativeThreadRoute {
    let uiID: String
    let wireID: String
    let environmentID: String
    let client: T3Client
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
    case workspaceNotFound
    case approvalNotFound
    case inputRequestNotFound
    case invalidProjectPath
    case branchRequired
    case terminalNotOpen
    case deviceSessionNotFound
    case missingScope(String)
    case tooManyAttachments

    var errorDescription: String? {
        switch self {
        case .notConnected: "Connect to a T3 environment first."
        case .environmentNotFound: "That T3 environment is no longer available."
        case .projectNotFound: "The selected project is no longer available."
        case .threadNotFound: "The selected thread is no longer available."
        case .workspaceNotFound: "The thread workspace is no longer available."
        case .approvalNotFound: "The approval request is no longer active."
        case .inputRequestNotFound: "The input request is no longer active."
        case .invalidProjectPath: "Enter a workspace path on the connected environment."
        case .branchRequired: "Choose a base branch for the new worktree."
        case .terminalNotOpen: "Open the terminal before sending input."
        case .deviceSessionNotFound: "That device session is no longer active."
        case .missingScope: "This connection does not have permission to manage devices."
        case .tooManyAttachments: "You can attach up to 8 images per message."
        }
    }
}
