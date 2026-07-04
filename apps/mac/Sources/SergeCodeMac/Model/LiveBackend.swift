import Foundation
import SidecarKit
import T3Kit

// LiveBackend — the real BackendService: composes SidecarKit.ServerProcess
// (spawns/supervises the Node t3 server child) with T3Kit's AuthClient +
// RpcConnection + T3Client (authenticated effect-RPC-over-WebSocket), and
// translates the wire protocol (docs/wire-protocol.md) into the UI-level
// BackendService surface (BackendEvent + the domain entities in Entities.swift).
//
// Isolation: this is an `actor`. All mutable projection state lives here; the
// four composed pieces (ServerProcess/AuthClient/RpcConnection/T3Client) are
// themselves Sendable actors. The `events` stream + its continuation are
// nonisolated `let`s so AppModel can grab the stream synchronously.
//
// ── Lifecycle ────────────────────────────────────────────────────────────────
//  start():   locate node -> build SidecarConfig (free port, default baseDir
//             ~/Library/Application Support/SergeCode, entry from
//             $SERGECODE_SERVER_ENTRY or the dev resolver) -> spawn sidecar ->
//             observe SidecarState.
//  SidecarState -> ConnectionPhase:
//             .launching(0)      -> .launchingServer
//             .launching(n>0)    -> .reconnecting(n)
//             .ready(pid)        -> open a *socket session* (auth + connect +
//                                   getConfig + subscribe); emits .connecting
//                                   then .ready.
//             .crashed(_, n)     -> tear down socket session, .reconnecting(n+1)
//                                   (the sidecar auto-restarts w/ backoff).
//             .stopped           -> tear down socket session (no phase; a
//                                   deliberate stop, not a failure).
//  Socket-level reconnect: while the sidecar is alive, a dropped socket is
//  retried with exponential backoff (reusing ServerProcess.backoffDelay), a
//  fresh wsTicket minted per attempt (AuthClient.makeSocketURL, per §4.3/§risk8).
//
// ── Mapping decisions (wire -> UI) — best-effort, documented, never silent ────
//  * ProviderKind: derived from ServerProvider.driver by substring match
//    (claude/codex/cursor/opencode). Drivers with no ProviderKind equivalent
//    (e.g. "grok") are dropped from providers() — ProviderKind is a closed enum
//    with no `.other`. See `providerKind(fromDriver:)`.
//  * A thread's ProviderKind is resolved from its modelSelection.instanceId via
//    the ServerConfig provider table, falling back to session.providerName, then
//    to `.claude`. Documented in `resolveProviderKind`.
//  * ThreadStatus is a projection of session.status + latestTurn.state +
//    hasPendingApprovals + archivedAt (see `mapStatus`); the shell subscription
//    is the source of truth for status (per-thread `thread.session-set` events
//    are intentionally NOT used to mutate status, to avoid fighting the shell
//    projection which already reflects session changes).
//  * Assistant streaming: the wire has no per-token delta on subscribeThread;
//    growing `thread.message-sent` payloads for the same messageId are diffed
//    into `assistantDelta`s (prefix-suffix). A non-append replacement can't be
//    expressed as a delta and is skipped (see `assistantDelta(new:old:)`).
//  * OrchestrationProposedPlan has no dedicated TimelineItem case -> rendered as
//    a `.notice`. System messages -> `.notice`. Activity tones map: .tool ->
//    toolEvent(.succeeded), .error -> toolEvent(.failed), .info -> notice.
//  * Approvals: the wire `requestId` needed to respond is extracted best-effort
//    from the opaque activity payload (OrchestrationMapping.extractRequestId),
//    falling back to the activity id. The (threadId, requestId) route is
//    remembered per approval id so respondToApproval can dispatch. If the id
//    can't be routed, respondToApproval throws (never silently no-ops).
//  * Diff: getFullThreadDiff(toTurnCount:) needs a turn count; we track the
//    highest checkpointTurnCount seen per thread. Before any completed turn we
//    return [] (graceful — no diff yet). The unified-diff string is parsed by
//    UnifiedDiffParser below.
//  * Checkpoints: OrchestrationCheckpointSummary.checkpointRef is used as the
//    UI Checkpoint.id; restoreCheckpoint routes id -> (threadId, turnCount).

