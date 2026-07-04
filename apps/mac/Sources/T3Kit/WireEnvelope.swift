// WireEnvelope.swift
// The Effect-RPC framing layer (§2): outbound C→S and inbound S→C envelope
// Codables, plus batch-array/single frame decoding (§2.1). Payload/value/error
// stay JSONValue here so this layer is method-agnostic; the method layer
// decodes those into typed models via JSONValue.decode(as:using:).

import Foundation

/// `FromClientEncoded` (§2.2). Each case encodes to one JSON object
/// discriminated by `_tag` — exactly one WS text frame's worth of JSON.
public enum ClientFrame: Encodable, Sendable {
    /// `headers` is an array of `[key, value]` string pairs, not a JSON
    /// object (§2.2); normally `[]`. `payload` must already be schema-encoded.
    case request(id: String, tag: String, payload: JSONValue, headers: [[String]], traceId: String? = nil)
    /// Acknowledge one streamed `Chunk`, enabling the next (§2.3, mandatory).
    case ack(requestId: String)
    /// Cancel an in-flight request / unsubscribe from a stream (§2.4).
    case interrupt(requestId: String)
    /// Liveness heartbeat sent every 5s (§1.4).
    case ping
    /// Client is done sending; rarely needed (§2.2).
    case eof

    private enum CodingKeys: String, CodingKey {
        case _tag = "_tag"
        case id, tag, payload, headers, traceId, requestId
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .request(id, tag, payload, headers, traceId):
            try container.encode("Request", forKey: ._tag)
            try container.encode(id, forKey: .id)
            try container.encode(tag, forKey: .tag)
            try container.encode(payload, forKey: .payload)
            try container.encode(headers, forKey: .headers)
            try container.encodeIfPresent(traceId, forKey: .traceId)
        case let .ack(requestId):
            try container.encode("Ack", forKey: ._tag)
            try container.encode(requestId, forKey: .requestId)
        case let .interrupt(requestId):
            try container.encode("Interrupt", forKey: ._tag)
            try container.encode(requestId, forKey: .requestId)
        case .ping:
            try container.encode("Ping", forKey: ._tag)
        case .eof:
            try container.encode("Eof", forKey: ._tag)
        }
    }
}

/// Terminal result of a request (§2.2): `Exit.Success` carries the encoded
/// success value; `Exit.Failure` carries a `Cause` array decoded into
/// `RpcFailure`.
public enum ExitResult: Decodable, Sendable {
    case success(value: JSONValue)
    case failure(RpcFailure)

    private enum CodingKeys: String, CodingKey {
        case _tag = "_tag"
        case value, cause
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let tag = try container.decode(String.self, forKey: ._tag)
        switch tag {
        case "Success":
            // Void-success RPCs (§3: "(none — void)") omit `value` entirely.
            let value = try container.decodeIfPresent(JSONValue.self, forKey: .value) ?? .null
            self = .success(value: value)
        case "Failure":
            let failure = try container.decode(RpcFailure.self, forKey: .cause)
            self = .failure(failure)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: ._tag,
                in: container,
                debugDescription: "Unknown Exit _tag: \(tag)"
            )
        }
    }
}

/// `FromServerEncoded` (§2.2), discriminated by `_tag`.
public enum ServerFrame: Decodable, Sendable {
    /// One batch of stream values for a streaming RPC. `values` is non-empty
    /// per spec; the caller MUST send an `Ack` for `requestId` after handling
    /// it (§2.3 — mandatory, or the stream stalls).
    case chunk(requestId: String, values: [JSONValue])
    case exit(requestId: String, exit: ExitResult)
    /// Connection-level defect, not tied to one request; kills all in-flight
    /// requests (§2.2).
    case defect(defect: JSONValue)
    /// Liveness reply to a client `Ping` (§1.4).
    case pong
    /// Server signals the client connection ended; safe to ignore (§2.2).
    /// Note: this is a decoded-`FromServer`-only tag in the reference client
    /// (`RpcMessage.ts:206-210`) and is never actually seen on the wire — the
    /// transport union instead sends `ClientProtocolError`
    /// (`RpcMessage.ts:218-223`). Kept for forward compatibility; harmless if
    /// it never arrives.
    case clientEnd(clientId: Int?)
    /// Connection-level protocol error reported by the server transport
    /// (bad/duplicate/oversized frame, serialization error affecting this
    /// client). Like `Defect`, this kills every in-flight request/stream on
    /// this connection — the reference client does the same
    /// (`RpcClient.ts:780-786`).
    case clientProtocolError(error: JSONValue)
    /// Any `_tag` this codec doesn't recognize (forward compatibility, §6 risk 1).
    case unknown(tag: String)

    private enum CodingKeys: String, CodingKey {
        case _tag = "_tag"
        case requestId, values, exit, defect, clientId, error
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let tag = try container.decode(String.self, forKey: ._tag)
        switch tag {
        case "Chunk":
            let requestId = try container.decode(String.self, forKey: .requestId)
            let values = try container.decode([JSONValue].self, forKey: .values)
            self = .chunk(requestId: requestId, values: values)
        case "Exit":
            let requestId = try container.decode(String.self, forKey: .requestId)
            let exit = try container.decode(ExitResult.self, forKey: .exit)
            self = .exit(requestId: requestId, exit: exit)
        case "Defect":
            let defect = try container.decode(JSONValue.self, forKey: .defect)
            self = .defect(defect: defect)
        case "Pong":
            self = .pong
        case "ClientEnd":
            let clientId = try container.decodeIfPresent(Int.self, forKey: .clientId)
            self = .clientEnd(clientId: clientId)
        case "ClientProtocolError":
            let error = try container.decode(JSONValue.self, forKey: .error)
            self = .clientProtocolError(error: error)
        default:
            self = .unknown(tag: tag)
        }
    }
}

/// Decode one WS text frame that may be a single JSON object or a JSON array
/// batch (§2.1): `JSON.parse(frameText)` — array means a batch of messages,
/// otherwise a single message.
public enum FrameBatch {
    public static func decode(_ text: String) throws -> [ServerFrame] {
        guard let data = text.data(using: .utf8) else {
            throw T3Error.decoding("Frame text is not valid UTF-8")
        }
        let isBatch = text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[")
        do {
            if isBatch {
                return try WireCoding.decoder.decode([ServerFrame].self, from: data)
            } else {
                let frame = try WireCoding.decoder.decode(ServerFrame.self, from: data)
                return [frame]
            }
        } catch let error as DecodingError {
            throw T3Error.decoding(String(describing: error))
        }
    }
}
