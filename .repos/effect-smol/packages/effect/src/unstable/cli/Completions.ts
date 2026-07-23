/**
 * The `Completions` module turns a plain description of an Effect CLI command
 * tree into shell completion scripts for Bash, Zsh, and Fish. It is the
 * low-level script generation surface used by the unstable CLI package and by
 * the built-in completions global flag.
 *
 * **Mental model**
 *
 * - {@link CommandDescriptor} is a shell-agnostic tree of commands,
 *   subcommands, flags, and positional arguments.
 * - {@link FlagDescriptor} and {@link ArgumentDescriptor} carry just enough
 *   metadata for shells to complete names, choices, paths, and value-shaped
 *   arguments.
 * - {@link generate} selects the shell-specific generator and returns a static
 *   script string for one executable name.
 *
 * **Common tasks**
 *
 * - Generate an installable completion script with {@link generate}.
 * - Preserve help text in completions by filling descriptor descriptions.
 * - Use `Choice` descriptors for finite values and `Path` descriptors when the
 *   shell should complete files or directories.
 *
 * **Gotchas**
 *
 * - This module does not inspect a `Command` directly; it consumes an already
 *   built {@link CommandDescriptor}.
 * - Generated scripts are returned as strings. Printing, installing, or caching
 *   those scripts is handled by the caller.
 *
 * @since 4.0.0
 */
import * as Bash from "./internal/completions/bash.ts"
import * as Fish from "./internal/completions/fish.ts"
import * as Zsh from "./internal/completions/zsh.ts"

/**
 * Shell type used to generate completion scripts.
 *
 * @category models
 * @since 4.0.0
 */
export type Shell = "bash" | "zsh" | "fish"

/**
 * Describes a command for completion script generation.
 *
 * @category models
 * @since 4.0.0
 */
export interface CommandDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly flags: ReadonlyArray<FlagDescriptor>
  readonly arguments: ReadonlyArray<ArgumentDescriptor>
  readonly subcommands: ReadonlyArray<CommandDescriptor>
}

/**
 * Describes a command flag for completions.
 *
 * @category models
 * @since 4.0.0
 */
export interface FlagDescriptor {
  readonly name: string
  readonly aliases: ReadonlyArray<string>
  readonly description: string | undefined
  readonly type: FlagType
}

/**
 * Describes the supported flag value shapes.
 *
 * @category models
 * @since 4.0.0
 */
export type FlagType =
  | { readonly _tag: "Boolean" }
  | { readonly _tag: "String" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Float" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly pathType: "file" | "directory" | "either" }

/**
 * Describes a positional argument for completions.
 *
 * @category models
 * @since 4.0.0
 */
export interface ArgumentDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly required: boolean
  readonly variadic: boolean
  readonly type: ArgumentType
}

/**
 * Describes the supported argument value shapes.
 *
 * @category models
 * @since 4.0.0
 */
export type ArgumentType =
  | { readonly _tag: "String" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Float" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly pathType: "file" | "directory" | "either" }

/**
 * Generates a shell completion script for a command descriptor.
 *
 * **When to use**
 *
 * Use to produce an installable completion script when you already have a
 * `CommandDescriptor`.
 *
 * **Details**
 *
 * Dispatches by `shell` to Bash, Zsh, or Fish generation and returns a static
 * script string for `executableName`.
 *
 * @see {@link Shell} for supported shell names
 * @see {@link CommandDescriptor} for the command shape used by completion generation
 *
 * @category constructors
 * @since 4.0.0
 */
export const generate = (
  executableName: string,
  shell: Shell,
  descriptor: CommandDescriptor
): string => {
  switch (shell) {
    case "bash":
      return Bash.generate(executableName, descriptor)
    case "zsh":
      return Zsh.generate(executableName, descriptor)
    case "fish":
      return Fish.generate(executableName, descriptor)
  }
}
