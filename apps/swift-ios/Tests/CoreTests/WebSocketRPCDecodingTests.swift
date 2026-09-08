import Foundation
import Testing
@testable import T3Code

@Suite("WebSocket Chunk decoding")
struct WebSocketRPCDecodingTests {
    @Test
    func malformedMiddleValueKeepsItsPrefixAndHealthySibling() async throws {
        let socket = ChunkDecodingSocket()
        let rpc = makeClient(socket)
        var sent = socket.sent.makeAsyncIterator()
        let numbers = await rpc.subscribe("numbers", as: Int.self)
        let numberID = try await nextRequestID(&sent)
        let strings = await rpc.subscribe("strings", as: String.self)
        let stringID = try await nextRequestID(&sent)

        try await socket.chunk(numberID, values: [.number(1), .string("invalid"), .number(3)])
        let interrupt = try await nextFrame(&sent)
        #expect(interrupt["_tag"] == .string("Interrupt"))
        #expect(interrupt["requestId"] == numberID)
        var numberEvents = numbers.makeAsyncIterator()
        let prefix = try await numberEvents.next()
        #expect(prefix == 1)
        do {
            _ = try await numberEvents.next()
            Issue.record("The malformed middle value must terminate this subscription.")
        } catch is DecodingError {}

        // A late chunk for the failed request cannot leak into its sibling.
        try await socket.chunk(numberID, values: [.string("late")])
        try await socket.chunk(stringID, values: [.string("healthy")])
        let ack = try await nextFrame(&sent)
        #expect(ack["_tag"] == .string("Ack"))
        #expect(ack["requestId"] == stringID)
        var stringEvents = strings.makeAsyncIterator()
        let healthy = try await stringEvents.next()
        #expect(healthy == "healthy")
        let acknowledgements = await socket.acknowledgements
        #expect(acknowledgements == [stringID])
        await rpc.stop()
    }

    @Test
    func overflowStopsBeforeLaterMalformedValueWithoutAcknowledging() async throws {
        let socket = ChunkDecodingSocket()
        let rpc = makeClient(socket, bufferLimit: 2)
        var sent = socket.sent.makeAsyncIterator()
        let stream = await rpc.subscribe("numbers", reconnect: false, as: Int.self)
        let id = try await nextRequestID(&sent)
        try await socket.chunk(id, values: [.number(1), .number(2), .number(3), .string("invalid")])
        await socket.waitUntilClosed()

        var events = stream.makeAsyncIterator()
        let first = try await events.next()
        let second = try await events.next()
        #expect(first == 1)
        #expect(second == 2)
        do {
            _ = try await events.next()
            Issue.record("Overflow must terminate a one-shot subscription.")
        } catch let error as RPCError {
            guard case .protocolViolation = error else { throw error }
        }
        let acknowledgements = await socket.acknowledgements
        #expect(acknowledgements.isEmpty)
        await rpc.stop()
    }

    @Test
    func emptyChunksAcknowledgeAndUnknownRequestsStayIsolated() async throws {
        let socket = ChunkDecodingSocket()
        let rpc = makeClient(socket)
        var sent = socket.sent.makeAsyncIterator()
        let stream = await rpc.subscribe("numbers", as: Int.self)
        let id = try await nextRequestID(&sent)
        for values in [nil, JSONValue.null, .array([])] {
            var envelope: [String: JSONValue] = ["_tag": .string("Chunk"), "requestId": id]
            envelope["values"] = values
            try await socket.feed(.object(envelope))
            let ack = try await nextFrame(&sent)
            #expect(ack["_tag"] == .string("Ack"))
            #expect(ack["requestId"] == id)
        }
        try await socket.chunk(.number(999_999), values: [.string("unknown request")])
        try await socket.chunk(id, values: [.number(7)])
        let ack = try await nextFrame(&sent)
        #expect(ack["_tag"] == .string("Ack"))
        #expect(ack["requestId"] == id)
        var events = stream.makeAsyncIterator()
        let value = try await events.next()
        #expect(value == 7)
        let acknowledgements = await socket.acknowledgements
        #expect(acknowledgements == Array(repeating: id, count: 4))
        await rpc.stop()
    }

    @Test
    func malformedChunkEnvelopeFailsTheSocketBeforeYielding() async throws {
        for values in [JSONValue.string("not an array"), .object(["0": .number(1)])] {
            let socket = ChunkDecodingSocket()
            let rpc = makeClient(socket)
            var sent = socket.sent.makeAsyncIterator()
            let stream = await rpc.subscribe("numbers", reconnect: false, as: Int.self)
            let id = try await nextRequestID(&sent)
            try await socket.feed(.object(["_tag": .string("Chunk"), "requestId": id, "values": values]))
            await socket.waitUntilClosed()
            var events = stream.makeAsyncIterator()
            do {
                _ = try await events.next()
                Issue.record("Invalid array framing must fail the socket.")
            } catch let error as RPCError {
                guard case .protocolViolation = error else { throw error }
            }
            let acknowledgements = await socket.acknowledgements
            #expect(acknowledgements.isEmpty)
            await rpc.stop()
        }
    }

