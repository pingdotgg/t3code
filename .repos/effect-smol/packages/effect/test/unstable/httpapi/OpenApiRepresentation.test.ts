import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

describe("OpenApi representation v2 consumer", () => {
  it("uses canonical JSON codecs for additional declaration schemas", () => {
    const AdditionalDate = Schema.Date.annotate({ identifier: "AdditionalDate" })
    const Api = HttpApi.make("Api").annotate(HttpApi.AdditionalSchemas, [AdditionalDate])

    assert.deepStrictEqual(OpenApi.fromApi(Api).components.schemas, {
      AdditionalDate: { $ref: "#/components/schemas/AdditionalDateJsonEncoding" },
      AdditionalDateJsonEncoding: { type: "string" }
    })
  })

  it("uses canonical JSON codecs for response declaration schemas", () => {
    const Api = HttpApi.make("Api").add(
      HttpApiGroup.make("test").add(
        HttpApiEndpoint.get("date", "/date", { success: Schema.Date })
      )
    )

    assert.deepStrictEqual(
      OpenApi.fromApi(Api).paths["/date"]?.get?.responses[200]?.content?.["application/json"]?.schema,
      { type: "string" }
    )
  })

  it("projects request and response schemas to the encoded side", () => {
    const Api = HttpApi.make("Api").add(
      HttpApiGroup.make("test").add(
        HttpApiEndpoint.post("create", "/create", {
          payload: Schema.FiniteFromString,
          success: Schema.FiniteFromString
        })
      )
    )

    const spec = OpenApi.fromApi(Api)

    assert.deepStrictEqual(
      spec.paths["/create"]?.post?.requestBody?.content["application/json"]?.schema,
      { type: "string" }
    )
    assert.deepStrictEqual(
      spec.paths["/create"]?.post?.responses[200]?.content?.["application/json"]?.schema,
      { type: "string" }
    )
  })

  it("uses custom JSON Schema compiler annotations", () => {
    const CustomString = Schema.String.check(Schema.makeFilter<string>((value) => value.length >= 2, {
      representation: {
        id: "test/openapi/minTwoCharacters",
        payload: null
      },
      toJsonSchema: () => ({ minLength: 2 })
    }))
    const Api = HttpApi.make("Api").add(
      HttpApiGroup.make("test").add(
        HttpApiEndpoint.post("create", "/create", { payload: CustomString })
      )
    )

    assert.deepStrictEqual(
      OpenApi.fromApi(Api).paths["/create"]?.post?.requestBody?.content["application/json"]?.schema,
      {
        type: "string",
        allOf: [{ minLength: 2 }]
      }
    )
  })

  it("shares definitions and caches by API identity", () => {
    const Shared = Schema.Struct({ value: Schema.FiniteFromString }).annotate({ identifier: "Shared" })
    const Api = HttpApi.make("Api").add(
      HttpApiGroup.make("test").add(
        HttpApiEndpoint.post("shared", "/shared", {
          payload: Schema.Struct({ first: Shared, second: Shared }),
          success: Shared
        })
      )
    )

    const first = OpenApi.fromApi(Api)

    assert.strictEqual(OpenApi.fromApi(Api), first)
    assert.deepStrictEqual(first.components.schemas.Shared, {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    })
  })
})
