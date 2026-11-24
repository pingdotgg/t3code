import { assert, describe, it } from "@effect/vitest"
import * as Hex from "effect/encoding/Hex"
import { ProtobufMessage } from "effect/protobuf"
import * as ProtobufDescriptor from "effect/protobuf/ProtobufDescriptor"
import * as Result from "effect/Result"
import { editions, field, message, registry, T } from "./descriptors.ts"

const unknownFields: typeof ProtobufMessage.unknownFields = ProtobufMessage.unknownFields

const bytes = (hex: string): Uint8Array => Result.getOrThrow(Hex.decode(hex.replaceAll(" ", "")))

const encode = (typeName: string, value: unknown, options?: Parameters<typeof ProtobufMessage.encode>[1]): string =>
  Hex.encode(Result.getOrThrow(ProtobufMessage.encode(message(typeName), options)(value as ProtobufMessage.Message)))

const decode = (
  typeName: string,
  hex: string,
  options?: Parameters<typeof ProtobufMessage.decode>[1]
): ProtobufMessage.Message => Result.getOrThrow(ProtobufMessage.decode(message(typeName), options)(bytes(hex)))

const failure = <A>(result: Result.Result<A, ProtobufMessage.ProtobufMessageError>) => {
  if (Result.isSuccess(result)) throw new Error("expected a failure")
  return { message: result.failure.message, path: result.failure.path }
}

const scalarZeros = {
  double: 0,
  float: 0,
  int64: 0n,
  uint64: 0n,
  int32: 0,
  fixed64: 0n,
  fixed32: 0,
  bool: false,
  string: "",
  bytes: new Uint8Array(0),
  uint32: 0,
  sfixed32: 0,
  sfixed64: 0n,
  sint32: 0,
  sint64: 0n
}

const shapeZeros = {
  name: "",
  points: [],
  ids: [],
  weights: [],
  tags: [],
  counts: {},
  by_id: {},
  flags: {},
  color: 0,
  colors: [],
  floats: []
}

const legacyZeros = { values: [], modes: [], mode_by_name: {} }

