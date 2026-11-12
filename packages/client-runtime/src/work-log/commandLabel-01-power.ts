import { COMMAND_WRAPPER_FLAGS, COMMAND_WRAPPER_OPTIONS_WITH_VALUE, TERMINAL_SHELL_PROGRAMS, commandWithoutLeadingShellComments, indexAfterShellRedirection, literalAssignmentProgram, powerShellCallOperatorProgramName, serializeShellTokens, shellCommandArgumentIndex, splitFirstShellCommand, staticProgramName, tokenizeShellCommand, transparentWrapperCommandIndex, withoutShellLineContinuations } from "./commandLabel-02-termin.ts";
import { MAX_COMMAND_SEGMENTS, NON_DESCRIPTIVE_SHELL_PROGRAMS, NON_PROGRAM_PREFIX_CHARACTERS, NON_PROGRAM_SUFFIX_CHARACTERS, POWERSHELL_FLAGS, POWERSHELL_OPTIONS_WITH_VALUE, POWERSHELL_SETUP_PROGRAMS, SHELL_COMMAND_WRAPPERS, SHELL_PRECOMMAND_MODIFIERS, SHELL_PROGRAMS, SKIPPABLE_SUDO_PROBES, START_PROCESS_FLAGS, START_PROCESS_OPTIONS_WITH_VALUE, WINDOWS_SHELL_PROGRAMS } from "./commandLabel-03-command.ts";
import type { CommandProgramContext, CommandWrapper, PowerShellAssignment, WindowsShellPayload } from "./commandLabel-03-command.ts";


export function powerShellAssignmentProgramName(
  command: string,
  depth: number,
  remainingCommand: string | null,
  segmentsRemaining: number,
): PowerShellAssignment {
  const assignment = command.match(
    /^\s*\$(?:(env|global|local|script):)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*([\s\S]*)$/iu,
  );
  if (!assignment) return { matched: false, program: null };

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

export function windowsShellPayloadProgramName(
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

export function startProcessProgramName(tokens: ReadonlyArray<string>, start: number): string | null {
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

export function referencedCommandAlias(token: string): string | null {
  const reference = token.match(
    /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?:\[@\])?\})$/u,
  );
  return reference?.[1] ?? reference?.[2] ?? null;
}

export function literalCommandAliasProgramName(command: string): string | null {
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

export function wrappedShellCommandProgramName(
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

export function parseCommandProgramName(
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

export function commandProgramNameInternal(
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

// Escape bytes and other control characters render as invisible gaps; display
// shows them as Unicode control pictures (ESC becomes ␛) instead. Tab, newline
// and carriage return lay out as whitespace, so CRLF scripts stay unmarked.
export const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function commandDisplayText(command: string): string {
  return withVisibleControlCharacters(withoutShellWrapper(command));
}

export function withVisibleControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, (character) =>
    character === "\u007f" ? "␡" : String.fromCharCode(0x2400 + character.charCodeAt(0)),
  );
}

// A wrapper whose quoting does not balance is kept: the script's end cannot be
// known, which happens when Codex's secret redaction removes the backslash of
// an escaped quote inside `-lc "…"`.
export function withoutShellWrapper(command: string): string {
  const trimmed = command.trim();
  const split = splitFirstShellCommand(trimmed);
  if (split.remainingCommand !== null) return trimmed;
  const tokens = tokenizeShellCommand(trimmed);
  const program = tokens?.[0]
    ?.split(/[\\/]/u)
    .at(-1)
    ?.replace(/\.exe$/iu, "");
  if (!tokens || !program || !SHELL_PROGRAMS.has(program)) return trimmed;
  const scriptIndex = shellCommandArgumentIndex(tokens, 1);
  // Positional arguments can affect the script; keep those invocations intact.
  if (scriptIndex === null || scriptIndex !== tokens.length - 1) return trimmed;
  return tokens[scriptIndex]?.trim() || trimmed;
}

export const POWERSHELL_PROGRAMS = new Set(["powershell", "pwsh"]);

export const POWERSHELL_VERBS = new Set(
  `Add Approve Assert Backup Block Build Checkpoint Clear Close Compare Complete Compress Confirm Connect Convert ConvertFrom ConvertTo Copy Debug Deny Deploy Disable Disconnect Dismount Edit Enable Enter Exit Expand Export Find ForEach Format Get Grant Group Hide Import Initialize Install Invoke Join Limit Lock Measure Merge Mount Move New Open Optimize Out Ping Pop Protect Publish Push Read Receive Redo Register Remove Rename Repair Request Reset Resize Resolve Restart Restore Resume Revoke Save Search Select Send Set Show Skip Sort Split Start Step Stop Submit Suspend Switch Sync Tee Test Trace Unblock Undo Uninstall Unlock Unprotect Unpublish Unregister Update Use Wait Watch Where Write`.split(
    " ",
  ),
);

export function isPowerShellCmdlet(word: string): boolean {
  const cmdlet = /^([A-Z][a-z]+(?:[A-Z][a-z]+)?)-[A-Z][A-Za-z]*$/u.exec(word);
  return cmdlet !== null && POWERSHELL_VERBS.has(cmdlet[1]!);
}

export function commandHighlightLanguage(command: string): "powershell" | "shellscript" {
  const program = /^(?:&\s*)?(?:"([^"]*)"|'([^']*)'|(\S+))/u.exec(command.trim());
  const name = (program?.[1] ?? program?.[2] ?? program?.[3] ?? "")
    .split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/u, "");
  if (name && POWERSHELL_PROGRAMS.has(name)) return "powershell";
  return isPowerShellScript(command) ? "powershell" : "shellscript";
}

export function isPowerShellScript(command: string): boolean {
  let rest: string | null = command.trim();
  if (/^&\s*\S/u.test(rest)) return true;
  for (let segment = 0; rest && segment < MAX_COMMAND_SEGMENTS; segment += 1) {
    const { firstCommand, remainingCommand } = splitFirstShellCommand(rest);
    const statement = firstCommand.trim();
    if (
      /^\$(?:env|global|local|script):/iu.test(statement) ||
      /^\$[A-Za-z_]\w*\s+=/u.test(statement) ||
      isPowerShellCmdlet(statement.match(/^\S+/u)?.[0] ?? "")
    ) {
      return true;
    }
    rest = remainingCommand;
  }
  return false;
}

