import { assert, describe, it } from "@effect/vitest"
import {
  Config,
  ConfigProvider,
  Duration,
  Effect,
  Option,
  pipe,
  Redacted,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation
} from "effect"
import { vi } from "vitest"
import type * as ConfigProviderModule from "../src/ConfigProvider.ts"

async function assertSuccess<T>(config: Config.Config<T>, provider: ConfigProvider.ConfigProvider, expected: T) {
  const r = await config.parse(provider).pipe(
    Effect.result,
    Effect.runPromise
  )
  assert.deepStrictEqual(r, Result.succeed(expected))
}

async function assertFailure<T>(config: Config.Config<T>, provider: ConfigProvider.ConfigProvider, message: string) {
  const r = await config.parse(provider).pipe(
    Effect.mapError((e) => e.cause.message),
    Effect.result,
    Effect.runPromise
  )
  assert.deepStrictEqual(r, Result.fail(message))
}

describe("Config", () => {
  it("recognizes SourceError defects from a reloaded module copy", async () => {
    vi.resetModules()
    const ForeignConfigProvider = await vi.importActual<typeof ConfigProviderModule>(
      "../src/ConfigProvider.ts"
    )
    const sourceError = new ForeignConfigProvider.SourceError({ message: "source unavailable" })
    assert.isFalse(sourceError instanceof ConfigProvider.SourceError)

    const provider = ConfigProvider.make(() => Effect.die(sourceError))
    const error = await Config.string("value").parse(provider).pipe(
      Effect.flip,
      Effect.runPromise
    )

    assert.strictEqual(error.cause, sourceError)
  })

  it.effect("uses the current ConfigProvider when yielded as an Effect", () =>
    Effect.gen(function*() {
      const provider = ConfigProvider.fromEnv({ env: { STRING: "value" } })
      const result = yield* Effect.provide(
        Config.schema(Schema.Struct({ STRING: Schema.String })),
        ConfigProvider.layer(provider)
      )

      assert.deepStrictEqual(result, { STRING: "value" })
    }))

  describe("constructors", () => {
    it("fail creates an always-failing config", async () => {
      await assertFailure(
        Config.fail(
          new Schema.SchemaError(new SchemaIssue.Forbidden({ message: "failure message" }))
        ),
        ConfigProvider.fromUnknown({}),
        `failure message`
      )
    })

    it("succeed creates a provider-independent value", async () => {
      const provider = ConfigProvider.fromUnknown({})
      await assertSuccess(Config.succeed(1), provider, 1)
    })

    it("string decodes present input and reports absence", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "value" })
      await assertSuccess(Config.string("a"), provider, "value")
      await assertFailure(
        Config.string("b"),
        provider,
        `Expected string
  at ["b"]`
      )
    })

    it("nonEmptyString rejects preserved empty input", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "value", b: "" }, { preserveEmptyStrings: true })
      await assertSuccess(Config.nonEmptyString("a"), provider, "value")
      await assertFailure(
        Config.nonEmptyString("b"),
        provider,
        `Expected a value with a length of at least 1
  at ["b"]`
      )
    })

    it("number accepts finite and non-finite numbers", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "1", c: "c", d: "Infinity" })
      await assertSuccess(Config.number("a"), provider, 1)
      await assertSuccess(Config.number("d"), provider, Infinity)
      await assertFailure(
        Config.number("b"),
        provider,
        `Expected string | "Infinity" | "-Infinity" | "NaN"
  at ["b"]`
      )
    })

    it("finite rejects invalid and non-finite numbers", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "1", b: "a", c: "Infinity" })
      await assertSuccess(Config.finite("a"), provider, 1)
      await assertFailure(
        Config.finite("b"),
        provider,
        `Expected a string representing a finite number
  at ["b"]`
      )
      await assertFailure(
        Config.finite("c"),
        provider,
        `Expected a string representing a finite number
  at ["c"]`
      )
    })

    it("int rejects non-integer numbers", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "1", b: "1.2" })
      await assertSuccess(Config.int("a"), provider, 1)
      await assertFailure(
        Config.int("b"),
        provider,
        `Expected an integer
  at ["b"]`
      )
    })

    it("literal accepts only the configured value", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "L" })
      await assertSuccess(Config.literal("L", "a"), provider, "L")
      await assertFailure(
        Config.literal("-", "a"),
        provider,
        `Expected "-"
  at ["a"]`
      )
    })

    it("literals accepts configured string alternatives", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "production", b: "staging" })
      await assertSuccess(Config.literals(["development", "production"], "a"), provider, "production")
      await assertFailure(
        Config.literals(["development", "production"], "b"),
        provider,
        `Expected "development" | "production"
  at ["b"]`
      )
    })

    it("literals accepts configured number alternatives", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "1", b: "3" })
      await assertSuccess(Config.literals([1, 2], "a"), provider, 1)
      await assertFailure(
        Config.literals([1, 2], "b"),
        provider,
        `Expected "1" | "2"
  at ["b"]`
      )
    })

    it("date rejects invalid dates", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "2021-01-01", b: "invalid" })
      await assertSuccess(Config.date("a"), provider, new Date("2021-01-01"))
      await assertFailure(
        Config.date("b"),
        provider,
        `Expected a valid Date
  at ["b"]`
      )
    })

    it("redacted creates redacted values and reports missing input", async () => {
      const provider = ConfigProvider.fromUnknown({
        a: "value"
      })

      await assertSuccess(Config.redacted("a"), provider, Redacted.make("value"))
      await assertFailure(
        Config.redacted("failure"),
        provider,
        `Expected string
  at ["failure"]`
      )
    })

    it("url decodes valid URLs and reports absence", async () => {
      const provider = ConfigProvider.fromUnknown({
        a: "https://example.com"
      })

      await assertSuccess(Config.url("a"), provider, new URL("https://example.com"))
      await assertFailure(
        Config.url("failure"),
        provider,
        `Expected string
  at ["failure"]`
      )
    })
  })

  describe("combinators", () => {
    it("map transforms successful values in data-first and data-last form", async () => {
      const config = Config.schema(Schema.String)

      await assertSuccess(
        Config.map(config, (value) => value.toUpperCase()),
        ConfigProvider.fromUnknown("value"),
        "VALUE"
      )
      await assertSuccess(
        pipe(config, Config.map((value) => value.toUpperCase())),
        ConfigProvider.fromUnknown("value"),
        "VALUE"
      )
    })

    it("mapOrFail supports effectful validation", async () => {
      const config = Config.schema(Schema.String)
      const f = (s: string) =>
        s === ""
          ? Effect.fail(
            new Config.ConfigError(
              new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: "empty" }))
            )
          )
          : Effect.succeed(s.toUpperCase())

      await assertSuccess(
        Config.mapOrFail(config, f),
        ConfigProvider.fromUnknown("value"),
        "VALUE"
      )
      await assertFailure(
        Config.mapOrFail(config, f),
        ConfigProvider.fromUnknown("", { preserveEmptyStrings: true }),
        `empty`
      )
    })

    it("orElse evaluates the fallback after absence", async () => {
      const config = Config.orElse(Config.string("a"), () => Config.finite("b"))

      await assertSuccess(
        config,
        ConfigProvider.fromUnknown({ a: "value" }),
        "value"
      )
      await assertSuccess(
        config,
        ConfigProvider.fromUnknown({ b: "1" }),
        1
      )
    })

    it.effect("defers user callbacks until the Config Effect is executed", () =>
      Effect.gen(function*() {
        const provider = ConfigProvider.fromUnknown({})
        let mapCalls = 0
        let mapOrFailCalls = 0
        let orElseCalls = 0
        const mapped = Config.succeed(1).pipe(
          Config.map((value) => {
            mapCalls++
            return value + 1
          })
        ).parse(provider)
        const mappedOrFailed = Config.succeed(1).pipe(
          Config.mapOrFail((value) => {
            mapOrFailCalls++
            return Effect.succeed(value + 1)
          })
        ).parse(provider)
        const recovered = Config.fail(
          new Schema.SchemaError(new SchemaIssue.Forbidden({ message: "failure" }))
        ).pipe(
          Config.orElse(() => {
            orElseCalls++
            return Config.succeed(1)
          })
        ).parse(provider)

        assert.strictEqual(mapCalls, 0)
        assert.strictEqual(mapOrFailCalls, 0)
        assert.strictEqual(orElseCalls, 0)

        yield* mapped
        yield* mappedOrFailed
        yield* recovered

        assert.strictEqual(mapCalls, 1)
        assert.strictEqual(mapOrFailCalls, 1)
        assert.strictEqual(orElseCalls, 1)
      }))

    describe("all", () => {
      it("combines tuple inputs and preserves positions", async () => {
        const config = Config.all([Config.nonEmptyString("a"), Config.finite("b")])

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a", b: "1" }), ["a", 1])
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "", b: "1" }, { preserveEmptyStrings: true }),
          `Expected a value with a length of at least 1
  at ["a"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "a", b: "b" }),
          `Expected a string representing a finite number
  at ["b"]`
        )
      })

      it("combines generic iterables in iteration order", async () => {
        const config = Config.all(new Set([Config.nonEmptyString("a"), Config.finite("b")]))

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a", b: "1" }), ["a", 1])
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "", b: "1" }, { preserveEmptyStrings: true }),
          `Expected a value with a length of at least 1
  at ["a"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "a", b: "b" }),
          `Expected a string representing a finite number
  at ["b"]`
        )
      })

      it("combines named fields and preserves their keys", async () => {
        const config = Config.all({ a: Config.nonEmptyString("b"), c: Config.finite("d") })

        await assertSuccess(config, ConfigProvider.fromUnknown({ b: "b", d: "1" }), { a: "b", c: 1 })
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "", d: "1" }, { preserveEmptyStrings: true }),
          `Expected a value with a length of at least 1
  at ["b"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "b", d: "b" }),
          `Expected a string representing a finite number
  at ["d"]`
        )
      })
    })

    describe("withDefault", () => {
      it("uses the parsed value when present and the default when absent", async () => {
        const defaultValue = 0
        const config = Config.finite("a").pipe(Config.withDefault(defaultValue))

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), 1)
        await assertSuccess(config, ConfigProvider.fromUnknown({}), defaultValue)
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "value" }),
          `Expected a string representing a finite number
  at ["a"]`
        )
      })

      it("supports redacted default values", async () => {
        const defaultValue = Redacted.make("default")
        const config = Config.redacted("a").pipe(Config.withDefault(defaultValue))

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "value" }), Redacted.make("value"))
        await assertSuccess(config, ConfigProvider.fromUnknown({}), defaultValue)
      })

      it("treats ignored empty env strings as absent", async () => {
        const config = Config.string("a").pipe(Config.withDefault("default"))

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "" } }), "default")
        await assertSuccess(
          config,
          ConfigProvider.fromEnv({ env: { a: "" }, preserveEmptyStrings: true }),
          ""
        )
      })

      it("validates empty env numbers when they are preserved", async () => {
        const config = Config.number("a").pipe(Config.withDefault(0))

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "" } }), 0)
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: { a: "" }, preserveEmptyStrings: true }),
          `Expected a string representing a finite number
  at ["a"]
