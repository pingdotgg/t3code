// @effect-diagnostics floatingEffect:skip-file
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Stdio } from "effect"
import { CliError, CliOutput, Command, Flag } from "effect/unstable/cli"
import { toImpl } from "effect/unstable/cli/internal/command"
import * as Lexer from "effect/unstable/cli/internal/lexer"
import * as Parser from "effect/unstable/cli/internal/parser"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as MockTerminal from "./services/MockTerminal.ts"

const FileSystemLayer = FileSystem.layerNoop({})
const PathLayer = Path.layer
const TerminalLayer = MockTerminal.layer
const SpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("Not implemented"))
)

const TestLayer = Layer.mergeAll(
  FileSystemLayer,
  PathLayer,
  TerminalLayer,
  SpawnerLayer,
  Stdio.layerTest({})
)

describe("Command errors", () => {
  describe("parse", () => {
    it.effect("fails with MissingOption when a required flag is absent", () =>
      Effect.gen(function*() {
        const command = Command.make("needs-value", {
          value: Flag.string("value")
        })

        const parsedInput = yield* Parser.parseArgs(Lexer.lex([]), command)
        const error = yield* Effect.flip(toImpl(command).parse(parsedInput))
        assert.instanceOf(error, CliError.MissingOption)
        assert.strictEqual(error.option, "value")
      }).pipe(Effect.provide(TestLayer)))

    it("throws DuplicateOption when shared parent and child flags reuse a name", () => {
      const parent = Command.make("parent").pipe(
        Command.withSharedFlags({
          shared: Flag.string("shared")
        })
      )

      const child = Command.make("child", {
        shared: Flag.string("shared")
      })

      try {
        parent.pipe(Command.withSubcommands([child]))
        assert.fail("expected DuplicateOption to be thrown")
      } catch (error) {
        assert.instanceOf(error, CliError.DuplicateOption)
        const duplicate = error as CliError.DuplicateOption
        assert.strictEqual(duplicate.option, "shared")
        assert.strictEqual(duplicate.parentCommand, "parent")
        assert.strictEqual(duplicate.childCommand, "child")
      }
    })

    it("allows parent local flags to reuse child flag names", () => {
      const parent = Command.make("parent", {
        shared: Flag.string("shared")
      })

      const child = Command.make("child", {
        shared: Flag.string("shared")
      })

      try {
        parent.pipe(Command.withSubcommands([child]))
      } catch (error) {
        assert.fail(`did not expect DuplicateOption: ${String(error)}`)
      }
    })

    it.effect("accumulates multiple UnrecognizedOption errors", () =>
      Effect.gen(function*() {
        const command = Command.make("test", {
          verbose: Flag.boolean("verbose")
        })

        const parsedInput = yield* Parser.parseArgs(
          Lexer.lex(["--unknown1", "--unknown2"]),
          command
        )

        assert.isDefined(parsedInput.errors)
        assert.strictEqual(parsedInput.errors!.length, 2)
        assert.instanceOf(parsedInput.errors![0], CliError.UnrecognizedOption)
        assert.instanceOf(parsedInput.errors![1], CliError.UnrecognizedOption)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("accumulates UnknownSubcommand error with suggestions", () =>
      Effect.gen(function*() {
        const sub = Command.make("deploy")
        const command = Command.make("app").pipe(
          Command.withSubcommands([sub])
        )

        const parsedInput = yield* Parser.parseArgs(
          Lexer.lex(["deplyo"]),
          command
        )

        assert.isDefined(parsedInput.errors)
        assert.strictEqual(parsedInput.errors!.length, 1)
        assert.instanceOf(parsedInput.errors![0], CliError.UnknownSubcommand)

        const error = parsedInput.errors![0] as CliError.UnknownSubcommand
        assert.strictEqual(error.subcommand, "deplyo")
        assert.isTrue(error.suggestions.includes("deploy"))
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("formatErrors", () => {
    it("formats single error with ERROR header", () => {
      const formatter = CliOutput.defaultFormatter({ colors: false })
      const error = new CliError.MissingOption({ option: "value" })

      const output = formatter.formatErrors([error])

      assert.isTrue(output.includes("ERROR"))
      assert.isTrue(output.includes("Missing required flag"))
    })

    it("formats multiple errors with ERRORS header", () => {
      const formatter = CliOutput.defaultFormatter({ colors: false })
      const errors = [
        new CliError.UnrecognizedOption({ option: "--foo", suggestions: [] }),
        new CliError.UnrecognizedOption({ option: "--bar", suggestions: [] })
      ]

      const output = formatter.formatErrors(errors)

      assert.isTrue(output.includes("ERRORS"))
      assert.isTrue(output.includes("--foo"))
      assert.isTrue(output.includes("--bar"))
    })

    it("returns empty string for empty array", () => {
      const formatter = CliOutput.defaultFormatter({ colors: false })
      const output = formatter.formatErrors([])
      assert.strictEqual(output, "")
    })
  })
})
