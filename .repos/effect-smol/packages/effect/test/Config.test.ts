import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Config, ConfigProvider, Duration, Effect, Option, pipe, Redacted, Result, Schema, SchemaIssue } from "effect"
import * as assert from "node:assert"

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
  it("a config is an Effect and can be yielded", () => {
    const provider = ConfigProvider.fromEnv({ env: { STRING: "value" } })
    const result = Effect.runSync(Effect.provide(
      Config.schema(Schema.Struct({ STRING: Schema.String })),
      ConfigProvider.layer(provider)
    ))
    deepStrictEqual(result, { STRING: "value" })
  })

  describe("schema", () => {
    it("should not leak any information about the value", async () => {
      const provider = ConfigProvider.fromUnknown({})
      await assertFailure(
        Config.schema(Schema.Redacted(Schema.Literal("secret")), "a"),
        provider,
        `Invalid data <redacted>
  at ["a"]`
      )
    })
  })

  describe("constructors", () => {
    it("fail", async () => {
      await assertFailure(
        Config.fail(
          new Schema.SchemaError(new SchemaIssue.Forbidden(Option.none(), { message: "failure message" }))
        ),
        ConfigProvider.fromUnknown({}),
        `failure message`
      )
    })

    it("succeed", async () => {
      const provider = ConfigProvider.fromUnknown({})
      await assertSuccess(Config.succeed(1), provider, 1)
    })

    it("string", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "value" })
      await assertSuccess(Config.string("a"), provider, "value")
      await assertFailure(
        Config.string("b"),
        provider,
        `Expected string, got undefined
  at ["b"]`
      )
    })

    it("nonEmptyString", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "value", b: "" })
      await assertSuccess(Config.nonEmptyString("a"), provider, "value")
      await assertFailure(
        Config.nonEmptyString("b"),
        provider,
        `Expected a value with a length of at least 1, got ""
  at ["b"]`
      )
    })

    it("number", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "1", c: "c", d: "Infinity" })
      await assertSuccess(Config.number("a"), provider, 1)
      await assertSuccess(Config.number("d"), provider, Infinity)
      await assertFailure(
        Config.number("b"),
        provider,
        `Expected string | "Infinity" | "-Infinity" | "NaN", got undefined
  at ["b"]`
      )
    })

    it("finite", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "1", b: "a", c: "Infinity" })
      await assertSuccess(Config.finite("a"), provider, 1)
      await assertFailure(
        Config.finite("b"),
        provider,
        `Expected a string representing a finite number, got "a"
  at ["b"]`
      )
      await assertFailure(
        Config.finite("c"),
        provider,
        `Expected a string representing a finite number, got "Infinity"
  at ["c"]`
      )
    })

    it("int", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "1", b: "1.2" })
      await assertSuccess(Config.int("a"), provider, 1)
      await assertFailure(
        Config.int("b"),
        provider,
        `Expected an integer, got 1.2
  at ["b"]`
      )
    })

    it("literal", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "L" })
      await assertSuccess(Config.literal("L", "a"), provider, "L")
      await assertFailure(
        Config.literal("-", "a"),
        provider,
        `Expected "-", got "L"
  at ["a"]`
      )
    })

    it("literals", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "production", b: "staging" })
      await assertSuccess(Config.literals(["development", "production"], "a"), provider, "production")
      await assertFailure(
        Config.literals(["development", "production"], "b"),
        provider,
        `Expected "development" | "production", got "staging"
  at ["b"]`
      )
    })

    it("literals (numbers)", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "1", b: "3" })
      await assertSuccess(Config.literals([1, 2], "a"), provider, 1)
      await assertFailure(
        Config.literals([1, 2], "b"),
        provider,
        `Expected "1" | "2", got "3"
  at ["b"]`
      )
    })

    it("date", async () => {
      const provider = ConfigProvider.fromUnknown({ a: "2021-01-01", b: "invalid" })
      await assertSuccess(Config.date("a"), provider, new Date("2021-01-01"))
      await assertFailure(
        Config.date("b"),
        provider,
        `Expected a valid date, got Invalid Date
  at ["b"]`
      )
    })

    it("redacted", async () => {
      const provider = ConfigProvider.fromUnknown({
        a: "value"
      })

      await assertSuccess(Config.redacted("a"), provider, Redacted.make("value"))
      await assertFailure(
        Config.redacted("failure"),
        provider,
        `Invalid data <redacted>
  at ["failure"]`
      )
    })

    it("url", async () => {
      const provider = ConfigProvider.fromUnknown({
        a: "https://example.com"
      })

      await assertSuccess(Config.url("a"), provider, new URL("https://example.com"))
      await assertFailure(
        Config.url("failure"),
        provider,
        `Expected string, got undefined
  at ["failure"]`
      )
    })
  })

  describe("combinators", () => {
    it("map", async () => {
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

    it("mapOrFail", async () => {
      const config = Config.schema(Schema.String)
      const f = (s: string) =>
        s === ""
          ? Effect.fail(
            new Config.ConfigError(
              new Schema.SchemaError(new SchemaIssue.InvalidValue(Option.some(s), { message: "empty" }))
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
        ConfigProvider.fromUnknown(""),
        `empty`
      )
    })

    it("orElse", async () => {
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

    describe("all", () => {
      it("tuple", async () => {
        const config = Config.all([Config.nonEmptyString("a"), Config.finite("b")])

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a", b: "1" }), ["a", 1])
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "", b: "1" }),
          `Expected a value with a length of at least 1, got ""
  at ["a"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "a", b: "b" }),
          `Expected a string representing a finite number, got "b"
  at ["b"]`
        )
      })

      it("iterable", async () => {
        const config = Config.all(new Set([Config.nonEmptyString("a"), Config.finite("b")]))

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a", b: "1" }), ["a", 1])
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "", b: "1" }),
          `Expected a value with a length of at least 1, got ""
  at ["a"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "a", b: "b" }),
          `Expected a string representing a finite number, got "b"
  at ["b"]`
        )
      })

      it("struct", async () => {
        const config = Config.all({ a: Config.nonEmptyString("b"), c: Config.finite("d") })

        await assertSuccess(config, ConfigProvider.fromUnknown({ b: "b", d: "1" }), { a: "b", c: 1 })
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "", d: "1" }),
          `Expected a value with a length of at least 1, got ""
  at ["b"]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "b", d: "b" }),
          `Expected a string representing a finite number, got "b"
  at ["d"]`
        )
      })
    })

    describe("withDefault", () => {
      it("value", async () => {
        const defaultValue = 0
        const config = Config.finite("a").pipe(Config.withDefault(defaultValue))

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), 1)
        await assertSuccess(config, ConfigProvider.fromUnknown({}), defaultValue)
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "value" }),
          `Expected a string representing a finite number, got "value"
  at ["a"]`
        )
      })

      it("redacted", async () => {
        const defaultValue = Redacted.make("default")
        const config = Config.redacted("a").pipe(Config.withDefault(defaultValue))

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "value" }), Redacted.make("value"))
        await assertSuccess(config, ConfigProvider.fromUnknown({}), defaultValue)
      })

      it("struct", async () => {
        const defaultValue = { a: "a", c: 0 }
        const config = Config.all({ a: Config.nonEmptyString("b"), c: Config.finite("d") }).pipe(
          Config.withDefault(defaultValue)
        )

        await assertSuccess(config, ConfigProvider.fromUnknown({ b: "b", d: "1" }), { a: "b", c: 1 })
        await assertSuccess(config, ConfigProvider.fromUnknown({ b: "b" }), defaultValue)
        await assertSuccess(config, ConfigProvider.fromUnknown({ d: "1" }), defaultValue)

        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "", d: "1" }),
          `Expected a value with a length of at least 1, got ""
  at ["b"]`
        )
      })
    })

    describe("option", () => {
      it("value", async () => {
        const config = Config.finite("a").pipe(Config.option)

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), Option.some(1))
        await assertSuccess(config, ConfigProvider.fromUnknown({}), Option.none())
        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ a: "value" }),
          `Expected a string representing a finite number, got "value"
  at ["a"]`
        )
      })

      it("struct", async () => {
        const config = Config.all({ a: Config.nonEmptyString("b"), c: Config.finite("d") }).pipe(
          Config.option
        )

        await assertSuccess(config, ConfigProvider.fromUnknown({ b: "b", d: "1" }), Option.some({ a: "b", c: 1 }))
        await assertSuccess(config, ConfigProvider.fromUnknown({ b: "b" }), Option.none())
        await assertSuccess(config, ConfigProvider.fromUnknown({ d: "1" }), Option.none())

        await assertFailure(
          config,
          ConfigProvider.fromUnknown({ b: "", d: "1" }),
          `Expected a value with a length of at least 1, got ""
  at ["b"]`
        )
      })
    })

    describe("nested", () => {
      describe("fromUnknown", () => {
        it("nested", async () => {
          const config = Config.string().pipe(Config.nested("a"))

          await assertSuccess(
            config,
            ConfigProvider.fromUnknown({ a: "value" }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({}),
            `Expected string, got undefined
  at ["a"]`
          )
        })

        it("name + nested", async () => {
          const config = Config.string("a").pipe(Config.nested("b"))

          await assertSuccess(
            config,
            ConfigProvider.fromUnknown({ b: { a: "value" } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({}),
            `Expected string, got undefined
  at ["b"]["a"]`
          )
        })

        it("name + nested + nested", async () => {
          const config = Config.string("a").pipe(Config.nested("b"), Config.nested("c"))

          await assertSuccess(
            config,
            ConfigProvider.fromUnknown({ c: { b: { a: "value" } } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromUnknown({ c: { b: {} } }),
            `Expected string, got undefined
  at ["c"]["b"]["a"]`
          )
        })

        it("all", async () => {
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
            `Expected string, got undefined
  at ["database"]["host"]`
          )
        })
      })

      describe("fromEnv", () => {
        it("nested", async () => {
          const config = Config.string().pipe(Config.nested("a"))

          await assertSuccess(
            config,
            ConfigProvider.fromEnv({ env: { a: "value" } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: {} }),
            `Expected string, got undefined
  at ["a"]`
          )
        })

        it("name + nested", async () => {
          const config = Config.string("a").pipe(Config.nested("b"))

          await assertSuccess(
            config,
            ConfigProvider.fromEnv({ env: { "b_a": "value" } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: {} }),
            `Expected string, got undefined
  at ["b"]["a"]`
          )
        })

        it("name + nested + nested", async () => {
          const config = Config.string("a").pipe(Config.nested("b"), Config.nested("c"))

          await assertSuccess(
            config,
            ConfigProvider.fromEnv({ env: { "c_b_a": "value" } }),
            "value"
          )
          await assertFailure(
            config,
            ConfigProvider.fromEnv({ env: { "c_b": "value" } }),
            `Expected string, got undefined
  at ["c"]["b"]["a"]`
          )
        })

        it("all", async () => {
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
            `Expected string, got undefined
  at ["database"]["host"]`
          )
        })
      })
    })

    describe("unwrap", () => {
      it("plain object", async () => {
        const config = Config.unwrap({
          a: Config.schema(Schema.String, "a2")
        })

        await assertSuccess(config, ConfigProvider.fromUnknown({ a2: "value" }), { a: "value" })
      })

      it("nested", async () => {
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

  describe("Config built-in schemas", () => {
    it("Boolean", async () => {
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
        `Expected "true" | "yes" | "on" | "1" | "y" | "false" | "no" | "off" | "0" | "n", got "value"
  at ["failure"]`
      )
    })

    it("Duration", async () => {
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
        `Invalid Duration string: value
  at ["failure"]`
      )
    })

    it("Port", async () => {
      const provider = ConfigProvider.fromUnknown({
        a: "8080",
        failure: "-1"
      })

      await assertSuccess(Config.port("a"), provider, 8080)
      await assertFailure(
        Config.port("failure"),
        provider,
        `Expected a value between 1 and 65535, got -1
  at ["failure"]`
      )
    })

    it("LogLevel / logLevel", async () => {
      const provider = ConfigProvider.fromUnknown({
        a: "Info",
        failure_1: "info",
        failure_2: "value"
      })

      await assertSuccess(Config.logLevel("a"), provider, "Info")
      await assertFailure(
        Config.logLevel("failure_1"),
        provider,
        `Expected "All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None", got "info"
  at ["failure_1"]`
      )
      await assertFailure(
        Config.logLevel("failure_2"),
        provider,
        `Expected "All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None", got "value"
  at ["failure_2"]`
      )
    })

    describe("Record", () => {
      it("from record", async () => {
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

      it("from string", async () => {
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

      it("options", async () => {
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

  describe("fromEnv", () => {
    it("path argument", async () => {
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

    describe("leafs and containers", () => {
      it("node can be both leaf and object", async () => {
        const schema = Schema.Struct({ a: Schema.Number })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", "a_b": "2" } }), { a: 1 })
      })

      it("node can be both leaf and array", async () => {
        const schema = Schema.Struct({ a: Schema.Number })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", "a_0": "2" } }), { a: 1 })
      })

      it("if a node can be both object and array, it should be an object", async () => {
        const schema = Schema.Struct({ a: Schema.Struct({ b: Schema.Number }) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", "a_b": "2", "a_0": "3" } }), {
          a: { b: 2 }
        })
      })
    })

    it("Null", async () => {
      const schema = Schema.Null
      const config = Config.schema(schema, "a")

      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "null" } }), null)
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: {} }),
        `Expected "null", got undefined
  at ["a"]`
      )
    })

    it("String", async () => {
      const schema = Schema.String
      const config = Config.schema(schema, "a")

      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), "a")
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: {} }),
        `Expected string, got undefined
  at ["a"]`
      )
    })

    it("Number", async () => {
      const schema = Schema.Number
      const config = Config.schema(schema, "a")

      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: {} }),
        `Expected string | "Infinity" | "-Infinity" | "NaN", got undefined
  at ["a"]`
      )
    })

    it("Finite", async () => {
      const schema = Schema.Finite
      const config = Config.schema(schema, "a")

      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: {} }),
        `Expected string, got undefined
  at ["a"]`
      )
    })

    it("Int", async () => {
      const schema = Schema.Int
      const config = Config.schema(schema, "a")

      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: {} }),
        `Expected string, got undefined
  at ["a"]`
      )
    })

    it("Boolean", async () => {
      const schema = Schema.Boolean
      const config = Config.schema(schema, "a")

      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "true" } }), true)
      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "false" } }), false)
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: {} }),
        `Expected "true" | "false", got undefined
  at ["a"]`
      )
    })

    describe("Struct", () => {
      it("required properties", async () => {
        const schema = Schema.Struct({ a: Schema.Number })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: 1 })
      })

      it("optionalKey properties", async () => {
        const schema = Schema.Struct({ a: Schema.optionalKey(Schema.Number) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: 1 })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: {} }), {})
      })

      it("optional properties", async () => {
        const config = Config.schema(
          Schema.Struct({ a: Schema.optional(Schema.Number) })
        )

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: 1 })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: {} }), {})
      })

      it("literal property", async () => {
        const schema = Schema.Struct({ a: Schema.Literals(["b", "c"]) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "b" } }), { a: "b" })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "c" } }), { a: "c" })
      })

      it("array property", async () => {
        const schema = Schema.Struct({ a: Schema.Array(Schema.Number) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "" } }), { a: [] })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: [1] })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a_0: "1" } }), { a: [1] })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a_0: "1", a_1: "2" } }), { a: [1, 2] })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", a_0: "2" } }), { a: [1] })
      })
    })

    it("Record(String, Finite)", async () => {
      const schema = Schema.Record(Schema.String, Schema.Finite)
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: 1 })
      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", b: "2" } }), { a: 1, b: 2 })
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: { a: "1", b: "value" } }),
        `Expected a string representing a finite number, got "value"
  at ["b"]`
      )
    })

    describe("Tuple", () => {
      it("empty", async () => {
        const schema = Schema.Struct({ a: Schema.Tuple([]) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "" } }), { a: [] })
      })

      it("ensure array", async () => {
        const schema = Schema.Struct({ a: Schema.Tuple([Schema.Number]) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: [1] })
      })

      it("required elements", async () => {
        const schema = Schema.Struct({ a: Schema.Tuple([Schema.String, Schema.Finite]) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a_0: "a", a_1: "2" } }), { a: ["a", 2] })
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: { a: "a" } }),
          `Missing key
  at ["a"][1]`
        )
        await assertFailure(
          config,
          ConfigProvider.fromEnv({ env: { a_0: "a", a_1: "value" } }),
          `Expected a string representing a finite number, got "value"
  at ["a"][1]`
        )
      })
    })

    it("Array(Finite)", async () => {
      const schema = Schema.Struct({ a: Schema.Array(Schema.Finite) })
      const config = Config.schema(schema)

      // ensure array
      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), { a: [1] })
      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a_0: "1", a_1: "2" } }), { a: [1, 2] })
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: { a: "a", a_0: "1" } }),
        `Expected a string representing a finite number, got "a"
  at ["a"][0]`
      )
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: { a_0: "1", a_2: "2" } }),
        `Expected string, got undefined
  at ["a"][1]`
      )
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: { a_0: "1", a_1: "value" } }),
        `Expected a string representing a finite number, got "value"
  at ["a"][1]`
      )
    })

    describe("Union", () => {
      describe("Literals", () => {
        it("string", async () => {
          const schema = Schema.Struct({ a: Schema.Literals(["a", "b"]) })
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), { a: "a" })
          await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "b" } }), { a: "b" })
        })
      })

      it("inclusive", async () => {
        const schema = Schema.Union([
          Schema.Struct({ a: Schema.String }),
          Schema.Struct({ b: Schema.Number })
        ])
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), { a: "a" })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { b: "1" } }), { b: 1 })
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a", b: "1" } }), { a: "a" })
      })

      it("exclusive", async () => {
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
          `Expected exactly one member to match the input {"a":"a","b":"1"}`
        )
      })

      it("number | string", async () => {
        const schema = Schema.Union([Schema.Number, Schema.String])
        const config = Config.schema(schema, "a")

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), "a")
      })

      it("string | number", async () => {
        const schema = Schema.Union([Schema.String, Schema.Number])
        const config = Config.schema(schema, "a")

        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), 1)
        await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "a" } }), "a")
      })
    })

    it("Suspend", async () => {
      interface A {
        readonly a: string
        readonly as: ReadonlyArray<A>
      }
      const schema = Schema.Struct({
        a: Schema.String,
        as: Schema.Array(Schema.suspend((): Schema.Codec<A> => schema))
      })
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1", as: "" } }), { a: "1", as: [] })
      await assertSuccess(
        config,
        ConfigProvider.fromEnv({ env: { a: "1", as_0_a: "2", as_0_as: "" } }),
        {
          a: "1",
          as: [{ a: "2", as: [] }]
        }
      )
    })

    it("Redacted(Int)", async () => {
      const schema = Schema.Redacted(Schema.Int)
      const config = Config.schema(schema, "a")

      await assertSuccess(config, ConfigProvider.fromEnv({ env: { a: "1" } }), Redacted.make(1))
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: {} }),
        `Invalid data <redacted>
  at ["a"]`
      )
      await assertFailure(
        config,
        ConfigProvider.fromEnv({ env: { a: "1.1" } }),
        `Invalid data <redacted>
  at ["a"]`
      )
    })
  })

  describe("fromUnknown", () => {
    it("path argument", async () => {
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

    it("Undefined", async () => {
      const schema = Schema.Undefined
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromUnknown(undefined), undefined)
      await assertFailure(config, ConfigProvider.fromUnknown("a"), `Expected undefined, got "a"`)
    })

    it("Null", async () => {
      const schema = Schema.Null
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromUnknown("null"), null)
      await assertFailure(config, ConfigProvider.fromUnknown("a"), `Expected "null", got "a"`)
    })

    it("String", async () => {
      const schema = Schema.String
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromUnknown("value"), "value")
      await assertFailure(config, ConfigProvider.fromUnknown({}), `Expected string, got undefined`)
    })

    it("Number", async () => {
      const schema = Schema.Number
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
      await assertFailure(
        config,
        ConfigProvider.fromUnknown("a"),
        `Expected a string representing a finite number, got "a"
Expected "Infinity" | "-Infinity" | "NaN", got "a"`
      )
    })

    it("Finite", async () => {
      const schema = Schema.Finite
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
      await assertFailure(
        config,
        ConfigProvider.fromUnknown("a"),
        `Expected a string representing a finite number, got "a"`
      )
    })

    it("Int", async () => {
      const schema = Schema.Int
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
      await assertFailure(
        config,
        ConfigProvider.fromUnknown("a"),
        `Expected a string representing a finite number, got "a"`
      )
    })

    it("Boolean", async () => {
      const schema = Schema.Boolean
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromUnknown("true"), true)
      await assertSuccess(config, ConfigProvider.fromUnknown("false"), false)
      await assertFailure(config, ConfigProvider.fromUnknown("a"), `Expected "true" | "false", got "a"`)
    })

    describe("Struct", () => {
      it("required properties", async () => {
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
          `Expected a string representing a finite number, got "value"
  at ["a"]`
        )
      })

      it("optionalKey properties", async () => {
        const schema = Schema.Struct({ a: Schema.optionalKey(Schema.Number) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), { a: 1 })
        await assertSuccess(config, ConfigProvider.fromUnknown({}), {})
      })

      it("optional properties", async () => {
        const config = Config.schema(
          Schema.Struct({ a: Schema.optional(Schema.Number) })
        )

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), { a: 1 })
        await assertSuccess(config, ConfigProvider.fromUnknown({}), {})
      })

      it("literal property", async () => {
        const schema = Schema.Struct({ a: Schema.Literals(["b", "c"]) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "b" }), { a: "b" })
        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "c" }), { a: "c" })
      })

      it("array property", async () => {
        const schema = Schema.Struct({ a: Schema.Array(Schema.Number) })
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "" }), { a: [] })
        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), { a: [1] })
      })
    })

    it("Record(String, Finite)", async () => {
      const schema = Schema.Record(Schema.String, Schema.Finite)
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1" }), { a: 1 })
      await assertSuccess(config, ConfigProvider.fromUnknown({ a: "1", b: "2" }), { a: 1, b: 2 })
      await assertFailure(
        config,
        ConfigProvider.fromUnknown({ a: "1", b: "value" }),
        `Expected a string representing a finite number, got "value"
  at ["b"]`
      )
    })

    describe("Tuple", () => {
      it("ensure array", async () => {
        const schema = Schema.Tuple([Schema.Number])
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown(["1"]), [1])
        await assertSuccess(config, ConfigProvider.fromUnknown("1"), [1])
      })

      it("required elements", async () => {
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
          `Expected a string representing a finite number, got "value"
  at [1]`
        )
      })
    })

    it("Array(Finite)", async () => {
      const schema = Schema.Array(Schema.Finite)
      const config = Config.schema(schema)

      await assertSuccess(config, ConfigProvider.fromUnknown(["1"]), [1])
      // ensure array
      await assertSuccess(config, ConfigProvider.fromUnknown("1"), [1])
      await assertSuccess(config, ConfigProvider.fromUnknown(["1", "2"]), [1, 2])
      await assertFailure(
        config,
        ConfigProvider.fromUnknown(["1", "value"]),
        `Expected a string representing a finite number, got "value"
  at [1]`
      )
    })

    describe("Union", () => {
      describe("Literals", () => {
        it("string", async () => {
          const schema = Schema.Literals(["a", "b"])
          const config = Config.schema(schema)

          await assertSuccess(config, ConfigProvider.fromUnknown("a"), "a")
          await assertSuccess(config, ConfigProvider.fromUnknown("b"), "b")
        })
      })

      it("inclusive", async () => {
        const schema = Schema.Union([
          Schema.Struct({ a: Schema.String }),
          Schema.Struct({ b: Schema.Number })
        ])
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a" }), { a: "a" })
        await assertSuccess(config, ConfigProvider.fromUnknown({ b: "1" }), { b: 1 })
        await assertSuccess(config, ConfigProvider.fromUnknown({ a: "a", b: "1" }), { a: "a" })
      })

      it("exclusive", async () => {
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
          `Expected exactly one member to match the input {"a":"a","b":"1"}`
        )
      })

      it("number | string", async () => {
        const schema = Schema.Union([Schema.Number, Schema.String])
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
        await assertSuccess(config, ConfigProvider.fromUnknown("a"), "a")
      })

      it("string | number", async () => {
        const schema = Schema.Union([Schema.String, Schema.Number])
        const config = Config.schema(schema)

        await assertSuccess(config, ConfigProvider.fromUnknown("1"), 1)
        await assertSuccess(config, ConfigProvider.fromUnknown("a"), "a")
      })
    })

    it("Suspend", async () => {
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

    it("Redacted(Int)", async () => {
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
        `Invalid data <redacted>
  at ["a"]`
      )
    })

    it("URL", async () => {
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
