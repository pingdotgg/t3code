import { NON_PROGRAM_PREFIX_CHARACTERS, NON_PROGRAM_SUFFIX_CHARACTERS, SHELL_OPTIONS_WITH_VALUE } from "./commandLabel-03-command.ts";
import type { CommandWrapper, Heredoc, ShellCommandSplit, ShellCommentRange, ShellSeparator } from "./commandLabel-03-command.ts";


export const TERMINAL_SHELL_PROGRAMS = new Set([
  "and",
  "begin",
  "break",
  "case",
  "catch",
  "continue",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "end",
  "esac",
  "eval",
  "exec",
  "exit",
  "false",
  "fi",
  "finally",
  "for",
  "foreach",
  "function",
  "if",
  "in",
  "not",
  "or",
  "repeat",
  "return",
  "select",
  "switch",
  "then",
  "try",
  "until",
  "while",
]);

export function shellCommandArgumentIndex(tokens: ReadonlyArray<string>, start: number): number | null {
  for (let index = start; index < tokens.length; index += 1) {
    const option = tokens[index]!;
    if (option === "--" || !option.startsWith("-")) return null;
    if (SHELL_OPTIONS_WITH_VALUE.has(option)) {
      index += 1;
      continue;
    }
    if (option === "--command" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(option)) return index + 1;
  }
  return null;
}

export const COMMAND_WRAPPER_OPTIONS_WITH_VALUE: Record<CommandWrapper, ReadonlySet<string>> = {
  env: new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]),
  sudo: new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-u", "--user"]),
};

export const COMMAND_WRAPPER_FLAGS: Record<CommandWrapper, ReadonlySet<string>> = {
  env: new Set(["-0", "--null", "-i", "--ignore-environment", "--debug", "-v"]),
  sudo: new Set(["-A", "--askpass", "-b", "--background", "-E", "-H", "-i", "-n", "-S"]),
};

export function tokenizeShellCommand(command: string): string[] | null {
  const input = command.trim();
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  let inBackticks = false;
  let substitutionDepth = 0;
  let parameterExpansionDepth = 0;
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaping) {
      current += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const nextCharacter = input[index + 1];
      const isWindowsPath = quote === null && /^(?:[A-Za-z]:|\.{1,2})(?:\\[^\s]*)?$/u.test(current);
      if (
        (quote === '"' || isWindowsPath) &&
        nextCharacter !== undefined &&
        nextCharacter !== '"' &&
        nextCharacter !== "\\" &&
        nextCharacter !== "$" &&
        nextCharacter !== "`" &&
        nextCharacter !== "\n"
      ) {
        current += character;
        tokenStarted = true;
        continue;
      }
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (inBackticks) {
      current += character;
      if (character === "`") inBackticks = false;
      tokenStarted = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "`") {
      current += character;
      inBackticks = true;
      tokenStarted = true;
      continue;
    }
    if (character === "$" && input[index + 1] === "{") {
      current += "${";
      parameterExpansionDepth += 1;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (character === "{" && parameterExpansionDepth > 0) {
      current += character;
      parameterExpansionDepth += 1;
      tokenStarted = true;
      continue;
    }
    if (character === "}" && parameterExpansionDepth > 0) {
      current += character;
      parameterExpansionDepth -= 1;
      tokenStarted = true;
      continue;
    }
    if (character === "$" && input[index + 1] === "(") {
      current += "$(";
      substitutionDepth += 1;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (character === "(") {
      current += character;
      substitutionDepth += 1;
      tokenStarted = true;
      continue;
    }
    if (character === ")" && substitutionDepth > 0) {
      current += character;
      substitutionDepth -= 1;
      tokenStarted = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (substitutionDepth > 0 || parameterExpansionDepth > 0) {
        current += character;
        tokenStarted = true;
        continue;
      }
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (
    quote !== null ||
    escaping ||
    inBackticks ||
    substitutionDepth > 0 ||
    parameterExpansionDepth > 0
  ) {
    return null;
  }
  if (tokenStarted) tokens.push(current);
  return tokens;
}

export function commandWithoutShellComments(
  command: string,
  end: number,
  comments: ReadonlyArray<ShellCommentRange>,
): string {
  let result = "";
  let cursor = 0;
  for (const comment of comments) {
    if (comment.start >= end) break;
    result += command.slice(cursor, comment.start);
    cursor = Math.min(comment.end, end);
  }
  return result + command.slice(cursor, end);
}

export function readHeredocDelimiter(
  command: string,
  start: number,
  stripTabs: boolean,
): { readonly heredoc: Heredoc; readonly end: number } | null {
  let index = start;
  while (command[index] === " " || command[index] === "\t") index += 1;

  let delimiter = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaping) {
      delimiter += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else delimiter += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character) || ";&|<>()".includes(character)) break;
    delimiter += character;
  }

  if (!delimiter || quote !== null || escaping) return null;
  return { heredoc: { delimiter, stripTabs }, end: index };
}