public actor LiveBackend: BackendService {

    // MARK: BackendService event stream

    public nonisolated let events: AsyncStream<BackendEvent>
    private nonisolated let continuation: AsyncStream<BackendEvent>.Continuation

    // MARK: Composed transport

    private var authClient: AuthClient?
    private var serverProcess: ServerProcess?
    private var currentConnection: RpcConnection?
    private var currentClient: T3Client?

    // MARK: Supervising tasks

    private var sidecarStatesTask: Task<Void, Never>?
    private var socketSessionTask: Task<Void, Never>?
    private var threadSubscriptions: [String: Task<Void, Never>] = [:]

    // MARK: Projection state (source for the query methods)

    private var projectsByID: [String: Project] = [:]
    private var threadsByID: [String: ChatThread] = [:]
    /// Latest wire modelSelection per thread — kept so option updates
    /// (reasoning effort) can round-trip instanceId/model/other options
    /// without re-fetching the shell.
    private var modelSelectionsByThread: [String: ModelSelection] = [:]
    private var providersByInstanceId: [String: ServerProvider] = [:]

    /// Threads the UI has opened; re-subscribed on every reconnect.
    private var activeThreadIDs: Set<String> = []
    /// Latest mapped timeline per opened thread (returned by `timeline`).
    private var latestTimeline: [String: [TimelineItem]] = [:]
    /// Callers awaiting a thread's first snapshot before `timeline` can return.
    private var snapshotWaiters: [String: [CheckedContinuation<[TimelineItem], Error>]] = [:]

    /// Per-thread dedup + delta-tracking, seeded from each snapshot.
    private var seenMessageIDs: [String: Set<String>] = [:]
    private var assistantTextByMessage: [String: [String: String]] = [:]
    /// Dedup sets for the non-message timeline kinds, seeded from each
    /// snapshot. The server's subscribeThread live tail is not filtered by
    /// snapshot sequence (unlike subscribeShell), so an activity/checkpoint/
    /// plan present in the snapshot can also arrive on the live tail.
    private var seenActivityIDs: [String: Set<String>] = [:]
    private var seenCheckpointRefs: [String: Set<String>] = [:]
    private var seenPlanIDs: [String: Set<String>] = [:]

    /// Approval id -> (threadId, wire requestId) for respondToApproval.
    private var approvalRoutes: [String: (threadID: String, requestId: String)] = [:]
    /// User-input request id -> (dispatch route + the request itself, kept so
    /// answers can be encoded per-question: multi-select -> array, else string).
    private var userInputRoutes: [String: (threadID: String, requestId: String, request: UserInputRequest)] = [:]
    /// Checkpoint id (checkpointRef) -> (threadId, turnCount) for restore.
    private var checkpointRoutes: [String: (threadID: String, turnCount: Int)] = [:]
    private var checkpointsByThread: [String: [Checkpoint]] = [:]
    /// Highest completed-turn count per thread, used as getFullThreadDiff's `toTurnCount`.
    private var currentTurnCount: [String: Int] = [:]

    /// Verification-only breadcrumb path (see `emit`), opt-in via
    /// `$SERGECODE_DEBUG_LOG` (e.g. for a manual `open`-launched run whose
    /// stdio isn't attached to a terminal). `nil` — the default for every
    /// normal/user launch — disables the file breadcrumb entirely so nothing
    /// grows unbounded on a real user's machine; the connection-phase line
    /// still goes to stderr either way (direct/terminal launches only).
    private static let debugLogPath: String? = {
        guard let path = ProcessInfo.processInfo.environment["SERGECODE_DEBUG_LOG"] else {
            return nil
        }
        try? FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        return path
    }()

    public init() {
        let (stream, continuation) = AsyncStream<BackendEvent>.makeStream()
        self.events = stream
        self.continuation = continuation
    }

    // MARK: - Lifecycle

    public func start() async {
        guard serverProcess == nil else { return }
        emit(.connection(.launchingServer))

        let token = BootstrapTokenGenerator.generate()

        let nodePath: String
        do {
            nodePath = try NodeRuntimeLocator().locate().path
        } catch {
            emit(.connection(.failed("Could not locate a compatible Node.js runtime: \(error)")))
            return
        }

        let entryPath =
            ProcessInfo.processInfo.environment["SERGECODE_SERVER_ENTRY"]
            ?? SidecarEntryPathResolver.devDefaultEntryPath()

        let sidecarConfig: SidecarConfig
        do {
            sidecarConfig = try SidecarConfig(nodePath: nodePath, entryPath: entryPath)
        } catch {
            emit(.connection(.failed("Could not configure the server sidecar: \(error)")))
            return
        }

        let kit = T3KitConfig(
            host: sidecarConfig.host, port: sidecarConfig.port, desktopBootstrapToken: token)
        authClient = AuthClient(config: kit.authConfig)

        let process = ServerProcess(config: sidecarConfig, bootstrapToken: token)
        serverProcess = process

        let states = await process.states()
        sidecarStatesTask = Task { [weak self] in
            for await state in states {
                await self?.handleSidecarState(state)
            }
        }

        await process.start()
    }

    public func stop() async {
        sidecarStatesTask?.cancel()
        sidecarStatesTask = nil
        socketSessionTask?.cancel()
        socketSessionTask = nil
        cancelAllThreadSubscriptions()
        cancelAllVcsSubscriptions()

        if let conn = currentConnection {
            currentConnection = nil
            await conn.disconnect(reason: "client stop")
        }
        currentClient = nil

        if let process = serverProcess {
            serverProcess = nil
            await process.stop()
        }

        failAllSnapshotWaiters(error: LiveBackendError.notConnected)
        continuation.finish()
    }

    // MARK: - Sidecar state -> connection phase

    private func handleSidecarState(_ state: SidecarState) async {
        switch state {
        case .idle:
            break
        case .launching(let attempt):
            emit(.connection(attempt == 0 ? .launchingServer : .reconnecting(attempt: attempt)))
        case .ready:
            startSocketSession()
        case .crashed(_, let attempt):
            await teardownSocketSession()
            // The sidecar auto-restarts; surface as reconnecting rather than a
            // hard failure so the UI keeps its spinner instead of erroring out.
            emit(.connection(.reconnecting(attempt: attempt + 1)))
        case .stopped:
            await teardownSocketSession()
        }
    }

    private func startSocketSession() {
        socketSessionTask?.cancel()
        socketSessionTask = Task { [weak self] in
            await self?.runSocketSession()
        }
    }

    private func teardownSocketSession() async {
        socketSessionTask?.cancel()
        socketSessionTask = nil
        cancelAllThreadSubscriptions()
        cancelAllVcsSubscriptions()
        currentClient = nil
        if let conn = currentConnection {
            currentConnection = nil
            await conn.disconnect(reason: "sidecar restart")
        }
    }

    // MARK: - Socket session (connect + subscribe, with socket-level reconnect)

    private func runSocketSession() async {
        var attempt = 0
        while !Task.isCancelled {
            guard let auth = authClient else { return }
            // Kept outside the `do` so the catch can close a socket that was
            // opened before the failure (e.g. getConfig / subscription setup
            // throwing an RPC or decode error): without an explicit
            // disconnect its receive/ping loops would keep running alongside
            // the next attempt's fresh connection.
            var attemptConnection: RpcConnection?
            do {
                emit(.connection(attempt == 0 ? .connecting : .reconnecting(attempt: attempt)))

                // Fresh wsTicket per attempt (tickets are single-use / short-lived).
                let url = try await auth.makeSocketURL()
                let conn = RpcConnection(url: url)
                attemptConnection = conn
                try await conn.connect()
                let client = T3Client(transport: conn)

                // Initial sync — populates providers before we announce ready.
                let config = try await client.getConfig()
                applyProviders(config.providers)

                currentConnection = conn
                currentClient = client
                attempt = 0
                emit(.connection(.ready))

                // Blocks until a subscription/connection failure (throws) or a
                // clean stream close (returns) — both mean: reconnect.
                try await runSubscriptions(client: client, conn: conn)

                currentClient = nil
                currentConnection = nil
                await conn.disconnect(reason: "reconnect")
                // runSubscriptions returned rather than threw: an unexpected
                // clean stream end (the common socket-drop path throws via
                // watchConnection's `.closed` -> the `catch` below). Back off
                // here too so a server that repeatedly completes a
                // subscription stream cleanly can't spin a tight
                // reconnect/auth loop with no delay between attempts.
                if Task.isCancelled { return }
                attempt += 1
                emit(.connection(.reconnecting(attempt: attempt)))
                let cleanEndDelay = ServerProcess.backoffDelay(forAttempt: attempt)
                try? await Task.sleep(nanoseconds: UInt64(cleanEndDelay * 1_000_000_000))
            } catch {
                currentClient = nil
                currentConnection = nil
                if let conn = attemptConnection {
                    // Idempotent if the socket already closed itself (the
                    // common drop path); required for non-transport failures.
                    await conn.disconnect(reason: "socket session failed")
                }
                if Task.isCancelled { return }
                attempt += 1
                emit(.connection(.reconnecting(attempt: attempt)))
                let delay = ServerProcess.backoffDelay(forAttempt: attempt)
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }
    }

    private func runSubscriptions(client: T3Client, conn: RpcConnection) async throws {
        // Re-establish per-thread subscriptions on the fresh client (§4.3: no
        // resume token, every stream re-subscribes from a new snapshot).
        for id in activeThreadIDs {
            startThreadSubscription(id, client: client)
        }

        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { [weak self] in
                    guard let self else { return }
                    try await self.consumeShell(client)
                }
                group.addTask { [weak self] in
                    guard let self else { return }
                    try await self.consumeServerConfig(client)
                }
                group.addTask { [weak self] in
                    guard let self else { return }
                    try await self.watchConnection(conn)
                }
                // First child to finish/throw ends the session; cancel the rest.
                try await group.next()
                group.cancelAll()
            }
        } catch {
            cancelAllThreadSubscriptions()
            throw error
        }
        cancelAllThreadSubscriptions()
    }

    private func consumeShell(_ client: T3Client) async throws {
        let stream = await client.subscribeShell()
        for try await item in stream {
            handleShellItem(item)
        }
    }

    private func consumeServerConfig(_ client: T3Client) async throws {
        let stream = await client.subscribeServerConfig()
        for try await event in stream {
            handleServerConfigEvent(event)
        }
    }

    private func watchConnection(_ conn: RpcConnection) async throws {
        for await state in conn.stateUpdates {
            if case .closed(let reason) = state {
                throw T3Error.connectionClosed(reason: reason)
            }
        }
    }

    // MARK: - Shell subscription (project + thread list)

    private func handleShellItem(_ item: OrchestrationShellStreamItem) {
        switch item {
        case .snapshot(let snapshot):
            // The snapshot is the authoritative current state, so reconcile
            // rather than merge: anything deleted while the socket was down
            // gets no replayed removal event and must be dropped here.
            projectsByID = Dictionary(
                snapshot.projects.map { ($0.id, mapProject($0)) },
                uniquingKeysWith: { _, new in new })
            emit(.projectsChanged(currentProjectList()))
            let snapshotThreadIDs = Set(snapshot.threads.map(\.id))
            for id in threadsByID.keys where !snapshotThreadIDs.contains(id) {
                threadsByID[id] = nil
                emit(.threadRemoved(id: id))
            }
            for shell in snapshot.threads {
                let thread = mapThread(shell)
                threadsByID[thread.id] = thread
                modelSelectionsByThread[thread.id] = shell.modelSelection
                emit(.threadUpserted(thread))
            }
        case .event(let event):
            switch event {
            case .projectUpserted(_, let shell):
                projectsByID[shell.id] = mapProject(shell)
                emit(.projectsChanged(currentProjectList()))
            case .projectRemoved(_, let projectID):
                projectsByID[projectID] = nil
                emit(.projectsChanged(currentProjectList()))
            case .threadUpserted(_, let shell):
                let thread = mapThread(shell)
                threadsByID[thread.id] = thread
                modelSelectionsByThread[thread.id] = shell.modelSelection
                emit(.threadUpserted(thread))
            case .threadRemoved(_, let threadID):
                threadsByID[threadID] = nil
                modelSelectionsByThread[threadID] = nil
                emit(.threadRemoved(id: threadID))
            }
        }
    }

    private func currentProjectList() -> [Project] {
        Array(projectsByID.values).sorted { $0.name < $1.name }
    }

    // MARK: - Server-config subscription (providers)

    private func handleServerConfigEvent(_ event: ServerConfigStreamEvent) {
        switch event {
        case .snapshot(let config):
            applyProviders(config.providers)
        case .providerStatuses(let payload):
            applyProviders(payload.providers)
        case .settingsUpdated, .keybindingsUpdated, .other:
            break
        }
    }

    private func applyProviders(_ providers: [ServerProvider]) {
        // Every wire payload carrying `providers` (getConfig, config snapshot,
        // providerStatuses, refresh/update results) is the full current list,
        // so replace rather than merge — an instance removed from the server
        // config must not linger as a selectable stale entry.
        providersByInstanceId = Dictionary(
            providers.map { ($0.instanceId, $0) },
            uniquingKeysWith: { _, new in new })
        emit(.providersChanged(currentProviderList()))
    }

    // MARK: - Per-thread subscription (timeline / approvals / checkpoints)

    private func startThreadSubscription(_ threadID: String, client: T3Client) {
        threadSubscriptions[threadID]?.cancel()
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let stream = await client.subscribeThread(threadId: threadID)
                for try await item in stream {
                    await self.handleThreadItem(threadID: threadID, item: item)
                }
                await self.failSnapshotWaiters(
                    threadID: threadID, error: LiveBackendError.notConnected)
            } catch {
                await self.failSnapshotWaiters(threadID: threadID, error: error)
            }
        }
        threadSubscriptions[threadID] = task
    }

    private func cancelAllThreadSubscriptions() {
        for task in threadSubscriptions.values {
            task.cancel()
        }
        threadSubscriptions.removeAll()
    }

    private func cancelAllVcsSubscriptions() {
        for task in vcsSubscriptions.values {
            task.cancel()
        }
        vcsSubscriptions.removeAll()
    }

    private func handleThreadItem(threadID: String, item: OrchestrationThreadStreamItem) {
        switch item {
        case .snapshot(let snapshot):
            applyThreadSnapshot(threadID: threadID, thread: snapshot.thread)
        case .event(let event):
            applyThreadEvent(threadID: threadID, event: event)
        }
    }

    private func applyThreadSnapshot(threadID: String, thread: OrchestrationThread) {
        // Seed dedup + delta state so live events for already-shown items don't
        // duplicate and assistant deltas continue from the snapshot text.
        seenMessageIDs[threadID] = Set(thread.messages.map(\.id))
        var assistantText: [String: String] = [:]
        for message in thread.messages where message.role == .assistant {
            assistantText[message.id] = message.text
        }
        assistantTextByMessage[threadID] = assistantText
        seenActivityIDs[threadID] = Set(thread.activities.map(\.id))
        seenCheckpointRefs[threadID] = Set(thread.checkpoints.map(\.checkpointRef))
        seenPlanIDs[threadID] = Set(thread.proposedPlans.map(\.id))

        // Only `approval.requested` is actionable; the server records
        // resolutions as separate `approval.resolved` activities with the same
        // tone. A request already named by a resolution must not resurface as
        // a pending card.
        var resolvedApprovalIDs: Set<String> = []
        for activity in thread.activities where activity.kind == ActivityKind.approvalResolved {
            if let requestID = OrchestrationMapping.extractRequestId(from: activity.payload) {
                resolvedApprovalIDs.insert(requestID)
            }
        }
        var pendingApprovalIDs: Set<String> = []
        for activity in thread.activities where activity.kind == ActivityKind.approvalRequested {
            let requestID =
                OrchestrationMapping.extractRequestId(from: activity.payload) ?? activity.id
            guard !resolvedApprovalIDs.contains(requestID) else { continue }
            pendingApprovalIDs.insert(requestID)
            approvalRoutes[requestID] = (threadID, requestID)
        }

        var checkpoints: [Checkpoint] = []
        var maxTurn = currentTurnCount[threadID] ?? 0
        for summary in thread.checkpoints {
            checkpointRoutes[summary.checkpointRef] = (threadID, summary.checkpointTurnCount)
            let at = WireDate.parse(summary.completedAt) ?? Date()
            checkpoints.append(
                Checkpoint(
                    id: summary.checkpointRef, threadID: threadID,
                    label: "Turn \(summary.checkpointTurnCount)", createdAt: at))
            maxTurn = max(maxTurn, summary.checkpointTurnCount)
        }
        checkpointsByThread[threadID] = checkpoints
        currentTurnCount[threadID] = maxTurn

        // Typed activity kinds: rebuild user-input routes (a request is
        // pending unless a later `user-input.resolved` names it) and replay
        // the latest plan/context-window side-channel state.
        var resolvedInputIDs: Set<String> = []
        for activity in thread.activities where activity.kind == ActivityKind.userInputResolved {
            let requestID =
                activity.decodePayload(UserInputResolvedActivityPayload.self)?.requestId
                ?? OrchestrationMapping.extractRequestId(from: activity.payload)
            if let requestID { resolvedInputIDs.insert(requestID) }
        }
        var pendingInputIDs: Set<String> = []
        for activity in thread.activities where activity.kind == ActivityKind.userInputRequested {
            let at = WireDate.parse(activity.createdAt) ?? Date()
            guard let request = mapUserInputRequest(activity, threadID: threadID, at: at),
                !resolvedInputIDs.contains(request.id)
            else { continue }
            pendingInputIDs.insert(request.id)
            userInputRoutes[request.id] = (threadID, request.id, request)
        }

        // Upsert (not append) so lifecycle activities sharing a row id —
        // tool updated/completed for one call, successive reasoning updates
        // of one task — collapse into a single row, same as the live tail.
        var items: [TimelineItem] = []
        for entry in OrchestrationMapping.timeline(for: thread) {
            guard
                let item = mapEntry(
                    entry, threadID: threadID, pendingUserInputIDs: pendingInputIDs,
                    pendingApprovalIDs: pendingApprovalIDs)
            else { continue }
            items.upsertTimelineItem(item)
        }
        // A prior timeline means this snapshot is a *re*-subscribe (e.g. after
        // a socket reconnect), not the thread's first load. `timeline()`
        // callers already have `latestTimeline` cached, so `snapshotWaiters`
        // (below) would be empty and any content that arrived during the gap
        // — including a resolved streaming state — would otherwise be silent.
        // Push the freshly rebuilt timeline to already-subscribed consumers.
        let isResubscribe = latestTimeline[threadID] != nil
        latestTimeline[threadID] = items
        if isResubscribe {
            emit(.timelineReset(threadID: threadID, items: items))
        }
        resolveSnapshotWaiters(threadID: threadID, items: items)

        // Side-channel state derived from the newest matching activity.
        if let activity = thread.activities.last(where: { $0.kind == ActivityKind.turnPlanUpdated }),
            let payload = activity.decodePayload(TurnPlanUpdatedActivityPayload.self)
        {
            let steps = payload.plan.enumerated().map { index, step in
                PlanStep(id: index, title: step.step, status: Self.uiPlanStatus(step.status))
            }
            emit(
                .planProgressUpdated(
                    threadID: threadID,
                    progress: PlanProgress(steps: steps, explanation: payload.explanation)))
        }
        if let activity = thread.activities.last(where: {
            $0.kind == ActivityKind.contextWindowUpdated
        }),
            let payload = activity.decodePayload(ContextWindowUpdatedActivityPayload.self)
        {
            emit(
                .contextWindowUpdated(
                    threadID: threadID,
                    status: ContextWindowStatus(
                        usedTokens: payload.usedTokens, maxTokens: payload.maxTokens)))
        }
    }

    private func applyThreadEvent(threadID: String, event: OrchestrationEvent) {
        switch event.payload {
        case .threadMessageSent(let payload):
            applyMessageSent(threadID: threadID, payload: payload)

        case .threadActivityAppended(let payload):
            let activity = payload.activity
            // The live tail is not filtered by snapshot sequence (unlike
            // subscribeShell), so an activity already folded into the snapshot
            // can also arrive here again; dedup by id, seeded from the snapshot.
            guard !(seenActivityIDs[threadID]?.contains(activity.id) ?? false) else { return }
            seenActivityIDs[threadID, default: []].insert(activity.id)
            let at = WireDate.parse(activity.createdAt) ?? Date()
            // Typed activity kinds (user-input, live plan, context window)
            // are consumed into dedicated events, not generic timeline rows.
            if consumeSpecialActivity(activity, threadID: threadID, at: at, appendToTimeline: true) {
                return
            }
            switch activity.kind {
            case ActivityKind.approvalRequested:
                let requestID =
                    OrchestrationMapping.extractRequestId(from: activity.payload) ?? activity.id
                approvalRoutes[requestID] = (threadID, requestID)
                let request = ApprovalRequest(
                    id: requestID, threadID: threadID, kind: approvalKind(activity.kind),
                    title: activity.summary.isEmpty ? "Approval required" : activity.summary,
                    detail: approvalDetail(activity.payload), createdAt: at)
                emit(.approvalRequested(request))
                emit(.timelineAppended(threadID: threadID, item: .approval(request)))
            case ActivityKind.approvalResolved:
                // The request was answered (possibly by another client);
                // retire the pending card instead of rendering a new one —
                // both activities share tone `.approval`.
                if let requestID = OrchestrationMapping.extractRequestId(from: activity.payload) {
                    approvalRoutes[requestID] = nil
                    emit(.approvalResolved(id: requestID))
                }
            default:
                guard let item = mapActivity(activity, at: at) else { return }
                emit(.timelineAppended(threadID: threadID, item: item))
            }

        case .threadProposedPlanUpserted(let payload):
            let plan = payload.proposedPlan
            guard !(seenPlanIDs[threadID]?.contains(plan.id) ?? false) else { return }
            seenPlanIDs[threadID, default: []].insert(plan.id)
            let at = WireDate.parse(plan.createdAt) ?? Date()
            emit(
                .timelineAppended(
                    threadID: threadID,
                    item: .plan(
                        ProposedPlan(
                            id: plan.id, threadID: threadID, markdown: plan.planMarkdown,
                            isImplemented: plan.implementedAt != nil, createdAt: at))))

        case .threadTurnDiffCompleted(let payload):
            currentTurnCount[threadID] = max(
                currentTurnCount[threadID] ?? 0, payload.checkpointTurnCount)
            checkpointRoutes[payload.checkpointRef] = (threadID, payload.checkpointTurnCount)
            // Dedup by checkpointRef: a checkpoint already present in the
            // snapshot can also arrive again on the unfiltered live tail.
            // currentTurnCount/checkpointRoutes above stay idempotent either
            // way, but the timeline item + checkpointsByThread list must not
            // gain a duplicate entry.
            guard !(seenCheckpointRefs[threadID]?.contains(payload.checkpointRef) ?? false) else {
                return
            }
            seenCheckpointRefs[threadID, default: []].insert(payload.checkpointRef)
            let at = WireDate.parse(payload.completedAt) ?? Date()
            let checkpoint = Checkpoint(
                id: payload.checkpointRef, threadID: threadID,
                label: "Turn \(payload.checkpointTurnCount)", createdAt: at)
            checkpointsByThread[threadID, default: []].append(checkpoint)
            emit(.timelineAppended(threadID: threadID, item: .checkpoint(checkpoint)))
            emit(.diffInvalidated(threadID: threadID))

        case .threadReverted(let payload):
            // The revert rewinds the thread to `turnCount`; checkpoints (and
            // the diff turn cursor) beyond it no longer exist server-side.
            // Leaving them tracked would keep stale restore points visible
            // and make `diff()` query a turn count that was reverted away.
            currentTurnCount[threadID] = payload.turnCount
            checkpointsByThread[threadID]?.removeAll { checkpoint in
                guard let route = checkpointRoutes[checkpoint.id] else { return false }
                return route.turnCount > payload.turnCount
            }
            for (ref, route) in checkpointRoutes
            where route.threadID == threadID && route.turnCount > payload.turnCount {
                checkpointRoutes[ref] = nil
                seenCheckpointRefs[threadID]?.remove(ref)
            }
            emit(.diffInvalidated(threadID: threadID))
            emit(
                .timelineAppended(
                    threadID: threadID,
                    item: .notice(
                        id: "revert-\(event.eventId)",
                        text: "Reverted to turn \(payload.turnCount).", at: Date())))

        // Status is projected from the shell subscription; the remaining events
        // (session-set, meta-updated, turn-start/interrupt requests, user-input,
        // approval-response-requested, etc.) are intentionally not mirrored into
        // the timeline here. TODO: surface user-input prompts once the UI grows a
        // dedicated affordance (today it only models approvals).
        default:
            break
        }
    }

    /// Consumes an activity with a well-known typed kind (ActivityKind.*).
    /// Returns false when the activity is not special — the caller falls
    /// through to generic tone-based mapping. When true, the dedicated
    /// BackendEvents were emitted; `.userInput` additionally joins the
    /// timeline when `appendToTimeline` is set (live tail; snapshot rebuilds
    /// the timeline wholesale instead).
    private func consumeSpecialActivity(
        _ activity: OrchestrationThreadActivity, threadID: String, at: Date,
        appendToTimeline: Bool
    ) -> Bool {
        switch activity.kind {
        case ActivityKind.userInputRequested:
            guard let request = mapUserInputRequest(activity, threadID: threadID, at: at) else {
                return false  // Malformed payload: degrade to generic rendering.
            }
            userInputRoutes[request.id] = (threadID, request.id, request)
            emit(.userInputRequested(request))
            if appendToTimeline {
                emit(.timelineAppended(threadID: threadID, item: .userInput(request)))
            }
            return true

        case ActivityKind.userInputResolved:
            let requestID =
                activity.decodePayload(UserInputResolvedActivityPayload.self)?.requestId
                ?? OrchestrationMapping.extractRequestId(from: activity.payload)
            if let requestID {
                userInputRoutes[requestID] = nil
                emit(.userInputResolved(id: requestID))
            }
            return true

        case ActivityKind.turnPlanUpdated:
            guard let payload = activity.decodePayload(TurnPlanUpdatedActivityPayload.self) else {
                return false
            }
            let steps = payload.plan.enumerated().map { index, step in
                PlanStep(id: index, title: step.step, status: Self.uiPlanStatus(step.status))
            }
            emit(
                .planProgressUpdated(
                    threadID: threadID,
                    progress: PlanProgress(steps: steps, explanation: payload.explanation)))
            return true

        case ActivityKind.contextWindowUpdated:
            guard let payload = activity.decodePayload(ContextWindowUpdatedActivityPayload.self)
            else { return false }
            emit(
                .contextWindowUpdated(
                    threadID: threadID,
                    status: ContextWindowStatus(
                        usedTokens: payload.usedTokens, maxTokens: payload.maxTokens)))
            return true

        default:
            return false
        }
    }

    private func mapUserInputRequest(
        _ activity: OrchestrationThreadActivity, threadID: String, at: Date
    ) -> UserInputRequest? {
        guard let payload = activity.decodePayload(UserInputRequestedActivityPayload.self),
            !payload.questions.isEmpty
        else { return nil }
        let requestID = payload.requestId ?? activity.id
        let questions = payload.questions.map { question in
            UserInputQuestionItem(
                id: question.id, header: question.header, question: question.question,
                options: question.options.map {
                    UserInputOption(label: $0.label, detail: $0.description)
                },
                multiSelect: question.multiSelect)
        }
        return UserInputRequest(id: requestID, threadID: threadID, questions: questions, createdAt: at)
    }

    private static func uiPlanStatus(_ status: TurnPlanStepStatus?) -> PlanStepStatus {
        switch status {
        case .pending, nil: .pending
        case .inProgress: .inProgress
        case .completed: .completed
        }
    }

    private func applyMessageSent(threadID: String, payload: ThreadMessageSentPayload) {
        let at = WireDate.parse(payload.createdAt) ?? Date()
        let messageID = payload.messageId
        let alreadySeen = seenMessageIDs[threadID]?.contains(messageID) ?? false

        switch payload.role {
        case .user:
            guard !alreadySeen else { return }
            seenMessageIDs[threadID, default: []].insert(messageID)
            emit(
                .timelineAppended(
                    threadID: threadID,
                    item: .userMessage(id: messageID, text: payload.text, at: at)))

        case .assistant:
            if !alreadySeen {
                seenMessageIDs[threadID, default: []].insert(messageID)
                assistantTextByMessage[threadID, default: [:]][messageID] = payload.text
                emit(
                    .timelineAppended(
                        threadID: threadID,
                        item: .assistantMessage(
                            id: messageID, markdown: payload.text,
                            isStreaming: payload.streaming, at: at)))
            } else {
                let old = assistantTextByMessage[threadID]?[messageID] ?? ""
                let delta = Self.assistantDelta(new: payload.text, old: old)
                assistantTextByMessage[threadID, default: [:]][messageID] = payload.text
                if !delta.isEmpty {
                    emit(.assistantDelta(threadID: threadID, messageID: messageID, delta: delta))
                }
            }
            if !payload.streaming {
                // The terminal, non-streaming `message-sent` is authoritative —
                // pass the server's full text so the UI corrects any lossy/
                // skipped delta (see `assistantDelta(new:old:)`) on completion.
                emit(
                    .assistantCompleted(
                        threadID: threadID, messageID: messageID, markdown: payload.text))
            }

        case .system:
            guard !alreadySeen else { return }
            seenMessageIDs[threadID, default: []].insert(messageID)
            emit(
                .timelineAppended(
                    threadID: threadID,
                    item: .notice(id: messageID, text: payload.text, at: at)))
        }
    }

    /// A wire `message-sent` carries the full assistant text, not a delta; we
    /// diff against the last-seen text. A pure append yields the new suffix; a
    /// non-append replacement can't be represented as a delta and is skipped
    /// (returns "") rather than corrupting the rendered message.
    private static func assistantDelta(new: String, old: String) -> String {
        if old.isEmpty { return new }
        if new.hasPrefix(old) { return String(new.dropFirst(old.count)) }
        return ""
    }

    private func resolveSnapshotWaiters(threadID: String, items: [TimelineItem]) {
        let waiters = snapshotWaiters.removeValue(forKey: threadID) ?? []
        for waiter in waiters {
            waiter.resume(returning: items)
        }
    }

    private func failSnapshotWaiters(threadID: String, error: Error) {
        let waiters = snapshotWaiters.removeValue(forKey: threadID) ?? []
        for waiter in waiters {
            waiter.resume(throwing: error)
        }
    }

    private func failAllSnapshotWaiters(error: Error) {
        for waiters in snapshotWaiters.values {
            for waiter in waiters {
                waiter.resume(throwing: error)
            }
        }
        snapshotWaiters.removeAll()
    }

    // MARK: - BackendService: queries

    public func projects() async throws -> [Project] {
        Array(projectsByID.values).sorted { $0.name < $1.name }
    }

    public func threads() async throws -> [ChatThread] {
        Array(threadsByID.values).sorted { $0.updatedAt > $1.updatedAt }
    }

    public func timeline(threadID: String) async throws -> [TimelineItem] {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        activeThreadIDs.insert(threadID)
        if threadSubscriptions[threadID] == nil {
            startThreadSubscription(threadID, client: client)
        }
        if let cached = latestTimeline[threadID] {
            return cached
        }
        return try await withCheckedThrowingContinuation { continuation in
            snapshotWaiters[threadID, default: []].append(continuation)
        }
    }

    public func providers() async throws -> [ProviderInstance] {
        currentProviderList()
    }

    public func models() async throws -> [ModelOption] {
        providersByInstanceId.values
            .flatMap { provider -> [ModelOption] in
                guard let kind = providerKind(fromDriver: provider.driver) else { return [] }
                return provider.models.map { model in
                    let effort = Self.effortDescriptor(of: model)
                    return ModelOption(
                        instanceID: provider.instanceId, modelID: model.slug,
                        displayName: model.name, provider: kind,
                        // The wire has no per-instance default marker; the first
                        // listed model is what `modelSelection(for:)` picks for
                        // new threads, so mark that one.
                        isDefault: model.slug == provider.models.first?.slug,
                        effortOptionID: effort?.id,
                        effortChoices: effort?.options.map {
                            EffortChoice(id: $0.id, label: $0.label, isDefault: $0.isDefault ?? false)
                        } ?? [])
                }
            }
            .sorted { ($0.provider.rawValue, $0.displayName) < ($1.provider.rawValue, $1.displayName) }
    }

    // MARK: - BackendService: commands

    public func createThread(
        projectID: String, provider: ProviderKind, title: String?
    ) async throws -> ChatThread {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let selection = modelSelection(for: provider) else {
            throw LiveBackendError.noProviderForKind(provider)
        }
        let threadID = UUID().uuidString
        let title = title ?? "New \(provider.displayName) thread"
        _ = try await client.createThread(
            threadId: threadID, projectId: projectID, title: title, modelSelection: selection,
            runtimeMode: .fullAccess)
        let thread = ChatThread(
            id: threadID, projectID: projectID, title: title, provider: provider, status: .idle,
            updatedAt: Date())
        threadsByID[threadID] = thread
        modelSelectionsByThread[threadID] = selection
        // Emit immediately: the shell subscription's authoritative upsert can
        // lag (or be missed across a reconnect), and the caller selects the
        // thread right away — without this the detail pane shows an empty
        // state for a thread that exists.
        emit(.threadUpserted(thread))
        return thread
    }

    public func archiveThread(id: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.archiveThread(threadId: id)
        // The shell subscription re-emits the thread with archivedAt set.
    }

    public func unarchiveThread(id: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.unarchiveThread(threadId: id)
    }

    public func deleteThread(id: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.deleteThread(threadId: id)
        // The shell subscription emits thread-removed; drop local caches now
        // so a re-created id never sees stale dedup state.
        threadsByID[id] = nil
        latestTimeline[id] = nil
        activeThreadIDs.remove(id)
        threadSubscriptions[id]?.cancel()
        threadSubscriptions[id] = nil
    }

    public func sendMessage(
        threadID: String, text: String, attachments: [OutgoingAttachment]
    ) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        // The wire command requires modes; echo the thread's current ones so a
        // send never silently flips an approval-required thread to full access.
        let thread = threadsByID[threadID]
        let uploads = attachments.map { attachment in
            UploadChatAttachment(
                name: attachment.name, mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes, dataUrl: attachment.dataURL)
        }
        _ = try await client.startTurn(
            threadId: threadID, text: text, attachments: uploads,
            runtimeMode: thread.map { Self.wireRuntimeMode($0.runtimeMode) } ?? .wireDefault,
            interactionMode: thread.map { Self.wireInteractionMode($0.interactionMode) } ?? .wireDefault)
    }

    public func searchWorkspace(projectID: String, query: String) async throws -> [WorkspaceEntry] {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let project = projectsByID[projectID] else { return [] }
        let result = try await client.searchEntries(cwd: project.path, query: query, limit: 20)
        return result.entries.map {
            WorkspaceEntry(path: $0.path, isDirectory: $0.kind == .directory)
        }
    }

    public func listWorkspace(projectID: String, subpath: String) async throws -> [WorkspaceEntry] {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let root = try projectCwd(projectID)
        let cwd = subpath.isEmpty ? root : root + "/" + subpath
        let result = try await client.listEntries(cwd: cwd)
        return result.entries
            .map { WorkspaceEntry(path: $0.path, isDirectory: $0.kind == .directory) }
            .sorted { lhs, rhs in
                if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
                return lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
            }
    }

    public func readWorkspaceFile(projectID: String, path: String) async throws -> FilePreview {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let result = try await client.readFile(cwd: try projectCwd(projectID), relativePath: path)
        return FilePreview(
            path: result.relativePath, contents: result.contents, truncated: result.truncated)
    }

    public func openInEditor(
        projectID: String, subpath: String?, editor: ExternalEditor
    ) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let root = try projectCwd(projectID)
        let cwd = subpath.map { root + "/" + $0 } ?? root
        try await client.openInEditor(cwd: cwd, editor: editor.rawValue)
    }

    public func implementPlan(threadID: String, planID: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let thread = threadsByID[threadID]
        // Implementation turns always run in the default interaction mode —
        // plan mode is what produced the plan being implemented.
        _ = try await client.startTurn(
            threadId: threadID, text: "Implement the proposed plan.",
            runtimeMode: thread.map { Self.wireRuntimeMode($0.runtimeMode) } ?? .wireDefault,
            interactionMode: .default,
            sourceProposedPlan: SourceProposedPlanReference(threadId: threadID, planId: planID))
    }

    public func cancelTurn(threadID: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.interruptTurn(threadId: threadID)
    }

    public func respondToApproval(id: String, approve: Bool) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let route = approvalRoutes[id] else {
            throw LiveBackendError.unresolvedApproval(id)
        }
        let decision = OrchestrationMapping.approvalDecision(approve: approve)
        _ = try await client.respondToApproval(
            threadId: route.threadID, requestId: route.requestId, decision: decision)
        approvalRoutes[id] = nil
        emit(.approvalResolved(id: id))
    }

    public func respondToUserInput(id: String, answers: [String: [String]]) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let route = userInputRoutes[id] else {
            throw LiveBackendError.unresolvedUserInput(id)
        }
        // Wire `answers` is Record<questionId, unknown>: multi-select questions
        // get an array of option labels, everything else a single string.
        var wireAnswers: ProviderUserInputAnswers = [:]
        for question in route.request.questions {
            guard let values = answers[question.id], !values.isEmpty else { continue }
            wireAnswers[question.id] =
                question.multiSelect
                ? .array(values.map { .string($0) })
                : .string(values[0])
        }
        _ = try await client.respondToUserInput(
            threadId: route.threadID, requestId: route.requestId, answers: wireAnswers)
        userInputRoutes[id] = nil
        emit(.userInputResolved(id: id))
    }

    public func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.setRuntimeMode(threadId: threadID, runtimeMode: Self.wireRuntimeMode(mode))
        updateCachedThread(threadID) { $0.runtimeMode = mode }
    }

    public func setInteractionMode(threadID: String, mode: ThreadInteractionMode) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.setInteractionMode(
            threadId: threadID, interactionMode: Self.wireInteractionMode(mode))
        updateCachedThread(threadID) { $0.interactionMode = mode }
    }

    public func setModel(threadID: String, model: ModelOption) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        // Options deliberately dropped: effort choice ids are per-model, so a
        // carried-over value could be invalid for the new model.
        let selection = ModelSelection(instanceId: model.instanceID, model: model.modelID)
        _ = try await client.updateThreadMeta(threadId: threadID, modelSelection: selection)
        modelSelectionsByThread[threadID] = selection
        updateCachedThread(threadID) {
            $0.modelInstanceID = model.instanceID
            $0.modelID = model.modelID
            $0.provider = model.provider
            $0.reasoningEffort = nil
        }
    }

    /// Effort-style select descriptors go by different ids per driver
    /// (claudeAgent: "effort"; codex: "reasoningEffort"; cursor: "reasoning").
    private static let effortOptionIDs: Set<String> = ["effort", "reasoningEffort", "reasoning"]

    private static func effortDescriptor(of model: ServerProviderModel)
        -> SelectProviderOptionDescriptor?
    {
        model.capabilities?.optionDescriptors?.lazy.compactMap { descriptor in
            if case .select(let select) = descriptor, effortOptionIDs.contains(select.id) {
                return select
            }
            return nil
        }.first
    }

    /// The explicit effort value in a thread's modelSelection options, if any.
    private static func effortValue(of selection: ModelSelection) -> String? {
        selection.canonicalOptions?.lazy.compactMap { option -> String? in
            guard effortOptionIDs.contains(option.id), case .string(let value) = option.value
            else { return nil }
            return value
        }.first
    }

    public func setReasoningEffort(threadID: String, value: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let selection = modelSelectionsByThread[threadID] else {
            throw LiveBackendError.unknownThread(threadID)
        }
        guard
            let model = providersByInstanceId[selection.instanceId]?.models
                .first(where: { $0.slug == selection.model }),
            let descriptor = Self.effortDescriptor(of: model)
        else {
            throw LiveBackendError.noEffortOption(selection.model)
        }
        // Replace any prior effort selection, keep unrelated options.
        var options = selection.canonicalOptions ?? []
        options.removeAll { Self.effortOptionIDs.contains($0.id) }
        options.append(ProviderOptionSelection(id: descriptor.id, value: .string(value)))
        let updated = ModelSelection(
            instanceId: selection.instanceId, model: selection.model, canonicalOptions: options)
        _ = try await client.updateThreadMeta(threadId: threadID, modelSelection: updated)
        modelSelectionsByThread[threadID] = updated
        updateCachedThread(threadID) { $0.reasoningEffort = value }
    }

    /// Optimistically patch the cached thread and re-emit it; the shell
    /// subscription's authoritative upsert follows and overwrites.
    private func updateCachedThread(_ threadID: String, _ mutate: (inout ChatThread) -> Void) {
        guard var thread = threadsByID[threadID] else { return }
        mutate(&thread)
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))
    }

    public func diff(threadID: String) async throws -> [DiffFile] {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let toTurn = currentTurnCount[threadID], toTurn > 0 else {
            // No completed turn yet -> no diff to show (graceful, not an error).
            return []
        }
        let result = try await client.getFullThreadDiff(threadId: threadID, toTurnCount: toTurn)
        return UnifiedDiffParser.parse(result.diff)
    }

    public func checkpoints(threadID: String) async throws -> [Checkpoint] {
        checkpointsByThread[threadID] ?? []
    }

    public func restoreCheckpoint(id: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let route = checkpointRoutes[id] else {
            throw LiveBackendError.unresolvedCheckpoint(id)
        }
        _ = try await client.revertCheckpoint(threadId: route.threadID, turnCount: route.turnCount)
        emit(.diffInvalidated(threadID: route.threadID))
    }

    public func addProject(path: String) async throws -> Project {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let projectID = UUID().uuidString
        let name = (path as NSString).lastPathComponent
        let title = name.isEmpty ? path : name
        _ = try await client.createProject(
            projectId: projectID, title: title, workspaceRoot: path,
            createWorkspaceRootIfMissing: false)
        let project = Project(id: projectID, name: title, path: path)
        projectsByID[projectID] = project
        emit(.projectsChanged(currentProjectList()))
        return project
    }

    // MARK: - BackendService: git / VCS

    /// Live status subscriptions keyed by projectID; re-established on
    /// demand after reconnects (watchVcsStatus is called again by the UI).
    private var vcsSubscriptions: [String: Task<Void, Never>] = [:]
    /// Last combined local+remote projection per project.
    private var vcsLocal: [String: VcsStatusLocal] = [:]
    private var vcsRemote: [String: VcsStatusRemote] = [:]

    public func watchVcsStatus(projectID: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let project = projectsByID[projectID] else { return }
        guard vcsSubscriptions[projectID] == nil else { return }
        let cwd = project.path
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let stream = await client.subscribeVcsStatus(cwd: cwd)
                for try await event in stream {
                    await self.applyVcsEvent(projectID: projectID, event: event)
                }
            } catch {
                // Stream ended (socket drop or non-repo error): forget the
                // subscription so the next watch call re-establishes it.
            }
            await self.clearVcsSubscription(projectID: projectID)
        }
        vcsSubscriptions[projectID] = task
    }

    private func clearVcsSubscription(projectID: String) {
        vcsSubscriptions[projectID] = nil
    }

    private func applyVcsEvent(projectID: String, event: VcsStatusStreamEvent) {
        switch event {
        case .snapshot(let local, let remote):
            vcsLocal[projectID] = local
            vcsRemote[projectID] = remote ?? vcsRemote[projectID]
        case .localUpdated(let local):
            vcsLocal[projectID] = local
        case .remoteUpdated(let remote):
            if let remote { vcsRemote[projectID] = remote }
        }
        guard let local = vcsLocal[projectID] else { return }
        emit(
            .vcsStatusChanged(
                projectID: projectID,
                status: Self.uiVcsStatus(local: local, remote: vcsRemote[projectID])))
    }

    private static func uiVcsStatus(local: VcsStatusLocal, remote: VcsStatusRemote?) -> VcsStatus {
        VcsStatus(
            isRepo: local.isRepo, branch: local.refName, isDefaultBranch: local.isDefaultRef,
            changedFileCount: local.workingTree.files.count,
            insertions: local.workingTree.insertions, deletions: local.workingTree.deletions,
            aheadCount: remote?.aheadCount ?? 0, behindCount: remote?.behindCount ?? 0,
            hasUpstream: remote?.hasUpstream ?? false, prNumber: remote?.pr?.number,
            prTitle: remote?.pr?.title, prURL: remote?.pr?.url)
    }

    private func projectCwd(_ projectID: String) throws -> String {
        guard let project = projectsByID[projectID] else {
            throw LiveBackendError.notConnected
        }
        return project.path
    }

    public func listBranches(projectID: String, query: String?) async throws -> [BranchRef] {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let result = try await client.listRefs(
            cwd: try projectCwd(projectID), query: query, refKind: "local", limit: 50)
        return result.refs.map {
            BranchRef(
                name: $0.name, isCurrent: $0.current, isDefault: $0.isDefault,
                isRemote: $0.isRemote ?? false)
        }
    }

    public func switchBranch(projectID: String, name: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.switchRef(cwd: try projectCwd(projectID), refName: name)
    }

    public func createBranch(projectID: String, name: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.createRef(cwd: try projectCwd(projectID), refName: name, switchRef: true)
    }

    public func pull(projectID: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.pull(cwd: try projectCwd(projectID))
    }

    public func runGitAction(
        projectID: String, action: GitAction, commitMessage: String?
    ) async throws -> GitActionOutcome {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let wireAction: GitStackedAction =
            switch action {
            case .commit: .commit
            case .push: .push
            case .commitPush: .commitPush
            case .commitPushPR: .commitPushPR
            }
        let stream = await client.runStackedAction(
            cwd: try projectCwd(projectID), action: wireAction, commitMessage: commitMessage)
        var outcome = GitActionOutcome(success: false, title: "No response from git action")
        for try await event in stream {
            switch event {
            case .finished(let result):
                outcome = GitActionOutcome(
                    success: true, title: result.toast.title, detail: result.toast.description,
                    prURL: result.toast.prURL)
            case .failed(_, let message):
                outcome = GitActionOutcome(success: false, title: message)
            case .started, .phaseStarted, .hookStarted, .hookOutput, .hookFinished:
                break
            }
        }
        return outcome
    }

    // MARK: - BackendService: settings + providers

    public func settings() async throws -> AppSettings {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        return Self.uiSettings(try await client.getSettings())
    }

    public func updateSettings(_ settings: AppSettings) async throws -> AppSettings {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let patch = ServerSettingsPatch(
            enableAssistantStreaming: settings.assistantStreaming,
            enableProviderUpdateChecks: settings.providerUpdateChecks,
            defaultThreadEnvMode: settings.defaultEnvMode == .worktree ? .worktree : .local,
            newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
            addProjectBaseDirectory: settings.addProjectBaseDirectory)
        return Self.uiSettings(try await client.updateSettings(patch: patch))
    }

    public func refreshProviders() async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let payload = try await client.refreshProviders()
        applyProviders(payload.providers)
    }

    public func updateProvider(instanceID: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let provider = providersByInstanceId[instanceID] else {
            throw LiveBackendError.noProviderInstance(instanceID)
        }
        let payload = try await client.updateProviderCLI(
            driver: provider.driver, instanceId: instanceID)
        applyProviders(payload.providers)
    }

    private static func uiSettings(_ settings: ServerSettings) -> AppSettings {
        AppSettings(
            assistantStreaming: settings.enableAssistantStreaming,
            providerUpdateChecks: settings.enableProviderUpdateChecks,
            defaultEnvMode: settings.defaultThreadEnvMode == .worktree ? .worktree : .local,
            newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
            addProjectBaseDirectory: settings.addProjectBaseDirectory)
    }

    // MARK: - Emit helper

    private func emit(_ event: BackendEvent) {
        if case .connection(let phase) = event {
            // Lightweight breadcrumb so there's real evidence of sidecar+socket
            // progress without a full logger (one line per transition, cheap).
            // stderr always (harmless — only meaningful for a terminal-attached
            // launch); the file breadcrumb is opt-in (`debugLogPath` is `nil`
            // unless `$SERGECODE_DEBUG_LOG` is set) for launches whose stdio
            // isn't attached to a terminal (e.g. `open`).
            let line = "[LiveBackend] connection -> \(phase)\n"
            FileHandle.standardError.write(Data(line.utf8))
            if let debugLogPath = Self.debugLogPath, let handle = FileHandle(forWritingAtPath: debugLogPath) {
                handle.seekToEndOfFile()
                handle.write(Data(line.utf8))
                handle.closeFile()
            }
        }
        continuation.yield(event)
    }

    // MARK: - Wire -> UI mapping

    private func mapProject(_ shell: OrchestrationProjectShell) -> Project {
        Project(id: shell.id, name: shell.title, path: shell.workspaceRoot)
    }

    private func mapThread(_ shell: OrchestrationThreadShell) -> ChatThread {
        let kind = resolveProviderKind(
            instanceId: shell.modelSelection.instanceId, providerName: shell.session?.providerName)
        let status = mapStatus(
            session: shell.session, latestTurn: shell.latestTurn, archivedAt: shell.archivedAt,
            hasPendingApprovals: shell.hasPendingApprovals || shell.hasPendingUserInput)
        let updatedAt = WireDate.parse(shell.updatedAt) ?? Date()
        return ChatThread(
            id: shell.id, projectID: shell.projectId, title: shell.title, provider: kind,
            status: status, updatedAt: updatedAt,
            runtimeMode: Self.uiRuntimeMode(shell.runtimeMode),
            interactionMode: Self.uiInteractionMode(shell.interactionMode),
            modelInstanceID: shell.modelSelection.instanceId, modelID: shell.modelSelection.model,
            reasoningEffort: Self.effortValue(of: shell.modelSelection))
    }

    // MARK: - Mode mapping (wire <-> UI)

    static func uiRuntimeMode(_ mode: RuntimeMode) -> ThreadRuntimeMode {
        switch mode {
        case .approvalRequired: .approvalRequired
        case .autoAcceptEdits: .autoAcceptEdits
        case .fullAccess: .fullAccess
        }
    }

    static func wireRuntimeMode(_ mode: ThreadRuntimeMode) -> RuntimeMode {
        switch mode {
        case .approvalRequired: .approvalRequired
        case .autoAcceptEdits: .autoAcceptEdits
        case .fullAccess: .fullAccess
        }
    }

    static func uiInteractionMode(_ mode: ProviderInteractionMode) -> ThreadInteractionMode {
        switch mode {
        case .default: .normal
        case .plan: .plan
        }
    }

    static func wireInteractionMode(_ mode: ThreadInteractionMode) -> ProviderInteractionMode {
        switch mode {
        case .normal: .default
        case .plan: .plan
        }
    }

    private func mapStatus(
        session: OrchestrationSession?, latestTurn: OrchestrationLatestTurn?, archivedAt: String?,
        hasPendingApprovals: Bool
    ) -> ThreadStatus {
        if archivedAt != nil { return .archived }
        if hasPendingApprovals { return .waitingApproval }
        if let status = session?.status {
            switch status {
            case .running, .starting: return .running
            case .error: return .error
            case .idle, .ready, .interrupted, .stopped: break
            }
        }
        if let state = latestTurn?.state {
            switch state {
            case .running: return .running
            case .error: return .error
            case .interrupted, .completed: break
            }
        }
        return .idle
    }

    /// Maps one merged timeline entry to a UI item. Returns nil for entries
    /// that live outside the timeline (plan/context-window side channels,
    /// answered user-input prompts).
    private func mapEntry(
        _ entry: T3TimelineEntry, threadID: String, pendingUserInputIDs: Set<String> = [],
        pendingApprovalIDs: Set<String> = []
    ) -> TimelineItem? {
        switch entry {
        case let .userMessage(id, text, at):
            return .userMessage(id: id, text: text, at: at)
        case let .assistantMessage(id, markdown, isStreaming, at):
            return .assistantMessage(id: id, markdown: markdown, isStreaming: isStreaming, at: at)
        case let .activity(activity, at):
            switch activity.kind {
            case ActivityKind.userInputRequested:
                guard let request = mapUserInputRequest(activity, threadID: threadID, at: at),
                    pendingUserInputIDs.contains(request.id)
                else { return nil }
                return .userInput(request)
            case ActivityKind.userInputResolved, ActivityKind.turnPlanUpdated,
                ActivityKind.contextWindowUpdated:
                return nil
            default:
                return mapActivity(activity, at: at)
            }
        case let .approvalActivity(activity, requestID, at):
            let id = requestID ?? activity.id
            // Actionable card only for a still-pending `approval.requested`;
            // resolved requests and `approval.resolved` records (same tone)
            // degrade to plain notices.
            guard activity.kind == ActivityKind.approvalRequested,
                pendingApprovalIDs.contains(id)
            else {
                return mapActivity(activity, at: at)
            }
            return .approval(
                ApprovalRequest(
                    id: id, threadID: threadID, kind: approvalKind(activity.kind),
                    title: activity.summary.isEmpty ? "Approval required" : activity.summary,
                    detail: approvalDetail(activity.payload), createdAt: at))
        case let .checkpoint(summary, at):
            return .checkpoint(
                Checkpoint(
                    id: summary.checkpointRef, threadID: threadID,
                    label: "Turn \(summary.checkpointTurnCount)", createdAt: at))
        case let .proposedPlan(plan, at):
            return .plan(
                ProposedPlan(
                    id: plan.id, threadID: threadID, markdown: plan.planMarkdown,
                    isImplemented: plan.implementedAt != nil, createdAt: at))
        }
    }

    /// Refined activity row (ActivityRows): lifecycle noise maps to nil,
    /// tool rows get their human title + payload detail, task progress
    /// surfaces the actual reasoning text. Row ids are stable across one
    /// tool call / task, so consumers upsert rather than append.
    private func mapActivity(_ activity: OrchestrationThreadActivity, at: Date) -> TimelineItem? {
        switch ActivityRows.row(for: activity) {
        case .tool(let id, let title, let detail, let phase):
            let status: ToolEventStatus =
                switch phase {
                case .running: .running
                case .succeeded: .succeeded
                case .failed: .failed
                }
            return .toolEvent(id: id, name: title, detail: detail, status: status, at: at)
        case .reasoning(let id, let text):
            return .reasoning(id: id, text: text, at: at)
        case .notice(let id, let text):
            return .notice(id: id, text: text, at: at)
        case nil:
            return nil
        }
    }

    private func approvalKind(_ kind: String) -> ApprovalKind {
        let lowered = kind.lowercased()
        if lowered.contains("command") || lowered.contains("exec") || lowered.contains("shell")
            || lowered.contains("bash")
        {
            return .command
        }
        if lowered.contains("edit") || lowered.contains("write") || lowered.contains("file")
            || lowered.contains("patch") || lowered.contains("apply")
        {
            return .fileEdit
        }
        return .other
    }

    private func approvalDetail(_ payload: JSONValue) -> String {
        if let object = payload.objectValue {
            for key in ["command", "detail", "description", "message", "summary"] {
                if let value = object[key]?.stringValue { return value }
            }
        }
        if case let .string(value) = payload { return value }
        if let data = try? JSONEncoder().encode(payload),
            let string = String(data: data, encoding: .utf8), string != "null"
        {
            return string
        }
        return ""
    }

    private func resolveProviderKind(instanceId: String?, providerName: String?) -> ProviderKind {
        if let instanceId, let provider = providersByInstanceId[instanceId],
            let kind = providerKind(fromDriver: provider.driver)
        {
            return kind
        }
        if let providerName, let kind = providerKind(fromDriver: providerName) {
            return kind
        }
        // Fallback for a thread whose provider can't be resolved (e.g. its
        // instance is gone from the config, or an unmapped driver).
        return .claude
    }

    private func providerKind(fromDriver driver: String) -> ProviderKind? {
        let lowered = driver.lowercased()
        if lowered.contains("claude") { return .claude }
        if lowered.contains("codex") { return .codex }
        if lowered.contains("cursor") { return .cursor }
        if lowered.contains("opencode") { return .opencode }
        // No ProviderKind equivalent (e.g. "grok"): the closed enum can't hold it.
        return nil
    }

    private func currentProviderList() -> [ProviderInstance] {
        providersByInstanceId.values.compactMap { provider -> ProviderInstance? in
            guard let kind = providerKind(fromDriver: provider.driver) else { return nil }
            return ProviderInstance(
                id: provider.instanceId, kind: kind, availability: availability(for: provider),
                version: provider.version,
                slashCommands: provider.slashCommands.map {
                    SlashCommandInfo(
                        name: $0.name, detail: $0.description, argumentHint: $0.input?.hint)
                })
        }
        .sorted { $0.id < $1.id }
    }

    private func availability(for provider: ServerProvider) -> ProviderAvailability {
        if !provider.isAvailable || !provider.installed { return .missing }
        if provider.auth.status == .unauthenticated { return .authRequired }
        return .available
    }

    private func modelSelection(for provider: ProviderKind) -> ModelSelection? {
        // Same bar as the provider list UI (`availability(for:)`): an
        // uninstalled/unauthenticated instance, or one with no models, can't
        // run a thread — returning nil surfaces `noProviderForKind` instead
        // of sending the server an unusable ModelSelection.
        let chosen = providersByInstanceId.values.first {
            providerKind(fromDriver: $0.driver) == provider
                && availability(for: $0) == .available
                && !$0.models.isEmpty
        }
        guard let chosen, let model = chosen.models.first?.slug else { return nil }
        return ModelSelection(instanceId: chosen.instanceId, model: model)
    }
}

