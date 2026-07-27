import * as Console from "../../../Console.ts"
import * as Effect from "../../../Effect.ts"
import * as Option from "../../../Option.ts"
import * as Redacted from "../../../Redacted.ts"
import type * as Terminal from "../../../Terminal.ts"
import type * as CliError from "../CliError.ts"
import type * as Command from "../Command.ts"
import * as Param from "../Param.ts"
import * as Primitive from "../Primitive.ts"
import * as Prompt from "../Prompt.ts"
import * as Ansi from "./ansi.ts"
import { toImpl } from "./command.ts"

export interface Options {
  readonly commandPath?: ReadonlyArray<string> | undefined
  readonly prefix?: ReadonlyArray<string> | undefined
}

export const run: (
  command: Command.Command.Any,
  options?: Options
) => Effect.Effect<Array<string>, CliError.CliError | Terminal.QuitError, Command.Environment> = Effect.fnUntraced(
  function*(command, options) {
    const commandPath = options?.commandPath ?? [command.name]
    const selected = getCommandAtPath(command, commandPath)
    const commandLine = [...(options?.prefix ?? commandPath)]
    yield* logCurrentCommand(commandLine)
    yield* promptCommand(selected, commandLine, selected === command ? "ROOT" : selected.name)
    return commandLine
  }
)

const getCommandAtPath = (
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>
): Command.Command.Any => {
  let current = command
  for (const name of commandPath.slice(1)) {
    const child = current.subcommands
      .flatMap((group) => group.commands)
      .find((candidate) => candidate.name === name || candidate.alias === name)
    if (child === undefined) {
      break
    }
    current = child
  }
  return current
}

const promptCommand: (
  command: Command.Command.Any,
  commandLine: Array<string>,
  sectionName: string
) => Effect.Effect<void, CliError.CliError | Terminal.QuitError, Command.Environment> = Effect.fnUntraced(
  function*(command, commandLine, sectionName) {
    const impl = toImpl(command)
    const visibleSubcommands = command.subcommands.flatMap((group) => group.commands.filter((child) => !child.hidden))
    const config = visibleSubcommands.length === 0 ? impl.config : impl.contextConfig

    if (config.flags.length > 0) {
      yield* Console.log(renderSection(sectionName, "FLAGS"))
      for (const param of config.flags) {
        commandLine.push(...yield* promptParam(param))
      }
      if (config.arguments.length > 0 || visibleSubcommands.length > 0) {
        yield* logCurrentCommand(commandLine)
      }
    }

    if (config.arguments.length > 0) {
      yield* Console.log(renderSection(sectionName, "ARGUMENTS"))
      for (const param of config.arguments) {
        commandLine.push(...yield* promptParam(param))
      }
      if (visibleSubcommands.length > 0) {
        yield* logCurrentCommand(commandLine)
      }
    }

    if (visibleSubcommands.length === 0) {
      return
    }

    const child = yield* Prompt.run(Prompt.select({
      message: "Command",
      choices: visibleSubcommands.map((command) => ({
        title: command.name,
        value: command,
        ...(command.shortDescription !== undefined
          ? { description: command.shortDescription }
          : command.description !== undefined
          ? { description: command.description }
          : {})
      }))
    }))
    yield* Console.log()
    commandLine.push(child.name)
    if (hasWizardSteps(child)) {
      yield* logCurrentCommand(commandLine)
    }
    yield* promptCommand(child, commandLine, child.name)
  }
)

const hasWizardSteps = (command: Command.Command.Any): boolean => {
  const hasVisibleSubcommands = command.subcommands.some((group) => group.commands.some((child) => !child.hidden))
  return hasVisibleSubcommands || toImpl(command).config.orderedParams.length > 0
}

const promptParam: (
  param: Param.Any
) => Effect.Effect<Array<string>, CliError.CliError | Terminal.QuitError, Command.Environment> = Effect.fnUntraced(
  function*(param) {
    const single = Param.getUnderlyingSingleOrThrow(param)
    const metadata = Param.getParamMetadata(param)

    if (metadata.isOptional) {
      const include = yield* Prompt.run(Prompt.confirm({
        message: `Set ${renderParamLabel(single)}?`,
        initial: false
      }))
      if (!include) {
        yield* Console.log()
        return []
      }
    }

    const count = !metadata.isVariadic
      ? 1
      : yield* Prompt.run(Prompt.integer({
        message: `${renderParamLabel(single)} count`,
        default: Option.getOrElse(metadata.variadicMin, () => 0),
        min: Option.getOrElse(metadata.variadicMin, () => 0),
        ...(Option.isSome(metadata.variadicMax) ? { max: metadata.variadicMax.value } : {})
      }))
    const values: Array<string> = []
    for (let i = 0; i < count; i++) {
      values.push(yield* promptSingle(single))
    }

    const parsed = single.kind === Param.flagKind
      ? {
        flags: { [single.name]: values },
        arguments: []
      }
      : {
        flags: {},
        arguments: values
      }
    yield* param.parse(parsed)
    yield* Console.log()

    if (single.kind === Param.argumentKind) {
      return values
    }
    return values.flatMap((value) => [`--${single.name}`, value])
  }
)

