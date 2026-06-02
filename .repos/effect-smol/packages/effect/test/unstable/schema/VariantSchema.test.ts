import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import { Model, VariantSchema } from "effect/unstable/schema"

describe("VariantSchema", () => {
  it("FieldOnly and FieldExcept select fields from key arrays", () => {
    const Test = VariantSchema.make({
      variants: ["a", "b", "c"],
      defaultVariant: "a"
    })
    const struct = Test.Struct({
      common: Schema.String,
      onlyB: Test.FieldOnly(["b"])(Schema.Number),
      exceptC: Test.FieldExcept(["c"])(Schema.Boolean)
    })

    assert.deepStrictEqual(Object.keys(Test.extract(struct, "a").fields), ["common", "exceptC"])
    assert.deepStrictEqual(Object.keys(Test.extract(struct, "b").fields), ["common", "onlyB", "exceptC"])
    assert.deepStrictEqual(Object.keys(Test.extract(struct, "c").fields), ["common"])
  })
})

describe("Model", () => {
  it("FieldOnly includes fields only in listed variants", () => {
    const InsertOnly = Model.Struct({
      value: Model.FieldOnly(["insert"])(Schema.String)
    })

    assert.deepStrictEqual(Object.keys(Model.extract(InsertOnly, "insert").fields), ["value"])
    assert.deepStrictEqual(Object.keys(Model.extract(InsertOnly, "select").fields), [])
  })

  it("BooleanSqlite encodes database bits and JSON booleans across variants", () => {
    const User = Model.Struct({
      active: Model.BooleanSqlite
    })

    const select = Model.extract(User, "select")
    const json = Model.extract(User, "json")
    const encodeSelect = Schema.encodeSync(select)
    const decodeSelect = Schema.decodeSync(select)
    const encodeJson = Schema.encodeSync(json)
    const decodeJson = Schema.decodeSync(json)

    assert.deepStrictEqual(encodeSelect({ active: true }), { active: 1 })
    assert.deepStrictEqual(decodeSelect({ active: 0 }), { active: false })
    assert.deepStrictEqual(encodeJson({ active: true }), { active: true })
    assert.deepStrictEqual(decodeJson({ active: false }), { active: false })
  })

  it.effect("Overrideable defaults are constructor-only and accept explicit overrides", () =>
    Effect.gen(function*() {
      const User = Model.Struct({
        createdAt: Model.DateTimeInsertFromNumber
      })

      const insert = Model.extract(User, "insert")

      const now = yield* DateTime.now
      const user = yield* insert.makeEffect({})
      assert.deepStrictEqual(user.createdAt, now)

      yield* Schema.encodeEffect(insert)({
        createdAt: Model.Override(now)
      })

      const error = yield* Schema.decodeUnknownEffect(insert)({}).pipe(
        Effect.flip
      )
      assert.include(error.message, "createdAt")
    }))
})
