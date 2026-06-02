import { assert, describe, it } from "@effect/vitest"
import { Config, ConfigProvider, Effect, FileSystem, Layer, Option, Path, Ref } from "effect"
import { TestConsole } from "effect/testing"
import { Argument, CliError, Flag, Prompt } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as MockTerminal from "./services/MockTerminal.ts"

const ConsoleLayer = TestConsole.layer
const FileSystemLayer = FileSystem.layerNoop({})
const PathLayer = Path.layer
const TerminalLayer = MockTerminal.layer

const TestLayer = Layer.mergeAll(
  ConsoleLayer,
  FileSystemLayer,
  PathLayer,
  TerminalLayer,
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.die("Not implemented")))
)

describe("Param", () => {
  describe("optional", () => {
    it.effect("returns none when an optional boolean flag is omitted", () =>
      Effect.gen(function*() {
        const flag = Flag.boolean("verbose").pipe(Flag.optional)

        const [, value] = yield* flag.parse({
          flags: {},
          arguments: []
        })

        assert.deepStrictEqual(value, Option.none())
      }).pipe(Effect.provide(TestLayer)))

    it.effect("returns some when an optional boolean flag is provided", () =>
      Effect.gen(function*() {
        const flag = Flag.boolean("verbose").pipe(Flag.optional)

        const [, value] = yield* flag.parse({
          flags: { verbose: ["false"] },
          arguments: []
        })

        assert.deepStrictEqual(value, Option.some(false))
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("withFallbackPrompt", () => {
    it.effect("prompts for missing flag values and preserves remaining args", () =>
      Effect.gen(function*() {
        const prompt = Prompt.text({ message: "Name" })
        const flag = Flag.string("name").pipe(Flag.withFallbackPrompt(prompt))

        yield* MockTerminal.inputText("Chandra")
        yield* MockTerminal.inputKey("enter")

        const [remaining, value] = yield* flag.parse({
          flags: {},
          arguments: ["tail"]
        })

        assert.strictEqual(value, "Chandra")
        assert.deepStrictEqual(remaining, ["tail"])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("does not prompt when flag value is provided", () =>
      Effect.gen(function*() {
        const prompt = Prompt.text({ message: "Name" })
        const flag = Flag.string("name").pipe(Flag.withFallbackPrompt(prompt))

        const [, value] = yield* flag.parse({
          flags: { name: ["Ava"] },
          arguments: []
        })

        assert.strictEqual(value, "Ava")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("prompts for missing arguments", () =>
      Effect.gen(function*() {
        const prompt = Prompt.text({ message: "File" })
        const argument = Argument.string("file").pipe(Argument.withFallbackPrompt(prompt))

        yield* MockTerminal.inputText("notes.txt")
        yield* MockTerminal.inputKey("enter")

        const [remaining, value] = yield* argument.parse({
          flags: {},
          arguments: []
        })

        assert.strictEqual(value, "notes.txt")
        assert.deepStrictEqual(remaining, [])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("builds flag fallback prompts from effects lazily", () =>
      Effect.gen(function*() {
        const calls = yield* Ref.make(0)
        const prompt = Effect.gen(function*() {
          yield* Ref.update(calls, (n) => n + 1)
          return Prompt.text({ message: "Name from effect" })
        })

        const flag = Flag.string("name").pipe(Flag.withFallbackPrompt(prompt))

        const [, provided] = yield* flag.parse({
          flags: { name: ["Ava"] },
          arguments: []
        })
        assert.strictEqual(provided, "Ava")
        assert.strictEqual(yield* Ref.get(calls), 0)

        yield* MockTerminal.inputText("Mia")
        yield* MockTerminal.inputKey("enter")

        const [remaining, prompted] = yield* flag.parse({
          flags: {},
          arguments: ["tail"]
        })

        assert.strictEqual(prompted, "Mia")
        assert.deepStrictEqual(remaining, ["tail"])
        assert.strictEqual(yield* Ref.get(calls), 1)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("builds argument fallback prompts from effects lazily", () =>
      Effect.gen(function*() {
        const calls = yield* Ref.make(0)
        const prompt = Effect.gen(function*() {
          yield* Ref.update(calls, (n) => n + 1)
          return Prompt.text({ message: "File from effect" })
        })

        const argument = Argument.string("file").pipe(Argument.withFallbackPrompt(prompt))

        const [providedRemaining, provided] = yield* argument.parse({
          flags: {},
          arguments: ["notes.txt", "tail"]
        })
        assert.strictEqual(provided, "notes.txt")
        assert.deepStrictEqual(providedRemaining, ["tail"])
        assert.strictEqual(yield* Ref.get(calls), 0)

        yield* MockTerminal.inputText("draft.md")
        yield* MockTerminal.inputKey("enter")

        const [promptedRemaining, prompted] = yield* argument.parse({
          flags: {},
          arguments: []
        })

        assert.strictEqual(prompted, "draft.md")
        assert.deepStrictEqual(promptedRemaining, [])
        assert.strictEqual(yield* Ref.get(calls), 1)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("propagates errors from effectful fallback prompt creation", () =>
      Effect.gen(function*() {
        const failure = new CliError.UserError({
          cause: "failed to build prompt"
        })
        const prompt = Effect.fail(failure)

        const flag = Flag.string("name").pipe(Flag.withFallbackPrompt(prompt))

        const error = yield* Effect.flip(
          flag.parse({
            flags: {},
            arguments: []
          })
        )

        assert.strictEqual(error, failure)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("prefers defaults over fallback prompts", () =>
      Effect.gen(function*() {
        const prompt = Prompt.text({ message: "Name" })
        const flag = Flag.string("name").pipe(
          Flag.withDefault("guest"),
          Flag.withFallbackPrompt(prompt)
        )

        const [, value] = yield* flag.parse({
          flags: {},
          arguments: []
        })

        assert.strictEqual(value, "guest")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("does not prompt for invalid flag values", () =>
      Effect.gen(function*() {
        const prompt = Prompt.text({ message: "Count" })
        const flag = Flag.integer("count").pipe(Flag.withFallbackPrompt(prompt))

        const error = yield* Effect.flip(
          flag.parse({
            flags: { count: ["nope"] },
            arguments: []
          })
        )

        assert.instanceOf(error, CliError.InvalidValue)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("does not prompt for invalid argument values", () =>
      Effect.gen(function*() {
        const prompt = Prompt.text({ message: "Count" })
        const argument = Argument.integer("count").pipe(Argument.withFallbackPrompt(prompt))

        const error = yield* Effect.flip(
          argument.parse({
            flags: {},
            arguments: ["nope"]
          })
        )

        assert.instanceOf(error, CliError.InvalidValue)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("does not prompt for missing boolean flags", () =>
      Effect.gen(function*() {
        const prompt = Prompt.text({ message: "Verbose" })
        const flag = Flag.boolean("verbose").pipe(Flag.withFallbackPrompt(prompt))

        const [, value] = yield* flag.parse({
          flags: {},
          arguments: []
        })

        assert.strictEqual(value, false)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("returns MissingOption when prompt is cancelled", () =>
      Effect.gen(function*() {
        const prompt = Prompt.text({ message: "Name" })
        const flag = Flag.string("name").pipe(Flag.withFallbackPrompt(prompt))

        yield* MockTerminal.inputKey("c", { ctrl: true })

        const error = yield* Effect.flip(
          flag.parse({
            flags: {},
            arguments: []
          })
        )

        assert.instanceOf(error, CliError.MissingOption)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("returns MissingArgument when argument prompt is cancelled", () =>
      Effect.gen(function*() {
        const prompt = Prompt.text({ message: "File" })
        const argument = Argument.string("file").pipe(Argument.withFallbackPrompt(prompt))

        yield* MockTerminal.inputKey("c", { ctrl: true })

        const error = yield* Effect.flip(
          argument.parse({
            flags: {},
            arguments: []
          })
        )

        assert.instanceOf(error, CliError.MissingArgument)
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("withFallbackConfig", () => {
    it.effect("uses ConfigProvider when a flag is missing", () => {
      const provider = ConfigProvider.fromEnv({
        env: {
          NAME: "Ava"
        }
      })

      return Effect.gen(function*() {
        const flag = Flag.string("name").pipe(
          Flag.withFallbackConfig(Config.string("NAME"))
        )

        const [, value] = yield* flag.parse({
          flags: {},
          arguments: []
        })

        assert.strictEqual(value, "Ava")
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
        Effect.provide(TestLayer)
      )
    })

    it.effect("uses flag values before reading config fallbacks", () => {
      const provider = ConfigProvider.fromEnv({
        env: {
          NAME: "Ava"
        }
      })

      return Effect.gen(function*() {
        const flag = Flag.string("name").pipe(
          Flag.withFallbackConfig(Config.string("NAME"))
        )

        const [, value] = yield* flag.parse({
          flags: { name: ["Maya"] },
          arguments: []
        })

        assert.strictEqual(value, "Maya")
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
        Effect.provide(TestLayer)
      )
    })

    it.effect("uses ConfigProvider when an argument is missing", () => {
      const provider = ConfigProvider.fromEnv({
        env: {
          REPOSITORY: "repo"
        }
      })

      return Effect.gen(function*() {
        const argument = Argument.string("repository").pipe(
          Argument.withFallbackConfig(Config.string("REPOSITORY"))
        )

        const [, value] = yield* argument.parse({
          flags: {},
          arguments: []
        })

        assert.strictEqual(value, "repo")
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
        Effect.provide(TestLayer)
      )
    })

    it.effect("returns MissingOption when config is missing", () => {
      const provider = ConfigProvider.fromEnv({ env: {} })

      return Effect.gen(function*() {
        const flag = Flag.string("name").pipe(
          Flag.withFallbackConfig(Config.string("NAME"))
        )

        const error = yield* Effect.flip(
          flag.parse({
            flags: {},
            arguments: []
          })
        )

        assert.instanceOf(error, CliError.MissingOption)
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
        Effect.provide(TestLayer)
      )
    })

    it.effect("returns InvalidValue when config fails to parse", () => {
      const provider = ConfigProvider.fromEnv({
        env: {
          COUNT: "nope"
        }
      })

      return Effect.gen(function*() {
        const flag = Flag.integer("count").pipe(
          Flag.withFallbackConfig(Config.int("COUNT"))
        )

        const error = yield* Effect.flip(
          flag.parse({
            flags: {},
            arguments: []
          })
        )

        assert.instanceOf(error, CliError.InvalidValue)
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
        Effect.provide(TestLayer)
      )
    })
  })
})
