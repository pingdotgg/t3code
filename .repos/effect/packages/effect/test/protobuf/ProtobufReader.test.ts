import { assert, describe, it } from "@effect/vitest"
import * as Hex from "effect/encoding/Hex"
import { ProtobufReader, ProtobufWriter } from "effect/protobuf"
import * as Result from "effect/Result"

type Reader = ProtobufReader.ProtobufReader

const reader = (hex: string): Reader => ProtobufReader.make(Result.getOrThrow(Hex.decode(hex)))

const failure = (hex: string, f: (r: Reader) => unknown): string => {
  try {
    f(reader(hex))
  } catch (e) {
    assert.instanceOf(e, ProtobufReader.ProtobufReaderError)
    return e.message
  }
  throw new Error("expected a ProtobufReaderError")
}

// A varint read after the tag of a nested message, as a uint32 and an int64
const nested = (name: string, hex: string, message: string): Array<[string, string, (r: Reader) => unknown, string]> =>
  [(r: Reader) => r.uint32(), (r: Reader) => r.int64()].map((read, i) => [
    `${name} the end of a nested message (${i === 0 ? "uint32" : "int64"})`,
    hex,
    (r: Reader) => {
      r.tag()
      const child = r.delimited()
      child.tag()
      read(child)
    },
    message
  ])

