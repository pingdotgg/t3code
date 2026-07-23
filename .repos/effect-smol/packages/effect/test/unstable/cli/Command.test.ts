import { assert, describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Option, Path, Stdio } from "effect"
import { TestConsole } from "effect/testing"
import { Argument, CliOutput, Command, Flag, GlobalFlag } from "effect/unstable/cli"
import { toImpl } from "effect/unstable/cli/internal/command"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Cli from "./fixtures/ComprehensiveCli.ts"
import * as MockTerminal from "./services/MockTerminal.ts"
import * as TestActions from "./services/TestActions.ts"

const ActionsLayer = TestActions.layer
const ConsoleLayer = TestConsole.layer
const FileSystemLayer = FileSystem.layerNoop({})
const PathLayer = Path.layer
const TerminalLayer = MockTerminal.layer
const CliOutputLayer = CliOutput.layer(
  CliOutput.defaultFormatter({
    colors: false
  })
)

const TestLayer = Layer.mergeAll(
  ActionsLayer,
  ConsoleLayer,
  FileSystemLayer,
  PathLayer,
  TerminalLayer,
  CliOutputLayer,
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("Not implemented"))
  ),
  Stdio.layerTest({})
)

const TestLayerWithoutFormatter = Layer.mergeAll(
  ActionsLayer,
  ConsoleLayer,
  FileSystemLayer,
  PathLayer,
  TerminalLayer,
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("Not implemented"))
  ),
  Stdio.layerTest({})
)

