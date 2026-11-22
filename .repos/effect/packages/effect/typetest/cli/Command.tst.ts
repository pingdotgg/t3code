import { Context, Effect } from "effect"
import type { CliError } from "effect/cli"
import { Argument, Command, Flag, GlobalFlag } from "effect/cli"
import { describe, expect, it } from "tstyche"

describe("Command", () => {
  it("make validates symbol fields in nested configurations and accepts object type aliases", () => {
    const key = Symbol()
    type Nested = {
      [key]: Flag.Flag<string>
    }
    type Fields = {
      nested: Nested
      tuple: readonly [Flag.Flag<number>, Nested]
    }
    const nested: Nested = { [key]: Flag.String("name") }
    const fields: Fields = { nested, tuple: [Flag.Int("count"), nested] }
    expect(Command.make("example", fields)).type.toBe<
      Command.Command<
        "example",
        { readonly nested: { readonly [key]: string }; readonly tuple: readonly [number, { readonly [key]: string }] }
      >
    >()
    Command.make("example", fields, (input) => {
      expect(input.nested[key]).type.toBe<string>()
      expect(input.tuple[0]).type.toBe<number>()
      return Effect.void
    })
    type IndexedFields = {
      [key: string]: Flag.Flag<string>
    }
    const indexed: IndexedFields = { name: Flag.String("name") }
    expect(Command.make).type.toBeCallableWith("example", indexed)
    expect(Command.make).type.not.toBeCallableWith("example", { [key]: 42 })
    expect(Command.make).type.not.toBeCallableWith("example", 42)
    expect(Command.make).type.not.toBeCallableWith("example", "value")
    expect(Command.make).type.not.toBeCallableWith("example", [Flag.String("name")])
    expect(Command.make).type.not.toBeCallableWith("example", { nested: { [key]: 42 } })
    expect(Command.make).type.not.toBeCallableWith("example", { nested: [{ [key]: 42 }] })
    expect(Command.make).type.not.toBeCallableWith("example", { [key]: 42 }, () => Effect.void)
  })

  describe("validate", () => {
    it("receives the parsed input and preserves the command type", () => {
      const command = Command.make("download", {
        useApi: Flag.Boolean("use-api"),
        useDocker: Flag.Boolean("use-docker")
      }, () => Effect.void as Effect.Effect<void, "err">).pipe(
        Command.validate((input) => {
          expect(input).type.toBe<{ readonly useApi: boolean; readonly useDocker: boolean }>()
          return Effect.void
        })
      )

      expect(command).type.toBe<
        Command.Command<
          "download",
          { readonly useApi: boolean; readonly useDocker: boolean },
          {},
          "err",
          never
        >
      >()
    })

    it("adds the validation's own error type to the command", () => {
      const command = Command.make("download", {
        useApi: Flag.Boolean("use-api")
      }, () => Effect.void as Effect.Effect<void, "err">).pipe(
        Command.validate(() => Effect.void as Effect.Effect<void, "conflict" | CliError.ValidationError>)
      )

      expect(command).type.toBe<
        Command.Command<"download", { readonly useApi: boolean }, {}, "err" | "conflict", never>
      >()
    })

    it("accepts an explicit input type argument without adding errors", () => {
      const command = Command.make("download", {
        useApi: Flag.Boolean("use-api")
      }, () => Effect.void as Effect.Effect<void, "err">).pipe(
        Command.validate<{ readonly useApi: boolean }>(() => Effect.void)
      )

      expect(command).type.toBe<Command.Command<"download", { readonly useApi: boolean }, {}, "err", never>>()
    })

    it("keeps the validation's error type through withHandler and provideSync", () => {
      class Api extends Context.Service<Api, string>()("Api") {}
      const command = Command.make("download", {
        useApi: Flag.Boolean("use-api")
      }).pipe(
        Command.validate(() => Effect.void as Effect.Effect<void, "conflict">),
        Command.withHandler(() => Effect.void as Effect.Effect<void, "err", Api>),
        Command.provideSync(Api, () => "api")
      )

      expect(command).type.toBe<
        Command.Command<"download", { readonly useApi: boolean }, {}, "conflict" | "err", never>
      >()
    })
  })

  describe("withSubcommands", () => {
    it("unions errors and requirements across multiple subcommands", () => {
      class _ServiceA extends Context.Service<_ServiceA, string>()("ServiceA") {}
      class _ServiceB extends Context.Service<_ServiceB, string>()("ServiceB") {}
      class _ServiceC extends Context.Service<_ServiceC, string>()("ServiceC") {}

      const childA = Command.make("child-a", {}, () => Effect.void as Effect.Effect<void, "err-a", _ServiceA>)
      const childB = Command.make("child-b", {}, () => Effect.void as Effect.Effect<void, "err-b", _ServiceB>)
      const childC = Command.make("child-c", {}, () => Effect.void as Effect.Effect<void, "err-c", _ServiceC>)

      const root = Command.make("root").pipe(
        Command.withSubcommands([childA, childB, childC])
      )

      expect(root).type.toBe<
        Command.Command<"root", {}, {}, "err-a" | "err-b" | "err-c", _ServiceA | _ServiceB | _ServiceC>
      >()
    })
  })

  describe("withSharedFlags", () => {
    it("validates symbol fields and nested flags in both call styles", () => {
      const key = Symbol()
      type Fields = {
        [key]: Flag.Flag<string>
      }
      const fields: Fields = { [key]: Flag.String("name") }
      const root = Command.make("root")
      expect(Command.withSharedFlags(root, fields)).type.toBe<
        Command.Command<"root", { readonly [key]: string }, { readonly [key]: string }>
      >()
      expect(root.pipe(Command.withSharedFlags({ nested: [fields] }))).type.toBe<
        Command.Command<
          "root",
          { readonly nested: readonly [{ readonly [key]: string }] },
          { readonly nested: readonly [{ readonly [key]: string }] }
        >
      >()
      expect(Command.withSharedFlags).type.not.toBeCallableWith({ [key]: 42 })
      expect(Command.withSharedFlags).type.not.toBeCallableWith(42)
      expect(Command.withSharedFlags).type.not.toBeCallableWith("value")
      expect(Command.withSharedFlags).type.not.toBeCallableWith([Flag.String("name")])
      expect(Command.withSharedFlags).type.not.toBeCallableWith(root, { [key]: 42 })
      expect(Command.withSharedFlags).type.not.toBeCallableWith({ [key]: Argument.String("file") })
      expect(Command.withSharedFlags).type.not.toBeCallableWith(root, { [key]: Argument.String("file") })
      expect(Command.withSharedFlags).type.not.toBeCallableWith({ nested: [{ [key]: Argument.String("file") }] })
      expect(Command.withSharedFlags).type.not.toBeCallableWith(root, { nested: { [key]: Argument.String("file") } })
    })

    it("adds shared flags to command input and parent context", () => {
      const root = Command.make("root", {
        workspace: Flag.String("workspace")
      }).pipe(
        Command.withSharedFlags({
          verbose: Flag.Boolean("verbose")
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
        workspace: Flag.String("workspace")
      }).pipe(
        Command.withSharedFlags({
          verbose: Flag.Boolean("verbose")
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
        local: Flag.String("local")
      }).pipe(
        Command.withSharedFlags({
          verbose: Flag.Boolean("verbose")
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
        Command.withSharedFlags({ file: Argument.String("file") })
      )
    })
  })

  describe("withGlobalFlags", () => {
    it("strips setting context from mixed global flags", () => {
      const VerboseAction = GlobalFlag.Action({
        flag: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
        run: () => Effect.void
      })
      const Format = GlobalFlag.Setting("format")({
        flag: Flag.String("format").pipe(Flag.withDefault("text"))
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
      const VerboseAction = GlobalFlag.Action({
        flag: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
        run: () => Effect.void
      })
      const Format = GlobalFlag.Setting("format")({
        flag: Flag.String("format").pipe(Flag.withDefault("text"))
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

  describe("built-in global flags", () => {
    it("strips built-in setting context from Command.make handlers", () => {
      const command = Command.make("example", {}, () =>
        Effect.gen(function*() {
          yield* GlobalFlag.LogLevel
        }))

      expect(command).type.toBe<Command.Command<"example", {}, {}, never, never>>()
    })

    it("strips built-in setting context from Command.withHandler handlers", () => {
      const command = Command.make("example").pipe(
        Command.withHandler(() =>
          Effect.gen(function*() {
            yield* GlobalFlag.LogLevel
          })
        )
      )

      expect(command).type.toBe<Command.Command<"example", {}, {}, never, never>>()
    })
  })
})
