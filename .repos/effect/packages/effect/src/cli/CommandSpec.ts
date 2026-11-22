/**
 * The `CommandSpec` module projects one command path of an Effect CLI command
 * tree into plain data for documentation tooling such as reference pages or
 * JSON schemas. It is lossless where `Completions.fromCommand` is deliberately
 * not: hidden flags and unlisted subcommands are included and marked, every
 * effective flag says where it comes from, primitive types are not collapsed,
 * and defaults and fallbacks are reported structurally without running
 * handlers, prompts, `Config` lookups or effectful defaults.
 *
 * @stability unstable
 * @since 4.1.3
 */
import type * as Context from "../Context.ts"
import * as Option from "../Option.ts"
import type { Command } from "./Command.ts"
import * as GlobalFlag from "./GlobalFlag.ts"
import { toImpl } from "./internal/command.ts"
import type * as Param from "./Param.ts"
import * as Primitive from "./Primitive.ts"

/**
 * Everything known about one command path.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface Spec {
  /** The resolved path, root name first. */
  readonly path: ReadonlyArray<string>
  readonly name: string
  readonly alias: string | undefined
  readonly description: string | undefined
  readonly shortDescription: string | undefined
  readonly unlisted: boolean
  /** Examples resolved for `path`, not for the bare command name. */
  readonly examples: ReadonlyArray<Command.Example>
  readonly annotations: Context.Context<never>
  /**
   * The flags this path accepts, in the order help lists them: local flags,
   * then flags inherited through `withSharedFlags` from the root down, then
   * global flags with built-ins ahead of declarations.
   */
  readonly flags: ReadonlyArray<Flag>
  readonly arguments: ReadonlyArray<Argument>
  /** Direct subcommands, including unlisted ones. Aliases are data, not extra entries. */
  readonly subcommands: ReadonlyArray<Subcommand>
}

/**
 * The input surface of one flag as the user types it. Transformations applied
 * to the parsed value (`map`, `withSchema`, `filter`) are transparent, and a
 * parameter built with `orElse` yields one entry per alternative.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface Flag {
  readonly name: string
  /** Raw alias names without dashes. */
  readonly aliases: ReadonlyArray<string>
  readonly description: string | undefined
  /** Still parsed, but absent from `--help` and completions. */
  readonly hidden: boolean
  readonly type: Type
  /** Generic type name, e.g. `"integer"`, as `Primitive.getTypeName` reports it. */
  readonly typeName: string
  /** Display name given with `withMetavar`, if any. */
  readonly metavar: string | undefined
  /**
   * Whether parsing fails when this entry is absent and no fallback on its own
   * path supplies a value. Bare boolean flags are required like any other
   * flag; `withDefault(false)` makes them optional. A `Config` or `Prompt`
   * fallback does not clear this; pair it with `fallbacks` to render
   * "required unless `$VAR` is set". Global `Action` flags are never required
   * because the runner parses them only when present. The value is
   * branch-local, not whole-parameter: for `config` with
   * `orElse(() => configUrl.pipe(withDefault(...)))`, `config` is required
   * even though omitting both flags succeeds through the alternative.
   */
  readonly required: boolean
  /**
   * Fallbacks on this entry's own path, in the order the parser consults them
   * when the value is missing: innermost combinator first. Fallbacks applied
   * to each item of a variadic parameter are not reported, since they do not
   * satisfy its minimum.
   */
  readonly fallbacks: ReadonlyArray<Fallback>
  /** Repeat bounds for a variadic flag, `undefined` when the flag is not variadic. */
  readonly variadic: VariadicBounds | undefined
  /** Raw value used when the flag is given without a value, see `withOptionalValue`. */
  readonly optionalValue: string | undefined
  /** Effective long name that sets a boolean flag to `false`, `undefined` when none. */
  readonly negation: string | undefined
  readonly scope: Scope
  /** Annotations attached with `annotate`. */
  readonly annotations: Context.Context<never>
}