    @Test
    func snapshotFixtureAndFollowingEventKeepWireOrder() async throws {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Fixtures/Wire/thread-stream-snapshot.json")
        let data = try Data(contentsOf: fixture)
        let raw = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        let expected = try JSONDecoder.t3.decode(ThreadStreamItem.self, from: data)
        let socket = ChunkDecodingSocket()
        let rpc = makeClient(socket)
        var sent = socket.sent.makeAsyncIterator()
        let stream = await rpc.subscribe("orchestration.subscribeThread", as: ThreadStreamItem.self)
        let id = try await nextRequestID(&sent)
        try await socket.chunk(id, values: [raw, .object(["kind": .string("synchronized")])])
        let ack = try await nextFrame(&sent)
        #expect(ack["_tag"] == .string("Ack"))
        var events = stream.makeAsyncIterator()
        let first = try await events.next()
        let second = try await events.next()
        guard case let .snapshot(actual) = first, case let .snapshot(expected) = expected,
              case .synchronized = second else {
            Issue.record("Snapshot and completion marker must retain their order.")
            await rpc.stop()
            return
        }
        #expect(actual == expected)
        await rpc.stop()
    }

    @Test
    func malformedBatchKeepsCompletedBatchesAndDoesNotAcknowledge() async throws {
        let socket = ChunkDecodingSocket()
        let rpc = makeClient(socket)
        var sent = socket.sent.makeAsyncIterator()
        let stream = await rpc.subscribeBatches("numbers", as: Int.self)
        let id = try await nextRequestID(&sent)
        let prefix = (0..<64).map { JSONValue.number(Double($0)) }
        try await socket.chunk(id, values: prefix + [.number(64), .string("invalid")])
        let interrupt = try await nextFrame(&sent)
        #expect(interrupt["_tag"] == .string("Interrupt"))
        var events = stream.makeAsyncIterator()
        let first = try await events.next()
        #expect(first == Array(0..<64))
        do {
            _ = try await events.next()
            Issue.record("Malformed batch must end the subscription.")
        } catch is DecodingError {}
        let acknowledgements = await socket.acknowledgements
        #expect(acknowledgements.isEmpty)
        await rpc.stop()
    }

    private func makeClient(_ socket: ChunkDecodingSocket, bufferLimit: Int = 128) -> WebSocketRPCClient {
        WebSocketRPCClient(
            connector: ChunkDecodingConnector(socket: socket),
            subscriptionBufferLimit: bufferLimit,
            reconnectBackoff: { _ in .seconds(60) },
            endpointProvider: { URL(string: "wss://fixture.example/ws")! }
        )
    }

    private func nextFrame(_ frames: inout AsyncStream<JSONValue>.Iterator) async throws -> JSONValue {
        try #require(await frames.next())
    }

    private func nextRequestID(_ frames: inout AsyncStream<JSONValue>.Iterator) async throws -> JSONValue {
        let frame = try await nextFrame(&frames)
        #expect(frame["_tag"] == .string("Request"))
        return try #require(frame["id"])
    }
}

private struct ChunkDecodingConnector: WebSocketConnecting {
    let socket: ChunkDecodingSocket
    func connect(to _: URL) -> any WebSocketConnection { socket }
}

private actor ChunkDecodingSocket: WebSocketConnection {
    nonisolated let sent: AsyncStream<JSONValue>
    private let sender: AsyncStream<JSONValue>.Continuation
    private var queued: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var closed = false
    private var closeWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var acknowledgements: [JSONValue] = []

    init() { (sent, sender) = AsyncStream.makeStream() }

    func send(_ data: Data) throws {
        let value = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if value["_tag"] == .string("Ack"), let id = value["requestId"] {
            acknowledgements.append(id)
        }
        sender.yield(value)
    }

    func receive() async throws -> Data {
        if !queued.isEmpty { return queued.removeFirst() }
        if closed { throw RPCError.disconnected }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func feed(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queued.append(data)
        }
    }

    func chunk(_ requestID: JSONValue, values: [JSONValue]) throws {
        try feed(.object(["_tag": .string("Chunk"), "requestId": requestID, "values": .array(values)]))
    }

    func close() {
        closed = true
        receiver?.resume(throwing: RPCError.disconnected)
        receiver = nil
        let waiters = closeWaiters
        closeWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    func waitUntilClosed() async {
        if closed { return }
        await withCheckedContinuation { closeWaiters.append($0) }
    }
}
