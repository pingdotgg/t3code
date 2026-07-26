// RpcCancellationRegressionTests.swift
// Regressions for two cancellation leaks: a cancelled unary `request` used to
// park its awaiter forever (no resume, no `Interrupt` on the wire, pending
// entry retained until the socket died), and `clearActiveTasks()` used to skip
// paused tasks because they are deliberately absent from the active-id set.

import Foundation
import Testing

@testable import T3Kit

// MARK: - In-memory WebSocket double

/// Minimal `RpcWebSocket` double: records C→S frames, never delivers S→C ones
/// (these tests only care about what cancellation writes and resumes).
/// `@unchecked Sendable`: all mutable state is guarded by `lock`.
private final class CancelMockWebSocket: RpcWebSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [String] = []
    private var receiveWaiter: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var closed = false

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let waiter: CheckedContinuation<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
            closed = true
            let waiter = receiveWaiter
            receiveWaiter = nil
            return waiter
        }
        waiter?.resume(throwing: CancellationError())
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        if case .string(let text) = message {
            lock.withLock { sent.append(text) }
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            let isClosed = lock.withLock { () -> Bool in
                if closed { return true }
                receiveWaiter = continuation
                return false
            }
            if isClosed { continuation.resume(throwing: CancellationError()) }
        }
    }

    func sentFrames() -> [String] {
        lock.withLock { sent }
    }
}

/// `Request` carries its id under `id`; `Ack`/`Interrupt` use `requestId`
/// (WireEnvelope §2.2), so normalise both onto one field for matching.
private func frameTags(_ frames: [String]) -> [(tag: String, requestId: String?)] {
    frames.compactMap { text in
        guard let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let tag = object["_tag"] as? String
        else { return nil }
        return (tag, (object["requestId"] as? String) ?? (object["id"] as? String))
    }
}

/// Polls `condition` until true or the deadline elapses, so the tests never
/// depend on a fixed wall-clock sleep.
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

private let cancellationTestURL = URL(string: "wss://example.invalid/ws")!

// MARK: - Unary cancellation (§2.4)

@Suite("RpcConnection unary cancellation")
struct RpcConnectionUnaryCancellationTests {

    @Test("cancelling a unary request resumes the awaiter and sends Interrupt")
    func cancelledRequestInterruptsAndThrows() async throws {
        let mock = CancelMockWebSocket()
        let conn = RpcConnection(url: cancellationTestURL)
        await conn.connect(socket: mock)

        // No `Exit` is ever fed, so the awaiter can only be freed by
        // cancellation — which is precisely what used to strand it.
        let task = Task { try await conn.request(tag: "test.unary", payload: .object([:])) }

        let sawRequest = await waitUntil {
            frameTags(mock.sentFrames()).contains { $0.tag == "Request" && $0.requestId == "0" }
        }
        #expect(sawRequest)

        task.cancel()

        var thrown: Error?
        do {
            _ = try await task.value
        } catch {
            thrown = error
        }
        #expect(thrown is CancellationError)

        let sawInterrupt = await waitUntil {
            frameTags(mock.sentFrames()).contains { $0.tag == "Interrupt" && $0.requestId == "0" }
        }
        #expect(sawInterrupt)

        await conn.disconnect()
    }

    @Test("a cancelled request releases its pending entry so ids are not leaked")
    func cancelledRequestDropsPendingEntry() async throws {
        let mock = CancelMockWebSocket()
        let conn = RpcConnection(url: cancellationTestURL)
        await conn.connect(socket: mock)

        let task = Task { try await conn.request(tag: "test.unary", payload: .object([:])) }
        _ = await waitUntil {
            frameTags(mock.sentFrames()).contains { $0.tag == "Request" && $0.requestId == "0" }
        }
        task.cancel()
        _ = try? await task.value

        // `interrupt` on the same id must now be a no-op (entry already gone),
        // i.e. exactly one Interrupt frame for "0" — a second would mean the
        // cancellation handler left the registry dirty.
        _ = await waitUntil {
            frameTags(mock.sentFrames()).contains { $0.tag == "Interrupt" && $0.requestId == "0" }
        }
        await conn.interrupt(requestId: "0")
        let interrupts = await waitUntil(timeout: .milliseconds(200)) {
            frameTags(mock.sentFrames())
                .filter { $0.tag == "Interrupt" && $0.requestId == "0" }
                .count > 1
        }
        #expect(!interrupts)

        await conn.disconnect()
    }
}

// MARK: - clearActiveTasks sweeps paused tasks

@Suite("Subagent task clear sweeps paused tasks")
struct SubagentTaskClearPausedTests {
    private func activity(
        id: String, kind: String, at: String, payload: JSONValue
    ) -> OrchestrationThreadActivity {
        OrchestrationThreadActivity(
            id: id, tone: .info, kind: kind, summary: kind, payload: payload,
            sequence: nil, createdAt: at)
    }

    @Test("a paused task is stopped and re-emitted by clearActiveTasks")
    func clearStopsPausedTask() throws {
        var state = T3SubagentTaskActivityState()

        let start = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object(["taskId": .string("task-paused")]))
        let paused = activity(
            id: "act-paused", kind: ActivityKind.taskUpdated,
            at: "2026-07-04T10:00:02.000Z",
            payload: .object([
                "taskId": .string("task-paused"),
                "status": .string("paused"),
            ]))
        _ = state.apply(activity: start, at: WireDate.parse(start.createdAt)!)
        let pausedItem = state.apply(activity: paused, at: WireDate.parse(paused.createdAt)!)
        #expect(pausedItem?.state == .paused)
        // Paused deliberately leaves the active set — the old sweep keyed off
        // that set and therefore never saw this task.
        #expect(state.activeTaskIDs.isEmpty)

        let stopped = state.clearActiveTasks()
        #expect(stopped.map(\.taskId) == ["task-paused"])
        #expect(stopped.first?.state == .stopped)
        #expect(stopped.first?.completedAt != nil)
        #expect(state.items.first?.state == .stopped)
    }

    @Test("clearActiveTasks leaves already-terminal tasks untouched")
    func clearSkipsTerminalTasks() throws {
        var state = T3SubagentTaskActivityState()

        let start = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object(["taskId": .string("task-done")]))
        let completed = activity(
            id: "act-complete", kind: ActivityKind.taskCompleted,
            at: "2026-07-04T10:00:05.000Z",
            payload: .object([
                "taskId": .string("task-done"),
                "status": .string("completed"),
            ]))
        _ = state.apply(activity: start, at: WireDate.parse(start.createdAt)!)
        let finished = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)
        #expect(finished?.state == .completed)

        #expect(state.clearActiveTasks().isEmpty)
        #expect(state.items.first?.state == .completed)
    }
}
