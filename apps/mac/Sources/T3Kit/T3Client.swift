// T3Client — typed facade over the RPC connection layer, exposing the v1
// method subset (orchestration + server-config, §3.1/§3.2/§3.11 of
// docs/wire-protocol.md) as async calls / AsyncThrowingStreams instead of
// raw `(tag, JSONValue)` pairs. This is the "one layer up" from
// RpcConnection.swift that the architect plan describes: RpcConnection
// deals in JSONValue, this file does the JSON <-> typed-model conversion
// using WireCoding + the models in OrchestrationModels.swift/ServerModels.swift.
//
// ASSUMED DEPENDENCY CONTRACT (flag for reconciliation — RpcConnection.swift
// is a different slice of this plan and its exact public API was not
// available when this file was written): `T3RpcTransport` below states the
// minimal shape this client needs. Once RpcConnection.swift lands, either
// conform it directly (`extension RpcConnection: T3RpcTransport {}`, if its
// method names already match) or add a one-screen adapter. The essential
// invariants this file relies on:
//   - `request` performs one non-streaming RPC: send `Request{tag,payload}`,
//     await the terminal `Exit`, decode `.success.value` or throw
//     `T3Error.rpc(RpcFailure)` from `.failure.cause` (§2.2).
//   - `stream` performs one streaming RPC: send `Request{tag,payload}`,
//     yield each `Chunk.values` element (sending the mandatory per-chunk
//     `Ack` internally, §2.3 — non-negotiable, or the stream stalls after
//     the first chunk), and finish the stream on the terminal `Exit`
//     (throwing on `Exit.Failure`). Cancelling the returned
//     `AsyncThrowingStream` (Task cancellation) must translate to an
//     `Interrupt{requestId}` frame internally — this layer never sees
//     RpcConnection's internal request ids, so it cannot send `Interrupt`
//     itself.

import Foundation

/// Minimal transport contract `T3Client` needs from the connection actor.
///
/// `stream` is `async throws` (not a plain synchronous-returning function)
/// because `RpcConnection.stream` itself throws if the initial `Request`
/// frame fails to send (§2.4) — that failure must propagate to the caller
/// rather than being swallowed or only surfacing once someone iterates the
/// stream.
public protocol T3RpcTransport: Actor {
    func request(tag: String, payload: JSONValue) async throws -> JSONValue
    func stream(tag: String, payload: JSONValue) async throws -> AsyncThrowingStream<JSONValue, Error>
}

/// `{}` — the payload schema for every no-argument RPC in the v1 subset
/// (`server.getConfig`, `subscribeServerConfig`, `subscribeServerLifecycle`,
/// `orchestration.getArchivedShellSnapshot`, `orchestration.subscribeShell`).
public struct EmptyPayload: Encodable, Sendable {
    public init() {}
}

/// `orchestration.subscribeThread` input (`OrchestrationSubscribeThreadInput`).
public struct OrchestrationSubscribeThreadInput: Encodable, Sendable {
    public var threadId: String
    public init(threadId: String) { self.threadId = threadId }
}

/// Client-side id/timestamp generation helpers. Every dispatched command
/// carries a client-minted `commandId` and (for most variants) `createdAt`;
/// the server treats both as opaque strings, so any unique value is valid,
/// but ids must be unique per §6 risk 12 (trimmed, non-empty).
public enum T3Ids {
    public static func newCommandId() -> String { UUID().uuidString }
    public static func newMessageId() -> String { UUID().uuidString }
}

