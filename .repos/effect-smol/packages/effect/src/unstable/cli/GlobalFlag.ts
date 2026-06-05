/**
 * The `GlobalFlag` module defines flags that are available to every command in
 * an Effect CLI application. Global flags are useful for cross-cutting command
 * line behavior such as printing help, showing the application version,
 * generating shell completions, or configuring shared handler settings like the
 * minimum log level.
 *
 * **Common tasks**
 *
 * - Create an action flag with {@link action} for side effects that should run
 *   before the selected command, such as `--help` or `--version`
 * - Create a setting flag with {@link setting} for values that should be made
 *   available to command handlers through the Effect context
 * - Reuse the built-in {@link Help}, {@link Version}, {@link Completions}, and
 *   {@link LogLevel} flags when constructing command runners
 *
 * **Gotchas**
 *
 * - Action flags are intended to perform their effect and exit instead of
 *   continuing into the command handler
 * - Setting flags allocate a distinct context service for each call to
 *   {@link setting}, so reuse exported settings when handlers need to read the
 *   same parsed global value
 *
 * @since 4.0.0
 */

import * as Console from "../../Console.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import type { LogLevel as LogLevelType } from "../../LogLevel.ts"
import * as Option from "../../Option.ts"
import * as CliOutput from "./CliOutput.ts"
import type * as Command from "./Command.ts"
import * as Completions_ from "./Completions.ts"
import * as Flag from "./Flag.ts"
import * as CommandDescriptor from "./internal/completions/descriptor.ts"
import * as HelpInternal from "./internal/help.ts"

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

/**
 * Context passed to action handlers.
 *
 * @category models
 * @since 4.0.0
 */
export interface HandlerContext {
  readonly command: Command.Command.Any
  readonly commandPath: ReadonlyArray<string>
  readonly version: string
}

/**
 * Action flag: side effect + exit (--help, --version, --completions).
 *
 * @category models
 * @since 4.0.0
 */
export interface Action<A> {
  readonly _tag: "Action"
  readonly flag: Flag.Flag<A>
  readonly run: (
    value: A,
    context: HandlerContext
  ) => Effect.Effect<void>
}

/**
 * Setting flag: configure command handler's environment (--log-level, --config).
 *
 * @category models
 * @since 4.0.0
 */
export interface Setting<Id extends string, A> extends Context.Service<Setting.Identifier<Id>, A> {
  readonly _tag: "Setting"
  readonly id: Id
  readonly flag: Flag.Flag<A>
}

/**
 * Namespace containing type helpers for global setting flags.
 *
 * @since 4.0.0
 */
export declare namespace Setting {
  /**
   * Type-level service identifier used by `Setting` global flags for the
   * parsed value associated with a setting id.
   *
   * @category models
   * @since 4.0.0
   */
  export type Identifier<Id extends string> = `effect/unstable/cli/GlobalFlag/${Id}`
}

/**
 * Global flag discriminated union.
 *
 * @category models
 * @since 4.0.0
 */
export type GlobalFlag<A> = Action<A> | Setting<any, A>

/* ========================================================================== */
/* Constructors                                                               */
/* ========================================================================== */

/**
 * Creates an Action flag that performs a side effect and exits.
 *
 * @category constructors
 * @since 4.0.0
 */
export const action = <A>(options: {
  readonly flag: Flag.Flag<A>
  readonly run: (
    value: A,
    context: HandlerContext
  ) => Effect.Effect<void>
}): Action<A> => ({
  _tag: "Action",
  flag: options.flag,
  run: options.run
})

/**
 * Creates a Setting flag that configures the command handler's environment.
 *
 * @category constructors
 * @since 4.0.0
 */
export const setting = <const Id extends string>(
  id: Id
) =>
<A>(options: {
  readonly flag: Flag.Flag<A>
}): Setting<Id, A> => {
  settingIdCounter += 1
  const ref = Context.Service<Setting.Identifier<Id>, A>(
    `effect/unstable/cli/GlobalFlag/${id}/${settingIdCounter}`
  )
  return Object.assign(ref, {
    _tag: "Setting" as const,
    id,
    flag: options.flag
  })
}

let settingIdCounter = 0

