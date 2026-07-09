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
//    (claude/claude-synthero/codex/cursor/grok/fugu/opencode). Drivers with no ProviderKind
//    equivalent are dropped from providers() — ProviderKind is a closed enum
//    with no `.other`. See `providerKind(fromDriver:)`.
//  * A thread's ProviderKind is resolved from its modelSelection.instanceId via
//    the ServerConfig provider table, falling back to session.providerName, then
//    to `.claude`. Documented in `resolveProviderKind`.
//  * ThreadStatus is a projection of session.status + latestTurn.state +
//    hasPendingApprovals + archivedAt + active subagent task count (see
//    `mapStatus`); the shell subscription remains the source of truth for the
//    session/turn inputs. Per-thread task events only update the active-count
//    input and then re-run that projection.
//  * Assistant streaming: repeated `thread.message-sent` events for one
//    messageId carry DELTA chunks in `text` while `streaming` is true, and
//    the terminal `streaming: false` event replaces the full text only when
//    its `text` is non-empty (matching projector.ts, which appends streaming
//    chunks and keeps the accumulated text on an empty completion).
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
    private struct RunningLivenessCheck {
        let turnKey: String
        let task: Task<Void, Never>
    }
    private var runningLivenessChecks: [String: RunningLivenessCheck] = [:]
    private var latestRunningLivenessTurnKeys: [String: String] = [:]
    private var confirmedRunningTurnKeys: [String: String] = [:]
    private var staleRunningTurnKeys: [String: String] = [:]

    // MARK: Projection state (source for the query methods)

    private var projectsByID: [String: Project] = [:]
    private var threadsByID: [String: ChatThread] = [:]
    /// Latest wire modelSelection per thread — kept so option updates
    /// (reasoning effort) can round-trip instanceId/model/other options
    /// without re-fetching the shell.
    private var modelSelectionsByThread: [String: ModelSelection] = [:]
    /// Placeholder title a thread was created under by *this* client (scene
    /// name or "New … thread"). Sent as `titleSeed` on sends so first-turn
    /// title generation may replace it — never set for threads created
    /// elsewhere or before this launch, so custom titles are never seeded
    /// away.
    private var titleSeedsByThread: [String: String] = [:]
    private var providersByInstanceId: [String: ServerProvider] = [:]
    /// Latest shell per thread. Task lifecycle events re-project this cached
    /// shell with the active subagent count instead of writing a competing
    /// status value directly.
    private var threadShellsByID: [String: OrchestrationThreadShell] = [:]

    /// Where a thread runs, from its shell (`worktreePath`) plus whether it
    /// has started any turn (`latestTurn`). Drives the first-turn worktree
    /// bootstrap: a turnless thread with no worktree gets one when the
    /// server's defaultThreadEnvMode says so (web-client parity).
    private struct ThreadEnvState {
        var worktreePath: String?
        var hasTurns: Bool
    }
    private var threadEnvByThread: [String: ThreadEnvState] = [:]

    /// Threads the UI has opened; re-subscribed on every reconnect.
    private var activeThreadIDs: Set<String> = []
    /// Latest mapped timeline per opened thread (returned by `timeline`).
    private var latestTimeline: [String: [TimelineItem]] = [:]
    /// Callers awaiting a thread's first snapshot before `timeline` can return.
    private var snapshotWaiters: [String: [CheckedContinuation<[TimelineItem], Error>]] = [:]
    /// Callers awaiting `thread.reverted` after dispatching a checkpoint
    /// revert — the RPC returns when the command is accepted, but the
    /// timeline (and provider conversation) only rewinds when the event
    /// lands. Edit-resend must not start a new turn until then.
    private var revertWaiters: [String: [CheckedContinuation<Void, Error>]] = [:]

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

    /// Wire assistant deltas arrive per chunk; buffer them here and emit a
    /// merged `.assistantDelta` at ~30Hz so AppModel's intake (also ~30Hz)
    /// isn't flooded with single-token events. Keyed threadID → messageID → text.
    private var pendingAssistantDeltas: [String: [String: String]] = [:]
    /// True while a flush-after-33ms task is outstanding.
    private var deltaFlushScheduled = false

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
    /// Active/background delegated task lifecycle, rebuilt from thread
    /// snapshots and advanced by live `task.*` activity events.
    private var subagentTasksByThread: [String: T3SubagentTaskActivityState] = [:]

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

    /// When true, the sidecar binds `0.0.0.0` instead of loopback so the
    /// SergeCode mobile app can connect over the local network. Auth is
    /// still required (pairing token exchange + per-connection wsTicket);
    /// the server flips its policy to `remote-reachable`, which keeps the
    /// desktop-bootstrap method available (EnvironmentAuthPolicy.ts).
    /// Fixed for the life of the process; read from
    /// `MobileAccessPreference` at construction (App.swift).
    private let allowLanAccess: Bool
    /// Port of the running sidecar, captured at spawn for the mobile
    /// pairing URL.
    private var sidecarPort: Int?
    private static let runningLivenessConfirmationDelay: Duration = .seconds(12)

    public init(allowLanAccess: Bool = false) {
        self.allowLanAccess = allowLanAccess
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
            sidecarConfig = try SidecarConfig(
                nodePath: nodePath, entryPath: entryPath,
                host: allowLanAccess ? "0.0.0.0" : "127.0.0.1")
        } catch {
            emit(.connection(.failed("Could not configure the server sidecar: \(error)")))
            return
        }
        sidecarPort = sidecarConfig.port

        // The app's own connection always goes over loopback, regardless of
        // the bind host (0.0.0.0 is not a connectable address).
        let kit = T3KitConfig(
            host: "127.0.0.1", port: sidecarConfig.port, desktopBootstrapToken: token)
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
        cancelAllRunningLivenessChecks()

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
        failAllRevertWaiters(error: LiveBackendError.notConnected)
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
        cancelAllRunningLivenessChecks()
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
                titleSeedsByThread[id] = nil
                threadEnvByThread[id] = nil
                threadShellsByID[id] = nil
                subagentTasksByThread[id] = nil
                clearRunningLivenessState(threadID: id)
                emitOrdered(threadID: id, event: .threadRemoved(id: id))
            }
            for shell in snapshot.threads {
                threadShellsByID[shell.id] = shell
                let thread = mapThread(shell)
                threadsByID[thread.id] = thread
                modelSelectionsByThread[thread.id] = shell.modelSelection
                threadEnvByThread[thread.id] = ThreadEnvState(
                    worktreePath: shell.worktreePath, hasTurns: shell.latestTurn != nil)
                emitOrdered(threadID: thread.id, event: .threadUpserted(thread))
                reconcileRunningLiveness(for: shell)
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
                threadShellsByID[shell.id] = shell
                let thread = mapThread(shell)
                threadsByID[thread.id] = thread
                modelSelectionsByThread[thread.id] = shell.modelSelection
                threadEnvByThread[thread.id] = ThreadEnvState(
                    worktreePath: shell.worktreePath, hasTurns: shell.latestTurn != nil)
                restartVcsWatchIfStale(threadID: thread.id)
                emitOrdered(threadID: thread.id, event: .threadUpserted(thread))
                reconcileRunningLiveness(for: shell)
            case .threadRemoved(_, let threadID):
                threadsByID[threadID] = nil
                modelSelectionsByThread[threadID] = nil
                titleSeedsByThread[threadID] = nil
                threadEnvByThread[threadID] = nil
                threadShellsByID[threadID] = nil
                subagentTasksByThread[threadID] = nil
                clearRunningLivenessState(threadID: threadID)
                emitOrdered(threadID: threadID, event: .threadRemoved(id: threadID))
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
                await self.failRevertWaiters(
                    threadID: threadID, error: LiveBackendError.notConnected)
            } catch {
                await self.failSnapshotWaiters(threadID: threadID, error: error)
                await self.failRevertWaiters(threadID: threadID, error: error)
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

    private func reconcileRunningLiveness(for shell: OrchestrationThreadShell) {
        let turnKey = runningLivenessTurnKey(for: shell)
        latestRunningLivenessTurnKeys[shell.id] = turnKey
        // Liveness only watches running turns; background subagents have no
        // turn to go stale, so their count must not influence this projection.
        let wireStatus = mapStatus(
            session: shell.session, latestTurn: shell.latestTurn, archivedAt: shell.archivedAt,
            hasPendingApprovals: shell.hasPendingApprovals || shell.hasPendingUserInput,
            activeSubagentCount: 0)
        if wireStatus == .running {
            scheduleRunningLivenessCheck(
                threadID: shell.id, turnKey: turnKey)
        } else {
            clearRunningLivenessState(threadID: shell.id)
        }
    }

    private func runningLivenessTurnKey(for shell: OrchestrationThreadShell) -> String {
        shell.latestTurn?.turnId ?? shell.session?.activeTurnId ?? "pending-turn"
    }

    private func scheduleRunningLivenessCheck(threadID: String, turnKey: String) {
        if let existingCheck = runningLivenessChecks[threadID] {
            guard existingCheck.turnKey != turnKey else { return }
            existingCheck.task.cancel()
            runningLivenessChecks[threadID] = nil
        }

        guard confirmedRunningTurnKeys[threadID] != turnKey,
            staleRunningTurnKeys[threadID] != turnKey,
            let client = currentClient
        else { return }
        let task = Task { [weak self, client] in
            guard let self else { return }
            await self.runRunningLivenessCheck(
                threadID: threadID, turnKey: turnKey, client: client)
        }
        runningLivenessChecks[threadID] = RunningLivenessCheck(turnKey: turnKey, task: task)
    }

    private func runRunningLivenessCheck(threadID: String, turnKey: String, client: T3Client) async {
        do {
            let firstCheck = try await client.getThreadLiveness(threadId: threadID)
            try Task.checkCancellation()
            if firstCheck.hasActiveTurn {
                markRunningThreadLive(threadID: threadID, turnKey: turnKey)
                finishRunningLivenessCheck(threadID: threadID, turnKey: turnKey)
                return
            }

            try await Task.sleep(for: Self.runningLivenessConfirmationDelay)
            let secondCheck = try await client.getThreadLiveness(threadId: threadID)
            try Task.checkCancellation()
            if secondCheck.hasActiveTurn {
                markRunningThreadLive(threadID: threadID, turnKey: turnKey)
            } else {
                markRunningThreadStale(threadID: threadID, turnKey: turnKey)
            }
        } catch {
            if !Task.isCancelled {
                finishRunningLivenessCheck(threadID: threadID, turnKey: turnKey)
            }
            return
        }
        finishRunningLivenessCheck(threadID: threadID, turnKey: turnKey)
    }

    private func markRunningThreadStale(threadID: String, turnKey: String) {
        guard latestRunningLivenessTurnKeys[threadID] == turnKey else { return }
        confirmedRunningTurnKeys[threadID] = nil
        guard var thread = threadsByID[threadID], thread.status == .running else { return }
        staleRunningTurnKeys[threadID] = turnKey
        thread.status = .error
        threadsByID[threadID] = thread
        emitOrdered(threadID: threadID, event: .threadUpserted(thread))
    }

    private func markRunningThreadLive(threadID: String, turnKey: String) {
        guard latestRunningLivenessTurnKeys[threadID] == turnKey else { return }
        confirmedRunningTurnKeys[threadID] = turnKey
        let wasStale = staleRunningTurnKeys.removeValue(forKey: threadID) != nil
        guard wasStale, var thread = threadsByID[threadID], thread.status == .error else {
            return
        }
        thread.status = .running
        threadsByID[threadID] = thread
        emitOrdered(threadID: threadID, event: .threadUpserted(thread))
    }

    private func finishRunningLivenessCheck(threadID: String, turnKey: String) {
        guard runningLivenessChecks[threadID]?.turnKey == turnKey else { return }
        runningLivenessChecks[threadID] = nil
    }

    private func clearRunningLivenessState(threadID: String) {
        runningLivenessChecks[threadID]?.task.cancel()
        runningLivenessChecks[threadID] = nil
        latestRunningLivenessTurnKeys[threadID] = nil
        confirmedRunningTurnKeys[threadID] = nil
        staleRunningTurnKeys[threadID] = nil
    }

    private func cancelAllRunningLivenessChecks() {
        for check in runningLivenessChecks.values {
            check.task.cancel()
        }
        runningLivenessChecks.removeAll()
        latestRunningLivenessTurnKeys.removeAll()
        confirmedRunningTurnKeys.removeAll()
        staleRunningTurnKeys.removeAll()
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
                    label: "Turn \(summary.checkpointTurnCount)", createdAt: at,
                    turnCount: summary.checkpointTurnCount))
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
        // tool updated/completed for one call, subagent task lifecycle
        // updates — collapse into a single row, same as the live tail.
        var items: [TimelineItem] = []
        var subagentState = T3SubagentTaskActivityState()
        let hadSubagentTasks = !(subagentTasksByThread[threadID]?.items.isEmpty ?? true)
        for entry in OrchestrationMapping.timeline(for: thread) {
            if case let .activity(activity, at) = entry,
                Self.isTaskLifecycleActivity(activity),
                let task = subagentState.apply(activity: activity, at: at)
            {
                items.upsertTimelineItem(mapSubagentTask(task))
                continue
            }
            guard
                let item = mapEntry(
                    entry, threadID: threadID, pendingUserInputIDs: pendingInputIDs,
                    pendingApprovalIDs: pendingApprovalIDs)
            else { continue }
            items.upsertTimelineItem(item)
        }
        let hasSubagentTasks = !subagentState.items.isEmpty
        subagentTasksByThread[threadID] = hasSubagentTasks ? subagentState : nil
        // A prior timeline means this snapshot is a *re*-subscribe (e.g. after
        // a socket reconnect), not the thread's first load. `timeline()`
        // callers already have `latestTimeline` cached, so `snapshotWaiters`
        // (below) would be empty and any content that arrived during the gap
        // — including a resolved streaming state — would otherwise be silent.
        // Push the freshly rebuilt timeline to already-subscribed consumers.
        let isResubscribe = latestTimeline[threadID] != nil
        latestTimeline[threadID] = items
        if isResubscribe {
            emitOrdered(
                threadID: threadID, event: .timelineReset(threadID: threadID, items: items))
        }
        resolveSnapshotWaiters(threadID: threadID, items: items)
        if hadSubagentTasks || hasSubagentTasks {
            reemitThreadWithCurrentProjection(threadID: threadID)
        }

        // Side-channel state derived from the newest matching activity.
        if let activity = thread.activities.last(where: { $0.kind == ActivityKind.turnPlanUpdated }),
            let payload = activity.decodePayload(TurnPlanUpdatedActivityPayload.self)
        {
            let steps = payload.plan.enumerated().map { index, step in
                PlanStep(id: index, title: step.step, status: Self.uiPlanStatus(step.status))
            }
            emitOrdered(
                threadID: threadID,
                event: .planProgressUpdated(
                    threadID: threadID,
                    progress: PlanProgress(steps: steps, explanation: payload.explanation)))
        }
        if let activity = thread.activities.last(where: {
            $0.kind == ActivityKind.contextWindowUpdated
        }),
            let payload = activity.decodePayload(ContextWindowUpdatedActivityPayload.self)
        {
            emitOrdered(
                threadID: threadID,
                event: .contextWindowUpdated(
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
            if applySubagentTaskActivity(activity, threadID: threadID, at: at) {
                return
            }
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
                emitOrdered(threadID: threadID, event: .approvalRequested(request))
                emitOrdered(
                    threadID: threadID,
                    event: .timelineAppended(threadID: threadID, item: .approval(request)))
            case ActivityKind.approvalResolved:
                // The request was answered (possibly by another client);
                // retire the pending card instead of rendering a new one —
                // both activities share tone `.approval`.
                if let requestID = OrchestrationMapping.extractRequestId(from: activity.payload) {
                    approvalRoutes[requestID] = nil
                    emitOrdered(threadID: threadID, event: .approvalResolved(id: requestID))
                }
            default:
                guard let item = mapActivity(activity, at: at) else { return }
                emitOrdered(
                    threadID: threadID,
                    event: .timelineAppended(threadID: threadID, item: item))
            }

        case .threadProposedPlanUpserted(let payload):
            let plan = payload.proposedPlan
            guard !(seenPlanIDs[threadID]?.contains(plan.id) ?? false) else { return }
            seenPlanIDs[threadID, default: []].insert(plan.id)
            let at = WireDate.parse(plan.createdAt) ?? Date()
            emitOrdered(
                threadID: threadID,
                event: .timelineAppended(
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
                label: "Turn \(payload.checkpointTurnCount)", createdAt: at,
                turnCount: payload.checkpointTurnCount)
            checkpointsByThread[threadID, default: []].append(checkpoint)
            emitOrdered(
                threadID: threadID,
                event: .timelineAppended(threadID: threadID, item: .checkpoint(checkpoint)))
            emitOrdered(threadID: threadID, event: .diffInvalidated(threadID: threadID))

        case .threadReverted(let payload):
            // The revert rewinds the thread to `turnCount`; checkpoints (and
            // the diff turn cursor) beyond it no longer exist server-side.
            // Leaving them tracked would keep stale restore points visible
            // and make `diff()` query a turn count that was reverted away.
            // The subscribeThread stream does not re-emit a full snapshot on
            // revert, so rebuild the local timeline by retaining the first
            // `turnCount` user turns (server projector parity).
            currentTurnCount[threadID] = payload.turnCount
            checkpointsByThread[threadID]?.removeAll { checkpoint in
                guard let route = checkpointRoutes[checkpoint.id] else {
                    return checkpoint.turnCount > payload.turnCount
                }
                return route.turnCount > payload.turnCount
            }
            for (ref, route) in checkpointRoutes
            where route.threadID == threadID && route.turnCount > payload.turnCount {
                checkpointRoutes[ref] = nil
                seenCheckpointRefs[threadID]?.remove(ref)
            }
            let retained = Self.timelineRetaining(
                turnCount: payload.turnCount, from: latestTimeline[threadID] ?? [])
            latestTimeline[threadID] = retained
            // Rebuild dedup sets from the truncated timeline so a later live
            // event for a dropped message can reappear cleanly after resend.
            var retainedMessageIDs: Set<String> = []
            var retainedActivityIDs: Set<String> = []
            var retainedPlanIDs: Set<String> = []
            var retainedCheckpointRefs: Set<String> = []
            for item in retained {
                switch item {
                case .userMessage(let id, _, _), .assistantMessage(let id, _, _, _):
                    retainedMessageIDs.insert(id)
                case .toolEvent(let id, _, _, _, _, _, _, _),
                    .reasoning(let id, _, _),
                    .notice(let id, _, _):
                    retainedActivityIDs.insert(id)
                case .subagentTask(let task):
                    retainedActivityIDs.insert(task.id)
                case .plan(let plan):
                    retainedPlanIDs.insert(plan.id)
                case .checkpoint(let checkpoint):
                    retainedCheckpointRefs.insert(checkpoint.id)
                case .approval(let request):
                    retainedActivityIDs.insert(request.id)
                case .userInput(let request):
                    retainedActivityIDs.insert(request.id)
                case .usageLimit(let notice):
                    retainedActivityIDs.insert(notice.id)
                }
            }
            seenMessageIDs[threadID] = retainedMessageIDs
            seenActivityIDs[threadID] = retainedActivityIDs
            seenPlanIDs[threadID] = retainedPlanIDs
            seenCheckpointRefs[threadID] = retainedCheckpointRefs
            if var assistantText = assistantTextByMessage[threadID] {
                assistantText = assistantText.filter { retainedMessageIDs.contains($0.key) }
                assistantTextByMessage[threadID] = assistantText
            }
            pendingAssistantDeltas[threadID] = nil
            emitOrdered(
                threadID: threadID,
                event: .timelineReset(threadID: threadID, items: retained))
            emitOrdered(threadID: threadID, event: .diffInvalidated(threadID: threadID))
            emitOrdered(
                threadID: threadID,
                event: .timelineAppended(
                    threadID: threadID,
                    item: .notice(
                        id: "revert-\(event.eventId)",
                        text: "Reverted to turn \(payload.turnCount).", at: Date())))
            resolveRevertWaiters(threadID: threadID)

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
            emitOrdered(threadID: threadID, event: .userInputRequested(request))
            if appendToTimeline {
                emitOrdered(
                    threadID: threadID,
                    event: .timelineAppended(threadID: threadID, item: .userInput(request)))
            }
            return true

        case ActivityKind.usageLimitReached:
            guard let notice = mapUsageLimitNotice(activity, threadID: threadID, at: at) else {
                return false
            }
            if appendToTimeline {
                emitOrdered(
                    threadID: threadID,
                    event: .timelineAppended(threadID: threadID, item: .usageLimit(notice)))
            }
            return true

        case ActivityKind.userInputResolved:
            let requestID =
                activity.decodePayload(UserInputResolvedActivityPayload.self)?.requestId
                ?? OrchestrationMapping.extractRequestId(from: activity.payload)
            if let requestID {
                userInputRoutes[requestID] = nil
                emitOrdered(threadID: threadID, event: .userInputResolved(id: requestID))
            }
            return true

        case ActivityKind.turnPlanUpdated:
            guard let payload = activity.decodePayload(TurnPlanUpdatedActivityPayload.self) else {
                return false
            }
            let steps = payload.plan.enumerated().map { index, step in
                PlanStep(id: index, title: step.step, status: Self.uiPlanStatus(step.status))
            }
            emitOrdered(
                threadID: threadID,
                event: .planProgressUpdated(
                    threadID: threadID,
                    progress: PlanProgress(steps: steps, explanation: payload.explanation)))
            return true

        case ActivityKind.contextWindowUpdated:
            guard let payload = activity.decodePayload(ContextWindowUpdatedActivityPayload.self)
            else { return false }
            emitOrdered(
                threadID: threadID,
                event: .contextWindowUpdated(
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

    private func mapUsageLimitNotice(
        _ activity: OrchestrationThreadActivity, threadID: String, at: Date
    ) -> UsageLimitNotice? {
        guard let payload = activity.decodePayload(UsageLimitReachedActivityPayload.self) else {
            return nil
        }
        let resetAt =
            payload.resetsAt.flatMap(WireDate.parse)
            ?? payload.resetsAtEpochSeconds.map { Date(timeIntervalSince1970: TimeInterval($0)) }
        let provider = payload.provider.flatMap(providerKind(fromDriver:))
        let providerName =
            provider?.displayName
            ?? payload.provider?.replacingOccurrences(of: "Agent", with: " Agent")
            ?? "Agent"
        return UsageLimitNotice(
            id: activity.id,
            threadID: threadID,
            provider: provider,
            providerName: providerName,
            message: payload.message,
            resetsAt: resetAt,
            createdAt: at)
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
            emitOrdered(
                threadID: threadID,
                event: .timelineAppended(
                    threadID: threadID,
                    item: .userMessage(id: messageID, text: payload.text, at: at)))

        case .assistant:
            // Wire semantics (projector.ts "thread.message-sent"): while
            // `streaming` is true, `text` is an append-only DELTA chunk; the
            // terminal `streaming: false` event replaces the full text only
            // when non-empty — providers routinely finish with `text: ""`,
            // which means "keep what streamed".
            if !alreadySeen {
                seenMessageIDs[threadID, default: []].insert(messageID)
                assistantTextByMessage[threadID, default: [:]][messageID] = payload.text
                emitOrdered(
                    threadID: threadID,
                    event: .timelineAppended(
                        threadID: threadID,
                        item: .assistantMessage(
                            id: messageID, markdown: payload.text,
                            isStreaming: payload.streaming, at: at)))
            } else if payload.streaming {
                if !payload.text.isEmpty {
                    let old = assistantTextByMessage[threadID]?[messageID] ?? ""
                    assistantTextByMessage[threadID, default: [:]][messageID] = old + payload.text
                    // Buffer: merged at ~30Hz (or flushed before any non-delta).
                    bufferAssistantDelta(
                        threadID: threadID, messageID: messageID, delta: payload.text)
                }
            }
            if !payload.streaming {
                let accumulated = assistantTextByMessage[threadID]?[messageID] ?? ""
                let finalText = payload.text.isEmpty ? accumulated : payload.text
                assistantTextByMessage[threadID, default: [:]][messageID] = finalText
                emitOrdered(
                    threadID: threadID,
                    event: .assistantCompleted(
                        threadID: threadID, messageID: messageID, markdown: finalText))
            }

        case .system:
            guard !alreadySeen else { return }
            seenMessageIDs[threadID, default: []].insert(messageID)
            emitOrdered(
                threadID: threadID,
                event: .timelineAppended(
                    threadID: threadID,
                    item: .notice(id: messageID, text: payload.text, at: at)))
        }
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

    public func closeTimeline(threadID: String) async {
        // Cancel live timeline fan-in; shell status for this thread stays live.
        threadSubscriptions[threadID]?.cancel()
        threadSubscriptions[threadID] = nil
        activeThreadIDs.remove(threadID)

        // Drop per-thread projection/dedup caches so a later timeline() load
        // re-subscribes cleanly and treats the next snapshot as authoritative.
        latestTimeline[threadID] = nil
        seenMessageIDs[threadID] = nil
        assistantTextByMessage[threadID] = nil
        seenActivityIDs[threadID] = nil
        seenCheckpointRefs[threadID] = nil
        seenPlanIDs[threadID] = nil
        pendingAssistantDeltas[threadID] = nil

        // Fail any waiter still blocked on the first snapshot or a pending
        // checkpoint revert for this thread.
        failSnapshotWaiters(threadID: threadID, error: LiveBackendError.notConnected)
        failRevertWaiters(threadID: threadID, error: LiveBackendError.notConnected)

        // Tear down VCS watch so watchVcsStatus can re-establish after prune
        // (it guards on vcsSubscriptions[threadID] == nil).
        vcsSubscriptions[threadID]?.cancel()
        clearVcsSubscription(threadID: threadID)
        vcsLocal[threadID] = nil
        vcsRemote[threadID] = nil
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
                    let serviceTier = Self.serviceTierDescriptor(of: model)
                    return ModelOption(
                        instanceID: provider.instanceId, modelID: model.slug,
                        displayName: model.name, provider: kind,
                        // The wire has no per-instance default marker; the first
                        // listed model is what `modelSelection(for:)` picks for
                        // new threads absent a last-used pick, so mark that one.
                        isDefault: model.slug == provider.models.first?.slug,
                        effortOptionID: effort?.id,
                        effortChoices: effort?.options.map {
                            EffortChoice(id: $0.id, label: $0.label, isDefault: $0.isDefault ?? false)
                        } ?? [],
                        serviceTierOptionID: serviceTier?.id,
                        serviceTierChoices: serviceTier?.options.map {
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
        // Worktree mode: create the worktree up front so the session lands on
        // its own sergecode/* branch immediately, not on the first send. When
        // this fails (or the eager RPC is unavailable), the thread is created
        // without one and the first-turn bootstrap in sendMessage picks it up.
        var worktree: VcsWorktree?
        if let plan = await worktreePlan(projectID: projectID) {
            worktree = await createEagerWorktree(plan: plan)
        }
        do {
            _ = try await client.createThread(
                threadId: threadID, projectId: projectID, title: title, modelSelection: selection,
                runtimeMode: .fullAccess, branch: worktree?.refName,
                worktreePath: worktree?.path)
        } catch {
            // Don't leak the worktree when the thread never came to exist.
            if let worktree, let project = projectsByID[projectID] {
                _ = try? await client.removeWorktree(
                    cwd: project.path, path: worktree.path, force: true)
            }
            throw error
        }
        let thread = ChatThread(
            id: threadID, projectID: projectID, title: title, provider: provider, status: .idle,
            updatedAt: Date(), modelInstanceID: selection.instanceId, modelID: selection.model,
            reasoningEffort: Self.effortValue(of: selection),
            serviceTier: Self.serviceTierValue(of: selection))
        threadsByID[threadID] = thread
        modelSelectionsByThread[threadID] = selection
        titleSeedsByThread[threadID] = title
        threadEnvByThread[threadID] = ThreadEnvState(
            worktreePath: worktree?.path, hasTurns: false)
        // Emit immediately: the shell subscription's authoritative upsert can
        // lag (or be missed across a reconnect), and the caller selects the
        // thread right away — without this the detail pane shows an empty
        // state for a thread that exists.
        emitOrdered(threadID: threadID, event: .threadUpserted(thread))
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
        titleSeedsByThread[id] = nil
        threadEnvByThread[id] = nil
        modelSelectionsByThread[id] = nil
        await closeTimeline(threadID: id)
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
        let bootstrap = await worktreeBootstrapIfNeeded(threadID: threadID)
        _ = try await client.startTurn(
            threadId: threadID, text: text, attachments: uploads,
            // Marks the creation placeholder title as replaceable so the
            // server's first-turn generation can retitle the thread with an
            // AI description. Only set for threads this client created: the
            // server compares seed to current title, so sending the live
            // title would also mark manually-set titles as replaceable.
            titleSeed: titleSeedsByThread[threadID],
            runtimeMode: thread.map { Self.wireRuntimeMode($0.runtimeMode) } ?? .wireDefault,
            interactionMode: thread.map { Self.wireInteractionMode($0.interactionMode) } ?? .wireDefault,
            bootstrap: bootstrap)
        // Mark the turn locally right away: the shell upsert carrying
        // latestTurn/worktreePath can lag, and a quick second send must not
        // bootstrap a second worktree in the meantime.
        threadEnvByThread[threadID]?.hasTurns = true
    }

    /// Whether (and from which base branch) a new thread in this project
    /// should get its own worktree: the server's defaultThreadEnvMode is
    /// worktree and the project is a git repo. Base = the repo's default
    /// local ref, falling back to the current one. Any failure resolves to
    /// nil — run in the project checkout rather than block.
    private struct WorktreePlan {
        var projectCwd: String
        var baseBranch: String
        var startFromOrigin: Bool
    }

    private func worktreePlan(projectID: String) async -> WorktreePlan? {
        guard let client = currentClient, let project = projectsByID[projectID] else { return nil }
        do {
            let settings = try await client.getSettings()
            guard settings.defaultThreadEnvMode == .worktree else { return nil }
            let refs = try await client.listRefs(cwd: project.path)
            guard refs.isRepo else { return nil }
            let baseBranch =
                refs.refs.first(where: { $0.isDefault && !($0.isRemote ?? false) })?.name
                ?? refs.refs.first(where: { $0.current })?.name
            guard let baseBranch else { return nil }
            return WorktreePlan(
                projectCwd: project.path, baseBranch: baseBranch,
                startFromOrigin: settings.newWorktreesStartFromOrigin)
        } catch {
            return nil
        }
    }

    /// Eager worktree creation at session-create time (vcs.createWorktree).
    /// startFromOrigin uses the base's origin tracking ref as the start point
    /// — fresh as of the last fetch; unlike the turn bootstrap this RPC does
    /// no network fetch — and falls back to the local base when that ref
    /// doesn't resolve.
    private func createEagerWorktree(plan: WorktreePlan) async -> VcsWorktree? {
        guard let client = currentClient else { return nil }
        let branch = Self.temporaryWorktreeBranchName()
        if plan.startFromOrigin,
            let result = try? await client.createWorktree(
                cwd: plan.projectCwd, refName: "origin/\(plan.baseBranch)",
                newRefName: branch, baseRefName: plan.baseBranch)
        {
            return result.worktree
        }
        let result = try? await client.createWorktree(
            cwd: plan.projectCwd, refName: plan.baseBranch,
            newRefName: branch, baseRefName: plan.baseBranch)
        return result?.worktree
    }

    /// First-turn worktree bootstrap (web ChatView parity) — the fallback
    /// when eager creation didn't happen (older turnless threads, or the
    /// eager RPC failed at session-create time). Also runs the project setup
    /// script in the fresh worktree, which the eager path can't.
    private func worktreeBootstrapIfNeeded(threadID: String) async -> ThreadTurnStartBootstrap? {
        guard let env = threadEnvByThread[threadID], env.worktreePath == nil, !env.hasTurns,
            let projectID = threadsByID[threadID]?.projectID
        else { return nil }
        guard let plan = await worktreePlan(projectID: projectID) else { return nil }
        return ThreadTurnStartBootstrap(
            prepareWorktree: ThreadTurnStartBootstrapPrepareWorktree(
                projectCwd: plan.projectCwd, baseBranch: plan.baseBranch,
                branch: Self.temporaryWorktreeBranchName(),
                startFromOrigin: plan.startFromOrigin ? true : nil),
            runSetupScript: true)
    }

    /// Mirrors `buildTemporaryWorktreeBranchName` in packages/shared/git.ts:
    /// `sergecode/<8 lowercase hex chars>`. Must match the shared
    /// WORKTREE_BRANCH_PREFIX + hex pattern exactly — the server only
    /// auto-renames the branch to a meaningful name (generated from the
    /// first message) when it recognizes this temporary shape.
    private static func temporaryWorktreeBranchName() -> String {
        String(format: "sergecode/%08x", UInt32.random(in: UInt32.min...UInt32.max))
    }

    public func searchWorkspace(threadID: String, query: String) async throws -> [WorkspaceEntry] {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let cwd = try? threadCwd(threadID) else { return [] }
        let result = try await client.searchEntries(cwd: cwd, query: query, limit: 20)
        return result.entries.map {
            WorkspaceEntry(path: $0.path, isDirectory: $0.kind == .directory)
        }
    }

    public func listWorkspace(threadID: String, subpath: String) async throws -> [WorkspaceEntry] {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let root = try threadCwd(threadID)
        let cwd = subpath.isEmpty ? root : root + "/" + subpath
        let result = try await client.listEntries(cwd: cwd)
        return result.entries
            .map { WorkspaceEntry(path: $0.path, isDirectory: $0.kind == .directory) }
            .sorted { lhs, rhs in
                if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
                return lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
            }
    }

    public func readWorkspaceFile(threadID: String, path: String) async throws -> FilePreview {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let result = try await client.readFile(cwd: try threadCwd(threadID), relativePath: path)
        return FilePreview(
            path: result.relativePath, contents: result.contents, truncated: result.truncated)
    }

    public func openInEditor(
        threadID: String, subpath: String?, editor: ExternalEditor
    ) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let root = try threadCwd(threadID)
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
        emitOrdered(threadID: route.threadID, event: .approvalResolved(id: id))
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
        emitOrdered(threadID: route.threadID, event: .userInputResolved(id: id))
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
        rememberModelSelection(selection, for: model.provider)
        updateCachedThread(threadID) {
            $0.modelInstanceID = model.instanceID
            $0.modelID = model.modelID
            $0.provider = model.provider
            $0.reasoningEffort = nil
            $0.serviceTier = nil
        }
    }

    /// Effort-style select descriptors go by different ids per driver
    /// (claudeAgent: "effort"; codex: "reasoningEffort"; cursor: "reasoning").
    private static let effortOptionIDs: Set<String> = ["effort", "reasoningEffort", "reasoning"]
    private static let serviceTierOptionID = "serviceTier"

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

    private static func serviceTierDescriptor(of model: ServerProviderModel)
        -> SelectProviderOptionDescriptor?
    {
        model.capabilities?.optionDescriptors?.lazy.compactMap { descriptor in
            if case .select(let select) = descriptor, select.id == serviceTierOptionID {
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

    private static func serviceTierValue(of selection: ModelSelection) -> String? {
        selection.canonicalOptions?.lazy.compactMap { option -> String? in
            guard option.id == serviceTierOptionID, case .string(let value) = option.value
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
        let updated = Self.modelSelection(selection, settingEffort: value, descriptorID: descriptor.id)
        _ = try await client.updateThreadMeta(threadId: threadID, modelSelection: updated)
        modelSelectionsByThread[threadID] = updated
        if let instance = providersByInstanceId[selection.instanceId],
            let provider = providerKind(fromDriver: instance.driver)
        {
            rememberReasoningEffort(value, for: provider)
        }
        updateCachedThread(threadID) { $0.reasoningEffort = value }
    }

    public func setServiceTier(threadID: String, value: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let selection = modelSelectionsByThread[threadID] else {
            throw LiveBackendError.unknownThread(threadID)
        }
        guard
            let model = providersByInstanceId[selection.instanceId]?.models
                .first(where: { $0.slug == selection.model }),
            let descriptor = Self.serviceTierDescriptor(of: model)
        else {
            throw LiveBackendError.noServiceTierOption(selection.model)
        }
        let updated = Self.modelSelection(
            selection, settingServiceTier: value, descriptorID: descriptor.id)
        _ = try await client.updateThreadMeta(threadId: threadID, modelSelection: updated)
        modelSelectionsByThread[threadID] = updated
        if let instance = providersByInstanceId[selection.instanceId],
            let provider = providerKind(fromDriver: instance.driver)
        {
            rememberServiceTier(value, for: provider)
        }
        updateCachedThread(threadID) { $0.serviceTier = value }
    }

    /// Optimistically patch the cached thread and re-emit it; the shell
    /// subscription's authoritative upsert follows and overwrites.
    private func updateCachedThread(_ threadID: String, _ mutate: (inout ChatThread) -> Void) {
        guard var thread = threadsByID[threadID] else { return }
        mutate(&thread)
        threadsByID[threadID] = thread
        emitOrdered(threadID: threadID, event: .threadUpserted(thread))
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
        guard let route = checkpointRoutes[id] else {
            throw LiveBackendError.unresolvedCheckpoint(id)
        }
        try await revertThread(threadID: route.threadID, turnCount: route.turnCount)
    }

    public func revertThread(threadID: String, turnCount: Int) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        // Wait for the domain event, not just dispatch acceptance: the server
        // accepts `thread.checkpoint.revert` immediately and finishes the
        // rewind asynchronously. Edit-resend must only start the replacement
        // turn after the projection (and provider conversation) has rewound.
        //
        // Register the waiter synchronously in the continuation body (same
        // pattern as `snapshotWaiters`), then kick the RPC from a child task
        // so a fast `thread.reverted` cannot race past registration.
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            revertWaiters[threadID, default: []].append(continuation)
            Task {
                do {
                    _ = try await client.revertCheckpoint(
                        threadId: threadID, turnCount: turnCount)
                    // Optimistic diff invalidation; timeline truncation lands
                    // with `thread.reverted` and resolves the waiter above.
                    await self.emitOrdered(
                        threadID: threadID, event: .diffInvalidated(threadID: threadID))
                } catch {
                    await self.failRevertWaiters(threadID: threadID, error: error)
                }
            }
        }
    }

    private func resolveRevertWaiters(threadID: String) {
        let waiters = revertWaiters.removeValue(forKey: threadID) ?? []
        for waiter in waiters {
            waiter.resume()
        }
    }

    private func failRevertWaiters(threadID: String, error: Error) {
        let waiters = revertWaiters.removeValue(forKey: threadID) ?? []
        for waiter in waiters {
            waiter.resume(throwing: error)
        }
    }

    private func failAllRevertWaiters(error: Error) {
        for waiters in revertWaiters.values {
            for waiter in waiters {
                waiter.resume(throwing: error)
            }
        }
        revertWaiters.removeAll()
    }

    /// Retains the first `turnCount` user turns (and the work that follows
    /// each until the next user message). `turnCount == 0` clears the thread.
    static func timelineRetaining(turnCount: Int, from items: [TimelineItem]) -> [TimelineItem] {
        guard turnCount > 0 else { return [] }
        var userCount = 0
        var retained: [TimelineItem] = []
        for item in items {
            if case .userMessage = item {
                userCount += 1
                if userCount > turnCount { break }
            }
            retained.append(item)
        }
        return retained
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

    public func renameProject(id: String, name: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.updateProject(projectId: id, title: name)
        // The shell subscription re-emits the project; update locally now so
        // the sidebar doesn't flash the old name in the meantime.
        if var project = projectsByID[id] {
            project.name = name
            projectsByID[id] = project
            emit(.projectsChanged(currentProjectList()))
        }
    }

    public func deleteProject(id: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        // force: the server cascades thread deletes; the UI confirms first.
        _ = try await client.deleteProject(projectId: id, force: true)
        // The shell subscription emits project/thread removals; drop local
        // caches now so re-created ids never see stale dedup state (mirrors
        // deleteThread).
        projectsByID[id] = nil
        emit(.projectsChanged(currentProjectList()))
        for (threadID, thread) in threadsByID where thread.projectID == id {
            threadsByID[threadID] = nil
            modelSelectionsByThread[threadID] = nil
            titleSeedsByThread[threadID] = nil
            threadEnvByThread[threadID] = nil
            await closeTimeline(threadID: threadID)
            emitOrdered(threadID: threadID, event: .threadRemoved(id: threadID))
        }
    }

    // MARK: - BackendService: git / VCS

    /// Live status subscriptions keyed by threadID; re-established on demand
    /// after reconnects (watchVcsStatus is called again by the UI) and torn
    /// down/restarted when the thread's worktree appears.
    private var vcsSubscriptions: [String: Task<Void, Never>] = [:]
    /// The cwd each live subscription is watching — compared against the
    /// thread's current cwd to notice a worktree switching underneath it.
    private var vcsWatchedCwd: [String: String] = [:]
    /// Last combined local+remote projection per thread.
    private var vcsLocal: [String: VcsStatusLocal] = [:]
    private var vcsRemote: [String: VcsStatusRemote] = [:]

    public func watchVcsStatus(threadID: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        guard let cwd = try? threadCwd(threadID) else { return }
        guard vcsSubscriptions[threadID] == nil else { return }
        vcsWatchedCwd[threadID] = cwd
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let stream = await client.subscribeVcsStatus(cwd: cwd)
                for try await event in stream {
                    await self.applyVcsEvent(threadID: threadID, event: event)
                }
            } catch {
                // Stream ended (socket drop or non-repo error): forget the
                // subscription so the next watch call re-establishes it.
            }
            await self.clearVcsSubscription(threadID: threadID)
        }
        vcsSubscriptions[threadID] = task
    }

    private func clearVcsSubscription(threadID: String) {
        vcsSubscriptions[threadID] = nil
        vcsWatchedCwd[threadID] = nil
    }

    /// When a thread's first turn creates its worktree, an active VCS watch
    /// still points at the project checkout — restart it on the new cwd.
    private func restartVcsWatchIfStale(threadID: String) {
        guard let watched = vcsWatchedCwd[threadID],
            let current = try? threadCwd(threadID), watched != current
        else { return }
        vcsSubscriptions[threadID]?.cancel()
        vcsSubscriptions[threadID] = nil
        vcsWatchedCwd[threadID] = nil
        vcsLocal[threadID] = nil
        vcsRemote[threadID] = nil
        Task { [weak self] in
            try? await self?.watchVcsStatus(threadID: threadID)
        }
    }

    private func applyVcsEvent(threadID: String, event: VcsStatusStreamEvent) {
        switch event {
        case .snapshot(let local, let remote):
            vcsLocal[threadID] = local
            vcsRemote[threadID] = remote ?? vcsRemote[threadID]
        case .localUpdated(let local):
            vcsLocal[threadID] = local
        case .remoteUpdated(let remote):
            if let remote { vcsRemote[threadID] = remote }
        }
        guard let local = vcsLocal[threadID] else { return }
        emitOrdered(
            threadID: threadID,
            event: .vcsStatusChanged(
                threadID: threadID,
                status: Self.uiVcsStatus(local: local, remote: vcsRemote[threadID])))
    }

    private static func uiVcsStatus(local: VcsStatusLocal, remote: VcsStatusRemote?) -> VcsStatus {
        VcsStatus(
            isRepo: local.isRepo, branch: local.refName, isDefaultBranch: local.isDefaultRef,
            changedFileCount: local.workingTree.files.count,
            insertions: local.workingTree.insertions, deletions: local.workingTree.deletions,
            aheadCount: remote?.aheadCount ?? 0, behindCount: remote?.behindCount ?? 0,
            hasUpstream: remote?.hasUpstream ?? false,
            hasPrimaryRemote: local.hasPrimaryRemote,
            aheadOfDefaultCount: remote?.aheadOfDefaultCount,
            prNumber: remote?.pr?.number,
            prTitle: remote?.pr?.title, prURL: remote?.pr?.url,
            prState: (remote?.pr?.state).flatMap(PullRequestState.init(rawValue:)))
    }

    /// The directory a thread's workspace/VCS calls operate on: its worktree
    /// when it has one, otherwise the project checkout.
    private func threadCwd(_ threadID: String) throws -> String {
        guard let thread = threadsByID[threadID],
            let project = projectsByID[thread.projectID]
        else {
            throw LiveBackendError.notConnected
        }
        return threadEnvByThread[threadID]?.worktreePath ?? project.path
    }

    public func listBranches(threadID: String, query: String?) async throws -> [BranchRef] {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        let result = try await client.listRefs(
            cwd: try threadCwd(threadID), query: query, refKind: "local", limit: 50)
        return result.refs.map {
            BranchRef(
                name: $0.name, isCurrent: $0.current, isDefault: $0.isDefault,
                isRemote: $0.isRemote ?? false)
        }
    }

    public func switchBranch(threadID: String, name: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.switchRef(cwd: try threadCwd(threadID), refName: name)
    }

    public func createBranch(threadID: String, name: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.createRef(cwd: try threadCwd(threadID), refName: name, switchRef: true)
    }

    public func pull(threadID: String) async throws {
        guard let client = currentClient else { throw LiveBackendError.notConnected }
        _ = try await client.pull(cwd: try threadCwd(threadID))
    }

    public func runGitAction(
        threadID: String, action: GitAction, commitMessage: String?
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
            cwd: try threadCwd(threadID), action: wireAction, commitMessage: commitMessage)
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

    // MARK: - BackendService: mobile pairing

    public func isServerLanReachable() async -> Bool {
        allowLanAccess && serverProcess != nil
    }

    public func mintMobilePairing() async throws -> MobilePairingInfo {
        guard allowLanAccess else { throw LiveBackendError.mobileAccessDisabled }
        guard let auth = authClient, let port = sidecarPort, currentClient != nil else {
            throw LiveBackendError.notConnected
        }
        guard let address = LanAddressResolver.primaryIPv4() else {
            throw LiveBackendError.noLanAddress
        }
        let accessToken = try await auth.acquireAccessToken()
        let minted = try await auth.mintPairingCredential(accessToken: accessToken, label: "iPhone")
        // Same shape the server's headless `serve` QR encodes
        // (startupAccess.ts buildPairingUrl): path /pair, token in the URL
        // fragment so it never appears in request logs.
        guard let url = URL(string: "http://\(address):\(port)/pair#token=\(minted.credential)")
        else {
            throw LiveBackendError.noLanAddress
        }
        let expiresAt = WireDate.parse(minted.expiresAt) ?? Date().addingTimeInterval(5 * 60)
        return MobilePairingInfo(
            pairingURL: url, credential: minted.credential, expiresAt: expiresAt)
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

    // MARK: - Emit helpers

    /// Buffer a wire assistant-delta chunk. Flushed on the ~30Hz schedule or
    /// immediately before any non-delta event for the same thread.
    private func bufferAssistantDelta(threadID: String, messageID: String, delta: String) {
        pendingAssistantDeltas[threadID, default: [:]][messageID, default: ""] += delta
        scheduleDeltaFlush()
    }

    private func scheduleDeltaFlush() {
        guard !deltaFlushScheduled else { return }
        deltaFlushScheduled = true
        Task {
            try? await Task.sleep(for: .milliseconds(33))
            await self.flushDeltas()
        }
    }

    /// Emit every buffered assistant delta (all threads) and clear the schedule flag.
    private func flushDeltas() {
        deltaFlushScheduled = false
        let pending = pendingAssistantDeltas
        pendingAssistantDeltas.removeAll(keepingCapacity: true)
        for (threadID, byMessage) in pending {
            for (messageID, text) in byMessage where !text.isEmpty {
                emit(.assistantDelta(threadID: threadID, messageID: messageID, delta: text))
            }
        }
    }

    /// Flush pending deltas for one thread only (ordering barrier before a
    /// non-delta event). Leaves other threads' buffers and the schedule flag alone.
    private func flushDeltas(for threadID: String) {
        guard let byMessage = pendingAssistantDeltas.removeValue(forKey: threadID) else { return }
        for (messageID, text) in byMessage where !text.isEmpty {
            emit(.assistantDelta(threadID: threadID, messageID: messageID, delta: text))
        }
    }

    /// Ordering barrier: any non-delta event for a thread must land after that
    /// thread's pending assistant deltas (in particular `assistantCompleted`
    /// and `timelineReset`). Deltas themselves go through `bufferAssistantDelta`.
    private func emitOrdered(threadID: String, event: BackendEvent) {
        flushDeltas(for: threadID)
        // Keep `latestTimeline` current so `thread.reverted` can truncate a
        // live-updated cache (not just the last snapshot).
        mirrorTimelineCache(threadID: threadID, event: event)
        emit(event)
    }

    private func mirrorTimelineCache(threadID: String, event: BackendEvent) {
        switch event {
        case .timelineAppended(_, let item):
            latestTimeline[threadID, default: []].upsertTimelineItem(item)
        case .timelineReset(_, let items):
            latestTimeline[threadID] = items
        case .assistantCompleted(_, let messageID, let markdown):
            guard var items = latestTimeline[threadID] else { return }
            if let index = items.firstIndex(where: {
                if case .assistantMessage(let id, _, _, _) = $0 { return id == messageID }
                return false
            }), case .assistantMessage(let id, _, _, let at) = items[index] {
                items[index] = .assistantMessage(
                    id: id, markdown: markdown, isStreaming: false, at: at)
                latestTimeline[threadID] = items
            }
        case .assistantDelta(_, let messageID, let delta):
            guard var items = latestTimeline[threadID] else { return }
            if let index = items.firstIndex(where: {
                if case .assistantMessage(let id, _, _, _) = $0 { return id == messageID }
                return false
            }), case .assistantMessage(let id, let markdown, _, let at) = items[index] {
                items[index] = .assistantMessage(
                    id: id, markdown: markdown + delta, isStreaming: true, at: at)
                latestTimeline[threadID] = items
            }
        default:
            break
        }
    }

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
        if shell.archivedAt != nil || shell.session?.status == .error
            || shell.latestTurn?.state == .error
        {
            subagentTasksByThread[shell.id]?.clearActiveTasks()
        }
        let activeSubagentCount = subagentTasksByThread[shell.id]?.activeTaskCount ?? 0
        let status = mapStatus(
            session: shell.session, latestTurn: shell.latestTurn, archivedAt: shell.archivedAt,
            hasPendingApprovals: shell.hasPendingApprovals || shell.hasPendingUserInput,
            activeSubagentCount: activeSubagentCount)
        let presentedStatus =
            status == .running
            && staleRunningTurnKeys[shell.id] == runningLivenessTurnKey(for: shell)
            ? .error : status
        let updatedAt = WireDate.parse(shell.updatedAt) ?? Date()
        return ChatThread(
            id: shell.id, projectID: shell.projectId, title: shell.title, provider: kind,
            status: presentedStatus, updatedAt: updatedAt,
            runtimeMode: Self.uiRuntimeMode(shell.runtimeMode),
            interactionMode: Self.uiInteractionMode(shell.interactionMode),
            modelInstanceID: shell.modelSelection.instanceId, modelID: shell.modelSelection.model,
            reasoningEffort: Self.effortValue(of: shell.modelSelection),
            serviceTier: Self.serviceTierValue(of: shell.modelSelection),
            backgroundAgentCount: activeSubagentCount)
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
        hasPendingApprovals: Bool, activeSubagentCount: Int
    ) -> ThreadStatus {
        switch ThreadStatusProjection.project(
            session: session, latestTurn: latestTurn, archivedAt: archivedAt,
            hasPendingApprovals: hasPendingApprovals,
            activeSubagentCount: activeSubagentCount)
        {
        case .idle: return .idle
        case .running: return .running
        case .waitingApproval: return .waitingApproval
        case .backgroundWork: return .backgroundWork
        case .error: return .error
        case .archived: return .archived
        }
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
            case ActivityKind.usageLimitReached:
                guard let notice = mapUsageLimitNotice(activity, threadID: threadID, at: at) else {
                    return nil
                }
                return .usageLimit(notice)
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
                    label: "Turn \(summary.checkpointTurnCount)", createdAt: at,
                    turnCount: summary.checkpointTurnCount))
        case let .proposedPlan(plan, at):
            return .plan(
                ProposedPlan(
                    id: plan.id, threadID: threadID, markdown: plan.planMarkdown,
                    isImplemented: plan.implementedAt != nil, createdAt: at))
        }
    }

    /// Refined activity row (ActivityRows): lifecycle noise maps to nil,
    /// tool rows get their human title + payload detail, and row ids are
    /// stable across one tool call so consumers upsert rather than append.
    private func mapActivity(_ activity: OrchestrationThreadActivity, at: Date) -> TimelineItem? {
        switch ActivityRows.row(for: activity) {
        case .tool(let id, let title, let detail, let itemType, let phase, let output, let outputIsError):
            let status: ToolEventStatus =
                switch phase {
                case .running: .running
                case .succeeded: .succeeded
                case .failed: .failed
                }
            return .toolEvent(
                id: id, name: title, detail: detail, kind: ToolEventKind(itemType: itemType),
                status: status, at: at, output: output, outputIsError: outputIsError)
        case .reasoning(let id, let text):
            return .reasoning(id: id, text: text, at: at)
        case .notice(let id, let text):
            return .notice(id: id, text: text, at: at)
        case nil:
            return nil
        }
    }

    private static func isTaskLifecycleActivity(_ activity: OrchestrationThreadActivity) -> Bool {
        switch activity.kind {
        case ActivityKind.taskStarted, ActivityKind.taskProgress, ActivityKind.taskCompleted:
            return true
        default:
            return false
        }
    }

    private func applySubagentTaskActivity(
        _ activity: OrchestrationThreadActivity, threadID: String, at: Date
    ) -> Bool {
        guard Self.isTaskLifecycleActivity(activity) else { return false }
        var state = subagentTasksByThread[threadID] ?? T3SubagentTaskActivityState()
        guard let task = state.apply(activity: activity, at: at) else { return false }
        subagentTasksByThread[threadID] = state
        emitOrdered(
            threadID: threadID,
            event: .timelineAppended(threadID: threadID, item: mapSubagentTask(task)))
        reemitThreadWithCurrentProjection(threadID: threadID)
        return true
    }

    private func reemitThreadWithCurrentProjection(threadID: String) {
        if let shell = threadShellsByID[threadID] {
            let thread = mapThread(shell)
            threadsByID[threadID] = thread
            emitOrdered(threadID: threadID, event: .threadUpserted(thread))
            return
        }
        guard var thread = threadsByID[threadID] else { return }
        let activeCount = subagentTasksByThread[threadID]?.activeTaskCount ?? 0
        thread.backgroundAgentCount = activeCount
        if thread.status == .idle, activeCount > 0 {
            thread.status = .backgroundWork
        } else if thread.status == .backgroundWork, activeCount == 0 {
            thread.status = .idle
        }
        threadsByID[threadID] = thread
        emitOrdered(threadID: threadID, event: .threadUpserted(thread))
    }

    private func mapSubagentTask(_ task: T3SubagentTaskItem) -> TimelineItem {
        .subagentTask(
            SubagentTaskItem(
                taskId: task.taskId, taskType: task.taskType, description: task.description,
                state: Self.uiSubagentTaskState(task.state),
                latestProgress: task.completionSummary ?? task.latestProgress,
                startedAt: task.startedAt, duration: task.duration,
                progressLog: task.progressLog.map {
                    SubagentTaskProgressEntry(at: $0.at, toolName: $0.toolName, text: $0.text)
                }))
    }

    private static func uiSubagentTaskState(_ state: T3SubagentTaskState) -> SubagentTaskState {
        switch state {
        case .running: .running
        case .completed: .completed
        case .failed: .failed
        case .stopped: .stopped
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
        if lowered.contains("synthero") { return .claudeSynthero }
        if lowered.contains("claude") { return .claude }
        if lowered.contains("codex") { return .codex }
        if lowered.contains("cursor") { return .cursor }
        if lowered.contains("grok") { return .grok }
        if lowered.contains("fugu") { return .fugu }
        if lowered.contains("opencode") { return .opencode }
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
        // Prefer the model the user last picked for this provider kind, so a
        // new thread doesn't silently reset to the instance's first model.
        if let remembered = lastUsedModelSelection(for: provider) {
            return applyingLastUsedOptions(to: remembered, for: provider)
        }
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
        return applyingLastUsedOptions(
            to: ModelSelection(instanceId: chosen.instanceId, model: model), for: provider)
    }

    private func applyingLastUsedOptions(
        to selection: ModelSelection, for provider: ProviderKind
    ) -> ModelSelection {
        applyingLastUsedServiceTier(
            to: applyingLastUsedEffort(to: selection, for: provider), for: provider)
    }

    private static func modelSelection(
        _ selection: ModelSelection, settingEffort effort: String, descriptorID: String
    ) -> ModelSelection {
        // Replace any prior effort selection, keep unrelated options.
        var options = selection.canonicalOptions ?? []
        options.removeAll { Self.effortOptionIDs.contains($0.id) }
        options.append(ProviderOptionSelection(id: descriptorID, value: .string(effort)))
        return ModelSelection(
            instanceId: selection.instanceId, model: selection.model, canonicalOptions: options)
    }

    private static func modelSelection(
        _ selection: ModelSelection, settingServiceTier tier: String, descriptorID: String
    ) -> ModelSelection {
        var options = selection.canonicalOptions ?? []
        options.removeAll { $0.id == serviceTierOptionID }
        options.append(ProviderOptionSelection(id: descriptorID, value: .string(tier)))
        return ModelSelection(
            instanceId: selection.instanceId, model: selection.model, canonicalOptions: options)
    }

    private func applyingLastUsedEffort(
        to selection: ModelSelection, for provider: ProviderKind
    ) -> ModelSelection {
        guard
            let instance = providersByInstanceId[selection.instanceId],
            let model = instance.models.first(where: { $0.slug == selection.model }),
            let descriptor = Self.effortDescriptor(of: model),
            let effort = resolvedLastUsedEffort(for: provider, descriptor: descriptor)
        else { return selection }
        return Self.modelSelection(selection, settingEffort: effort, descriptorID: descriptor.id)
    }

    private func applyingLastUsedServiceTier(
        to selection: ModelSelection, for provider: ProviderKind
    ) -> ModelSelection {
        guard
            let instance = providersByInstanceId[selection.instanceId],
            let model = instance.models.first(where: { $0.slug == selection.model }),
            let descriptor = Self.serviceTierDescriptor(of: model),
            let tier = resolvedLastUsedServiceTier(for: provider, descriptor: descriptor)
        else { return selection }
        return Self.modelSelection(
            selection, settingServiceTier: tier, descriptorID: descriptor.id)
    }

    private func resolvedLastUsedEffort(
        for provider: ProviderKind, descriptor: SelectProviderOptionDescriptor
    ) -> String? {
        guard let remembered = lastUsedReasoningEffort(for: provider) else { return nil }
        if descriptor.options.contains(where: { $0.id == remembered }) {
            return remembered
        }
        return descriptor.options.first(where: { $0.isDefault == true })?.id
    }

    private func resolvedLastUsedServiceTier(
        for provider: ProviderKind, descriptor: SelectProviderOptionDescriptor
    ) -> String? {
        guard let remembered = lastUsedServiceTier(for: provider) else { return nil }
        if descriptor.options.contains(where: { $0.id == remembered }) {
            return remembered
        }
        return descriptor.options.first(where: { $0.isDefault == true })?.id
    }

    // MARK: - Last-used model/effort memory

    private static func lastUsedModelKey(for provider: ProviderKind) -> String {
        "lastUsedModel.\(provider.rawValue)"
    }

    private static func lastUsedEffortKey(for provider: ProviderKind) -> String {
        "lastUsedEffort.\(provider.rawValue)"
    }

    private static func lastUsedServiceTierKey(for provider: ProviderKind) -> String {
        "lastUsedServiceTier.\(provider.rawValue)"
    }

    private func rememberModelSelection(_ selection: ModelSelection, for provider: ProviderKind) {
        UserDefaults.standard.set(
            "\(selection.instanceId)\t\(selection.model)",
            forKey: Self.lastUsedModelKey(for: provider))
    }

    private func rememberReasoningEffort(_ value: String, for provider: ProviderKind) {
        UserDefaults.standard.set(value, forKey: Self.lastUsedEffortKey(for: provider))
    }

    private func lastUsedReasoningEffort(for provider: ProviderKind) -> String? {
        UserDefaults.standard.string(forKey: Self.lastUsedEffortKey(for: provider))
    }

    private func rememberServiceTier(_ value: String, for provider: ProviderKind) {
        UserDefaults.standard.set(value, forKey: Self.lastUsedServiceTierKey(for: provider))
    }

    private func lastUsedServiceTier(for provider: ProviderKind) -> String? {
        UserDefaults.standard.string(forKey: Self.lastUsedServiceTierKey(for: provider))
    }

    /// The remembered selection, only while it still points at an available
    /// instance of this kind that lists the model — a stale entry (provider
    /// uninstalled, model retired) falls through to the default pick.
    private func lastUsedModelSelection(for provider: ProviderKind) -> ModelSelection? {
        guard
            let raw = UserDefaults.standard.string(forKey: Self.lastUsedModelKey(for: provider))
        else { return nil }
        let parts = raw.split(separator: "\t", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        let (instanceID, modelSlug) = (parts[0], parts[1])
        guard
            let instance = providersByInstanceId[instanceID],
            providerKind(fromDriver: instance.driver) == provider,
            availability(for: instance) == .available,
            instance.models.contains(where: { $0.slug == modelSlug })
        else { return nil }
        return ModelSelection(instanceId: instanceID, model: modelSlug)
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
    /// The thread's model exposes no service-tier option descriptor.
    case noServiceTierOption(String)
    /// Mobile pairing requested while the sidecar is loopback-only (the
    /// preference was off at launch); relaunch applies the new bind host.
    case mobileAccessDisabled
    /// No non-loopback IPv4 interface found — not on a network.
    case noLanAddress
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
