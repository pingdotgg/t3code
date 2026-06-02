import { Schema } from "effect"
import * as DateTime from "effect/DateTime"
import * as FastCheck from "effect/testing/FastCheck"
import { describe, it } from "vitest"
import { deepStrictEqual, strictEqual, throws } from "../utils/assert.ts"

/**
 * This suite intentionally avoids re-testing generic JSON Patch behavior
 * (pointer parsing, add/replace/remove mechanics, ordering, etc).
 *
 * It focuses on Schema.toDifferJsonPatch-specific guarantees:
 * - reference preservation when patch is a no-op
 * - reference replacement for root replace
 * - immutability of inputs
 * - schema-specific diff/patch encodings (Number / Date / Defect / DateTimeUtcFromMillis)
 * - property-based roundtrip across a broad set of codecs
 */

function roundtrip<T, E>(codec: Schema.Codec<T, E>) {
  const differ = Schema.toDifferJsonPatch(codec)
  const arbitrary = Schema.toArbitrary(codec)
  const arb = arbitrary.filter((v) => {
    // avoid prototype-poisoning-ish values that aren't valid JSON-ish containers for patching
    if (
      typeof v === "object" &&
      v !== null &&
      (Object.getPrototypeOf(v) === null || Object.hasOwn(v as any, "__proto__"))
    ) {
      return false
    }
    return true
  })

  FastCheck.assert(
    FastCheck.property(arb, arb, (v1, v2) => {
      const patch = differ.diff(v1, v2)
      const patched = differ.patch(v1, patch)

      // two invalid dates are not considered equal by deepStrictEqual
      if (patched instanceof Date && v2 instanceof Date && Object.is(patched.getTime(), v2.getTime())) {
        return
      }

      deepStrictEqual(patched, v2)
    })
  )
}

