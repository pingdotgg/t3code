import { PgProtocol, PgTypes as PgTypesResult } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import { bytes, rows } from "./fixtures/goldens.ts"

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const PgTypes = {
  ...PgTypesResult,
  encode: (value: unknown, oid: number) => success(PgTypesResult.encode(value, oid)),
  decode: (value: Uint8Array, oid: number, format: number) => success(PgTypesResult.decode(value, oid, format)),
  encodeParameter: (parameter: PgTypesResult.Parameter) => success(PgTypesResult.encodeParameter(parameter)),
  makeFieldReader: (columns: ReadonlyArray<PgTypesResult.Column>) => success(PgTypesResult.makeFieldReader(columns)),
  array: (values: ReadonlyArray<unknown> | null, elementOid: number) => success(PgTypesResult.array(values, elementOid))
}

/** Extracts the single column of a captured `DataRow` golden. */
const column = (golden: string): Uint8Array => {
  const messages = PgProtocol.makeParser().push(bytes(golden))
  const row = messages[0] as PgProtocol.DataRow
  return row.values[0]!
}

const assertThrowsTagged = (tag: string, run: () => unknown) => {
  try {
    const value = run()
    if (Result.isResult(value) && Result.isFailure(value)) {
      assert.strictEqual((value.failure as { readonly _tag?: string })._tag, tag)
      return
    }
  } catch (error) {
    assert.strictEqual((error as { _tag?: string })._tag, tag)
    return
  }
  assert.fail(`Expected ${tag} to be thrown`)
}

