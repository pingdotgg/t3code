import { Context, Option, Redactable, Redacted, Schema } from "effect"
import { format, formatJson } from "effect/Formatter"
import { describe, it } from "vitest"
import { strictEqual } from "./utils/assert.ts"

class SensitiveData implements Redactable.Redactable {
  constructor(private secret: string) {}

  f(s: string) {
    this.secret += s
  }

  [Redactable.symbolRedactable]() {
    return { secret: "[REDACTED]" }
  }
}

const data = new SensitiveData("my-secret-key")

describe("Formatter", () => {
  describe("format", () => {
    it("null", () => {
      strictEqual(format(null), `null`)
    })

    it("undefined", () => {
      strictEqual(format(undefined), `undefined`)
    })

    it("string", () => {
      strictEqual(format("a"), `"a"`)
    })

    it("number", () => {
      strictEqual(format(123), `123`)
    })

    it("boolean", () => {
      strictEqual(format(true), `true`)
    })

    it("symbol", () => {
      strictEqual(format(Symbol("a")), `Symbol(a)`)
    })

    it("bigint", () => {
      strictEqual(format(BigInt(123)), `123n`)
    })

    it("custom toString method", () => {
      strictEqual(format({ toString: () => "custom" }), `custom`)
    })

    it("array", () => {
      strictEqual(format([1, 2, 3n]), `[1,2,3n]`)
    })

    it("circular array", () => {
      const arr: any = [1]
      arr.push(arr)
      strictEqual(format(arr), `[1,[Circular]]`)
    })

    it("circular Map contents", () => {
      const obj: any = { a: 1 }
      const map = new Map([["obj", obj]])
      obj.map = map
      strictEqual(format(map), `Map([["obj",{"a":1,"map":[Circular]}]])`)
    })

    it("circular Set contents", () => {
      const obj: any = { a: 1 }
      const set = new Set([obj])
      obj.set = set
      strictEqual(format(set), `Set([{"a":1,"set":[Circular]}])`)
    })

    it("object", () => {
      strictEqual(format({ a: 1 }), `{"a":1}`)
      strictEqual(format({ a: 1, b: 2 }), `{"a":1,"b":2}`)
      strictEqual(format({ [Symbol.for("a")]: 1 }), `{Symbol(a):1}`)
      strictEqual(format({ a: 1, b: [1, 2, 3n] }), `{"a":1,"b":[1,2,3n]}`)
    })

    it("circular object", () => {
      const obj: any = { a: 1 }
      obj.b = obj
      strictEqual(format(obj), `{"a":1,"b":[Circular]}`)
    })

    it("object with null prototype", () => {
      strictEqual(format(Object.create(null)), `{}`)
      strictEqual(format(Object.create(null, { a: { value: 1 } })), `{"a":1}`)
    })

    it("function", () => {
      strictEqual(
        format(() => {}),
        `() => {
        }`
      )
      strictEqual(
        format(() => {
          return 1
        }),
        `() => {
          return 1;
        }`
      )
    })

    it("Error", () => {
      strictEqual(format(new Error("a")), `Error: a`)
      strictEqual(format(new Error("a", { cause: "b" })), `Error: a (cause: "b")`)
    })

    it("Date", () => {
      strictEqual(format(new Date(0)), `1970-01-01T00:00:00.000Z`)
      strictEqual(format(new Date("invalid")), `Invalid Date`)
    })

    it("RegExp", () => {
      strictEqual(format(/a/), `/a/`)
    })

    it("Set", () => {
      strictEqual(format(new Set([1, 2, 3])), `Set([1,2,3])`)
    })

    it("Map", () => {
      strictEqual(format(new Map([["a", 1], ["b", 2]])), `Map([["a",1],["b",2]])`)
    })

    it("FormData", () => {
      const formData = new FormData()
      formData.append("a", "1")
      strictEqual(format(formData), `FormData([["a","1"]])`)
    })

    it("Uint8Array", () => {
      const uint8Array = new Uint8Array([1, 2, 3])
      strictEqual(format(uint8Array), `Uint8Array([1,2,3])`)
    })

    it("Redacted", () => {
      strictEqual(format(Redacted.make("a")), `<redacted>`)
    })

    it("Option", () => {
      strictEqual(
        format(Option.some(1)),
        `some(1)`
      )
      strictEqual(
        format(Option.none()),
        `none()`
      )
    })

    it("Schema.Class", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String
      }) {}
      strictEqual(format(new A({ a: "a" })), `A({"a":"a"})`)
    })

    it("Schema.ErrorClass", () => {
      class E extends Schema.ErrorClass<E>("E")({
        a: Schema.String
      }) {}
      strictEqual(format(new E({ a: "a" })), `E`)
    })

    it("Context.Service", () => {
      const MyService = Context.Service<{ readonly value: number }>("MyService")
      strictEqual(format(MyService).includes(`"key": "MyService"`), true)
    })

    describe("whitespace", () => {
      it("object", () => {
        strictEqual(format({ a: 1 }, { space: 2 }), `{"a":1}`)
        strictEqual(
          format({ a: 1, b: 2 }, { space: 2 }),
          `{
  "a": 1,
  "b": 2
}`
        )
        strictEqual(
          format({ a: 1, b: [1, 2, 3n] }, { space: 2 }),
          `{
  "a": 1,
  "b": [
    1,
    2,
    3n
  ]
}`
        )
        strictEqual(format({ [Symbol.for("a")]: 1 }, { space: 2 }), `{Symbol(a):1}`)
      })

      it("circular object", () => {
        const obj: any = { a: 1 }
        obj.b = obj
        strictEqual(
          format(obj, { space: 2 }),
          `{
  "a": 1,
  "b": [Circular]
}`
        )
      })

      it("object with null prototype", () => {
        strictEqual(format(Object.create(null), { space: 2 }), `{}`)
        strictEqual(
          format(Object.create(null, { a: { value: 1 } }), { space: 2 }),
          `{"a":1}`
        )
      })
    })

    it("should redact sensitive data", () => {
      strictEqual(format(data), `{"secret":"[REDACTED]"}`)
      strictEqual(format({ a: data }), `{"a":{"secret":"[REDACTED]"}}`)
    })
  })

  describe("formatJson", () => {
    it("should omit circular references", () => {
      const obj: any = { a: 1 }
      obj.self = obj
      strictEqual(formatJson(obj), `{"a":1}`)
    })

    it("preserves repeated non-circular references", () => {
      const shared = { a: 1 }
      strictEqual(formatJson({ left: shared, right: shared }), `{"left":{"a":1},"right":{"a":1}}`)
    })

    it("should redact sensitive data", () => {
      strictEqual(formatJson(data), `{"secret":"[REDACTED]"}`)
      strictEqual(formatJson({ a: data }), `{"a":{"secret":"[REDACTED]"}}`)
    })
  })
})
