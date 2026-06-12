import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { ConfigProvider, Effect, FileSystem, Layer, Path, PlatformError, Result } from "effect"

async function assertSuccess(
  provider: ConfigProvider.ConfigProvider,
  path: ConfigProvider.Path,
  expected: ConfigProvider.Node | undefined
) {
  const r = Effect.result(provider.load(path))
  deepStrictEqual(await Effect.runPromise(r), Result.succeed(expected))
}

// async function assertFailure(
//   provider: ConfigProvider.ConfigProvider,
//   path: ConfigProvider.Path,
//   expected: ConfigProvider.SourceError
// ) {
//   const r = Effect.result(provider.load(path))
//   deepStrictEqual(await Effect.runPromise(r), Result.fail(expected))
// }

describe("ConfigProvider", () => {
  it("orElse", async () => {
    const provider1 = ConfigProvider.fromEnv({
      env: {
        "A": "value1"
      }
    })
    const provider2 = ConfigProvider.fromEnv({
      env: {
        "B": "value2"
      }
    })
    const provider = provider1.pipe(ConfigProvider.orElse(provider2))
    await assertSuccess(provider, ["A"], ConfigProvider.makeValue("value1"))
    await assertSuccess(provider, ["B"], ConfigProvider.makeValue("value2"))
  })

  it("constantCase", async () => {
    const provider = ConfigProvider.constantCase(ConfigProvider.fromEnv({
      env: {
        "CONSTANT_CASE": "value1"
      }
    }))
    await assertSuccess(provider, ["constant.case"], ConfigProvider.makeValue("value1"))
  })

  describe("mapInput", () => {
    it("two mappings", async () => {
      const appendA = ConfigProvider.mapInput((path) => path.map((sn) => typeof sn === "string" ? sn + "_A" : sn))
      const appendB = ConfigProvider.mapInput((path) => path.map((sn) => typeof sn === "string" ? sn + "_B" : sn))
      const provider = ConfigProvider.fromEnv({
        env: {
          "KEY_A_B": "value"
        }
      }).pipe(appendA, appendB)
      await assertSuccess(provider, ["KEY"], ConfigProvider.makeValue("value"))
    })
  })

  describe("nested", () => {
    it("should add a prefix to the path", async () => {
      const provider = ConfigProvider.fromEnv({
        env: {
          "prefix_A": "value"
        }
      }).pipe(ConfigProvider.nested("prefix"))
      await assertSuccess(provider, ["A"], ConfigProvider.makeValue("value"))
    })

    it("constantCase + nested", async () => {
      const provider = ConfigProvider.fromEnv({
        env: {
          "prefix_KEY_WITH_DOTS": "value"
        }
      }).pipe(ConfigProvider.constantCase, ConfigProvider.nested("prefix"))
      await assertSuccess(provider, ["key.with.dots"], ConfigProvider.makeValue("value"))
    })

    it("nested + constantCase", async () => {
      const provider = ConfigProvider.fromEnv({
        env: {
          "PREFIX_WITH_DOTS_KEY_WITH_DOTS": "value"
        }
      }).pipe(ConfigProvider.nested("prefix.with.dots"), ConfigProvider.constantCase)
      await assertSuccess(provider, ["key.with.dots"], ConfigProvider.makeValue("value"))
    })
  })

  describe("fromEnv", () => {
    it("env without an underscore", async () => {
      const env = { A: "value1" }
      const provider = ConfigProvider.fromEnv({ env })
      await assertSuccess(provider, ["A"], ConfigProvider.makeValue("value1"))
    })

    it("missing key returns undefined", async () => {
      const env = { A: "value1" }
      const provider = ConfigProvider.fromEnv({ env })
      await assertSuccess(provider, ["missing"], undefined)
    })

    it("direct lookup of a key containing underscores", async () => {
      const env = { NODE_ENV: "value1" }
      const provider = ConfigProvider.fromEnv({ env })
      await assertSuccess(provider, ["NODE_ENV"], ConfigProvider.makeValue("value1"))
    })

    it("single underscore creates nesting", async () => {
      const env = { NODE_ENV: "value1" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["NODE"], ConfigProvider.makeRecord(new Set(["ENV"])))
      await assertSuccess(provider, ["NODE", "ENV"], ConfigProvider.makeValue("value1"))
    })

    it("prefix can be both a value and a container", async () => {
      const env = { NODE: "value1", NODE_ENV: "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["NODE"], ConfigProvider.makeRecord(new Set(["ENV"]), "value1"))
      await assertSuccess(provider, ["NODE", "ENV"], ConfigProvider.makeValue("value2"))
      await assertSuccess(provider, ["NODE_ENV"], ConfigProvider.makeValue("value2"))
    })

    it("multiple nested children under the same prefix", async () => {
      const env = { NODE: "value1", NODE_ENV: "value2", NODE_PATH: "value3" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["NODE"], ConfigProvider.makeRecord(new Set(["ENV", "PATH"]), "value1"))
      await assertSuccess(provider, ["NODE", "ENV"], ConfigProvider.makeValue("value2"))
      await assertSuccess(provider, ["NODE", "PATH"], ConfigProvider.makeValue("value3"))
      await assertSuccess(provider, ["NODE_PATH"], ConfigProvider.makeValue("value3"))
    })

    it("nested depth > 2 works", async () => {
      const env = { A_B_C: "value1" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeRecord(new Set(["B"])))
      await assertSuccess(provider, ["A", "B"], ConfigProvider.makeRecord(new Set(["C"])))
      await assertSuccess(provider, ["A", "B", "C"], ConfigProvider.makeValue("value1"))
    })

    it("array: dense numeric children yield an Array node", async () => {
      const env = { A_0: "value1", A_1: "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeArray(2))
      await assertSuccess(provider, ["A", 0], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A", 1], ConfigProvider.makeValue("value2"))
    })

    it("array: non-dense numeric children still yield an Array node", async () => {
      const env = { A: "root", A_0: "value1", A_2: "value3" }
      const provider = ConfigProvider.fromEnv({ env })

      // max index is 2 => length 3 (sparse is allowed)
      await assertSuccess(provider, ["A"], ConfigProvider.makeArray(3, "root"))
      await assertSuccess(provider, ["A", 0], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A", 1], undefined)
      await assertSuccess(provider, ["A", 2], ConfigProvider.makeValue("value3"))
    })

    it("array: parent can have a co-located value", async () => {
      const env = { A: "root", A_0: "value1", A_1: "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeArray(2, "root"))
      await assertSuccess(provider, ["A", 0], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A", 1], ConfigProvider.makeValue("value2"))
    })

    it("mixed children (numeric + non-numeric) yields Record", async () => {
      const env = { A_0: "value1", A_B: "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeRecord(new Set(["0", "B"])))
      await assertSuccess(provider, ["A", 0], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A", "B"], ConfigProvider.makeValue("value2"))
    })

    it("double underscore produces an empty segment (no special handling)", async () => {
      const env = { A__B: "value1" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeRecord(new Set([""])))
      await assertSuccess(provider, ["A", ""], ConfigProvider.makeRecord(new Set(["B"])))
      await assertSuccess(provider, ["A", "", "B"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A__B"], ConfigProvider.makeValue("value1"))
    })

    it("empty segment node can be both a value and a container", async () => {
      const env = { A_: "value1", A__B: "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A", ""], ConfigProvider.makeRecord(new Set(["B"]), "value1"))
      await assertSuccess(provider, ["A", "", "B"], ConfigProvider.makeValue("value2"))
    })

    it("leading underscore creates an empty first segment", async () => {
      const env = { _A: "value1" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set([""])))
      await assertSuccess(provider, [""], ConfigProvider.makeRecord(new Set(["A"])))
      await assertSuccess(provider, ["", "A"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["_A"], ConfigProvider.makeValue("value1"))
    })

    it("trailing underscore creates an empty last segment", async () => {
      const env = { A_: "value1" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeRecord(new Set([""])))
      await assertSuccess(provider, ["A", ""], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A_"], ConfigProvider.makeValue("value1"))
    })

    it("cannot descend past a leaf (A exists, but A_B does not)", async () => {
      const env = { A: "value1" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A", "B"], undefined)
      await assertSuccess(provider, ["A_B"], undefined)
    })

    it("direct lookup and nested lookup both work for the same env var", async () => {
      const env = { A_B: "value1" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A_B"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A"], ConfigProvider.makeRecord(new Set(["B"])))
      await assertSuccess(provider, ["A", "B"], ConfigProvider.makeValue("value1"))
    })

    it("prefix value is preserved when there are multiple nested children", async () => {
      const env = { A: "root", A_B: "value1", A_C: "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeRecord(new Set(["B", "C"]), "root"))
      await assertSuccess(provider, ["A", "B"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A", "C"], ConfigProvider.makeValue("value2"))
    })

    it("intermediate node can be both a value and a container (A_B and A_B_C)", async () => {
      const env = { A_B: "value1", A_B_C: "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A_B"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A"], ConfigProvider.makeRecord(new Set(["B"])))
      await assertSuccess(provider, ["A", "B"], ConfigProvider.makeRecord(new Set(["C"]), "value1"))
      await assertSuccess(provider, ["A", "B", "C"], ConfigProvider.makeValue("value2"))
    })

    it("numeric index: string and number segments should resolve the same", async () => {
      const env = { A_0: "value1" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A", 0], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A", "0"], ConfigProvider.makeValue("value1"))
    })

    it("array: leading-zero indices are not numeric, so it yields a Record", async () => {
      const env = { A_01: "value1", A_1: "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeRecord(new Set(["01", "1"])))
      await assertSuccess(provider, ["A", "01"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["A", 1], ConfigProvider.makeValue("value2"))
    })

    it("root path exposes top-level keys", async () => {
      const env = { A: "value1", B_C: "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["A", "B"])))
      await assertSuccess(provider, ["A"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["B"], ConfigProvider.makeRecord(new Set(["C"])))
    })

    it("underscore-only key creates empty segments", async () => {
      const env = { "_": "value1" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["_"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set([""])))
      await assertSuccess(provider, [""], ConfigProvider.makeRecord(new Set([""])))
      await assertSuccess(provider, ["", ""], ConfigProvider.makeValue("value1"))
    })

    it("array: non-integer indices do not yield an Array node", async () => {
      const env = { "A_-1": "value1", "A_1.5": "value2" }
      const provider = ConfigProvider.fromEnv({ env })

      await assertSuccess(provider, ["A"], ConfigProvider.makeRecord(new Set(["-1", "1.5"])))
    })
  })

  describe("fromUnknown", () => {
    const provider = ConfigProvider.fromUnknown({
      string: "value1",
      record: {
        key1: "value2",
        key2: {
          key3: "value3"
        }
      },
      array: ["value4", {
        key4: "value5"
      }, ["value6"]],
      null: null,
      number: 42,
      boolean: true,
      bigint: 0n,
      undefined,
      unknown: Symbol("unknown")
    })

    it("Root node", async () => {
      await assertSuccess(
        provider,
        [],
        ConfigProvider.makeRecord(
          new Set(["string", "record", "array", "null", "number", "boolean", "bigint", "undefined", "unknown"])
        )
      )
    })

    it("Exact leaf resolution", async () => {
      await assertSuccess(provider, ["string"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["record", "key1"], ConfigProvider.makeValue("value2"))
      await assertSuccess(provider, ["array", 0], ConfigProvider.makeValue("value4"))
      await assertSuccess(provider, ["array", 1, "key4"], ConfigProvider.makeValue("value5"))
      await assertSuccess(provider, ["array", 2, 0], ConfigProvider.makeValue("value6"))
    })

    it("Object detection", async () => {
      await assertSuccess(provider, ["record"], ConfigProvider.makeRecord(new Set(["key1", "key2"])))
      await assertSuccess(provider, ["record", "key2"], ConfigProvider.makeRecord(new Set(["key3"])))
    })

    it("Array detection", async () => {
      await assertSuccess(provider, ["array"], ConfigProvider.makeArray(3))
      await assertSuccess(provider, ["array", 2], ConfigProvider.makeArray(1))
    })

    it("should return undefined on non-existing paths", async () => {
      await assertSuccess(provider, ["string", "non-existing"], undefined)
      await assertSuccess(provider, ["record", "non-existing"], undefined)
      await assertSuccess(provider, ["array", 3, "non-existing"], undefined)
    })

    it("null values", async () => {
      await assertSuccess(provider, ["null"], undefined)
    })

    it("number values", async () => {
      await assertSuccess(provider, ["number"], ConfigProvider.makeValue("42"))
    })

    it("boolean values", async () => {
      await assertSuccess(provider, ["boolean"], ConfigProvider.makeValue("true"))
    })

    it("bigint values", async () => {
      await assertSuccess(provider, ["bigint"], ConfigProvider.makeValue("0"))
    })

    it("undefined values", async () => {
      await assertSuccess(provider, ["undefined"], undefined)
    })

    it("unknown values", async () => {
      await assertSuccess(provider, ["unknown"], ConfigProvider.makeValue("Symbol(unknown)"))
    })
  })

  describe("fromDotEnvContents", () => {
    it("comments are ignored", async () => {
      const provider = ConfigProvider.fromDotEnvContents(`
# comments are ignored
API_URL=https://api.example.com
`)
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["API"])))
      await assertSuccess(provider, ["API_URL"], ConfigProvider.makeValue("https://api.example.com"))
    })

    it("export is allowed", async () => {
      const provider = ConfigProvider.fromDotEnvContents(`
export NODE_ENV=production
`)
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["NODE"])))
      await assertSuccess(provider, ["NODE_ENV"], ConfigProvider.makeValue("production"))
    })

    it("quoting is allowed", async () => {
      const provider = ConfigProvider.fromDotEnvContents(`
NODE_ENV="production"
`)
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["NODE"])))
      await assertSuccess(provider, ["NODE_ENV"], ConfigProvider.makeValue("production"))
    })

    it("objects are supported", async () => {
      const provider = ConfigProvider.fromDotEnvContents(`
OBJECT_key1=value1
OBJECT_key2=value2
`)
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["OBJECT"])))
      await assertSuccess(provider, ["OBJECT"], ConfigProvider.makeRecord(new Set(["key1", "key2"])))
      await assertSuccess(provider, ["OBJECT", "key1"], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["OBJECT", "key2"], ConfigProvider.makeValue("value2"))
    })

    it("a node may be both leaf and object", async () => {
      const provider = ConfigProvider.fromDotEnvContents(`
OBJECT=value1
OBJECT_key1=value2
OBJECT_key2=value3
`)
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["OBJECT"])))
      await assertSuccess(provider, ["OBJECT"], ConfigProvider.makeRecord(new Set(["key1", "key2"]), "value1"))
      await assertSuccess(provider, ["OBJECT", "key1"], ConfigProvider.makeValue("value2"))
      await assertSuccess(provider, ["OBJECT", "key2"], ConfigProvider.makeValue("value3"))
    })

    it("a node may be both leaf and array", async () => {
      const provider = ConfigProvider.fromDotEnvContents(`
ARRAY=value1
ARRAY_0=value2
ARRAY_1=value3
`)
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["ARRAY"])))
      await assertSuccess(provider, ["ARRAY"], ConfigProvider.makeArray(2, "value1"))
      await assertSuccess(provider, ["ARRAY", 0], ConfigProvider.makeValue("value2"))
      await assertSuccess(provider, ["ARRAY", 1], ConfigProvider.makeValue("value3"))
    })

    it("arrays are supported", async () => {
      const provider = ConfigProvider.fromDotEnvContents(`
ARRAY_0=value1
ARRAY_1=value2
`)
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["ARRAY"])))
      await assertSuccess(provider, ["ARRAY"], ConfigProvider.makeArray(2))
      await assertSuccess(provider, ["ARRAY", 0], ConfigProvider.makeValue("value1"))
      await assertSuccess(provider, ["ARRAY", 1], ConfigProvider.makeValue("value2"))
    })

    it("expansion of environment variables is off by default", async () => {
      const provider = ConfigProvider.fromDotEnvContents(`
PASSWORD="value"
DB_PASS=$PASSWORD
`)
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["PASSWORD", "DB"])))
      await assertSuccess(provider, ["PASSWORD"], ConfigProvider.makeValue("value"))
      await assertSuccess(provider, ["DB_PASS"], ConfigProvider.makeValue("$PASSWORD"))
    })

    it("expansion of environment variables is supported", async () => {
      const provider = ConfigProvider.fromDotEnvContents(
        `
PASSWORD="value"
DB_PASS=$PASSWORD
`,
        { expandVariables: true }
      )
      await assertSuccess(provider, [], ConfigProvider.makeRecord(new Set(["PASSWORD", "DB"])))
      await assertSuccess(provider, ["PASSWORD"], ConfigProvider.makeValue("value"))
      await assertSuccess(provider, ["DB_PASS"], ConfigProvider.makeValue("value"))
    })
  })

  describe("fromDotEnv", () => {
    it("should load configuration from .env file", async () => {
      const provider = await Effect.runPromise(
        ConfigProvider.fromDotEnv().pipe(
          Effect.provide(FileSystem.layerNoop({
            readFileString: (path) =>
              Effect.succeed(`PATH=${path}
A=1`)
          }))
        )
      )

      await assertSuccess(provider, ["PATH"], ConfigProvider.makeValue(".env"))
      await assertSuccess(provider, ["A"], ConfigProvider.makeValue("1"))
    })

    it("should support `path` option to specify the path to the .env file", async () => {
      const provider = await Effect.runPromise(
        ConfigProvider.fromDotEnv({ path: "custom.env" }).pipe(
          Effect.provide(FileSystem.layerNoop({
            readFileString: (path) =>
              Effect.succeed(`CUSTOM_PATH=${path}
A=1`)
          }))
        )
      )

      await assertSuccess(provider, ["CUSTOM_PATH"], ConfigProvider.makeValue("custom.env"))
      await assertSuccess(provider, ["A"], ConfigProvider.makeValue("1"))
    })
  })

  describe("fromDir", () => {
    const provider = ConfigProvider.fromDir({ rootPath: "/" })
    const files: Record<string, string> = {
      "/secret": "keepitsafe\n", // test trimming
      "/SHOUTING": "value",
      "/integer": "123",
      "/nested/config": "hello"
    }
    const Fs = FileSystem.layerNoop({
      readFileString(path) {
        if (path in files) {
          return Effect.succeed(files[path])
        }
        return Effect.fail(
          PlatformError.systemError({
            module: "FileSystem",
            _tag: "NotFound",
            method: "readFileString"
          })
        )
      },
      readDirectory(_path) {
        // For the test, we only have files, no directories
        return Effect.fail(
          PlatformError.systemError({
            module: "FileSystem",
            _tag: "NotFound",
            method: "readDirectory"
          })
        )
      }
    })
    const Platform = Layer.mergeAll(Fs, Path.layer)
    const SetLayer = ConfigProvider.layer(provider).pipe(
      Layer.provide(Platform),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
        env: { secret: "fail" }
      })))
    )
    const AddLayer = ConfigProvider.layerAdd(provider).pipe(
      Layer.provide(Platform),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
        env: {
          secret: "shh",
          fallback: "value"
        }
      })))
    )

    it("reads config", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const provider = yield* ConfigProvider.ConfigProvider
          const secret = yield* provider.load(["secret"])
          const shouting = yield* provider.load(["SHOUTING"])
          const integer = yield* provider.load(["integer"])
          const nestedConfig = yield* provider.load(["nested", "config"])

          return { secret, shouting, integer, nestedConfig }
        }).pipe(Effect.provide(SetLayer))
      )

      deepStrictEqual(result.secret, ConfigProvider.makeValue("keepitsafe"))
      deepStrictEqual(result.shouting, ConfigProvider.makeValue("value"))
      deepStrictEqual(result.integer, ConfigProvider.makeValue("123"))
      deepStrictEqual(result.nestedConfig, ConfigProvider.makeValue("hello"))

      // Test that non-existent path throws an error
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function*() {
            const provider = yield* ConfigProvider.ConfigProvider
            yield* provider.load(["fallback"])
          }).pipe(Effect.provide(SetLayer))
        )
      )

      deepStrictEqual(error.message, "Failed to read file at /fallback")
    })

    it("layerAdd uses fallback", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const provider = yield* ConfigProvider.ConfigProvider
          const secret = yield* provider.load(["secret"])
          const integer = yield* provider.load(["integer"])
          const fallback = yield* provider.load(["fallback"])

          return { secret, integer, fallback }
        }).pipe(Effect.provide(AddLayer))
      )

      deepStrictEqual(result.secret, ConfigProvider.makeValue("shh"))
      deepStrictEqual(result.integer, ConfigProvider.makeValue("123"))
      deepStrictEqual(result.fallback, ConfigProvider.makeValue("value"))
    })
  })
})
