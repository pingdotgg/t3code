import {
  BUILT_IN_SLASH_COMMAND_NAMES,
  type UserCommand,
  type UserCommandSource,
} from "@t3tools/contracts";

export type ResolvedUserCommand = UserCommand & { readonly source: UserCommandSource };

const BUILT_IN_NAMES: ReadonlySet<string> = new Set(BUILT_IN_SLASH_COMMAND_NAMES);

/**
 * Project commands replace user-wide ones of the same name; a later entry replaces an earlier
 * one within a source. Built-in names are dropped and reported in `ignored`.
 */
export function resolveUserCommands(input: {
  readonly user: ReadonlyArray<UserCommand>;
  readonly project: ReadonlyArray<UserCommand>;
}): {
  readonly commands: ReadonlyArray<ResolvedUserCommand>;
  readonly ignored: ReadonlyArray<{ readonly name: string; readonly source: UserCommandSource }>;
} {
  const byName = new Map<string, ResolvedUserCommand>();
  const ignored: Array<{ name: string; source: UserCommandSource }> = [];
  for (const [source, commands] of [
    ["user", input.user],
    ["project", input.project],
  ] as const) {
    for (const command of commands) {
      if (BUILT_IN_NAMES.has(command.name)) {
        ignored.push({ name: command.name, source });
        continue;
      }
      byName.set(command.name, { ...command, source });
    }
  }
  return {
    commands: [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    ignored,
  };
}

/** Splits typed text on whitespace; single or double quotes keep spaces in one argument. */
export function splitCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** `~` and `~/…` (or `~\…`) become the home folder; anything else is unchanged. */
export function expandHome(
  argument: string,
  home: string,
  join: (...parts: ReadonlyArray<string>) => string,
): string {
  if (argument === "~") return home;
  if (argument.startsWith("~/") || argument.startsWith("~\\")) {
    return join(home, argument.slice(2));
  }
  return argument;
}
