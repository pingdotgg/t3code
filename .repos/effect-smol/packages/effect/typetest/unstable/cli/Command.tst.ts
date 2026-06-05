import { Effect } from "effect"
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli"
import { describe, expect, it } from "tstyche"

describe("Command", () => {
  describe("withSharedFlags", () => {
    it("adds shared flags to command input and parent context", () => {
      const root = Command.make("root", {
        workspace: Flag.string("workspace")
      }).pipe(
        Command.withSharedFlags({
          verbose: Flag.boolean("verbose")
        }),
        Command.withHandler((config) => {
          expect(config).type.toBe<{ readonly workspace: string; readonly verbose: boolean }>()
          return Effect.void
        })
      )

      expect(root).type.toBe<
        Command.Command<
          "root",
          { readonly workspace: string; readonly verbose: boolean },
          { readonly verbose: boolean },
          never,
          never
        >
      >()
    })

    it("does not expose local config through yield* parent", () => {
      const root = Command.make("root", {
        workspace: Flag.string("workspace")
      }).pipe(
        Command.withSharedFlags({
          verbose: Flag.boolean("verbose")
        })
      )

      const child = Command.make("child", {}, () =>
        Effect.gen(function*() {
          const parent = yield* root
          expect(parent).type.toBe<{ readonly verbose: boolean }>()
          expect(parent).type.not.toHaveProperty("workspace")
          return
        }))

      root.pipe(Command.withSubcommands([child]))
    })

    it("widens input after withSubcommands for input-based combinators", () => {
      const root = Command.make("root", {
        local: Flag.string("local")
      }).pipe(
        Command.withSharedFlags({
          verbose: Flag.boolean("verbose")
        })
      )

      const child = Command.make("child")

      root.pipe(
        Command.withSubcommands([child]),
        Command.provideEffectDiscard((input) => {
          expect(input).type.toBe<
            | { readonly local: string; readonly verbose: boolean }
            | { readonly verbose: boolean }
          >()
          expect(input.verbose).type.toBe<boolean>()
          expect(input).type.not.toHaveProperty("local")
          return Effect.void
        })
      )
    })

    it("accepts only flags", () => {
      Command.make("root").pipe(
        // @ts-expect-error Type 'Argument<string>' is not assignable
        Command.withSharedFlags({ file: Argument.string("file") })
      )
    })
  })

  describe("withGlobalFlags", () => {
    it("strips setting context from mixed global flags", () => {
      const VerboseAction = GlobalFlag.action({
        flag: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
        run: () => Effect.void
      })
      const Format = GlobalFlag.setting("format")({
        flag: Flag.string("format").pipe(Flag.withDefault("text"))
      })

      const command = Command.make("example", {}, () =>
        Effect.gen(function*() {
          yield* Format
        })).pipe(
          Command.withGlobalFlags([VerboseAction, Format])
        )

      expect(command).type.toBe<Command.Command<"example", {}, {}, never, never>>()
    })

    it("strips setting context in data-first form", () => {
      const VerboseAction = GlobalFlag.action({
        flag: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
        run: () => Effect.void
      })
      const Format = GlobalFlag.setting("format")({
        flag: Flag.string("format").pipe(Flag.withDefault("text"))
      })

      const command = Command.withGlobalFlags(
        Command.make("example", {}, () =>
          Effect.gen(function*() {
            yield* Format
          })),
        [VerboseAction, Format]
      )

      expect(command).type.toBe<Command.Command<"example", {}, {}, never, never>>()
    })
  })
})
