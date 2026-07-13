// RpcConnectionTests.swift
// Actor-level protocol tests for the two RpcConnection fixes, driven through
// the internal `connect(socket:)` seam with an in-memory `MockWebSocket` (no
// network): outbound frame ordering (§2 wire order == call order) and real
// per-chunk Ack backpressure tied to consumer draining (§2.3).

import Foundation
import Testing

@testable import T3Kit

// MARK: - In-memory WebSocket double

/// Records every C→S frame (in send order) and lets the test feed S→C frames.
/// `@unchecked Sendable`: all mutable state is guarded by `lock`.
private final class MockWebSocket: RpcWebSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [String] = []
    private var inbox: [URLSessionWebSocketTask.Message] = []
    private var receiveWaiter: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var closed = false

    /// When true, every `send` parks until `openGate()` — used to force frames
    /// to queue behind an in-flight send so wire order is observable.
    private var gateOpen: Bool
    private var gateWaiters: [CheckedContinuation<Void, Never>] = []

    init(blockSends: Bool = false) { self.gateOpen = !blockSends }

    // RpcWebSocket

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let (waiter, gated): (CheckedContinuation<URLSessionWebSocketTask.Message, Error>?, [CheckedContinuation<Void, Never>]) = lock.withLock {
            closed = true
            let waiter = receiveWaiter
            receiveWaiter = nil
            let gated = gateWaiters
            gateWaiters = []
            gateOpen = true
            return (waiter, gated)
        }
        waiter?.resume(throwing: CancellationError())
        gated.forEach { $0.resume() }
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        if case .string(let text) = message {
            lock.withLock { sent.append(text) }
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let open = lock.withLock { () -> Bool in
                if gateOpen { return true }
                gateWaiters.append(continuation)
                return false
            }
            if open { continuation.resume() }
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            enum Action { case closed; case message(URLSessionWebSocketTask.Message); case park }
            let action = lock.withLock { () -> Action in
                if closed { return .closed }
                if !inbox.isEmpty { return .message(inbox.removeFirst()) }
                receiveWaiter = continuation
                return .park
            }
            switch action {
            case .closed: continuation.resume(throwing: CancellationError())
            case .message(let message): continuation.resume(returning: message)
            case .park: break
            }
        }
    }

    // Test surface

    func feed(_ text: String) {
        let waiter: CheckedContinuation<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
            if let waiter = receiveWaiter {
                receiveWaiter = nil
                return waiter
            }
            inbox.append(.string(text))
            return nil
        }
        waiter?.resume(returning: .string(text))
    }

    func openGate() {
        let gated: [CheckedContinuation<Void, Never>] = lock.withLock {
            gateOpen = true
            let gated = gateWaiters
            gateWaiters = []
            return gated
        }
        gated.forEach { $0.resume() }
    }

    func closeGate() {
        lock.withLock { gateOpen = false }
    }

    func sentFrames() -> [String] {
        lock.withLock { sent }
    }
}

// MARK: - Frame inspection helpers

private struct DecodedFrame {
    let tag: String
    let requestId: String?
    let requestTag: String?
}

private func inspect(_ text: String) -> DecodedFrame? {
    guard let data = text.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let tag = object["_tag"] as? String
    else { return nil }
    return DecodedFrame(
        tag: tag,
        requestId: object["requestId"] as? String,
        requestTag: object["tag"] as? String)
}

private func inspectAll(_ frames: [String]) -> [DecodedFrame] {
    frames.compactMap(inspect)
}

/// Polls `condition` until true or the deadline elapses. Returns whether it
/// became true. Avoids wall-clock flakiness by re-checking on a short cadence.
private func waitUntil(
    timeout: Duration = .seconds(3),
    _ condition: @Sendable () -> Bool
) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}

private let dummyURL = URL(string: "wss://example.invalid/ws")!

// MARK: - Backpressure (§2.3)

@Suite("RpcConnection backpressure")
struct RpcConnectionBackpressureTests {