public enum T3Clock {
    /// ISO-8601 UTC with fractional seconds, matching `IsoDateTime`'s wire
    /// convention (`DateTime.formatIso`, §5.1).
    public static func nowISO8601() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

/// Typed RPC facade for the v1 method subset. One instance per live
/// connection; construct after the transport is connected and authenticated
/// (AuthClient/RpcConnection's job, not this layer's).
public actor T3Client {
    private let transport: any T3RpcTransport

    public init(transport: any T3RpcTransport) {
        self.transport = transport
    }

    // MARK: - Generic call helpers

    func call<Payload: Encodable, Success: Decodable>(
        _ tag: String, _ payload: Payload
    ) async throws -> Success {
        let payloadJSON = try Self.encodeToJSON(payload)
        let resultJSON = try await transport.request(tag: tag, payload: payloadJSON)
        do {
            return try resultJSON.decode(as: Success.self, using: WireCoding.decoder)
        } catch {
            throw T3Error.decoding("Failed decoding \(Success.self) for \(tag): \(error)")
        }
    }

    func streamCall<Payload: Encodable & Sendable, Item: Decodable & Sendable>(
        _ tag: String, _ payload: Payload
    ) -> AsyncThrowingStream<Item, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let payloadJSON = try Self.encodeToJSON(payload)
                    let rawStream = try await self.transport.stream(tag: tag, payload: payloadJSON)
                    for try await raw in rawStream {
                        do {
                            continuation.yield(try raw.decode(as: Item.self, using: WireCoding.decoder))
                        } catch {
                            continuation.finish(
                                throwing: T3Error.decoding("Failed decoding \(Item.self) for \(tag): \(error)"))
                            return
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

    static func encodeToJSON(_ value: some Encodable) throws -> JSONValue {
        let data = try WireCoding.encoder.encode(value)
        return try WireCoding.decoder.decode(JSONValue.self, from: data)
    }

    // MARK: - server.* (§3.2, §3.11)

    public func getConfig() async throws -> ServerConfig {
        try await call("server.getConfig", EmptyPayload())
    }

    public func subscribeServerConfig() -> AsyncThrowingStream<ServerConfigStreamEvent, Error> {
        streamCall("subscribeServerConfig", EmptyPayload())
    }

    public func subscribeServerLifecycle() -> AsyncThrowingStream<ServerLifecycleStreamEvent, Error> {
        streamCall("subscribeServerLifecycle", EmptyPayload())
    }

    // MARK: - orchestration.* (§3.1)

    @discardableResult
    public func dispatch(_ command: ClientOrchestrationCommand) async throws -> DispatchResult {
        try await call("orchestration.dispatchCommand", command)
    }

    public func getTurnDiff(
        threadId: String, fromTurnCount: Int, toTurnCount: Int, ignoreWhitespace: Bool? = nil
    ) async throws -> ThreadTurnDiff {
        try await call(
            "orchestration.getTurnDiff",
            OrchestrationGetTurnDiffInput(
                fromTurnCount: fromTurnCount, toTurnCount: toTurnCount, threadId: threadId,
                ignoreWhitespace: ignoreWhitespace))
    }

    public func getFullThreadDiff(
        threadId: String, toTurnCount: Int, ignoreWhitespace: Bool? = nil
    ) async throws -> ThreadTurnDiff {
        try await call(
            "orchestration.getFullThreadDiff",
            OrchestrationGetFullThreadDiffInput(
                threadId: threadId, toTurnCount: toTurnCount, ignoreWhitespace: ignoreWhitespace))
    }

    public func replayEvents(fromSequenceExclusive: Int) async throws -> [OrchestrationEvent] {
        try await call(
            "orchestration.replayEvents",
            OrchestrationReplayEventsInput(fromSequenceExclusive: fromSequenceExclusive))
    }

    public func getArchivedShellSnapshot() async throws -> OrchestrationShellSnapshot {
        try await call("orchestration.getArchivedShellSnapshot", EmptyPayload())
    }

    /// Snapshot-then-live-tail (§4.2): first item is `.snapshot`, then
    /// `.event(...)` deltas for every project/thread. Re-issue after every
    /// reconnect (§4.3) — there is no resume token.
    public func subscribeShell() -> AsyncThrowingStream<OrchestrationShellStreamItem, Error> {
        streamCall("orchestration.subscribeShell", EmptyPayload())
    }

    /// Snapshot-then-live-tail for one thread's detail (messages, activities,
    /// proposed plans, checkpoints, session).
    public func subscribeThread(threadId: String) -> AsyncThrowingStream<OrchestrationThreadStreamItem, Error> {
        streamCall("orchestration.subscribeThread", OrchestrationSubscribeThreadInput(threadId: threadId))
    }

    // MARK: - Command convenience wrappers
    //
    // Thin sugar over `dispatch(_:)` that fills in `commandId`/`createdAt`.
    // Kept at the wire-parameter level (not BackendService's UI-level
    // signatures) since resolving UI ids (e.g. a `Checkpoint.id` ->
    // `turnCount`) is the app-layer adapter's job, not this client's.

    @discardableResult
    public func createProject(
        projectId: String, title: String, workspaceRoot: String,
        createWorkspaceRootIfMissing: Bool? = nil, defaultModelSelection: ModelSelection? = nil
    ) async throws -> DispatchResult {
        try await dispatch(
            .projectCreate(
                ProjectCreateCommand(
                    commandId: T3Ids.newCommandId(), projectId: projectId, title: title,
                    workspaceRoot: workspaceRoot,
                    createWorkspaceRootIfMissing: createWorkspaceRootIfMissing,
                    defaultModelSelection: defaultModelSelection, createdAt: T3Clock.nowISO8601())))
    }

    @discardableResult
    public func deleteProject(projectId: String, force: Bool? = nil) async throws -> DispatchResult {
        try await dispatch(
            .projectDelete(
                ProjectDeleteCommand(commandId: T3Ids.newCommandId(), projectId: projectId, force: force)))
    }

    @discardableResult
    public func createThread(
        threadId: String, projectId: String, title: String, modelSelection: ModelSelection,
        runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode = .wireDefault,
        branch: String? = nil, worktreePath: String? = nil
    ) async throws -> DispatchResult {
        try await dispatch(
            .threadCreate(
                ThreadCreateCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId, projectId: projectId,
                    title: title, modelSelection: modelSelection, runtimeMode: runtimeMode,
                    interactionMode: interactionMode, branch: branch, worktreePath: worktreePath,
                    createdAt: T3Clock.nowISO8601())))
    }

    @discardableResult
    public func deleteThread(threadId: String) async throws -> DispatchResult {
        try await dispatch(.threadDelete(ThreadDeleteCommand(commandId: T3Ids.newCommandId(), threadId: threadId)))
    }

    @discardableResult
    public func archiveThread(threadId: String) async throws -> DispatchResult {
        try await dispatch(.threadArchive(ThreadArchiveCommand(commandId: T3Ids.newCommandId(), threadId: threadId)))
    }

    @discardableResult
    public func unarchiveThread(threadId: String) async throws -> DispatchResult {
        try await dispatch(
            .threadUnarchive(ThreadUnarchiveCommand(commandId: T3Ids.newCommandId(), threadId: threadId)))
    }

    @discardableResult
    public func setRuntimeMode(threadId: String, runtimeMode: RuntimeMode) async throws -> DispatchResult {
        try await dispatch(
            .threadRuntimeModeSet(
                ThreadRuntimeModeSetCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId, runtimeMode: runtimeMode,
                    createdAt: T3Clock.nowISO8601())))
    }

    @discardableResult
    public func setInteractionMode(
        threadId: String, interactionMode: ProviderInteractionMode
    ) async throws -> DispatchResult {
        try await dispatch(
            .threadInteractionModeSet(
                ThreadInteractionModeSetCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId,
                    interactionMode: interactionMode, createdAt: T3Clock.nowISO8601())))
    }

