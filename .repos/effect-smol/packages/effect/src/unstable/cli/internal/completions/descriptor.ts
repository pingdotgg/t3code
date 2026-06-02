/**
 * CommandDescriptor — pure-data representation of a command tree for
 * shell completion generation.
 *
 * @internal
 */
import * as Option from "../../../../Option.ts"
import type { Command } from "../../Command.ts"
import type * as Completions from "../../Completions.ts"
import * as Param from "../../Param.ts"
import * as Primitive from "../../Primitive.ts"
import { toImpl } from "../command.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toFlagType = (single: Param.Single<"flag", unknown>): Completions.FlagType => {
  const tag = single.primitiveType._tag
  switch (tag) {
    case "Boolean":
      return { _tag: "Boolean" }
    case "Integer":
      return { _tag: "Integer" }
    case "Float":
      return { _tag: "Float" }
    case "Date":
      return { _tag: "Date" }
    case "Choice": {
      const keys = Primitive.getChoiceKeys(single.primitiveType)
      return { _tag: "Choice", values: keys ?? [] }
    }
    case "Path": {
      const typeName = single.typeName
      const pathType: "file" | "directory" | "either" = typeName === "file"
        ? "file"
        : typeName === "directory"
        ? "directory"
        : "either"
      return { _tag: "Path", pathType }
    }
    default:
      return { _tag: "String" }
  }
}

const toArgumentType = (single: Param.Single<"argument", unknown>): Completions.ArgumentType => {
  const tag = single.primitiveType._tag
  switch (tag) {
    case "Integer":
      return { _tag: "Integer" }
    case "Float":
      return { _tag: "Float" }
    case "Date":
      return { _tag: "Date" }
    case "Choice": {
      const keys = Primitive.getChoiceKeys(single.primitiveType)
      return { _tag: "Choice", values: keys ?? [] }
    }
    case "Path": {
      const typeName = single.typeName
      const pathType: "file" | "directory" | "either" = typeName === "file"
        ? "file"
        : typeName === "directory"
        ? "directory"
        : "either"
      return { _tag: "Path", pathType }
    }
    default:
      return { _tag: "String" }
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** @internal */
export const fromCommand = (cmd: Command.Any): Completions.CommandDescriptor => {
  const impl = toImpl(cmd)
  const config = impl.config

  const flags: Array<Completions.FlagDescriptor> = []
  for (const flag of config.flags) {
    const singles = Param.extractSingleParams(flag)
    for (const single of singles) {
      if (single.kind !== "flag") continue
      // Omit hidden flags from completion scripts so tab-completion in the
      // shell does not advertise flags that are absent from --help.
      if (single.hidden) continue
      flags.push({
        name: single.name,
        aliases: single.aliases,
        description: Option.getOrUndefined(single.description),
        type: toFlagType(single as Param.Single<"flag", unknown>)
      })
    }
  }

  const args: Array<Completions.ArgumentDescriptor> = []
  for (const arg of config.arguments) {
    const singles = Param.extractSingleParams(arg)
    const metadata = Param.getParamMetadata(arg)
    for (const single of singles) {
      if (single.kind !== "argument") continue
      args.push({
        name: single.name,
        description: Option.getOrUndefined(single.description),
        required: !metadata.isOptional,
        variadic: metadata.isVariadic,
        type: toArgumentType(single as Param.Single<"argument", unknown>)
      })
    }
  }

  const subcommands: Array<Completions.CommandDescriptor> = []
  for (const group of cmd.subcommands) {
    for (const subcommand of group.commands) {
      // Omit hidden subcommands from completion scripts so tab-completion in
      // the shell does not advertise commands that are absent from --help.
      if (subcommand.hidden) continue
      subcommands.push(fromCommand(subcommand))
    }
  }

  return {
    name: cmd.name,
    description: cmd.shortDescription ?? cmd.description,
    flags,
    arguments: args,
    subcommands
  }
}