/**
 * The input surface of one positional argument. `required` and `fallbacks`
 * follow the same branch-local rules as {@link Flag}.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface Argument {
  readonly name: string
  readonly description: string | undefined
  readonly type: Type
  readonly typeName: string
  readonly metavar: string | undefined
  /** Whether parsing fails when this entry is absent and no fallback on its own path supplies a value. */
  readonly required: boolean
  /** Fallbacks on this entry's own path, innermost combinator first. */
  readonly fallbacks: ReadonlyArray<Fallback>
  readonly variadic: VariadicBounds | undefined
  readonly annotations: Context.Context<never>
}

/**
 * A direct subcommand of the resolved command.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface Subcommand {
  readonly name: string
  readonly alias: string | undefined
  readonly group: string | undefined
  /** Still parsed, but absent from `--help` and completions. */
  readonly unlisted: boolean
  readonly shortDescription: string | undefined
  readonly description: string | undefined
}

/**
 * Where an effective flag is declared.
 *
 * **Details**
 *
 * `Local` flags are declared on the resolved command itself. `Inherited`
 * flags come from `withSharedFlags` on the ancestor at `declaredBy`. `Global`
 * flags carry the path of the command that declared them with
 * `withGlobalFlags`, or `undefined` for a built-in.
 *
 * A nearer `Local` or `Inherited` flag hides an inherited flag of the same
 * name. A `Global` flag is always listed, even when a local or inherited flag
 * shares its name, because the parser still routes its other names and
 * aliases to the global flag.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export type Scope =
  | { readonly _tag: "Local" }
  | { readonly _tag: "Inherited"; readonly declaredBy: ReadonlyArray<string> }
  | {
    readonly _tag: "Global"
    readonly declaredBy: ReadonlyArray<string> | undefined
    readonly kind: "Action" | "Setting"
  }

/**
 * Repeat bounds of a variadic parameter. `undefined` means unbounded on that side.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface VariadicBounds {
  readonly min: number | undefined
  readonly max: number | undefined
}

/**
 * How a parameter obtains a value when it is absent, described without being
 * evaluated. See `Param.Fallback`.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export type Fallback = Param.Fallback

/**
 * The primitive type a parameter parses, one variant per `Primitive`.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export type Type =
  | { readonly _tag: "Boolean" }
  | { readonly _tag: "String" }
  | { readonly _tag: "Int" }
  | { readonly _tag: "Finite" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly pathType: Primitive.PathType }
  | { readonly _tag: "Redacted" }
  | { readonly _tag: "FileText" }
  | { readonly _tag: "FileParse" }
  | { readonly _tag: "FileSchema" }
  | { readonly _tag: "KeyValuePair" }
  | { readonly _tag: "Never" }

/**
 * Options for {@link resolve}.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface ResolveOptions {
  /**
   * Built-in global flags to report. Defaults to `GlobalFlag.BuiltIns`; pass
   * the value configured in `CliConfig` when it differs.
   */
  readonly builtIns?: ReadonlyArray<GlobalFlag.GlobalFlag<any>> | undefined
}

