import Foundation

/// A lossless, Sendable JSON representation used at protocol boundaries that
/// intentionally carry provider-defined payloads.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case integer(Int64)
    case unsignedInteger(UInt64)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            let double = Double(value)
            self = Int64(exactly: double) == value ? .number(double) : .integer(value)
        } else if let value = try? container.decode(UInt64.self) {
            let double = Double(value)
            self = UInt64(exactly: double) == value
                ? .number(double)
                : .unsignedInteger(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .integer(value):
            try container.encode(value)
        case let .unsignedInteger(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }

    public subscript(key: String) -> JSONValue? {
        guard case let .object(object) = self else { return nil }
        return object[key]
    }

    public var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    public static func encode<T: Encodable & Sendable>(
        _ value: T,
        encoder: JSONEncoder = .t3
    ) throws -> JSONValue {
        let data = try encoder.encode(value)
        return try JSONDecoder.t3.decode(JSONValue.self, from: data)
    }

    public func decode<T: Decodable & Sendable>(
        _ type: T.Type,
        decoder: JSONDecoder = .t3
    ) throws -> T {
        // The intermediate bytes are discarded immediately, so skip the
        // deterministic-output formatting the wire encoder pays for.
        try decoder.decode(type, from: JSONEncoder.t3Intermediate.encode(self))
    }
}

// Encoders and decoders are configured once and never mutated afterwards, so
// shared instances are safe for concurrent use and avoid rebuilding coder
// state on every RPC message.
extension JSONEncoder {
    /// Deterministic output for wire payloads.
    public static let t3: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    /// Throwaway intermediate encoding (JSONValue -> concrete type bridging).
    static let t3Intermediate: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()
}

extension JSONDecoder {
    public static let t3 = JSONDecoder()
}