describe("ProtobufReader", () => {
  it.each<[string, string, (r: Reader) => unknown, unknown]>([
    ["uint32 150", "9601", (r) => r.uint32(), 150],
    ["uint32 of a ten-byte varint, truncated", "ffffffffffffffffff01", (r) => r.uint32(), 4294967295],
    ["int32 -1", "ffffffffffffffffff01", (r) => r.int32(), -1],
    ["sint32 -2147483648", "ffffffff0f", (r) => r.sint32(), -2147483648],
    ["int64 -1n", "ffffffffffffffffff01", (r) => r.int64(), -1n],
    ["uint64 max", "ffffffffffffffffff01", (r) => r.uint64(), 2n ** 64n - 1n],
    ["sint64 -2^63", "ffffffffffffffffff01", (r) => r.sint64(), -(2n ** 63n)],
    ["sint64 2^63 - 1", "feffffffffffffffff01", (r) => r.sint64(), 2n ** 63n - 1n],
    ["bool of a nonzero high half", "8080808010", (r) => r.bool(), true],
    ["fixed32 max", "ffffffff", (r) => r.fixed32(), 4294967295],
    ["sfixed32 -2", "feffffff", (r) => r.sfixed32(), -2],
    ["fixed64 max", "ffffffffffffffff", (r) => r.fixed64(), 2n ** 64n - 1n],
    ["sfixed64 -2n", "feffffffffffffff", (r) => r.sfixed64(), -2n],
    ["uint64Number max, rounded", "ffffffffffffffffff01", (r) => r.uint64Number(), 2 ** 64],
    ["int64Number -1", "ffffffffffffffffff01", (r) => r.int64Number(), -1],
    ["sint64Number -2^63", "ffffffffffffffffff01", (r) => r.sint64Number(), -(2 ** 63)],
    ["sint64Number 1", "02", (r) => r.sint64Number(), 1],
    ["fixed64Number max, rounded", "ffffffffffffffff", (r) => r.fixed64Number(), 2 ** 64],
    ["sfixed64Number -2", "feffffffffffffff", (r) => r.sfixed64Number(), -2],
    ["float 1", "0000803f", (r) => r.float(), 1],
    ["double -0.5", "000000000000e0bf", (r) => r.double(), -0.5],
    ["string", "09c3a9e697a5f09f9880", (r) => r.string(), "é日😀"]
  ])("reads %s", (_, hex, read, expected) => {
    const r = reader(hex)
    assert.strictEqual(read(r), expected)
    assert.isTrue(r.isDone())
  })

  it("rounds 64-bit numbers as Number rounds a bigint", () => {
    const values = [
      2n ** 53n + 1n,
      2n ** 53n + 3n,
      2n ** 63n - 1n,
      -(2n ** 53n) - 3n,
      2n ** 60n + 2n ** 8n + 1n,
      -(2n ** 63n)
    ]
    for (const n of values) {
      const r = ProtobufReader.make(ProtobufWriter.make().int64(n).sint64(n).sfixed64(n).finish())
      assert.strictEqual(r.int64Number(), Number(n))
      assert.strictEqual(r.sint64Number(), Number(n))
      assert.strictEqual(r.sfixed64Number(), Number(n))
    }
  })

  it("reads bytes as a copy", () => {
    const input = new Uint8Array([2, 1, 2])
    const bytes = ProtobufReader.make(input).bytes()
    input[1] = 9
    assert.deepStrictEqual(bytes, new Uint8Array([1, 2]))
  })

  it("exposes borrowed bytes explicitly and respects nested limits", () => {
    const input = new Uint8Array([3, 2, 1, 2, 7])
    const r = ProtobufReader.make(input)
    const child = r.delimited()
    const view = child.bytesView()
    assert.isTrue(child.isDone())
    input[2] = 9
    assert.deepStrictEqual(view, new Uint8Array([9, 2]))
    view[1] = 8
    assert.strictEqual(input[3], 8)
    assert.strictEqual(r.uint32(), 7)
  })

  it("replaces malformed UTF-8 only when requested", () => {
    const r = reader("02ff6110")
    assert.strictEqual(r.string({ validateUtf8: false }), "�a")
    assert.strictEqual(r.uint32(), 16)
    assert.throws(() => reader("03ff61").string({ validateUtf8: false }), /complete value/)
  })

  it("skips deep groups with a caller-supplied bound", () => {
    const r = reader("0b".repeat(4096) + "0c".repeat(4096) + "082a")
    r.skip(r.tag(), 4096)
    assert.strictEqual(r.tag(), 8)
    assert.strictEqual(r.uint32(), 42)
    assert.throws(() => {
      const r = reader("0b0c")
      r.skip(r.tag(), 0)
    }, /groups nested at most 0/)
    assert.throws(() => {
      const r = reader("0b0b0c0c")
      r.skip(r.tag(), 1)
    }, /groups nested at most 1/)
  })

  it("splits a tag into its field number and wire type", () => {
    const tag = reader("8201").tag()
    assert.strictEqual(ProtobufReader.fieldNumber(tag), 16)
    assert.strictEqual(ProtobufReader.wireType(tag), ProtobufReader.WireType.Len)
  })

  it("bounds child readers independently of the parent", () => {
    // { 1: { 1: 150 }, 2: { 1: 150 }, 3: 7 }
    const r = reader("0a0308960112030896011807")
    r.tag()
    const first = r.delimited()
    assert.strictEqual(first.offset, 2)
    assert.strictEqual(r.offset, 5)
    assert.strictEqual(ProtobufReader.fieldNumber(first.tag()), 1)
    assert.strictEqual(first.uint32(), 150)
    assert.isTrue(first.isDone())
    assert.throws(() => first.uint32(), /complete value at offset 5/)
    r.tag()
    const second = r.delimited()
    assert.strictEqual(ProtobufReader.fieldNumber(r.tag()), 3)
    assert.strictEqual(r.uint32(), 7)
    assert.isTrue(r.isDone())
    // The child remains readable after the parent has advanced.
    assert.strictEqual(second.tag(), 8)
    assert.strictEqual(second.uint32(), 150)
    assert.isTrue(second.isDone())
  })

  it("keeps absolute offsets across several child readers", () => {
    const root = reader("03020196")
    const child = root.delimited().delimited().delimited()
    assert.strictEqual(child.offset, 3)
    assert.throws(() => child.uint32(), /complete value at offset 4/)
    assert.isTrue(root.isDone())
  })

  it("skips every wire type, including nested groups", () => {
    const r = reader(
      "08ffffffffffffffffff01" + // 1: varint
        "11000000000000f03f" + // 2: i64
        "1a0161" + // 3: len
        "232b0d010000002c24" + // 4: group { 5: group { 1: i32 } }
        "302a" // 6: 42
    )
    for (let i = 0; i < 4; i++) r.skip(r.tag())
    assert.strictEqual(ProtobufReader.fieldNumber(r.tag()), 6)
    assert.strictEqual(r.uint32(), 42)
    assert.isTrue(r.isDone())
  })

  it.each<[string, string, (r: Reader) => unknown, string]>([
    ["a truncated varint", "96", (r) => r.uint32(), "Expected a complete value at offset 1"],
    [
      "a uint32 varint longer than ten bytes",
      "ffffffffffffffffffff01",
      (r) => r.uint32(),
      "Expected a varint of at most 10 bytes at offset 10"
    ],
    [
      "an int64 varint longer than ten bytes",
      "ffffffffffffffffffff01",
      (r) => r.int64(),
      "Expected a varint of at most 10 bytes at offset 10"
    ],
    ["a truncated fixed64", "01020304", (r) => r.fixed64(), "Expected a complete value at offset 0"],
    ["a length past the end", "0561", (r) => r.string(), "Expected a complete value at offset 1"],
    // { 1: { 1: <truncated> }, 2: 7, ... }, long enough for the unchecked varint path
    ...nested("a varint running past", "0a02089610071007100710071007", "Expected a complete value at offset 4"),
    // { 1: { 1: <missing> }, 2: 7 }
    ...nested("a varint after", "0a01081007", "Expected a complete value at offset 3"),
    [
      "a length past the end of a nested message",
      // { 1: { 1: "abcde" } } with a nested length of 2
      "0a020a056162636465",
      (r) => {
        r.tag()
        const child = r.delimited()
        child.tag()
        child.string()
      },
      "Expected a complete value at offset 4"
    ],
    ["a length over 32 bits", "ffffffff1f", (r) => r.bytes(), "Expected a varint of at most 32 bits at offset 5"],
    ["invalid UTF-8", "01ff", (r) => r.string(), "Expected valid UTF-8 at offset 1"],
    [
      "field number 0",
      "00",
      (r) => r.tag(),
      "Expected a tag with a nonzero field number and a wire type up to 5 at offset 1"
    ],
    [
      "wire type 6",
      "0e",
      (r) => r.tag(),
      "Expected a tag with a nonzero field number and a wire type up to 5 at offset 1"
    ],
    [
      "an end group tag without a start",
      "0c",
      (r) => r.skip(r.tag()),
      "Expected a start group tag before the end group tag of field 1 at offset 1"
    ],
    ["a mismatched end group tag", "0b14", (r) => r.skip(r.tag()), "Expected an end group tag for field 1 at offset 2"],
    ["an unterminated group", "0b", (r) => r.skip(r.tag()), "Expected a complete value at offset 1"],
    [
      "groups nested deeper than 512",
      "0b".repeat(513),
      (r) => r.skip(r.tag()),
      "Expected groups nested at most 512 deep at offset 513"
    ]
  ])("rejects %s", (_, hex, read, message) => {
    assert.strictEqual(failure(hex, read), message)
  })
})
