// T3Error.swift
// Error taxonomy surfaced to callers: transport failures, decode failures,
// ack/ping-timeout deadness, and typed in-band RPC failures decoded from
// Exit.Failure causes (§2.2, §5.6). RpcFailure is the per-request error the
// app must handle without treating it as connection-fatal (§risk9).

import Foundation

/// Decoded from `Exit.Failure.cause` (§2.2): an array of cause nodes, each
/// discriminated by `_tag` as `Fail` | `Die` | `Interrupt`.
public struct RpcFailure: Error, Decodable, Sendable {
    public enum Node: Sendable, Decodable {
        /// `{ "_tag": "Fail", "error": { "_tag": "<ErrorName>", …fields } }`.
        /// `tag` is the *error's* `_tag` literal (§5.9: match on this, never
        /// the exported class name); `error` is the full error object.
        case fail(tag: String, error: JSONValue)
        /// `{ "_tag": "Die", "defect": <json> }` — opaque, best-effort (§5.6).
        case die(defect: JSONValue)
        /// `{ "_tag": "Interrupt", "fiberId": 12 }` — `fiberId` may be absent.
        case interrupt(fiberId: Int?)

        private enum CodingKeys: String, CodingKey {
            case _tag = "_tag"
            case error, defect, fiberId
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let tag = try container.decode(String.self, forKey: ._tag)
            switch tag {
            case "Fail":
                let error = try container.decode(JSONValue.self, forKey: .error)
                let errorTag = error["_tag"]?.stringValue ?? ""
                self = .fail(tag: errorTag, error: error)
            case "Die":
                let defect = try container.decode(JSONValue.self, forKey: .defect)
                self = .die(defect: defect)
            case "Interrupt":
                let fiberId = try container.decodeIfPresent(Int.self, forKey: .fiberId)
                self = .interrupt(fiberId: fiberId)
            default:
                // Forward-compatible fallback: an unrecognized cause-node tag
                // is treated as an opaque defect rather than a hard decode
                // failure (§6 risk 1: the envelope is an unstable Effect API).
                let raw = try JSONValue(from: decoder)
                self = .die(defect: raw)
            }
        }
    }

    public let causes: [Node]

    public init(causes: [Node]) {
        self.causes = causes
    }

    public init(from decoder: any Decoder) throws {
        causes = try [Node](from: decoder)
    }

    /// The first `Fail` node's error `_tag` literal (§5.9). Match on this, not
    /// the Swift/TS class name.
    public var primaryErrorTag: String? {
        for cause in causes {
            if case let .fail(tag, _) = cause { return tag }
        }
        return nil
    }

    public var isAuthorizationError: Bool {
        primaryErrorTag == "EnvironmentAuthorizationError"
    }

    public var requiredScope: String? {
        for cause in causes {
            if case let .fail(_, error) = cause {
                return error["requiredScope"]?.stringValue
            }
        }
        return nil
    }
}

public enum T3Error: Error, Sendable {
    case notConnected
    case connectionClosed(reason: String?)
    /// ~10s without a `Pong` after the 5s ping cadence (§1.4).
    case pingTimeout
    /// URLSession/WebSocket transport-layer failure.
    case transport(String)
    /// Frame/model decode failure (malformed JSON, unexpected shape).
    case decoding(String)
    /// A typed `Exit.Failure` cause, decoded per-request (§risk9: not fatal
    /// to the connection).
    case rpc(RpcFailure)
    /// HTTP bootstrap/ticket failure (§1.2).
    case auth(String)
    /// The bearer session is no longer accepted by the remote server.
    case unauthorized(String)
    case unexpectedFrame(String)
}
