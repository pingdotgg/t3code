import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import type { JsonSchema } from "effect"
import { HttpRouter } from "effect/http"
import { OpenRpc, Rpc, RpcGroup, RpcMiddleware, RpcSchema, RpcSerialization, RpcServer } from "effect/rpc"

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const AjvDraft07 = require("ajv")
const ajv = new AjvDraft07.default({ allErrors: true, strict: false, validateFormats: false })
const options = { info: { title: "Contract tests", version: "1.0.0" } }

const method = (document: OpenRpc.OpenRPCSpec, name: string) => {
  const result = document.methods.find((method) => method.name === name)
  assert.isDefined(result, `Missing method ${name}`)
  return result!
}

const accepts = (document: OpenRpc.OpenRPCSpec, schema: JsonSchema.JsonSchema, value: unknown) =>
  ajv.compile({ ...schema, components: document.components })(value)

const sortErrors = (errors: ReadonlyArray<OpenRpc.OpenRPCError> | undefined) =>
  errors?.slice().sort((a, b) => a.code - b.code)

describe("OpenRpc", () => {
  it("describes encoded named parameters", () => {
    const Payload = Schema.Struct({
      optional: Schema.optionalKey(Schema.String),
      amount: Schema.NumberFromString
    }).annotate({ identifier: "ConvertParams" })
    const document = OpenRpc.fromRpcGroup(
      RpcGroup.make(Rpc.make("convert", { payload: Payload, success: Schema.NumberFromString })),
      options
    )
    const convert = method(document, "convert")
    assert.strictEqual(convert.paramStructure, "by-name")
    assert.deepStrictEqual(convert.params, [
      { name: "amount", required: true, schema: { type: "string" } },
      { name: "optional", required: false, schema: { type: "string" } }
    ])
    const params = convert["x-effect-params-schema"]!
    assert.isTrue(accepts(document, params, { amount: "42" }))
    assert.isFalse(accepts(document, params, { amount: 42 }))
    assert.isFalse(accepts(document, params, { optional: "x" }))
    assert.isTrue(accepts(document, convert.result.schema, "42"))
    assert.isFalse(accepts(document, convert.result.schema, 42))
  })

  it("describes the fixed prefix of positional parameters", () => {
    const document = OpenRpc.fromRpcGroup(
      RpcGroup.make(
        Rpc.make("tuple", { payload: Schema.Tuple([Schema.NumberFromString, Schema.optionalKey(Schema.Boolean)]) }),
        Rpc.make("rest", { payload: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Boolean]) })
      ),
      options
    )
    const tuple = method(document, "tuple")
    assert.strictEqual(tuple.paramStructure, "by-position")
    assert.deepStrictEqual(tuple.params, [
      { name: "0", required: true, schema: { type: "string" } },
      { name: "1", required: false, schema: { type: "boolean" } }
    ])
    assert.isTrue(accepts(document, tuple["x-effect-params-schema"]!, ["1"]))
    assert.isFalse(accepts(document, tuple["x-effect-params-schema"]!, ["1", false, true]))
    const rest = method(document, "rest")
    assert.strictEqual(rest.paramStructure, "by-position")
    assert.deepStrictEqual(rest.params, [{ name: "0", required: true, schema: { type: "string" } }])
    assert.isTrue(accepts(document, rest["x-effect-params-schema"]!, ["prefix", true, false]))
    assert.isFalse(accepts(document, rest["x-effect-params-schema"]!, ["prefix", 1]))
  })

  it("keeps the whole schema for union and record payloads", () => {
    const document = OpenRpc.fromRpcGroup(
      RpcGroup.make(
        Rpc.make("mixed", {
          payload: Schema.Union([Schema.Struct({ name: Schema.String }), Schema.Tuple([Schema.String])])
        }),
        Rpc.make("record", { payload: Schema.Record(Schema.String, Schema.NumberFromString) })
      ),
      options
    )
    const mixed = method(document, "mixed")
    assert.strictEqual(mixed.paramStructure, "either")
    assert.deepStrictEqual(mixed.params, [])
    assert.isTrue(accepts(document, mixed["x-effect-params-schema"]!, { name: "Ada" }))
    assert.isTrue(accepts(document, mixed["x-effect-params-schema"]!, ["Ada"]))
    assert.isFalse(accepts(document, mixed["x-effect-params-schema"]!, "Ada"))
    const record = method(document, "record")
    assert.strictEqual(record.paramStructure, "by-name")
    assert.deepStrictEqual(record.params, [])
    assert.isTrue(accepts(document, record["x-effect-params-schema"]!, { any: "1" }))
    assert.isFalse(accepts(document, record["x-effect-params-schema"]!, { any: 1 }))
  })

  it("shares definitions and keeps colliding recursive identifiers apart", () => {
    interface TextNode {
      readonly value: string
      readonly children: ReadonlyArray<TextNode>
    }
    interface CountNode {
      readonly value: number
      readonly children: ReadonlyArray<CountNode>
    }
    const TextNode: Schema.Codec<TextNode> = Schema.Struct({
      value: Schema.String,
      children: Schema.Array(Schema.suspend(() => TextNode))
    }).annotate({ identifier: "Node" })
    const CountNode: Schema.Codec<CountNode> = Schema.Struct({
      value: Schema.Int,
      children: Schema.Array(Schema.suspend(() => CountNode))
    }).annotate({ identifier: "Node" })
    const document = OpenRpc.fromRpcGroup(
      RpcGroup.make(
        Rpc.make("text", { payload: { node: TextNode }, success: TextNode }),
        Rpc.make("count", { success: CountNode })
      ),
      options
    )
    const text = method(document, "text")
    const count = method(document, "count").result.schema
    assert.isString(text.result.schema.$ref)
    assert.strictEqual(text.params[0].schema.$ref, text.result.schema.$ref)
    assert.notStrictEqual(count.$ref, text.result.schema.$ref)
    assert.isTrue(accepts(document, text.result.schema, { value: "a", children: [{ value: "b", children: [] }] }))
    assert.isFalse(accepts(document, text.result.schema, { value: "a", children: [{ value: 1, children: [] }] }))
    assert.isTrue(accepts(document, count, { value: 1, children: [{ value: 2, children: [] }] }))
    assert.isFalse(accepts(document, count, { value: 1, children: [{ value: "b", children: [] }] }))
  })

  it("keeps references into shared definitions valid after Draft 7 lowering", () => {
    const Pair = Schema.Tuple([Schema.String]).annotate({ identifier: "Pair" })
    const First = Schema.String.check(Schema.makeFilter(() => true, {
      representation: { id: "test/OpenRpc/First", payload: null, schemas: [Pair.ast] },
      toJsonSchema: ({ schemas }) => ({ $ref: `${schemas[0].$ref}/prefixItems/0` })
    }))
    const document = OpenRpc.fromRpcGroup(
      RpcGroup.make(Rpc.make("first", { success: Schema.Struct({ value: First }) })),
      options
    )
    const result = method(document, "first").result.schema
    assert.isTrue(accepts(document, result, { value: "a" }))
    assert.isFalse(accepts(document, result, { value: 1 }))
  })

  it("keeps external references in descriptors", () => {
    const External = Schema.Any.check(Schema.makeFilter((value) => typeof value === "string", {
      toJsonSchema: () => ({ $ref: "https://example.com/string.json" })
    }))
    const document = OpenRpc.fromRpcGroup(RpcGroup.make(Rpc.make("external", { success: External })), options)
    assert.strictEqual(method(document, "external").result.schema.$ref, "https://example.com/string.json")
  })

  it("describes void calls with a null result and rejects scalar payloads", () => {
    const document = OpenRpc.fromRpcGroup(RpcGroup.make(Rpc.make("void")), {
      ...options,
      servers: [{ name: "production", url: "https://example.com/rpc" }]
    })
    assert.deepStrictEqual(document, {
      openrpc: "1.3.2",
      info: options.info,
      servers: [{ name: "production", url: "https://example.com/rpc" }],
      methods: [{
        name: "void",
        paramStructure: "by-name",
        params: [],
        result: { name: "result", schema: { type: "null" } }
      }],
      components: { schemas: {} }
    })
    assert.throws(
      () => OpenRpc.fromRpcGroup(RpcGroup.make(Rpc.make("scalar", { payload: Schema.String })), options),
      /"scalar"/
    )
  })

  it("applies group annotation defaults and method overrides", () => {
    const examples = [{ name: "default", params: [], result: { name: "result", value: null } }]
    const group = RpcGroup.make(
      Rpc.make("inherited").annotateMerge(OpenRpc.annotations({ summary: undefined, tags: undefined })),
      Rpc.make("overridden").annotateMerge(OpenRpc.annotations({
        summary: "Local summary",
        description: "Local description",
        tags: [],
        examples: [],
        errors: [],
        deprecated: false,
        externalDocs: { url: "https://example.com/local" }
      }))
    )
      .annotate(OpenRpc.Summary, "Default summary")
      .annotate(OpenRpc.Description, "Default description")
      .annotate(OpenRpc.Tags, [{ name: "default" }])
      .annotate(OpenRpc.Examples, examples)
      .annotate(OpenRpc.Errors, [{ code: 7, message: "Unavailable" }])
      .annotate(OpenRpc.Deprecated, true)
      .annotate(OpenRpc.ExternalDocs, { url: "https://example.com/default" })
    const document = OpenRpc.fromRpcGroup(group, options)
    const { name: _, ...inherited } = method(document, "inherited")
    assert.deepStrictEqual(inherited, {
      paramStructure: "by-name",
      params: [],
      result: { name: "result", schema: { type: "null" } },
      summary: "Default summary",
      description: "Default description",
      tags: [{ name: "default" }],
      examples,
      deprecated: true,
      externalDocs: { url: "https://example.com/default" },
      errors: [{ code: 7, message: "Unavailable" }]
    })
    const overridden = method(document, "overridden")
    assert.strictEqual(overridden.summary, "Local summary")
    assert.strictEqual(overridden.description, "Local description")
    assert.deepStrictEqual(overridden.tags, [])
    assert.deepStrictEqual(overridden.examples, [])
    assert.deepStrictEqual(overridden.errors, [])
    assert.strictEqual(overridden.deprecated, false)
    assert.deepStrictEqual(overridden.externalDocs, { url: "https://example.com/local" })
  })

  it("derives literal error metadata on a best-effort basis", () => {
    class Auth extends RpcMiddleware.Service<Auth>()("OpenRpcTest/Auth", {
      error: Schema.Struct({ code: Schema.Literal(42), message: Schema.Literal("Unauthorized") })
    }) {}
    const Known = Schema.Struct({ code: Schema.Literal("41"), message: Schema.Literal("Known") })
    const Dynamic = Schema.Struct({ code: Schema.Int, message: Schema.String })
    const document = OpenRpc.fromRpcGroup(
      RpcGroup.make(
        Rpc.make("derived", { error: Schema.Union([Known, Dynamic]) }).middleware(Auth),
        Rpc.make("dynamic", { error: Dynamic }),
        Rpc.make("explicit", { error: Known }).annotate(OpenRpc.Errors, [{ code: 7, message: "Explicit" }])
      ),
      options
    )
    assert.deepStrictEqual(sortErrors(method(document, "derived").errors), [
      { code: 41, message: "Known" },
      { code: 42, message: "Unauthorized" }
    ])
    assert.isUndefined(method(document, "dynamic").errors)
    assert.deepStrictEqual(method(document, "explicit").errors, [{ code: 7, message: "Explicit" }])
  })

  it("ignores Never members when deriving literal errors", () => {
    const document = OpenRpc.fromRpcGroup(
      RpcGroup.make(Rpc.make("never", {
        error: Schema.Struct({
          code: Schema.Union([Schema.Literal(41), Schema.Never]),
          message: Schema.Union([Schema.Literal("Known"), Schema.suspend(() => Schema.Never)])
        })
      })),
      options
    )
    assert.deepStrictEqual(method(document, "never").errors, [{ code: 41, message: "Known" }])
  })

  it("describes streams for both stream constructors", () => {
    const Item = Schema.Struct({ value: Schema.NumberFromString }).annotate({ identifier: "StreamItem" })
    const StreamFailure = Schema.Struct({ code: Schema.Literal(21), message: Schema.Literal("Stream failed") })
    const RpcFailure = Schema.Struct({ code: Schema.Literal(22), message: Schema.Literal("RPC failed") })
    const document = OpenRpc.fromRpcGroup(
      RpcGroup.make(
        Rpc.make("flag", { success: Item, error: StreamFailure, stream: true }),
        Rpc.make("schema", { success: RpcSchema.Stream(Item, StreamFailure), error: RpcFailure }),
        Rpc.make("unary", { success: Item })
      ),
      options
    )
    for (const name of ["flag", "schema"]) {
      const streaming = method(document, name)
      const stream = streaming["x-effect-stream"]!
      assert.strictEqual(stream.encoding, "effect-jsonrpc")
      assert.deepStrictEqual(streaming.result.schema, { type: "null" })
      assert.isTrue(accepts(document, stream.itemSchema, { value: "1" }))
      assert.isFalse(accepts(document, stream.itemSchema, { value: 1 }))
      assert.isTrue(accepts(document, stream.chunkSchema, [{ value: "1" }]))
      assert.isFalse(accepts(document, stream.chunkSchema, []))
      const error = { code: 21, message: "Stream failed" }
      assert.isTrue(accepts(document, stream.errorSchema, error))
      assert.isTrue(accepts(document, stream.causeSchema, [{ _tag: "Fail", error }]))
    }
    assert.deepStrictEqual(sortErrors(method(document, "schema").errors), [
      { code: 21, message: "Stream failed" },
      { code: 22, message: "RPC failed" }
    ])
    assert.isUndefined(method(document, "unary")["x-effect-stream"])
  })

  it.effect("describes what the JSON-RPC serializer sends", () =>
    Effect.gen(function*() {
      const NotFound = Schema.Struct({ code: Schema.Literal(404), message: Schema.Literal("Not found") })
      const Rpcs = RpcGroup.make(
        Rpc.make("Convert", {
          payload: { at: Schema.Date, count: Schema.NumberFromString },
          success: Schema.Struct({ at: Schema.Date, count: Schema.BigInt })
        }),
        Rpc.make("Missing", { error: NotFound }),
        Rpc.make("Values", { success: Schema.BigInt, stream: true })
      )
      const { dispose, handler } = HttpRouter.toWebHandler(
        RpcServer.layerHttp({ group: Rpcs, path: "/rpc", protocol: "http" }).pipe(
          Layer.provide(Rpcs.toLayer({
            Convert: ({ at, count }) => Effect.succeed({ at, count: BigInt(count) }),
            Missing: () => Effect.fail({ code: 404 as const, message: "Not found" as const }),
            Values: () => Stream.make(1n, 2n)
          })),
          Layer.provide(RpcSerialization.layerNdJsonRpc())
        )
      )
      yield* Effect.addFinalizer(() => Effect.promise(dispose))
      const call = (method: string, params?: unknown) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request("http://test/rpc", {
              method: "POST",
              headers: { "content-type": "application/json-rpc" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"
            })
          )
          return (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
        })
      const spec = OpenRpc.fromRpcGroup(Rpcs, options)

      const params = { at: "1970-01-01T00:00:00.000Z", count: "42" }
      assert.isTrue(accepts(spec, method(spec, "Convert")["x-effect-params-schema"]!, params))
      const [converted] = yield* call("Convert", params)
      assert.deepStrictEqual(converted.result, params)
      assert.isTrue(accepts(spec, method(spec, "Convert").result.schema, converted.result))

      const [missing] = yield* call("Missing")
      assert.deepStrictEqual(method(spec, "Missing").errors, [
        { code: missing.error.code, message: missing.error.message }
      ])

      const frames = yield* call("Values")
      const stream = method(spec, "Values")["x-effect-stream"]!
      const terminal = frames.pop()
      assert.isTrue(frames.length > 0)
      for (const frame of frames) {
        assert.isTrue(frame.chunk)
        assert.isTrue(accepts(spec, stream.chunkSchema, frame.result))
      }
      assert.deepStrictEqual(frames.flatMap((frame) => frame.result), ["1", "2"])
      assert.isTrue(accepts(spec, method(spec, "Values").result.schema, terminal.result))
    }))
})
