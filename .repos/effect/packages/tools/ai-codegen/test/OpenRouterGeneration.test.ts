import * as Config from "@effect/ai-codegen/Config"
import * as Generator from "@effect/ai-codegen/Generator"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"

const generateAndImport = Effect.fn(function*(schemas: Record<string, unknown>) {
  const fs = yield* FileSystem.FileSystem
  const generator = yield* Generator.CodeGenerator
  const code = yield* generator.generate({
    name: "openrouter",
    packagePath: ".",
    outputPath: "Generated.ts",
    specSource: Config.SpecSource.File("fixture.json"),
    config: new Config.CodegenConfig({
      spec: "fixture.json",
      output: "Generated.ts",
      includeSchemas: ["Root"],
      closeObjects: true
    })
  }, {
    openapi: "3.1.0",
    info: { title: "OpenRouter", version: "1.0.0" },
    paths: {},
    components: { schemas }
  })
  const directory = yield* fs.makeTempDirectoryScoped({ directory: import.meta.dirname })
  const file = `${directory}/Generated.ts`
  yield* fs.writeFileString(file, code)
  const generated = yield* Effect.promise(() => import(file))
  return generated.Root as Schema.Codec<unknown, unknown>
})

describe("OpenRouter generation", () => {
  it.effect("shares references through annotation-only allOf members", () =>
    Effect.gen(function*() {
      const schema = yield* generateAndImport({
        Base: {
          description: "Base",
          oneOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "number" } }, required: ["b"] }
          ]
        },
        Root: {
          type: "object",
          properties: {
            first: { allOf: [{ $ref: "#/components/schemas/Base" }, { description: "First" }] },
            second: {
              allOf: [{ description: "Second" }, { $ref: "#/components/schemas/Base" }],
              description: "Outer"
            }
          },
          required: ["first", "second"]
        }
      })
      assert(SchemaAST.isObjects(schema.ast))
      const [first, second] = schema.ast.propertySignatures
      assert(SchemaAST.isSuspend(first.type))
      assert(SchemaAST.isSuspend(second.type))
      assert.strictEqual(first.type.thunk(), second.type.thunk())
      assert.strictEqual(first.type.annotations?.description, "First")
      assert.strictEqual(second.type.annotations?.description, "Second")
      assert.strictEqual(first.type.thunk().annotations?.description, "Base")

      const decode = Schema.decodeUnknownExit(schema)
      const value = { first: { a: "a" }, second: { b: 1 } }
      assert.deepStrictEqual(decode(value), Exit.succeed(value))
      assert.isTrue(Exit.isFailure(decode({ first: { a: 1 }, second: { b: 1 } })))
      assert.isTrue(Exit.isFailure(decode({ first: { a: "a" }, second: { b: "b" } })))
    }).pipe(Effect.provide(Generator.layerSchema.pipe(Layer.provideMerge(NodeServices.layer)))))

  it.effect.each([
    {
      name: "merges object constraints beside allOf annotations",
      schemas: {
        Base: { type: "object", properties: { base: { type: "string" } } },
        Root: {
          allOf: [
            { description: "Root" },
            { $ref: "#/components/schemas/Base" },
            { description: "Extra", properties: { extra: { type: "number" } }, required: ["extra"] }
          ]
        }
      },
      valid: [{ base: "base", extra: 1 }],
      invalid: [{ base: "base" }, { base: "base", extra: "extra" }]
    },
    ...[
      {
        name: "a type array",
        schema: { type: ["object", "null"], properties: { message: { type: "string" } } }
      },
      {
        name: "anyOf",
        schema: {
          anyOf: [
            { type: "object", properties: { message: { type: "string" } } },
            { type: "null" }
          ]
        }
      }
    ].map(({ name, schema }) => ({
      name: `intersects an already-nullable reference using ${name}`,
      schemas: {
        Base: schema,
        Root: {
          allOf: [
            { $ref: "#/components/schemas/Base", nullable: true },
            { type: ["object", "null"], properties: { code: { type: "string" } } }
          ]
        }
      },
      valid: [null, { message: "failed", code: "server_error" }],
      invalid: [{ message: 1 }, { code: 1 }]
    })),
    {
      name: "preserves inherited fields when closing a nullable allOf base",
      // Reduced from BaseReasoningConfig and ReasoningConfig.
      schemas: {
        Base: { type: ["object", "null"], properties: { effort: { type: "string" } } },
        Root: {
          allOf: [
            { $ref: "#/components/schemas/Base" },
            { type: "object", properties: { enabled: { type: "boolean" } } }
          ]
        }
      },
      valid: [{ effort: "high", enabled: true }],
      invalid: [null, { effort: 1 }, { enabled: 1 }]
    },
    {
      name: "closes composed array items after combining their properties",
      // Output item intersections must retain fields declared by either operand.
      schemas: {
        Base: { type: "array", items: { type: "object", properties: { value: { type: "string" } } } },
        Root: {
          allOf: [
            { $ref: "#/components/schemas/Base" },
            { type: "array", items: { type: "object", properties: { extra: { type: "number" } } } }
          ]
        }
      },
      valid: [[{ value: "value", extra: 1 }]],
      invalid: [[{ value: 1 }], [{ extra: "value" }]]
    },
    ...[
      {
        name: "enum",
        schema: { type: ["string", "null"], enum: ["ok"] }
      },
      {
        name: "a sibling type",
        schema: { type: "string", anyOf: [{ const: "ok" }, { type: "null" }] }
      },
      {
        name: "allOf on the null branch",
        schema: { anyOf: [{ const: "ok" }, { type: "null", allOf: [{ type: "string" }] }] }
      }
    ].map(({ name, schema }) => ({
      name: `adds null when ${name} excludes it`,
      schemas: {
        Base: schema,
        Root: { $ref: "#/components/schemas/Base", nullable: true }
      },
      valid: [null, "ok"],
      invalid: ["other", 1]
    }))
  ])("$name", ({ invalid, schemas, valid }) =>
    Effect.gen(function*() {
      const schema = yield* generateAndImport(schemas)
      const decode = Schema.decodeUnknownExit(schema)

      for (const input of valid) {
        assert.deepStrictEqual(decode(input), Exit.succeed(input))
      }
      for (const input of invalid) {
        assert.isTrue(Exit.isFailure(decode(input)))
      }
    }).pipe(Effect.provide(Generator.layerSchema.pipe(Layer.provideMerge(NodeServices.layer)))))
})
