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

import Foundation

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

    private enum PendingRequest {
        case unary(CheckedContinuation<JSONValue, Error>)
        case stream(AsyncThrowingStream<JSONValue, Error>.Continuation)
    }

    /// Incoming WS message cap (64 MiB). See `connect()`.
    static let maxIncomingMessageBytes = 64 * 1024 * 1024

    private let url: URL
    private let urlSession: URLSession

    private var task: URLSessionWebSocketTask?
    private var receiveLoopTask: Task<Void, Never>?
    private var pingLoopTask: Task<Void, Never>?

    private var nextRequestId: Int = 0
    private var pending: [String: PendingRequest] = [:]

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
        guard task == nil else { return }
        currentState = .connecting
        let task = urlSession.webSocketTask(with: url)
        // A thread snapshot arrives as one WS text message and can far exceed
        // URLSession's 1 MiB default; hitting the cap makes `receive()` throw,
        // which tears the session down and — because the supervisor re-opens
        // the same subscriptions — locks the app in a reconnect loop the
        // server never even sees. Long-lived threads reach several MiB, so
        // give plenty of headroom.
        task.maximumMessageSize = Self.maxIncomingMessageBytes
        self.task = task
        task.resume()
        awaitingPong = false
        currentState = .connected
        receiveLoopTask = Task { [weak self] in await self?.receiveLoop() }
        pingLoopTask = Task { [weak self] in await self?.pingLoop() }
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
            // Register before the frame is ever sent so a same-actor reentrant
            // `Exit`/`Chunk` arriving while the send is in flight always finds
            // its pending entry (no lost-response race).
            pending[id] = .unary(continuation)
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.send(.request(id: id, tag: tag, payload: payload, headers: headers, traceId: traceId))
                } catch {
                    await self.failPending(id: id, with: error)
                }
            }
        }
    }

    /// Invokes a streaming RPC. The returned stream's first values are
    /// typically a snapshot followed by a live tail (§4.2); each element is
    /// one value out of a `Chunk`'s (possibly batched) `values` array. Every
    /// `Chunk` is `Ack`'d automatically after its values are yielded (§2.3 —
    /// mandatory, handled transparently here). The stream finishes normally
    /// on `Exit.Success`, throws `T3Error.rpc` on `Exit.Failure`, and — if the
    /// consumer stops iterating early (e.g. breaks out of a `for await` loop
    /// or the enclosing `Task` is cancelled) — sends `Interrupt` for the
    /// request (§2.4).
    public func stream(
        tag: String,
        payload: JSONValue,
        headers: [[String]] = [],
        traceId: String? = nil
    ) async throws -> AsyncThrowingStream<JSONValue, Error> {
        let id = allocateRequestId()
        let (stream, continuation) = AsyncThrowingStream<JSONValue, Error>.makeStream()
        // Registered before the `await send(...)` suspension point below, so
        // there is no window where a fast server response could arrive before
        // this entry exists.
        pending[id] = .stream(continuation)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.handleStreamTermination(id: id) }
        }
        do {
            try await send(.request(id: id, tag: tag, payload: payload, headers: headers, traceId: traceId))
        } catch {
            pending.removeValue(forKey: id)
            throw error
        }
        return stream
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
        case .stream(let continuation):
            continuation.finish(throwing: CancellationError())
        }
        try? await send(.interrupt(requestId: requestId))
    }

    /// Sends `{"_tag":"Eof"}` (§2.2). Rarely needed — the reference client
    /// never sends it — provided for forward compatibility.
    public func sendEof() async throws {
        try await send(.eof)
    }

    // MARK: Outbound framing

    private func send(_ frame: ClientFrame) async throws {
        guard let task else { throw T3Error.notConnected }
        let text: String
        do {
            text = try WireCoding.encodeFrameString(frame)
        } catch {
            throw T3Error.decoding("Failed to encode outgoing frame: \(error)")
        }
        do {
            try await task.send(.string(text))
        } catch {
            throw T3Error.transport("WebSocket send failed: \(error)")
        }
    }

    // MARK: Receive loop

    private func receiveLoop() async {
        guard let task else { return }
        while !Task.isCancelled {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
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
                // keep moving, even though this batch of values is lost.
                await ackLeniently(text)
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
    private func ackLeniently(_ text: String) async {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (object["_tag"] as? String) == "Chunk",
              let requestId = object["requestId"] as? String
        else { return }
        try? await send(.ack(requestId: requestId))
    }

    private func handle(_ frame: ServerFrame) async {
        switch frame {
        case let .chunk(requestId, values):
            await handleChunk(requestId: requestId, values: values)
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

    private func handleChunk(requestId: String, values: [JSONValue]) async {
        guard let entry = pending[requestId] else {
            // No (or no longer any) consumer for this id — still must Ack or
            // the server-side latch for this requestId never opens (§2.3).
            try? await send(.ack(requestId: requestId))
            return
        }
        switch entry {
        case .stream(let continuation):
            for value in values {
                continuation.yield(value)
            }
            do {
                try await send(.ack(requestId: requestId))
            } catch {
                pending.removeValue(forKey: requestId)
                continuation.finish(throwing: T3Error.transport("Failed to send Ack: \(error)"))
            }
        case .unary(let continuation):
            // A non-streaming RPC should never receive a Chunk; surface it as
            // a protocol violation rather than silently dropping the values.
            pending.removeValue(forKey: requestId)
            continuation.resume(throwing: T3Error.unexpectedFrame("Received Chunk for non-streaming request \(requestId)"))
            try? await send(.ack(requestId: requestId))
        }
    }

    private func handleExit(requestId: String, exit: ExitResult) {
        guard let entry = pending.removeValue(forKey: requestId) else { return }
        switch entry {
        case .unary(let continuation):
            switch exit {
            case let .success(value):
                continuation.resume(returning: value)
            case let .failure(failure):
                continuation.resume(throwing: T3Error.rpc(failure))
            }
        case .stream(let continuation):
            switch exit {
            case .success:
                continuation.finish()
            case let .failure(failure):
                continuation.finish(throwing: T3Error.rpc(failure))
            }
        }
    }

    /// Invoked when a stream's `AsyncThrowingStream` terminates from the
    /// consumer side (early `break`, enclosing `Task` cancellation, or normal
    /// producer-side finish). Only sends `Interrupt` if the request was still
    /// tracked as pending — i.e. the consumer walked away before a terminal
    /// `Exit` arrived (§2.4).
    private func handleStreamTermination(id: String) async {
        guard pending.removeValue(forKey: id) != nil else { return }
        try? await send(.interrupt(requestId: id))
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
                try await send(.ping)
            } catch {
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
        case .stream(let continuation):
            continuation.finish(throwing: error)
        }
    }

    private func failAllPending(with error: Error) {
        let entries = pending
        pending.removeAll()
        for entry in entries.values {
            switch entry {
            case .unary(let continuation):
                continuation.resume(throwing: error)
            case .stream(let continuation):
                continuation.finish(throwing: error)
            }
        }
    }

    private func teardown(state: ConnectionState, error: Error) async {
        receiveLoopTask?.cancel()
        pingLoopTask?.cancel()
        receiveLoopTask = nil
        pingLoopTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        failAllPending(with: error)
        currentState = state
    }

    private func allocateRequestId() -> String {
        defer { nextRequestId += 1 }
        return String(nextRequestId)
    }
}
