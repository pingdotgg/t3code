type CommandWrapper = "env" | "sudo";
type CommandProgramContext = "exec" | "shell";

const MAX_COMMAND_SEGMENTS = 64;

const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
const WINDOWS_SHELL_PROGRAMS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);
const SHELL_OPTIONS_WITH_VALUE = new Set(["-o", "-O", "--rcfile", "--init-file"]);
const SHELL_COMMAND_WRAPPERS = new Set(["builtin", "command", "exec"]);
const SHELL_PRECOMMAND_MODIFIERS = new Set(["nocorrect", "noglob", "time"]);
const POWERSHELL_SETUP_PROGRAMS = new Set(["pop-location", "push-location", "set-location"]);
const POWERSHELL_FLAGS = new Set(["-mta", "-nologo", "-noninteractive", "-noprofile", "-sta"]);
const POWERSHELL_OPTIONS_WITH_VALUE = new Set([
  "-configurationname",
  "-executionpolicy",
  "-inputformat",
  "-outputformat",
  "-version",
  "-windowstyle",
  "-workingdirectory",
]);
const START_PROCESS_FLAGS = new Set([
  "-confirm",
  "-debug",
  "-loaduserprofile",
  "-nonewwindow",
  "-passthru",
  "-usenewenvironment",
  "-verbose",
  "-wait",
  "-whatif",
]);
const START_PROCESS_OPTIONS_WITH_VALUE = new Set([
  "-argumentlist",
  "-credential",
  "-environment",
  "-erroraction",
  "-errorvariable",
  "-informationaction",
  "-informationvariable",
  "-outbuffer",
  "-outvariable",
  "-pipelinevariable",
  "-progressaction",
  "-redirectstandarderror",
  "-redirectstandardinput",
  "-redirectstandardoutput",
  "-verb",
  "-warningaction",
  "-warningvariable",
  "-windowstyle",
  "-workingdirectory",
]);
const SKIPPABLE_SUDO_PROBES = new Set(["[", "[[", "test", "true"]);
const NON_PROGRAM_PREFIX_CHARACTERS = "<>(){}[];|&$`#!%@:";
const NON_PROGRAM_SUFFIX_CHARACTERS = "){]}`";

// These tokens describe shell syntax or shell-local control flow, not a useful
// executable name. Falling back to "command" is less misleading than labels
// such as "Ran if", "Ran [", or "Ran function".
const NON_DESCRIPTIVE_SHELL_PROGRAMS = new Set([
  "!",
  "#",
  ".",
  ":",
  "[",
  "[[",
  "alias",
  "and",
  "autoload",
  "begin",
  "bg",
  "bind",
  "bindkey",
  "break",
  "builtin",
  "caller",
  "case",
  "catch",
  "cd",
  "command",
  "compgen",
  "complete",
  "compopt",
  "continue",
  "coproc",
  "declare",
  "dirs",
  "disown",
  "do",
  "done",
  "elif",
  "else",
  "enable",
  "end",
  "esac",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "fi",
  "finally",
  "for",
  "foreach",
  "function",
  "getopts",
  "history",
  "if",
  "in",
  "jobs",
  "let",
  "local",
  "logout",
  "mapfile",
  "nocorrect",
  "noglob",
  "not",
  "or",
  "popd",
  "pushd",
  "read",
  "readarray",
  "readonly",
  "repeat",
  "return",
  "select",
  "set",
  "setopt",
  "shift",
  "shopt",
  "source",
  "switch",
  "suspend",
  "test",
  "then",
  "time",
  "times",
  "trap",
  "try",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "until",
  "unset",
  "unsetopt",
  "wait",
  "while",
]);