Expected "Infinity" | "-Infinity" | "NaN"
  at ["a"]`
        )
      })

      it("defaults wholly absent products and rejects partial products", async () => {
        const defaultValue = { a: "a", c: 0 }
        const config = Config.all({ a: Config.nonEmptyString("b"), c: Config.finite("d") }).pipe(
          Config.withDefault(defaultValue)
        )

        await assertSuccess(config, ConfigProvider.fromUnknown({ b: "b", d: "1" }), { a: "b", c: 1 })
        await assertSuccess(config, ConfigProvider.fromUnknown({}), defaultValue)
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "b" }),
          `Expected string
  at ["d"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ d: "1" }),
          `Expected string
  at ["b"]`
        )

        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "", d: "1" }, { preserveEmptyStrings: true }),
          `Expected a value with a length of at least 1
  at ["b"]`
        )
      })

      it("does not recover from invalid union input", async () => {
        const config = Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info"))

        await assertSuccess(config, ConfigProvider.fromUnknown({}), "Info")
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ LOG_LEVEL: "debug" }),
          `Expected "All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None"
  at ["LOG_LEVEL"]`
        )
      })

      it("does not recover from schema refinement failures", async () => {
        const schema = Schema.String.check(
          Schema.makeFilter((s) => s === "a" ? undefined : new SchemaIssue.InvalidValue({ message: `must be "a"` }))
        )
        const config = Config.schema(schema, "a").pipe(Config.withDefault("fallback"))

        // missing key -> default
        await assertSuccess(config, ConfigProvider.fromUnknown({}), "fallback")
        // valid present value -> parsed
        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a" }), "a")
        // present value that fails the refinement must fail, not use the default
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "b" }),
          `must be "a"
  at ["a"]`
        )
      })

      it("uses the default unless a plain Array schema receives an array representation", async () => {
        const config = Config.schema(Schema.Array(Schema.String), "a").pipe(Config.withDefault(["default"]))

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "value" } }), ["default"])
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "" } }), ["default"])
        await assertSuccess(
          config,
          ConfigProvider.fromEnv({ env: { a: "" }, preserveEmptyStrings: true }),
          ["default"]
        )
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a_0: "value" } }), ["value"])
        await assertSuccess(config, ConfigProvider.fromEnv({ env: {} }), ["default"])
      })

      it("defaults absent named containers and preserves explicit empty containers", async () => {
        const absent = ConfigProvider.fromUnknown({})

        await assertSuccess(
          Config.schema(Schema.Struct({ value: Schema.String }), "a").pipe(Config.withDefault({ value: "default" })),
          absent,
          { value: "default" }
        )
        await assertSuccess(
          Config.schema(Schema.Struct({ value: Schema.optionalKey(Schema.String) }), "a").pipe(
            Config.withDefault({ value: "default" })
          ),
          absent,
          { value: "default" }
        )
        await assertSuccess(
          Config.schema(Schema.Struct({}), "a").pipe(Config.withDefault({ value: "default" })),
          absent,
          { value: "default" }
        )
        await assertSuccess(
          Config.schema(Schema.Record(Schema.String, Schema.String), "a").pipe(
            Config.withDefault({ value: "default" })
          ),
          absent,
          { value: "default" }
        )
        await assertSuccess(
          Config.schema(Schema.Tuple([]), "a").pipe(Config.withDefault(["default"])),
          absent,
          ["default"]
        )
        await assertSuccess(
          Config.schema(Schema.Tuple([Schema.String]), "a").pipe(Config.withDefault(["default"])),
          absent,
          ["default"]
        )
        await assertSuccess(
          Config.schema(Schema.ReadonlySet(Schema.String), "a").pipe(Config.withDefault(new Set(["default"]))),
          absent,
          new Set(["default"])
        )
        await assertSuccess(
          Config.schema(Schema.ReadonlyMap(Schema.String, Schema.String), "a").pipe(
            Config.withDefault(new Map([["default", "value"]]))
          ),
          absent,
          new Map([["default", "value"]])
        )

        await assertSuccess(
          Config.schema(Schema.Struct({ value: Schema.optionalKey(Schema.String) }), "a"),
          ConfigProvider.fromUnknown({ a: {} }),
          {}
        )
        await assertSuccess(
          Config.schema(Schema.Record(Schema.String, Schema.String), "a"),
          ConfigProvider.fromUnknown({ a: {} }),
          {}
        )
        await assertSuccess(
          Config.schema(Schema.Tuple([]), "a"),
          ConfigProvider.fromUnknown({ a: [] }),
          []
        )
      })

      it("preserves values successfully decoded from undefined", async () => {
        const config = Config.schema(Schema.UndefinedOr(Schema.String), "a").pipe(
          Config.withDefault("default")
        )

        await assertSuccess(config, ConfigProvider.fromUnknown({}), undefined)
      })
    })

    describe("option", () => {
      it("wraps present values and maps absence to None", async () => {
        const config = Config.finite("a").pipe(Config.option)
        const stringConfig = Config.string("a").pipe(Config.option)

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), Option.some(1))
        await assertSuccess(config, ConfigProvider.fromUnknown({}), Option.none())
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "" } }), Option.none())
        await assertSuccess(
          stringConfig,
          ConfigProvider.fromEnv({ env: { a: "" }, preserveEmptyStrings: true }),
          Option.some("")
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "value" }),
          `Expected a string representing a finite number
  at ["a"]`
        )
      })

      it("returns None for absent products and rejects partial products", async () => {
        const config = Config.all({ a: Config.nonEmptyString("b"), c: Config.finite("d") }).pipe(
          Config.option
        )

        await assertSuccess(config, ConfigProvider.fromUnknown({ b: "b", d: "1" }), Option.some({ a: "b", c: 1 }))
        await assertSuccess(config, ConfigProvider.fromUnknown({}), Option.none())
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "b" }),
          `Expected string
  at ["d"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ d: "1" }),
          `Expected string
  at ["b"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "", d: "1" }),
          `Expected string
  at ["b"]`
        )

        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "", d: "1" }, { preserveEmptyStrings: true }),
          `Expected a value with a length of at least 1
  at ["b"]`
        )
      })

      it.effect("wraps successfully decoded undefined in Some", () =>
        Effect.gen(function*() {
          const config = Config.schema(Schema.UndefinedOr(Schema.String), "a").pipe(Config.option)

          assert.deepStrictEqual(
            yield* config.parse(ConfigProvider.fromUnknown({})),
            Option.some(undefined)
          )
        }))
    })

    describe("absence semantics", () => {
      describe("schema and all", () => {
        const fallback = { host: "fallback", port: 0 }
        const schemaConfig = Config.schema(
          Schema.Struct({
            host: Schema.String,
            port: Schema.Finite
          })
        ).pipe(Config.nested("database"))
        const allConfig = Config.all({
          host: Config.string("host"),
          port: Config.finite("port")
        }).pipe(Config.nested("database"))

        it("default wholly absent nested configurations", async () => {
          const provider = ConfigProvider.fromUnknown({})

          await assertSuccess(schemaConfig.pipe(Config.withDefault(fallback)), provider, fallback)
          await assertSuccess(allConfig.pipe(Config.withDefault(fallback)), provider, fallback)
        })

        it("distinguish an explicit empty schema container from an absent all group", async () => {
          const provider = ConfigProvider.fromUnknown({ database: {} })

          await assertFailure(
            schemaConfig.pipe(Config.withDefault(fallback)),
            provider,
            `Missing key
  at ["database"]["host"]`
          )
          await assertSuccess(allConfig.pipe(Config.withDefault(fallback)), provider, fallback)

          await assertFailure(
            schemaConfig.pipe(Config.option),
            provider,
            `Missing key
  at ["database"]["host"]`
          )
          await assertSuccess(allConfig.pipe(Config.option), provider, Option.none())
        })

        it("reject partial input for both composition models", async () => {
          const provider = ConfigProvider.fromUnknown({ database: { host: "localhost" } })

          await assertFailure(
            schemaConfig.pipe(Config.withDefault(fallback)),
            provider,
            `Missing key
  at ["database"]["port"]`
          )
          await assertFailure(
            allConfig.pipe(Config.withDefault(fallback)),
            provider,
            `Expected string
  at ["database"]["port"]`
          )
        })

        it.effect("does not count successful undefined child values as provider input", () =>
          Effect.gen(function*() {
            const config = Config.all({
              optional: Config.schema(Schema.UndefinedOr(Schema.String), "optional"),
              required: Config.string("required")
            })
            const fallback = { optional: "fallback", required: "fallback" }
            const provider = ConfigProvider.fromUnknown({})

            assert.deepStrictEqual(
              yield* config.pipe(Config.withDefault(fallback)).parse(provider),
              fallback
            )
            assert.deepStrictEqual(
              yield* config.pipe(Config.option).parse(provider),
              Option.none()
            )
          }))
      })

      it.effect("rejects partial products independently of field order", () =>
        Effect.gen(function*() {
          const provider = ConfigProvider.fromUnknown({ invalid: "not-a-number" })
          const schemaConfigs = [
            Config.schema(
              Schema.Struct({
                missing: Schema.String,
                invalid: Schema.Finite
              })
            ),
            Config.schema(
              Schema.Struct({
                invalid: Schema.Finite,
                missing: Schema.String
              })
            )
          ]
          const allConfigs = [
            Config.all({
              missing: Config.string("missing"),
              invalid: Config.finite("invalid")
            }),
            Config.all({
              invalid: Config.finite("invalid"),
              missing: Config.string("missing")
            })
          ]

          for (const config of [...schemaConfigs, ...allConfigs]) {
            const error = yield* config.pipe(
              Config.withDefault({ missing: "default", invalid: 0 }),
              (config) => config.parse(provider),
              Effect.flip
            )
            assert.ok(error instanceof Config.ConfigError)
          }
        }))

      it.effect("does not count child defaults as provider input", () =>
        Effect.gen(function*() {
          const fallback = { required: "fallback", defaulted: 0 }
          const config = Config.all({
            required: Config.string("required"),
            defaulted: Config.int("defaulted").pipe(Config.withDefault(1))
          }).pipe(Config.withDefault(fallback))

          assert.deepStrictEqual(
            yield* config.parse(ConfigProvider.fromUnknown({})),
            fallback
          )
          assert.deepStrictEqual(
            yield* config.parse(ConfigProvider.fromUnknown({ required: "value" })),
            { required: "value", defaulted: 1 }
          )
          const error = yield* config.parse(
            ConfigProvider.fromUnknown({ defaulted: "2" })
          ).pipe(Effect.flip)
          assert.strictEqual(
            error.cause.message,
            `Expected string
  at ["required"]`
          )
        }))

      it.effect("preserves provider input evidence recovered by orElse", () =>
        Effect.gen(function*() {
          const config = Config.all({
            recovered: Config.int("recovered").pipe(Config.orElse(() => Config.succeed(1))),
            required: Config.string("required")
          }).pipe(Config.withDefault({ recovered: 0, required: "default" }))
          const error = yield* config.parse(
            ConfigProvider.fromUnknown({ recovered: "invalid" })
          ).pipe(Effect.flip)

          assert.strictEqual(
            error.cause.message,
            `Expected string
  at ["required"]`
          )
        }))

      it.effect("does not invent provider input evidence when orElse recovers absence", () =>
        Effect.gen(function*() {
          const fallback = { recovered: 0, required: "default" }
          const config = Config.all({
            recovered: Config.int("recovered").pipe(Config.orElse(() => Config.succeed(1))),
            required: Config.string("required")
          }).pipe(Config.withDefault(fallback))

          assert.deepStrictEqual(
            yield* config.parse(ConfigProvider.fromUnknown({})),
            fallback
          )
        }))

      it.effect("does not turn recovered invalid input into absence", () =>
        Effect.gen(function*() {
          const config = Config.int("primary").pipe(
            Config.orElse(() => Config.string("fallback")),
            Config.withDefault("default")
          )
          const error = yield* config.parse(
            ConfigProvider.fromUnknown({ primary: "invalid" })
          ).pipe(Effect.flip)

          assert.strictEqual(
            error.cause.message,
            `Expected string
  at ["fallback"]`
          )
        }))

      it.effect("preserves provider input evidence through mapOrFail and orElse", () =>
        Effect.gen(function*() {
          const validationError = new Config.ConfigError(
            new Schema.SchemaError(new SchemaIssue.Forbidden({ message: "invalid value" }))
          )
          const config = Config.all({
            recovered: Config.string("recovered").pipe(
              Config.mapOrFail(() => Effect.fail(validationError)),
              Config.orElse(() => Config.succeed("fallback"))
            ),
            required: Config.string("required")
          }).pipe(Config.withDefault({ recovered: "default", required: "default" }))
          const error = yield* config.parse(
            ConfigProvider.fromUnknown({ recovered: "value" })
          ).pipe(Effect.flip)

          assert.strictEqual(
            error.cause.message,
            `Expected string
  at ["required"]`
          )
        }))

      it.effect("preserves provider input evidence after a descendant source failure", () =>
        Effect.gen(function*() {
          const sourceError = new ConfigProvider.SourceError({ message: "source unavailable" })
          const provider = ConfigProvider.make((path) => {
            if (path.length === 0) {
              return Effect.succeed(ConfigProvider.makeRecord(new Set(["value"])))
            }
            return path.length === 1 && path[0] === "value"
              ? Effect.fail(sourceError)
              : Effect.succeed(undefined)
          })
          const config = Config.all({
            recovered: Config.schema(Schema.Struct({ value: Schema.String })).pipe(
              Config.orElse(() => Config.succeed({ value: "fallback" }))
            ),
            required: Config.string("required")
          }).pipe(Config.withDefault({ recovered: { value: "default" }, required: "default" }))
          const error = yield* config.parse(provider).pipe(Effect.flip)

          assert.strictEqual(
            error.cause.message,
            `Expected string
  at ["required"]`
          )
        }))

      it.effect("preserves sibling input evidence when recovering an all failure", () =>
        Effect.gen(function*() {
          const sourceError = new ConfigProvider.SourceError({ message: "source unavailable" })
          const provider = ConfigProvider.make((path) => {
            if (path[0] === "failed") return Effect.fail(sourceError)
            if (path[0] === "present") return Effect.succeed(ConfigProvider.makeValue("value"))
            return Effect.succeed(undefined)
          })
          const recovered = Config.all({
            failed: Config.string("failed"),
            present: Config.string("present")
          }).pipe(Config.orElse(() => Config.succeed({ failed: "recovered", present: "recovered" })))
          const config = Config.all({
            recovered,
            required: Config.string("required")
          }).pipe(Config.withDefault({
            recovered: { failed: "default", present: "default" },
            required: "default"
          }))
          const error = yield* config.parse(provider).pipe(Effect.flip)

          assert.strictEqual(
            error.cause.message,
            `Expected string
  at ["required"]`
          )
        }))

      it.effect("does not invent provider input evidence after an initial source failure", () =>
        Effect.gen(function*() {
          const sourceError = new ConfigProvider.SourceError({ message: "source unavailable" })
          const provider = ConfigProvider.make((path) =>
            path.length === 0 ? Effect.fail(sourceError) : Effect.succeed(undefined)
          )
          const fallback = { recovered: { value: "default" }, required: "default" }
          const config = Config.all({
            recovered: Config.schema(Schema.Struct({ value: Schema.String })).pipe(
              Config.orElse(() => Config.succeed({ value: "fallback" }))
            ),
            required: Config.string("required")
          }).pipe(Config.withDefault(fallback))

          assert.deepStrictEqual(
            yield* config.parse(provider),
            fallback
          )
        }))

      it.effect("normalizes unavailable scalar representations to absence", () =>
        Effect.gen(function*() {
          const provider = ConfigProvider.make((path) =>
            Effect.succeed(
              path.length === 1 && path[0] === "value"
                ? ConfigProvider.makeRecord(new Set())
                : undefined
            )
          )
          const config = Config.string("value")

          assert.strictEqual(
            yield* config.pipe(Config.withDefault("default")).parse(provider),
            "default"
          )
          assert.deepStrictEqual(
            yield* config.pipe(Config.option).parse(provider),
            Option.none()
          )
        }))

      it.effect("treats incompatible container representations as absent", () =>
        Effect.gen(function*() {
          const struct = Config.schema(
            Schema.Struct({ value: Schema.optionalKey(Schema.String) }),
            "value"
          )
          const array = Config.schema(Schema.Array(Schema.String), "value")

          assert.deepStrictEqual(
            yield* struct.pipe(Config.withDefault({ value: "default" })).parse(
              ConfigProvider.fromUnknown({ value: [] })
            ),
            { value: "default" }
          )
          assert.deepStrictEqual(
            yield* array.pipe(Config.option).parse(
              ConfigProvider.fromUnknown({ value: {} })
            ),
            Option.none()
          )
        }))

      it.effect("propagates provider failures", () =>
        Effect.gen(function*() {
          const cause = new ConfigProvider.SourceError({ message: "source unavailable" })
          const provider = ConfigProvider.make(() => Effect.fail(cause))
          const error = yield* Config.string("a").pipe(
            Config.withDefault("fallback"),
            (config) => config.parse(provider),
            Effect.flip
          )

          assert.strictEqual(error.cause, cause)
        }))

      it.effect("rejects present containers with incompatible shapes", () =>
        Effect.gen(function*() {
          const wrongStruct = yield* Config.schema(
            Schema.Struct({ value: Schema.optionalKey(Schema.String) }),
            "value"
          ).parse(ConfigProvider.fromUnknown({ value: [] })).pipe(Effect.flip)
          assert.ok(wrongStruct instanceof Config.ConfigError)

          const wrongArray = yield* Config.schema(
            Schema.Array(Schema.String),
            "value"
          ).parse(ConfigProvider.fromUnknown({ value: {} })).pipe(Effect.flip)
          assert.ok(wrongArray instanceof Config.ConfigError)
        }))
    })

    describe("nested", () => {
      describe("with fromUnknown", () => {
        it("prefixes a root config", async () => {
          const config = Config.string().pipe(Config.nested("a"))

          await assertSuccess(
            config,
            ConfigProvider.fromUnknown({ a: "value" }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({}),
            `Expected string
  at ["a"]`
          )
        })

        it("composes a constructor path with a prefix", async () => {
          const config = Config.string("a").pipe(Config.nested("b"))

          await assertSuccess(
            config,
            ConfigProvider.fromUnknown({ b: { a: "value" } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({}),
            `Expected string
  at ["b"]["a"]`
          )
        })

        it("composes multiple prefixes from outermost to innermost", async () => {
          const config = Config.string("a").pipe(Config.nested("b"), Config.nested("c"))

          await assertSuccess(
            config,
            ConfigProvider.fromUnknown({ c: { b: { a: "value" } } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({ c: { b: {} } }),
            `Expected string
  at ["c"]["b"]["a"]`
          )
        })

        it("prefixes every child of an all product", async () => {
          const config = Config.all({
            host: Config.string("host"),
            port: Config.number("port")
          }).pipe(Config.nested("database"))

          await assertSuccess(
            config,
            ConfigProvider.fromUnknown({ database: { host: "localhost", port: "5432" } }),
            { host: "localhost", port: 5432 }
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({}),
            `Expected string
  at ["database"]["host"]`
          )
        })
      })

      describe("with fromEnv", () => {
        it("prefixes a root config", async () => {
          const config = Config.string().pipe(Config.nested("a"))

          await assertSuccess(
            config,
            ConfigProvider.fromEnv({ env: { a: "value" } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: {} }),
            `Expected string
  at ["a"]`
          )
        })

        it("composes a constructor path with a prefix", async () => {
          const config = Config.string("a").pipe(Config.nested("b"))

          await assertSuccess(
            config,
            ConfigProvider.fromEnv({ env: { "b_a": "value" } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: {} }),
            `Expected string
  at ["b"]["a"]`
          )
        })

        it("composes multiple prefixes from outermost to innermost", async () => {
          const config = Config.string("a").pipe(Config.nested("b"), Config.nested("c"))

          await assertSuccess(
            config,
            ConfigProvider.fromEnv({ env: { "c_b_a": "value" } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: { "c_b": "value" } }),
            `Expected string
  at ["c"]["b"]["a"]`
          )
        })

        it("prefixes every child of an all product", async () => {
          const config = Config.all({
            host: Config.string("host"),
            port: Config.number("port")
          }).pipe(Config.nested("database"))

          await assertSuccess(
            config,
            ConfigProvider.fromEnv({ env: { "database_host": "localhost", "database_port": "5432" } }),
            { host: "localhost", port: 5432 }
          )
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: {} }),
            `Expected string
  at ["database"]["host"]`
          )
        })

        it("composes Config and provider prefixes without leaking provider paths into errors", async () => {
          const config = Config.string("host").pipe(Config.nested("database"))
          const provider = ConfigProvider.fromEnv({
            env: { app_database_host: "localhost" }
          }).pipe(ConfigProvider.nested("app"))

          await assertSuccess(config, provider, "localhost")
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: {} }).pipe(ConfigProvider.nested("app")),
            `Expected string
  at ["database"]["host"]`
          )
        })

        it("preserves logical error paths through provider fallback", async () => {
          const provider = ConfigProvider.fromEnv({ env: { app_port: "abc" } }).pipe(
            ConfigProvider.orElse(ConfigProvider.fromEnv({ env: {} })),
            ConfigProvider.nested("app")
          )

          await assertFailure(
            Config.number("port"),
            provider,
            `Expected a string representing a finite number
  at ["port"]
Expected "Infinity" | "-Infinity" | "NaN"
  at ["port"]`
          )
        })
      })
    })

    describe("unwrap", () => {
      it("combines a plain record of configs", async () => {
        const config = Config.unwrap({
          a: Config.schema(Schema.String, "a2")
        })

        await assertSuccess(config, ConfigProvider.fromUnknown({ a2: "value" }), { a: "value" })
      })

      it("recursively combines nested records", async () => {
        const config = Config.unwrap({
          a: {
            b: Config.schema(Schema.String, "b2")
          }
        })

        await assertSuccess(
          config,
          ConfigProvider.fromUnknown({ b2: "value" }),
          { a: { b: "value" } }
        )
      })
    })
  })

  describe("schema", () => {
    it("reports missing redacted input", async () => {
      await assertFailure(
        Config.schema(Schema.Redacted(Schema.Literal("secret")), "a"),
        ConfigProvider.fromUnknown({}),
        `Expected "secret"
  at ["a"]`
      )
    })

    describe("built-in schema-backed constructors", () => {
      it("decodes supported boolean spellings", async () => {
        const provider = ConfigProvider.fromUnknown({
          a: "true",
          b: "false",
          c: "yes",
          d: "no",
          e: "on",
          f: "off",
          g: "1",
          h: "0",
          i: "y",
          j: "n",
          failure: "value"
        })

        await assertSuccess(Config.boolean("a"), provider, true)
        await assertSuccess(Config.boolean("b"), provider, false)
        await assertSuccess(Config.boolean("c"), provider, true)
        await assertSuccess(Config.boolean("d"), provider, false)
        await assertSuccess(Config.boolean("e"), provider, true)
        await assertSuccess(Config.boolean("f"), provider, false)
        await assertSuccess(Config.boolean("g"), provider, true)
        await assertSuccess(Config.boolean("h"), provider, false)
        await assertSuccess(Config.boolean("i"), provider, true)
        await assertSuccess(Config.boolean("j"), provider, false)
        await assertFailure(
          Config.boolean("failure"),
          provider,
          `Expected "true" | "yes" | "on" | "1" | "y" | "false" | "no" | "off" | "0" | "n"
  at ["failure"]`
        )
      })

      it("decodes durations including infinities", async () => {
        const provider = ConfigProvider.fromUnknown({
          a: "1000 millis",
          b: "1 second",
          c: "Infinity",
          d: "-Infinity",
          failure: "value"
        })

        await assertSuccess(Config.duration("a"), provider, Duration.millis(1000))
        await assertSuccess(Config.duration("b"), provider, Duration.seconds(1))
        await assertSuccess(Config.duration("c"), provider, Duration.infinity)
        await assertSuccess(Config.duration("d"), provider, Duration.negativeInfinity)
        await assertFailure(
          Config.duration("failure"),
          provider,
          `Expected a valid Duration string
  at ["failure"]`
        )
      })

      it("validates port ranges", async () => {
        const provider = ConfigProvider.fromUnknown({
          a: "8080",
          failure: "-1"
        })

        await assertSuccess(Config.port("a"), provider, 8080)
        await assertFailure(
          Config.port("failure"),
          provider,
          `Expected a value between 1 and 65535
  at ["failure"]`
        )
      })

      it("validates log-level literals", async () => {
        const provider = ConfigProvider.fromUnknown({
          a: "Info",
          failure_1: "info",
          failure_2: "value"
        })

        await assertSuccess(Config.logLevel("a"), provider, "Info")
        await assertFailure(
          Config.logLevel("failure_1"),
          provider,
          `Expected "All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None"
  at ["failure_1"]`
        )
        await assertFailure(
          Config.logLevel("failure_2"),
          provider,
          `Expected "All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None"
  at ["failure_2"]`
        )
      })

      describe("Record", () => {
        it("decodes object input", async () => {
          const schema = Config.Record(Schema.String, Schema.String)
          const config = Config.schema(schema, "OTEL_RESOURCE_ATTRIBUTES")

          await assertSuccess(
            config,
            ConfigProvider.fromUnknown({
              OTEL_RESOURCE_ATTRIBUTES: {
                "service.name": "my-service",
                "service.version": "1.0.0",
                "custom.attribute": "value"
              }
            }),
            {
              "service.name": "my-service",
              "service.version": "1.0.0",
              "custom.attribute": "value"
            }
          )
        })

        it("decodes separated string input", async () => {
          const schema = Config.Record(Schema.String, Schema.String)
          const config = Config.schema(schema, "OTEL_RESOURCE_ATTRIBUTES")

          await assertSuccess(
            config,
            ConfigProvider.fromEnv({
              env: {
                OTEL_RESOURCE_ATTRIBUTES: "service.name=my-service,service.version=1.0.0,custom.attribute=value"
              }
            }),
            {
              "service.name": "my-service",
              "service.version": "1.0.0",
              "custom.attribute": "value"
            }
          )
        })

        it("supports custom separators", async () => {
          const schema = Config.Record(Schema.String, Schema.String, { separator: "&", keyValueSeparator: "==" })
          const config = Config.schema(schema, "OTEL_RESOURCE_ATTRIBUTES")

          await assertSuccess(
            config,
            ConfigProvider.fromEnv({
              env: {
                OTEL_RESOURCE_ATTRIBUTES: "service.name==my-service&service.version==1.0.0&custom.attribute==value"
              }
            }),
            {
              "service.name": "my-service",
              "service.version": "1.0.0",
              "custom.attribute": "value"
            }
          )
        })
      })
    })

    describe("materialization", () => {
      describe("Encoded shapes", () => {
        const scalarToStruct = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Struct({ value: Schema.String }),
            SchemaTransformation.transform({
              decode: (value) => ({ value }),
              encode: ({ value }) => value
            })
          )
        )
        const structToScalar = Schema.Struct({ value: Schema.String }).pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transform({
              decode: ({ value }) => value,
              encode: (value) => ({ value })
            })
          )
        )

        it.effect("loads the encoded shape when it differs from the decoded shape", () =>
          Effect.gen(function*() {
            assert.deepStrictEqual(
              yield* Config.schema(scalarToStruct, "config").parse(
                ConfigProvider.fromUnknown({ config: "value" })
              ),
              { value: "value" }
            )
            assert.strictEqual(
              yield* Config.schema(structToScalar, "config").parse(
                ConfigProvider.fromUnknown({ config: { value: "value" } })
              ),
              "value"
            )
          }))

        it.effect("loads encoded shapes recursively inside objects and arrays", () =>
          Effect.gen(function*() {
            const config = Config.schema(
              Schema.Struct({
                fromScalar: scalarToStruct,
                fromStruct: structToScalar,
                items: Schema.Array(scalarToStruct)
              })
            )

            assert.deepStrictEqual(
              yield* config.parse(
                ConfigProvider.fromUnknown({
                  fromScalar: "one",
                  fromStruct: { value: "two" },
                  items: ["three"]
                })
              ),
              {
                fromScalar: { value: "one" },
                fromStruct: "two",
                items: [{ value: "three" }]
              }
            )
          }))

        it.effect("loads every union member from its encoded shape", () =>
          Effect.gen(function*() {
            const config = Config.schema(
              Schema.Union([scalarToStruct, structToScalar]),
              "config"
            )

            assert.deepStrictEqual(
              yield* config.parse(ConfigProvider.fromUnknown({ config: "scalar" })),
              { value: "scalar" }
            )
            assert.strictEqual(
              yield* config.parse(
                ConfigProvider.fromUnknown({ config: { value: "struct" } })
              ),
              "struct"
            )
          }))
      })

      describe("Objects", () => {
        it.effect("loads explicit properties even when only a fallback provider contains the child", () =>
          Effect.gen(function*() {
            const primary = ConfigProvider.make((path) =>
              Effect.succeed(
                path.length === 0
                  ? ConfigProvider.makeRecord(new Set())
                  : undefined
              )
            )
            const fallback = ConfigProvider.make((path) =>
              Effect.succeed(
                path.length === 1 && path[0] === "host"
                  ? ConfigProvider.makeValue("localhost")
                  : undefined
              )
            )
            const provider = ConfigProvider.orElse(primary, fallback)

            assert.deepStrictEqual(
              yield* Config.schema(Schema.Struct({ host: Schema.String })).parse(provider),
              { host: "localhost" }
            )
          }))

        it.effect("does not load advertised keys that are unrelated to the schema", () =>
          Effect.gen(function*() {
            const sourceError = new ConfigProvider.SourceError({ message: "unrelated key was loaded" })
            const provider = ConfigProvider.make((path) => {
              if (path.length === 0) {
                return Effect.succeed(ConfigProvider.makeRecord(new Set(["wanted", "unrelated"])))
              }
              if (path[0] === "wanted") {
                return Effect.succeed(ConfigProvider.makeValue("value"))
              }
              return Effect.fail(sourceError)
            })

            assert.deepStrictEqual(
              yield* Config.schema(Schema.Struct({ wanted: Schema.String })).parse(provider),
              { wanted: "value" }
            )
          }))

        it.effect("loads advertised keys only when they match an index signature", () =>
          Effect.gen(function*() {
            const sourceError = new ConfigProvider.SourceError({ message: "non-matching key was loaded" })
            const provider = ConfigProvider.make((path) => {
              if (path.length === 0) {
                return Effect.succeed(ConfigProvider.makeRecord(new Set(["wanted", "unrelated"])))
              }
              if (path[0] === "wanted") {
                return Effect.succeed(ConfigProvider.makeValue("value"))
              }
              return Effect.fail(sourceError)
            })

            assert.deepStrictEqual(
              yield* Config.schema(Schema.Record(Schema.Literal("wanted"), Schema.String)).parse(provider),
              { wanted: "value" }
            )
          }))

        it.effect("leaves separated record parsing to the explicit Config.Record schema", () =>
          Effect.gen(function*() {
            const provider = ConfigProvider.fromEnv({
              env: {
                values: "first=1,second=2"
              }
            })

            assert.deepStrictEqual(
              yield* Config.schema(Config.Record(Schema.String, Schema.Finite), "values").parse(provider),
              { first: 1, second: 2 }
            )
          }))
      })

      describe("Arrays", () => {
        it.effect("preserves missing array positions as undefined values", () =>
          Effect.gen(function*() {
            const provider = ConfigProvider.make((path) => {
              if (path.length === 0) {
                return Effect.succeed(ConfigProvider.makeArray(2))
              }
              return Effect.succeed(
                path[0] === 0
                  ? ConfigProvider.makeValue("value")
                  : undefined
              )
            })

            assert.deepStrictEqual(
              yield* Config.schema(Schema.Array(Schema.UndefinedOr(Schema.String))).parse(provider),
              ["value", undefined]
            )
          }))

        it.effect("leaves scalar-to-array parsing to the explicit Config.Array schema", () =>
          Effect.gen(function*() {
            const provider = ConfigProvider.fromEnv({
              env: {
                values: "1,2",
                values_0: "3"
              }
            })

            assert.deepStrictEqual(
              yield* Config.schema(Config.Array(Schema.Finite), "values").parse(provider),
              [1, 2]
            )
            assert.deepStrictEqual(
              yield* Config.schema(Schema.Array(Schema.Finite), "values").parse(provider),
              [3]
            )
          }))
      })

      describe("Opaque schemas", () => {
        const unsupported = [
          ["Any", Schema.Any],
          ["Unknown", Schema.Unknown],
          ["ObjectKeyword", Schema.ObjectKeyword],
          ["Json", Schema.Json],
          ["MutableJson", Schema.MutableJson]
        ] as const

        for (const [name, schema] of unsupported) {
          it(`rejects Schema.${name}`, () => {
            assert.throws(
              () => Config.schema(schema),
              /Config\.schema does not support opaque StringTree encodings/
            )
          })
        }

        it("rejects opaque shapes nested in objects", () => {
          assert.throws(
            () => Config.schema(Schema.Struct({ value: Schema.Unknown })),
            /Config\.schema does not support opaque StringTree encodings/
          )
        })

        it("rejects opaque union members", () => {
          assert.throws(
            () => Config.schema(Schema.Union([Schema.String, Schema.Unknown])),
            /Config\.schema does not support opaque StringTree encodings/
          )
        })

        it("rejects opaque shapes behind suspensions", () => {
          assert.throws(
            () => Config.schema(Schema.suspend(() => Schema.Unknown)),
            /Config\.schema does not support opaque StringTree encodings/
          )
        })

        it.effect("supports declarations with concrete StringTree encodings", () =>
          Effect.gen(function*() {
            const provider = ConfigProvider.fromUnknown({ value: "https://example.com" })
            const value = yield* Config.schema(Schema.URL, "value").parse(provider)

            assert.strictEqual(value.href, "https://example.com/")
          }))

        it.effect("supports arbitrary JSON encoded in a scalar string", () =>
          Effect.gen(function*() {
            const provider = ConfigProvider.fromUnknown({ value: `{"nested":[1,true]}` })
            const value = yield* Config.schema(Schema.fromJsonString(Schema.Json), "value").parse(provider)

            assert.deepStrictEqual(value, { nested: [1, true] })
          }))
      })

      describe("Union", () => {
        it("materializes each member independently before applying first-match semantics", async () => {
          const config = Config.schema(
            Schema.Union([
              Schema.Struct({ child: Schema.String }),
              Schema.String
            ]),
            "value"
          )
          const provider = ConfigProvider.fromEnv({
            env: {
              value: "scalar",
              value_child: "object"
            }
          })

          await assertSuccess(config, provider, { child: "object" })
        })

        it("preserves first-match semantics when the scalar member is declared first", async () => {
          const config = Config.schema(
            Schema.Union([
              Schema.String,
              Schema.Struct({ child: Schema.String })
            ]),
            "value"
          )
          const provider = ConfigProvider.fromEnv({
            env: {
              value: "scalar",
              value_child: "object"
            }
          })

          await assertSuccess(config, provider, "scalar")
        })

        it("reports oneOf ambiguity without exposing the internal cursor", async () => {
          const config = Config.schema(
            Schema.Union([
              Schema.Struct({ child: Schema.String }),
              Schema.String
            ], { mode: "oneOf" }),
            ["database", "value"]
          )
          const provider = ConfigProvider.fromEnv({
            env: {
              database_value: "scalar",
              database_value_child: "object"
            }
          })

          await assertFailure(
            config,
            provider,
            `Expected exactly one member to match
  at ["database"]["value"]`
          )
        })

        it.effect("counts input available to any member when composing with Config.all", () =>
          Effect.gen(function*() {
            const config = Config.all({
              selected: Config.schema(
                Schema.Union([
                  Schema.Undefined,
                  Schema.Struct({ child: Schema.String })
                ]),
                "value"
              ),
              required: Config.string("required")
            }).pipe(
              Config.withDefault({
                selected: undefined,
                required: "default"
              })
            )
            const provider = ConfigProvider.fromEnv({
              env: {
                value_child: "present"
              }
            })

            const error = yield* config.parse(provider).pipe(Effect.flip)
            assert.strictEqual(
              error.cause.message,
              `Expected string
  at ["required"]`
            )
          }))

        it.effect("applies checks attached to the original union", () =>
          Effect.gen(function*() {
            const schema = Schema.Union([
              Schema.Struct({ child: Schema.String }),
              Schema.String
            ]).check(
              Schema.makeFilter((value) =>
                typeof value === "string"
                  ? new SchemaIssue.InvalidValue({ message: "union check failed" })
                  : undefined
              )
            )
            const error = yield* Config.schema(schema, "value").parse(
              ConfigProvider.fromUnknown({ value: "scalar" })
            ).pipe(Effect.flip)

            assert.strictEqual(
              error.cause.message,
              `union check failed
  at ["value"]`
            )
          }))

        it.effect("propagates SourceError defects instead of trying another member", () =>
          Effect.gen(function*() {
            const sourceError = new ConfigProvider.SourceError({ message: "source unavailable" })
            const provider = ConfigProvider.make((path) => {
              if (path.length === 1 && path[0] === "value") {
                return Effect.succeed(ConfigProvider.makeRecord(new Set(["child"]), "scalar"))
              }
              return Effect.fail(sourceError)
            })
            const config = Config.schema(
              Schema.Union([
                Schema.Struct({ child: Schema.String }),
                Schema.String
              ]),
              "value"
            )

            const error = yield* config.parse(provider).pipe(Effect.flip)
            assert.strictEqual(error.cause, sourceError)
          }))
      })
    })

    describe("fromEnv provider", () => {
      it("loads root, flat, and nested paths", async () => {
        await assertSuccess(
          Config.schema(Schema.String, "a"),
          ConfigProvider.fromEnv({ env: { a: "value" } }),
          "value"
        )
        await assertSuccess(
          Config.schema(Schema.String, ["a", "b"]),
          ConfigProvider.fromEnv({ env: { "a_b": "value" } }),
          "value"
        )
        await assertSuccess(
          Config.schema(Schema.UndefinedOr(Schema.String)),
          ConfigProvider.fromEnv({ env: {} }),
          undefined
        )
        await assertSuccess(
          Config.schema(Schema.UndefinedOr(Schema.String), "a"),
          ConfigProvider.fromEnv({ env: {} }),
          undefined
        )
      })

      describe("node precedence", () => {
        it("uses a co-located scalar instead of object children for a leaf schema", async () => {
          const schema = Schema.Struct({ a: Schema.Number })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", "a_b": "2" } }), { a: 1 })
        })

        it("uses a co-located scalar instead of array children for a leaf schema", async () => {
          const schema = Schema.Struct({ a: Schema.Number })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", "a_0": "2" } }), { a: 1 })
        })

        it("prefers object children when a node can be both object and array", async () => {
          const schema = Schema.Struct({ a: Schema.Struct({ b: Schema.Number }) })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", "a_b": "2", "a_0": "3" } }), {
            a: { b: 2 }
          })
        })
      })

      it("decodes Null", async () => {
        const schema = Schema.Null
        const config = Config.schema(schema, "a")

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "null" } }), null)
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: {} }),
          `Expected "null"
  at ["a"]`
        )
      })

      it("decodes String and reports absence", async () => {
        const schema = Schema.String
        const config = Config.schema(schema, "a")

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), "a")
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: {} }),
          `Expected string
  at ["a"]`
        )
      })

      it("decodes Number and reports absence", async () => {
        const schema = Schema.Number
        const config = Config.schema(schema, "a")

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: {} }),
          `Expected string | "Infinity" | "-Infinity" | "NaN"
  at ["a"]`
        )
      })

      it("decodes Finite and reports absence", async () => {
        const schema = Schema.Finite
        const config = Config.schema(schema, "a")

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: {} }),
          `Expected string
  at ["a"]`
        )
      })

      it("decodes Int and reports absence", async () => {
        const schema = Schema.Int
        const config = Config.schema(schema, "a")

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: {} }),
          `Expected string
  at ["a"]`
        )
      })

      it("decodes Boolean and reports absence", async () => {
        const schema = Schema.Boolean
        const config = Config.schema(schema, "a")

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "true" } }), true)
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "false" } }), false)
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: {} }),
          `Expected "true" | "false"
  at ["a"]`
        )
      })

      describe("Struct", () => {
        it("decodes required properties", async () => {
          const schema = Schema.Struct({ a: Schema.Number })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: 1 })
        })

        it("omits absent optionalKey properties", async () => {
          const schema = Schema.Struct({ a: Schema.optionalKey(Schema.Number) })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: 1 })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { unrelated: "value" } }), {})
        })

        it("omits absent optional properties", async () => {
          const config = Config.schema(
            Schema.Struct({ a: Schema.optional(Schema.Number) })
          )

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: 1 })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { unrelated: "value" } }), {})
        })

        it("decodes literal properties", async () => {
          const schema = Schema.Struct({ a: Schema.Literals(["b", "c"]) })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "b" } }), { a: "b" })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "c" } }), { a: "c" })
        })

        it("decodes indexed array properties without treating co-located scalars as arrays", async () => {
          const schema = Schema.Struct({ a: Schema.Array(Schema.Number) })
          const config = Config.schema(schema)

          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: { a: "" }, preserveEmptyStrings: true }),
            `Expected array
  at ["a"]`
          )
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: { a: "1" } }),
            `Expected array
  at ["a"]`
          )
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a_0: "1" } }), { a: [1] })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a_0: "1", a_1: "2" } }), { a: [1, 2] })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", a_0: "2" } }), { a: [2] })
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: {} }),
            `Expected object`
          )
        })
      })

      it("decodes and validates Record values", async () => {
        const schema = Schema.Record(Schema.String, Schema.Finite)
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: 1 })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", b: "2" } }), { a: 1, b: 2 })
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: { a: "1", b: "value" } }),
          `Expected a string representing a finite number
  at ["b"]`
        )
      })

      describe("Tuple", () => {
        it("rejects a scalar where an empty tuple is expected", async () => {
          const schema = Schema.Struct({ a: Schema.Tuple([]) })
          const config = Config.schema(schema)

          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: { a: "" }, preserveEmptyStrings: true }),
            `Expected array
  at ["a"]`
          )
        })

        it("rejects scalar tuple input", async () => {
          const schema = Schema.Struct({ a: Schema.Tuple([Schema.Number]) })
          const config = Config.schema(schema)

          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: { a: "1" } }),
            `Expected array
  at ["a"]`
          )
        })

        it("requires and validates every tuple element", async () => {
          const schema = Schema.Struct({ a: Schema.Tuple([Schema.String, Schema.Finite]) })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a_0: "a", a_1: "2" } }), { a: ["a", 2] })
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: { a: "a" } }),
            `Expected array
  at ["a"]`
          )
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: { a_0: "a", a_1: "value" } }),
            `Expected a string representing a finite number
  at ["a"][1]`
          )
        })
      })

      it("decodes indexed Array input and rejects scalar input", async () => {
        const schema = Schema.Struct({ a: Schema.Array(Schema.Finite) })
        const config = Config.schema(schema)

        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: { a: "1,2,3" } }),
          `Expected array
  at ["a"]`
        )
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a_0: "1", a_1: "2" } }), { a: [1, 2] })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a", a_0: "1" } }), { a: [1] })
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: { a_0: "1", a_2: "2" } }),
          `Expected string
  at ["a"][1]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: { a_0: "1", a_1: "value" } }),
          `Expected a string representing a finite number
  at ["a"][1]`
        )
      })

      describe("Union", () => {
        it("decodes literal unions", async () => {
          const schema = Schema.Struct({ a: Schema.Literals(["a", "b"]) })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), { a: "a" })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "b" } }), { a: "b" })
        })

        it("uses first-match semantics by default", async () => {
          const schema = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({ b: Schema.Number })
          ])
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), { a: "a" })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { b: "1" } }), { b: 1 })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a", b: "1" } }), { a: "a" })
        })

        it("enforces exactly one match in oneOf mode", async () => {
          const schema = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({ b: Schema.Number })
          ], { mode: "oneOf" })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), { a: "a" })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { b: "1" } }), { b: 1 })
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: { a: "a", b: "1" } }),
            "Expected exactly one member to match"
          )
        })

        it("decodes Number before String", async () => {
          const schema = Schema.Union([Schema.Number, Schema.String])
          const config = Config.schema(schema, "a")

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), "a")
        })

        it("still decodes numeric input when String is listed first", async () => {
          const schema = Schema.Union([Schema.String, Schema.Number])
          const config = Config.schema(schema, "a")

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), "a")
        })
      })

      it("reports Int validation errors", async () => {
        const schema = Schema.Redacted(Schema.Int)
        const config = Config.schema(schema, "a")

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), Redacted.make(1))
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: {} }),
          `Expected string
  at ["a"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: { a: "1.1" } }),
          `Expected an integer
  at ["a"]`
        )
      })
    })

    describe("fromUnknown provider", () => {
      it("loads root, flat, and nested paths", async () => {
        await assertSuccess(
          Config.schema(Schema.String, []),
          ConfigProvider.fromUnknown("value"),
          "value"
        )
        await assertSuccess(
          Config.schema(Schema.String, "a"),
          ConfigProvider.fromUnknown({ a: "value" }),
          "value"
        )
        await assertSuccess(
          Config.schema(Schema.String, ["a", "b"]),
          ConfigProvider.fromUnknown({ a: { b: "value" } }),
          "value"
        )
      })

      it("decodes Undefined", async () => {
        const schema = Schema.Undefined
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown(undefined), undefined)
        await assertFailure(config, ConfigProvider.fromUnknown("a"), `Expected undefined`)
      })

      it("decodes Null", async () => {
        const schema = Schema.Null
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown("null"), null)
        await assertFailure(config, ConfigProvider.fromUnknown("a"), `Expected "null"`)
      })

      it("decodes String and rejects object input", async () => {
        const schema = Schema.String
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown("value"), "value")
        await assertFailure(config, ConfigProvider.fromUnknown({}), `Expected string`)
      })

      it("decodes Number and rejects invalid input", async () => {
        const schema = Schema.Number
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
        await assertFailure(
          config,
          ConfigProvider.fromUnknown("a"),
          `Expected a string representing a finite number
Expected "Infinity" | "-Infinity" | "NaN"`
        )
      })

      it("decodes Finite and rejects invalid input", async () => {
        const schema = Schema.Finite
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
        await assertFailure(
          config,
          ConfigProvider.fromUnknown("a"),
          `Expected a string representing a finite number`
        )
      })

      it("decodes Int and rejects invalid input", async () => {
        const schema = Schema.Int
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
        await assertFailure(
          config,
          ConfigProvider.fromUnknown("a"),
          `Expected a string representing a finite number`
        )
      })

      it("decodes Boolean and rejects invalid input", async () => {
        const schema = Schema.Boolean
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown("true"), true)
        await assertSuccess(config, ConfigProvider.fromUnknown("false"), false)
        await assertFailure(config, ConfigProvider.fromUnknown("a"), `Expected "true" | "false"`)
      })

      describe("Struct", () => {
        it("requires and validates required properties", async () => {
          const schema = Schema.Struct({ a: Schema.Finite })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), { a: 1 })
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({}),
            `Missing key
  at ["a"]`
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({ a: "value" }),
            `Expected a string representing a finite number
  at ["a"]`
          )
        })

        it("omits absent optionalKey properties", async () => {
          const schema = Schema.Struct({ a: Schema.optionalKey(Schema.Number) })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), { a: 1 })
          await assertSuccess(config, ConfigProvider.fromUnknown({}), {})
        })

        it("omits absent optional properties", async () => {
          const config = Config.schema(
            Schema.Struct({ a: Schema.optional(Schema.Number) })
          )

          await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), { a: 1 })
          await assertSuccess(config, ConfigProvider.fromUnknown({}), {})
        })

        it("decodes literal properties", async () => {
          const schema = Schema.Struct({ a: Schema.Literals(["b", "c"]) })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown({ a: "b" }), { a: "b" })
          await assertSuccess(config, ConfigProvider.fromUnknown({ a: "c" }), { a: "c" })
        })

        it("rejects scalar values for array properties", async () => {
          const schema = Schema.Struct({ a: Schema.Array(Schema.Number) })
          const config = Config.schema(schema)

          await assertFailure(
            config,
            ConfigProvider.fromUnknown({ a: "" }),
            `Missing key
  at ["a"]`
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({ a: "" }, { preserveEmptyStrings: true }),
            `Expected array
  at ["a"]`
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({ a: "1" }),
            `Expected array
  at ["a"]`
          )
        })
      })

      it("decodes and validates Record values", async () => {
        const schema = Schema.Record(Schema.String, Schema.Finite)
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), { a: 1 })
        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1", b: "2" }), { a: 1, b: 2 })
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "1", b: "value" }),
          `Expected a string representing a finite number
  at ["b"]`
        )
      })

      describe("Tuple", () => {
        it("accepts array tuple input and rejects scalar input", async () => {
          const schema = Schema.Tuple([Schema.Number])
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown(["1"]), [1])
          await assertFailure(config, ConfigProvider.fromUnknown("1"), `Expected array`)
        })

        it("requires and validates every tuple element", async () => {
          const schema = Schema.Tuple([Schema.String, Schema.Finite])
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown(["a", "2"]), ["a", 2])
          await assertFailure(
            config,
            ConfigProvider.fromUnknown(["a"]),
            `Missing key
  at [1]`
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown(["a", "value"]),
            `Expected a string representing a finite number
  at [1]`
          )
        })
      })

      it("accepts array input and rejects scalar Array input", async () => {
        const schema = Schema.Array(Schema.Finite)
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown(["1"]), [1])
        await assertFailure(config, ConfigProvider.fromUnknown("1"), `Expected array`)
        await assertSuccess(config, ConfigProvider.fromUnknown(["1", "2"]), [1, 2])
        await assertFailure(
          config,
          ConfigProvider.fromUnknown(["1", "value"]),
          `Expected a string representing a finite number
  at [1]`
        )
      })

      describe("Union", () => {
        it("decodes literal unions", async () => {
          const schema = Schema.Literals(["a", "b"])
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown("a"), "a")
          await assertSuccess(config, ConfigProvider.fromUnknown("b"), "b")
        })

        it("uses first-match semantics by default", async () => {
          const schema = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({ b: Schema.Number })
          ])
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a" }), { a: "a" })
          await assertSuccess(config, ConfigProvider.fromUnknown({ b: "1" }), { b: 1 })
          await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a", b: "1" }), { a: "a" })
        })

        it("enforces exactly one match in oneOf mode", async () => {
          const schema = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({ b: Schema.Number })
          ], { mode: "oneOf" })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a" }), { a: "a" })
          await assertSuccess(config, ConfigProvider.fromUnknown({ b: "1" }), { b: 1 })
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({ a: "a", b: "1" }),
            "Expected exactly one member to match"
          )
        })

        it("decodes Number before String", async () => {
          const schema = Schema.Union([Schema.Number, Schema.String])
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
          await assertSuccess(config, ConfigProvider.fromUnknown("a"), "a")
        })

        it("still decodes numeric input when String is listed first", async () => {
          const schema = Schema.Union([Schema.String, Schema.Number])
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
          await assertSuccess(config, ConfigProvider.fromUnknown("a"), "a")
        })
      })

      it("decodes recursive suspended schemas", async () => {
        interface A {
          readonly a: string
          readonly as: ReadonlyArray<A>
        }
        const schema = Schema.Struct({
          a: Schema.String,
          as: Schema.Array(Schema.suspend((): Schema.Codec<A> => schema))
        })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1", as: [] }), { a: "1", as: [] })
        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1", as: [{ a: "2", as: [] }] }), {
          a: "1",
          as: [{ a: "2", as: [] }]
        })
      })

      it("reports nested Int validation errors", async () => {
        const schema = Schema.Struct({ a: Schema.Redacted(Schema.Int) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), { a: Redacted.make(1) })
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({}),
          `Missing key
  at ["a"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "1.1" }),
          `Expected an integer
  at ["a"]`
        )
      })

      it("decodes nested URL values", async () => {
        const schema = Schema.Struct({ a: Schema.URL })
        const config = Config.schema(schema)

        await assertSuccess(
          config,
          ConfigProvider.fromUnknown({ a: "https://example.com" }),
          { a: new URL("https://example.com") }
        )
      })
    })
  })
})
