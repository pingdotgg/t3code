import Foundation
import Observation
import T3MobileProtocol

@Observable
@MainActor
final class ShellViewModel {
    private(set) var environments: [MobileEnvironment]
    private(set) var projects: [MobileProject]
    private(set) var threads: [MobileThread]
    private(set) var threadSections: [MobileThreadSection]
    private var threadProjectIDs: [MobileThread.ID: MobileProject.ID]
    private(set) var connectionState: MobileConnectionState
    private(set) var selectedThreadDetail: MobileThreadDetail?
    private(set) var threadDetailState: MobileConnectionState
    private var syncSession: MobileSyncSession?
    private var healthMonitorTask: Task<Void, Never>?
    private var shellSubscriptionTask: Task<Void, Never>?
    private var threadSubscriptionTask: Task<Void, Never>?
    private var syncClient: MobileSyncClient?
    private var syncConfiguration: MobileServerConfiguration?
    private var cacheService: MobileCacheService?
    private let mapper = MobileSyncProjectionMapper()
    private let jsonEncoder = JSONEncoder()
    private let jsonDecoder = JSONDecoder()
    private var reconnectFailureCount = 0
    private var shellSnapshotSequence = 0
    private var loadingThreadID: MobileThread.ID?
    private(set) var isSendingMessage = false
    private(set) var isInterrupting = false
    private(set) var selectedDiff: MobileTurnDiff?
    private(set) var commandErrorMessage: String?
    private(set) var respondedRequestIDs: Set<String> = []
    private(set) var respondingRequestIDs: Set<String> = []
    private(set) var diagnosticsEvents: [MobileDiagnosticsEntry] = []
    var composerDraft = ""
    var selectedEnvironmentID: MobileEnvironment.ID?
    var selectedProjectID: MobileProject.ID?
    var selectedThreadID: MobileThread.ID?