    /// Partial thread-meta update; `nil` fields are omitted (left untouched).
    @discardableResult
    public func updateThreadMeta(
        threadId: String, title: String? = nil, modelSelection: ModelSelection? = nil,
        branch: String?? = nil, worktreePath: String?? = nil
    ) async throws -> DispatchResult {
        try await dispatch(
            .threadMetaUpdate(
                ThreadMetaUpdateCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId, title: title,
                    modelSelection: modelSelection, branch: branch, worktreePath: worktreePath)))
    }

    /// Sends a user message and starts a turn (composer send action).
    @discardableResult
    public func startTurn(
        threadId: String, text: String, attachments: [UploadChatAttachment] = [],
        modelSelection: ModelSelection? = nil, titleSeed: String? = nil,
        runtimeMode: RuntimeMode = .wireDefault, interactionMode: ProviderInteractionMode = .wireDefault,
        sourceProposedPlan: SourceProposedPlanReference? = nil
    ) async throws -> DispatchResult {
        let message = ChatMessageInput(
            messageId: T3Ids.newMessageId(), text: text, attachments: attachments)
        return try await dispatch(
            .threadTurnStart(
                ThreadTurnStartCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId, message: message,
                    modelSelection: modelSelection, titleSeed: titleSeed, runtimeMode: runtimeMode,
                    interactionMode: interactionMode, sourceProposedPlan: sourceProposedPlan,
                    createdAt: T3Clock.nowISO8601())))
    }

    @discardableResult
    public func interruptTurn(threadId: String, turnId: String? = nil) async throws -> DispatchResult {
        try await dispatch(
            .threadTurnInterrupt(
                ThreadTurnInterruptCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId, turnId: turnId,
                    createdAt: T3Clock.nowISO8601())))
    }

    @discardableResult
    public func respondToApproval(
        threadId: String, requestId: String, decision: ProviderApprovalDecision
    ) async throws -> DispatchResult {
        try await dispatch(
            .threadApprovalRespond(
                ThreadApprovalRespondCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId, requestId: requestId,
                    decision: decision, createdAt: T3Clock.nowISO8601())))
    }

    @discardableResult
    public func respondToUserInput(
        threadId: String, requestId: String, answers: ProviderUserInputAnswers
    ) async throws -> DispatchResult {
        try await dispatch(
            .threadUserInputRespond(
                ThreadUserInputRespondCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId, requestId: requestId,
                    answers: answers, createdAt: T3Clock.nowISO8601())))
    }

    @discardableResult
    public func revertCheckpoint(threadId: String, turnCount: Int) async throws -> DispatchResult {
        try await dispatch(
            .threadCheckpointRevert(
                ThreadCheckpointRevertCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId, turnCount: turnCount,
                    createdAt: T3Clock.nowISO8601())))
    }

    @discardableResult
    public func stopSession(threadId: String) async throws -> DispatchResult {
        try await dispatch(
            .threadSessionStop(
                ThreadSessionStopCommand(
                    commandId: T3Ids.newCommandId(), threadId: threadId, createdAt: T3Clock.nowISO8601())))
    }
}