export function commandAfterHeredocs(
  command: string,
  start: number,
  heredocs: ReadonlyArray<Heredoc>,
): string | null {
  let cursor = start;
  for (const heredoc of heredocs) {
    let foundDelimiter = false;
    while (cursor <= command.length) {
      const newlineIndex = command.indexOf("\n", cursor);
      const lineEnd = newlineIndex === -1 ? command.length : newlineIndex;
      const line = command.slice(cursor, lineEnd).replace(/\r$/u, "");
      const comparableLine = heredoc.stripTabs ? line.replace(/^\t+/u, "") : line;
      cursor = newlineIndex === -1 ? command.length : newlineIndex + 1;
      if (comparableLine === heredoc.delimiter) {
        foundDelimiter = true;
        break;
      }
      if (newlineIndex === -1) break;
    }
    if (!foundDelimiter) return null;
  }

  return command.slice(cursor).trim() || null;
}

export function splitFirstShellCommand(command: string): ShellCommandSplit {
  let quote: '"' | "'" | null = null;
  let powerShellHereStringQuote: '"' | "'" | null = null;
  let escaping = false;
  let inBackticks = false;
  let inComment = false;
  let substitutionDepth = 0;
  let parameterExpansionDepth = 0;
  const heredocs: Heredoc[] = [];
  const comments: ShellCommentRange[] = [];
  let commentStart = 0;
  let separatorBeforeHeredocs: ShellSeparator | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (powerShellHereStringQuote !== null) {
      if (
        character === powerShellHereStringQuote &&
        command[index + 1] === "@" &&
        (index === 0 || command[index - 1] === "\n")
      ) {
        powerShellHereStringQuote = null;
        index += 1;
      }
      continue;
    }
    if (inComment) {
      if (character !== "\n") continue;
      inComment = false;
      comments.push({ start: commentStart, end: index });
    }
    if (escaping) {
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (inBackticks) {
      if (character === "`") inBackticks = false;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (
      character === "@" &&
      (command[index + 1] === '"' || command[index + 1] === "'") &&
      (command[index + 2] === "\n" || (command[index + 2] === "\r" && command[index + 3] === "\n"))
    ) {
      powerShellHereStringQuote = command[index + 1] as '"' | "'";
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "`") {
      inBackticks = true;
      continue;
    }
    if (
      character === "#" &&
      (index === 0 || /\s/u.test(command[index - 1]!) || ";&|(".includes(command[index - 1]!))
    ) {
      inComment = true;
      commentStart = index;
      continue;
    }
    if (character === "$" && command[index + 1] === "{") {
      parameterExpansionDepth += 1;
      index += 1;
      continue;
    }
    if (character === "{" && parameterExpansionDepth > 0) {
      parameterExpansionDepth += 1;
      continue;
    }
    if (character === "}" && parameterExpansionDepth > 0) {
      parameterExpansionDepth -= 1;
      continue;
    }
    if (character === "(") {
      substitutionDepth += 1;
      continue;
    }
    if (character === ")" && substitutionDepth > 0) {
      substitutionDepth -= 1;
      continue;
    }
    if (substitutionDepth > 0 || parameterExpansionDepth > 0) continue;

    if (character === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
      const stripTabs = command[index + 2] === "-";
      const delimiter = readHeredocDelimiter(command, index + (stripTabs ? 3 : 2), stripTabs);
      if (delimiter === null) {
        return { firstCommand: command.trim(), remainingCommand: null, separator: null };
      }
      heredocs.push(delimiter.heredoc);
      index = delimiter.end - 1;
      continue;
    }

    const isDoubleOperator =
      (character === "&" && command[index + 1] === "&") ||
      (character === "|" && (command[index + 1] === "|" || command[index + 1] === "&"));
    const isRedirectionAmpersand =
      character === "&" &&
      (command[index - 1] === ">" || command[index - 1] === "<" || command[index + 1] === ">");
    if ((!isDoubleOperator && !";&|\n".includes(character)) || isRedirectionAmpersand) continue;

    if (character === "\n" && heredocs.length > 0) {
      const separator = separatorBeforeHeredocs;
      const firstCommand = commandWithoutShellComments(
        command,
        separator?.index ?? index,
        comments,
      ).trimStart();
      const commandBeforeHeredocs = separator
        ? command.slice(separator.index + separator.length, index).trim()
        : "";
      const commandFollowingHeredocs = commandAfterHeredocs(command, index + 1, heredocs);
      const remainingCommand = [commandBeforeHeredocs, commandFollowingHeredocs]
        .filter((part): part is string => Boolean(part))
        .join("\n");
      return {
        firstCommand,
        remainingCommand: remainingCommand || null,
        separator: separator
          ? command.slice(separator.index, separator.index + separator.length)
          : "\n",
      };
    }
    if (heredocs.length > 0) {
      separatorBeforeHeredocs ??= {
        index,
        length: isDoubleOperator ? 2 : 1,
      };
      if (isDoubleOperator) index += 1;
      continue;
    }

    const firstCommand = commandWithoutShellComments(command, index, comments).trimStart();
    let nextCommandIndex = index + (isDoubleOperator ? 2 : 1);
    while (/\s/u.test(command[nextCommandIndex] ?? "")) nextCommandIndex += 1;
    const nextCommand = command.slice(nextCommandIndex).trim();
    return {
      firstCommand,
      remainingCommand: nextCommand || null,
      separator: isDoubleOperator ? command.slice(index, index + 2) : character,
    };
  }

  if (inComment) comments.push({ start: commentStart, end: command.length });
  return {
    firstCommand: commandWithoutShellComments(command, command.length, comments).trim(),
    remainingCommand: null,
    separator: null,
  };
}

export function commandWithoutLeadingShellComments(command: string): string | null {
  let remainingCommand = command.trimStart();
  while (remainingCommand.startsWith("#")) {
    const newlineIndex = remainingCommand.indexOf("\n");
    if (newlineIndex === -1) return null;
    remainingCommand = remainingCommand.slice(newlineIndex + 1).trimStart();
  }
  return remainingCommand || null;
}

export function withoutShellLineContinuations(command: string): string {
  let normalizedCommand = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaping) {
      normalizedCommand += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      if (command[index + 1] === "\n") {
        index += 1;
        continue;
      }
      if (command[index + 1] === "\r" && command[index + 2] === "\n") {
        index += 2;
        continue;
      }
      normalizedCommand += character;
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    }
    normalizedCommand += character;
  }

  return normalizedCommand;
}