    @Test("a chunk's Ack is withheld until the consumer drains the whole chunk")
    func ackDeferredUntilChunkDrained() async throws {
        let mock = MockWebSocket()
        let conn = RpcConnection(url: dummyURL)
        await conn.connect(socket: mock)

        // id "0": the initial Request is sent synchronously (awaited).
        let stream = try await conn.stream(tag: "test.stream", payload: .object([:]))
        var iterator = stream.makeAsyncIterator()

        // One chunk carrying two values.
        mock.feed(#"{"_tag":"Chunk","requestId":"0","values":[{"n":1},{"n":2}]}"#)

        // Pull the first value: not the last of the chunk, so NO Ack yet — the
        // server stays blocked, which is the backpressure.
        let first = try await iterator.next()
        #expect(first?["n"]?.intValue == 1)
        let acksAfterFirst = inspectAll(mock.sentFrames())
            .filter { $0.tag == "Ack" && $0.requestId == "0" }
        #expect(acksAfterFirst.isEmpty)

        // Pull the second (last) value: draining the chunk releases exactly one
        // Ack for requestId "0".
        let second = try await iterator.next()
        #expect(second?["n"]?.intValue == 2)
        let acksAfterSecond = inspectAll(mock.sentFrames())
            .filter { $0.tag == "Ack" && $0.requestId == "0" }
        #expect(acksAfterSecond.count == 1)

        // Terminal Exit ends the stream.
        mock.feed(#"{"_tag":"Exit","requestId":"0","exit":{"_tag":"Success","value":{}}}"#)
        let terminal = try await iterator.next()
        #expect(terminal == nil)

        await conn.disconnect()
    }

    @Test("an empty chunk is Ack'd immediately (nothing to drain)")
    func emptyChunkAckedImmediately() async throws {
        let mock = MockWebSocket()
        let conn = RpcConnection(url: dummyURL)
        await conn.connect(socket: mock)

        _ = try await conn.stream(tag: "test.stream", payload: .object([:]))
        mock.feed(#"{"_tag":"Chunk","requestId":"0","values":[]}"#)

        let acked = await waitUntil {
            inspectAll(mock.sentFrames()).contains { $0.tag == "Ack" && $0.requestId == "0" }
        }
        #expect(acked)

        await conn.disconnect()
    }
}

// MARK: - Outbound frame ordering (§2)

@Suite("RpcConnection outbound ordering")
struct RpcConnectionOrderingTests {

    @Test("frames enqueued in call order reach the wire in that order via the single FIFO writer")
    func wireOrderMatchesCallOrder() async throws {
        let mock = MockWebSocket()
        let conn = RpcConnection(url: dummyURL)
        await conn.connect(socket: mock)

        // Three active streams (ids "0","1","2"); their initial Requests send
        // immediately while the gate is open.
        _ = try await conn.stream(tag: "s0", payload: .object([:]))
        _ = try await conn.stream(tag: "s1", payload: .object([:]))
        _ = try await conn.stream(tag: "s2", payload: .object([:]))

        // Now stall the writer on an in-flight Eof so the frames enqueued next
        // must queue behind it — exactly the race the old per-call
        // `Task { send }` for `request()` could reorder.
        mock.closeGate()
        let eofTask = Task { try? await conn.sendEof() }
        let sawEof = await waitUntil {
            inspectAll(mock.sentFrames()).contains { $0.tag == "Eof" }
        }
        #expect(sawEof)

        // `interrupt` on the (known) stream ids enqueues an Interrupt frame
        // synchronously and returns without awaiting the send. Sequential awaits
        // on this one task therefore fix the enqueue order deterministically.
        await conn.interrupt(requestId: "2")
        await conn.interrupt(requestId: "0")
        await conn.interrupt(requestId: "1")

        // Release the gate and let the single writer drain the FIFO.
        mock.openGate()

        let interruptOrder: @Sendable () -> [String] = {
            inspectAll(mock.sentFrames())
                .filter { $0.tag == "Interrupt" }
                .compactMap(\.requestId)
        }
        let drained = await waitUntil { interruptOrder().count >= 3 }
        #expect(drained)

        // Wire order must equal enqueue order, NOT numeric id order.
        #expect(interruptOrder() == ["2", "0", "1"])

        eofTask.cancel()
        await conn.disconnect()
    }
}
