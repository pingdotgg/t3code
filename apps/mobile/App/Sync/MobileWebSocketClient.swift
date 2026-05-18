import Foundation
import T3MobileProtocol

actor MobileWebSocketClient {
    private let session: any MobileWebSocketSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private var readerTask: Task<Void, Never>?
    private var pendingMessages: [String: CheckedContinuation<MobileServerMessage, Error>] = [:]
    private var bufferedMessages: [String: [MobileServerMessage]] = [:]
    private var terminalError: Error?
    private var requestCount = 0
    private var replayRequestCount = 0
    private var turnDiffRequestCount = 0
    private var fullThreadDiffRequestCount = 0
    private var dispatchRequestCount = 0
    private let maxBufferedMessagesPerID: Int

    init(
        session: any MobileWebSocketSession,
        decoder: JSONDecoder = JSONDecoder(),
        encoder: JSONEncoder = JSONEncoder(),
        maxBufferedMessagesPerID: Int = 128
    ) {
        self.session = session
        self.decoder = decoder
        self.encoder = encoder
        self.maxBufferedMessagesPerID = maxBufferedMessagesPerID
    }

    func hello(capabilities: [MobileClientCapability] = mobileV1ClientCapabilities) async throws -> MobileHelloResponse {
        let id = "hello-1"
        try await send(MobileHelloMessage(id: id, capabilities: capabilities))
        let message = try await receiveMessage(id: id)
        switch message {
        case let .hello(response):
            return response
        case let .error(error):
            throw MobileSyncError.protocolError(code: error.error.code, message: error.error.message)
        default:
            throw MobileSyncError.unexpectedMessage("Expected mobile hello response.")
        }
    }

    func subscribeShell() async throws -> MobileStreamMessage {
        let id = nextRequestID(prefix: "shell")
        return try await subscribeShell(id: id)
    }

    func openShellSubscription() async throws -> MobileStreamSubscription {
        let id = nextRequestID(prefix: "shell")
        return try await MobileStreamSubscription(id: id, initial: subscribeShell(id: id))
    }

    private func subscribeShell(id: String) async throws -> MobileStreamMessage {
        try await send(
            MobileRequestMessage(
                id: id,
                method: "orchestration.subscribeShell",
                payload: EmptyPayload()
            )
        )
        return try await receiveStream(id: id)
    }

    func subscribeThread(threadID: String) async throws -> MobileStreamMessage {
        let id = nextRequestID(prefix: "thread")
        return try await subscribeThread(threadID: threadID, id: id)
    }

    func openThreadSubscription(threadID: String) async throws -> MobileStreamSubscription {
        let id = nextRequestID(prefix: "thread")
        return try await MobileStreamSubscription(id: id, initial: subscribeThread(threadID: threadID, id: id))
    }

    private func subscribeThread(threadID: String, id: String) async throws -> MobileStreamMessage {
        try await send(
            MobileRequestMessage(
                id: id,
                method: "orchestration.subscribeThread",
                payload: SubscribeThreadPayload(threadId: threadID)
            )
        )
        return try await receiveStream(id: id)
    }

    func nextStream(subscription: MobileStreamSubscription) async throws -> MobileStreamMessage {
        try await receiveStream(id: subscription.id)
    }

    func replay(fromSequenceExclusive: Int) async throws -> MobileReplayEnvelope {
        replayRequestCount += 1
        let id = "replay-\(replayRequestCount)"
        try await send(
            MobileRequestMessage(
                id: id,
                method: "orchestration.replayEvents",
                payload: ReplayEventsPayload(fromSequenceExclusive: fromSequenceExclusive)
            )
        )
        let response = try await receiveResponse(id: id)
        guard case let .replay(envelope) = response.payload else {
            throw MobileSyncError.unexpectedMessage("Expected mobile replay envelope.")
        }
        return envelope
    }

    func getTurnDiff(threadID: String, fromTurnCount: Int, toTurnCount: Int) async throws -> MobileTurnDiff {
        turnDiffRequestCount += 1
        let id = "diff-\(turnDiffRequestCount)"
        try await send(
            MobileRequestMessage(
                id: id,
                method: "orchestration.getTurnDiff",
                payload: TurnDiffPayload(
                    threadId: threadID,
                    fromTurnCount: fromTurnCount,
                    toTurnCount: toTurnCount
                )
            )
        )
        return try await receiveTurnDiff(id: id)
    }

    func getFullThreadDiff(threadID: String, toTurnCount: Int) async throws -> MobileTurnDiff {
        fullThreadDiffRequestCount += 1
        let id = "full-diff-\(fullThreadDiffRequestCount)"
        try await send(
            MobileRequestMessage(
                id: id,
                method: "orchestration.getFullThreadDiff",
                payload: FullThreadDiffPayload(threadId: threadID, toTurnCount: toTurnCount)
            )
        )
        return try await receiveTurnDiff(id: id)
    }

    func dispatchCommand<Command: Codable & Equatable & Sendable>(_ command: Command) async throws -> MobileCommandReceipt {
        dispatchRequestCount += 1
        let id = "dispatch-\(dispatchRequestCount)"
        try await send(
            MobileRequestMessage(
                id: id,
                method: "orchestration.dispatchCommand",
                payload: command
            )
        )
        let response = try await receiveResponse(id: id)
        guard case let .commandReceipt(receipt) = response.payload else {
            throw MobileSyncError.unexpectedMessage("Expected mobile command receipt.")
        }
        return receipt
    }

    func nextMessage() async throws -> MobileServerMessage {
        try await receiveMessage(id: nil)
    }

    func ping() async throws {
        if let terminalError {
            throw terminalError
        }
        try await session.ping()
    }

    func close() async {
        let error = MobileSyncError.webSocketClosed("Mobile WebSocket closed.")
        terminalError = error
        readerTask?.cancel()
        readerTask = nil
        failPending(error)
        await session.close()
    }

    private func receiveStream(id: String) async throws -> MobileStreamMessage {
        let message = try await receiveMessage(id: id)
        switch message {
        case let .stream(stream):
            return stream
        case let .error(error):
            throw MobileSyncError.protocolError(code: error.error.code, message: error.error.message)
        default:
            throw MobileSyncError.unexpectedMessage("Expected mobile stream message.")
        }
    }

    private func receiveResponse(id: String) async throws -> MobileResponseMessage {
        let message = try await receiveMessage(id: id)
        switch message {
        case let .response(response):
            return response
        case let .error(error):
            throw MobileSyncError.protocolError(code: error.error.code, message: error.error.message)
        default:
            throw MobileSyncError.unexpectedMessage("Expected mobile response message.")
        }
    }

    private func receiveTurnDiff(id: String) async throws -> MobileTurnDiff {
        let response = try await receiveResponse(id: id)
        guard case let .turnDiff(diff) = response.payload else {
            throw MobileSyncError.unexpectedMessage("Expected mobile turn diff response.")
        }
        return diff
    }

    private func send<Value: Encodable>(_ value: Value) async throws {
        if let terminalError {
            throw terminalError
        }
        startReaderIfNeeded()
        try await session.send(encoder.encode(value))
    }

    private func receiveMessage(id: String?) async throws -> MobileServerMessage {
        startReaderIfNeeded()
        if let buffered = popBufferedMessage(id: id) {
            return buffered
        }
        if let terminalError {
            throw terminalError
        }
        return try await withCheckedThrowingContinuation { continuation in
            let key = id ?? "__next__"
            pendingMessages[key] = continuation
        }
    }

    private func startReaderIfNeeded() {
        guard readerTask == nil else {
            return
        }
        readerTask = Task { [session, decoder] in
            while !Task.isCancelled {
                do {
                    let data = try await session.receive()
                    let message = try decoder.decode(MobileServerMessage.self, from: data)
                    await self.route(message)
                } catch {
                    await self.finishReader(error)
                    return
                }
            }
            await self.finishReader(MobileSyncError.webSocketClosed("Mobile WebSocket reader stopped."))
        }
    }

    private func route(_ message: MobileServerMessage) {
        if let id = messageID(message), let continuation = pendingMessages.removeValue(forKey: id) {
            continuation.resume(returning: message)
            return
        }
        if let continuation = pendingMessages.removeValue(forKey: "__next__") {
            continuation.resume(returning: message)
            return
        }
        let key = messageID(message) ?? "__next__"
        var messages = bufferedMessages[key, default: []]
        messages.append(message)
        if messages.count > maxBufferedMessagesPerID {
            let error = MobileSyncError.webSocketClosed(
                "Mobile WebSocket became unhealthy after buffering too many unmatched messages for \(key)."
            )
            finishReader(error)
            Task {
                await session.close()
            }
            return
        }
        bufferedMessages[key] = messages
    }

    private func popBufferedMessage(id: String?) -> MobileServerMessage? {
        let key = id ?? "__next__"
        if var messages = bufferedMessages[key], !messages.isEmpty {
            let message = messages.removeFirst()
            bufferedMessages[key] = messages.isEmpty ? nil : messages
            return message
        }
        if id == nil {
            for key in bufferedMessages.keys.sorted() {
                if var messages = bufferedMessages[key], !messages.isEmpty {
                    let message = messages.removeFirst()
                    bufferedMessages[key] = messages.isEmpty ? nil : messages
                    return message
                }
            }
        }
        return nil
    }

    private func failPending(_ error: Error) {
        let continuations = pendingMessages.values
        pendingMessages.removeAll()
        for continuation in continuations {
            continuation.resume(throwing: error)
        }
    }

    private func finishReader(_ error: Error) {
        readerTask = nil
        terminalError = error
        bufferedMessages.removeAll()
        failPending(error)
    }

    private func nextRequestID(prefix: String) -> String {
        requestCount += 1
        return "\(prefix)-\(requestCount)"
    }

    private func messageID(_ message: MobileServerMessage) -> String? {
        switch message {
        case let .hello(response):
            response.id
        case let .response(response):
            response.id
        case let .stream(stream):
            stream.id
        case let .error(error):
            error.id
        }
    }
}

struct MobileStreamSubscription: Sendable {
    let id: String
    let initial: MobileStreamMessage
}
