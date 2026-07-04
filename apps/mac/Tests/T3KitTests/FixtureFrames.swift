// FixtureFrames.swift
// Plain string constants — NOT a bundled resource — reproducing the canonical
// wire frames from docs/wire-protocol.md Appendix A, plus a handful of
// additional frames needed to exercise edges (Die/Interrupt causes, batches,
// no-value encodings, non-`_tag` discriminators) that the appendix only
// describes in prose. Every constant below cites the doc section it mirrors.

enum FixtureFrames {

    // MARK: - §Appendix A — canonical example frames

    /// C→S invoke `server.getConfig` (id 0).
    static let requestGetConfig = #"""
    {"_tag":"Request","id":"0","tag":"server.getConfig","payload":{},"headers":[]}
    """#

    /// S→C success exit for the above.
    static let exitGetConfigSuccess = #"""
    {"_tag":"Exit","requestId":"0","exit":{"_tag":"Success","value":{"cwd":"/tmp"}}}
    """#

    /// C→S subscribe to a thread (streaming; id 1).
    static let requestSubscribeThread = #"""
    {"_tag":"Request","id":"1","tag":"orchestration.subscribeThread","payload":{"threadId":"th_123"},"headers":[]}
    """#

    /// S→C first chunk = snapshot.
    static let chunkSubscribeThreadSnapshot = #"""
    {"_tag":"Chunk","requestId":"1","values":[{"kind":"snapshot","snapshot":{"snapshotSequence":100,"thread":{"id":"th_123"}}}]}
    """#

    /// C→S must ack the snapshot chunk to receive more.
    static let ackSubscribeThreadSnapshot = #"""
    {"_tag":"Ack","requestId":"1"}
    """#

    /// S→C live event chunk.
    static let chunkSubscribeThreadEvent = #"""
    {"_tag":"Chunk","requestId":"1","values":[{"kind":"event","event":{"sequence":101,"type":"thread.message-sent","aggregateKind":"thread","aggregateId":"th_123","occurredAt":"2026-07-04T12:00:00.000Z","eventId":"ev_9","commandId":null,"causationEventId":null,"correlationId":null,"metadata":{},"payload":{}}}]}
    """#

    /// C→S ack for the live event chunk.
    static let ackSubscribeThreadEvent = #"""
    {"_tag":"Ack","requestId":"1"}
    """#

    /// Heartbeat: client ping.
    static let ping = #"""
    {"_tag":"Ping"}
    """#

    /// Heartbeat: server pong.
    static let pong = #"""
    {"_tag":"Pong"}
    """#

    /// C→S start a turn via `dispatchCommand` (id 2).
    static let requestDispatchTurnStart = #"""
    {"_tag":"Request","id":"2","tag":"orchestration.dispatchCommand","headers":[],"payload":{"type":"thread.turn.start","commandId":"cmd_1","threadId":"th_123","message":{"messageId":"m_1","role":"user","text":"hi","attachments":[]},"runtimeMode":"full-access","interactionMode":"default","createdAt":"2026-07-04T12:00:01.000Z"}}
    """#

    /// S→C success exit for the dispatched command.
    static let exitDispatchTurnStartSuccess = #"""
    {"_tag":"Exit","requestId":"2","exit":{"_tag":"Success","value":{"sequence":102}}}
    """#

    /// C→S cancel the subscription.
    static let interruptSubscribeThread = #"""
    {"_tag":"Interrupt","requestId":"1"}
    """#

    /// C→S "done sending" (rarely used).
    static let eof = #"""
    {"_tag":"Eof"}
    """#

    /// S→C failure exit — missing scope (§1.2, §5.6).
    static let exitAuthorizationFailure = #"""
    {"_tag":"Exit","requestId":"3","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: orchestration:operate","requiredScope":"orchestration:operate"}}]}}
    """#

    // MARK: - Additional Exit.Failure cause shapes (§2.2, §5.6)

    /// Unexpected server crash: `Die` cause with an opaque defect.
    static let exitDieFailure = #"""
    {"_tag":"Exit","requestId":"4","exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":{"name":"TypeError","message":"boom"}}]}}
    """#

    /// Interrupted fiber, `fiberId` present.
    static let exitInterruptFailureWithFiberId = #"""
    {"_tag":"Exit","requestId":"5","exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":12}]}}
    """#

    /// Interrupted fiber, `fiberId` absent (§2.2: "may be undefined/absent").
    static let exitInterruptFailureWithoutFiberId = #"""
    {"_tag":"Exit","requestId":"6","exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt"}]}}
    """#

    // MARK: - Connection-level frames (§2.2)

    static let defect = #"""
    {"_tag":"Defect","defect":{"name":"Error","message":"connection lost"}}
    """#

    static let clientEndWithId = #"""
    {"_tag":"ClientEnd","clientId":5}
    """#

    static let clientEndWithoutId = #"""
    {"_tag":"ClientEnd"}
    """#

    static let unknownServerTag = #"""
    {"_tag":"SomeFutureMessage","foo":"bar"}
    """#

    // MARK: - §2.1 batching — one WS frame may be a JSON array of messages

    static let batchOfTwoServerFrames = #"""
    [{"_tag":"Pong"},{"_tag":"Chunk","requestId":"1","values":[{"kind":"snapshot","snapshot":{}}]}]
    """#

    // MARK: - §5.3/§5.4 no-value encoding matrix

    /// `Schema.optional` — key entirely absent.
    static let optionalKeyAbsent = #"""
    {"present":"x"}
    """#

    /// `Schema.NullOr` — key present, value explicit JSON null.
    static let nullOrKeyPresentNull = #"""
    {"present":"x","branch":null}
    """#

    /// `Schema.Option` — tagged object, the "Some" case.
    static let optionSome = #"""
    {"_tag":"Some","value":"origin/main"}
    """#

    /// `Schema.Option` — tagged object, the "None" case.
    static let optionNone = #"""
    {"_tag":"None"}
    """#

    // MARK: - §5.5 discriminator variants (`_tag` vs `type` vs `kind`)

    /// Envelope-style union discriminated by `_tag` (protocol frames, tagged errors).
    static let discriminatorByTag = #"""
    {"_tag":"EnvironmentAuthorizationError","message":"nope","requiredScope":"access:read"}
    """#

    /// OrchestrationEvent-style union discriminated by `type` (orchestration.ts:1001+).
    static let discriminatorByType = #"""
    {"sequence":7,"type":"thread.archived","aggregateKind":"thread","aggregateId":"th_1"}
    """#

    /// Orchestration stream-item-style union discriminated by `kind` (orchestration.ts:421-452, :1115-1124).
    static let discriminatorByKind = #"""
    {"kind":"thread-upserted","sequence":9,"threadId":"th_1"}
    """#
}
