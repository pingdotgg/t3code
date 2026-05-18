import Foundation

public let mobileProtocolVersion = "mobile.v1"

public enum MobileClientCapability: String, Codable, Sendable {
    case authBearerBootstrap = "auth.bearer-bootstrap"
    case authWebSocketToken = "auth.ws-token"
    case orchestrationShell = "orchestration.shell"
    case orchestrationThreadDetail = "orchestration.thread-detail"
    case orchestrationReplayEnvelope = "orchestration.replay-envelope"
    case orchestrationCommandReceipts = "orchestration.command-receipts"
    case diffTurn = "diff.turn"
    case diffFullThread = "diff.full-thread"
}

public typealias MobileServerCapability = MobileClientCapability

public let mobileV1ClientCapabilities: [MobileClientCapability] = [
    .authBearerBootstrap,
    .authWebSocketToken,
    .orchestrationShell,
    .orchestrationThreadDetail,
    .orchestrationReplayEnvelope,
    .orchestrationCommandReceipts,
    .diffTurn,
    .diffFullThread,
]

public struct MobileEndpointDescriptor: Codable, Equatable, Sendable {
    public let descriptor: String
    public let authBearerBootstrap: String
    public let authSession: String
    public let authWebSocketToken: String
    public let websocket: String
}

public struct MobileEnvironmentDescriptor: Codable, Equatable, Sendable {
    public struct Platform: Codable, Equatable, Sendable {
        public let os: String
        public let arch: String
    }

    public let environmentId: String
    public let label: String
    public let platform: Platform
    public let serverVersion: String
    public let capabilities: [String: Bool]
}

public struct MobileDescriptorResult: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let serverCapabilities: [MobileServerCapability]
    public let minSupportedProtocolVersion: String
    public let endpoints: MobileEndpointDescriptor
    public let environment: MobileEnvironmentDescriptor
}

public struct MobileBearerBootstrapInput: Codable, Equatable, Sendable {
    public let credential: String

    public init(credential: String) {
        self.credential = credential
    }
}

public struct MobileBearerBootstrapSession: Codable, Equatable, Sendable {
    public let authenticated: Bool
    public let role: String
    public let sessionMethod: String
    public let expiresAt: String
    public let sessionToken: String
}

public struct MobileAuthBearerBootstrapResult: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let serverCapabilities: [MobileServerCapability]
    public let result: MobileBearerBootstrapSession
}

public struct MobileAuthSessionState: Codable, Equatable, Sendable {
    public let authenticated: Bool
    public let role: String?
    public let sessionMethod: String?
    public let expiresAt: String?
}

public struct MobileAuthSessionResult: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let serverCapabilities: [MobileServerCapability]
    public let result: MobileAuthSessionState
}

public struct MobileWebSocketToken: Codable, Equatable, Sendable {
    public let token: String
    public let expiresAt: String
}

public struct MobileAuthWebSocketTokenResult: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let serverCapabilities: [MobileServerCapability]
    public let result: MobileWebSocketToken
}

public struct MobileProtocolEnvelope: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let serverCapabilities: [MobileServerCapability]
}

public struct MobileHelloMessage: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let protocolVersion: String
    public let capabilities: [MobileClientCapability]

    public init(id: String, capabilities: [MobileClientCapability]) {
        self.id = id
        type = "hello"
        protocolVersion = mobileProtocolVersion
        self.capabilities = capabilities
    }
}

public struct MobileHelloResponse: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let serverCapabilities: [MobileServerCapability]
    public let id: String
    public let type: String
}

public struct MobileErrorPayload: Codable, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct MobileErrorMessage: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let serverCapabilities: [MobileServerCapability]
    public let id: String?
    public let type: String
    public let error: MobileErrorPayload
}

public struct MobileStreamMessage: Codable, Equatable, Sendable {
    public struct Payload: Codable, Equatable, Sendable {
        public let kind: String
        public let sequence: Int?
        public let snapshot: JSONValue?
        public let event: JSONValue?
        public let project: JSONValue?
        public let thread: JSONValue?
        public let projectId: String?
        public let threadId: String?

        public init(
            kind: String,
            sequence: Int? = nil,
            snapshot: JSONValue? = nil,
            event: JSONValue? = nil,
            project: JSONValue? = nil,
            thread: JSONValue? = nil,
            projectId: String? = nil,
            threadId: String? = nil
        ) {
            self.kind = kind
            self.sequence = sequence
            self.snapshot = snapshot
            self.event = event
            self.project = project
            self.thread = thread
            self.projectId = projectId
            self.threadId = threadId
        }
    }

    public let protocolVersion: String
    public let serverCapabilities: [MobileServerCapability]
    public let id: String
    public let type: String
    public let payload: Payload