describe("ProtobufMessage", () => {
  it("encodes and decodes the largest valid field number", () => {
    const descriptor = Result.getOrThrow(ProtobufDescriptor.make([{
      name: "large.proto",
      syntax: "proto3",
      message_type: [{ name: "Large", field: [{ name: "value", number: 536870911, label: 1, type: 5 }] }]
    }])).getMessage("Large")!
    const encoded = bytes("f8ffffff0f01")
    assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.encode(descriptor)({ value: 1 })), encoded)
    assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.decode(descriptor)(encoded)), { value: 1 })
  })

  // Each case encodes to its bytes, and decodes back to its value, with the
  // zero values of the other fields.
  describe("encodes and decodes", () => {
    const cases: ReadonlyArray<readonly [string, string, object, string, object]> = [
      ["double 1.5", "test.Scalars", { double: 1.5 }, "09 000000000000f83f", scalarZeros],
      ["double -0, which is written", "test.Scalars", { double: -0 }, "09 0000000000000080", scalarZeros],
      ["float 1.5", "test.Scalars", { float: 1.5 }, "15 0000c03f", scalarZeros],
      ["int64 -1", "test.Scalars", { int64: -1n }, "18 ffffffffffffffffff01", scalarZeros],
      ["uint64 max", "test.Scalars", { uint64: 2n ** 64n - 1n }, "20 ffffffffffffffffff01", scalarZeros],
      ["int32 -2, as ten bytes", "test.Scalars", { int32: -2 }, "28 feffffffffffffffff01", scalarZeros],
      ["fixed64 1", "test.Scalars", { fixed64: 1n }, "31 0100000000000000", scalarZeros],
      ["fixed32 max", "test.Scalars", { fixed32: 4294967295 }, "3d ffffffff", scalarZeros],
      ["bool", "test.Scalars", { bool: true }, "40 01", scalarZeros],
      ["string", "test.Scalars", { string: "é" }, "4a 02 c3a9", scalarZeros],
      ["bytes", "test.Scalars", { bytes: new Uint8Array([1, 2]) }, "62 02 0102", scalarZeros],
      ["uint32 150", "test.Scalars", { uint32: 150 }, "68 9601", scalarZeros],
      ["sfixed32 -2", "test.Scalars", { sfixed32: -2 }, "7d feffffff", scalarZeros],
      ["sfixed64 -2", "test.Scalars", { sfixed64: -2n }, "8101 feffffffffffffff", scalarZeros],
      ["sint32 -1", "test.Scalars", { sint32: -1 }, "8801 01", scalarZeros],
      ["sint64 -1", "test.Scalars", { sint64: -1n }, "9001 01", scalarZeros],
      ["an int64 as a string", "test.Js", { as_string: "-1" }, "08 ffffffffffffffffff01", {
        as_string: "0",
        as_number: 0
      }],
      ["an int64 as a number", "test.Js", { as_number: 2 ** 53 }, "10 8080808080808010", {
        as_string: "0",
        as_number: 0
      }],
      ["an explicit zero", "test.Optional", { a: 0 }, "0800", {}],
      ["a message", "test.Shape", { origin: { x: 1, y: 0 } }, "12 02 0801", shapeZeros],
      [
        "repeated messages",
        "test.Shape",
        { points: [{ x: 1, y: 0 }, { x: 0, y: 2 }] },
        "1a02 0801 1a02 1002",
        shapeZeros
      ],
      ["a oneof case", "test.Shape", { kind: { _tag: "label", value: "hi" } }, "22 02 6869", shapeZeros],
      ["a oneof message", "test.Shape", { kind: { _tag: "center", value: { x: 1, y: 0 } } }, "2a 02 0801", shapeZeros],
      ["packed integers", "test.Shape", { ids: [1, 2, 300] }, "32 04 0102ac02", shapeZeros],
      ["packed doubles", "test.Shape", { weights: [0.5] }, "3a 08 000000000000e03f", shapeZeros],
      ["packed floats", "test.Shape", { floats: [1, -2] }, "72 08 0000803f000000c0", shapeZeros],
      ["repeated strings", "test.Shape", { tags: ["a", "b"] }, "42 01 61 42 01 62", shapeZeros],
      ["a map of strings", "test.Shape", { counts: { a: 1 } }, "4a 05 0a0161 1001", shapeZeros],
      [
        "a map of int64 keys",
        "test.Shape",
        { by_id: { "-5": "x" } },
        "52 0e 08fbffffffffffffffff01 120178",
        shapeZeros
      ],
      ["a map of messages", "test.Shape", { flags: { true: { x: 1, y: 0 } } }, "5a 06 0801 12020801", shapeZeros],
      ["an enum", "test.Shape", { color: 1 }, "60 01", shapeZeros],
      ["packed enums", "test.Shape", { colors: [1, 0] }, "6a 02 0100", shapeZeros],
      ["a required field", "legacy.Legacy", { id: 1 }, "0801", legacyZeros],
      ["an explicit empty string", "legacy.Legacy", { id: 1, name: "" }, "0801 1200", legacyZeros],
      ["proto2 repeated fields, expanded", "legacy.Legacy", { id: 1, values: [1, 2] }, "0801 1801 1802", legacyZeros],
      ["a group", "legacy.Legacy", { id: 1, item: { x: 1 } }, "0801 23 2801 24", legacyZeros],
      ["a closed enum", "legacy.Legacy", { id: 1, mode: 2 }, "0801 3002", legacyZeros],
      ["packed closed enums", "legacy.Legacy", { id: 1, modes: [1, 2] }, "0801 3a02 0102", legacyZeros],
      [
        "a map of a closed enum",
        "legacy.Legacy",
        { id: 1, mode_by_name: { a: 1 } },
        "0801 4205 0a0161 1001",
        legacyZeros
      ],
      ["explicit presence by default in editions", "editions.E", { a: 0 }, "0800", { b: 0, c: [] }],
      ["packed by default in editions", "editions.E", { b: 1, c: [1, 2] }, "1001 1a020102", { b: 0, c: [] }],
      ["delimited messages in editions", "editions.E", { d: { x: 1 } }, "23 0801 24", { b: 0, c: [] }]
    ]
    for (const [name, typeName, value, hex, zeros] of cases) {
      it(name, () => {
        assert.strictEqual(encode(typeName, value), hex.replaceAll(" ", ""))
        assert.deepStrictEqual(decode(typeName, hex), { ...zeros, ...value })
      })
    }
  })

  describe("syntax and edition compatibility", () => {
    const versions = [
      ["proto2", "proto2", undefined],
      ["proto3", "proto3", undefined],
      ["2023", "editions", ProtobufDescriptor.Edition.EDITION_2023],
      ["2024", "editions", ProtobufDescriptor.Edition.EDITION_2024],
      ["2026", "editions", ProtobufDescriptor.Edition.EDITION_2026]
    ] as const

    for (const [version, syntax, edition] of versions) {
      it(`uses ${version} binary defaults from a descriptor set`, () => {
        const file: ProtobufDescriptor.FileDescriptorProto = {
          name: "version.proto",
          syntax,
          ...(edition === undefined ? {} : { edition }),
          message_type: [{
            name: "Example",
            field: [
              field("id", 1, "int32"),
              field("values", 2, "int32", { label: 3 }),
              field("text", 3, "string"),
              field("kind", 4, ".Kind", { type: T.enum }),
              field("child", 5, ".Example")
            ]
          }],
          enum_type: [{ name: "Kind", value: [{ name: "ZERO", number: 0 }] }]
        }
        const set = Result.getOrThrow(ProtobufMessage.encode(ProtobufDescriptor.FileDescriptorSet)({ file: [file] }))
        const registry = Result.getOrThrow(ProtobufDescriptor.fromFileDescriptorSet(set))
        assert.strictEqual(registry.getFile(file.name!)!.edition, version)
        const descriptor = registry.getMessage("Example")!
        const encode = ProtobufMessage.encode(descriptor)
        const decode = ProtobufMessage.decode(descriptor)
        assert.deepStrictEqual(
          Result.getOrThrow(decode(bytes(""))),
          version === "proto3"
            ? { id: 0, values: [], text: "", kind: 0 }
            : { values: [] }
        )
        assert.deepStrictEqual(Result.getOrThrow(encode({ id: 0 })), bytes(version === "proto3" ? "" : "0800"))
        assert.deepStrictEqual(
          Result.getOrThrow(encode({ values: [1, 2], child: {} })),
          bytes(version === "proto2" ? "1001 1002 2a00" : "12020102 2a00")
        )
        const unknownEnum = Result.getOrThrow(decode(bytes("2007")))
        if (version === "proto2") {
          assert.isUndefined(unknownEnum.kind)
          assert.deepStrictEqual(unknownEnum[unknownFields], bytes("2007"))
        } else {
          assert.strictEqual(unknownEnum.kind, 7)
          assert.isFalse(unknownFields in unknownEnum)
        }
        const invalidUtf8 = decode(bytes("1a01ff"))
        if (version === "proto2") assert.strictEqual(Result.getOrThrow(invalidUtf8).text, "\uFFFD")
        else assert.isTrue(Result.isFailure(invalidUtf8))
      })
    }

    for (const [version, , edition] of versions) {
      if (edition === undefined) continue
      it(`applies feature overrides in edition ${version}`, () => {
        const registry = Result.getOrThrow(ProtobufDescriptor.make([{
          ...editions,
          edition,
          options: { features: { repeated_field_encoding: 2, utf8_validation: 3 } },
          message_type: editions.message_type!.map((message) => ({
            ...message,
            field: [
              ...message.field!,
              field("text", 6, "string"),
              field("checked_text", 7, "string", { options: { features: { utf8_validation: 2 } } })
            ]
          }))
        }]))
        const descriptor = registry.getMessage("editions.E")!
        const value = { a: 0, b: 0, c: [1, 2], d: { x: 1 }, e: 1 }
        const wire = bytes("0800 1801 1802 23 0801 24 2801")
        assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.encode(descriptor)(value)), wire)
        assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.decode(descriptor)(wire)), value)
        const unknownEnum = Result.getOrThrow(ProtobufMessage.decode(descriptor)(bytes("2807")))
        assert.isUndefined(unknownEnum.e)
        assert.deepStrictEqual(unknownEnum[unknownFields], bytes("2807"))
        assert.strictEqual(Result.getOrThrow(ProtobufMessage.decode(descriptor)(bytes("3201ff"))).text, "\uFFFD")
        assert.isTrue(Result.isFailure(ProtobufMessage.decode(descriptor)(bytes("3a01ff"))))
      })
    }
  })

  it("leaves out implicit zero values", () => {
    assert.strictEqual(encode("test.Scalars", scalarZeros), "")
    assert.strictEqual(encode("test.Shape", shapeZeros), "")
    assert.strictEqual(encode("test.Shape", {}), "")
  })

  it("takes 64-bit integers as a bigint, number or decimal string", () => {
    for (const int64 of [-1n, -1, "-1"]) assert.strictEqual(encode("test.Scalars", { int64 }), "18ffffffffffffffffff01")
  })

  it("rounds a JS_NUMBER int64 outside the safe integers, as Number does", () => {
    assert.strictEqual(decode("test.Js", "10 8180808080808010").as_number, 2 ** 53)
  })

  describe("original names", () => {
    it("round-trips names that would collide after camel casing", () => {
      const value = decode("legacy.OriginalNames", "08011002")
      assert.deepStrictEqual(value, { bar: 1, bar_: 2 })
      assert.strictEqual(encode("legacy.OriginalNames", value), "08011002")
    })

    it("preserves implicit field names, including Object.prototype names", () => {
      assert.deepStrictEqual(decode("test.Names", ""), { constructor: 0, foo_bar: 0 })
      const value = { constructor: 1, foo_bar: 2 }
      assert.strictEqual(encode("test.Names", value), "08011002")
      assert.deepStrictEqual(decode("test.Names", "08011002"), value)
      assert.strictEqual(encode("test.Names", {}), "")
    })

    it("stores and merges explicit fields as own properties", () => {
      const hex = "1a0208011a02100222020803220210042805"
      const value = decode("legacy.OriginalNames", hex)
      assert.deepStrictEqual(value, {
        constructor: { x: 1, y: 2 },
        ["__proto__"]: { x: 3, y: 4 },
        toString: 5
      })
      assert.strictEqual(Object.getPrototypeOf(value), Object.prototype)
      assert.strictEqual(Object.hasOwn(value, "__proto__"), true)
      assert.strictEqual(encode("legacy.OriginalNames", value), "1a04080110022204080310042805")
      assert.deepStrictEqual(decode("legacy.OriginalNames", ""), {})
      assert.strictEqual(encode("legacy.OriginalNames", {}), "")
    })

    it("preserves oneof names and case tags without changing the object prototype", () => {
      const value = { ["__proto__"]: { _tag: "child_value", value: { x: 1, y: 2 } } }
      assert.deepStrictEqual(decode("test.NamedOneof", "0a0208010a021002"), value)
      assert.strictEqual(encode("test.NamedOneof", value), "0a0408011002")
      const replaced = decode("test.NamedOneof", "0a001003")
      assert.deepStrictEqual(replaced, { ["__proto__"]: { _tag: "toString", value: 3 } })
      assert.strictEqual(Object.getPrototypeOf(replaced), Object.prototype)
      assert.strictEqual(encode("test.NamedOneof", {}), "")
    })

    it("preserves repeated field, map field and map key names", () => {
      const value = { ["__proto__"]: ["a"], constructor: { ["__proto__"]: { x: 1, y: 0 } } }
      const encoded = encode("test.NamedCollections", value)
      const decoded = decode("test.NamedCollections", encoded)
      assert.deepStrictEqual(decoded, value)
      assert.strictEqual(Object.getPrototypeOf(decoded), Object.prototype)
      assert.strictEqual(Object.getPrototypeOf(decoded.constructor), Object.prototype)
      assert.deepStrictEqual(decode("test.NamedCollections", ""), { ["__proto__"]: [], constructor: {} })
      assert.strictEqual(encode("test.NamedCollections", {}), "")
    })

    it("does not satisfy required fields with inherited properties", () => {
      assert.isTrue(Result.isFailure(ProtobufMessage.decode(message("legacy.RequiredName"))(bytes(""))))
      assert.isTrue(Result.isFailure(ProtobufMessage.encode(message("legacy.RequiredName"))({})))
      assert.deepStrictEqual(decode("legacy.RequiredName", "0801"), { constructor: 1 })
    })
  })

  describe("validates the completed message", () => {
    const zeros = { children: [], items: {} }
    const cases: ReadonlyArray<readonly [string, string, object]> = [
      ["replaced oneof", "0a001001", { kind: { _tag: "other_value", value: 1 } }],
      ["replaced ancestor", "0a04080112001001", { kind: { _tag: "other_value", value: 1 } }],
      ["merged oneof", "0a000a020801", { kind: { _tag: "child_value", value: { n: 1 } } }],
      ["empty merged occurrence", "0a0208010a00", { kind: { _tag: "child_value", value: { n: 1 } } }],
      ["merged singular message", "1a001a020801", { singular: { n: 1 } }],
      ["replaced map entry", "2a050a016112002a070a016112020801", { items: { a: { n: 1 } } }],
      ["replaced default map value", "2a030a01612a070a016112020801", { items: { a: { n: 1 } } }],
      ["merged map value", "2a090a0161120012020801", { items: { a: { n: 1 } } }]
    ]
    for (const [name, hex, expected] of cases) {
      it(name, () => {
        const value = decode("legacy.RequiredContainer", hex)
        assert.deepStrictEqual(value, { ...zeros, ...expected })
        assert.deepStrictEqual(decode("legacy.RequiredContainer", encode("legacy.RequiredContainer", value)), value)
      })
    }

    const invalid: ReadonlyArray<readonly [string, string, ReadonlyArray<PropertyKey>]> = [
      ["active oneof", "0a00", ["kind", "n"]],
      ["oneof switched back", "0a02080110010a00", ["kind", "n"]],
      ["singular message", "1a00", ["singular", "n"]],
      ["nested message", "1a0408011200", ["singular", "child", "n"]],
      ["repeated element", "220022020801", ["children", 0, "n"]],
      ["default map value", "2a030a0161", ["items", "a", "n"]],
      ["explicit empty map value", "2a050a01611200", ["items", "a", "n"]],
      ["replacement map value", "2a070a0161120208012a030a0161", ["items", "a", "n"]]
    ]
    for (const [name, hex, path] of invalid) {
      it(`rejects ${name} with the missing field path`, () => {
        const error = failure(ProtobufMessage.decode(message("legacy.RequiredContainer"))(bytes(hex)))
        assert.deepStrictEqual(error.path, path)
        assert.include(error.message, "Expected required field n of legacy.RequiredChild")
      })
    }
  })

  it("applies maxDepth to unknown groups inside known messages", () => {
    const value = "12 04 0b0b0c0c"
    assert.isTrue(Result.isFailure(ProtobufMessage.decode(message("test.Shape"), { maxDepth: 2 })(bytes(value))))
    assert.deepStrictEqual(decode("test.Shape", value, { maxDepth: 3 }).origin, {
      x: 0,
      y: 0,
      [unknownFields]: bytes("0b0b0c0c")
    })
  })

  it("applies maxDepth to both explicit and default map message values", () => {
    for (const hex of ["5a020801", "5a0408011200"]) {
      const error = failure(ProtobufMessage.decode(message("test.Shape"), { maxDepth: 0 })(bytes(hex)))
      assert.deepStrictEqual(error.path, ["flags", "true"])
      assert.deepStrictEqual(decode("test.Shape", hex, { maxDepth: 1 }).flags, { true: { x: 0, y: 0 } })
    }
  })

  it("rejects invalid nesting limits consistently", () => {
    for (const maxDepth of [-1, 0.5, NaN, Infinity]) {
      assert.isTrue(Result.isFailure(ProtobufMessage.decode(message("test.Point"), { maxDepth })(bytes(""))))
      assert.isTrue(Result.isFailure(ProtobufMessage.encode(message("test.Point"), { maxDepth })({})))
    }
  })

  describe("decodes", () => {
    const cases: ReadonlyArray<readonly [string, string, string, object]> = [
      ["merged occurrences of a message", "test.Shape", "12020801 12021002", { ...shapeZeros, origin: { x: 1, y: 2 } }],
      ["the last occurrence of a scalar", "test.Shape", "0a0161 0a0162", { ...shapeZeros, name: "b" }],
      ["the last case of a oneof", "test.Shape", "22026869 2a020801", {
        ...shapeZeros,
        kind: { _tag: "center", value: { x: 1, y: 0 } }
      }],
      ["merged occurrences of a oneof message", "test.Shape", "2a020801 2a021002", {
        ...shapeZeros,
        kind: { _tag: "center", value: { x: 1, y: 2 } }
      }],
      ["a packed field written unpacked", "test.Shape", "3001 3002", { ...shapeZeros, ids: [1, 2] }],
      ["an unpacked field written with mixed encodings", "legacy.Legacy", "0801 1801 1a020203 1804", {
        ...legacyZeros,
        id: 1,
        values: [1, 2, 3, 4]
      }],
      ["map entries without a value or key", "test.Shape", "4a03 0a0161 4a02 1001", {
        ...shapeZeros,
        counts: { a: 0, "": 1 }
      }],
      ["a field of another wire type, as an unknown field", "test.Shape", "0d00000000", {
        ...shapeZeros,
        [unknownFields]: bytes("0d00000000")
      }],
      ["an undeclared field, as an unknown field", "test.Point", "f80701", {
        x: 0,
        y: 0,
        [unknownFields]: bytes("f80701")
      }],
      ["an unknown number of a closed enum, as an unknown field", "legacy.Legacy", "0801 3007", {
        ...legacyZeros,
        id: 1,
        [unknownFields]: bytes("3007")
      }],
      ["unknown numbers of a packed closed enum, as unpacked fields", "legacy.Legacy", "0801 3a03 010702", {
        ...legacyZeros,
        id: 1,
        modes: [1, 2],
        [unknownFields]: bytes("3807")
      }],
      [
        "a map entry with an unknown closed enum number, as an unknown field",
        "legacy.Legacy",
        "0801 4205 0a0161 1007",
        {
          ...legacyZeros,
          id: 1,
          [unknownFields]: bytes("4205 0a0161 1007")
        }
      ],
      ["an unknown number of a closed enum in editions", "editions.E", "2807", {
        b: 0,
        c: [],
        [unknownFields]: bytes("2807")
      }],
      ["invalid UTF-8 without validation", "legacy.Legacy", "0801 1201ff", { ...legacyZeros, id: 1, name: "�" }]
    ]
    for (const [name, typeName, hex, value] of cases) {
      it(name, () => {
        assert.deepStrictEqual(decode(typeName, hex), value)
      })
    }
  })

  it("writes unknown fields back, last", () => {
    const value = decode("test.Shape", "0a0161 f80701 1a00")
    assert.strictEqual(encode("test.Shape", value), "0a0161 1a00 f80701".replaceAll(" ", ""))
  })

  it("owns decoded byte fields and retained unknown bytes", () => {
    const input = bytes("62020102f80701")
    const value = Result.getOrThrow(ProtobufMessage.decode(message("test.Scalars"))(input))
    input.fill(0)
    assert.deepStrictEqual(value.bytes, bytes("0102"))
    assert.deepStrictEqual(value[unknownFields], bytes("f80701"))
  })

  it("owns bytes in repeated fields, maps and oneofs after finalization", () => {
    const input = bytes("0a010112060a01611201021a0103")
    const value = Result.getOrThrow(ProtobufMessage.decode(message("test.ByteCollections"))(input))
    input.fill(0)
    assert.deepStrictEqual(value, {
      items: [bytes("01")],
      values: { a: bytes("02") },
      kind: { _tag: "selected", value: bytes("03") }
    })
  })

  it("distinguishes omitted fields from explicit zero values when merging messages", () => {
    assert.deepStrictEqual(decode("test.Shape", "120208011200").origin, { x: 1, y: 0 })
    assert.deepStrictEqual(decode("test.Shape", "1202080112020800").origin, { x: 0, y: 0 })
    assert.deepStrictEqual(decode("legacy.RequiredContainer", "0a000a020800").kind, {
      _tag: "child_value",
      value: { n: 0 }
    })
  })

  it("keeps unknown spans with the message that owns them", () => {
    const merged = decode("test.Shape", "120408011801120410022002")
    assert.deepStrictEqual(merged.origin, { x: 1, y: 2, [unknownFields]: bytes("18012002") })
    const replaced = decode("legacy.RequiredContainer", "0a040801180110017803")
    assert.deepStrictEqual(replaced.kind, { _tag: "other_value", value: 1 })
    assert.deepStrictEqual(replaced[unknownFields], bytes("7803"))
  })

  it("does not change a oneof case when a closed-enum occurrence is unknown", () => {
    assert.deepStrictEqual(
      failure(ProtobufMessage.decode(message("legacy.RequiredContainer"))(bytes("0a003007"))).path,
      ["kind", "n"]
    )
    const value = decode("legacy.RequiredContainer", "0a0208013007")
    assert.deepStrictEqual(value.kind, { _tag: "child_value", value: { n: 1 } })
    assert.deepStrictEqual(value[unknownFields], bytes("3007"))
    assert.deepStrictEqual(decode("legacy.RequiredContainer", "0a003001").kind, { _tag: "mode_value", value: 1 })
  })

  it("does not replace a map entry with an unknown closed-enum value", () => {
    const value = decode("legacy.Legacy", "080142050a0161100142050a01611007")
    assert.deepStrictEqual(value.mode_by_name, { a: 1 })
    assert.deepStrictEqual(value[unknownFields], bytes("42050a01611007"))
  })

  it("classifies closed-enum map entries by their final value", () => {
    const known = decode("legacy.Legacy", "0801 4207 0a0161 1007 1001")
    assert.deepStrictEqual(known.mode_by_name, { a: 1 })
    assert.isFalse(unknownFields in known)
    const unknown = decode("legacy.Legacy", "0801 4207 0a0161 1001 1007")
    assert.deepStrictEqual(unknown.mode_by_name, {})
    assert.deepStrictEqual(unknown[unknownFields], bytes("4207 0a0161 1001 1007"))
  })

  it("retains large packed closed-enum fields without exceeding argument limits", () => {
    const count = 150000
    // id = 1, followed by 150000 packed occurrences of the unknown enum number 7.
    const input = new Uint8Array(count + 6)
    input.set([0x08, 0x01, 0x3a, 0xf0, 0x93, 0x09])
    input.fill(7, 6)
    const value = Result.getOrThrow(ProtobufMessage.decode(message("legacy.Legacy"))(input))
    assert.deepStrictEqual(value.modes, [])
    const expected = new Uint8Array(count * 2)
    for (let i = 0; i < expected.length; i += 2) {
      expected[i] = 0x38
      expected[i + 1] = 7
    }
    assert.deepStrictEqual(value[unknownFields], expected)
    const dropped = Result.getOrThrow(
      ProtobufMessage.decode(message("legacy.Legacy"), { readUnknownFields: false })(input)
    )
    assert.isUndefined(dropped[unknownFields])
  })

  it("drops unknown fields with readUnknownFields: false and writeUnknownFields: false", () => {
    assert.deepStrictEqual(decode("test.Point", "f80701", { readUnknownFields: false }), { x: 0, y: 0 })
    assert.strictEqual(encode("test.Point", { [unknownFields]: bytes("f80701") }, { writeUnknownFields: false }), "")
  })

  describe("fails to decode", () => {
    it("rejects malformed bytes even if a later occurrence would replace the value", () => {
      for (const hex of ["0a01081001", "2a040a0161122a070a016112020801"]) {
        assert.isTrue(Result.isFailure(ProtobufMessage.decode(message("legacy.RequiredContainer"))(bytes(hex))))
      }
    })

    const cases: ReadonlyArray<readonly [string, string, string, string, ReadonlyArray<PropertyKey>]> = [
      ["a truncated varint", "test.Point", "08", "x: Expected a complete value at offset 1", ["x"]],
      ["invalid UTF-8", "test.Shape", "0a01ff", "name: Expected valid UTF-8 at offset 2", ["name"]],
      [
        "a value past the end of its message",
        "test.Shape",
        "1201 0801",
        "origin.x: Expected a complete value at offset 3",
        [
          "origin",
          "x"
        ]
      ],
      ["a list element", "test.Shape", "1a02 0801 1a01 08", "points[1].x: Expected a complete value at offset 7", [
        "points",
        1,
        "x"
      ]],
      [
        "a partial packed double",
        "test.Shape",
        "3a09 000000000000f03f 01",
        "weights[1]: Expected a complete value at offset 10",
        [
          "weights",
          1
        ]
      ],
      ["a missing required field", "legacy.Legacy", "1200", "id: Expected required field id of legacy.Legacy", ["id"]],
      [
        "a stray end group tag",
        "test.Point",
        "3c",
        "Expected a start group tag before the end group tag of field 7",
        []
      ]
    ]
    for (const [name, typeName, hex, message_, path] of cases) {
      it(name, () => {
        assert.deepStrictEqual(failure(ProtobufMessage.decode(message(typeName))(bytes(hex))), {
          message: message_,
          path
        })
      })
    }

    it("messages nested deeper than maxDepth", () => {
      const tree = { children: [{ children: [{ children: [] }] }] }
      const encoded = Result.getOrThrow(ProtobufMessage.encode(message("test.Tree"))(tree))
      assert.deepStrictEqual(
        Result.getOrThrow(ProtobufMessage.encode(message("test.Tree"), { maxDepth: 2 })(tree)),
        encoded
      )
      assert.deepStrictEqual(failure(ProtobufMessage.encode(message("test.Tree"), { maxDepth: 1 })(tree)), {
        message: "children[0].children[0]: Expected messages nested at most 1 deep",
        path: ["children", 0, "children", 0]
      })
      assert.deepStrictEqual(failure(ProtobufMessage.decode(message("test.Tree"), { maxDepth: 1 })(encoded)), {
        message: "children[0].children[0]: Expected messages nested at most 1 deep",
        path: ["children", 0, "children", 0]
      })
    })
  })

  describe("fails to encode", () => {
    it("enforces closed enums for singular, packed and map values", () => {
      for (const value of [{ id: 1, mode: 7 }, { id: 1, modes: [1, 7] }, { id: 1, mode_by_name: { a: 7 } }]) {
        assert.isTrue(Result.isFailure(ProtobufMessage.encode(message("legacy.Legacy"))(value)))
      }
      const open = { ...shapeZeros, color: 7, colors: [7] }
      assert.deepStrictEqual(decode("test.Shape", encode("test.Shape", open)), open)
    })
    const cases: ReadonlyArray<readonly [string, string, unknown, string, ReadonlyArray<PropertyKey>]> = [
      ["a value of another type", "test.Shape", { name: 1 }, "name: Expected a string, got 1", ["name"]],
      [
        "a list element",
        "test.Shape",
        { points: [{ x: 1 }, { x: 1.5 }] },
        "points[1].x: Expected an integer for an int32, got 1.5",
        [
          "points",
          1,
          "x"
        ]
      ],
      ["a packed element", "test.Shape", { ids: [1, "2"] }, "ids[1]: Expected an integer for an int32, got \"2\"", [
        "ids",
        1
      ]],
      [
        "an unknown oneof case",
        "test.Shape",
        { kind: { _tag: "nope", value: 1 } },
        "kind: Expected a case of oneof kind, got \"nope\"",
        [
          "kind"
        ]
      ],
      ["a map value", "test.Shape", { counts: { a: "x" } }, "counts.a: Expected an integer for an int32, got \"x\"", [
        "counts",
        "a"
      ]],
      ["a map key", "test.Shape", { by_id: { x: "a" } }, "by_id.x: Expected an integer key for an int64, got \"x\"", [
        "by_id",
        "x"
      ]],
      ["a uint64 out of range", "test.Scalars", { uint64: -1n }, "uint64: Expected a uint64 in range, got -1n", [
        "uint64"
      ]],
      [
        "a float out of range",
        "test.Scalars",
        { float: 1e39 },
        "float: Expected a number in the range of a float, got 1e+39",
        [
          "float"
        ]
      ],
      ["a missing required field", "legacy.Legacy", {}, "id: Expected a value for required field id", ["id"]],
      ["something other than an object", "test.Point", null, "Expected an object for test.Point, got null", []]
    ]
    for (const [name, typeName, value, message_, path] of cases) {
      it(name, () => {
        assert.deepStrictEqual(
          failure(ProtobufMessage.encode(message(typeName))(value as ProtobufMessage.Message)),
          { message: message_, path }
        )
      })
    }
  })

  describe("extensions", () => {
    const priority = registry.getExtension("legacy.priority")!
    const labels = registry.getExtension("legacy.labels")!
    const member = registry.getExtension("legacy.SetMember.member")!

    it("validates message extensions after all occurrences have merged", () => {
      const extension = registry.getExtension("legacy.required_child")!
      const read = (hex: string) => ProtobufMessage.getExtension({ [unknownFields]: bytes(hex) }, extension)
      assert.deepStrictEqual(Result.getOrThrow(read("b20600b206020801")), { n: 1 })
      assert.deepStrictEqual(failure(read("b20600")).path, ["required_child", "n"])
    })

    it("sets, replaces and clears an extension in the unknown fields", () => {
      const set = Result.getOrThrow(ProtobufMessage.setExtension({ id: 1 }, priority, 3))
      assert.strictEqual(encode("legacy.Legacy", set), "0801a00603")
      assert.strictEqual(Result.getOrThrow(ProtobufMessage.getExtension(set, priority)), 3)
      const replaced = Result.getOrThrow(ProtobufMessage.setExtension(set, priority, 4))
      assert.deepStrictEqual(replaced[unknownFields], bytes("a00604"))
      const cleared = Result.getOrThrow(ProtobufMessage.setExtension(replaced, priority, undefined))
      assert.isFalse(unknownFields in cleared)
      assert.isUndefined(Result.getOrThrow(ProtobufMessage.getExtension(cleared, priority)))
    })

    it("reads an extension of decoded bytes", () => {
      assert.strictEqual(
        Result.getOrThrow(ProtobufMessage.getExtension(decode("legacy.Legacy", "0801 a00603"), priority)),
        3
      )
    })

    it("reads and writes a repeated extension", () => {
      assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension({ id: 1 }, labels)), [])
      const set = Result.getOrThrow(ProtobufMessage.setExtension({ id: 1 }, labels, ["a", "b"]))
      assert.deepStrictEqual(set[unknownFields], bytes("aa060161 aa060162"))
      assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension(set, labels)), ["a", "b"])
    })

    it("writes the extensions of a MessageSet as items", () => {
      const set = Result.getOrThrow(ProtobufMessage.setExtension({}, member, { text: "a" }))
      assert.deepStrictEqual(set[unknownFields], bytes("0b 10e807 1a030a0161 0c"))
      assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension(set, member)), { text: "a" })
    })

    for (
      const [number, typeId] of [
        [536870912, "8080808002"],
        [536870913, "8180808002"],
        [2147483646, "feffffff07"]
      ] as const
    ) {
      it(`reads, writes, replaces and clears MessageSet extension ${number}`, () => {
        const descriptors = Result.getOrThrow(ProtobufDescriptor.make([{
          name: "message-set.proto",
          message_type: [
            {
              name: "Container",
              options: { message_set_wire_format: true },
              extension_range: [{ start: 4, end: 2147483647 }]
            },
            {
              name: "Payload",
              field: [
                { name: "x", number: 1, type: 5, label: 2 },
                { name: "y", number: 2, type: 5, label: 1 }
              ]
            }
          ],
          extension: [{ name: "payload", number, type: 11, type_name: ".Payload", label: 1, extendee: ".Container" }]
        }]))
        const extension = descriptors.getExtension("payload")!
        const container = descriptors.getMessage("Container")!
        const other = "0b 10e807 1a030a0161 0c"
        const wire = bytes(`${other} 0b 10${typeId} 1a020807 0c`)
        const decoded = Result.getOrThrow(ProtobufMessage.decode(container)(wire))
        assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension(decoded, extension)), { x: 7 })
        const set = Result.getOrThrow(
          ProtobufMessage.setExtension({ [unknownFields]: bytes(other) }, extension, { x: 7 })
        )
        assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.encode(container)(set)), wire)
        assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension(set, extension)), { x: 7 })
        const replaced = Result.getOrThrow(ProtobufMessage.setExtension(decoded, extension, { x: 8 }))
        assert.deepStrictEqual(replaced[unknownFields], bytes(`${other} 0b 10${typeId} 1a020808 0c`))
        const cleared = Result.getOrThrow(ProtobufMessage.setExtension(replaced, extension, undefined))
        assert.deepStrictEqual(cleared[unknownFields], bytes(other))
        assert.isUndefined(Result.getOrThrow(ProtobufMessage.getExtension(cleared, extension)))

        // MessageSet payloads merge before required fields are checked.
        const merged = { [unknownFields]: bytes(`0b 10${typeId} 1a021009 0c 0b 10${typeId} 1a020807 0c`) }
        assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension(merged, extension)), { x: 7, y: 9 })
        assert.deepStrictEqual(
          failure(ProtobufMessage.getExtension({ [unknownFields]: bytes(`0b 10${typeId} 1a00 0c`) }, extension)).path,
          ["payload", "x"]
        )
        assert.deepStrictEqual(failure(ProtobufMessage.setExtension({}, extension, { x: "bad" })).path, [
          "payload",
          "x"
        ])
      })
    }

    it("reads MessageSet extensions encoded as ordinary message fields", () => {
      const set = { [unknownFields]: bytes("c23e030a0161") }
      assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension(set, member)), { text: "a" })
      const cleared = Result.getOrThrow(ProtobufMessage.setExtension(set, member, undefined))
      assert.isFalse(unknownFields in cleared)
    })

    it("uses the first type id and payload within each MessageSet item", () => {
      for (
        const hex of [
          "0b 10e807 1a030a0161 1a030a0162 0c",
          "0b 10e807 1a030a0161 10e907 0c",
          "0b 10e807 10e907 1a030a0161 0c",
          "0b 1a030a0161 1a030a0162 10e807 0c",
          "0b 1a030a0161 10e807 10e907 0c"
        ]
      ) {
        const set = { [unknownFields]: bytes(hex) }
        assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension(set, member)), { text: "a" })
        assert.isFalse(unknownFields in Result.getOrThrow(ProtobufMessage.setExtension(set, member, undefined)))
      }
    })

    it("ignores incomplete MessageSet items and rejects zero type ids", () => {
      for (const hex of ["0b 10e807 0c", "0b 1a030a0161 0c"]) {
        const set = { [unknownFields]: bytes(hex) }
        assert.isUndefined(Result.getOrThrow(ProtobufMessage.getExtension(set, member)))
        assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.setExtension(set, member, undefined)), set)
      }
      for (const hex of ["0b 1000 1a030a0161 0c", "0b 10e807 1a030a0161 1000 0c"]) {
        assert.isTrue(Result.isFailure(ProtobufMessage.getExtension({ [unknownFields]: bytes(hex) }, member)))
      }
    })

    it("validates the first MessageSet payload even when a later payload is valid", () => {
      const set = { [unknownFields]: bytes("0b 10e807 1a020a02 1a030a0161 0c") }
      assert.deepStrictEqual(failure(ProtobufMessage.getExtension(set, member)).path, ["member", "text"])
    })

    it("rejects field values split across MessageSet payloads", () => {
      // The payloads 0a02 and 6162 only form a valid string field when joined.
      for (
        const hex of [
          "0b10e8071a020a020c0b10e8071a0261620c",
          "c23e020a02c23e026162",
          "0b10e8071a020a020cc23e026162"
        ]
      ) {
        const result = ProtobufMessage.getExtension({ [unknownFields]: bytes(hex) }, member)
        assert.deepStrictEqual(failure(result).path, ["member", "text"])
      }
    })

    it("retains owned unknown fields from every merged MessageSet payload", () => {
      const input = bytes("0b10e8071a0210010cc23e050a01611802")
      const value = Result.getOrThrow(ProtobufMessage.getExtension({ [unknownFields]: input }, member))
      input.fill(0)
      assert.deepStrictEqual(value, { text: "a", [unknownFields]: bytes("10011802") })
    })

    it("preserves incompatible wire types when replacing extensions", () => {
      const unknown = { [unknownFields]: bytes("a2060178") }
      assert.isUndefined(Result.getOrThrow(ProtobufMessage.getExtension(unknown, priority)))
      const set = Result.getOrThrow(ProtobufMessage.setExtension(unknown, priority, 3))
      assert.deepStrictEqual(set[unknownFields], bytes("a2060178a00603"))
      assert.strictEqual(Result.getOrThrow(ProtobufMessage.getExtension(set, priority)), 3)
      const cleared = Result.getOrThrow(ProtobufMessage.setExtension(set, priority, undefined))
      assert.deepStrictEqual(cleared[unknownFields], unknown[unknownFields])
    })

    it("preserves unknown closed-enum numbers when replacing extensions", () => {
      const extension = registry.getExtension("legacy.mode_ext")!
      const original = { [unknownFields]: bytes("b80607b80601") }
      assert.strictEqual(Result.getOrThrow(ProtobufMessage.getExtension(original, extension)), 1)
      const set = Result.getOrThrow(ProtobufMessage.setExtension(original, extension, 2))
      assert.deepStrictEqual(set[unknownFields], bytes("b80607b80602"))
      const cleared = Result.getOrThrow(ProtobufMessage.setExtension(set, extension, undefined))
      assert.deepStrictEqual(cleared[unknownFields], bytes("b80607"))
      assert.isUndefined(Result.getOrThrow(ProtobufMessage.getExtension(cleared, extension)))
    })

    it("preserves unknown numbers from packed closed-enum extensions", () => {
      const extension = registry.getExtension("legacy.modes_ext")!
      const original = { [unknownFields]: bytes("c20603010702") }
      assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension(original, extension)), [1, 2])
      const set = Result.getOrThrow(ProtobufMessage.setExtension(original, extension, [2]))
      assert.deepStrictEqual(set[unknownFields], bytes("c00607c2060102"))
      const cleared = Result.getOrThrow(ProtobufMessage.setExtension(set, extension, undefined))
      assert.deepStrictEqual(cleared[unknownFields], bytes("c00607"))
      assert.deepStrictEqual(Result.getOrThrow(ProtobufMessage.getExtension(cleared, extension)), [])
    })

    it("fails for a value of another type", () => {
      assert.deepStrictEqual(failure(ProtobufMessage.setExtension({}, priority, "x")), {
        message: "priority: Expected an integer for an int32, got \"x\"",
        path: ["priority"]
      })
    })
  })
})
