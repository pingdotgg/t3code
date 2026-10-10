import Foundation

enum OrchestrationV2SynchronizationError: LocalizedError {
    case snapshotRequired
    var errorDescription: String? { "Refreshing the thread after an interrupted update." }
}

/// Owns V2 state and wire requests. The legacy transport never reads these
/// projections or uses their resume cursors.
actor OrchestrationV2Client {
    private let environment: Environment
    private let api: EnvironmentAPI
    private let rpc: WebSocketRPCClient
    private var states: [String: OrchestrationV2ThreadState] = [:]
    private var recency: [String] = []
    private var generation = 0
    private var presentationRevision = 0
    private var commandPlans: [String: OrchestrationV2Commands.Plan] = [:]
    private var commandTasks: [String: Task<DispatchResult, Error>] = [:]
    private var commandResults: [String: DispatchResult] = [:]
    private var completedCommandIDs: [String] = []

    init(environment: Environment, api: EnvironmentAPI, rpc: WebSocketRPCClient) {
        self.environment = environment
        self.api = api
        self.rpc = rpc
    }

    func reset() {
        generation &+= 1
        states.removeAll()
        recency.removeAll()
        commandTasks.values.forEach { $0.cancel() }
        commandTasks.removeAll()
        commandPlans.removeAll()
        commandResults.removeAll()
        completedCommandIDs.removeAll()
    }

    func shellSnapshot(timeoutInterval: TimeInterval? = nil) async throws -> OrchestrationShellSnapshot {
        let epoch = generation
        let snapshot = try await api.orchestrationV2Snapshot(
            path: "/api/orchestration/shell", environment: environment,
            timeoutInterval: timeoutInterval, as: OrchestrationV2ShellSnapshot.self
        )
        guard generation == epoch else { throw RPCError.disconnected }
        return try OrchestrationV2Presentation.shellSnapshot(snapshot)
    }

    func archivedShellSnapshot() async throws -> OrchestrationShellSnapshot {
        let json = try await rpc.request("orchestration.getArchivedShellSnapshot", as: JSONValue.self)
        return try OrchestrationV2Presentation.shellSnapshot(json)
    }

    /// Tool output can be withheld from timeline snapshots. Fetch one item only
    /// when its inspector opens, without replacing the loaded transcript.
    func turnItem(threadID: String, itemID: String, revision: String?) async throws -> OrchestrationV2TurnItem? {
        let epoch = generation
        var payload: [String: JSONValue] = ["threadId": .string(threadID), "itemId": .string(itemID)]
        if let revision { payload["revision"] = .string(revision) }
        let result = try await rpc.request("orchestration.getTurnItem", payload: .object(payload), as: JSONValue.self)
        guard generation == epoch else { throw RPCError.disconnected }
        guard let raw = result["item"], raw != .null else { return nil }
        let item = try OrchestrationV2TurnItem(json: raw)
        guard item.threadId == threadID, item.id == itemID else {
            throw RPCError.protocolViolation("The tool result belongs to a different item.")
        }
        return item
    }

    func readModel() async throws -> OrchestrationReadModel {
        let shell = try await shellSnapshot()
        var threads: [OrchestrationThread] = []
        for thread in shell.threads {
            threads.append(try await fullThreadSnapshot(id: thread.id).thread)
        }
        return OrchestrationReadModel(
            snapshotSequence: shell.snapshotSequence, projects: shell.projects,
            threads: threads, updatedAt: shell.updatedAt
        )
    }

    func threadSnapshot(
        id: String, beforeCursor: String? = nil, timeoutInterval: TimeInterval? = nil
    ) async throws -> OrchestrationThreadDetailSnapshot {
        let epoch = generation
        let path = try threadPath(id)
        if let beforeCursor {
            guard states[id] != nil else {
                throw RPCError.protocolViolation("Reload this thread before loading earlier messages.")
            }
            let page = try await api.orchestrationV2Snapshot(
                path: path + "/history", environment: environment,
                queryItems: [URLQueryItem(name: "cursor", value: beforeCursor)],
                timeoutInterval: timeoutInterval, as: OrchestrationV2ThreadHistoryPage.self
            )
            guard generation == epoch, var current = states[id] else { throw RPCError.disconnected }
            _ = try current.appendHistory(page, beforeCursor: beforeCursor)
            retain(current, id: id)
            return displaySnapshot(current)
        }
        let snapshot = try await api.orchestrationV2Snapshot(
            path: path + "/bounded", environment: environment, timeoutInterval: timeoutInterval,
            as: OrchestrationV2ThreadSnapshot.self
        )
        guard generation == epoch else { throw RPCError.disconnected }
        let state = try OrchestrationV2ThreadState(decoded: snapshot)
        guard state.projection.thread.id == id else { throw OrchestrationV2StateError.wrongThread }
        if let current = states[id], current.snapshotSequence > state.snapshotSequence {
            return displaySnapshot(current)
        }
        retain(state, id: id)
        return displaySnapshot(state)
    }

    /// Action validation must include old checkpoints. Do not retain this read:
    /// the display may have loaded pages or received newer events while it was in flight.
    func fullThreadSnapshot(
        id: String, timeoutInterval: TimeInterval? = nil
    ) async throws -> OrchestrationThreadDetailSnapshot {
        let epoch = generation
        let full = try await api.orchestrationV2Snapshot(
            path: try threadPath(id), environment: environment, timeoutInterval: timeoutInterval,
            as: OrchestrationV2ThreadSnapshot.self
        )
        guard generation == epoch else { throw RPCError.disconnected }
        let state = try OrchestrationV2ThreadState(decoded: full)
        guard state.projection.thread.id == id else { throw OrchestrationV2StateError.wrongThread }
        let normalized = state.normalizedSnapshot()
        var thread = normalized.thread
        var control = thread.orchestrationV2Control?.v2Object ?? [:]
        control["checkpoints"] = .array(state.projection.checkpoints.map(\.raw))
        control["checkpointScopes"] = .array(state.projection.checkpointScopes.map(\.raw))
        thread.orchestrationV2Control = .object(control)
        var snapshot = OrchestrationThreadDetailSnapshot(
            snapshotSequence: normalized.snapshotSequence, thread: thread, page: normalized.page
        )
        snapshot.orchestrationProtocolVersion = 2
        return snapshot
    }

    func shellEventBatches(
        after sequence: Int?, reconnect: Bool
    ) async -> AsyncThrowingStream<[ShellStreamItem], Error> {
        var payload: [String: JSONValue] = ["requestCompletionMarker": .bool(true)]
        if let sequence { payload["afterSequence"] = .number(Double(sequence)) }
        let source = await rpc.subscribeBatches(
            "orchestration.subscribeShell", payload: .object(payload),
            reconnect: reconnect, as: JSONValue.self
        )
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(32)) { continuation in
            let task = Task {
                do {
                    for try await batch in source {
                        try Task.checkCancellation()
                        let mapped = batch.map(OrchestrationV2Presentation.shellStreamItem)
                        switch continuation.yield(mapped) {
                        case .enqueued: break
                        case .dropped:
                            throw RPCError.protocolViolation("Live updates need to be synchronized again.")
                        case .terminated: return
                        @unknown default: return
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func threadEventBatches(
        threadID: String, after sequence: Int?
    ) async throws -> (events: AsyncThrowingStream<[ThreadStreamItem], Error>, connectionID: UUID) {
        var payload: [String: JSONValue] = [
            "threadId": .string(threadID), "requestCompletionMarker": .bool(true),
            "acceptBoundedSnapshot": .bool(true),
        ]
        // The V2 projection, not a caller's legacy cursor, owns replay.
        if let state = states[threadID], sequence != nil {
            payload["afterSequence"] = .number(Double(state.snapshotSequence))
        }
        let source = try await rpc.subscribeBatchesOnCurrentConnection(
            "orchestration.subscribeThread", payload: .object(payload), as: JSONValue.self
        )
        let epoch = generation
        let events = AsyncThrowingStream<[ThreadStreamItem], Error>(bufferingPolicy: .bufferingOldest(32)) { continuation in
            let task = Task {
                do {
                    for try await batch in source.events {
                        try Task.checkCancellation()
                        let updates = try self.consume(batch, threadID: threadID, epoch: epoch)
                        guard !updates.isEmpty else { continue }
                        switch continuation.yield(updates) {
                        case .enqueued: break
                        case .dropped:
                            self.states[threadID] = nil
                            throw OrchestrationV2SynchronizationError.snapshotRequired
                        case .terminated: return
                        @unknown default: return
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (events, source.connectionID)
    }

    private func consume(_ batch: [JSONValue], threadID: String, epoch: Int) throws -> [ThreadStreamItem] {
        guard generation == epoch else { throw RPCError.disconnected }
        var remaining = batch
        if states[threadID] == nil {
            guard let index = batch.firstIndex(where: { $0["kind"]?.stringValue == "snapshot" }) else {
                throw OrchestrationV2SynchronizationError.snapshotRequired
            }
            retain(try OrchestrationV2ThreadState(snapshot: batch[index]), id: threadID)
            remaining = Array(batch.dropFirst(index + 1))
        }
        guard var state = states[threadID] else { throw RPCError.disconnected }
        let result = state.apply(remaining)
        retain(state, id: threadID)
        if result.refreshRequired {
            states[threadID] = nil
            throw OrchestrationV2SynchronizationError.snapshotRequired
        }
        // Publish once per wire batch. The native render cache preserves rows
        // whose message and activity records have not changed.
        var updates: [ThreadStreamItem] = [.projection(displaySnapshot(state))]
        if result.synchronized { updates.append(.synchronized) }
        return updates
    }

    func dispatch(
        _ command: JSONValue,
        responseDeadline: WebSocketRPCClient.ResponseDeadline = .standard,
        serverResolvedCommandContext: Bool = false
    ) async throws -> DispatchResult {
        guard let id = command["commandId"]?.stringValue else {
            throw OrchestrationV2Commands.AdapterError.missingField("commandId")
        }
        if let result = commandResults[id] { return result }
        if let pending = commandTasks[id] { return try await pending.value }
        let epoch = generation
        let task = Task { try await self.executeCommand(command, id: id, responseDeadline: responseDeadline,
                                                       serverResolvedCommandContext: serverResolvedCommandContext) }
        commandTasks[id] = task
        do {
            let result = try await task.value
            try Task.checkCancellation()
            guard generation == epoch else { throw RPCError.disconnected }
            commandTasks[id] = nil
            commandPlans[id] = nil
            commandResults[id] = result
            completedCommandIDs.append(id)
            if completedCommandIDs.count > 128 {
                commandResults.removeValue(forKey: completedCommandIDs.removeFirst())
            }
            return result
        } catch {
            commandTasks[id] = nil
            if case RPCError.remote = error { commandPlans[id] = nil }
            throw error
        }
    }

    private func executeCommand(
        _ command: JSONValue, id: String, responseDeadline: WebSocketRPCClient.ResponseDeadline,
        serverResolvedCommandContext: Bool
    ) async throws -> DispatchResult {
        let rpc = rpc
        let request: @Sendable (OrchestrationV2Commands.Request) async throws -> JSONValue = { step in
            try await rpc.request(step.method, payload: step.payload,
                                  responseDeadline: responseDeadline, as: JSONValue.self)
        }
        if let plan = commandPlans[id] {
            return DispatchResult(sequence: try await OrchestrationV2Commands.execute(plan, request: request).sequence)
        }
        let prepared = try await OrchestrationV2Commands.prepareAttachments(command, request: request)
        let projection: JSONValue?
        if OrchestrationV2Commands.requiresProjection(prepared, serverResolvedCommandContext: serverResolvedCommandContext),
           let threadID = prepared["threadId"]?.stringValue {
            // Commands target the server's current run/session. A cached
            // timeline can be behind another client's queue or provider change.
            let rollback = ["thread.conversation.revert", "thread.checkpoint.revert", "checkpoint.rollback"]
                .contains(prepared["type"]?.stringValue ?? "")
            let json = try await api.orchestrationV2Snapshot(
                path: try threadPath(threadID) + (rollback ? "" : "/bounded"), environment: environment,
                as: JSONValue.self
            )
            projection = json["projection"]
        } else {
            projection = nil
        }
        let plan = try OrchestrationV2Commands.plan(prepared, projection: projection,
                                                serverResolvedCommandContext: serverResolvedCommandContext)
        // A retry must retain its original target run and request identities,
        // even if an earlier step committed before the socket disconnected.
        commandPlans[id] = plan
        let result = try await OrchestrationV2Commands.execute(plan, request: request)
        return DispatchResult(sequence: result.sequence)
    }

    /// History pages can change the display without advancing the event cursor.
    /// Stamp both paths so a buffered stream batch cannot replace newer history.
    private func displaySnapshot(_ state: OrchestrationV2ThreadState) -> OrchestrationThreadDetailSnapshot {
        presentationRevision &+= 1
        let normalized = state.normalizedSnapshot()
        var thread = normalized.thread
        thread.orchestrationV2Revision = presentationRevision
        var result = OrchestrationThreadDetailSnapshot(
            snapshotSequence: normalized.snapshotSequence, thread: thread, page: normalized.page
        )
        result.orchestrationProtocolVersion = 2
        return result
    }

    private func retain(_ state: OrchestrationV2ThreadState, id: String) {
        states[id] = state
        recency.removeAll { $0 == id }
        recency.append(id)
        while recency.count > 6 {
            states.removeValue(forKey: recency.removeFirst())
        }
    }

    private func threadPath(_ id: String) throws -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#%")
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed), !encoded.isEmpty else {
            throw RPCError.protocolViolation("The thread identifier is invalid.")
        }
        return "/api/orchestration/threads/\(encoded)"
    }
}
