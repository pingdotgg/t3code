import { assert, describe, it } from "@effect/vitest"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { fromCommand } from "effect/unstable/cli/internal/completions/descriptor"

describe("CommandDescriptor", () => {
  describe("fromCommand", () => {
    it("extracts command name and description", () => {
      const cmd = Command.make("deploy").pipe(
        Command.withDescription("Deploy the application")
      )
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.name, "deploy")
      assert.strictEqual(desc.description, "Deploy the application")
    })

    it("extracts string flags with aliases", () => {
      const cmd = Command.make("test", {
        output: Flag.string("output").pipe(
          Flag.withAlias("o"),
          Flag.withDescription("Output directory")
        )
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.flags.length, 1)
      assert.strictEqual(desc.flags[0].name, "output")
      assert.deepStrictEqual(desc.flags[0].aliases, ["o"])
      assert.strictEqual(desc.flags[0].description, "Output directory")
      assert.strictEqual(desc.flags[0].type._tag, "String")
    })

    it("extracts boolean flags", () => {
      const cmd = Command.make("test", {
        verbose: Flag.boolean("verbose").pipe(Flag.withAlias("v"))
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.flags.length, 1)
      assert.strictEqual(desc.flags[0].name, "verbose")
      assert.strictEqual(desc.flags[0].type._tag, "Boolean")
      assert.deepStrictEqual(desc.flags[0].aliases, ["v"])
    })

    it("extracts integer and float flags", () => {
      const cmd = Command.make("test", {
        port: Flag.integer("port"),
        ratio: Flag.float("ratio")
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.flags.length, 2)
      const portFlag = desc.flags.find((f) => f.name === "port")!
      const ratioFlag = desc.flags.find((f) => f.name === "ratio")!
      assert.strictEqual(portFlag.type._tag, "Integer")
      assert.strictEqual(ratioFlag.type._tag, "Float")
    })

    it("extracts file, directory, and path flags", () => {
      const cmd = Command.make("test", {
        input: Flag.file("input"),
        outDir: Flag.directory("out-dir"),
        config: Flag.path("config", { pathType: "either" })
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.flags.length, 3)
      const inputFlag = desc.flags.find((f) => f.name === "input")!
      const outDirFlag = desc.flags.find((f) => f.name === "out-dir")!
      const configFlag = desc.flags.find((f) => f.name === "config")!
      assert.deepStrictEqual(inputFlag.type, { _tag: "Path", pathType: "file" })
      assert.deepStrictEqual(outDirFlag.type, { _tag: "Path", pathType: "directory" })
      assert.deepStrictEqual(configFlag.type, { _tag: "Path", pathType: "either" })
    })

    it("extracts choice flags with values", () => {
      const cmd = Command.make("test", {
        color: Flag.choice("color", ["red", "green", "blue"])
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.flags.length, 1)
      assert.deepStrictEqual(desc.flags[0].type, {
        _tag: "Choice",
        values: ["red", "green", "blue"]
      })
    })

    it("extracts optional flags", () => {
      const cmd = Command.make("test", {
        name: Flag.string("name").pipe(Flag.optional)
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.flags.length, 1)
      assert.strictEqual(desc.flags[0].name, "name")
      assert.strictEqual(desc.flags[0].type._tag, "String")
    })

    it("extracts positional arguments with types", () => {
      const cmd = Command.make("test", {
        name: Argument.string("name"),
        count: Argument.integer("count")
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.arguments.length, 2)
      const nameArg = desc.arguments.find((a) => a.name === "name")!
      const countArg = desc.arguments.find((a) => a.name === "count")!
      assert.strictEqual(nameArg.type._tag, "String")
      assert.strictEqual(countArg.type._tag, "Integer")
      assert.strictEqual(nameArg.required, true)
      assert.strictEqual(countArg.required, true)
    })

    it("extracts variadic arguments", () => {
      const cmd = Command.make("test", {
        files: Argument.string("files").pipe(Argument.variadic({ min: 1 }))
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.arguments.length, 1)
      assert.strictEqual(desc.arguments[0].name, "files")
      assert.strictEqual(desc.arguments[0].variadic, true)
      assert.strictEqual(desc.arguments[0].required, true)
    })

    it("extracts optional arguments", () => {
      const cmd = Command.make("test", {
        email: Argument.string("email").pipe(Argument.optional)
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.arguments.length, 1)
      assert.strictEqual(desc.arguments[0].name, "email")
      assert.strictEqual(desc.arguments[0].required, false)
    })

    it("extracts nested subcommands recursively", () => {
      const leaf = Command.make("leaf").pipe(
        Command.withDescription("A leaf command")
      )
      const mid = Command.make("mid").pipe(
        Command.withSubcommands([leaf])
      )
      const root = Command.make("root").pipe(
        Command.withSubcommands([mid])
      )
      const desc = fromCommand(root)
      assert.strictEqual(desc.subcommands.length, 1)
      assert.strictEqual(desc.subcommands[0].name, "mid")
      assert.strictEqual(desc.subcommands[0].subcommands.length, 1)
      assert.strictEqual(desc.subcommands[0].subcommands[0].name, "leaf")
      assert.strictEqual(desc.subcommands[0].subcommands[0].description, "A leaf command")
    })

    it("extracts descriptions from flags and arguments", () => {
      const cmd = Command.make("test", {
        port: Flag.integer("port").pipe(
          Flag.withDescription("Port number")
        ),
        host: Argument.string("host").pipe(
          Argument.withDescription("Hostname")
        )
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.flags[0].description, "Port number")
      assert.strictEqual(desc.arguments[0].description, "Hostname")
    })

    it("handles commands with no flags or arguments", () => {
      const cmd = Command.make("noop")
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.name, "noop")
      assert.strictEqual(desc.flags.length, 0)
      assert.strictEqual(desc.arguments.length, 0)
      assert.strictEqual(desc.subcommands.length, 0)
    })

    it("handles deeply nested command trees", () => {
      const level3 = Command.make("level3", {
        flag: Flag.boolean("deep")
      })
      const level2 = Command.make("level2").pipe(
        Command.withSubcommands([level3])
      )
      const level1 = Command.make("level1").pipe(
        Command.withSubcommands([level2])
      )
      const root = Command.make("root").pipe(
        Command.withSubcommands([level1])
      )
      const desc = fromCommand(root)
      const deepCmd = desc.subcommands[0].subcommands[0].subcommands[0]
      assert.strictEqual(deepCmd.name, "level3")
      assert.strictEqual(deepCmd.flags.length, 1)
      assert.strictEqual(deepCmd.flags[0].name, "deep")
      assert.strictEqual(deepCmd.flags[0].type._tag, "Boolean")
    })

    it("extracts choice arguments", () => {
      const cmd = Command.make("test", {
        env: Argument.choice("env", ["dev", "staging", "prod"])
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.arguments.length, 1)
      assert.deepStrictEqual(desc.arguments[0].type, {
        _tag: "Choice",
        values: ["dev", "staging", "prod"]
      })
    })

    it("extracts file/directory arguments", () => {
      const cmd = Command.make("test", {
        input: Argument.file("input", { mustExist: false }),
        outDir: Argument.directory("output", { mustExist: false })
      })
      const desc = fromCommand(cmd)
      assert.strictEqual(desc.arguments.length, 2)
      const inputArg = desc.arguments.find((a) => a.name === "input")!
      const outputArg = desc.arguments.find((a) => a.name === "output")!
      assert.deepStrictEqual(inputArg.type, { _tag: "Path", pathType: "file" })
      assert.deepStrictEqual(outputArg.type, { _tag: "Path", pathType: "directory" })
    })

    it("extracts multiple subcommands", () => {
      const a = Command.make("alpha").pipe(Command.withDescription("First"))
      const b = Command.make("beta").pipe(Command.withDescription("Second"))
      const c = Command.make("gamma").pipe(Command.withDescription("Third"))
      const root = Command.make("root").pipe(
        Command.withSubcommands([a, b, c])
      )
      const desc = fromCommand(root)
      assert.strictEqual(desc.subcommands.length, 3)
      assert.strictEqual(desc.subcommands[0].name, "alpha")
      assert.strictEqual(desc.subcommands[1].name, "beta")
      assert.strictEqual(desc.subcommands[2].name, "gamma")
    })

    it("prefers short descriptions for subcommand listings", () => {
      const build = Command.make("build").pipe(
        Command.withDescription("Build the project and all artifacts"),
        Command.withShortDescription("Build artifacts")
      )
      const test = Command.make("test").pipe(
        Command.withDescription("Run the full test suite")
      )
      const root = Command.make("root").pipe(Command.withSubcommands([build, test]))

      const desc = fromCommand(root)
      assert.strictEqual(desc.subcommands[0].description, "Build artifacts")
      assert.strictEqual(desc.subcommands[1].description, "Run the full test suite")
    })
  })
})
