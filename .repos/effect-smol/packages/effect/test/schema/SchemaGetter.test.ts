import { DateTime, Effect, Option, Result, SchemaGetter } from "effect"
import { describe, it } from "vitest"
import { assertSome, deepStrictEqual } from "../utils/assert.ts"

function makeAsserts<T, E>(getter: SchemaGetter.Getter<T, E>) {
  return async (input: E, expected: T) => {
    const r = await Effect.runPromise(
      getter.run(Option.some(input), {}).pipe(
        Effect.mapError((issue) => issue.toString()),
        Effect.result
      )
    )
    deepStrictEqual(r, Result.succeed(Option.some(expected)))
  }
}

describe("SchemaGetter", () => {
  it("map", () => {
    const getter = SchemaGetter.succeed(1).map((t) => t + 1)
    const result = Effect.runSync(getter.run(Option.some(1), {}))
    assertSome(result, 2)
  })

  it("dateTimeUtcFromInput", async () => {
    const decoding = makeAsserts(SchemaGetter.dateTimeUtcFromInput<string>())
    await decoding("2024-01-01 01:00:00", DateTime.makeUnsafe("2024-01-01T01:00:00.000Z"))
    await decoding("2020-02-01T11:17:00+1100", DateTime.makeUnsafe("2020-02-01T00:17:00.000Z"))
    // should support strings with explicit GMT zone
    await decoding("Tue, 27 Jan 2026 17:14:06 GMT", DateTime.makeUnsafe("2026-01-27T17:14:06.000Z"))
  })

  describe("decodeFormData / encodeFormData", () => {
    const decoding = makeAsserts(SchemaGetter.decodeFormData())
    const encoding = makeAsserts(SchemaGetter.encodeFormData())

    it("should support multiple values for the same key", async () => {
      const formData = new FormData()
      formData.append("a", "1")
      formData.append("a", "2")
      const object = {
        a: ["1", "2"]
      }
      await decoding(formData, object)
      await encoding(object, formData)
    })

    it("should handle top level empty keys", async () => {
      const formData = new FormData()
      formData.append("", "value")
      const object = { "": "value" }
      await decoding(formData, object)
      await encoding(object, formData)
    })

    it("decodes simple top-level keys", async () => {
      const formData = new FormData()
      formData.append("a", "1")
      formData.append("b", "two")
      const object = {
        a: "1",
        b: "two"
      }
      await decoding(formData, object)
      await encoding(object, formData)
    })

    it("decodes nested objects via bracket notation", async () => {
      const formData = new FormData()
      formData.append("user[name]", "John")
      formData.append("user[email]", "john@example.com")
      const object = {
        user: {
          name: "John",
          email: "john@example.com"
        }
      }
      await decoding(formData, object)
      await encoding(object, formData)
    })

    it("decodes nested objects via dot notation", async () => {
      const formData = new FormData()
      formData.append("user.name", "John")
      formData.append("user.email", "john@example.com")
      const object = {
        user: {
          name: "John",
          email: "john@example.com"
        }
      }
      await decoding(formData, object)
    })

    it("decodes mixed dot + bracket notation", async () => {
      const formData = new FormData()
      formData.append("user.address[city]", "Milan")
      formData.append("user.address[zip]", "20100")
      const object = {
        user: {
          address: {
            city: "Milan",
            zip: "20100"
          }
        }
      }
      await decoding(formData, object)
    })

    it("decodes arrays with numeric indices", async () => {
      const formData = new FormData()
      formData.append("items[0]", "item1")
      formData.append("items[1]", "item2")
      const object = {
        items: ["item1", "item2"]
      }
      await decoding(formData, object)

      {
        const formData = new FormData()
        formData.append("items", "item1")
        formData.append("items", "item2")
        await encoding(object, formData)
      }
    })

    it("decodes arrays with numeric indices and nested objects", async () => {
      const formData = new FormData()
      formData.append("items[0][id]", "a")
      formData.append("items[0][name]", "Item A")
      formData.append("items[1][id]", "b")
      formData.append("items[1][name]", "Item B")
      const object = {
        items: [
          { id: "a", name: "Item A" },
          { id: "b", name: "Item B" }
        ]
      }
      await decoding(formData, object)
      await encoding(object, formData)
    })

    it("decodes arrays with [] (append)", async () => {
      const formData = new FormData()
      formData.append("tags[]", "a")
      formData.append("tags[]", "b")
      formData.append("tags[]", "c")
      const object = {
        tags: ["a", "b", "c"]
      }
      await decoding(formData, object)

      {
        const formData = new FormData()
        formData.append("tags", "a")
        formData.append("tags", "b")
        formData.append("tags", "c")
        await encoding(object, formData)
      }
    })

    it("decodes arrays with [] and nested objects", async () => {
      const formData = new FormData()
      formData.append("items[][id]", "x")
      formData.append("items[][id]", "y")
      const object = {
        items: [
          { id: "x" },
          { id: "y" }
        ]
      }
      await decoding(formData, object)
    })

    it("decodes mixed indexed and append arrays under the same key", async () => {
      const formData = new FormData()
      formData.append("items[0]", "a")
      formData.append("items[]", "b")
      formData.append("items[]", "c")
      const object = {
        items: ["a", "b", "c"]
      }
      // Implementation detail: first write at index 0, then pushes at 1 and 2
      await decoding(formData, object)
    })

    it("decodes nested objects inside appended array elements", async () => {
      const formData = new FormData()
      formData.append("users[][name]", "John")
      formData.append("users[][name]", "Alice")
      const object = {
        users: [
          { name: "John" },
          { name: "Alice" }
        ]
      }
      await decoding(formData, object)
    })

    it("decodes complex mixed structure", async () => {
      const formData = new FormData()
      formData.append("user[name]", "John")
      formData.append("user[address][city]", "Milan")
      formData.append("user[address][zip]", "20100")
      formData.append("orders[0][id]", "o1")
      formData.append("orders[0][total]", "10")
      formData.append("orders[1][id]", "o2")
      formData.append("orders[1][total]", "20")
      formData.append("tags[0]", "a")
      formData.append("tags[1]", "b")
      const object = {
        user: {
          name: "John",
          address: {
            city: "Milan",
            zip: "20100"
          }
        },
        orders: [
          { id: "o1", total: "10" },
          { id: "o2", total: "20" }
        ],
        tags: ["a", "b"]
      }
      await decoding(formData, object)
    })
  })

  describe("decodeURLSearchParams / encodeURLSearchParams", () => {
    const decoding = makeAsserts(SchemaGetter.decodeURLSearchParams())
    const encoding = makeAsserts(SchemaGetter.encodeURLSearchParams())

    it("should support multiple values for the same key", async () => {
      const urlSearchParams = new URLSearchParams("a=1&a=2")
      const object = {
        a: ["1", "2"]
      }
      await decoding(urlSearchParams, object)
      await encoding(object, urlSearchParams)
    })

    it("should handle top level empty keys", async () => {
      const urlSearchParams = new URLSearchParams("=value")
      const object = { "": "value" }
      await decoding(urlSearchParams, object)
      await encoding(object, urlSearchParams)
    })

    it("decodes simple top-level keys", async () => {
      const urlSearchParams = new URLSearchParams("a=1&b=two")
      const object = {
        a: "1",
        b: "two"
      }
      await decoding(urlSearchParams, object)
      await encoding(object, urlSearchParams)
    })

    it("decodes nested objects via bracket notation", async () => {
      const urlSearchParams = new URLSearchParams("user[name]=John&user[email]=john@example.com")
      const object = {
        user: {
          name: "John",
          email: "john@example.com"
        }
      }
      await decoding(urlSearchParams, object)
      await encoding(object, urlSearchParams)
    })

    it("decodes nested objects via dot notation", async () => {
      const urlSearchParams = new URLSearchParams("user.name=John&user.email=john@example.com")
      const object = {
        user: {
          name: "John",
          email: "john@example.com"
        }
      }
      await decoding(urlSearchParams, object)
    })

    it("decodes mixed dot + bracket notation", async () => {
      const urlSearchParams = new URLSearchParams("user.address[city]=Milan&user.address[zip]=20100")
      const object = {
        user: {
          address: {
            city: "Milan",
            zip: "20100"
          }
        }
      }
      await decoding(urlSearchParams, object)
    })

    it("decodes arrays with numeric indices", async () => {
      const urlSearchParams = new URLSearchParams("items[0]=item1&items[1]=item2")
      const object = {
        items: ["item1", "item2"]
      }
      await decoding(urlSearchParams, object)

      {
        const urlSearchParams = new URLSearchParams("items=item1&items=item2")
        await encoding(object, urlSearchParams)
      }
    })

    it("decodes arrays with numeric indices and nested objects", async () => {
      const urlSearchParams = new URLSearchParams(
        "items[0][id]=a&items[0][name]=Item A&items[1][id]=b&items[1][name]=Item B"
      )
      const object = {
        items: [
          { id: "a", name: "Item A" },
          { id: "b", name: "Item B" }
        ]
      }
      await decoding(urlSearchParams, object)
      await encoding(object, urlSearchParams)
    })

    it("decodes arrays with [] (append)", async () => {
      const urlSearchParams = new URLSearchParams("tags[]=a&tags[]=b&tags[]=c")
      const object = {
        tags: ["a", "b", "c"]
      }
      await decoding(urlSearchParams, object)

      {
        const urlSearchParams = new URLSearchParams("tags=a&tags=b&tags=c")
        await encoding(object, urlSearchParams)
      }
    })

    it("decodes arrays with [] and nested objects", async () => {
      const urlSearchParams = new URLSearchParams("items[][id]=x&items[][id]=y")
      const object = {
        items: [{ id: "x" }, { id: "y" }]
      }
      await decoding(urlSearchParams, object)
    })

    it("decodes mixed indexed and append arrays under the same key", async () => {
      const urlSearchParams = new URLSearchParams("items[0]=a&items[]=b&items[]=c")
      const object = {
        items: ["a", "b", "c"]
      }
      // Implementation detail: first write at index 0, then pushes at 1 and 2
      await decoding(urlSearchParams, object)
    })

    it("decodes nested objects inside appended array elements", async () => {
      const urlSearchParams = new URLSearchParams("users[][name]=John&users[][name]=Alice")
      const object = {
        users: [
          { name: "John" },
          { name: "Alice" }
        ]
      }
      await decoding(urlSearchParams, object)
    })

    it("decodes complex mixed structure", async () => {
      const urlSearchParams = new URLSearchParams(
        "user[name]=John&user.address[city]=Milan&user.address[zip]=20100&orders[0][id]=o1&orders[0][total]=10&orders[1][id]=o2&orders[1][total]=20&tags[0]=a&tags[1]=b"
      )
      const object = {
        user: {
          name: "John",
          address: {
            city: "Milan",
            zip: "20100"
          }
        },
        orders: [
          { id: "o1", total: "10" },
          { id: "o2", total: "20" }
        ],
        tags: ["a", "b"]
      }
      await decoding(urlSearchParams, object)
    })
  })
})