public enum LiveBackendError: Error, Sendable {
    case notConnected
    case unresolvedApproval(String)
    case unresolvedUserInput(String)
    case unresolvedCheckpoint(String)
    case noProviderForKind(ProviderKind)
    case noProviderInstance(String)
    case unknownThread(String)
    /// The thread's model exposes no reasoning-effort option descriptor.
    case noEffortOption(String)
}

// MARK: - Unified diff parsing (getFullThreadDiff string -> [DiffFile])

/// Minimal unified-diff parser for `git diff`-style output. Handles `diff --git`
/// file headers, new/deleted/rename status hints, `---`/`+++` path lines, `@@`
/// hunk headers, and +/-/context body lines. Line numbers are tracked from the
/// hunk header. Best-effort: filenames containing spaces or exotic diff options
/// may parse imperfectly; the goal is a faithful side-by-side render, not a
/// byte-exact reconstruction.
enum UnifiedDiffParser {
    static func parse(_ diff: String) -> [DiffFile] {
        var files: [DiffFile] = []

        var path: String?
        var status: DiffFileStatus = .modified
        var hunks: [DiffHunk] = []
        var hunkHeader: String?
        var lines: [DiffLine] = []
        var oldLine = 0
        var newLine = 0

        func flushHunk() {
            if let header = hunkHeader {
                hunks.append(DiffHunk(header: header, lines: lines))
            }
            hunkHeader = nil
            lines = []
        }
        func flushFile() {
            flushHunk()
            if let path {
                files.append(DiffFile(path: path, status: status, hunks: hunks))
            }
            path = nil
            status = .modified
            hunks = []
        }

        for raw in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("diff --git") {
                flushFile()
                path = gitPath(from: line)
                status = .modified
            } else if line.hasPrefix("new file") {
                status = .added
            } else if line.hasPrefix("deleted file") {
                status = .deleted
            } else if line.hasPrefix("rename ") || line.hasPrefix("copy ") {
                status = .renamed
            } else if line.hasPrefix("--- ") {
                // A bare unified diff with no `diff --git` header: treat a `---`
                // that arrives while we already have a file as a new file start.
                if path != nil && hunkHeader != nil { flushFile() }
            } else if line.hasPrefix("+++ ") {
                let candidate = stripPathPrefix(String(line.dropFirst(4)))
                if candidate != "/dev/null" { path = candidate }
            } else if line.hasPrefix("@@") {
                flushHunk()
                hunkHeader = line
                let starts = hunkStarts(from: line)
                oldLine = starts.old
                newLine = starts.new
            } else if hunkHeader != nil {
                switch line.first {
                case "+":
                    lines.append(
                        DiffLine(
                            kind: .addition, text: String(line.dropFirst()), oldNumber: nil,
                            newNumber: newLine))
                    newLine += 1
                case "-":
                    lines.append(
                        DiffLine(
                            kind: .deletion, text: String(line.dropFirst()), oldNumber: oldLine,
                            newNumber: nil))
                    oldLine += 1
                case "\\":
                    break  // "\ No newline at end of file"
                default:
                    let text = line.hasPrefix(" ") ? String(line.dropFirst()) : line
                    lines.append(
                        DiffLine(
                            kind: .context, text: text, oldNumber: oldLine, newNumber: newLine))
                    oldLine += 1
                    newLine += 1
                }
            }
        }
        flushFile()
        return files
    }

    /// `diff --git a/foo b/foo` -> `foo` (prefers the `b/` side).
    private static func gitPath(from line: String) -> String? {
        if let range = line.range(of: " b/") {
            return String(line[range.upperBound...])
        }
        if let range = line.range(of: " a/") {
            return String(line[range.upperBound...])
        }
        return nil
    }

    /// Strips a leading `a/` or `b/`, a trailing tab-timestamp, and passes
    /// `/dev/null` through unchanged.
    private static func stripPathPrefix(_ raw: String) -> String {
        var value = raw
        if let tab = value.firstIndex(of: "\t") {
            value = String(value[..<tab])
        }
        if value == "/dev/null" { return value }
        if value.hasPrefix("a/") || value.hasPrefix("b/") {
            value.removeFirst(2)
        }
        return value
    }

    /// Parses the old/new starting line numbers out of `@@ -a,b +c,d @@`.
    private static func hunkStarts(from header: String) -> (old: Int, new: Int) {
        var old = 0
        var new = 0
        let tokens = header.split(separator: " ")
        for token in tokens {
            if token.hasPrefix("-") {
                old = Int(token.dropFirst().split(separator: ",").first ?? "") ?? 0
            } else if token.hasPrefix("+") {
                new = Int(token.dropFirst().split(separator: ",").first ?? "") ?? 0
            }
        }
        return (old, new)
    }
}
