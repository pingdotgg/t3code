// RpcConnection.swift
// The core actor: owns the WebSocket, the request-id counter, the in-flight
// registry, mandatory per-`Chunk` `Ack` backpressure (§2.3 — critical, or a
// stream stalls after its first chunk), the 5s `Ping` heartbeat with ~10s
// dead-connection detection (§1.4), request/stream/interrupt primitives, and
// a connection-state `AsyncStream` for observers.
//
// This layer deals exclusively in `JSONValue` payloads/values (§2, §5).
// RPC-method-specific typing (mapping `tag` -> payload/success Codables)
// happens one layer up, via `JSONValue.decode(as:using:)`.
//
// There is no application-level handshake (§1.3) — a caller may issue any
// RPC as the first request once `connect()` returns. This actor does not
// auto-reconnect (§1.5): reconnection (fresh `AuthClient.makeSocketURL()`,
// a new `RpcConnection`, re-`server.getConfig`, re-`subscribe*`, optionally
// `orchestration.replayEvents`) is a supervisor concern one layer up (§4.3).
//
// ─────────────────────────────────────────────────────────────────────────
// DESIGN NOTES — invariants preserved across the two protocol fixes below.
// (Kept as comments-to-self so future edits don't silently regress them.)
//
// A. Outbound frame ordering (§2 wire order == call order).
//    Every C→S frame flows through a single actor-owned FIFO `outboundQueue`
//    drained by ONE long-lived `writerTask`. Callers *enqueue synchronously*
//    at call time (no suspension between id allocation / pending registration
//    and enqueue), so the wire order a single writer produces is exactly the
//    order calls reached the actor. Two back-to-back `dispatchCommand`s
//    (turn.start → turn.interrupt → approval.respond) can no longer race onto
//    the wire out of order the way per-call `Task { send }` allowed.
//
// B. No lost responses. `pending[id]` is registered *before* the request
//    frame is ever enqueued, and both happen with no suspension point in
//    between — so a reentrant `Exit`/`Chunk` can never arrive before its
//    pending entry exists.
//
// C. Atomic completion, no double-resume. Unary completions do
//    check-then-remove on `pending`. Stream completions funnel through a
//    per-request `StreamState` whose terminal transition removes `pending[id]`
//    exactly once. On teardown, `failAllPending` runs *before* the outbound
//    queue is drained, so a queued request frame's `.failPending` handler is a
//    no-op (its pending entry is already gone) — no continuation is resumed
//    twice.
//
// D. Real backpressure (§2.3). A chunk's `Ack` is sent only when the consumer
//    has *drained that whole chunk* out of `StreamState` (see
//    `nextStreamValue`). Because the server blocks after each chunk awaiting
//    its `Ack`, at most ~one chunk sits buffered ahead of a slow consumer:
//    unbounded memory growth is gone. The lenient malformed-frame recovery
//    still Acks leniently (a chunk that never decoded never entered the
//    buffer, so it is never double-Acked).
//
// E. Teardown / drop / cancellation never hang or double-resume. Queued-but-
//    unsent frames fail their awaiters/pending on teardown; a consumer parked
//    inside `nextStreamValue` is woken (via `StreamState.termination` or task
//    cancellation) and throws rather than hanging; the sole abandonment signal
//    for an `unfolding` stream is task cancellation, which `T3Client.streamCall`
//    guarantees by converting its outer stream's termination into a
//    `task.cancel()`.

import Foundation

/// Minimal WebSocket surface `RpcConnection` needs. `URLSessionWebSocketTask`
/// satisfies it directly; tests inject an in-memory double via the internal
/// `connect(socket:)` seam. `Sendable` because the actor awaits the socket's
/// nonisolated `send`/`receive` (which "sends" it off the actor); a test double
/// must guarantee its own thread-safety (`@unchecked Sendable`).
protocol RpcWebSocket: Sendable {
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func resume()
}

extension URLSessionWebSocketTask: RpcWebSocket {}