/**
 * Projects one command path of a command tree into a {@link Spec}.
 *
 * **When to use**
 *
 * Use when generating reference documentation or machine-readable schemas
 * for a CLI from its `Command` definition, in a build step, without running
 * the CLI.
 *
 * **Details**
 *
 * `path` names the commands from the root down, root name first, exactly as
 * `HelpDoc.commandPath` does. Only canonical names match: a subcommand alias
 * in the path, an unknown segment, a different root name or an empty path all
 * yield `Option.none()` rather than the deepest matching ancestor.
 *
 * Each flag or argument entry describes one `Single` parameter together with
 * the combinators on the path from the parameter's root to it, outermost
 * first. A combinator applied outside an `orElse` applies to every
 * alternative; one applied inside a branch applies to that branch only.
 * Combinators beneath a variadic describe each item and do not contribute to
 * `required` or `fallbacks`.
 *
 * The call is pure and synchronous. Handlers, prompts, `Config` lookups and
 * effectful defaults are reported as {@link Fallback} values and never run.
 *
 * **Example** (Listing the required flags of a subcommand)
 *
 * ```ts import.meta.vitest
 * import { Option } from "effect"
 * import { Command, CommandSpec, Flag } from "effect/cli"
 *
 * const push = Command.make("push", {
 *   dbUrl: Flag.String("db-url"),
 *   dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false))
 * })
 * const cli = Command.make("app").pipe(
 *   Command.withSharedFlags({ profile: Flag.String("profile").pipe(Flag.optional) }),
 *   Command.withSubcommands([push])
 * )
 *
 * const spec = Option.getOrThrow(CommandSpec.resolve(cli, ["app", "push"], { builtIns: [] }))
 *
 * const surface = spec.flags.map((flag) => [flag.name, flag.scope._tag, flag.required])
 * surface // => [["db-url", "Local", true], ["dry-run", "Local", false], ["profile", "Inherited", false]]
 * ```
 *
 * @see {@link Spec} for the returned shape
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const resolve = (
  command: Command.Any,
  path: ReadonlyArray<string>,
  options?: ResolveOptions | undefined
): Option.Option<Spec> => {
  const lineage = resolveLineage(command, path)
  if (lineage === undefined) return Option.none()

  const current = lineage[lineage.length - 1]
  const impl = toImpl(current)
  const builtIns = options?.builtIns ?? GlobalFlag.BuiltIns

  const flags: Array<Flag> = []
  const seen = new Set<string>()
  const addFlags = (params: ReadonlyArray<Param.AnyFlag>, scope: Scope): void => {
    for (const param of params) {
      for (const entry of collectEntries(param)) {
        if (entry.single.kind !== "flag") continue
        // Match help: an inherited name already supplied by a nearer scope
        // wins. Globals are deduplicated by identity only, since the parser
        // still routes their unshadowed names and aliases to the global flag.
        if (scope._tag === "Inherited" && seen.has(entry.single.name)) continue
        seen.add(entry.single.name)
        flags.push(toFlag(entry, scope))
      }
    }
  }

  addFlags(impl.config.flags, { _tag: "Local" })
  for (let index = 0; index < lineage.length - 1; index++) {
    addFlags(toImpl(lineage[index]).contextConfig.flags, {
      _tag: "Inherited",
      declaredBy: path.slice(0, index + 1)
    })
  }

  const seenGlobals = new Set<GlobalFlag.GlobalFlag<any>>()
  const addGlobals = (
    globals: ReadonlyArray<GlobalFlag.GlobalFlag<any>>,
    declaredBy: ReadonlyArray<string> | undefined
  ): void => {
    for (const global of globals) {
      if (seenGlobals.has(global)) continue
      seenGlobals.add(global)
      addFlags([global.flag], { _tag: "Global", declaredBy, kind: global._tag })
    }
  }
  addGlobals(builtIns, undefined)
  for (let index = 0; index < lineage.length; index++) {
    addGlobals(toImpl(lineage[index]).globalFlags, path.slice(0, index + 1))
  }

  const args: Array<Argument> = []
  for (const param of impl.config.arguments) {
    for (const entry of collectEntries(param)) {
      if (entry.single.kind !== "argument") continue
      args.push(toArgument(entry))
    }
  }

  const subcommands: Array<Subcommand> = []
  for (const group of current.subcommands) {
    for (const subcommand of group.commands) {
      subcommands.push({
        name: subcommand.name,
        alias: subcommand.alias,
        group: group.group,
        unlisted: subcommand.unlisted,
        shortDescription: subcommand.shortDescription,
        description: subcommand.description
      })
    }
  }

  return Option.some({
    path,
    name: current.name,
    alias: current.alias,
    description: current.description,
    shortDescription: current.shortDescription,
    unlisted: current.unlisted,
    examples: impl.resolveExamples(path),
    annotations: impl.annotations,
    flags,
    arguments: args,
    subcommands
  })
}

/**
 * Walks `path` from the root, matching canonical names only. Returns the
 * commands from root to leaf, or `undefined` when any segment fails to match.
 */
const resolveLineage = (
  root: Command.Any,
  path: ReadonlyArray<string>
): ReadonlyArray<Command.Any> | undefined => {
  if (path.length === 0 || path[0] !== root.name) return undefined
  const lineage: Array<Command.Any> = [root]
  for (let index = 1; index < path.length; index++) {
    const parent = lineage[lineage.length - 1]
    let next: Command.Any | undefined = undefined
    for (const group of parent.subcommands) {
      next = group.commands.find((subcommand) => subcommand.name === path[index])
      if (next !== undefined) break
    }
    if (next === undefined) return undefined
    lineage.push(next)
  }
  return lineage
}