describe("Command", () => {
  describe("annotations", () => {
    it.effect("should expose annotations in help docs", () =>
      Effect.gen(function*() {
        const Team = Context.Service<never, string>("effect/test/unstable/cli/Team")
        const Priority = Context.Service<never, number>("effect/test/unstable/cli/Priority")
        const docs: Array<Parameters<CliOutput.Formatter["formatHelpDoc"]>[0]> = []

        const formatter: CliOutput.Formatter = {
          ...CliOutput.defaultFormatter({ colors: false }),
          formatHelpDoc: (doc) => {
            docs.push(doc)
            return ""
          }
        }

        const command = Command.make("deploy").pipe(
          Command.annotate(Team, "runtime"),
          Command.annotateMerge(Context.make(Priority, 2))
        )

        yield* Command.runWith(command, { version: "1.0.0" })(["--help"]).pipe(
          Effect.provide(TestLayerWithoutFormatter),
          Effect.provideService(CliOutput.Formatter, formatter)
        )

        assert.strictEqual(docs.length, 1)
        const annotations = docs[0].annotations
        assert.strictEqual(Context.get(annotations, Team), "runtime")
        assert.strictEqual(Context.get(annotations, Priority), 2)
      }))

    it.effect("should keep annotations when adding subcommands", () =>
      Effect.gen(function*() {
        const Scope = Context.Service<never, string>("effect/test/unstable/cli/Scope")
        const docs: Array<Parameters<CliOutput.Formatter["formatHelpDoc"]>[0]> = []

        const formatter: CliOutput.Formatter = {
          ...CliOutput.defaultFormatter({ colors: false }),
          formatHelpDoc: (doc) => {
            docs.push(doc)
            return ""
          }
        }

        const child = Command.make("child").pipe(Command.annotate(Scope, "child"))
        const command = Command.make("root").pipe(
          Command.annotate(Scope, "root"),
          Command.withSubcommands([child])
        )

        const run = Command.runWith(command, { version: "1.0.0" })

        yield* run(["--help"]).pipe(
          Effect.provide(TestLayerWithoutFormatter),
          Effect.provideService(CliOutput.Formatter, formatter)
        )

        yield* run(["child", "--help"]).pipe(
          Effect.provide(TestLayerWithoutFormatter),
          Effect.provideService(CliOutput.Formatter, formatter)
        )

        assert.strictEqual(docs.length, 2)
        assert.strictEqual(Context.get(docs[0].annotations, Scope), "root")
        assert.strictEqual(Context.get(docs[1].annotations, Scope), "child")
      }))
  })

  describe("run", () => {
    it.effect("should execute handler with parsed config", () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const resolvedSrc = path.resolve("src.txt")
        const resolvedDest = path.resolve("dest.txt")

        yield* Cli.run(["copy", "src.txt", "dest.txt", "--recursive", "--force"])

        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 1)
        assert.deepStrictEqual(actions[0], {
          command: "copy",
          details: {
            source: resolvedSrc,
            destination: resolvedDest,
            recursive: true,
            force: true,
            bufferSize: 64
          }
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should handle nested config in handler", () =>
      Effect.gen(function*() {
        const username = "john_doe"
        const email = "john@example.com"
        const role = "admin"

        yield* Cli.run(["admin", "users", "create", username, email, "--role", role, "--notify"])

        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 1)
        assert.deepStrictEqual(actions[0], {
          command: "users create",
          details: { username, email: Option.some(email), role, notify: true }
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should work with effectful handlers", () =>
      Effect.gen(function*() {
        const files = ["file1.txt", "file2.txt", "dir/"]

        yield* Cli.run(["remove", ...files, "--recursive", "--force", "--verbose"])

        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 1)
        assert.deepStrictEqual(actions[0], {
          command: "remove",
          details: {
            files,
            recursive: true,
            force: true,
            verbose: true
          }
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should work with option aliases in handler", () =>
      Effect.gen(function*() {
        const config = "build.json"
        const output = "dist/"

        yield* Cli.run(["build", "-o", output, "-v", "-f", config])

        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 1)
        assert.deepStrictEqual(actions[0], {
          command: "build",
          details: { output, verbose: true, config }
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should merge repeated key=value flags into a single record", () =>
      Effect.gen(function*() {
        const captured: Array<Record<string, string>> = []

        const command = Command.make("env", {
          env: Flag.keyValuePair("env")
        }, (config) =>
          Effect.sync(() => {
            captured.push(config.env)
          }))

        const runCommand = Command.runWith(command, {
          version: "1.0.0"
        })

        yield* runCommand([
          "--env",
          "foo=bar",
          "--env",
          "cool=dude"
        ])

        assert.deepStrictEqual(captured, [{ foo: "bar", cool: "dude" }])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should merge key=value flags even when interleaved with other options", () =>
      Effect.gen(function*() {
        const captured: Array<Record<string, unknown>> = []

        const command = Command.make("env", {
          env: Flag.keyValuePair("env"),
          verbose: Flag.boolean("verbose"),
          profile: Flag.string("profile")
        }, (config) =>
          Effect.sync(() => {
            captured.push(config)
          }))

        const runCommand = Command.runWith(command, {
          version: "1.0.0"
        })

        yield* runCommand([
          "--env",
          "foo=bar",
          "--profile",
          "dev",
          "--env",
          "cool=dude",
          "--verbose",
          "--env",
          "zip=zop"
        ])

        assert.deepStrictEqual(captured, [{
          env: { foo: "bar", cool: "dude", zip: "zop" },
          verbose: true,
          profile: "dev"
        }])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should expose setting global flags to command handlers", () =>
      Effect.gen(function*() {
        const Region = GlobalFlag.setting("region")({
          flag: Flag.string("region").pipe(Flag.optional)
        })
        const captured: Array<Option.Option<string>> = []

        const command = Command.make("deploy", {}, () =>
          Effect.gen(function*() {
            captured.push(yield* Region)
          })).pipe(
            Command.withGlobalFlags([Region])
          )

        const runCommand = Command.runWith(command, {
          version: "1.0.0"
        })

        yield* runCommand(["--region", "us-east-1"])
        yield* runCommand([])

        assert.deepStrictEqual(captured, [Option.some("us-east-1"), Option.none()])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should expose setting global flags with Flag.withDefault", () =>
      Effect.gen(function*() {
        const Region = GlobalFlag.setting("region")({
          flag: Flag.string("region").pipe(Flag.withDefault("us-west-2"))
        })
        const captured: Array<string> = []

        const command = Command.make("deploy", {}, () =>
          Effect.gen(function*() {
            captured.push(yield* Region)
          })).pipe(
            Command.withGlobalFlags([Region])
          )

        const runCommand = Command.runWith(command, {
          version: "1.0.0"
        })

        yield* runCommand(["--region", "eu-west-1"])
        yield* runCommand([])

        assert.deepStrictEqual(captured, ["eu-west-1", "us-west-2"])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should support mixed action and setting global flags", () =>
      Effect.gen(function*() {
        const actions: Array<boolean> = []
        const captured: Array<string> = []
        let handlerInvocations = 0

        const VerboseAction = GlobalFlag.action({
          flag: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
          run: (value) =>
            Effect.sync(() => {
              actions.push(value)
            })
        })
        const Format = GlobalFlag.setting("format")({
          flag: Flag.string("format").pipe(Flag.withDefault("text"))
        })

        const command = Command.make("deploy", {}, () =>
          Effect.gen(function*() {
            handlerInvocations += 1
            captured.push(yield* Format)
          })).pipe(
            Command.withGlobalFlags([VerboseAction, Format])
          )

        const runCommand = Command.runWith(command, {
          version: "1.0.0"
        })

        yield* runCommand(["--format", "json"])
        yield* runCommand(["--verbose", "--format", "yaml"])

        assert.deepStrictEqual(captured, ["json"])
        assert.deepStrictEqual(actions, [true])
        assert.strictEqual(handlerInvocations, 1)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should reject explicit values for canonical negated global flags", () =>
      Effect.gen(function*() {
        let handlerInvoked = false
        const Verbose = GlobalFlag.setting("verbose")({
          flag: Flag.boolean("verbose")
        })

        const command = Command.make("deploy", {}, () =>
          Effect.sync(() => {
            handlerInvoked = true
          })).pipe(
            Command.withGlobalFlags([Verbose])
          )

        const runCommand = Command.runWith(command, {
          version: "1.0.0"
        })

        yield* runCommand(["--no-verbose", "false"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        assert.isFalse(handlerInvoked)

        const stderr = yield* TestConsole.errorLines
        assert.isTrue(stderr.join("\n").includes("use --no-verbose by itself to set --verbose to false"))
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should expose setting global flags in Command.provide APIs", () =>
      Effect.gen(function*() {
        const Region = GlobalFlag.setting("region")({
          flag: Flag.string("region").pipe(Flag.optional)
        })
        const RegionFromProvide = Context.Service<never, Option.Option<string>>(
          "effect/test/unstable/cli/RegionFromProvide"
        )
        const capturedFromProvide: Array<Option.Option<string>> = []
        const capturedFromProvideEffect: Array<Option.Option<string>> = []

        const command = Command.make("deploy", {}, () =>
          Effect.gen(function*() {
            capturedFromProvide.push(yield* RegionFromProvide)
          })).pipe(
            Command.provide(() =>
              Layer.effect(
                RegionFromProvide,
                Effect.gen(function*() {
                  return yield* Region
                })
              )
            ),
            Command.provideEffectDiscard(() =>
              Effect.gen(function*() {
                capturedFromProvideEffect.push(yield* Region)
              })
            ),
            Command.withGlobalFlags([Region])
          )

        const runCommand = Command.runWith(command, {
          version: "1.0.0"
        })

        yield* runCommand(["--region", "eu-west-1"])

        assert.deepStrictEqual(capturedFromProvide, [Option.some("eu-west-1")])
        assert.deepStrictEqual(capturedFromProvideEffect, [Option.some("eu-west-1")])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should reject global flags that are out of scope for selected subcommand", () =>
      Effect.gen(function*() {
        const Region = GlobalFlag.setting("region")({
          flag: Flag.string("region").pipe(Flag.withDefault("us-east-1"))
        })
        let dbInvoked = false
        let deployInvoked = false

        const deploy = Command.make("deploy", {}, () =>
          Effect.sync(() => {
            deployInvoked = true
          })).pipe(
            Command.withGlobalFlags([Region])
          )

        const db = Command.make("db", {}, () =>
          Effect.sync(() => {
            dbInvoked = true
          }))

        const root = Command.make("app", {}).pipe(Command.withSubcommands([deploy, db]))

        const runCommand = Command.runWith(root, {
          version: "1.0.0"
        })

        yield* runCommand(["db", "--region", "eu-west-1"]).pipe(
          Effect.ignore
        )

        const stderr = yield* TestConsole.errorLines
        assert.isTrue(
          stderr.some((line) => String(line).includes("--region")),
          "expected CLI to report out-of-scope global flag"
        )
        assert.isFalse(dbInvoked)
        assert.isFalse(deployInvoked)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should show only path-active global flags in subcommand help", () =>
      Effect.gen(function*() {
        const Region = GlobalFlag.setting("region")({
          flag: Flag.string("region").pipe(Flag.withDefault("us-east-1"))
        })

        const deploy = Command.make("deploy", {}, () => Effect.void).pipe(
          Command.withGlobalFlags([Region])
        )
        const db = Command.make("db", {}, () => Effect.void)
        const root = Command.make("app", {}).pipe(Command.withSubcommands([deploy, db]))

        const runCommand = Command.runWith(root, {
          version: "1.0.0"
        })

        yield* runCommand(["deploy", "--help"])
        const deployHelp = yield* TestConsole.logLines
        assert.isTrue(deployHelp.some((line) => String(line).includes("--region")))

        yield* runCommand(["db", "--help"])
        const dbHelp = yield* TestConsole.logLines
        const dbSection = dbHelp.slice(deployHelp.length)
        assert.isFalse(dbSection.some((line) => String(line).includes("--region")))
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should fail for malformed key=value flags", () =>
      Effect.gen(function*() {
        let invoked = false

        const command = Command.make("env", {
          env: Flag.keyValuePair("env")
        }, () =>
          Effect.sync(() => {
            invoked = true
          }))

        const runCommand = Command.runWith(command, {
          version: "1.0.0"
        })

        yield* runCommand([
          "--env",
          "invalid"
        ]).pipe(Effect.ignore)

        const stderr = yield* TestConsole.errorLines
        assert.isTrue(
          stderr.some((line) => String(line).includes("Invalid key=value format")),
          "expected CLI to report invalid key=value format"
        )

        assert.isFalse(invoked)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should handle parsing errors from run", () =>
      Effect.gen(function*() {
        const runCommand = Command.runWith(Cli.ComprehensiveCli, {
          version: "1.0.0"
        })

        yield* runCommand(["invalid-command"]).pipe(Effect.ignore)

        // Check that help text was shown to stdout
        const stdout = yield* TestConsole.logLines
        assert.isTrue(stdout.some((line) => String(line).includes("DESCRIPTION")))
        assert.isTrue(stdout.some((line) => String(line).includes("comprehensive CLI tool")))

        // Check that error was shown to stderr
        const stderr = yield* TestConsole.errorLines
        assert.isTrue(stderr.some((line) => String(line).includes("ERROR")))
        assert.isTrue(stderr.some((line) => String(line).includes("Unknown subcommand")))
        assert.isTrue(stderr.some((line) => String(line).includes("invalid-command")))
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should propagate handler errors from run", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Cli.run(["test-failing", "--input", "test"]))
        assert.strictEqual(result, "Handler error")
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("withSubcommands", () => {
    it.effect("should execute parent handler when no subcommand provided", () =>
      Effect.gen(function*() {
        const command = "git"

        yield* Cli.run([command, "--verbose"])

        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 1)
        assert.deepStrictEqual(actions[0], { command, details: { verbose: true } })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should execute subcommand when provided", () =>
      Effect.gen(function*() {
        const command = ["git", "clone"]
        const repository = "myrepo"
        const branch = "develop"

        yield* Cli.run([...command, repository, "--branch", branch])

        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 1)
        assert.deepStrictEqual(actions[0], {
          command: command.join(" "),
          details: { repository, branch }
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should execute subcommand when provided by alias", () =>
      Effect.gen(function*() {
        const executed: Array<string> = []

        const plan = Command.make("plan", {}, () => Effect.sync(() => executed.push("plan"))).pipe(
          Command.withAlias("p")
        )
        const root = Command.make("tool").pipe(Command.withSubcommands([plan]))
        const runRoot = Command.runWith(root, { version: "1.0.0" })

        yield* runRoot(["p"])

        assert.deepStrictEqual(executed, ["plan"])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should accept grouped and ungrouped subcommands", () =>
      Effect.gen(function*() {
        const executed: Array<string> = []

        const root = Command.make("tool")
        const login = Command.make("login", {}, () => Effect.sync(() => executed.push("login")))
        const logout = Command.make("logout", {}, () => Effect.sync(() => executed.push("logout")))
        const status = Command.make("status", {}, () => Effect.sync(() => executed.push("status")))

        const cli = root.pipe(Command.withSubcommands([
          {
            group: "Auth commands",
            commands: [login, logout]
          },
          status
        ]))

        const runCli = Command.runWith(cli, { version: "1.0.0" })

        yield* runCli(["login"])
        yield* runCli(["status"])

        assert.deepStrictEqual(executed, ["login", "status"])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should handle multiple subcommands correctly", () =>
      Effect.gen(function*() {
        yield* Cli.run(["git", "clone", "repo1"])
        yield* Cli.run(["git", "add", "file1", "--update"])
        yield* Cli.run(["git", "status", "--short"])

        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 3)
        assert.deepStrictEqual(actions[0], {
          command: "git clone",
          details: { repository: "repo1", branch: "main" }
        })
        assert.deepStrictEqual(actions[1], {
          command: "git add",
          details: { files: "file1", update: true }
        })
        assert.deepStrictEqual(actions[2], {
          command: "git status",
          details: { short: true }
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should handle nested config structures in subcommands", () =>
      Effect.gen(function*() {
        const service = "api-service"
        const environment = "production"
        const dbHost = "localhost"
        const dbPort = 5432

        yield* Cli.run([
          "app",
          "--env",
          "prod",
          "deploy",
          service,
          environment,
          "--db-host",
          dbHost,
          "--db-port",
          dbPort.toString(),
          "--dry-run"
        ])

        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 1)
        assert.deepStrictEqual(actions[0], {
          command: "deploy",
          details: {
            service,
            environment,
            database: { host: dbHost, port: dbPort },
            dryRun: true
          }
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should execute parent handler with options when no subcommand provided", () =>
      Effect.gen(function*() {
        // Use git command with only --verbose flag (git doesn't have an "unknown" option)
        // This will execute the parent git handler instead of trying to match subcommands
        yield* Cli.run(["git", "--verbose"])

        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 1)
        assert.deepStrictEqual(actions[0], {
          command: "git",
          details: { verbose: true }
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should propagate subcommand errors", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Cli.run(["test-failing", "--input", "test"]))
        assert.strictEqual(result, "Handler error")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should provide shared parent context to subcommands", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        const parent = Command.make("parent").pipe(
          Command.withSharedFlags({
            verbose: Flag.boolean("verbose"),
            config: Flag.string("config")
          })
        )

        // Create subcommand that accesses parent context
        const child = Command.make("child", { action: Flag.string("action") }, (config) =>
          Effect.gen(function*() {
            const parentConfig = yield* parent
            messages.push(`child: parent.verbose=${parentConfig.verbose}`)
            messages.push(`child: parent.config=${parentConfig.config}`)
            messages.push(`child: action=${config.action}`)
          }))

        const combined = parent.pipe(Command.withSubcommands([child]))

        const runCommand = Command.runWith(combined, {
          version: "1.0.0"
        })

        yield* runCommand([
          "--verbose",
          "--config",
          "prod.json",
          "child",
          "--action",
          "deploy"
        ])

        assert.deepStrictEqual(messages, [
          "child: parent.verbose=true",
          "child: parent.config=prod.json",
          "child: action=deploy"
        ])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should accept shared parent flags before or after a subcommand (npm-style)", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        const root = Command.make("npm").pipe(
          Command.withSharedFlags({
            global: Flag.boolean("global")
          })
        )

        const install = Command.make("install", {
          pkg: Flag.string("pkg")
        }, (config) =>
          Effect.gen(function*() {
            const parentConfig = yield* root
            messages.push(`install: global=${parentConfig.global}, pkg=${config.pkg}`)
          }))

        const npm = root.pipe(Command.withSubcommands([install]))

        const runNpm = Command.runWith(npm, { version: "1.0.0" })

        yield* runNpm(["--global", "install", "--pkg", "cowsay"])
        yield* runNpm(["install", "--pkg", "cowsay", "--global"])

        assert.deepStrictEqual(messages, [
          "install: global=true, pkg=cowsay",
          "install: global=true, pkg=cowsay"
        ])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should parse shared flags for parent handlers", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        const root = Command.make("tool", {
          workspace: Flag.string("workspace")
        }).pipe(
          Command.withSharedFlags({
            model: Flag.string("model")
          }),
          Command.withHandler((config) =>
            Effect.sync(() => {
              messages.push(`root: workspace=${config.workspace}, model=${config.model}`)
            })
          )
        )

        const runRoot = Command.runWith(root, { version: "1.0.0" })
        yield* runRoot(["--workspace", "docs", "--model", "gpt-4o"])

        assert.deepStrictEqual(messages, ["root: workspace=docs, model=gpt-4o"])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should allow child flags to reuse parent local flag names", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        const root = Command.make("tool", {
          model: Flag.string("model")
        }).pipe(
          Command.withSharedFlags({
            workspace: Flag.string("workspace")
          })
        )

        const chat = Command.make("chat", {
          model: Flag.string("model")
        }, (config) =>
          Effect.gen(function*() {
            const parent = yield* root
            messages.push(`chat: workspace=${parent.workspace}, model=${config.model}`)
          }))

        const cli = root.pipe(Command.withSubcommands([chat]))
        const runCli = Command.runWith(cli, { version: "1.0.0" })

        yield* runCli(["--workspace", "docs", "chat", "--model", "gpt-4o-mini"])

        assert.deepStrictEqual(messages, ["chat: workspace=docs, model=gpt-4o-mini"])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should reject parent local flags on subcommand paths", () =>
      Effect.gen(function*() {
        const root = Command.make("tool", {
          model: Flag.string("model")
        }).pipe(
          Command.withSharedFlags({
            workspace: Flag.string("workspace")
          })
        )

        const chat = Command.make("chat", {
          topic: Flag.string("topic")
        })

        const cli = root.pipe(Command.withSubcommands([chat]))
        const runCli = Command.runWith(cli, { version: "1.0.0" })

        yield* runCli(["--workspace", "docs", "--model", "gpt-4o", "chat", "--topic", "bugs"]).pipe(
          Effect.catchTag("ShowHelp", () => Effect.void)
        )

        const stderr = yield* TestConsole.errorLines
        const text = stderr.join("\n")
        assert.isTrue(text.includes("Unrecognized flag: --model in command tool chat"))
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should allow direct accessing parent config in subcommands", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        const root = Command.make("npm").pipe(
          Command.withSharedFlags({
            global: Flag.boolean("global")
          })
        )

        const install = Command.make("install", {
          pkg: Flag.string("pkg")
        }, (config) =>
          Effect.gen(function*() {
            const parentConfig = yield* root
            messages.push(`install: global=${parentConfig.global}, pkg=${config.pkg}`)
          }))

        const npm = root.pipe(Command.withSubcommands([install]))

        const runNpm = Command.runWith(npm, { version: "1.0.0" })
        yield* runNpm(["--global", "install", "--pkg", "effect"])

        assert.deepStrictEqual(messages, [
          "install: global=true, pkg=effect"
        ])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should handle nested subcommands with context sharing", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        const root = Command.make("app").pipe(
          Command.withSharedFlags({
            env: Flag.string("env")
          }),
          Command.withHandler((config) =>
            Effect.gen(function*() {
              messages.push(`root: env=${config.env}`)
            })
          )
        )

        const service = Command.make("service").pipe(
          Command.withSharedFlags({
            name: Flag.string("name")
          }),
          Command.withHandler((config) =>
            Effect.gen(function*() {
              const rootConfig = yield* root
              messages.push(`service: root.env=${rootConfig.env}`)
              messages.push(`service: name=${config.name}`)
            })
          )
        )

        const deploy = Command.make("deploy", {
          targetVersion: Flag.string("target-version")
        }, (config) =>
          Effect.gen(function*() {
            const rootConfig = yield* root
            const serviceConfig = yield* service
            messages.push(`deploy: root.env=${rootConfig.env}`)
            messages.push(`deploy: service.name=${serviceConfig.name}`)
            messages.push(`deploy: target-version=${config.targetVersion}`)
          }))

        const serviceWithDeploy = service.pipe(
          Command.withSubcommands([deploy])
        )

        const appWithService = root.pipe(
          Command.withSubcommands([serviceWithDeploy])
        )

        const runCommand = Command.runWith(appWithService, { version: "1.0.0" })
        yield* runCommand([
          "--env",
          "production",
          "service",
          "--name",
          "api",
          "deploy",
          "--target-version",
          "1.0.0"
        ])

        assert.deepStrictEqual(messages, [
          "deploy: root.env=production",
          "deploy: service.name=api",
          "deploy: target-version=1.0.0"
        ])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should handle boolean shared flags before subcommands", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        const parent = Command.make("app").pipe(
          Command.withSharedFlags({
            verbose: Flag.boolean("verbose"),
            config: Flag.string("config")
          }),
          Command.withHandler((config) =>
            Effect.gen(function*() {
              messages.push(`parent: verbose=${config.verbose}, config=${config.config}`)
            })
          )
        )

        const deploy = Command.make("deploy", {
          targetVersion: Flag.string("target-version")
        }, (config) =>
          Effect.gen(function*() {
            const parentConfig = yield* parent
            messages.push(`deploy: parent.verbose=${parentConfig.verbose}`)
            messages.push(`deploy: target-version=${config.targetVersion}`)
          }))

        const combined = parent.pipe(
          Command.withSubcommands([deploy])
        )

        const runCommand = Command.runWith(combined, { version: "1.0.0" })
        yield* runCommand([
          "--config",
          "prod.json",
          "--verbose",
          "deploy",
          "--target-version",
          "1.0.0"
        ])

        assert.deepStrictEqual(messages, [
          "deploy: parent.verbose=true",
          "deploy: target-version=1.0.0"
        ])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should merge stacked withSharedFlags calls", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        const root = Command.make("tool", {
          dryRun: Flag.boolean("dry-run")
        }).pipe(
          Command.withSharedFlags({
            verbose: Flag.boolean("verbose")
          }),
          Command.withSharedFlags({
            format: Flag.string("format")
          })
        )

        const child = Command.make("run", {}, () =>
          Effect.gen(function*() {
            const parent = yield* root
            messages.push(`verbose=${parent.verbose}, format=${parent.format}`)
          }))

        const cli = root.pipe(Command.withSubcommands([child]))
        const runCli = Command.runWith(cli, { version: "1.0.0" })

        yield* runCli(["--verbose", "--format", "json", "run"])

        assert.deepStrictEqual(messages, ["verbose=true, format=json"])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should work with Command.provide when shared flags are present", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        const DbUrl = Context.Service<never, string>("effect/test/unstable/cli/DbUrl")

        const root = Command.make("app", {
          dryRun: Flag.boolean("dry-run")
        }).pipe(
          Command.withSharedFlags({
            env: Flag.string("env")
          })
        )

        const deploy = Command.make("deploy", {}, () =>
          Effect.gen(function*() {
            const parent = yield* root
            const dbUrl = yield* DbUrl
            messages.push(`env=${parent.env}, db=${dbUrl}`)
          }))

        const cli = root.pipe(
          Command.withSubcommands([deploy]),
          Command.provideSync(DbUrl, (input) => `db://${input.env}.example.com`)
        )

        const runCli = Command.runWith(cli, { version: "1.0.0" })
        yield* runCli(["--env", "production", "deploy"])

        assert.deepStrictEqual(messages, ["env=production, db=db://production.example.com"])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should reject shared/child flag collisions when withSharedFlags is applied after withSubcommands", () =>
      Effect.sync(() => {
        const child = Command.make("run", {
          verbose: Flag.boolean("verbose")
        })

        assert.throws(() =>
          Command.make("tool").pipe(
            Command.withSubcommands([child]),
            Command.withSharedFlags({
              verbose: Flag.boolean("verbose")
            })
          )
        )
      }))

    it.effect("should require withSharedFlags before withSubcommands for subcommand access", () =>
      Effect.gen(function*() {
        const messages: Array<string> = []

        // withSharedFlags BEFORE withSubcommands — correct ordering
        const root = Command.make("tool").pipe(
          Command.withSharedFlags({
            verbose: Flag.boolean("verbose")
          })
        )

        const child = Command.make("run", {}, () =>
          Effect.gen(function*() {
            const parent = yield* root
            messages.push(`verbose=${parent.verbose}`)
          }))

        const cli = root.pipe(
          Command.withSubcommands([child])
        )

        const runCli = Command.runWith(cli, { version: "1.0.0" })
        yield* runCli(["--verbose", "run"])

        assert.deepStrictEqual(messages, ["verbose=true"])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should treat tokens after -- as operands (no subcommand or flags)", () =>
      Effect.gen(function*() {
        const captured: Array<ReadonlyArray<string>> = []
        let childInvoked = false

        const root = Command.make("tool", {
          rest: Argument.string("rest").pipe(Argument.variadic())
        }, (config) =>
          Effect.sync(() => {
            captured.push(config.rest)
          }))

        const child = Command.make("child", {
          value: Flag.string("value")
        }, () =>
          Effect.sync(() => {
            childInvoked = true
          }))

        const cli = root.pipe(Command.withSubcommands([child]))
        const runCli = Command.runWith(cli, { version: "1.0.0" })

        yield* runCli(["--", "child", "--value", "x"])

        assert.isFalse(childInvoked)
        assert.deepStrictEqual(captured, [["child", "--value", "x"]])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should coerce boolean flags to false when given falsey literals", () =>
      Effect.gen(function*() {
        const captured: Array<boolean> = []

        const cmd = Command.make("tool", {
          verbose: Flag.boolean("verbose")
        }, (config) => Effect.sync(() => captured.push(config.verbose)))

        const runCmd = Command.runWith(cmd, { version: "1.0.0" })

        yield* runCmd(["--verbose", "false"])
        yield* runCmd(["--verbose", "0"])

        assert.deepStrictEqual(captured, [false, false])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should support optional boolean flags and --no-<flag> negation", () =>
      Effect.gen(function*() {
        const captured: Array<Option.Option<boolean>> = []

        const cmd = Command.make("tool", {
          open: Flag.boolean("open").pipe(Flag.optional)
        }, (config) => Effect.sync(() => captured.push(config.open)))

        const runCmd = Command.runWith(cmd, { version: "1.0.0" })

        yield* runCmd([])
        yield* runCmd(["--open"])
        yield* runCmd(["--no-open"])

        assert.deepStrictEqual(captured, [
          Option.none(),
          Option.some(true),
          Option.some(false)
        ])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should prefer canonical negation over conflicting aliases", () =>
      Effect.gen(function*() {
        const captured: Array<readonly [boolean, boolean]> = []

        const cmd = Command.make("tool", {
          prompt: Flag.boolean("prompt"),
          force: Flag.boolean("force").pipe(Flag.withAlias("no-prompt"))
        }, (config) => Effect.sync(() => captured.push([config.prompt, config.force] as const)))

        const runCmd = Command.runWith(cmd, { version: "1.0.0" })

        yield* runCmd(["--no-prompt"])

        assert.deepStrictEqual(captured, [[false, false]])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should reject explicit values for canonical negated flags", () =>
      Effect.gen(function*() {
        let invoked = false

        const cmd = Command.make("tool", {
          open: Flag.boolean("open")
        }, () =>
          Effect.sync(() => {
            invoked = true
          }))

        const runCmd = Command.runWith(cmd, { version: "1.0.0" })

        yield* runCmd(["--no-open", "false"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))
        yield* runCmd(["--no-open=true"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        assert.isFalse(invoked)

        const stderr = yield* TestConsole.errorLines
        assert.isTrue(stderr.join("\n").includes("use --no-open by itself to set --open to false"))
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should not leak a negated flag literal into subcommand parsing", () =>
      Effect.gen(function*() {
        let parentInvoked = false
        let childInvoked = false

        const child = Command.make("child", {}, () =>
          Effect.sync(() => {
            childInvoked = true
          }))

        const root = Command.make("tool", {
          open: Flag.boolean("open")
        }, () =>
          Effect.sync(() => {
            parentInvoked = true
          })).pipe(Command.withSubcommands([child]))

        const runCmd = Command.runWith(root, { version: "1.0.0" })

        yield* runCmd(["--no-open", "false", "child"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        assert.isFalse(parentInvoked)
        assert.isFalse(childInvoked)

        const stderr = yield* TestConsole.errorLines
        const output = stderr.join("\n")
        assert.isTrue(output.includes("use --no-open by itself to set --open to false"))
        assert.isFalse(output.includes("Unknown subcommand \"false\""))
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should fail when a required flag value is missing", () =>
      Effect.gen(function*() {
        let invoked = false

        const cmd = Command.make("tool", {
          pkg: Flag.string("pkg")
        }, () =>
          Effect.sync(() => {
            invoked = true
          }))

        const runCmd = Command.runWith(cmd, { version: "1.0.0" })

        yield* runCmd(["--pkg"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        assert.isFalse(invoked)
        const stderr = yield* TestConsole.errorLines
        assert.isAbove(stderr.length, 0)
        assert.isTrue(stderr.join("\n").includes("--pkg"))
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should parse combined short flags including one that expects a value", () =>
      Effect.gen(function*() {
        const captured: Array<{ all: boolean; verbose: boolean; pkg: string }> = []

        const cmd = Command.make("tool", {
          all: Flag.boolean("all").pipe(Flag.withAlias("a")),
          verbose: Flag.boolean("verbose").pipe(Flag.withAlias("v")),
          pkg: Flag.string("pkg").pipe(Flag.withAlias("p"))
        }, (config) =>
          Effect.sync(() => {
            captured.push(config)
          }))

        const runCmd = Command.runWith(cmd, { version: "1.0.0" })

        yield* runCmd(["-avp", "cowsay"])

        assert.deepStrictEqual(captured, [{ all: true, verbose: true, pkg: "cowsay" }])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should honor -- while still applying parent flags", () =>
      Effect.gen(function*() {
        const captured: Array<{ global: boolean; rest: ReadonlyArray<string> }> = []

        const root = Command.make("tool", {
          global: Flag.boolean("global"),
          rest: Argument.string("rest").pipe(Argument.variadic())
        }, (config) => Effect.sync(() => captured.push({ global: config.global, rest: config.rest })))

        const child = Command.make("child", {
          value: Flag.string("value")
        })

        const cli = root.pipe(Command.withSubcommands([child]))
        const runCli = Command.runWith(cli, { version: "1.0.0" })

        yield* runCli(["--global", "--", "child", "--value", "x"])

        assert.deepStrictEqual(captured, [{ global: true, rest: ["child", "--value", "x"] }])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should report unknown flag even when subcommand is unknown", () =>
      Effect.gen(function*() {
        const root = Command.make("root", {})
        const known = Command.make("known", {})
        const cli = root.pipe(Command.withSubcommands([known]))
        const runCli = Command.runWith(cli, { version: "1.0.0" })

        yield* runCli(["--unknown", "bogus"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        const stderr = yield* TestConsole.errorLines
        const text = stderr.join("\n")
        assert.isTrue(text.includes("Unrecognized flag: --unknown"))
        // Parser may also surface the unknown subcommand; ensure at least one error is emitted.
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should keep variadic argument order when options are interleaved", () =>
      Effect.gen(function*() {
        const captured: Array<{ files: ReadonlyArray<string>; verbose: boolean }> = []

        const cmd = Command.make("copy", {
          verbose: Flag.boolean("verbose"),
          files: Argument.string("file").pipe(Argument.variadic())
        }, (config) => Effect.sync(() => captured.push({ files: config.files, verbose: config.verbose })))

        const runCmd = Command.runWith(cmd, { version: "1.0.0" })

        yield* runCmd(["--verbose", "a.txt", "b.txt", "--verbose", "c.txt"])

        assert.deepStrictEqual(captured, [{ files: ["a.txt", "b.txt", "c.txt"], verbose: true }])
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should support options before, after, or between operands (relaxed POSIX Syntax Guideline No. 9)", () =>
      Effect.gen(function*() {
        // Test both orderings work: POSIX (options before operands) and modern (mixed)

        // Test 1: POSIX style - options before operands
        yield* Cli.run([
          "copy",
          "--recursive",
          "--force",
          "src.txt",
          "dest.txt"
        ])

        // Test 2: Modern style - options after operands
        yield* Cli.run([
          "copy",
          "src.txt",
          "dest.txt",
          "--recursive",
          "--force"
        ])

        // Test 3: Mixed style - some options before, some after
        yield* Cli.run([
          "copy",
          "--recursive",
          "src.txt",
          "dest.txt",
          "--force"
        ])

        // Check all three commands worked
        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 3)

        for (let i = 0; i < 3; i++) {
          assert.strictEqual(actions[i].command, "copy")
          assert.strictEqual(actions[i].details.recursive, true)
          assert.strictEqual(actions[i].details.force, true)
          assert.strictEqual(actions[i].details.bufferSize, 64)
          // Source and destination will be resolved paths - just check they contain the filenames
          assert.isTrue(String(actions[i].details.source).includes("src.txt"))
          assert.isTrue(String(actions[i].details.destination).includes("dest.txt"))
        }
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should suggest similar subcommands for unknown subcommands", () =>
      Effect.gen(function*() {
        yield* Cli.run(["cpy"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        const errorOutput = yield* TestConsole.errorLines
        const errorText = errorOutput.join("\n")
        expect(errorText).toMatchInlineSnapshot(`
          "
          ERROR
            Unknown subcommand "cpy" for "mycli"

            Did you mean this?
              copy"
        `)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should suggest similar subcommands for nested unknown subcommands", () =>
      Effect.gen(function*() {
        yield* Cli.run(["admin", "usrs", "list"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        // Capture the error output
        const errorOutput = yield* TestConsole.errorLines
        const errorText = errorOutput.join("\n")
        expect(errorText).toMatchInlineSnapshot(`
          "
          ERROR
            Unknown subcommand "usrs" for "mycli admin"

            Did you mean this?
              users"
        `)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should suggest similar options for unrecognized options", () =>
      Effect.gen(function*() {
        yield* Cli.run(["--debugs", "copy", "src.txt", "dest.txt"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        const errorOutput = yield* TestConsole.errorLines
        const errorText = errorOutput.join("\n")
        expect(errorText).toMatchInlineSnapshot(`
          "
          ERROR
            Unrecognized flag: --debugs in command mycli

            Did you mean this?
              --debug"
        `)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should suggest similar short options for unrecognized short options", () =>
      Effect.gen(function*() {
        yield* Cli.run(["-u", "copy", "src.txt", "dest.txt"]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        const errorOutput = yield* TestConsole.errorLines
        const errorText = errorOutput.join("\n")
        expect(errorText).toMatchInlineSnapshot(`
          "
          ERROR
            Unrecognized flag: -u in command mycli

            Did you mean this?
              -d
              -c
              -q"
        `)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should print version and exit even with subcommands (global precedence)", () =>
      Effect.gen(function*() {
        // --version should work on a command with subcommands
        yield* Cli.run(["--version"])

        const output = yield* TestConsole.logLines
        const outputText = output.join("\n")
        expect(outputText).toContain("1.0.0")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should print version and exit when --version appears before subcommand", () =>
      Effect.gen(function*() {
        // --version should take precedence over subcommand
        yield* Cli.run(["--version", "copy", "src.txt", "dest.txt"])

        const output = yield* TestConsole.logLines
        const outputText = output.join("\n")
        expect(outputText).toContain("1.0.0")

        // Subcommand should NOT have run
        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 0)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should print help when invoked with no arguments", () =>
      Effect.gen(function*() {
        yield* Cli.run([]).pipe(Effect.catchTag("ShowHelp", () => Effect.void))

        // Check that help text was shown to stdout
        const stdout = yield* TestConsole.logLines
        assert.isTrue(stdout.some((line) => String(line).includes("DESCRIPTION")))
        assert.isTrue(stdout.some((line) => String(line).includes("comprehensive CLI tool")))

        // Handler should NOT have run
        const actions = yield* TestActions.getActions
        assert.strictEqual(actions.length, 0)
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should use short descriptions in subcommand listings", () =>
      Effect.gen(function*() {
        const withShortDescription = Command.make("build").pipe(
          Command.withDescription("Build the project and all artifacts"),
          Command.withShortDescription("Build artifacts")
        )
        const withFallbackDescription = Command.make("test").pipe(
          Command.withDescription("Run the full test suite")
        )
        const root = Command.make("tool").pipe(
          Command.withSubcommands([withShortDescription, withFallbackDescription])
        )

        const runCommand = Command.runWith(root, { version: "1.0.0" })
        yield* runCommand(["--help"])

        const stdout = (yield* TestConsole.logLines).join("\n")
        assert.isTrue(stdout.includes("Build artifacts"))
        assert.isFalse(stdout.includes("Build the project and all artifacts"))
        assert.isTrue(stdout.includes("Run the full test suite"))
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should keep full description on the command help page", () =>
      Effect.gen(function*() {
        const child = Command.make("build").pipe(
          Command.withDescription("Build the project and all artifacts"),
          Command.withShortDescription("Build artifacts")
        )
        const root = Command.make("tool").pipe(Command.withSubcommands([child]))
        const runCommand = Command.runWith(root, { version: "1.0.0" })

        yield* runCommand(["build", "--help"])

        const stdout = (yield* TestConsole.logLines).join("\n")
        assert.isTrue(stdout.includes("Build the project and all artifacts"))
      }).pipe(Effect.provide(TestLayer)))

    it.effect("should include short description metadata in HelpDoc subcommands", () =>
      Effect.gen(function*() {
        const child = Command.make("build").pipe(
          Command.withDescription("Build the project and all artifacts"),
          Command.withShortDescription("Build artifacts"),
          Command.withAlias("b")
        )
        const root = Command.make("tool").pipe(Command.withSubcommands([child]))

        const helpDoc = toImpl(root).buildHelpDoc(["tool"])
        const listed = helpDoc.subcommands?.[0]?.commands[0]

        assert.strictEqual(listed?.alias, "b")
        assert.strictEqual(listed?.shortDescription, "Build artifacts")
        assert.strictEqual(listed?.description, "Build the project and all artifacts")
      }))
  })

  describe("withExamples", () => {
    it.effect("should expose examples in help docs", () =>
      Effect.gen(function*() {
        const command = Command.make("login").pipe(
          Command.withExamples([
            { command: "myapp login", description: "Log in with browser OAuth" },
            { command: "myapp login --token sbp_abc123", description: "Log in with a token" }
          ])
        )

        const helpDoc = toImpl(command).buildHelpDoc(["login"])

        assert.deepStrictEqual(helpDoc.examples, [
          { command: "myapp login", description: "Log in with browser OAuth" },
          { command: "myapp login --token sbp_abc123", description: "Log in with a token" }
        ])
      }))

    it.effect("should preserve examples when adding subcommands", () =>
      Effect.gen(function*() {
        const root = Command.make("root").pipe(
          Command.withExamples([
            { command: "myapp root", description: "Run root command" }
          ]),
          Command.withSubcommands([Command.make("child")])
        )

        const helpDoc = toImpl(root).buildHelpDoc(["root"])

        assert.deepStrictEqual(helpDoc.examples, [
          { command: "myapp root", description: "Run root command" }
        ])
      }))
  })

  describe("help docs", () => {
    it.effect("should include flag choices in help doc descriptions", () =>
      Effect.gen(function*() {
        const command = Command.make("tool", {
          mode: Flag.choice("mode", ["dev", "prod"]).pipe(
            Flag.withDescription("Execution mode")
          ),
          format: Flag.choice("format", ["json", "yaml"])
        })

        const helpDoc = toImpl(command).buildHelpDoc(["tool"])

        assert.deepStrictEqual(helpDoc.flags, [
          {
            name: "mode",
            aliases: [],
            type: "choice",
            description: Option.some("Execution mode (choices: dev, prod)"),
            required: true
          },
          {
            name: "format",
            aliases: [],
            type: "choice",
            description: Option.some("(choices: json, yaml)"),
            required: true
          }
        ])
      }))

    it.effect("should render flag choices in formatted help output", () =>
      Effect.gen(function*() {
        const command = Command.make("tool", {
          mode: Flag.choice("mode", ["dev", "prod"]).pipe(
            Flag.withDescription("Execution mode")
          )
        })
        const runCommand = Command.runWith(command, { version: "1.0.0" })

        yield* runCommand(["--help"])

        const stdout = (yield* TestConsole.logLines).join("\n")
        assert.isTrue(stdout.includes("Execution mode (choices: dev, prod)"))
      }).pipe(Effect.provide(TestLayer)))
  })
})