/// One live (or attempting-to-be-live) WebSocket connection to the t3
/// server's `/ws` RPC endpoint.
public actor RpcConnection {

    // MARK: Connection state

    public enum ConnectionState: Sendable, Equatable {
        case disconnected
        case connecting
        case connected
        case closed(reason: String?)
    }

    /// Per-streaming-request buffer + terminal state. Fed by the receive loop
    /// (`handleChunk`/`handleExit`) and drained by the consumer via
    /// `nextStreamValue`. Touched *only* on the actor (or handed to an actor
    /// method), so `@unchecked Sendable` is sound: there is no unsynchronized
    /// cross-actor access.
    private final class StreamState: @unchecked Sendable {
        enum Termination { case success; case failure(Error) }

        /// FIFO of received chunks' value-arrays not yet fully drained.
        private var chunks: [[JSONValue]] = []
        /// Read cursor into `chunks.first`.
        private var headOffset = 0
        /// Set once a terminal `Exit` (or teardown) is observed; surfaced to
        /// the consumer after the buffer drains.
        var termination: Termination?
        /// A failure sending a drain-`Ack` (dead socket); surfaced on the next
        /// pull so the stream fails rather than silently stalling.
        var ackFailure: Error?
        /// The consumer parked awaiting more values (empty buffer, not yet
        /// terminated).
        private var waiter: CheckedContinuation<Void, Never>?

        func enqueue(_ values: [JSONValue]) { chunks.append(values) }

        /// Pops the next buffered value. `didCompleteChunk` is true when the
        /// popped value was the last of its chunk — the point at which that
        /// chunk should be `Ack`'d (§2.3 backpressure release).
        func popValue() -> (value: JSONValue, didCompleteChunk: Bool)? {
            guard let head = chunks.first, headOffset < head.count else { return nil }
            let value = head[headOffset]
            headOffset += 1
            if headOffset >= head.count {
                chunks.removeFirst()
                headOffset = 0
                return (value, true)
            }
            return (value, false)
        }

        /// Drop buffered values (teardown): the consumer will observe
        /// `termination` immediately instead of draining a dead connection.
        func discardBuffer() {
            chunks.removeAll()
            headOffset = 0
        }

        func park(_ continuation: CheckedContinuation<Void, Never>) { waiter = continuation }

        func wake() {
            guard let waiter else { return }
            self.waiter = nil
            waiter.resume()
        }
    }

    private enum PendingRequest {
        case unary(CheckedContinuation<JSONValue, Error>)
        case stream(StreamState)
    }

    /// Incoming WS message cap (64 MiB). See `connect()`.
    static let maxIncomingMessageBytes = 64 * 1024 * 1024

    private let url: URL
    private let urlSession: URLSession

    private var socket: (any RpcWebSocket)?
    private var receiveLoopTask: Task<Void, Never>?
    private var pingLoopTask: Task<Void, Never>?
    private var writerTask: Task<Void, Never>?

    private var nextRequestId: Int = 0
    private var pending: [String: PendingRequest] = [:]

    // MARK: Outbound FIFO (frame-ordering fix, §note A)

    private enum OutboundResult {
        /// Best-effort frame (Ack/Interrupt/Eof); send errors are ignored.
        case ignore
        /// A caller is awaiting the send's completion.
        case awaited(CheckedContinuation<Void, Error>)
        /// A request frame: on send failure, fail its pending RPC.
        case failPending(id: String)
    }

    private struct OutboundItem {
        let frame: ClientFrame
        let onResult: OutboundResult
    }

    private var outboundQueue: [OutboundItem] = []
    /// The single writer parked because the queue is empty.
    private var writerWaiter: CheckedContinuation<Void, Never>?

    /// Whether the most recently sent `Ping` has not yet been answered by a
    /// `Pong`. If still true the *next* time the 5s ping tick fires, the
    /// connection is treated as dead (§1.4: ~5-10s without a `Pong`).
    private var awaitingPong = false

    private var currentState: ConnectionState = .disconnected {
        didSet { stateContinuation.yield(currentState) }
    }

    /// Connection-state observation stream. Safe to iterate from any
    /// isolation context; delivers `.disconnected` immediately to new
    /// subscribers as the initial value is buffered.
    public nonisolated let stateUpdates: AsyncStream<ConnectionState>
    private nonisolated let stateContinuation: AsyncStream<ConnectionState>.Continuation

    public init(url: URL, urlSession: URLSession = .shared) {
        self.url = url
        self.urlSession = urlSession
        let (stream, continuation) = AsyncStream<ConnectionState>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.stateUpdates = stream
        self.stateContinuation = continuation
        continuation.yield(.disconnected)
    }

    // MARK: Lifecycle

    /// Opens the socket and starts the receive loop + 5s ping heartbeat.
    /// Does not itself wait for a successful upgrade handshake — failures
    /// surface either as a thrown error from an in-flight `request`/`stream`
    /// call or as a `.closed` state transition once the receive loop's first
    /// read fails.
    public func connect() async throws {
        guard socket == nil else { return }
        let task = urlSession.webSocketTask(with: url)
        // A thread snapshot arrives as one WS text message and can far exceed
        // URLSession's 1 MiB default; hitting the cap makes `receive()` throw,
        // which tears the session down and — because the supervisor re-opens
        // the same subscriptions — locks the app in a reconnect loop the
        // server never even sees. Long-lived threads reach several MiB, so
        // give plenty of headroom.
        task.maximumMessageSize = Self.maxIncomingMessageBytes
        start(socket: task)
    }

    /// Test seam: attach an in-memory socket double without hitting the
    /// network. Same startup path as `connect()`.
    func connect(socket: any RpcWebSocket) {
        guard self.socket == nil else { return }
        start(socket: socket)
    }

    private func start(socket: any RpcWebSocket) {
        currentState = .connecting
        self.socket = socket
        socket.resume()
        awaitingPong = false
        currentState = .connected
        receiveLoopTask = Task { [weak self] in await self?.receiveLoop() }
        pingLoopTask = Task { [weak self] in await self?.pingLoop() }
        writerTask = Task { [weak self] in await self?.runWriter() }
    }

    /// Tears down the socket, fails every in-flight request/stream, and
    /// moves to `.closed`. Idempotent.
    public func disconnect(reason: String? = nil) async {
        await teardown(state: .closed(reason: reason), error: T3Error.connectionClosed(reason: reason))
    }

    deinit {
        stateContinuation.finish()
    }

    // MARK: Public RPC surface

    /// Invokes a non-streaming RPC and awaits its terminal `Exit`. Resolves
    /// with the decoded success value, or throws `T3Error.rpc` for a typed
    /// `Exit.Failure` (§2.2) — scope errors (`EnvironmentAuthorizationError`)
    /// arrive this way too and are not connection-fatal (§risk9).
    public func request(
        tag: String,
        payload: JSONValue,
        headers: [[String]] = [],
        traceId: String? = nil
    ) async throws -> JSONValue {
        let id = allocateRequestId()
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<JSONValue, Error>) in
            // Register before the frame is ever enqueued so a reentrant
            // `Exit`/`Chunk` always finds its pending entry (§note B). Both
            // steps are synchronous — no suspension in between — and the
            // synchronous enqueue pins wire order to call order (§note A).
            pending[id] = .unary(continuation)
            enqueue(.request(id: id, tag: tag, payload: payload, headers: headers, traceId: traceId),
                    onResult: .failPending(id: id))
        }
    }

    /// Invokes a streaming RPC. The returned stream yields one value out of a
    /// `Chunk`'s (possibly batched) `values` array at a time, PULL-based:
    /// every `Chunk`'s mandatory `Ack` (§2.3) is deferred until the consumer
    /// has drained that chunk, which is what actually engages the server's
    /// per-chunk flow control (a slow consumer no longer buffers unboundedly).
    /// The stream finishes normally on `Exit.Success`, throws `T3Error.rpc` on
    /// `Exit.Failure`, and — if the consuming `Task` is cancelled (which is how
    /// `T3Client.streamCall` reports an abandoned subscription) — sends
    /// `Interrupt` for the request (§2.4).
    public func stream(
        tag: String,
        payload: JSONValue,
        headers: [[String]] = [],
        traceId: String? = nil
    ) async throws -> AsyncThrowingStream<JSONValue, Error> {
        let id = allocateRequestId()
        let state = StreamState()
        // Registered before the initial `Request` is enqueued (§note B).
        pending[id] = .stream(state)
        do {
            // Await the initial send so a send failure throws synchronously to
            // the caller (§2.4) rather than only surfacing on first iteration.
            // The enqueue itself is synchronous, preserving wire order.
            try await sendAwaiting(.request(id: id, tag: tag, payload: payload, headers: headers, traceId: traceId))
        } catch {
            pending.removeValue(forKey: id)
            throw error
        }
        // `unfolding` gives us the consumer-pull hook that makes deferred,
        // drain-driven Acks possible. It has no `onTermination`, so the sole
        // abandonment signal is cancellation of the consuming task — handled in
        // `nextStreamValue`.
        return AsyncThrowingStream<JSONValue, Error> { [weak self, state] in
            guard let self else { return nil }
            return try await self.nextStreamValue(state: state, id: id)
        }
    }

    /// Cancels an in-flight request or unsubscribes from a stream (§2.4).
    /// Resolves/finishes the pending continuation with `CancellationError`
    /// locally and notifies the server; a no-op if `requestId` is unknown
    /// (already completed or already interrupted).
    public func interrupt(requestId: String) async {
        guard let entry = pending.removeValue(forKey: requestId) else { return }
        switch entry {
        case .unary(let continuation):
            continuation.resume(throwing: CancellationError())
        case .stream(let state):
            state.discardBuffer()
            state.termination = .failure(CancellationError())
            state.wake()
        }
        enqueue(.interrupt(requestId: requestId), onResult: .ignore)
    }

    /// Sends `{"_tag":"Eof"}` (§2.2). Rarely needed — the reference client
    /// never sends it — provided for forward compatibility.
    public func sendEof() async throws {
        try await sendAwaiting(.eof)
    }

    // MARK: Outbound FIFO writer (§note A)

    /// Enqueue a frame for the single writer. Synchronous (no suspension) so it
    /// pins wire order to actor-arrival order. If the socket is already gone,
    /// the item fails immediately rather than languishing in a queue no writer
    /// will ever drain.
    private func enqueue(_ frame: ClientFrame, onResult: OutboundResult) {
        let item = OutboundItem(frame: frame, onResult: onResult)
        guard socket != nil else {
            complete(item, error: T3Error.notConnected)
            return
        }
        outboundQueue.append(item)
        if let waiter = writerWaiter {
            writerWaiter = nil
            waiter.resume()
        }
    }

    /// Enqueue a frame and await its actual send (success or failure).
    private func sendAwaiting(_ frame: ClientFrame) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            enqueue(frame, onResult: .awaited(continuation))
        }
    }

    private func runWriter() async {
        while !Task.isCancelled {
            guard !outboundQueue.isEmpty else {
                // Park until `enqueue` (or teardown) resumes us. No enqueue can
                // interleave between the emptiness check and parking: both run
                // on the actor with no suspension in between.
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    writerWaiter = continuation
                }
                continue
            }
            let item = outboundQueue.removeFirst()
            await deliver(item)
        }
        // Exit only happens via teardown, which owns draining any residual
        // queue — nothing left to do here.
    }

    private func deliver(_ item: OutboundItem) async {
        guard let socket else {
            complete(item, error: T3Error.notConnected)
            return
        }
        let text: String
        do {
            text = try WireCoding.encodeFrameString(item.frame)
        } catch {
            complete(item, error: T3Error.decoding("Failed to encode outgoing frame: \(error)"))
            return
        }
        do {
            try await socket.send(.string(text))
        } catch {
            complete(item, error: T3Error.transport("WebSocket send failed: \(error)"))
            return
        }
        complete(item, error: nil)
    }

    private func complete(_ item: OutboundItem, error: Error?) {
        switch item.onResult {
        case .ignore:
            break
        case .awaited(let continuation):
            if let error {
                continuation.resume(throwing: error)
            } else {
                continuation.resume(returning: ())
            }
        case .failPending(let id):
            if let error { failPending(id: id, with: error) }
        }
    }

    // MARK: Receive loop

    private func receiveLoop() async {
        guard let socket else { return }
        while !Task.isCancelled {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await socket.receive()
            } catch {
                if Task.isCancelled { return }
                await teardown(state: .closed(reason: "\(error)"), error: T3Error.transport("WebSocket receive failed: \(error)"))
                return
            }

            let text: String?
            switch message {
            case .string(let value):
                text = value
            case .data(let data):
                text = String(data: data, encoding: .utf8)
            @unknown default:
                text = nil
            }
            guard let text else { continue }

            let frames: [ServerFrame]
            do {
                frames = try FrameBatch.decode(text)
            } catch {
                // A single malformed frame doesn't identify which in-flight
                // request it belonged to; drop it rather than tearing down
                // every other in-flight request/stream on this connection.
                //
                // A structurally-broken `Chunk` (e.g. an envelope that
                // decodes `_tag`/`requestId` fine but fails deeper, such as a
                // `Die` cause missing its `defect` key) still latched the
                // server-side backpressure gate for that requestId
                // (`RpcServer.ts:466-467`); if we never Ack it, that stream
                // stalls forever even though the socket is healthy. Recover
                // the `_tag`/`requestId` leniently (without requiring the
                // rest of the frame to decode) and Ack it so the stream can
                // keep moving, even though this batch of values is lost. A
                // chunk that never decoded never entered a `StreamState`
                // buffer, so it is never double-Acked by the drain path.
                ackLeniently(text)
                continue
            }
            for frame in frames {
                await handle(frame)
            }
        }
    }

    /// Best-effort recovery for a WS text frame (or one element of a batch)
    /// that failed full `ServerFrame` decoding. If it can still be recognized
    /// as a `Chunk` for a known requestId — by parsing only `_tag`/
    /// `requestId` rather than the whole envelope — send its mandatory `Ack`
    /// so the server-side backpressure latch doesn't stay closed forever
    /// (§2.3). This is deliberately shallow: it does not attempt to salvage
    /// per-element frames out of a malformed batch array.
    private func ackLeniently(_ text: String) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (object["_tag"] as? String) == "Chunk",
              let requestId = object["requestId"] as? String
        else { return }
        enqueue(.ack(requestId: requestId), onResult: .ignore)
    }

    private func handle(_ frame: ServerFrame) async {
        switch frame {
        case let .chunk(requestId, values):
            handleChunk(requestId: requestId, values: values)
        case let .exit(requestId, exit):
            handleExit(requestId: requestId, exit: exit)
        case let .defect(defect):
            // Connection-level: not tied to one request, kills all in-flight
            // requests/streams (§2.2). The socket itself is left open — the
            // server may still be reachable for new requests.
            failAllPending(with: T3Error.rpc(RpcFailure(causes: [.die(defect: defect)])))
        case let .clientProtocolError(error):
            // Connection-level, like `Defect`: the server transport has
            // abandoned every in-flight request on this connection
            // (`RpcClient.ts:780-786`). The socket itself is left open.
            failAllPending(with: T3Error.rpc(RpcFailure(causes: [.die(defect: error)])))
        case .pong:
            awaitingPong = false
        case .clientEnd:
            break // Ignored, matching the reference client (§2.2).
        case .unknown:
            break // Forward-compatible: ignore unrecognized envelope tags.
        }
    }

    private func handleChunk(requestId: String, values: [JSONValue]) {
        guard case .stream(let state)? = pending[requestId] else {
            // A non-streaming RPC should never receive a Chunk; surface it as
            // a protocol violation rather than silently dropping the values.
            if case .unary(let continuation)? = pending[requestId] {
                pending.removeValue(forKey: requestId)
                continuation.resume(throwing: T3Error.unexpectedFrame("Received Chunk for non-streaming request \(requestId)"))
            }
            // No (or no longer any) stream consumer for this id — still must
            // Ack or the server-side latch for this requestId never opens.
            enqueue(.ack(requestId: requestId), onResult: .ignore)
            return
        }
        guard !values.isEmpty else {
            // Empty chunk: nothing to drain, so its drain-triggered Ack would
            // never fire. Ack immediately so the stream isn't wedged.
            enqueue(.ack(requestId: requestId), onResult: .ignore)
            return
        }
        // NOTE: the Ack is intentionally NOT sent here. It is deferred until
        // the consumer drains this chunk (see `nextStreamValue`) — that is the
        // backpressure (§2.3, §note D).
        state.enqueue(values)
        state.wake()
    }

    private func handleExit(requestId: String, exit: ExitResult) {
        guard let entry = pending[requestId] else { return }
        switch entry {
        case .unary(let continuation):
            pending.removeValue(forKey: requestId)
            switch exit {
            case let .success(value):
                continuation.resume(returning: value)
            case let .failure(failure):
                continuation.resume(throwing: T3Error.rpc(failure))
            }
        case .stream(let state):
            // Don't remove `pending` yet — the consumer may still be draining
            // buffered chunks. Record the terminal state; `nextStreamValue`
            // removes the entry once the buffer empties.
            switch exit {
            case .success:
                state.termination = .success
            case let .failure(failure):
                state.termination = .failure(T3Error.rpc(failure))
            }
            state.wake()
        }
    }

    /// Consumer-pull hook for a streaming RPC (§note D). Returns the next
    /// buffered value, Acking a chunk the moment the consumer finishes draining
    /// it; parks when the buffer is empty; ends (`nil`) on `Exit.Success`,
    /// throws on `Exit.Failure`/teardown, and — on cancellation of the
    /// consuming task — sends `Interrupt` and throws `CancellationError`.
    private func nextStreamValue(state: StreamState, id: String) async throws -> JSONValue? {
        if Task.isCancelled {
            await abandonStream(id: id)
            throw CancellationError()
        }
        while true {
            if let ackFailure = state.ackFailure {
                pending.removeValue(forKey: id)
                throw ackFailure
            }
            if let (value, didCompleteChunk) = state.popValue() {
                if didCompleteChunk {
                    // Backpressure release: the server was blocked awaiting this
                    // Ack and only now sends the next chunk (§2.3). Surface a
                    // send failure on the next pull rather than dropping it.
                    do {
                        try await sendAwaiting(.ack(requestId: id))
                    } catch {
                        state.ackFailure = error
                    }
                }
                return value
            }
            if let termination = state.termination {
                pending.removeValue(forKey: id)
                switch termination {
                case .success: return nil
                case .failure(let error): throw error
                }
            }
            // Buffer empty and not terminated: park until a chunk/exit arrives
            // or the consuming task is cancelled.
            await withTaskCancellationHandler {
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    state.park(continuation)
                }
            } onCancel: {
                Task { [weak self, state] in await self?.wake(state) }
            }
            if Task.isCancelled {
                await abandonStream(id: id)
                throw CancellationError()
            }
        }
    }

    /// Actor-hop target for the cancellation handler in `nextStreamValue`:
    /// resumes the parked consumer so it can observe cancellation.
    private func wake(_ state: StreamState) { state.wake() }

    /// The consuming task walked away (early break routed through cancellation,
    /// or `Task` cancellation). Only sends `Interrupt` if the request was still
    /// tracked as pending — i.e. no terminal `Exit` was fully consumed yet
    /// (§2.4). Mirrors the pre-refactor `onTermination` behaviour.
    private func abandonStream(id: String) async {
        guard pending.removeValue(forKey: id) != nil else { return }
        enqueue(.interrupt(requestId: id), onResult: .ignore)
    }

    // MARK: Heartbeat (§1.4)

    private func pingLoop() async {
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(5))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }

            if awaitingPong {
                // Previous Ping went unanswered through this whole tick:
                // ~5-10s of silence, treat as dead (§1.4, §risk3).
                await teardown(state: .closed(reason: "ping timeout"), error: T3Error.pingTimeout)
                return
            }
            awaitingPong = true
            do {
                try await sendAwaiting(.ping)
            } catch {
                // A teardown in progress fails the queued Ping's awaiter; don't
                // re-enter teardown in that case (§note E — no double-teardown).
                if Task.isCancelled { return }
                await teardown(state: .closed(reason: "\(error)"), error: T3Error.transport("Failed to send Ping: \(error)"))
                return
            }
        }
    }

    // MARK: Teardown helpers

    private func failPending(id: String, with error: Error) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        switch entry {
        case .unary(let continuation):
            continuation.resume(throwing: error)
        case .stream(let state):
            state.discardBuffer()
            state.termination = .failure(error)
            state.wake()
        }
    }

    private func failAllPending(with error: Error) {
        let entries = pending
        pending.removeAll()
        for entry in entries.values {
            switch entry {
            case .unary(let continuation):
                continuation.resume(throwing: error)
            case .stream(let state):
                state.discardBuffer()
                state.termination = .failure(error)
                state.wake()
            }
        }
    }

    /// Drains the residual outbound queue on teardown, failing every awaiter.
    /// Runs *after* `failAllPending`, so a queued request frame's
    /// `.failPending` handler is a no-op (its pending entry is already gone) —
    /// no continuation is resumed twice (§note C).
    private func drainOutboundQueue(with error: Error) {
        let residual = outboundQueue
        outboundQueue.removeAll()
        for item in residual {
            complete(item, error: error)
        }
    }

    private func teardown(state: ConnectionState, error: Error) async {
        // Guard against reentrant / double teardown (§note E): once the socket
        // is gone there is nothing left to tear down, only a state transition.
        guard socket != nil else {
            if currentState != state { currentState = state }
            return
        }
        receiveLoopTask?.cancel()
        pingLoopTask?.cancel()
        writerTask?.cancel()
        receiveLoopTask = nil
        pingLoopTask = nil
        writerTask = nil
        // Wake the writer if it is parked so its Task observes cancellation and
        // exits (a `Never` continuation is never auto-resumed by cancellation).
        if let waiter = writerWaiter {
            writerWaiter = nil
            waiter.resume()
        }
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        failAllPending(with: error)
        drainOutboundQueue(with: error)
        currentState = state
    }

    private func allocateRequestId() -> String {
        defer { nextRequestId += 1 }
        return String(nextRequestId)
    }
}