const promptSingle = (
  single: Param.Single<Param.ParamKind, unknown>
): Effect.Effect<string, Terminal.QuitError, Command.Environment> => {
  const message = renderParamMessage(single)
  switch (single.primitiveType._tag) {
    case "Boolean":
      return Effect.map(
        Prompt.run(Prompt.confirm({
          message,
          label: {
            confirm: "true",
            deny: "false"
          },
          placeholder: {
            defaultConfirm: "(T/f)",
            defaultDeny: "(t/F)"
          }
        })),
        String
      )
    case "Choice": {
      const choices = Primitive.getChoiceKeys(single.primitiveType) ?? []
      return Prompt.run(Prompt.select({
        message,
        choices: choices.map((choice) => ({ title: choice, value: choice }))
      }))
    }
    case "Date":
      return Effect.map(Prompt.run(Prompt.date({ message })), (date) => date.toISOString())
    case "Float":
      return Effect.map(Prompt.run(Prompt.float({ message })), String)
    case "Integer":
      return Effect.map(Prompt.run(Prompt.integer({ message })), String)
    case "Redacted":
      return Effect.map(Prompt.run(Prompt.password({ message })), Redacted.value)
    default:
      return Prompt.run(Prompt.text({ message }))
  }
}

const formatName = (single: Param.Single<Param.ParamKind, unknown>): string =>
  single.kind === Param.flagKind ? `--${single.name}` : single.name

const renderParamMessage = (single: Param.Single<Param.ParamKind, unknown>): string => renderParamLabel(single)

const renderParamLabel = (single: Param.Single<Param.ParamKind, unknown>): string => {
  const description = Option.getOrUndefined(single.description)?.trim()
  const label = single.kind === Param.flagKind && description !== undefined && description.length <= 32
    ? description
    : humanize(single.name)
  return single.kind === Param.flagKind ? `${label} (${formatName(single)})` : label
}

const humanize = (name: string): string => {
  const words = name.split(/[-_]+/).filter((word) => word.length > 0)
  if (words.length === 0) return name
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(" ")
}

const logCurrentCommand = (commandLine: ReadonlyArray<string>): Effect.Effect<void> =>
  Console.log(renderCommandBlock("Current command", commandLine, Ansi.magenta))

const renderSection = (commandName: string, section: string): string =>
  `${Ansi.annotate(commandName.toUpperCase(), Ansi.bold, Ansi.cyanBright)} ${Ansi.annotate("·", Ansi.blackBright)} ${
    Ansi.annotate(section, Ansi.bold, Ansi.white)
  }`

export const renderIntroduction = (name: string, version: string, summary: string | undefined): string => {
  const title = `${Ansi.annotate(name, Ansi.bold, Ansi.cyanBright)} ${Ansi.annotate(`v${version}`, Ansi.white)} ${
    Ansi.annotate("· Command wizard", Ansi.bold, Ansi.white)
  }`
  return [
    title,
    ...(summary === undefined || summary.length === 0 ? [] : [summary]),
    Ansi.annotate("Build a command interactively. Press Ctrl+C to cancel.", Ansi.blackBright),
    ""
  ].join("\n")
}

export const renderCompletion = (commandLine: ReadonlyArray<string>): string =>
  renderCommandBlock("Command ready", commandLine, Ansi.cyanBright, Ansi.green)

export const renderQuit = (): string => `\n${Ansi.annotate("Wizard cancelled.", Ansi.red)}`

const renderCommandBlock = (
  label: string,
  commandLine: ReadonlyArray<string>,
  commandColor: string,
  labelColor: string = Ansi.white
): string => {
  const lines = wrapCommand(commandLine)
  return [
    Ansi.annotate(label, Ansi.bold, labelColor),
    ...lines.map((line) => Ansi.annotate(line, commandColor)),
    ""
  ].join("\n")
}

const wrapCommand = (commandLine: ReadonlyArray<string>): Array<string> => {
  const width = 88
  const firstIndent = "  $ "
  const continuationIndent = "    "
  const args = commandLine.map(formatShellArg)
  const lines: Array<string> = []
  let current = firstIndent

  for (const arg of args) {
    const separator = current === firstIndent || current === continuationIndent ? "" : " "
    if (current.length + separator.length + arg.length > width && current !== firstIndent) {
      lines.push(`${current} \\`)
      current = `${continuationIndent}${arg}`
    } else {
      current += `${separator}${arg}`
    }
  }

  if (current !== firstIndent) {
    lines.push(current)
  }
  return lines
}

const formatShellArg = (arg: string): string =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`
