// JSONValueTests.swift
// Round-trip + accessor coverage for the free-form JSON value used for
// opaque/untyped fields (§5.4, §5.6, §11 of docs/wire-protocol.md).

import Testing
@testable import T3Kit
import Foundation

@Suite("JSONValue")
struct JSONValueTests {

    @Test("decodes every primitive JSON shape")
    func decodesPrimitives() throws {
        let text = #"""
        {
          "n": null,
          "b": true,
          "i": 42,
          "d": 3.5,
          "s": "hi",
          "a": [1, "two", null],
          "o": {"k": "v"}
        }
        """#
        let value = try WireCoding.decoder.decode(JSONValue.self, from: Data(text.utf8))
        #expect(value["n"] == .null)
        #expect(value["b"] == .bool(true))
        #expect(value["i"]?.intValue == 42)
        #expect(value["d"] == .double(3.5))
        #expect(value["s"]?.stringValue == "hi")
        #expect(value["a"]?.arrayValue?.count == 3)
        #expect(value["a"]?.arrayValue?[1] == .string("two"))
        #expect(value["o"]?.objectValue?["k"] == .string("v"))
    }

    @Test("encode(to:) round-trips through decode for every case")
    func encodeDecodeRoundTrip() throws {
        let original = JSONValue.object([
            "null": .null,
            "bool": .bool(false),
            "int": .int(-7),
            "double": .double(1.25),
            "string": .string("café"),
            "array": .array([.int(1), .int(2), .int(3)]),
        ])
        let data = try WireCoding.encoder.encode(original)
        let decoded = try WireCoding.decoder.decode(JSONValue.self, from: data)
        #expect(decoded == original)
    }

    @Test("subscript returns nil for non-object values and missing keys")
    func subscriptOnNonObject() {
        let array = JSONValue.array([.int(1)])
        #expect(array["missing"] == nil)

        let object = JSONValue.object(["present": .int(1)])
        #expect(object["absent"] == nil)
        #expect(object["present"] == .int(1))
    }

    @Test("typed accessors return nil for mismatched cases")
    func typedAccessorsMismatch() {
        let string = JSONValue.string("x")
        #expect(string.stringValue == "x")
        #expect(string.intValue == nil)
        #expect(string.arrayValue == nil)
        #expect(string.objectValue == nil)

        let int = JSONValue.int(5)
        #expect(int.intValue == 5)
        #expect(int.stringValue == nil)
    }

    @Test("decode(as:using:) re-decodes a subtree into a typed model")
    func decodeSubtreeIntoTypedModel() throws {
        struct Snapshot: Decodable, Equatable {
            let snapshotSequence: Int
        }
        let value = JSONValue.object([
            "kind": .string("snapshot"),
            "snapshot": .object(["snapshotSequence": .int(100)]),
        ])
        let snapshot = try value["snapshot"]!.decode(as: Snapshot.self, using: WireCoding.decoder)
        #expect(snapshot == Snapshot(snapshotSequence: 100))
    }

    @Test("object values compare equal regardless of key insertion order")
    func objectEqualityIgnoresKeyOrder() {
        let a = JSONValue.object(["x": .int(1), "y": .int(2)])
        let b = JSONValue.object(["y": .int(2), "x": .int(1)])
        #expect(a == b)
    }
}