/* ========================================================================== */
/* Built-in Flag References                                                   */
/* ========================================================================== */

/**
 * Defines the `--help` / `-h` global flag, which shows help documentation for the
 * active command path.
 *
 * @see {@link BuiltIns} for the default list containing this flag
 * @see {@link action} for defining custom action global flags
 *
 * @category references
 * @since 4.0.0
 */
export const Help: Action<boolean> = action({
  flag: Flag.boolean("help").pipe(
    Flag.withAlias("h"),
    Flag.withDescription("Show help information")
  ),
  run: (_, { command, commandPath }) =>
    Effect.gen(function*() {
      const formatter = yield* CliOutput.Formatter
      const helpDoc = yield* HelpInternal.getHelpForCommandPath(command, commandPath, BuiltIns)
      yield* Console.log(formatter.formatHelpDoc(helpDoc))
    })
})

/**
 * Defines the global action flag for showing command version information.
 *
 * **When to use**
 *
 * Use to add a built-in `--version` flag to a command runner.
 *
 * @category references
 * @since 4.0.0
 */
export const Version: Action<boolean> = action({
  flag: Flag.boolean("version").pipe(
    Flag.withDescription("Show version information")
  ),
  run: (_, { command, version }) =>
    Effect.gen(function*() {
      const formatter = yield* CliOutput.Formatter
      yield* Console.log(formatter.formatVersion(command.name, version))
    })
})

/**
 * Defines the `--completions` global flag, which prints a shell completion script for
 * the given shell.
 *
 * **Details**
 *
 * Accepted values are `bash`, `zsh`, `fish`, and `sh`; `sh` is normalized to
 * `bash`.
 *
 * @category references
 * @since 4.0.0
 */
export const Completions: Action<Option.Option<"bash" | "zsh" | "fish">> = action({
  flag: Flag.choice("completions", ["bash", "zsh", "fish", "sh"] as const)
    .pipe(
      Flag.optional,
      Flag.map((v) => Option.map(v, (s) => s === "sh" ? "bash" : s)),
      Flag.withDescription("Print shell completion script")
    ),
  run: (shell, { command }) =>
    Effect.gen(function*() {
      if (Option.isNone(shell)) return
      const descriptor = CommandDescriptor.fromCommand(command)
      yield* Console.log(
        Completions_.generate(command.name, shell.value, descriptor)
      )
    })
})

/**
 * Defines the global setting flag for command log level.
 *
 * **When to use**
 *
 * Use to add a built-in `--log-level` option that configures the minimum log
 * level for the command.
 *
 * @category references
 * @since 4.0.0
 */
export const LogLevel: Setting<"log-level", Option.Option<LogLevelType>> = setting("log-level")({
  flag: Flag.choiceWithValue(
    "log-level",
    [
      ["all", "All"],
      ["trace", "Trace"],
      ["debug", "Debug"],
      ["info", "Info"],
      ["warn", "Warn"],
      ["warning", "Warn"],
      ["error", "Error"],
      ["fatal", "Fatal"],
      ["none", "None"]
    ] as const
  ).pipe(
    Flag.optional,
    Flag.withDescription("Sets the minimum log level")
  )
})

/* ========================================================================== */
/* References                                                                 */
/* ========================================================================== */

/**
 * Built-in global flags in default precedence order.
 *
 * **Details**
 *
 * The built-ins are `Help`, `Version`, `Completions`, and `LogLevel`.
 * `Command.runWith` prepends these built-ins when collecting and parsing global
 * flags.
 *
 * **Gotchas**
 *
 * Action flags are processed in active flag order and the first present action
 * exits, so this array controls built-in action precedence.
 *
 * @see {@link Help} for the help action flag
 * @see {@link Version} for the version action flag
 * @see {@link Completions} for the shell-completions action flag
 * @see {@link LogLevel} for the built-in log-level setting flag
 *
 * @category references
 * @since 4.0.0
 */
export const BuiltIns: ReadonlyArray<GlobalFlag<any>> = [
  Help,
  Version,
  Completions,
  LogLevel
]

/**
 * Built-in setting context identifiers.
 *
 * @category models
 * @since 4.0.0
 */
export type BuiltInSettingContext = Setting.Identifier<"log-level">
