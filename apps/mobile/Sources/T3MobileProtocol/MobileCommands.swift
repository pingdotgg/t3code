import Foundation

public struct MobileRequestMessage<Payload: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let protocolVersion: String
    public let method: String
    public let payload: Payload

    public init(id: String, method: String, payload: Payload) {
        self.id = id
        type = "request"
        protocolVersion = mobileProtocolVersion
        self.method = method
        self.payload = payload
    }
}

public struct EmptyPayload: Codable, Equatable, Sendable {
    public init() {}
}

public struct SubscribeThreadPayload: Codable, Equatable, Sendable {
    public let threadId: String

    public init(threadId: String) {
        self.threadId = threadId
    }
}

public struct ReplayEventsPayload: Codable, Equatable, Sendable {
    public let fromSequenceExclusive: Int

    public init(fromSequenceExclusive: Int) {
        self.fromSequenceExclusive = fromSequenceExclusive
    }
}

public struct TurnDiffPayload: Codable, Equatable, Sendable {
    public let threadId: String
    public let fromTurnCount: Int
    public let toTurnCount: Int
    public let scope: String

    public init(
        threadId: String,
        fromTurnCount: Int,
        toTurnCount: Int,
        scope: String = "snapshot"
    ) {
        self.threadId = threadId
        self.fromTurnCount = fromTurnCount
        self.toTurnCount = toTurnCount
        self.scope = scope
    }
}

public struct FullThreadDiffPayload: Codable, Equatable, Sendable {
    public let threadId: String
    public let toTurnCount: Int

    public init(threadId: String, toTurnCount: Int) {
        self.threadId = threadId
        self.toTurnCount = toTurnCount
    }
}

public struct UserMessagePayload: Codable, Equatable, Sendable {
    public let messageId: String
    public let role: String
    public let text: String
    public let attachments: [JSONValue]

    public init(messageId: String, text: String, attachments: [JSONValue] = []) {
        self.messageId = messageId
        role = "user"
        self.text = text
        self.attachments = attachments
    }
}

public struct ThreadTurnStartCommand: Codable, Equatable, Sendable {
    public let type: String
    public let commandId: String
    public let threadId: String
    public let message: UserMessagePayload
    public let runtimeMode: String
    public let interactionMode: String
    public let createdAt: String

    public init(
        commandId: String,
        threadId: String,
        message: UserMessagePayload,
        runtimeMode: String = "full-access",
        interactionMode: String = "default",
        createdAt: String
    ) {
        type = "thread.turn.start"
        self.commandId = commandId
        self.threadId = threadId
        self.message = message
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.createdAt = createdAt
    }
}

public struct ThreadTurnInterruptCommand: Codable, Equatable, Sendable {
    public let type: String
    public let commandId: String
    public let threadId: String
    public let turnId: String?
    public let createdAt: String

    public init(commandId: String, threadId: String, turnId: String? = nil, createdAt: String) {
        type = "thread.turn.interrupt"
        self.commandId = commandId
        self.threadId = threadId
        self.turnId = turnId
        self.createdAt = createdAt
    }
}

public struct ThreadApprovalRespondCommand: Codable, Equatable, Sendable {
    public let type: String
    public let commandId: String
    public let threadId: String
    public let requestId: String
    public let decision: String
    public let createdAt: String

    public init(
        commandId: String,
        threadId: String,
        requestId: String,
        decision: String,
        createdAt: String
    ) {
        type = "thread.approval.respond"
        self.commandId = commandId
        self.threadId = threadId
        self.requestId = requestId
        self.decision = decision
        self.createdAt = createdAt
    }
}

public struct ThreadUserInputRespondCommand: Codable, Equatable, Sendable {
    public let type: String
    public let commandId: String
    public let threadId: String
    public let requestId: String
    public let answers: [String: JSONValue]
    public let createdAt: String

    public init(
        commandId: String,
        threadId: String,
        requestId: String,
        answers: [String: JSONValue],
        createdAt: String
    ) {
        type = "thread.user-input.respond"
        self.commandId = commandId
        self.threadId = threadId
        self.requestId = requestId
        self.answers = answers
        self.createdAt = createdAt
    }
}

public struct ThreadSessionStopCommand: Codable, Equatable, Sendable {
    public let type: String
    public let commandId: String
    public let threadId: String
    public let createdAt: String

    public init(commandId: String, threadId: String, createdAt: String) {
        type = "thread.session.stop"
        self.commandId = commandId
        self.threadId = threadId
        self.createdAt = createdAt
    }
}

public struct ThreadCheckpointRevertCommand: Codable, Equatable, Sendable {
    public let type: String
    public let commandId: String
    public let threadId: String
    public let turnCount: Int
    public let createdAt: String

    public init(commandId: String, threadId: String, turnCount: Int, createdAt: String) {
        type = "thread.checkpoint.revert"
        self.commandId = commandId
        self.threadId = threadId
        self.turnCount = turnCount
        self.createdAt = createdAt
    }
}
