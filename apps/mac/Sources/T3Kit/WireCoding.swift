// WireCoding.swift
// Shared codec configuration plus the reusable optionality/default helpers
// that model files rely on: `Schema.Option` (§5.4) and `withDecodingDefault`
// (§5.3) fields.

import Foundation

public enum WireCoding {
    /// No key strategy mutation, no pretty printing — compact one-object (or
    /// one-array) JSON per WS text frame (§2.1).
    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        return encoder
    }()

    /// Default decoder. Dates stay `String` at the wire layer (§5.1); Option
    /// (`OptionBox`) and default-injecting fields are handled per-type.
    public static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        return decoder
    }()

    /// Encode one value as the UTF-8 text payload of a single WebSocket text
    /// frame (`JSON.stringify` equivalent, §2.1). `JSONEncoder` always emits
    /// valid UTF-8, so this only throws on the encode step itself.
    public static func encodeFrameString<T: Encodable>(_ value: T) throws -> String {
        let data = try encoder.encode(value)
        return String(decoding: data, as: UTF8.self)
    }
}

/// Decodes/encodes `Schema.Option` = `{_tag:"None"}` | `{_tag:"Some",value}`
/// (§5.4) — a tagged object, distinct from an absent key or a bare `null`.
public struct OptionBox<Wrapped: Codable & Sendable>: Codable, Sendable {
    public let value: Wrapped?

    public init(_ value: Wrapped?) {
        self.value = value
    }

    private enum CodingKeys: String, CodingKey {
        case _tag = "_tag"
        case value
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let tag = try container.decode(String.self, forKey: ._tag)
        switch tag {
        case "Some":
            value = try container.decode(Wrapped.self, forKey: .value)
        case "None":
            value = nil
        default:
            throw DecodingError.dataCorruptedError(
                forKey: ._tag,
                in: container,
                debugDescription: "Unknown Option _tag: \(tag)"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let value {
            try container.encode("Some", forKey: ._tag)
            try container.encode(value, forKey: .value)
        } else {
            try container.encode("None", forKey: ._tag)
        }
    }
}

extension KeyedDecodingContainer {
    /// `withDecodingDefault` support (§5.3): inject a default when the key is
    /// absent, e.g. `runtimeMode` (dflt `"full-access"`), `interactionMode`
    /// (dflt `"default"`), `archivedAt` (dflt `nil`), `proposedPlans` (dflt `[]`).
    public func decode<T: Decodable>(_ type: T.Type, forKey key: Key, default defaultValue: T) throws -> T {
        try decodeIfPresent(type, forKey: key) ?? defaultValue
    }
}