describe("Schema.toDifferJsonPatch", () => {
  describe("structural guarantees", () => {
    it("patch returns the same reference if nothing changed (no-op patch)", () => {
      const schema = Schema.Struct({ a: Schema.String })
      const differ = Schema.toDifferJsonPatch(schema)
      const value = { a: "a" }

      strictEqual(differ.patch(value, []), value)
    })

    it("root replace returns the provided reference (no clone)", () => {
      const differ = Schema.toDifferJsonPatch(Schema.Any)

      const newRef = { hello: "world" }
      const out = differ.patch({ old: true }, [{ op: "replace", path: "", value: newRef }])

      strictEqual(out, newRef)
      deepStrictEqual(out, newRef)
    })

    it("immutability: patch does not mutate the input", () => {
      const differ = Schema.toDifferJsonPatch(Schema.Any)

      const oldValue = { a: { b: [1, 2, 3] } }
      const snapshot = JSON.parse(JSON.stringify(oldValue))

      const out = differ.patch(oldValue, [
        { op: "replace", path: "/a/b/1", value: 9 },
        { op: "remove", path: "/a/b/2" }
      ])

      deepStrictEqual(oldValue, snapshot)
      deepStrictEqual(out, { a: { b: [1, 9] } })
    })
  })

  describe("codec-specific diff/patch semantics", () => {
    it("Number: distinguishes 0 and -0; treats NaN as equal to NaN", () => {
      const differ = Schema.toDifferJsonPatch(Schema.Number)

      deepStrictEqual(differ.diff(0, -0), [{ op: "replace", path: "", value: -0 }])
      deepStrictEqual(differ.diff(-0, 0), [{ op: "replace", path: "", value: 0 }])

      deepStrictEqual(differ.diff(NaN, NaN), [])
      deepStrictEqual(differ.diff(Infinity, Infinity), [])
      deepStrictEqual(differ.diff(-Infinity, -Infinity), [])

      deepStrictEqual(differ.patch(0, [{ op: "replace", path: "", value: -0 }]), -0)
      deepStrictEqual(differ.patch(-0, [{ op: "replace", path: "", value: 0 }]), 0)
    })

    it("Date: encodes invalid Date as a string on diff", () => {
      const differ = Schema.toDifferJsonPatch(Schema.Date)

      deepStrictEqual(
        differ.diff(new Date("1970-01-01T00:00:00.000Z"), new Date(NaN)),
        [{ op: "replace", path: "", value: "Invalid Date" }]
      )
    })

    it("Defect: diff encodes an Error to a plain object; patch decodes back to Error", () => {
      const differ = Schema.toDifferJsonPatch(Schema.Defect)

      deepStrictEqual(differ.diff("", new Error("b")), [{
        op: "replace",
        path: "",
        value: { name: "Error", message: "b" }
      }])

      deepStrictEqual(
        differ.patch("", [{
          op: "replace",
          path: "",
          value: { name: "Error", message: "b" }
        }]),
        new Error("b")
      )
    })

    it("DateTimeUtcFromMillis: diff uses millis and patch rehydrates DateTime", () => {
      const differ = Schema.toDifferJsonPatch(Schema.DateTimeUtcFromMillis)

      deepStrictEqual(
        differ.diff(
          DateTime.makeUnsafe("2021-01-01T00:00:00.000Z"),
          DateTime.makeUnsafe("2021-01-01T00:00:00.000Z")
        ),
        []
      )

      deepStrictEqual(
        differ.diff(
          DateTime.makeUnsafe("2021-01-01T00:00:00.000Z"),
          DateTime.makeUnsafe("2021-01-02T00:00:00.000Z")
        ),
        [{ op: "replace", path: "", value: 1609545600000 }]
      )

      deepStrictEqual(
        differ.patch(
          DateTime.makeUnsafe("2021-01-01T00:00:00.000Z"),
          [{ op: "replace", path: "", value: 1609545600000 }]
        ),
        DateTime.makeUnsafe("2021-01-02T00:00:00.000Z")
      )
    })
  })

  describe("integration sanity checks", () => {
    it("diff/patch works when root container kind changes", () => {
      const differ = Schema.toDifferJsonPatch(Schema.Any)

      deepStrictEqual(differ.diff([], {}), [{ op: "replace", path: "", value: {} }])
      deepStrictEqual(differ.patch([], [{ op: "replace", path: "", value: {} }]), {})
    })

    it("patch throws when asked to do an invalid replace (replace requires existence)", () => {
      const differ = Schema.toDifferJsonPatch(Schema.Any)
      const doc = {}
      throws(() => differ.patch(doc, [{ op: "replace", path: "/x", value: 1 }]))
    })
  })

  describe("roundtrip (property-based)", () => {
    it("patch(diff(a,b)) round-trips for a wide set of codecs", () => {
      roundtrip(Schema.Any.annotate({
        toArbitrary: () => (fc) => fc.json()
      }))

      roundtrip(Schema.String)
      roundtrip(Schema.Number)
      roundtrip(Schema.Boolean)
      roundtrip(Schema.BigInt)
      roundtrip(Schema.Symbol)

      // includes edgey keys without re-testing pointer logic exhaustively
      roundtrip(Schema.Struct({
        a: Schema.String,
        "-": Schema.NullOr(Schema.String),
        "": Schema.String
      }))

      roundtrip(Schema.Record(Schema.String, Schema.Number))
      roundtrip(Schema.StructWithRest(
        Schema.Struct({
          a: Schema.Number,
          "-": Schema.Number,
          "": Schema.Number
        }),
        [Schema.Record(Schema.String, Schema.Number)]
      ))

      roundtrip(Schema.Tuple([Schema.String, Schema.Number]))
      roundtrip(Schema.Array(Schema.Number))

      roundtrip(Schema.TupleWithRest(
        Schema.Tuple([Schema.Number]),
        [Schema.String]
      ))
      roundtrip(Schema.TupleWithRest(
        Schema.Tuple([Schema.Number]),
        [Schema.String, Schema.Boolean]
      ))

      roundtrip(Schema.Union([Schema.String, Schema.Finite]))

      roundtrip(Schema.Finite)
      roundtrip(Schema.Date)
      roundtrip(Schema.URL)
      roundtrip(Schema.RegExp)
      roundtrip(Schema.Duration)
      roundtrip(Schema.DateTimeUtc)
      roundtrip(Schema.DateValid)
      roundtrip(Schema.Uint8Array)
      roundtrip(Schema.PropertyKey)
      roundtrip(Schema.Option(Schema.String))
      roundtrip(Schema.Result(Schema.Number, Schema.String))
      roundtrip(Schema.ReadonlyMap(Schema.String, Schema.Number))
      roundtrip(Schema.Error)
      roundtrip(Schema.Defect)
      roundtrip(Schema.Exit(Schema.Number, Schema.String, Schema.Defect))

      class A extends Schema.Class<A>("A")({ value: Schema.Number }) {}
      class B extends Schema.Class<B>("B")({ a: A }) {}
      roundtrip(B)

      class E extends Schema.ErrorClass<E>("E")({ message: Schema.String }) {}
      roundtrip(E)
    })
  })
})