    init(
        environments: [MobileEnvironment],
        projects: [MobileProject],
        threads: [MobileThread],
        connectionState: MobileConnectionState = .idle
    ) {
        self.environments = environments
        self.projects = projects
        self.threads = threads
        self.connectionState = connectionState
        threadDetailState = .idle
        threadSections = Self.makeThreadSections(projects: projects, threads: threads)
        threadProjectIDs = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0.projectID) })
        selectedEnvironmentID = environments.first?.id
        selectedProjectID = projects.first?.id
        selectedThreadID = threads.first?.id
    }

    var selectedThread: MobileThread? {
        threads.first { $0.id == selectedThreadID }
    }

    func selectThread(_ threadID: MobileThread.ID?) async {
        guard selectedThreadID != threadID || loadingThreadID != threadID else {
            return
        }
        selectedThreadID = threadID
        selectedProjectID = projectID(forThreadID: threadID)
        await loadSelectedThreadDetail()
    }

    func stopSync() async {
        healthMonitorTask?.cancel()
        shellSubscriptionTask?.cancel()
        threadSubscriptionTask?.cancel()
        healthMonitorTask = nil
        shellSubscriptionTask = nil
        threadSubscriptionTask = nil
        await syncSession?.webSocket.close()
        syncSession = nil
    }

    func projectID(forThreadID threadID: MobileThread.ID?) -> MobileProject.ID? {
        guard let threadID else {
            return nil
        }
        return threadProjectIDs[threadID]
    }

    var canSendMessage: Bool {
        syncSession?.supports(.orchestrationCommandReceipts) == true
            && selectedThreadID != nil
            && !isSendingMessage
    }

    var canInterruptSelectedThread: Bool {
        guard let detail = selectedThreadDetail else {
            return false
        }
        return syncSession?.supports(.orchestrationCommandReceipts) == true
            && !isInterrupting
            && (detail.sessionStatus == "Running" || detail.sessionStatus == "Starting")
    }

    func sendMessage() async {
        let trimmed = composerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let threadID = selectedThreadID, let session = syncSession else {
            return
        }
        isSendingMessage = true
        commandErrorMessage = nil
        defer {
            isSendingMessage = false
        }
        do {
            try session.require(.orchestrationCommandReceipts)
            let receipt = try await session.webSocket.dispatchCommand(
                ThreadTurnStartCommand(
                    commandId: Self.commandID(prefix: "turn-start"),
                    threadId: threadID,
                    message: UserMessagePayload(
                        messageId: Self.commandID(prefix: "message"),
                        text: trimmed
                    ),
                    createdAt: Self.nowString()
                )
            )
            if receipt.status == "accepted" || receipt.status == "duplicate" {
                composerDraft = ""
                recordDiagnostic(.info, "Message command \(receipt.status).")
            } else {
                recordDiagnostic(.warning, "Message command returned \(receipt.status).")
            }
        } catch {
            commandErrorMessage = error.localizedDescription
            recordDiagnostic(.error, "Message send failed: \(error.localizedDescription)")
        }
    }

    func interruptSelectedThread() async {
        guard let threadID = selectedThreadID, let session = syncSession else {
            return
        }
        guard !isInterrupting else {
            return
        }
        isInterrupting = true
        commandErrorMessage = nil
        defer {
            isInterrupting = false
        }
        do {
            try session.require(.orchestrationCommandReceipts)
            _ = try await session.webSocket.dispatchCommand(
                ThreadTurnInterruptCommand(
                    commandId: Self.commandID(prefix: "turn-interrupt"),
                    threadId: threadID,
                    turnId: selectedThreadDetail?.activeTurnID,
                    createdAt: Self.nowString()
                )
            )
            recordDiagnostic(.info, "Interrupt command dispatched.")
        } catch {
            commandErrorMessage = error.localizedDescription
            recordDiagnostic(.error, "Interrupt failed: \(error.localizedDescription)")
        }
    }

    func respondToApproval(requestID: String, decision: String) async {
        guard let threadID = selectedThreadID, let session = syncSession else {
            return
        }
        guard !respondedRequestIDs.contains(requestID), !respondingRequestIDs.contains(requestID) else {
            return
        }
        respondingRequestIDs.insert(requestID)
        commandErrorMessage = nil
        defer {
            respondingRequestIDs.remove(requestID)
        }
        do {
            try session.require(.orchestrationCommandReceipts)
            let receipt = try await session.webSocket.dispatchCommand(
                ThreadApprovalRespondCommand(
                    commandId: Self.commandID(prefix: "approval"),
                    threadId: threadID,
                    requestId: requestID,
                    decision: decision,
                    createdAt: Self.nowString()
                )
            )
            if receipt.status == "accepted" || receipt.status == "duplicate" {
                respondedRequestIDs.insert(requestID)
                recordDiagnostic(.info, "Approval response \(receipt.status).")
            } else {
                recordDiagnostic(.warning, "Approval response returned \(receipt.status).")
            }
        } catch {
            commandErrorMessage = error.localizedDescription
            recordDiagnostic(.error, "Approval response failed: \(error.localizedDescription)")
        }
    }

    func respondToUserInput(requestID: String, answer: String) async {
        guard let threadID = selectedThreadID, let session = syncSession else {
            return
        }
        guard !respondedRequestIDs.contains(requestID), !respondingRequestIDs.contains(requestID) else {
            return
        }
        respondingRequestIDs.insert(requestID)
        commandErrorMessage = nil
        defer {
            respondingRequestIDs.remove(requestID)
        }
        do {
            try session.require(.orchestrationCommandReceipts)
            let receipt = try await session.webSocket.dispatchCommand(
                ThreadUserInputRespondCommand(
                    commandId: Self.commandID(prefix: "user-input"),
                    threadId: threadID,
                    requestId: requestID,
                    answers: ["response": .string(answer)],
                    createdAt: Self.nowString()
                )
            )
            if receipt.status == "accepted" || receipt.status == "duplicate" {
                respondedRequestIDs.insert(requestID)
                recordDiagnostic(.info, "User input response \(receipt.status).")
            } else {
                recordDiagnostic(.warning, "User input response returned \(receipt.status).")
            }
        } catch {
            commandErrorMessage = error.localizedDescription
            recordDiagnostic(.error, "User input response failed: \(error.localizedDescription)")
        }
    }

    func loadDiff(for checkpoint: MobileCheckpointSummary) async {
        guard let threadID = selectedThreadID, let session = syncSession else {
            return
        }
        commandErrorMessage = nil
        do {
            try session.require(.diffTurn)
            selectedDiff = try await session.webSocket.getTurnDiff(
                threadID: threadID,
                fromTurnCount: max(0, checkpoint.turnCount - 1),
                toTurnCount: checkpoint.turnCount
            )
            recordDiagnostic(.info, "Loaded diff for checkpoint \(checkpoint.turnCount).")
        } catch {
            commandErrorMessage = error.localizedDescription
            recordDiagnostic(.error, "Diff load failed: \(error.localizedDescription)")
        }
    }

    func clearSelectedDiff() {
        selectedDiff = nil
    }

    func revertToCheckpoint(_ checkpoint: MobileCheckpointSummary) async {
        guard let threadID = selectedThreadID, let session = syncSession else {
            return
        }
        commandErrorMessage = nil
        do {
            try session.require(.orchestrationCommandReceipts)
            _ = try await session.webSocket.dispatchCommand(
                ThreadCheckpointRevertCommand(
                    commandId: Self.commandID(prefix: "checkpoint-revert"),
                    threadId: threadID,
                    turnCount: checkpoint.turnCount,
                    createdAt: Self.nowString()
                )
            )
            recordDiagnostic(.info, "Checkpoint revert dispatched for turn \(checkpoint.turnCount).")
        } catch {
            commandErrorMessage = error.localizedDescription
            recordDiagnostic(.error, "Checkpoint revert failed: \(error.localizedDescription)")
        }
    }

    func loadInitialSync(
        configuration: MobileServerConfiguration?,
        client: MobileSyncClient = MobileSyncClient(),
        cacheService: MobileCacheService? = nil,
        initializationError: Error? = nil,
        onAuthenticatedBearerToken: (String) async throws -> Void = { _ in }
    ) async {
        if let initializationError {
            connectionState = .failed(initializationError.localizedDescription)
            recordDiagnostic(.error, "Initialization failed: \(initializationError.localizedDescription)")
        }
        if let cacheService {
            do {
                if let cachedShell = try await cacheService.loadShell() {
                    applyCachedShell(cachedShell)
                    recordDiagnostic(.info, "Loaded shell from cache.")
                }
            } catch {
                connectionState = .failed(error.localizedDescription)
                recordDiagnostic(.error, "Cache load failed: \(error.localizedDescription)")
            }
        }

        guard let configuration else {
            connectionState = .notConfigured
            recordDiagnostic(.warning, "Mobile server configuration is missing.")
            return
        }
        syncClient = client
        syncConfiguration = configuration
        self.cacheService = cacheService
        connectionState = .connecting
        do {
            let result = try await client.loadInitialShell(configuration)
            try await onAuthenticatedBearerToken(result.session.bearerSessionToken)
            try await cacheService?.saveInitialSync(result)
            applyInitialSync(result)
            recordDiagnostic(.info, "Loaded initial shell from server.")
            startShellSubscription(
                result.shellSubscription,
                session: result.session,
                cacheService: cacheService
            )
            startHealthMonitor(configuration: configuration, client: client, cacheService: cacheService)
            await loadSelectedThreadDetail()
        } catch {
            connectionState = .failed(error.localizedDescription)
            recordDiagnostic(.error, "Initial sync failed: \(error.localizedDescription)")
        }
    }

    var diagnosticsSnapshot: MobileDiagnosticsSnapshot {
        MobileDiagnosticsSnapshot(
            connectionState: connectionState.summary,
            threadDetailState: threadDetailState.summary,
            environmentCount: environments.count,
            projectCount: projects.count,
            threadCount: threads.count,
            selectedThreadID: selectedThreadID,
            shellSnapshotSequence: shellSnapshotSequence,
            selectedThreadSnapshotSequence: selectedThreadDetail?.snapshotSequence,
            pendingResponseCount: respondingRequestIDs.count,
            respondedRequestCount: respondedRequestIDs.count,
            isSendingMessage: isSendingMessage,
            isInterrupting: isInterrupting,
            recentEvents: diagnosticsEvents
        )
    }

    static func preview() -> ShellViewModel {
        ShellViewModel(
            environments: MobilePreviewData.environments,
            projects: MobilePreviewData.projects,
            threads: MobilePreviewData.threads
        )
    }

    private func applyInitialSync(_ result: MobileInitialSyncResult) {
        healthMonitorTask?.cancel()
        shellSubscriptionTask?.cancel()
        syncSession = result.session
        applyShellState(result.shellState)
        environments = [result.environment]
        selectedEnvironmentID = result.environment.id
        if selectedThreadID == nil || !threads.contains(where: { $0.id == selectedThreadID }) {
            selectedProjectID = projects.first?.id
            selectedThreadID = threads.first?.id
        }
        connectionState = .connected
        reconnectFailureCount = 0
    }

    private func startShellSubscription(
        _ subscription: MobileStreamSubscription,
        session: MobileSyncSession,
        cacheService: MobileCacheService?
    ) {
        shellSubscriptionTask?.cancel()
        shellSubscriptionTask = Task { [weak self, session, subscription, cacheService] in
            do {
                while !Task.isCancelled {
                    let stream = try await session.webSocket.nextStream(subscription: subscription)
                    await self?.applyShellStream(stream, cacheService: cacheService)
                }
            } catch {
                guard !Task.isCancelled else {
                    return
                }
                await self?.markShellStreamFailure(error)
            }
        }
    }

    private func applyShellStream(_ stream: MobileStreamMessage, cacheService: MobileCacheService?) async {
        do {
            let selectedWasRemoved = stream.payload.kind == "thread-removed"
                && stream.payload.threadId == selectedThreadID
            let nextState = try mapper.applyShellStream(
                stream,
                to: MobileShellState(
                    snapshotSequence: shellSnapshotSequence,
                    projects: projects,
                    threads: threads
                )
            )
            applyShellState(nextState)
            if selectedWasRemoved {
                threadSubscriptionTask?.cancel()
                threadSubscriptionTask = nil
                selectedThreadID = nil
                selectedProjectID = nil
                selectedThreadDetail = nil
                loadingThreadID = nil
                threadDetailState = .idle
            }
            if let environment = environments.first {
                try await cacheService?.saveShell(environment: environment, shellState: nextState)
            }
        } catch {
            connectionState = .failed(error.localizedDescription)
            recordDiagnostic(.error, "Shell stream failed: \(error.localizedDescription)")
        }
    }

    private func markShellStreamFailure(_ error: Error) {
        connectionState = .failed(error.localizedDescription)
        recordDiagnostic(.error, "Shell stream stopped: \(error.localizedDescription)")
    }

    private func loadSelectedThreadDetail() async {
        threadSubscriptionTask?.cancel()
        selectedThreadDetail = nil
        guard let threadID = selectedThreadID else {
            loadingThreadID = nil
            threadDetailState = .idle
            return
        }
        loadingThreadID = threadID
        threadDetailState = .connecting
        if let cached = try? await cacheService?.loadThreadSnapshot(threadID: threadID),
           let json = try? jsonDecoder.decode(JSONValue.self, from: cached.json),
           let detail = try? mapper.threadDetail(fromSnapshot: json)
        {
            selectedThreadDetail = detail
            recordDiagnostic(.info, "Loaded cached thread \(threadID).")
        }
        guard let session = syncSession else {
            threadDetailState = selectedThreadDetail == nil ? .failed("Thread detail sync is offline.") : .connected
            return
        }
        threadSubscriptionTask = Task { [weak self, session, threadID] in
            do {
                let subscription = try await session.webSocket.openThreadSubscription(threadID: threadID)
                await self?.applyThreadStream(subscription.initial, threadID: threadID)
                while !Task.isCancelled {
                    let stream = try await session.webSocket.nextStream(subscription: subscription)
                    await self?.applyThreadStream(stream, threadID: threadID)
                }
            } catch {
                guard !Task.isCancelled else {
                    return
                }
                await self?.markThreadStreamFailure(error)
            }
        }
    }

    private func applyThreadStream(_ stream: MobileStreamMessage, threadID: String) async {
        do {
            let next: MobileThreadDetail
            if let selectedThreadDetail {
                next = try mapper.applyThreadStream(stream, to: selectedThreadDetail)
            } else {
                next = try mapper.threadDetail(from: stream)
            }
            guard next.threadID == threadID else {
                return
            }
            selectedThreadDetail = next
            threadDetailState = .connected
            if stream.payload.kind == "snapshot", let snapshot = stream.payload.snapshot {
                try await cacheService?.saveThreadSnapshotAndCursor(
                    threadID: threadID,
                    snapshotJSON: jsonEncoder.encode(snapshot),
                    snapshotSequence: next.snapshotSequence
                )
            }
        } catch {
            threadDetailState = .failed(error.localizedDescription)
            recordDiagnostic(.error, "Thread stream failed: \(error.localizedDescription)")
        }
    }

    private func markThreadStreamFailure(_ error: Error) {
        threadDetailState = .failed(error.localizedDescription)
        recordDiagnostic(.error, "Thread stream stopped: \(error.localizedDescription)")
    }

    private func startHealthMonitor(
        configuration: MobileServerConfiguration,
        client: MobileSyncClient,
        cacheService: MobileCacheService?
    ) {
        guard let session = syncSession else {
            return
        }
        healthMonitorTask = Task { [weak self, session, configuration, client, cacheService] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                    try await session.webSocket.ping()
                    await self?.resetReconnectFailures()
                } catch {
                    guard !Task.isCancelled else {
                        return
                    }
                    await self?.handleHealthFailure(
                        error,
                        configuration: configuration,
                        client: client,
                        cacheService: cacheService,
                        failedSession: session
                    )
                    return
                }
            }
        }
    }

    private func handleHealthFailure(
        _ error: Error,
        configuration: MobileServerConfiguration,
        client: MobileSyncClient,
        cacheService: MobileCacheService?,
        failedSession: MobileSyncSession
    ) async {
        connectionState = .failed(error.localizedDescription)
        recordDiagnostic(.warning, "Health check failed: \(error.localizedDescription)")
        if syncSession?.webSocket === failedSession.webSocket {
            syncSession = nil
        }
        await failedSession.webSocket.close()
        reconnectFailureCount += 1
        let shift = UInt64(min(max(0, reconnectFailureCount - 1), 5))
        let delay = min(UInt64(1_000_000_000) << shift, 30_000_000_000)
        do {
        try await Task.sleep(nanoseconds: delay)
            await recoverSession(configuration: configuration, client: client, cacheService: cacheService)
        } catch {
            connectionState = .failed(error.localizedDescription)
            recordDiagnostic(.error, "Reconnect delay failed: \(error.localizedDescription)")
        }
    }

    private func recoverSession(
        configuration: MobileServerConfiguration,
        client: MobileSyncClient,
        cacheService: MobileCacheService?
    ) async {
        await loadInitialSync(configuration: configuration, client: client, cacheService: cacheService)
        guard let session = syncSession else {
            return
        }
        do {
            let shellCursor = try await cacheService?.loadEventCursor(name: "shell") ?? 0
            let shellReplay = try await session.webSocket.replay(fromSequenceExclusive: shellCursor)
            if shellReplay.status == "complete" {
                try await cacheService?.saveEventCursor(name: "shell", sequence: shellReplay.returnedToSequenceInclusive)
            } else {
                try await cacheService?.saveReplayGap(scope: "shell", envelope: shellReplay)
                await loadSelectedThreadDetail()
                return
            }

            guard let threadID = selectedThreadID, var nextDetail = selectedThreadDetail else {
                return
            }
            let threadCursor = try await cacheService?.loadEventCursor(name: "thread:\(threadID)") ?? nextDetail.snapshotSequence
            let threadReplay = try await session.webSocket.replay(fromSequenceExclusive: threadCursor)
            if threadReplay.status == "complete" {
                for event in threadReplay.events {
                    nextDetail = try mapper.applyReplayEvent(event, to: nextDetail) ?? nextDetail
                }
                selectedThreadDetail = nextDetail
                try await cacheService?.saveEventCursor(
                    name: "thread:\(threadID)",
                    sequence: threadReplay.returnedToSequenceInclusive
                )
            } else {
                try await cacheService?.saveReplayGap(scope: "thread:\(threadID)", envelope: threadReplay)
                await loadSelectedThreadDetail()
            }
        } catch {
            connectionState = .failed(error.localizedDescription)
            recordDiagnostic(.error, "Session recovery failed: \(error.localizedDescription)")
        }
    }

    private func resetReconnectFailures() {
        reconnectFailureCount = 0
    }

    private func applyCachedShell(_ cachedShell: MobileCachedShell) {
        environments = [
            MobileEnvironment(
                id: cachedShell.environment.id,
                title: cachedShell.environment.title,
                connectionSummary: "Cached \(cachedShell.savedAt)",
                isConnected: false
            ),
        ]
        projects = cachedShell.shellState.projects
        threads = cachedShell.shellState.threads
        threadSections = Self.makeThreadSections(projects: projects, threads: threads)
        threadProjectIDs = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0.projectID) })
        selectedEnvironmentID = cachedShell.environment.id
        selectedProjectID = projects.first?.id
        selectedThreadID = threads.first?.id
        loadingThreadID = nil
    }

    private func applyShellState(_ shellState: MobileShellState) {
        shellSnapshotSequence = shellState.snapshotSequence
        projects = shellState.projects
        threads = shellState.threads
        threadSections = Self.makeThreadSections(projects: projects, threads: threads)
        threadProjectIDs = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0.projectID) })
        if let selectedThreadID, !threads.contains(where: { $0.id == selectedThreadID }) {
            self.selectedThreadID = nil
            selectedProjectID = nil
            selectedThreadDetail = nil
            loadingThreadID = nil
            threadDetailState = .idle
        }
    }

    private static func makeThreadSections(
        projects: [MobileProject],
        threads: [MobileThread]
    ) -> [MobileThreadSection] {
        let threadsByProjectID = Dictionary(grouping: threads, by: \.projectID)
        return projects.map { project in
            MobileThreadSection(
                id: project.id,
                title: project.title,
                threads: threadsByProjectID[project.id] ?? []
            )
        }
    }

    private static func commandID(prefix: String) -> String {
        "\(prefix)-\(UUID().uuidString)"
    }

    private static func nowString() -> String {
        Date().ISO8601Format()
    }

    private func recordDiagnostic(_ level: MobileDiagnosticsLevel, _ message: String) {
        diagnosticsEvents.append(MobileDiagnosticsEntry(level: level, message: message))
        if diagnosticsEvents.count > 100 {
            diagnosticsEvents.removeFirst(diagnosticsEvents.count - 100)
        }
    }
}