// Unlike setup builtins, these can make later segments part of control flow or
// otherwise unreachable, so do not use a later program as the command label.
const TERMINAL_SHELL_PROGRAMS = new Set([
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

function shellCommandArgumentIndex(tokens: ReadonlyArray<string>, start: number): number | null {
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

const COMMAND_WRAPPER_OPTIONS_WITH_VALUE: Record<CommandWrapper, ReadonlySet<string>> = {
  env: new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]),
  sudo: new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-u", "--user"]),
};

const COMMAND_WRAPPER_FLAGS: Record<CommandWrapper, ReadonlySet<string>> = {
  env: new Set(["-0", "--null", "-i", "--ignore-environment", "--debug", "-v"]),
  sudo: new Set(["-A", "--askpass", "-b", "--background", "-E", "-H", "-i", "-n", "-S"]),
};

function tokenizeShellCommand(command: string): string[] | null {
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

type ShellCommandSplit = {
  readonly firstCommand: string;
  readonly remainingCommand: string | null;
  readonly separator: string | null;
};

type Heredoc = {
  readonly delimiter: string;
  readonly stripTabs: boolean;
};

type ShellSeparator = {
  readonly index: number;
  readonly length: number;
};

type ShellCommentRange = {
  readonly start: number;
  readonly end: number;
};

function commandWithoutShellComments(
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

function readHeredocDelimiter(
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

function commandAfterHeredocs(
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

function splitFirstShellCommand(command: string): ShellCommandSplit {
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

function commandWithoutLeadingShellComments(command: string): string | null {
  let remainingCommand = command.trimStart();
  while (remainingCommand.startsWith("#")) {
    const newlineIndex = remainingCommand.indexOf("\n");
    if (newlineIndex === -1) return null;
    remainingCommand = remainingCommand.slice(newlineIndex + 1).trimStart();
  }
  return remainingCommand || null;
}

function withoutShellLineContinuations(command: string): string {
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

function indexAfterShellRedirection(tokens: ReadonlyArray<string>, index: number): number | null {
  const token = tokens[index];
  if (!token || /^[<>]\(/u.test(token)) return null;
  const match = token.match(
    /^(?:(?:(?:\d+|\*|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<-|<<|<>|>>|>\||<&|>&|<|>))|&>>|&>)(.*)$/u,
  );
  if (!match) return null;
  if (match[1]) return index + 1;
  return tokens[index + 1] === undefined ? tokens.length + 1 : index + 2;
}

function serializeShellTokens(tokens: ReadonlyArray<string>): string {
  return tokens.map((token) => `'${token.replaceAll("'", "'\\''")}'`).join(" ");
}

function transparentWrapperCommandIndex(
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

function staticProgramName(value: string): string | null {
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

function leadingPowerShellLiteral(command: string): string | null {
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

function powerShellCallOperatorProgramName(command: string): string | null | undefined {
  const match = command.match(/^\s*&\s+([\s\S]*)$/u);
  return match ? leadingPowerShellLiteral(match[1]!) : undefined;
}

type PowerShellAssignment = {
  readonly matched: boolean;
  readonly program: string | null;
};

function powerShellAssignmentProgramName(
  command: string,
  depth: number,
  remainingCommand: string | null,
  segmentsRemaining: number,
): PowerShellAssignment {
  const assignment = command.match(
    /^\s*\$(?:(env|global|local|script):)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*([\s\S]*)$/iu,
  );
  if (!assignment) return { matched: false, program: null };

  // Environment assignments are setup. Their right-hand side is a value, not
  // a command, so prefer the next top-level segment when one exists.
  if (assignment[1]?.toLowerCase() === "env") {
    return {
      matched: true,
      program: remainingCommand
        ? commandProgramNameInternal(remainingCommand, depth, "shell", segmentsRemaining - 1)
        : null,
    };
  }

  const value = assignment[2]!.trim();
  // The POSIX-oriented segment splitter does not balance PowerShell arrays or
  // hashtables. Do not mistake a key after an internal semicolon for a command.
  if (/^(?:\[ordered\]\s*)?@\s*[{(]/iu.test(value)) {
    return { matched: true, program: null };
  }
  const calledProgram = powerShellCallOperatorProgramName(value);
  if (calledProgram !== undefined) return { matched: true, program: calledProgram };

  const directCommand = value.match(/^(?:@?\(\s*)?([A-Za-z][A-Za-z0-9_.-]*)\b/u)?.[1];
  if (directCommand && !NON_DESCRIPTIVE_SHELL_PROGRAMS.has(directCommand.toLowerCase())) {
    const parsedCommand = commandProgramNameInternal(value, depth + 1, "shell", segmentsRemaining);
    return { matched: true, program: parsedCommand ?? directCommand };
  }

  return {
    matched: true,
    program: remainingCommand
      ? commandProgramNameInternal(remainingCommand, depth, "shell", segmentsRemaining - 1)
      : null,
  };
}

type WindowsShellPayload = {
  readonly matched: boolean;
  readonly program: string | null;
};

function windowsShellPayloadProgramName(
  shell: string,
  tokens: ReadonlyArray<string>,
  start: number,
  depth: number,
  remainingCommand: string | null,
  separator: string | null,
  segmentsRemaining: number,
): WindowsShellPayload {
  const parsePayload = (payload: string | undefined): string | null => {
    if (!payload) return null;
    const command =
      remainingCommand && separator ? `${payload} ${separator} ${remainingCommand}` : payload;
    return commandProgramNameInternal(command, depth + 1, "shell", segmentsRemaining);
  };

  if (shell === "cmd" || shell === "cmd.exe") {
    for (let index = start; index < tokens.length; index += 1) {
      const option = tokens[index]!.toLowerCase();
      if (option !== "/c" && option !== "/k") continue;
      const payload = tokens[index + 1];
      return {
        matched: true,
        program: parsePayload(payload),
      };
    }
    return { matched: false, program: null };
  }

  for (let index = start; index < tokens.length; index += 1) {
    const option = tokens[index]!.toLowerCase();
    if (option === "-command" || option === "-c") {
      const payload = tokens[index + 1];
      return {
        matched: true,
        program: parsePayload(payload),
      };
    }
    if (option === "-file" || option === "-f") {
      return { matched: true, program: staticProgramName(tokens[index + 1] ?? "") };
    }
    if (option === "-encodedcommand" || option === "-enc" || option === "-e") {
      return { matched: true, program: null };
    }
    if (POWERSHELL_OPTIONS_WITH_VALUE.has(option)) {
      index += 1;
      continue;
    }
    if (POWERSHELL_FLAGS.has(option)) continue;
    if (!option.startsWith("-")) {
      return { matched: true, program: staticProgramName(tokens[index]!) };
    }
  }
  return { matched: false, program: null };
}

function startProcessProgramName(tokens: ReadonlyArray<string>, start: number): string | null {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const option = token.toLowerCase();
    if (option === "-filepath") return staticProgramName(tokens[index + 1] ?? "");
    if (START_PROCESS_FLAGS.has(option)) continue;
    if (START_PROCESS_OPTIONS_WITH_VALUE.has(option)) {
      if (tokens[index + 1] === undefined) return null;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return null;
    return staticProgramName(token);
  }
  return null;
}

function literalAssignmentProgram(
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

function referencedCommandAlias(token: string): string | null {
  const reference = token.match(
    /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?:\[@\])?\})$/u,
  );
  return reference?.[1] ?? reference?.[2] ?? null;
}

// Recover only literal aliases declared by an earlier top-level shell segment.
// This covers common `SSH=(ssh ...)` and `TOOL=/path/to/tool` forms without
// evaluating expansions or trying to model general shell state.
function literalCommandAliasProgramName(command: string): string | null {
  const aliases = new Map<string, string>();
  let remainingCommand: string | null = command;
  let controlFlowDepth = 0;

  for (let segmentCount = 0; remainingCommand && segmentCount < 64; segmentCount += 1) {
    const commandWithoutComments = commandWithoutLeadingShellComments(remainingCommand);
    if (commandWithoutComments === null) return null;
    const commandSplit = splitFirstShellCommand(commandWithoutComments);
    const tokens = tokenizeShellCommand(withoutShellLineContinuations(commandSplit.firstCommand));
    if (tokens === null) return null;

    let commandIndex = tokens[0] === "do" || tokens[0] === "then" ? 1 : 0;
    while (commandIndex < tokens.length) {
      const indexAfterRedirection = indexAfterShellRedirection(tokens, commandIndex);
      if (indexAfterRedirection !== null && indexAfterRedirection <= tokens.length) {
        commandIndex = indexAfterRedirection;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(tokens[commandIndex] ?? "")) {
        commandIndex += 1;
        continue;
      }
      break;
    }

    const aliasName = referencedCommandAlias(tokens[commandIndex] ?? "");
    const aliasedProgram = aliasName ? aliases.get(aliasName) : undefined;
    if (aliasedProgram) return aliasedProgram;

    const leadingToken = tokens[0];
    if (leadingToken === "fi" || leadingToken === "done" || leadingToken === "esac") {
      controlFlowDepth = Math.max(0, controlFlowDepth - 1);
    }
    if (
      leadingToken === "if" ||
      leadingToken === "for" ||
      leadingToken === "while" ||
      leadingToken === "until" ||
      leadingToken === "select" ||
      leadingToken === "case"
    ) {
      controlFlowDepth += 1;
    }

    if (controlFlowDepth === 0 && leadingToken === "unset") {
      for (const name of tokens.slice(1)) aliases.delete(name);
    }

    const assignmentStart = tokens[0] === "export" ? 1 : 0;
    const assignments = tokens.slice(assignmentStart).map(literalAssignmentProgram);
    if (
      controlFlowDepth === 0 &&
      assignments.length > 0 &&
      assignments.every((assignment) => assignment !== null)
    ) {
      for (const assignment of assignments) {
        if (assignment.program) aliases.set(assignment.name, assignment.program);
        else aliases.delete(assignment.name);
      }
    }

    remainingCommand = commandSplit.remainingCommand;
  }

  return null;
}

function wrappedShellCommandProgramName(
  wrapper: string,
  tokens: ReadonlyArray<string>,
  start: number,
  depth: number,
  remainingCommand: string | null,
  segmentsRemaining: number,
): string | null {
  let index = start;

  if (wrapper === "command") {
    while (index < tokens.length) {
      const option = tokens[index]!;
      if (option === "--") {
        index += 1;
        break;
      }
      if (!option.startsWith("-") || option === "-") break;
      if (option !== "-p") return null;
      index += 1;
    }
  } else if (wrapper === "builtin") {
    if (tokens[index] === "--") index += 1;
    else if (tokens[index]?.startsWith("-")) return null;
  } else if (wrapper === "exec") {
    while (index < tokens.length) {
      const option = tokens[index]!;
      if (option === "--") {
        index += 1;
        break;
      }
      if (option === "-a") {
        if (tokens[index + 1] === undefined) return null;
        index += 2;
        continue;
      }
      if (/^-a.+/u.test(option) || /^-[cl]+$/u.test(option)) {
        index += 1;
        continue;
      }
      if (option.startsWith("-") && option !== "-") return null;
      break;
    }
  }

  const wrappedTokens = tokens.slice(index);
  if (wrappedTokens.length === 0) return null;
  let targetIndex = 0;
  while (targetIndex < wrappedTokens.length) {
    const indexAfterRedirection = indexAfterShellRedirection(wrappedTokens, targetIndex);
    if (indexAfterRedirection === null || indexAfterRedirection > wrappedTokens.length) break;
    targetIndex = indexAfterRedirection;
  }
  const target = wrappedTokens[targetIndex];
  if (target && /^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(target)) return null;

  const wrappedProgram = commandProgramNameInternal(
    serializeShellTokens(wrappedTokens),
    depth + 1,
    wrapper === "exec" ? "exec" : "shell",
    segmentsRemaining,
  );
  if (wrappedProgram !== null) return wrappedProgram;

  if (
    wrapper !== "exec" &&
    target &&
    target === target.toLowerCase() &&
    NON_DESCRIPTIVE_SHELL_PROGRAMS.has(target) &&
    !TERMINAL_SHELL_PROGRAMS.has(target) &&
    remainingCommand
  ) {
    return commandProgramNameInternal(remainingCommand, depth, "shell", segmentsRemaining - 1);
  }
  return null;
}

function parseCommandProgramName(
  command: string,
  depth: number,
  context: CommandProgramContext,
  segmentsRemaining: number,
): string | null {
  if (depth >= 8 || segmentsRemaining <= 0) return null;
  const commandWithoutComments = commandWithoutLeadingShellComments(command);
  if (commandWithoutComments === null) return null;
  if (
    /^(?:catch|finally|for|foreach|function|if|param|switch|try|while)\s*[{(]/iu.test(
      commandWithoutComments,
    )
  ) {
    return null;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/u.test(commandWithoutComments)) return null;
  // `&&` and `||` inside a `[[ ... ]]` expression are not top-level command
  // separators. Keep the label conservative instead of scanning the test body.
  if (commandWithoutComments.startsWith("[[")) return null;
  const commandSplit = splitFirstShellCommand(commandWithoutComments);
  if (/^@["'](?:\r?\n)/u.test(commandSplit.firstCommand.trimStart())) {
    return commandSplit.remainingCommand
      ? commandProgramNameInternal(
          commandSplit.remainingCommand,
          depth,
          "shell",
          segmentsRemaining - 1,
        )
      : null;
  }
  const powerShellAssignment = powerShellAssignmentProgramName(
    commandSplit.firstCommand,
    depth,
    commandSplit.remainingCommand,
    segmentsRemaining,
  );
  if (powerShellAssignment.matched) return powerShellAssignment.program;
  const windowsPath = commandSplit.firstCommand.match(
    /^\s*((?:\.{1,2}|%[A-Za-z_][A-Za-z0-9_]*%|\$env:[A-Za-z_][A-Za-z0-9_]*)\\\S+)/iu,
  )?.[1];
  if (windowsPath) return staticProgramName(windowsPath);
  const tokens = tokenizeShellCommand(withoutShellLineContinuations(commandSplit.firstCommand));
  if (tokens === null) return null;
  const firstCharacter = commandSplit.firstCommand.trimStart()[0];
  if (
    tokens.length === 1 &&
    (firstCharacter === '"' || firstCharacter === "'") &&
    /[\s()=]/u.test(tokens[0] ?? "") &&
    !/[\\/]/u.test(tokens[0] ?? "")
  ) {
    return commandSplit.remainingCommand
      ? commandProgramNameInternal(
          commandSplit.remainingCommand,
          depth,
          context,
          segmentsRemaining - 1,
        )
      : null;
  }
  let index = 0;
  let wrapper: CommandWrapper | null = null;
  let executionContext = context;
  let sawAssignment = false;
  let sawRedirection = false;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) return null;
    const indexAfterRedirection = indexAfterShellRedirection(tokens, index);
    if (indexAfterRedirection !== null) {
      if (indexAfterRedirection > tokens.length) return null;
      sawRedirection = true;
      index = indexAfterRedirection;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(token)) {
      sawAssignment = true;
      index += 1;
      continue;
    }
    if (executionContext === "shell" && token === ":") {
      return commandSplit.remainingCommand
        ? commandProgramNameInternal(
            commandSplit.remainingCommand,
            depth,
            executionContext,
            segmentsRemaining - 1,
          )
        : null;
    }
    if (
      NON_PROGRAM_PREFIX_CHARACTERS.includes(token[0] ?? "") &&
      !(token.startsWith("$") && token.includes("/"))
    ) {
      return executionContext === "shell" && token.startsWith("[") && commandSplit.remainingCommand
        ? commandProgramNameInternal(
            commandSplit.remainingCommand,
            depth,
            executionContext,
            segmentsRemaining - 1,
          )
        : null;
    }
    const tokenProgram = token.split(/[\\/]/).at(-1);
    const isUnqualifiedToken = token === tokenProgram;
    if (tokenProgram === "env" || tokenProgram === "sudo") {
      wrapper = tokenProgram;
      executionContext = "exec";
      index += 1;
      continue;
    }
    if (wrapper !== null && token === "--") {
      wrapper = null;
      index += 1;
      continue;
    }
    if (wrapper !== null && token.startsWith("-")) {
      if (wrapper === "env" && (token === "-S" || token === "--split-string")) {
        const splitCommand = tokens[index + 1];
        return splitCommand
          ? commandProgramNameInternal(splitCommand, depth + 1, executionContext, segmentsRemaining)
          : null;
      }
      if (wrapper === "env" && token.startsWith("--split-string=")) {
        return commandProgramNameInternal(
          token.slice("--split-string=".length),
          depth + 1,
          executionContext,
          segmentsRemaining,
        );
      }
      if (COMMAND_WRAPPER_OPTIONS_WITH_VALUE[wrapper].has(token)) {
        if (tokens[index + 1] === undefined) return null;
        index += 2;
        continue;
      }
      if (COMMAND_WRAPPER_FLAGS[wrapper].has(token)) {
        index += 1;
        continue;
      }
      const equalsIndex = token.indexOf("=");
      if (token.startsWith("--") && equalsIndex > 2) {
        if (!COMMAND_WRAPPER_OPTIONS_WITH_VALUE[wrapper].has(token.slice(0, equalsIndex))) {
          return null;
        }
        index += 1;
        continue;
      }
      if (/^-[A-Za-z].+/.test(token) && !token.startsWith("--")) {
        let consumesNextToken = false;
        for (const [optionIndex, option] of token.slice(1).split("").entries()) {
          const shortOption = `-${option}`;
          if (COMMAND_WRAPPER_OPTIONS_WITH_VALUE[wrapper].has(shortOption)) {
            consumesNextToken = optionIndex === token.length - 2;
            break;
          }
          if (!COMMAND_WRAPPER_FLAGS[wrapper].has(shortOption)) return null;
        }
        if (consumesNextToken && tokens[index + 1] === undefined) return null;
        index += consumesNextToken ? 2 : 1;
        continue;
      }
      return null;
    }
    if (tokenProgram && SHELL_PROGRAMS.has(tokenProgram.replace(/\.exe$/i, "").toLowerCase())) {
      const scriptIndex = shellCommandArgumentIndex(tokens, index + 1);
      if (scriptIndex !== null) {
        const script = tokens[scriptIndex];
        return script
          ? commandProgramNameInternal(script, depth + 1, "shell", segmentsRemaining)
          : null;
      }
    }
    const lowerTokenProgram = tokenProgram?.toLowerCase();
    if (lowerTokenProgram && WINDOWS_SHELL_PROGRAMS.has(lowerTokenProgram)) {
      const payload = windowsShellPayloadProgramName(
        lowerTokenProgram,
        tokens,
        index + 1,
        depth,
        commandSplit.remainingCommand,
        commandSplit.separator,
        segmentsRemaining,
      );
      if (payload.matched) return payload.program;
    }
    if (lowerTokenProgram === "start-process") {
      const startedProgram = startProcessProgramName(tokens, index + 1);
      if (startedProgram !== null) return startedProgram;
    }
    if (
      executionContext === "shell" &&
      isUnqualifiedToken &&
      tokenProgram &&
      SHELL_PRECOMMAND_MODIFIERS.has(tokenProgram)
    ) {
      index += 1;
      if (tokenProgram === "time" && tokens[index] === "-p") index += 1;
      if (tokens[index]?.startsWith("-")) return null;
      continue;
    }
    if (isUnqualifiedToken && tokenProgram) {
      const targetIndex = transparentWrapperCommandIndex(tokenProgram, tokens, index);
      if (targetIndex !== null) {
        const wrappedProgram = commandProgramNameInternal(
          serializeShellTokens(tokens.slice(targetIndex)),
          depth + 1,
          "exec",
          segmentsRemaining,
        );
        if (wrappedProgram !== null) return wrappedProgram;
      }
    }
    if (isUnqualifiedToken && tokenProgram && SHELL_COMMAND_WRAPPERS.has(tokenProgram)) {
      return wrappedShellCommandProgramName(
        tokenProgram,
        tokens,
        index + 1,
        depth,
        commandSplit.remainingCommand,
        segmentsRemaining,
      );
    }
    if (
      (executionContext === "shell" ||
        (wrapper === "sudo" && tokenProgram && SKIPPABLE_SUDO_PROBES.has(tokenProgram))) &&
      isUnqualifiedToken &&
      tokenProgram &&
      NON_DESCRIPTIVE_SHELL_PROGRAMS.has(tokenProgram) &&
      (!TERMINAL_SHELL_PROGRAMS.has(tokenProgram) ||
        (tokenProgram === "false" && commandSplit.separator !== "&&")) &&
      commandSplit.remainingCommand
    ) {
      return commandProgramNameInternal(
        commandSplit.remainingCommand,
        depth,
        "shell",
        segmentsRemaining - 1,
      );
    }
    if (
      executionContext === "shell" &&
      isUnqualifiedToken &&
      lowerTokenProgram &&
      POWERSHELL_SETUP_PROGRAMS.has(lowerTokenProgram) &&
      commandSplit.remainingCommand
    ) {
      return commandProgramNameInternal(
        commandSplit.remainingCommand,
        depth,
        "shell",
        segmentsRemaining - 1,
      );
    }
    if (
      !tokenProgram ||
      (isUnqualifiedToken && NON_DESCRIPTIVE_SHELL_PROGRAMS.has(tokenProgram)) ||
      NON_PROGRAM_PREFIX_CHARACTERS.includes(tokenProgram[0] ?? "") ||
      NON_PROGRAM_SUFFIX_CHARACTERS.includes(tokenProgram.at(-1) ?? "") ||
      tokenProgram.endsWith("()") ||
      /^[A-Za-z_][A-Za-z0-9_]*\(\)\{$/u.test(tokenProgram)
    ) {
      return null;
    }
    return tokenProgram || null;
  }

  if ((sawAssignment || sawRedirection) && wrapper === null && commandSplit.remainingCommand) {
    return commandProgramNameInternal(
      commandSplit.remainingCommand,
      depth,
      executionContext,
      segmentsRemaining - 1,
    );
  }
  return null;
}

function commandProgramNameInternal(
  command: string,
  depth: number,
  context: CommandProgramContext,
  segmentsRemaining = MAX_COMMAND_SEGMENTS,
): string | null {
  if (segmentsRemaining <= 0) return null;
  const calledProgram = powerShellCallOperatorProgramName(command);
  if (calledProgram !== undefined) return calledProgram;
  return (
    parseCommandProgramName(command, depth, context, segmentsRemaining) ??
    (context === "shell" ? literalCommandAliasProgramName(command) : null)
  );
}

export function commandProgramName(command: string, depth = 0): string | null {
  return commandProgramNameInternal(command, depth, "shell", MAX_COMMAND_SEGMENTS);
}
