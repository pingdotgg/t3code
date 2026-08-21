import XCTest
@testable import T3Code

@MainActor
final class WebSocketRPCRaceTests: XCTestCase {
    func testResponseDeadlineStartsAfterConnectionAndSend() async throws {
        let connection = AutoReplyConnection()
        let connector = GatedConnector(connection: connection)
        let client = WebSocketRPCClient(
            connector: connector,
            connectionWaitTimeout: .seconds(1),
            responseTimeout: .milliseconds(40),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        let request = Task {
            try await client.request("server.repliesAfterConnect", as: JSONValue.self)
        }
        await connector.waitUntilConnectStarted()
        try await Task.sleep(for: .milliseconds(80))
        await connector.release()

        let response = try await request.value
        XCTAssertEqual(response, .object([:]))
        await client.stop()
    }

    func testSendFailureDropsDeadSocketAndReconnects() async throws {
        let failed = SendFailingConnection()
        let recovered = AutoReplyConnection()
        let connector = SequencedConnector(connections: [failed, recovered])
        let client = WebSocketRPCClient(
            connector: connector,
            connectionWaitTimeout: .seconds(2),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        do {
            _ = try await client.request("server.firstSendFails", as: JSONValue.self)
            XCTFail("A failed socket send must fail its unary request.")
        } catch let error as RPCError {
            guard case .disconnected = error else {
                await client.stop()
                return XCTFail("Unexpected RPC error: \(error)")
            }
        }

        await connector.waitUntilConnectionCount(2)
        let discardedReceiveCount = await failed.receiveCallCount()
        XCTAssertEqual(
            discardedReceiveCount,
            0,
            "Setup must not start receiving on a socket discarded by a queued send."
        )
        let isConnected = await client.isConnected()
        XCTAssertTrue(isConnected)
        let response = try await client.request("server.afterReconnect", as: JSONValue.self)
        XCTAssertEqual(response, .object([:]))
        await client.stop()
    }

    func testHungSendTimesOutAndReconnectsWithAFreshResponseWindow() async throws {
        let hung = HungSendConnection()
        let recovered = AutoReplyConnection()
        let connector = SequencedConnector(connections: [hung, recovered])
        let client = WebSocketRPCClient(
            connector: connector,
            connectionWaitTimeout: .seconds(2),
            responseTimeout: .milliseconds(40),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        let first = Task {
            try await client.request("server.sendNeverReturns", as: JSONValue.self)
        }
        await hung.waitUntilSending()
        do {
            _ = try await first.value
            XCTFail("A send that never completes must have an in-flight deadline.")
        } catch let error as RPCError {
            guard case .responseTimedOut = error else {
                await client.stop()
                return XCTFail("Unexpected RPC error: \(error)")
            }
        }

        await connector.waitUntilConnectionCount(2)
        let response = try await client.request("server.afterHungSend", as: JSONValue.self)
        XCTAssertEqual(response, .object([:]))
        await client.stop()
    }

    func testSentUnaryTimesOutAndLateTrafficCannotCompleteItTwice() async throws {
        let connection = DeadlineWebSocketConnection()
        let client = WebSocketRPCClient(
            connector: SequencedConnector(connections: [connection]),
            connectionWaitTimeout: .seconds(2),
            responseTimeout: .milliseconds(40),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        let first = Task {
            try await client.request("server.neverReplies", as: JSONValue.self)
        }
        await connection.waitUntilRequestCount(1)

        do {
            _ = try await first.value
            XCTFail("A sent unary request must have a response deadline.")
        } catch let error as RPCError {
            guard case .responseTimedOut = error else {
                await client.stop()
                return XCTFail("Unexpected RPC error: \(error)")
            }
        }
        await connection.waitUntilInterruptCount(1)

        // A response for the expired request is harmless, and the same socket
        // remains able to serve a subsequent unary call.
        try await connection.replyToRequest(at: 0)
        let second = try await client.request("server.replies", as: JSONValue.self)
        XCTAssertEqual(second, .object(["ok": .bool(true)]))
        await client.stop()
    }

    func testCancellingUnaryRemovesItAndInterruptsSentWork() async throws {
        let connection = DeadlineWebSocketConnection()
        let client = WebSocketRPCClient(
            connector: SequencedConnector(connections: [connection]),
            connectionWaitTimeout: .seconds(2),
            responseTimeout: .seconds(2),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        let request = Task {
            try await client.request("server.cancelled", as: JSONValue.self)
        }
        await connection.waitUntilRequestCount(1)
        request.cancel()

        do {
            _ = try await request.value
            XCTFail("Cancelling the caller must cancel its unary continuation.")
        } catch is CancellationError {}
        await connection.waitUntilInterruptCount(1)

        try await connection.replyToRequest(at: 0)
        let next = try await client.request("server.stillHealthy", as: JSONValue.self)
        XCTAssertEqual(next, .object(["ok": .bool(true)]))
        await client.stop()
    }

    func testRequestEnteringAlreadyCancelledNeverInstallsOrSends() async throws {
        let connection = AutoReplyConnection()
        let gate = RequestCancellationGate()
        let client = WebSocketRPCClient(
            connector: SequencedConnector(connections: [connection]),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )
        let request = Task {
            await gate.wait()
            return try await client.request("server.cancelledBeforeInstall", as: JSONValue.self)
        }
        await gate.waitUntilEntered()
        request.cancel()
        await gate.release()

        do {
            _ = try await request.value
            XCTFail("An already-cancelled request must fail before installation")
        } catch is CancellationError {}
        let sentRequestCount = await connection.sentRequestCount()
        XCTAssertEqual(sentRequestCount, 0)
        await client.stop()
    }

    func testDisconnectWhileUnarySendIsSuspendedFailsWithoutReplay() async throws {
        let first = SuspendedSendConnection()
        let second = AutoReplyConnection()
        let connector = SequencedConnector(connections: [first, second])
        let client = WebSocketRPCClient(
            connector: connector,
            connectionWaitTimeout: .seconds(2),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        await client.start()
        await first.waitUntilReceiving()

        let request = Task {
            do {
                let value = try await client.request(
                    "thread.rename",
                    as: JSONValue.self
                )
                return Result<JSONValue, Error>.success(value)
            } catch {
                return Result<JSONValue, Error>.failure(error)
            }
        }

        await first.waitUntilSending()
        await first.failReceive()

        let outcome = await request.value
        guard case let .failure(error) = outcome,
              case .disconnected = error as? RPCError
        else {
            await client.stop()
            await first.releaseSend()
            return XCTFail("An ambiguous unary send must fail as disconnected.")
        }

        await connector.waitUntilConnectionCount(2)
        let replayedRequestCount = await second.sentRequestCount()
        XCTAssertEqual(
            replayedRequestCount,
            0,
            "A unary request that crossed a broken socket must not be replayed."
        )

        await client.stop()
        await first.releaseSend()
    }

    func testStopDuringConnectClosesTheLateSocketWithoutPublishingIt() async {
        let lateConnection = CloseTrackingConnection()
        let connector = GatedConnector(connection: lateConnection)
        let client = WebSocketRPCClient(
            connector: connector,
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        await client.start()
        await connector.waitUntilConnectStarted()
        await client.stop()
        await connector.release()
        await lateConnection.waitUntilClosed()

        let isConnected = await client.isConnected()
        XCTAssertFalse(isConnected, "A socket returned after stop must never become active.")
        let receiveCount = await lateConnection.receiveCallCount()
        XCTAssertEqual(receiveCount, 0)
    }

    func testConnectionLoopDoesNotRetainReleasedClient() async {
        let connection = BlockingStopConnection()
        let connector = SequencedConnector(connections: [connection])
        var client: WebSocketRPCClient? = WebSocketRPCClient(
            connector: connector,
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )
        weak var releasedClient: WebSocketRPCClient?
        releasedClient = client

        await client?.start()
        await connection.waitUntilReceiving()
        client = nil

        XCTAssertNil(releasedClient, "The reconnect task must not own the RPC client.")
        await connection.waitUntilCloseStarted()
        await connection.releaseClose()
    }

    func testRestartWhileOldSocketClosesKeepsTheNewConnection() async throws {
        let closing = BlockingStopConnection()
        let recovered = AutoReplyConnection()
        let connector = SequencedConnector(connections: [closing, recovered])
        let client = WebSocketRPCClient(
            connector: connector,
            connectionWaitTimeout: .seconds(2),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        await client.start()
        await closing.waitUntilReceiving()

        let stop = Task { await client.stop() }
        await closing.waitUntilCloseStarted()
        let request = Task {
            try await client.request("server.afterRestart", as: JSONValue.self)
        }
        await connector.waitUntilConnectionCount(2)
        await closing.releaseClose()
        await stop.value

        let response = try await request.value
        XCTAssertEqual(response, .object([:]))
        let isConnected = await client.isConnected()
        XCTAssertTrue(isConnected, "Completing an old stop must not clear a newer socket.")
        await client.stop()
    }

    func testSubscriptionRoutesChunkBeforeSuspendedSendReturns() async throws {
        let connection = SubscriptionSendRaceConnection()
        let client = WebSocketRPCClient(
            connector: SequencedConnector(connections: [connection]),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        await client.start()
        await connection.waitUntilReceiveCount(1)
        let stream = await client.subscribe("thread.events", as: JSONValue.self)
        var iterator = stream.makeAsyncIterator()
        await connection.waitUntilRequestSuspended()
        await connection.waitUntilReceiveCount(2)
        await connection.releaseRequest()

        let value = try await iterator.next()
        XCTAssertEqual(value, .object(["event": .string("ready")]))
        await client.stop()
    }

    func testCancellingSubscriptionWhileSendIsSuspendedInterruptsWithoutResurrection() async {
        let connection = SubscriptionSendRaceConnection()
        let client = WebSocketRPCClient(
            connector: SequencedConnector(connections: [connection]),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        await client.start()
        await connection.waitUntilReceiveCount(1)
        var stream: AsyncThrowingStream<JSONValue, Error>? = await client.subscribe(
            "thread.events",
            as: JSONValue.self
        )
        let consumer = Task {
            var iterator = stream!.makeAsyncIterator()
            return try await iterator.next()
        }
        await connection.waitUntilRequestSuspended()
        consumer.cancel()
        stream = nil
        _ = try? await consumer.value

        let observedInterrupt = await connection.observesInterrupt()
        XCTAssertTrue(observedInterrupt)
        await connection.releaseRequest()
        await client.stop()
    }

    func testConnectionSetupAndSubscribeRaceSendsOneWireRequest() async throws {
        let connection = SetupSubscriptionRaceConnection()
        let client = WebSocketRPCClient(
            connector: SequencedConnector(connections: [connection]),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        let request = Task {
            try await client.request("server.setupBarrier", as: JSONValue.self)
        }
        await connection.waitUntilUnarySendSuspends()

        let stream = await client.subscribe("thread.events", as: JSONValue.self)
        await connection.waitUntilSubscriptionSendSuspends()
        await connection.releaseUnarySend()
        _ = try await request.value

        let subscriptionRequestCount = await connection.subscriptionRequestCount()
        XCTAssertEqual(
            subscriptionRequestCount,
            1,
            "Connection setup and subscribe() must not both own the same subscription send."
        )
        _ = stream
        await connection.releaseSubscriptionSend()
        await client.stop()
    }

    func testReconnectBackoffResetsOnlyAfterValidInboundTraffic() async {
        let connector = BackoffSequenceConnector()
        let recorder = BackoffRecorder()
        let client = WebSocketRPCClient(
            connector: connector,
            reconnectBackoff: { failureCount in
                recorder.record(failureCount)
                return .zero
            },
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        await client.start()
        await connector.waitUntilAttemptCount(4)

        XCTAssertEqual(
            recorder.values,
            [1, 2, 1],
            "Merely opening a socket must not reset backoff; a decoded server frame should."
        )
        await client.stop()
    }
}

private final class BackoffRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [Int] = []

    var values: [Int] {
        lock.withLock { recorded }
    }

    func record(_ value: Int) {
        lock.withLock { recorded.append(value) }
    }
}

private actor BackoffSequenceConnector: WebSocketConnecting {
    private let provenConnection = PongThenFailConnection()
    private let finalConnection = BlockingReceiveConnection()
    private var attemptCount = 0
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func connect(to _: URL) throws -> any WebSocketConnection {
        attemptCount += 1
        let ready = waiters.filter { attemptCount >= $0.0 }
        waiters.removeAll { attemptCount >= $0.0 }
        ready.forEach { $0.1.resume() }
        switch attemptCount {
        case 1, 2:
            throw URLError(.cannotConnectToHost)
        case 3:
            return provenConnection
        default:
            return finalConnection
        }
    }

    func waitUntilAttemptCount(_ count: Int) async {
        guard attemptCount < count else { return }
        await withCheckedContinuation { continuation in
            waiters.append((count, continuation))
        }
    }
}

private actor PongThenFailConnection: WebSocketConnection {
    private var sentPong = false

    func send(_: Data) {}

    func receive() throws -> Data {
        guard !sentPong else { throw URLError(.networkConnectionLost) }
        sentPong = true
        return try JSONEncoder.t3.encode(JSONValue.object(["_tag": .string("Pong")]))
    }

    func close() {}
}

private actor BlockingReceiveConnection: WebSocketConnection {
    private var continuation: CheckedContinuation<Data, Error>?

    func send(_: Data) {}

    func receive() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func close() {
        continuation?.resume(throwing: CancellationError())
        continuation = nil
    }
}

private actor SetupSubscriptionRaceConnection: WebSocketConnection {
    private var unaryRequestID: Int?
    private var unarySendContinuation: CheckedContinuation<Void, Never>?
    private var unaryWaiters: [CheckedContinuation<Void, Never>] = []
    private var subscriptionSends = 0
    private var subscriptionSendContinuation: CheckedContinuation<Void, Never>?
    private var subscriptionWaiters: [CheckedContinuation<Void, Never>] = []
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_ data: Data) async throws {
        let envelope = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard envelope["_tag"]?.stringValue == "Request",
              case let .number(rawID)? = envelope["id"],
              let requestID = Int(exactly: rawID)
        else { return }

        if envelope["tag"]?.stringValue == "server.setupBarrier" {
            unaryRequestID = requestID
            let waiters = unaryWaiters
            unaryWaiters.removeAll()
            waiters.forEach { $0.resume() }
            await withCheckedContinuation { unarySendContinuation = $0 }
            enqueue(try success(requestID: requestID))
        } else {
            subscriptionSends += 1
            let waiters = subscriptionWaiters
            subscriptionWaiters.removeAll()
            waiters.forEach { $0.resume() }
            await withCheckedContinuation { subscriptionSendContinuation = $0 }
        }
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty { return queuedResponses.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() {
        unarySendContinuation?.resume()
        unarySendContinuation = nil
        subscriptionSendContinuation?.resume()
        subscriptionSendContinuation = nil
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    func waitUntilUnarySendSuspends() async {
        guard unaryRequestID == nil else { return }
        await withCheckedContinuation { unaryWaiters.append($0) }
    }

    func waitUntilSubscriptionSendSuspends() async {
        guard subscriptionSends == 0 else { return }
        await withCheckedContinuation { subscriptionWaiters.append($0) }
    }

    func releaseUnarySend() {
        unarySendContinuation?.resume()
        unarySendContinuation = nil
    }

    func releaseSubscriptionSend() {
        subscriptionSendContinuation?.resume()
        subscriptionSendContinuation = nil
    }

    func subscriptionRequestCount() -> Int { subscriptionSends }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }

    private func success(requestID: Int) throws -> Data {
        try JSONEncoder.t3.encode(
            JSONValue.object([
                "_tag": .string("Exit"),
                "requestId": .number(Double(requestID)),
                "exit": .object([
                    "_tag": .string("Success"),
                    "value": .object([:]),
                ]),
            ])
        )
    }
}

private actor RequestCancellationGate {
    private var entered = false
    private var released = false
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        entered = true
        let waiters = entryWaiters
        entryWaiters.removeAll()
        waiters.forEach { $0.resume() }
        guard !released else { return }
        await withCheckedContinuation { continuation in
            releaseContinuation = continuation
        }
    }

    func waitUntilEntered() async {
        guard !entered else { return }
        await withCheckedContinuation { continuation in
            entryWaiters.append(continuation)
        }
    }

    func release() {
        released = true
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor SubscriptionSendRaceConnection: WebSocketConnection {
    private var requestID: Int?
    private var requestContinuation: CheckedContinuation<Void, Never>?
    private var requestWaiters: [CheckedContinuation<Void, Never>] = []
    private var receiveContinuation: CheckedContinuation<Data, Error>?
    private var receiveCount = 0
    private var receiveWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var queuedResponses: [Data] = []
    private var interruptCount = 0
    private var interruptWaiters: [CheckedContinuation<Void, Never>] = []

    func send(_ data: Data) async throws {
        let envelope = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        switch envelope["_tag"]?.stringValue {
        case "Request":
            guard requestID == nil,
                  case let .number(rawID)? = envelope["id"],
                  let id = Int(exactly: rawID) else { return }
            requestID = id
            enqueue(try chunk(requestID: id))
            let waiters = requestWaiters
            requestWaiters.removeAll()
            waiters.forEach { $0.resume() }
            await withCheckedContinuation { continuation in
                requestContinuation = continuation
            }
            enqueue(try exit(requestID: id))
        case "Interrupt":
            interruptCount += 1
            let waiters = interruptWaiters
            interruptWaiters.removeAll()
            waiters.forEach { $0.resume() }
        default:
            return
        }
    }

    func receive() async throws -> Data {
        receiveCount += 1
        let ready = receiveWaiters.filter { receiveCount >= $0.0 }
        receiveWaiters.removeAll { receiveCount >= $0.0 }
        ready.forEach { $0.1.resume() }
        if !queuedResponses.isEmpty { return queuedResponses.removeFirst() }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() {
        requestContinuation?.resume()
        requestContinuation = nil
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
    }

    func waitUntilRequestSuspended() async {
        guard requestID == nil else { return }
        await withCheckedContinuation { continuation in
            requestWaiters.append(continuation)
        }
    }

    func waitUntilReceiveCount(_ count: Int) async {
        guard receiveCount < count else { return }
        await withCheckedContinuation { continuation in
            receiveWaiters.append((count, continuation))
        }
    }

    func releaseRequest() {
        requestContinuation?.resume()
        requestContinuation = nil
    }

    func observesInterrupt() async -> Bool {
        if interruptCount > 0 { return true }
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                await self.waitUntilInterrupt()
                return true
            }
            group.addTask {
                try? await Task.sleep(for: .milliseconds(500))
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }

    private func waitUntilInterrupt() async {
        guard interruptCount == 0 else { return }
        await withCheckedContinuation { continuation in
            interruptWaiters.append(continuation)
        }
    }

    private func enqueue(_ data: Data) {
        if let receiveContinuation {
            self.receiveContinuation = nil
            receiveContinuation.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }

    private func chunk(requestID: Int) throws -> Data {
        try JSONEncoder.t3.encode(
            JSONValue.object([
                "_tag": .string("Chunk"),
                "requestId": .number(Double(requestID)),
                "values": .array([.object(["event": .string("ready")])]),
            ])
        )
    }

    private func exit(requestID: Int) throws -> Data {
        try JSONEncoder.t3.encode(
            JSONValue.object([
                "_tag": .string("Exit"),
                "requestId": .number(Double(requestID)),
                "exit": .object([
                    "_tag": .string("Success"),
                    "value": .null,
                ]),
            ])
        )
    }
}

private actor CloseTrackingConnection: WebSocketConnection {
    private var closed = false
    private var closeWaiters: [CheckedContinuation<Void, Never>] = []
    private var receives = 0

    func send(_: Data) {}

    func receive() throws -> Data {
        receives += 1
        throw URLError(.cannotLoadFromNetwork)
    }

    func close() {
        closed = true
        let waiters = closeWaiters
        closeWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    func waitUntilClosed() async {
        guard !closed else { return }
        await withCheckedContinuation { continuation in
            closeWaiters.append(continuation)
        }
    }

    func receiveCallCount() -> Int {
        receives
    }
}

private actor BlockingStopConnection: WebSocketConnection {
    private var receiveContinuation: CheckedContinuation<Data, Error>?
    private var receiveWaiters: [CheckedContinuation<Void, Never>] = []
    private var closeStarted = false
    private var closeReleased = false
    private var closeStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var closeReleaseWaiters: [CheckedContinuation<Void, Never>] = []

    func send(_: Data) throws {
        throw URLError(.networkConnectionLost)
    }

    func receive() async throws -> Data {
        let waiters = receiveWaiters
        receiveWaiters.removeAll()
        waiters.forEach { $0.resume() }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() async {
        if !closeStarted {
            closeStarted = true
            let waiters = closeStartWaiters
            closeStartWaiters.removeAll()
            waiters.forEach { $0.resume() }
        }
        if !closeReleased {
            await withCheckedContinuation { continuation in
                closeReleaseWaiters.append(continuation)
            }
        }
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
    }

    func waitUntilReceiving() async {
        guard receiveContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            receiveWaiters.append(continuation)
        }
    }

    func waitUntilCloseStarted() async {
        guard !closeStarted else { return }
        await withCheckedContinuation { continuation in
            closeStartWaiters.append(continuation)
        }
    }

    func releaseClose() {
        closeReleased = true
        let waiters = closeReleaseWaiters
        closeReleaseWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}

private actor DeadlineWebSocketConnection: WebSocketConnection {
    private var requestIDs: [Int] = []
    private var interruptIDs: [Int] = []
    private var requestWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var interruptWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_ data: Data) throws {
        let envelope = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        switch envelope["_tag"]?.stringValue {
        case "Request":
            guard case let .number(rawID)? = envelope["id"],
                  let requestID = Int(exactly: rawID) else {
                return
            }
            requestIDs.append(requestID)
            resumeRequestWaiters()
            if requestIDs.count > 1 {
                enqueue(try response(requestID: requestID))
            }
        case "Interrupt":
            guard case let .number(rawID)? = envelope["requestId"],
                  let requestID = Int(exactly: rawID) else {
                return
            }
            interruptIDs.append(requestID)
            resumeInterruptWaiters()
        default:
            break
        }
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    func waitUntilRequestCount(_ count: Int) async {
        guard requestIDs.count < count else { return }
        await withCheckedContinuation { continuation in
            requestWaiters.append((count, continuation))
        }
    }

    func waitUntilInterruptCount(_ count: Int) async {
        guard interruptIDs.count < count else { return }
        await withCheckedContinuation { continuation in
            interruptWaiters.append((count, continuation))
        }
    }

    func replyToRequest(at index: Int) throws {
        enqueue(try response(requestID: requestIDs[index]))
    }

    private func response(requestID: Int) throws -> Data {
        try JSONEncoder.t3.encode(
            JSONValue.object([
                "_tag": .string("Exit"),
                "requestId": .number(Double(requestID)),
                "exit": .object([
                    "_tag": .string("Success"),
                    "value": .object(["ok": .bool(true)]),
                ]),
            ])
        )
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }

    private func resumeRequestWaiters() {
        let ready = requestWaiters.filter { requestIDs.count >= $0.0 }
        requestWaiters.removeAll { requestIDs.count >= $0.0 }
        ready.forEach { $0.1.resume() }
    }

    private func resumeInterruptWaiters() {
        let ready = interruptWaiters.filter { interruptIDs.count >= $0.0 }
        interruptWaiters.removeAll { interruptIDs.count >= $0.0 }
        ready.forEach { $0.1.resume() }
    }
}

private actor SequencedConnector: WebSocketConnecting {
    private let connections: [any WebSocketConnection]
    private var nextIndex = 0
    private var countWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    init(connections: [any WebSocketConnection]) {
        self.connections = connections
    }

    func connect(to _: URL) throws -> any WebSocketConnection {
        guard nextIndex < connections.count else {
            throw URLError(.cannotConnectToHost)
        }
        let connection = connections[nextIndex]
        nextIndex += 1
        let completed = countWaiters.filter { nextIndex >= $0.0 }
        countWaiters.removeAll { nextIndex >= $0.0 }
        completed.forEach { $0.1.resume() }
        return connection
    }

    func waitUntilConnectionCount(_ count: Int) async {
        guard nextIndex < count else { return }
        await withCheckedContinuation { continuation in
            countWaiters.append((count, continuation))
        }
    }
}

private actor GatedConnector: WebSocketConnecting {
    private let connection: any WebSocketConnection
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var connectWaiters: [CheckedContinuation<Void, Never>] = []
    private var connectStarted = false
    private var released = false

    init(connection: any WebSocketConnection) {
        self.connection = connection
    }

    func connect(to _: URL) async -> any WebSocketConnection {
        connectStarted = true
        let waiters = connectWaiters
        connectWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if !released {
            await withCheckedContinuation { continuation in
                releaseContinuation = continuation
            }
        }
        return connection
    }

    func waitUntilConnectStarted() async {
        guard !connectStarted else { return }
        await withCheckedContinuation { continuation in
            connectWaiters.append(continuation)
        }
    }

    func release() {
        released = true
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor SendFailingConnection: WebSocketConnection {
    private var closed = false
    private var receives = 0
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_: Data) throws {
        throw URLError(.networkConnectionLost)
    }

    func receive() async throws -> Data {
        receives += 1
        if closed { throw URLError(.networkConnectionLost) }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        closed = true
        receiver?.resume(throwing: URLError(.networkConnectionLost))
        receiver = nil
    }

    func receiveCallCount() -> Int {
        receives
    }
}

private actor HungSendConnection: WebSocketConnection {
    private var closed = false
    private var sendContinuation: CheckedContinuation<Void, Error>?
    private var sendWaiters: [CheckedContinuation<Void, Never>] = []

    func send(_: Data) async throws {
        let waiters = sendWaiters
        sendWaiters.removeAll()
        waiters.forEach { $0.resume() }
        try await withCheckedThrowingContinuation { continuation in
            sendContinuation = continuation
        }
    }

    func receive() throws -> Data {
        throw URLError(closed ? .networkConnectionLost : .cannotLoadFromNetwork)
    }

    func close() {
        closed = true
        sendContinuation?.resume(throwing: URLError(.networkConnectionLost))
        sendContinuation = nil
    }

    func waitUntilSending() async {
        guard sendContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            sendWaiters.append(continuation)
        }
    }
}

private actor SuspendedSendConnection: WebSocketConnection {
    private var sendContinuation: CheckedContinuation<Void, Error>?
    private var receiveContinuation: CheckedContinuation<Data, Error>?
    private var sendWaiters: [CheckedContinuation<Void, Never>] = []
    private var receiveWaiters: [CheckedContinuation<Void, Never>] = []

    func send(_: Data) async throws {
        let waiters = sendWaiters
        sendWaiters.removeAll()
        waiters.forEach { $0.resume() }
        try await withCheckedThrowingContinuation { continuation in
            sendContinuation = continuation
        }
    }

    func receive() async throws -> Data {
        let waiters = receiveWaiters
        receiveWaiters.removeAll()
        waiters.forEach { $0.resume() }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() {
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
    }

    func waitUntilSending() async {
        guard sendContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            sendWaiters.append(continuation)
        }
    }

    func waitUntilReceiving() async {
        guard receiveContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            receiveWaiters.append(continuation)
        }
    }

    func failReceive() {
        receiveContinuation?.resume(throwing: URLError(.networkConnectionLost))
        receiveContinuation = nil
    }

    func releaseSend() {
        sendContinuation?.resume()
        sendContinuation = nil
    }
}

private actor AutoReplyConnection: WebSocketConnection {
    private var sentRequests = 0
    private var queuedResponses: [Data] = []
    private var receiveContinuation: CheckedContinuation<Data, Error>?

    func send(_ data: Data) throws {
        sentRequests += 1
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard case let .number(requestID) = request["id"] else { return }
        let response = JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(requestID),
            "exit": .object([
                "_tag": .string("Success"),
                "value": .object([:]),
            ]),
        ])
        enqueue(try JSONEncoder.t3.encode(response))
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() {
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
    }

    func sentRequestCount() -> Int {
        sentRequests
    }

    private func enqueue(_ data: Data) {
        if let receiveContinuation {
            self.receiveContinuation = nil
            receiveContinuation.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }
}
