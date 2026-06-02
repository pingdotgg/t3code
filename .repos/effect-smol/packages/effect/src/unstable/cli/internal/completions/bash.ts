/**
 * Static Bash completion script generator.
 *
 * Produces a self-contained completion script from a `CommandDescriptor` —
 * no re-invocation of the CLI at runtime.
 *
 * @internal
 */
import type * as Completions from "../../Completions.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const escapeForBash = (s: string): string => s.replace(/'/g, "'\\''")

const sanitizeFunctionName = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, "_")

const flagNamesForWordlist = (flag: Completions.FlagDescriptor): Array<string> => {
  const names: Array<string> = [`--${flag.name}`]
  for (const alias of flag.aliases) {
    names.push(alias.length === 1 ? `-${alias}` : `--${alias}`)
  }
  if (flag.type._tag === "Boolean") {
    names.push(`--no-${flag.name}`)
  }
  return names
}

/**
 * Build an associative array mapping each flag form to a group index.
 * At completion time, if any form in a group appears in COMP_WORDS,
 * all forms in that group are removed from the candidate list.
 */
const buildFlagGroupDeclarations = (
  flags: ReadonlyArray<Completions.FlagDescriptor>,
  lines: Array<string>
): void => {
  if (flags.length === 0) return
  lines.push(`  # Build used-flag filter`)
  lines.push(`  local -A _flag_groups`)
  let groupIdx = 0
  for (const flag of flags) {
    const forms = flagNamesForWordlist(flag)
    for (const form of forms) {
      lines.push(`  _flag_groups[${form}]=${groupIdx}`)
    }
    groupIdx++
  }
  lines.push(`  local -A _used_groups`)
  lines.push(`  for ((i = 1; i < cword; i++)); do`)
  lines.push(`    local _g="\${_flag_groups[\${words[i]}]:-}"`)
  lines.push(`    [[ -n "$_g" ]] && _used_groups[$_g]=1`)
  lines.push(`  done`)
  lines.push(`  local _filtered_flags=""`)
  lines.push(`  for _f in ${flags.flatMap(flagNamesForWordlist).join(" ")}; do`)
  lines.push(`    local _g="\${_flag_groups[$_f]:-}"`)
  lines.push(`    [[ -z "$_g" || -z "\${_used_groups[$_g]:-}" ]] && _filtered_flags+=" $_f"`)
  lines.push(`  done`)
  lines.push(``)
}

const flagValueCompletion = (type: Completions.FlagType): string | undefined => {
  switch (type._tag) {
    case "Boolean":
      return undefined
    case "Choice":
      return `COMPREPLY=( $(compgen -W '${type.values.join(" ")}' -- "$cur") )`
    case "Path":
      if (type.pathType === "directory") return `COMPREPLY=( $(compgen -d -- "$cur") )`
      return `COMPREPLY=( $(compgen -f -- "$cur") )`
    default:
      return undefined
  }
}