/**
 * One `Single` parameter together with the facts derived from the combinators
 * on the path from the parameter's root down to it.
 */
interface Entry {
  readonly single: Param.Single<Param.ParamKind, unknown>
  readonly required: boolean
  readonly fallbacks: ReadonlyArray<Fallback>
  readonly variadic: VariadicBounds | undefined
}

/**
 * What the combinators above the current node have established, outermost
 * first. Once a variadic has been entered, the nodes beneath it describe each
 * item rather than the parameter, so they no longer change omission facts.
 */
interface PathState {
  readonly omittable: boolean
  /** Outermost first; reversed into consult order when an entry is emitted. */
  readonly fallbacks: ReadonlyArray<Fallback>
  readonly variadic: VariadicBounds | undefined
}

const initialState: PathState = { omittable: false, fallbacks: [], variadic: undefined }

const collectEntries = (param: Param.Any): Array<Entry> => {
  const entries: Array<Entry> = []
  const visit = (node: Param.Any, state: PathState): void => {
    switch (node._tag) {
      case "Single": {
        entries.push({
          single: node as Param.Single<Param.ParamKind, unknown>,
          required: !state.omittable,
          fallbacks: [...state.fallbacks].reverse(),
          variadic: state.variadic
        })
        return
      }
      case "Map":
        return visit((node as Param.Map<Param.ParamKind, unknown, unknown>).param, state)
      case "Transform": {
        const transform = node as Param.Transform<Param.ParamKind, unknown, unknown>
        const next = transform.fallback === undefined || state.variadic !== undefined
          ? state
          : { ...state, fallbacks: [...state.fallbacks, transform.fallback] }
        visit(transform.param, next)
        for (const alternative of transform.alternatives) {
          visit(alternative(), next)
        }
        return
      }
      case "Optional": {
        const optional = node as Param.Optional<Param.ParamKind, unknown>
        return visit(optional.param, state.variadic !== undefined ? state : { ...state, omittable: true })
      }
      case "Variadic": {
        const variadic = node as Param.Variadic<Param.ParamKind, unknown>
        if (state.variadic !== undefined) return visit(variadic.param, state)
        const min = Option.getOrUndefined(variadic.min)
        return visit(variadic.param, {
          omittable: state.omittable || min === undefined || min <= 0,
          fallbacks: state.fallbacks,
          variadic: { min, max: Option.getOrUndefined(variadic.max) }
        })
      }
    }
  }
  visit(param, initialState)
  return entries
}

const toArgument = ({ single, ...facts }: Entry): Argument => ({
  name: single.name,
  description: Option.getOrUndefined(single.description),
  type: toType(single.primitiveType),
  typeName: Primitive.getTypeName(single.primitiveType),
  metavar: single.typeName,
  annotations: single.annotations,
  ...facts
})

const toFlag = (entry: Entry, scope: Scope): Flag => {
  const { single } = entry
  const isBoolean = Primitive.isBoolean(single.primitiveType)
  return {
    ...toArgument(entry),
    aliases: single.aliases,
    hidden: single.hidden,
    // The runner parses an Action only when it is present on the command line.
    required: entry.required && !(scope._tag === "Global" && scope.kind === "Action"),
    optionalValue: single.optionalValue,
    negation: isBoolean && single.negation !== false ? single.negation ?? `no-${single.name}` : undefined,
    scope
  }
}

const toType = (primitive: Primitive.Primitive<unknown>): Type => {
  switch (primitive._tag) {
    case "Choice":
      return { _tag: "Choice", values: Primitive.getChoiceKeys(primitive) ?? [] }
    case "Path":
      return { _tag: "Path", pathType: Primitive.getPathType(primitive) ?? "either" }
    case "Boolean":
    case "Int":
    case "Finite":
    case "Date":
    case "Redacted":
    case "FileText":
    case "FileParse":
    case "FileSchema":
    case "KeyValuePair":
    case "Never":
      return { _tag: primitive._tag }
    default:
      return { _tag: "String" }
  }
}