    public init(
        protocolVersion: String,
        serverCapabilities: [MobileServerCapability],
        id: String,
        type: String,
        payload: Payload
    ) {
        self.protocolVersion = protocolVersion
        self.serverCapabilities = serverCapabilities
        self.id = id
        self.type = type
        self.payload = payload
    }
}

public struct MobileReplayEnvelope: Codable, Equatable, Sendable {
    public let status: String
    public let fromSequenceExclusive: Int
    public let returnedFromSequenceExclusive: Int
    public let returnedToSequenceInclusive: Int
    public let serverHighWaterSequence: Int
    public let events: [JSONValue]
    public let resnapshot: [String]
    public let error: MobileErrorPayload?

    public init(
        status: String,
        fromSequenceExclusive: Int,
        returnedFromSequenceExclusive: Int,
        returnedToSequenceInclusive: Int,
        serverHighWaterSequence: Int,
        events: [JSONValue],
        resnapshot: [String],
        error: MobileErrorPayload?
    ) {
        self.status = status
        self.fromSequenceExclusive = fromSequenceExclusive
        self.returnedFromSequenceExclusive = returnedFromSequenceExclusive
        self.returnedToSequenceInclusive = returnedToSequenceInclusive
        self.serverHighWaterSequence = serverHighWaterSequence
        self.events = events
        self.resnapshot = resnapshot
        self.error = error
    }
}

public struct MobileCommandReceipt: Codable, Equatable, Sendable {
    public let status: String
    public let commandId: String
    public let payloadHash: String
    public let acceptedAt: String
    public let sequence: Int?
    public let error: MobileErrorPayload?

    public init(
        status: String,
        commandId: String,
        payloadHash: String,
        acceptedAt: String,
        sequence: Int?,
        error: MobileErrorPayload?
    ) {
        self.status = status
        self.commandId = commandId
        self.payloadHash = payloadHash
        self.acceptedAt = acceptedAt
        self.sequence = sequence
        self.error = error
    }
}

public struct MobileTurnDiff: Codable, Equatable, Sendable {
    public let threadId: String
    public let fromTurnCount: Int
    public let toTurnCount: Int
    public let diff: String
}

public enum MobileResponsePayload: Codable, Equatable, Sendable {
    case replay(MobileReplayEnvelope)
    case commandReceipt(MobileCommandReceipt)
    case turnDiff(MobileTurnDiff)
    case unknown(JSONValue)

    private enum CodingKeys: String, CodingKey {
        case events
        case commandId
        case diff
    }

    public init(from decoder: Decoder) throws {
        let keyed = try decoder.container(keyedBy: CodingKeys.self)
        if keyed.contains(.events) {
            self = .replay(try MobileReplayEnvelope(from: decoder))
        } else if keyed.contains(.commandId) {
            self = .commandReceipt(try MobileCommandReceipt(from: decoder))
        } else if keyed.contains(.diff) {
            self = .turnDiff(try MobileTurnDiff(from: decoder))
        } else {
            self = .unknown(try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .replay(value):
            try value.encode(to: encoder)
        case let .commandReceipt(value):
            try value.encode(to: encoder)
        case let .turnDiff(value):
            try value.encode(to: encoder)
        case let .unknown(value):
            try value.encode(to: encoder)
        }
    }
}

public struct MobileResponseMessage: Codable, Equatable, Sendable {
    public let protocolVersion: String
    public let serverCapabilities: [MobileServerCapability]
    public let id: String
    public let type: String
    public let payload: MobileResponsePayload
}

public enum MobileServerMessage: Codable, Equatable, Sendable {
    case hello(MobileHelloResponse)
    case error(MobileErrorMessage)
    case response(MobileResponseMessage)
    case stream(MobileStreamMessage)

    private enum CodingKeys: String, CodingKey {
        case type
    }

    public init(from decoder: Decoder) throws {
        let keyed = try decoder.container(keyedBy: CodingKeys.self)
        switch try keyed.decode(String.self, forKey: .type) {
        case "hello":
            self = .hello(try MobileHelloResponse(from: decoder))
        case "error":
            self = .error(try MobileErrorMessage(from: decoder))
        case "response":
            self = .response(try MobileResponseMessage(from: decoder))
        case "stream":
            self = .stream(try MobileStreamMessage(from: decoder))
        case let type:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: keyed,
                debugDescription: "Unsupported mobile server message type: \(type)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .hello(value):
            try value.encode(to: encoder)
        case let .error(value):
            try value.encode(to: encoder)
        case let .response(value):
            try value.encode(to: encoder)
        case let .stream(value):
            try value.encode(to: encoder)
        }
    }
}