/** Every value below was produced by PostgreSQL for the encoded parameter. */
const roundTrips: Array<{
  readonly name: keyof typeof rows
  readonly oid: number
  readonly value: unknown
  /** Set when PostgreSQL normalises the value, so encode is checked separately. */
  readonly encoded?: unknown
}> = [
  { name: "bool", oid: PgTypes.OID.bool, value: true },
  { name: "int2", oid: PgTypes.OID.int2, value: -12345 },
  { name: "int4", oid: PgTypes.OID.int4, value: 2147483647 },
  { name: "int8Max", oid: PgTypes.OID.int8, value: BigInt("9223372036854775807") },
  { name: "int8Min", oid: PgTypes.OID.int8, value: BigInt("-9223372036854775808") },
  { name: "oid", oid: PgTypes.OID.oid, value: 4294967295 },
  { name: "float4", oid: PgTypes.OID.float4, value: 1.5 },
  { name: "float8", oid: PgTypes.OID.float8, value: -3.0625 },
  { name: "numeric", oid: PgTypes.OID.numeric, value: "12345.6789" },
  { name: "numericSmall", oid: PgTypes.OID.numeric, value: "0.0001" },
  { name: "numericNegative", oid: PgTypes.OID.numeric, value: "-98765432109876543210" },
  { name: "numericNaN", oid: PgTypes.OID.numeric, value: "NaN" },
  { name: "text", oid: PgTypes.OID.text, value: "héllo ☃" },
  { name: "varchar", oid: PgTypes.OID.varchar, value: "abc" },
  { name: "bpchar", oid: PgTypes.OID.bpchar, value: "xy" },
  { name: "name", oid: PgTypes.OID.name, value: "some_name" },
  { name: "bytea", oid: PgTypes.OID.bytea, value: new Uint8Array([0, 1, 254, 255]) },
  { name: "json", oid: PgTypes.OID.json, value: { a: [1, 2], b: null } },
  // jsonb text is reformatted by the server, so only decoding is byte-exact
  { name: "jsonb", oid: PgTypes.OID.jsonb, value: { a: [1, 2], b: null }, encoded: false },
  { name: "uuid", oid: PgTypes.OID.uuid, value: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" },
  { name: "inet4", oid: PgTypes.OID.inet, value: "192.168.0.1" },
  { name: "inet4Masked", oid: PgTypes.OID.inet, value: "192.168.0.1/24" },
  { name: "inet6", oid: PgTypes.OID.inet, value: "2001:db8::1" },
  { name: "cidr", oid: PgTypes.OID.cidr, value: "10.0.0.0/8" },
  { name: "date", oid: PgTypes.OID.date, value: "2024-02-29" },
  { name: "dateInfinity", oid: PgTypes.OID.date, value: "infinity" },
  { name: "dateNegInfinity", oid: PgTypes.OID.date, value: "-infinity" },
  { name: "time", oid: PgTypes.OID.time, value: BigInt(45296000000) },
  { name: "timetz", oid: PgTypes.OID.timetz, value: "12:34:56+02:00" },
  { name: "timestamp", oid: PgTypes.OID.timestamp, value: 1717171717123 },
  { name: "timestampInfinity", oid: PgTypes.OID.timestamp, value: Number.POSITIVE_INFINITY },
  { name: "timestamptz", oid: PgTypes.OID.timestamptz, value: 1717171717123 },
  { name: "timestamptzNegInfinity", oid: PgTypes.OID.timestamptz, value: Number.NEGATIVE_INFINITY },
  { name: "int4ArrayWithNulls", oid: PgTypes.OID.int4Array, value: [1, null, -3] },
  { name: "textArrayEmpty", oid: PgTypes.OID.textArray, value: [] },
  { name: "timestamptzArray", oid: PgTypes.OID.timestamptzArray, value: [0, null, 1717171717000] }
]

/** One value per element OID that has an array type. */
const elementSamples: Record<number, unknown> = {
  [PgTypes.OID.bool]: true,
  [PgTypes.OID.bytea]: new Uint8Array([1, 2, 3]),
  [PgTypes.OID.name]: "some_name",
  [PgTypes.OID.int8]: BigInt("9007199254740993"),
  [PgTypes.OID.int2]: -3,
  [PgTypes.OID.int4]: 70000,
  [PgTypes.OID.text]: "héllo ☃",
  [PgTypes.OID.oid]: 4294967295,
  [PgTypes.OID.json]: { a: [1, 2] },
  [PgTypes.OID.jsonb]: { a: [1, 2] },
  [PgTypes.OID.cidr]: "10.0.0.0/8",
  [PgTypes.OID.float4]: 1.5,
  [PgTypes.OID.float8]: -3.0625,
  [PgTypes.OID.inet]: "192.168.0.1",
  [PgTypes.OID.bpchar]: "xy",
  [PgTypes.OID.varchar]: "abc",
  [PgTypes.OID.date]: "2024-02-29",
  [PgTypes.OID.time]: BigInt(45296000000),
  [PgTypes.OID.timestamp]: 1717171717123,
  [PgTypes.OID.timestamptz]: 0,
  [PgTypes.OID.timetz]: "12:34:56+02:00",
  [PgTypes.OID.numeric]: "-98765432109876543210",
  [PgTypes.OID.uuid]: "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
}

/** The eight wire bytes of an int64. */
const int64Bytes = (value: bigint): Uint8Array => {
  const wire = new Uint8Array(8)
  new DataView(wire.buffer).setBigInt64(0, value)
  return wire
}

/** A `DataRow` frame whose fields are the given bytes; `null` is SQL NULL. */
const dataRow = (fields: ReadonlyArray<Uint8Array | null>): Uint8Array => {
  const size = fields.reduce((total, field) => total + 4 + (field === null ? 0 : field.length), 0)
  const frame = new Uint8Array(1 + 4 + 2 + size)
  const view = new DataView(frame.buffer)
  frame[0] = 0x44
  view.setInt32(1, 4 + 2 + size)
  view.setInt16(5, fields.length)
  let offset = 7
  for (const field of fields) {
    view.setInt32(offset, field === null ? -1 : field.length)
    offset += 4
    if (field !== null) {
      frame.set(field, offset)
      offset += field.length
    }
  }
  return frame
}

const binary = (oids: ReadonlyArray<number>): Array<PgTypesResult.Column> =>
  oids.map((dataTypeOid) => ({ dataTypeOid, format: 1 }))

describe("PgTypes", () => {
  it("returns codec failures as Result values", () => {
    for (
      const result of [
        PgTypesResult.encode("x", 99999),
        PgTypesResult.decode(bytes("31"), PgTypesResult.OID.int4, 0),
        PgTypesResult.array([], 99999)
      ]
    ) {
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "PgTypesCodecError")
    }
  })

  describe("round trips against captured PostgreSQL rows", () => {
    for (const { encoded, name, oid, value } of roundTrips) {
      it(name, () => {
        const golden = column(rows[name])
        assert.deepStrictEqual(PgTypes.decode(golden, oid, 1), value)
        if (encoded !== false) {
          assert.deepStrictEqual(PgTypes.encode(value, oid), golden)
        }
        assert.deepStrictEqual(PgTypes.decode(PgTypes.encode(value, oid), oid, 1), value)
      })
    }
  })

  describe("arrays", () => {
    it("decodes a zero-dimension array as empty", () => {
      assert.deepStrictEqual(PgTypes.decode(column(rows.textArrayEmpty), PgTypes.OID.textArray, 1), [])
    })

    it("keeps nulls inside a 1-dimensional array", () => {
      assert.deepStrictEqual(
        PgTypes.decode(column(rows.int4ArrayWithNulls), PgTypes.OID.int4Array, 1),
        [1, null, -3]
      )
    })

    it("rejects arrays with more than one dimension", () => {
      // ndim 2, no nulls, int4 elements, dims 1x1, one element
      assertThrowsTagged(
        "PgTypesCodecError",
        () =>
          PgTypes.decode(
            bytes("000000020000000000000017000000010000000100000001000000010000000400000001"),
            PgTypes.OID.int4Array,
            1
          )
      )
    })

    it("rejects a truncated array element", () => {
      assertThrowsTagged(
        "PgTypesCodecError",
        () => PgTypes.decode(bytes("000000010000000000000017000000010000000100000004000000"), PgTypes.OID.int4Array, 1)
      )
    })

    it("rejects an array element length below the NULL sentinel", () => {
      assertThrowsTagged(
        "PgTypesCodecError",
        () => PgTypes.decode(bytes("0000000100000000000000110000000100000001fffffffe"), PgTypes.OID.byteaArray, 1)
      )
    })

    it("reads every array OID back through the element codecs", () => {
      for (const [elementOid, sample] of Object.entries(elementSamples)) {
        const arrayOid = PgTypes.arrayOidFor(Number(elementOid))!
        for (const value of [[], [sample], [null], [sample, null, sample]]) {
          assert.deepStrictEqual(
            PgTypes.decode(PgTypes.encode(value, arrayOid), arrayOid, 1),
            value,
            `array of OID ${elementOid} with ${value.length} element(s)`
          )
        }
      }
    })

    it("reads elements whose bytes are not at the front of the array", () => {
      // The second element decodes from an offset, so a codec that ignored one
      // would hand back the first element's value.
      const value = ["2024-02-29", "1999-12-31", null, "0001-01-02"]
      assert.deepStrictEqual(
        PgTypes.decode(PgTypes.encode(value, PgTypes.OID.dateArray), PgTypes.OID.dateArray, 1),
        value
      )
    })

    it("rejects an array whose lower bound is not one", () => {
      assertThrowsTagged(
        "PgTypesCodecError",
        () =>
          PgTypes.decode(
            bytes("0000000100000000000000170000000300000000000000040000000100000004000000020000000400000003"),
            PgTypes.OID.int4Array,
            1
          )
      )
    })

    it("rejects an array whose element OID does not match its array type", () => {
      assertThrowsTagged(
        "PgTypesCodecError",
        () =>
          PgTypes.decode(
            bytes("00000001000000000000001500000001000000010000000400000001"),
            PgTypes.OID.int4Array,
            1
          )
      )
    })

    it("rejects negative and mismatched declared array lengths", () => {
      for (
        const wire of [
          "000000010000000000000017ffffffff00000001",
          "00000001000000000000001700000000000000010000000400000001",
          "000000010000000000000017000000010000000100000004000000010000000400000002",
          "0000000000000000000000170000000100000001"
        ]
      ) {
        assertThrowsTagged(
          "PgTypesCodecError",
          () => PgTypes.decode(bytes(wire), PgTypes.OID.int4Array, 1)
        )
      }
    })
  })

  describe("errors", () => {
    it("rejects the text format", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.decode(bytes("31"), PgTypes.OID.int4, 0))
    })

    it("rejects a value of the wrong JavaScript type", () => {
      for (
        const [value, oid] of [
          [1, PgTypes.OID.bool],
          ["1", PgTypes.OID.int4],
          [1, PgTypes.OID.int8],
          ["1", PgTypes.OID.float8],
          [1, PgTypes.OID.numeric],
          [1, PgTypes.OID.text],
          [[1], PgTypes.OID.bytea],
          [1, PgTypes.OID.uuid],
          [1, PgTypes.OID.inet],
          [1, PgTypes.OID.date],
          [1, PgTypes.OID.time],
          [1, PgTypes.OID.timetz],
          [BigInt(1), PgTypes.OID.timestamp],
          ["not-an-array", PgTypes.OID.int4Array]
        ] as const
      ) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(value, oid))
      }
    })

    it("rejects integers outside their range", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(32768, PgTypes.OID.int2))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(1.5, PgTypes.OID.int4))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(-1, PgTypes.OID.oid))
      assertThrowsTagged(
        "PgTypesCodecError",
        () => PgTypes.encode(BigInt("9223372036854775808"), PgTypes.OID.int8)
      )
    })

    it("rejects NaN timestamps", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(Number.NaN, PgTypes.OID.timestamptz))
    })

    it("rejects timestamps outside the PostgreSQL int64 range", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(1e300, PgTypes.OID.timestamptz))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(-1e300, PgTypes.OID.timestamp))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(Number.MAX_VALUE, PgTypes.OID.timestamp))
    })

    it("rejects malformed dates and uuids", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("2024-2-9", PgTypes.OID.date))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("2023-02-31", PgTypes.OID.date))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("2023-04-31", PgTypes.OID.date))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("not-a-uuid", PgTypes.OID.uuid))
    })

    it("rejects finite dates outside the PostgreSQL wire range or on its infinity sentinels", () => {
      for (const value of ["5881610-07-11", "-5877611-06-22", "999999999-12-31", "-999999999-01-01"]) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(value, PgTypes.OID.date))
      }
    })

    it("rejects years with more digits than a Number can hold", () => {
      for (const sign of ["", "-"]) {
        assertThrowsTagged(
          "PgTypesCodecError",
          () => PgTypes.encode(`${sign}${"9".repeat(320)}-01-01`, PgTypes.OID.date)
        )
      }
    })

    it("rejects host bits outside a cidr netmask", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("10.1.2.3/8", PgTypes.OID.cidr))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("2001:db8::1/32", PgTypes.OID.cidr))
    })

    it("rejects invalid network masks and CIDR host bits on decode", () => {
      for (
        const [wire, oid] of [
          ["02210004c0a80001", PgTypes.OID.inet],
          ["020801040a010203", PgTypes.OID.cidr],
          ["0381011000000000000000000000000000000000", PgTypes.OID.cidr]
        ] as const
      ) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.decode(bytes(wire), oid, 1))
      }
    })

    it("rejects a value the wrong size for its OID", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.decode(bytes("0001"), PgTypes.OID.int4, 1))
    })

    it("rejects unsupported JSONB versions and unserialisable JSON values", () => {
      for (const wire of ["", "007b7d", "027b7d"]) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.decode(bytes(wire), PgTypes.OID.jsonb, 1))
      }
      for (const oid of [PgTypes.OID.json, PgTypes.OID.jsonb]) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(undefined, oid))
      }
    })

    it("rejects malformed text, numeric, time, and network values", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.decode(bytes("ff"), PgTypes.OID.text, 1))
      for (const value of ["", ".", "+", "1.2.3", "not-a-number", `0.${"0".repeat(0x4000)}1`]) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(value, PgTypes.OID.numeric))
      }
      for (
        const value of [
          "12+00:00",
          "12:xx:00+00:00",
          "12:00:00",
          "12:00:00+xx",
          "12:00:00+02:60",
          "12:00:00+02:00:60",
          "12:00:00+16:00"
        ]
      ) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(value, PgTypes.OID.timetz))
      }
      for (
        const value of [
          "1.2.3.4.5",
          "1.2.x.4",
          "256.0.0.1",
          "2001::db8::1",
          "2001:db8:zz::1",
          "192.168.0.1/-1",
          "192.168.0.1/33",
          "2001:db8::1/129"
        ]
      ) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(value, PgTypes.OID.inet))
      }
      for (const wire of ["", "020000", "04000004c0a80001", "02000010c0a80001", "02200204c0a80001"]) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.decode(bytes(wire), PgTypes.OID.inet, 1))
      }
    })
  })

  describe("scalar boundaries", () => {
    it("round trips integer and time limits and rejects the adjacent values", () => {
      const cases: ReadonlyArray<{
        readonly oid: number
        readonly accepted: ReadonlyArray<number | bigint>
        readonly rejected: ReadonlyArray<number | bigint>
      }> = [
        { oid: PgTypes.OID.int2, accepted: [-32768, 32767], rejected: [-32769, 32768] },
        { oid: PgTypes.OID.int4, accepted: [-2147483648, 2147483647], rejected: [-2147483649, 2147483648] },
        { oid: PgTypes.OID.oid, accepted: [0, 4294967295], rejected: [-1, 4294967296] },
        {
          oid: PgTypes.OID.int8,
          accepted: [BigInt("-9223372036854775808"), BigInt("9223372036854775807")],
          rejected: [BigInt("-9223372036854775809"), BigInt("9223372036854775808")]
        },
        {
          oid: PgTypes.OID.time,
          accepted: [BigInt(0), BigInt("86400000000")],
          rejected: [BigInt(-1), BigInt("86400000001")]
        }
      ]
      for (const { accepted, oid, rejected } of cases) {
        for (const value of accepted) {
          assert.deepStrictEqual(PgTypes.decode(PgTypes.encode(value, oid), oid, 1), value)
        }
        for (const value of rejected) {
          assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(value, oid))
        }
      }
    })

    it("round trips scalar boundary values inside arrays", () => {
      for (
        const [oid, value] of [
          [PgTypes.OID.int2Array, [-32768, null, 32767]],
          [PgTypes.OID.int4Array, [-2147483648, null, 2147483647]],
          [PgTypes.OID.int8Array, [BigInt("-9223372036854775808"), null, BigInt("9223372036854775807")]],
          [PgTypes.OID.timeArray, [BigInt(0), null, BigInt("86400000000")]]
        ] as const
      ) {
        assert.deepStrictEqual(PgTypes.decode(PgTypes.encode(value, oid), oid, 1), value)
      }
    })

    it("round trips deterministic generated integer values", () => {
      let state = 0x9e3779b9
      const values: Array<number> = []
      for (let index = 0; index < 512; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) | 0
        values.push(state)
        assert.strictEqual(PgTypes.decode(PgTypes.encode(state, PgTypes.OID.int4), PgTypes.OID.int4, 1), state)
      }
      assert.deepStrictEqual(
        PgTypes.decode(PgTypes.encode(values, PgTypes.OID.int4Array), PgTypes.OID.int4Array, 1),
        values
      )
    })
  })

  describe("unknown OIDs", () => {
    it("decodes to the raw bytes", () => {
      assert.deepStrictEqual(PgTypes.decode(bytes("00ff"), 99999, 1), bytes("00ff"))
    })

    it("fails to encode until a codec is registered", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("x", 99999))
      PgTypes.register<string>(99999, {
        encode: (value) => Result.succeed(new TextEncoder().encode(value.toUpperCase())),
        decode: (value) => Result.succeed(new TextDecoder().decode(value).toLowerCase())
      })
      try {
        assert.deepStrictEqual(PgTypes.encode("ab", 99999), bytes("4142"))
        assert.strictEqual(PgTypes.decode(bytes("4142"), 99999, 1), "ab")
      } finally {
        PgTypes.unregister(99999)
      }
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("x", 99999))
    })

    it("restores a builtin codec after an override is unregistered", () => {
      PgTypes.register<string>(PgTypes.OID.text, {
        encode: () => Result.succeed(bytes("ff")),
        decode: () => Result.succeed("overridden")
      })
      try {
        assert.deepStrictEqual(PgTypes.encode("text", PgTypes.OID.text), bytes("ff"))
        assert.strictEqual(PgTypes.decode(bytes("00"), PgTypes.OID.text, 1), "overridden")
      } finally {
        PgTypes.unregister(PgTypes.OID.text)
      }
      assert.deepStrictEqual(PgTypes.encode("text", PgTypes.OID.text), bytes("74657874"))
    })
  })

  describe("numeric", () => {
    it("round trips values with only a fractional part", () => {
      for (const value of ["0", "0.00", "1", "-1", "0.5", "1000000", "0.000000001", "1e3", "12345678901234567890"]) {
        const expected = value === "1e3" ? "1000" : value
        assert.strictEqual(
          PgTypes.decode(PgTypes.encode(value, PgTypes.OID.numeric), PgTypes.OID.numeric, 1),
          expected
        )
      }
    })

    it("rejects a digit group that has no four-digit text", () => {
      // one group, weight 0, positive, scale 0, digit 10000
      assertThrowsTagged(
        "PgTypesCodecError",
        () => PgTypes.decode(bytes("00010000000000002710"), PgTypes.OID.numeric, 1)
      )
      assertThrowsTagged(
        "PgTypesCodecError",
        () => PgTypes.decode(bytes("0001000000000000ffff"), PgTypes.OID.numeric, 1)
      )
    })

    it("round trips the special values", () => {
      for (const value of ["NaN", "Infinity", "-Infinity"]) {
        assert.strictEqual(
          PgTypes.decode(PgTypes.encode(value, PgTypes.OID.numeric), PgTypes.OID.numeric, 1),
          value
        )
      }
    })
  })

  describe("timestamps", () => {
    it("agrees with the exact 64-bit conversion either side of the Number boundary", () => {
      const epochMs = BigInt(946684800000)
      const boundary = BigInt("9007199254740992")
      const micros = [
        BigInt(0),
        BigInt(1),
        BigInt(-1),
        BigInt("1717171717123000") - epochMs * BigInt(1000),
        boundary - BigInt(1),
        boundary,
        // just past the boundary, and chosen so that rounding it into a double
        // would move the millisecond it truncates to
        boundary + BigInt(7),
        -boundary,
        -boundary - BigInt(7),
        BigInt("9223372036854775806"),
        BigInt("-9223372036854775807")
      ]
      for (const value of micros) {
        assert.strictEqual(
          PgTypes.decode(int64Bytes(value), PgTypes.OID.timestamptz, 1),
          Number(value / BigInt(1000)) + 946684800000,
          `${value} microseconds`
        )
      }
    })

    it("round trips milliseconds through both the float and the BigInt path", () => {
      for (const ms of [0, 1, -1, 946684800000, 1717171717123, -62135596800000, 253402300799000, 9007199254740]) {
        assert.strictEqual(PgTypes.decode(PgTypes.encode(ms, PgTypes.OID.timestamp), PgTypes.OID.timestamp, 1), ms)
      }
    })

    it("truncates sub-millisecond values toward zero on both sides of the PostgreSQL epoch", () => {
      const before = new Uint8Array(8)
      const after = new Uint8Array(8)
      new DataView(before.buffer).setBigInt64(0, BigInt(-1))
      new DataView(after.buffer).setBigInt64(0, BigInt(1))
      assert.strictEqual(PgTypes.decode(before, PgTypes.OID.timestamp, 1), 946684800000)
      assert.strictEqual(PgTypes.decode(after, PgTypes.OID.timestamp, 1), 946684800000)
    })
  })

  describe("dates", () => {
    it("round trips years of every width, negative ones included", () => {
      for (const value of ["0001-01-01", "0999-12-31", "2024-02-29", "2000-02-29", "10000-06-15", "-0044-03-15"]) {
        assert.strictEqual(PgTypes.decode(PgTypes.encode(value, PgTypes.OID.date), PgTypes.OID.date, 1), value)
      }
    })

    it("rejects days a month does not have", () => {
      for (const value of ["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-10", "2024-13-01", "2024-01-00"]) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(value, PgTypes.OID.date))
      }
    })

    it("rejects text that is not a date", () => {
      for (const value of ["", "2024", "2024-01-01 ", "2024/01/01", "202-01-01", "20x4-01-01", "2024-0a-01"]) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(value, PgTypes.OID.date))
      }
    })
  })

  describe("timetz", () => {
    it("round trips fractional seconds and zone offsets", () => {
      for (
        const value of [
          "00:00:00+00:00",
          "24:00:00+00:00",
          "12:34:56.5+02:00",
          "23:59:59.999999-05:30"
        ]
      ) {
        assert.strictEqual(PgTypes.decode(PgTypes.encode(value, PgTypes.OID.timetz), PgTypes.OID.timetz, 1), value)
      }
      assert.strictEqual(
        PgTypes.decode(PgTypes.encode("12:34:00Z", PgTypes.OID.timetz), PgTypes.OID.timetz, 1),
        "12:34:00+00:00"
      )
    })

    it("enforces PostgreSQL's wire time zone displacement range", () => {
      assert.strictEqual(PgTypes.decode(bytes("00000000000000000000e0ff"), PgTypes.OID.timetz, 1), "00:00:00-15:59")
      assert.strictEqual(PgTypes.decode(bytes("0000000000000000ffff1f01"), PgTypes.OID.timetz, 1), "00:00:00+15:59")
      assertThrowsTagged(
        "PgTypesCodecError",
        () => PgTypes.decode(bytes("00000000000000000000e100"), PgTypes.OID.timetz, 1)
      )
      assertThrowsTagged(
        "PgTypesCodecError",
        () => PgTypes.decode(bytes("0000000000000000ffff1f00"), PgTypes.OID.timetz, 1)
      )
    })

    it("rejects times past midnight at both ends", () => {
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("24:00:01+00:00", PgTypes.OID.timetz))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("25:00:00+00:00", PgTypes.OID.timetz))
      const past = new Uint8Array(12)
      new DataView(past.buffer).setBigInt64(0, BigInt("86400000001"))
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.decode(past, PgTypes.OID.timetz, 1))
    })
  })

  describe("uuid", () => {
    it("accepts either case and rejects anything else", () => {
      assert.deepStrictEqual(
        PgTypes.encode("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", PgTypes.OID.uuid),
        PgTypes.encode("6ba7b810-9dad-11d1-80b4-00c04fd430c8", PgTypes.OID.uuid)
      )
      for (
        const value of [
          "6ba7b810-9dad-11d1-80b4-00c04fd430c",
          "6ba7b8109dad-11d1-80b4-00c04fd430c8",
          "6ba7b810_9dad-11d1-80b4-00c04fd430c8",
          "6ba7b81g-9dad-11d1-80b4-00c04fd430c8",
          "6ba7b81☃-9dad-11d1-80b4-00c04fd430c8"
        ]
      ) {
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode(value, PgTypes.OID.uuid))
      }
    })
  })

  describe("parameters", () => {
    it("copies bytea values when encoding", () => {
      const source = bytes("010203")
      const encoded = PgTypes.encode(source, PgTypes.OID.bytea)
      assert.notStrictEqual(encoded, source)
      source[0] = 0xff
      assert.deepStrictEqual(encoded, bytes("010203"))
    })

    it("carries the OID with the value", () => {
      assert.deepStrictEqual(PgTypes.int4(1), { oid: PgTypes.OID.int4, value: 1 })
      assert.deepStrictEqual(PgTypes.timestamptz(0), { oid: PgTypes.OID.timestamptz, value: 0 })
      assert.deepStrictEqual(PgTypes.array([1, null], PgTypes.OID.int4), {
        oid: PgTypes.OID.int4Array,
        value: [1, null]
      })
    })

    it("encodes SQL NULL as null", () => {
      assert.strictEqual(PgTypes.encodeParameter(PgTypes.int4(null)), null)
      assert.deepStrictEqual(PgTypes.encodeParameter(PgTypes.int4(1)), bytes("00000001"))
    })

    it("encodes strings past the ASCII fast path", () => {
      const encoder = new TextEncoder()
      // longer than the scratch buffer the encoder writes through
      for (const value of ["abc", "é", "x".repeat(200), "héllo ☃ 👋🏽", "y".repeat(70_000)]) {
        assert.deepStrictEqual(PgTypes.encode(value, PgTypes.OID.text), encoder.encode(value))
        assert.strictEqual(PgTypes.decode(PgTypes.encode(value, PgTypes.OID.text), PgTypes.OID.text, 1), value)
        const jsonb = PgTypes.encode(value, PgTypes.OID.jsonb)
        assert.strictEqual(jsonb[0], 1)
        assert.deepStrictEqual(jsonb.subarray(1), encoder.encode(JSON.stringify(value)))
      }
    })

    it("decodes a non-ASCII character at every position of the fast path", () => {
      // The fast path reads eight bytes at a time, so a character it cannot
      // handle has to be caught wherever it falls in a group and whatever the
      // tail after the last full one.
      for (let prefix = 0; prefix <= 48; prefix++) {
        const value = "a".repeat(prefix) + "é☃"
        assert.strictEqual(PgTypes.decode(PgTypes.encode(value, PgTypes.OID.text), PgTypes.OID.text, 1), value)
      }
    })

    it("decodes text that really contains the replacement character", () => {
      // The fast decoder signals invalid bytes with U+FFFD, so text that holds
      // a genuine one has to survive the strict re-decode that triggers.
      for (const value of ["\ufffd", "abc\ufffddef and some padding", "\ufffd".repeat(20)]) {
        assert.strictEqual(PgTypes.decode(PgTypes.encode(value, PgTypes.OID.text), PgTypes.OID.text, 1), value)
      }
    })

    it("rejects a stray high byte at every position of the fast path", () => {
      // A lone lead byte is not valid UTF-8, so the fast path has to hand it to
      // the decoder rather than read it as a character of its own.
      for (let length = 1; length <= 16; length++) {
        for (let at = 0; at < length; at++) {
          const bytes = new Uint8Array(length).fill(0x61)
          bytes[at] = 0xc3
          assert.throws(() => PgTypes.decode(bytes, PgTypes.OID.text, 1), /Invalid UTF-8 in text value/)
        }
      }
    })

    it("decodes a multi-byte character at every position of the fast path", () => {
      for (let prefix = 0; prefix <= 16; prefix++) {
        const value = "a".repeat(prefix) + "é☃"
        assert.strictEqual(PgTypes.decode(PgTypes.encode(value, PgTypes.OID.text), PgTypes.OID.text, 1), value)
      }
    })

    it("decodes ASCII text of every length across the fast path boundary", () => {
      for (let length = 0; length <= 16; length++) {
        const value = "abcdefgh".repeat(2).slice(0, length)
        assert.strictEqual(PgTypes.decode(PgTypes.encode(value, PgTypes.OID.text), PgTypes.OID.text, 1), value)
      }
    })

    it("writes every builtin parameter as the bytes encode produces", () => {
      const encodeBind = PgProtocol.makeBindEncoder(PgTypes.writeParameter)
      const parameters = [
        ...roundTrips.map(({ oid, value }) => ({ oid, value })),
        { oid: PgTypes.OID.int4, value: null },
        { oid: PgTypes.OID.textArray, value: null }
      ]
      assert.deepStrictEqual(
        encodeBind({ portal: "p1", statement: "s1", parameters }),
        PgProtocol.encodeBind({
          portal: "p1",
          statement: "s1",
          parameters: parameters.map(PgTypes.encodeParameter)
        })
      )
    })

    it("rejects wrong types through the direct Bind writer", () => {
      const encodeBind = PgProtocol.makeBindEncoder(PgTypes.writeParameter)
      for (
        const parameter of [
          { oid: PgTypes.OID.bool, value: 1 },
          { oid: PgTypes.OID.bytea, value: "bytes" },
          { oid: PgTypes.OID.json, value: undefined },
          { oid: PgTypes.OID.jsonb, value: undefined },
          { oid: PgTypes.OID.int4Array, value: "not-an-array" }
        ]
      ) {
        assertThrowsTagged(
          "PgTypesCodecError",
          () => encodeBind({ portal: "", statement: "", parameters: [parameter] })
        )
      }
    })

    it("registers codecs outside the direct table", () => {
      for (const oid of [-1, 4096, 99999]) {
        PgTypes.register<string>(oid, {
          encode: (value) => Result.succeed(new TextEncoder().encode(value.toUpperCase())),
          decode: (value) => Result.succeed(new TextDecoder().decode(value).toLowerCase())
        })
        try {
          assert.deepStrictEqual(PgTypes.encode("ab", oid), bytes("4142"))
          assert.strictEqual(PgTypes.decode(bytes("4142"), oid, 1), "ab")
        } finally {
          PgTypes.unregister(oid)
        }
        assertThrowsTagged("PgTypesCodecError", () => PgTypes.encode("x", oid))
      }
    })

    it("writes every array OID as the bytes encode produces", () => {
      const encodeBind = PgProtocol.makeBindEncoder(PgTypes.writeParameter)
      for (const [elementOid, sample] of Object.entries(elementSamples)) {
        const arrayOid = PgTypes.arrayOidFor(Number(elementOid))!
        assert.notStrictEqual(arrayOid, undefined)
        for (const value of [[], [sample], [null], [sample, null, sample]]) {
          const parameters = [{ oid: arrayOid, value }]
          assert.deepStrictEqual(
            encodeBind({ portal: "", statement: "", parameters }),
            PgProtocol.encodeBind({
              portal: "",
              statement: "",
              parameters: parameters.map(PgTypes.encodeParameter)
            }),
            `array of OID ${elementOid} with ${value.length} element(s)`
          )
        }
      }
    })

    it("frames array elements that grow the pool mid-write", () => {
      const encodeBind = PgProtocol.makeBindEncoder(PgTypes.writeParameter)
      const value = ["a", "b".repeat(24 * 1024), null, "c"]
      const parameters = [{ oid: PgTypes.OID.textArray, value }, PgTypes.int4(7)]
      assert.deepStrictEqual(
        encodeBind({ portal: "p", statement: "s", parameters }),
        PgProtocol.encodeBind({ portal: "p", statement: "s", parameters: parameters.map(PgTypes.encodeParameter) })
      )
    })

    it("writes a registered codec through encode when it has no writer", () => {
      const encodeBind = PgProtocol.makeBindEncoder(PgTypes.writeParameter)
      const parameters = [{ oid: 99999, value: "ab" }]
      assertThrowsTagged("PgTypesCodecError", () => encodeBind({ portal: "", statement: "", parameters }))
      PgTypes.register<string>(99999, {
        encode: (value) => Result.succeed(new TextEncoder().encode(value.toUpperCase())),
        decode: (value) => Result.succeed(new TextDecoder().decode(value).toLowerCase())
      })
      try {
        assert.deepStrictEqual(
          encodeBind({ portal: "", statement: "", parameters }),
          PgProtocol.encodeBind({ portal: "", statement: "", parameters: parameters.map(PgTypes.encodeParameter) })
        )
      } finally {
        PgTypes.unregister(99999)
      }
    })

    it("recovers from a parameter that fails mid-frame", () => {
      const encodeBind = PgProtocol.makeBindEncoder(PgTypes.writeParameter)
      // The uuid writer fails after the frame is partly written, so the next
      // frame proves the writer dropped what the failed one left behind.
      assertThrowsTagged(
        "PgTypesCodecError",
        () => encodeBind({ portal: "", statement: "s", parameters: [PgTypes.int4(1), PgTypes.uuid("not-a-uuid")] })
      )
      const parameters = [PgTypes.uuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8")]
      assert.deepStrictEqual(
        encodeBind({ portal: "", statement: "s", parameters }),
        PgProtocol.encodeBind({ portal: "", statement: "s", parameters: parameters.map(PgTypes.encodeParameter) })
      )
    })

    it("keeps a bytea frame intact when the source is mutated afterwards", () => {
      const encodeBind = PgProtocol.makeBindEncoder(PgTypes.writeParameter)
      const source = bytes("010203")
      const encoded = success(encodeBind({ portal: "", statement: "", parameters: [PgTypes.bytea(source)] }))
      source[0] = 0xff
      // the frame ends with the four bytes of the result format code
      assert.deepStrictEqual(encoded.slice(-7, -4), bytes("010203"))
    })

    it("maps element OIDs to array OIDs", () => {
      assert.strictEqual(PgTypes.arrayOidFor(PgTypes.OID.text), PgTypes.OID.textArray)
      assert.strictEqual(PgTypes.arrayOidFor(99999), undefined)
      assertThrowsTagged("PgTypesCodecError", () => PgTypes.array([], 99999))
    })
  })

  describe("makeFieldReader", () => {
    it("reads every builtin column as decode does", () => {
      const columns = roundTrips.map(({ oid }) => oid)
      const fields = roundTrips.map(({ oid, value }) => PgTypes.encode(value, oid))
      const parser = PgProtocol.makeParser({ readField: PgTypes.makeFieldReader(binary(columns)) })
      const messages = parser.push(dataRow(fields))
      assert.strictEqual(messages.length, 1)
      const row = messages[0] as PgProtocol.DataRow<unknown>
      assert.deepStrictEqual(row.values, fields.map((field, index) => PgTypes.decode(field, columns[index], 1)))
    })

    it("reads SQL NULL as null", () => {
      const parser = PgProtocol.makeParser({
        readField: PgTypes.makeFieldReader(binary([PgTypes.OID.int4, PgTypes.OID.text]))
      })
      const messages = parser.push(dataRow([null, PgTypes.encode("a", PgTypes.OID.text)]))
      assert.deepStrictEqual((messages[0] as PgProtocol.DataRow<unknown>).values, [null, "a"])
    })

    it("copies the bytes of a column whose OID has no codec", () => {
      const parser = PgProtocol.makeParser({ readField: PgTypes.makeFieldReader(binary([99999])) })
      const payload = new Uint8Array([1, 2, 3])
      const value = (parser.push(dataRow([payload]))[0] as PgProtocol.DataRow<unknown>).values[0]
      assert.deepStrictEqual(value, payload)
      // A copy, not a view into the parser's buffer, which is far larger and
      // holds the whole frame rather than just this field.
      assert.strictEqual((value as Uint8Array).byteOffset, 0)
      assert.strictEqual((value as Uint8Array).buffer.byteLength, payload.length)
    })

    it("hands a view to a registered codec that cannot read in place", () => {
      const oid = 90001
      let sawWholeField: Uint8Array | undefined
      PgTypes.register(oid, {
        encode: (value) => Result.succeed(value as Uint8Array),
        decode: (fieldBytes) => {
          sawWholeField = fieldBytes
          return Result.succeed(`saw ${fieldBytes.length}`)
        }
      })
      try {
        const parser = PgProtocol.makeParser({ readField: PgTypes.makeFieldReader(binary([PgTypes.OID.int4, oid])) })
        const messages = parser.push(dataRow([PgTypes.encode(1, PgTypes.OID.int4), new Uint8Array([9, 8, 7])]))
        assert.deepStrictEqual((messages[0] as PgProtocol.DataRow<unknown>).values, [1, "saw 3"])
        // The view covers the field and nothing else, though the buffer behind
        // it holds the whole frame.
        assert.deepStrictEqual(Array.from(sawWholeField!), [9, 8, 7])
      } finally {
        PgTypes.unregister(oid)
      }
    })

    it("keeps public codec failures typed and makes parser failures terminal", () => {
      const oid = 90002
      const failure = new PgTypesResult.CodecError({ message: "field decode failed" })
      PgTypes.register(oid, {
        encode: () => Result.succeed(new Uint8Array([1])),
        decode: () => Result.fail(failure)
      })
      try {
        const reader = success(PgTypesResult.makeFieldReader(binary([oid])))
        const direct = PgTypesResult.decode(new Uint8Array([1]), oid, 1)
        assert.isTrue(Result.isFailure(direct))
        if (Result.isFailure(direct)) assert.strictEqual(direct.failure, failure)

        const parser = PgProtocol.makeParser({ readField: reader })
        let threw = false
        try {
          parser.push(dataRow([new Uint8Array([1])]))
        } catch (error) {
          threw = true
          assert.strictEqual(error, failure)
        }
        assert.isTrue(threw)
        assertThrowsTagged("PgProtocolParseError", () => parser.push(dataRow([new Uint8Array([1])])))
      } finally {
        PgTypes.unregister(oid)
      }
    })

    it("rejects a text column when the reader is built, not once per row", () => {
      assertThrowsTagged(
        "PgTypesCodecError",
        () => PgTypes.makeFieldReader([{ dataTypeOid: PgTypes.OID.int4, format: 0 }])
      )
    })

    it("reads a row split across chunks", () => {
      const columns = [PgTypes.OID.int4, PgTypes.OID.text, PgTypes.OID.uuid]
      const values = [7, "a longer value than the fast path covers", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"]
      const frame = dataRow(columns.map((oid, index) => PgTypes.encode(values[index], oid)))
      const parser = PgProtocol.makeParser({ readField: PgTypes.makeFieldReader(binary(columns)) })
      const decoded: Array<unknown> = []
      for (let at = 0; at < frame.length; at += 3) {
        for (const message of parser.push(frame.subarray(at, at + 3))) {
          decoded.push(...(message as PgProtocol.DataRow<unknown>).values)
        }
      }
      assert.deepStrictEqual(decoded, values)
    })

    it("reads through a reader replaced mid-stream", () => {
      const parser = PgProtocol.makeParser<unknown>({
        readField: PgTypes.makeFieldReader(binary([PgTypes.OID.int4]))
      })
      const payload = PgTypes.encode(1, PgTypes.OID.int4)
      assert.deepStrictEqual((parser.push(dataRow([payload]))[0] as PgProtocol.DataRow<unknown>).values, [1])
      parser.readField = PgTypes.makeFieldReader(binary([PgTypes.OID.oid]))
      assert.deepStrictEqual((parser.push(dataRow([payload]))[0] as PgProtocol.DataRow<unknown>).values, [1])
      parser.readField = undefined
      assert.deepStrictEqual(
        (parser.push(dataRow([payload]))[0] as PgProtocol.DataRow<unknown>).values,
        [payload]
      )
    })
  })
})