export function indexAfterShellRedirection(tokens: ReadonlyArray<string>, index: number): number | null {
  const token = tokens[index];
  if (!token || /^[<>]\(/u.test(token)) return null;
  const match = token.match(
    /^(?:(?:(?:\d+|\*|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<-|<<|<>|>>|>\||<&|>&|<|>))|&>>|&>)(.*)$/u,
  );
  if (!match) return null;
  if (match[1]) return index + 1;
  return tokens[index + 1] === undefined ? tokens.length + 1 : index + 2;
}

export function serializeShellTokens(tokens: ReadonlyArray<string>): string {
  return tokens.map((token) => `'${token.replaceAll("'", "'\\''")}'`).join(" ");
}

export function transparentWrapperCommandIndex(
  wrapper: string,
  tokens: ReadonlyArray<string>,
  index: number,
): number | null {
  if (wrapper === "bundle") {
    return tokens[index + 1] === "exec" && tokens[index + 2] !== undefined ? index + 2 : null;
  }

  if (wrapper === "nohup") {
    let targetIndex = index + 1;
    if (tokens[targetIndex] === "--") targetIndex += 1;
    const target = tokens[targetIndex];
    return target && !target.startsWith("-") ? targetIndex : null;
  }

  if (wrapper === "script") {
    // BSD `script` takes an output file before the optional command. Requiring
    // an option and both operands avoids guessing about a plain `script file`.
    return /^-[adkpqr]+$/u.test(tokens[index + 1] ?? "") && tokens[index + 3] !== undefined
      ? index + 3
      : null;
  }

  if (wrapper === "arch") {
    if (/^-(?:arm64|arm64e|i386|x86_64)$/u.test(tokens[index + 1] ?? "")) {
      return tokens[index + 2] !== undefined ? index + 2 : null;
    }
    return tokens[index + 1] === "-arch" && tokens[index + 3] !== undefined ? index + 3 : null;
  }

  if (wrapper === "timeout" || wrapper === "gtimeout") {
    return /^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/u.test(tokens[index + 1] ?? "") &&
      tokens[index + 2] !== undefined
      ? index + 2
      : null;
  }

  return null;
}

export function staticProgramName(value: string): string | null {
  const trimmedValue = value.trim();
  if (!trimmedValue || /^[A-Za-z][A-Za-z0-9+.-]*:(?![\\/])/u.test(trimmedValue)) return null;
  const program = trimmedValue.split(/[\\/]/u).at(-1);
  if (
    !program ||
    (/\s/u.test(program) && !/[\\/]/u.test(trimmedValue)) ||
    NON_PROGRAM_PREFIX_CHARACTERS.includes(program[0] ?? "") ||
    NON_PROGRAM_SUFFIX_CHARACTERS.includes(program.at(-1) ?? "")
  ) {
    return null;
  }
  return program;
}

export function leadingPowerShellLiteral(command: string): string | null {
  const input = command.trimStart();
  const quote = input[0];
  if (quote !== '"' && quote !== "'") return staticProgramName(input.match(/^\S+/u)?.[0] ?? "");

  let value = "";
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === "`" && input[index + 1] !== undefined) {
      value += input[index + 1];
      index += 1;
      continue;
    }
    if (character === quote) {
      if (quote === "'" && input[index + 1] === "'") {
        value += "'";
        index += 1;
        continue;
      }
      return staticProgramName(value);
    }
    value += character;
  }
  return null;
}

export function powerShellCallOperatorProgramName(command: string): string | null | undefined {
  const match = command.match(/^\s*&\s+([\s\S]*)$/u);
  return match ? leadingPowerShellLiteral(match[1]!) : undefined;
}

export function literalAssignmentProgram(
  token: string,
): { readonly name: string; readonly program: string | null } | null {
  const assignment = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su);
  if (!assignment) return null;
  const name = assignment[1]!;
  let value = assignment[2]!.trim();
  if (!value || /[$`]/u.test(value)) return { name, program: null };

  if (value.startsWith("(") && value.endsWith(")")) {
    const arrayTokens = tokenizeShellCommand(value.slice(1, -1));
    value = arrayTokens?.[0] ?? "";
  } else if (/\s/u.test(value) && !/[\\/]/u.test(value)) {
    return { name, program: null };
  }

  return { name, program: staticProgramName(value) };
}