const argCompletion = (type: Completions.ArgumentType): string | undefined => {
  switch (type._tag) {
    case "Choice":
      return `COMPREPLY=( $(compgen -W '${type.values.join(" ")}' -- "$cur") )`
    case "Path":
      if (type.pathType === "directory") return `COMPREPLY=( $(compgen -d -- "$cur") )`
      return `COMPREPLY=( $(compgen -f -- "$cur") )`
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

const generateFunction = (
  descriptor: Completions.CommandDescriptor,
  parentPath: ReadonlyArray<string>,
  lines: Array<string>
): void => {
  const currentPath = [...parentPath, descriptor.name]
  const funcName = `_${currentPath.map(sanitizeFunctionName).join("_")}`

  lines.push(`${funcName}()`)
  lines.push(`{`)
  lines.push(`  local cur prev words cword`)
  lines.push(`  _init_completion || return`)
  lines.push(``)

  // Build flag-value dispatch
  const flagsWithValues = descriptor.flags.filter((f) => f.type._tag !== "Boolean")
  if (flagsWithValues.length > 0) {
    lines.push(`  # Flag value completions`)
    lines.push(`  case "$prev" in`)
    for (const flag of flagsWithValues) {
      const longNames = [`--${flag.name}`]
      for (const alias of flag.aliases) {
        longNames.push(alias.length === 1 ? `-${alias}` : `--${alias}`)
      }
      const completion = flagValueCompletion(flag.type)
      if (completion) {
        lines.push(`    ${longNames.join("|")})`)
        lines.push(`      ${completion}`)
        lines.push(`      return`)
        lines.push(`      ;;`)
      }
    }
    lines.push(`  esac`)
    lines.push(``)
  }

  // Subcommand dispatch
  if (descriptor.subcommands.length > 0) {
    lines.push(`  # Subcommand dispatch`)
    lines.push(`  local i cmd`)
    lines.push(`  for ((i = 1; i < cword; i++)); do`)
    lines.push(`    case "\${words[i]}" in`)
    for (const sub of descriptor.subcommands) {
      const subFuncName = `_${[...currentPath, sub.name].map(sanitizeFunctionName).join("_")}`
      lines.push(`      ${sub.name})`)
      lines.push(`        ${subFuncName}`)
      lines.push(`        return`)
      lines.push(`        ;;`)
    }
    lines.push(`    esac`)
    lines.push(`  done`)
    lines.push(``)
  }

  // Filter already-used flags (entire alias group removed when any form is used)
  buildFlagGroupDeclarations(descriptor.flags, lines)

  if (descriptor.flags.length > 0 || descriptor.subcommands.length > 0) {
    lines.push(`  # Complete flags (filtered) and subcommands`)
    lines.push(`  if [[ "$cur" == -* ]]; then`)
    if (descriptor.flags.length > 0) {
      lines.push(`    COMPREPLY=( $(compgen -W "$_filtered_flags" -- "$cur") )`)
    }
    lines.push(`    return`)
    lines.push(`  fi`)
    lines.push(``)
  }

  // Positional argument completion
  const argsWithCompletions = descriptor.arguments.filter((a) => argCompletion(a.type) !== undefined)
  if (argsWithCompletions.length > 0) {
    lines.push(`  # Positional argument completions`)
    for (const arg of argsWithCompletions) {
      const comp = argCompletion(arg.type)!
      lines.push(`  ${comp}`)
      lines.push(`  return`)
    }
  } else if (descriptor.subcommands.length > 0) {
    const subNames = descriptor.subcommands.map((s) => s.name)
    lines.push(`  COMPREPLY=( $(compgen -W '${subNames.join(" ")}' -- "$cur") )`)
  }

  lines.push(`}`)
  lines.push(``)

  // Recurse into subcommands
  for (const sub of descriptor.subcommands) {
    generateFunction(sub, currentPath, lines)
  }
}

/** @internal */
export const generate = (
  executableName: string,
  descriptor: Completions.CommandDescriptor
): string => {
  const lines: Array<string> = []
  const safeName = sanitizeFunctionName(executableName)

  lines.push(`###-begin-${escapeForBash(executableName)}-completions-###`)
  lines.push(`#`)
  lines.push(`# Static completion script for Bash`)
  lines.push(`#`)
  lines.push(`# Installation:`)
  lines.push(`#   ${escapeForBash(executableName)} --completions bash >> ~/.bashrc`)
  lines.push(`#`)
  lines.push(``)

  // Inline minimal _init_completion fallback for environments without
  // bash-completion installed. The real _init_completion handles edge cases
  // (= in options, redirections, etc.) but this covers the common path.
  lines.push(`if ! type _init_completion &>/dev/null; then`)
  lines.push(`  _init_completion()`)
  lines.push(`  {`)
  lines.push(`    COMPREPLY=()`)
  lines.push(`    cur="\${COMP_WORDS[COMP_CWORD]}"`)
  lines.push(`    prev="\${COMP_WORDS[COMP_CWORD-1]}"`)
  lines.push(`    words=("\${COMP_WORDS[@]}")`)
  lines.push(`    cword=$COMP_CWORD`)
  lines.push(`  }`)
  lines.push(`fi`)
  lines.push(``)

  generateFunction(descriptor, [], lines)

  lines.push(`complete -F _${safeName} ${escapeForBash(executableName)}`)
  lines.push(`###-end-${escapeForBash(executableName)}-completions-###`)

  return lines.join("\n")
}
