import type { SourceControlProviderKind } from "@t3tools/contracts";
import type { ForgeCommand } from "@t3tools/source-control-core/shared/definition";
import { builtInSourceControlDefinitions as sourceControlDefinitions } from "@t3tools/source-control-definitions/registry";

// Where a shell starts a command, past `NAME=value` assignments and wrappers like `timeout 60`.
// A command anywhere else, as in `echo "gh pr create"`, is text, not a command that runs.
export const COMMAND_START =
  "(?:^|[;&|({`\\n]|\\b(?:do|then|else)\\s)\\s*(?:(?:\\w+=\\S*|env|time|nohup|timeout\\s+\\S+)\\s+)*";
export const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/u;

// Codex runs each command as `/bin/zsh -lc <script>`, quoting the script in pieces such as
// `"a "'`b`'" c"`.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(?=["'])([\s\S]*)$/u;
const SHELL_WORD_PIECE = /"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])|(\S)/gu;
const HEREDOC_OPENER = /<<-?[ \t]*(['"]?)(\w+)\1/uy;
const COMMAND_SEPARATORS = new RegExp(COMMAND_SEPARATOR, "gu");
const SUBSHELL_SEPARATORS = /&&|\|\||[;|\n()`]/gu;

/** The script a shell input runs, unwrapped from Codex's `sh -lc`. */
export function shellScript(input: string): string {
  const [, wrapped] = SHELL_WRAPPER.exec(input) ?? [];
  return wrapped === undefined
    ? input
    : Array.from(
        wrapped.matchAll(SHELL_WORD_PIECE),
        ([, double, single, escaped, bare]) =>
          double?.replace(/\\(["\\$`])/gu, "$1") ?? single ?? escaped ?? bare,
      ).join("");
}

/** Where a heredoc opened at `at` ends: after its terminator line, or at the end of the script. */
function heredocEnd(script: string, at: number): number | undefined {
  HEREDOC_OPENER.lastIndex = at;
  const [opener, , tag] = HEREDOC_OPENER.exec(script) ?? [];
  if (opener === undefined || tag === undefined) return undefined;
  let lineStart = script.indexOf("\n", at + opener.length);
  if (lineStart === -1) return undefined;
  while (lineStart !== -1) {
    const lineEnd = script.indexOf("\n", lineStart + 1);
    const end = lineEnd === -1 ? script.length : lineEnd;
    if (script.slice(lineStart + 1, end).trim() === tag) return end;
    lineStart = lineEnd;
  }
  return script.length;
}

/** Where a double-quoted string opened at `at` ends. A heredoc that `$(` opens inside it is read first. */
function doubleQuoteEnd(script: string, at: number): number {
  let index = at + 1;
  while (index < script.length) {
    const char = script[index];
    if (char === '"') return index + 1;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (script.startsWith("$(", index)) {
      let opener = index + 2;
      while (opener < script.length && !'"()'.includes(script[opener] ?? "")) {
        if (script.startsWith("<<", opener)) break;
        opener++;
      }
      const end = heredocEnd(script, opener);
      index = end ?? index + 2;
      continue;
    }
    index++;
  }
  return script.length;
}

type CarriedText = {
  readonly start: number;
  readonly end: number;
  readonly kind: "escape" | "text" | "heredoc";
};

/**
 * The text a script carries rather than runs: escapes, quoted strings, comments and heredoc
 * bodies, read in one left-to-right scan as the shell does. A `#` opens a comment only where an
 * unquoted, unescaped separator comes before it. An unclosed quote carries the rest of the script.
 */
function carriedText(script: string): ReadonlyArray<CarriedText> {
  const pieces: Array<CarriedText> = [];
  let wordStart = true;
  let index = 0;
  const carry = (end: number, kind: CarriedText["kind"]) => {
    pieces.push({ start: index, end: Math.min(end, script.length), kind });
    index = end;
    wordStart = false;
  };
  while (index < script.length) {
    const char = script[index] ?? "";
    if (char === "\\") carry(index + 2, "escape");
    else if (script.startsWith("$'", index)) {
      let end = index + 2;
      while (end < script.length && script[end] !== "'") end += script[end] === "\\" ? 2 : 1;
      carry(end + 1, "text");
    } else if (char === "'") {
      const close = script.indexOf("'", index + 1);
      carry(close === -1 ? script.length : close + 1, "text");
    } else if (char === '"') carry(doubleQuoteEnd(script, index), "text");
    else if (char === "#" && wordStart) {
      const lineEnd = script.indexOf("\n", index);
      carry(lineEnd === -1 ? script.length : lineEnd, "text");
    } else {
      const end = char === "<" ? heredocEnd(script, index) : undefined;
      if (end !== undefined) carry(end, "heredoc");
      else {
        wordStart = /[\s;&|(]/u.test(char);
        index++;
      }
    }
  }
  return pieces;
}

/** The script with each piece of text it carries replaced. */
function replaceCarriedText(script: string, replace: (piece: CarriedText) => string): string {
  let result = "";
  let index = 0;
  for (const piece of carriedText(script)) {
    result += script.slice(index, piece.start) + replace(piece);
    index = piece.end;
  }
  return result + script.slice(index);
}

/** A script split at the separators in its code, leaving carried text intact. */
function splitShell(script: string, separators: RegExp): ReadonlyArray<string> {
  const masked = replaceCarriedText(script, ({ start, end }) => "_".repeat(end - start));
  const segments: Array<string> = [];
  let start = 0;
  for (const separator of masked.matchAll(separators)) {
    segments.push(script.slice(start, separator.index));
    start = separator.index + separator[0].length;
  }
  segments.push(script.slice(start));
  return segments;
}

/** A script split at the command separators in its code, leaving carried text intact. */
export const shellSegments = (script: string): ReadonlyArray<string> =>
  splitShell(script, COMMAND_SEPARATORS);

/** The commands a script runs, without the text it carries. */
export const shellCode = (script: string) =>
  replaceCarriedText(script, ({ start, end, kind }) =>
    kind === "escape" ? script.slice(start, end) : kind === "heredoc" ? "<<" : "''",
  );

/** One segment's words with quotes resolved, stopping at a comment. */
function shellWords(segment: string): Array<string> {
  const words: Array<string> = [];
  let current: string | null = null;
  let quote: string | null = null;
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] ?? "";
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') current = (current ?? "") + (segment[++index] ?? "");
      else current = (current ?? "") + char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current ??= "";
    } else if (char === "\\") {
      current = (current ?? "") + (segment[++index] ?? "");
    } else if (/\s/u.test(char)) {
      if (current !== null) words.push(current);
      current = null;
    } else if (char === "#" && current === null) {
      break;
    } else {
      current = (current ?? "") + char;
    }
  }
  if (current !== null) words.push(current);
  return words;
}

export interface AgentShellCommand {
  /** The executable as written, before basename normalization. */
  readonly executable: string;
  /** The program and its arguments, after assignments and wrappers such as `timeout 60`. */
  readonly words: ReadonlyArray<string>;
  /** `NAME=value` assignments that prefixed the command, including those after `env`. */
  readonly assignments: ReadonlyMap<string, string>;
  /** Runs more than once: under `watch`, inside an `until`/`while` loop, or a `for` loop. */
  readonly repeats: boolean;
  readonly bypassCommand: string;
}

const ASSIGNMENT = /^([A-Za-z_]\w*)=([\s\S]*)$/u;
const REDIRECTION = /^\d*(?:>>?|<<?|&>)(?:&\d+|\S*)$/u;
const REDIRECTION_OPERATOR = /^\d*(?:>>?|<|&>)$/u;
const LOOP_KEYWORDS = new Set(["until", "while", "for"]);
const DROPPED_KEYWORDS = new Set(["do", "then", "else", "if", "elif", "!", "{", "}"]);
const PLAIN_WRAPPERS = new Set(["env", "time", "nohup", "exec", "command", "builtin"]);

function stripRedirections(words: ReadonlyArray<string>): Array<string> {
  const kept: Array<string> = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? "";
    if (REDIRECTION_OPERATOR.test(word)) index++;
    else if (!REDIRECTION.test(word)) kept.push(word);
  }
  return kept;
}

/** The commands a shell input runs, in order. Text inside quotes and heredocs is not a command. */
export function agentShellCommands(input: string): ReadonlyArray<AgentShellCommand> {
  const unwrapped = shellScript(input);
  const script = replaceCarriedText(unwrapped, ({ start, end, kind }) =>
    kind === "heredoc" ? "<<" : unwrapped.slice(start, end),
  );
  const segments = splitShell(script, SUBSHELL_SEPARATORS);
  const commands: Array<AgentShellCommand> = [];
  let loopDepth = 0;
  let offset = 0;
  for (const source of segments) {
    const start = script.indexOf(source, offset);
    offset = start + source.length;
    const segment = stripRedirections(shellWords(source));
    const assignments = new Map<string, string>();
    let watches = false;
    let index = 0;
    while (index < segment.length) {
      const word = segment[index] ?? "";
      if (word === "done") {
        loopDepth = Math.max(0, loopDepth - 1);
        index++;
      } else if (LOOP_KEYWORDS.has(word)) {
        loopDepth++;
        index++;
      } else if (DROPPED_KEYWORDS.has(word) || PLAIN_WRAPPERS.has(word)) {
        index++;
      } else if (ASSIGNMENT.test(word)) {
        const [, name = "", value = ""] = ASSIGNMENT.exec(word) ?? [];
        assignments.set(name, value);
        index++;
      } else if (word === "timeout" || word === "watch") {
        watches ||= word === "watch";
        index++;
        // Flags, then `timeout`'s duration; `watch -n 5` takes its interval the same way.
        while (index < segment.length && (segment[index] ?? "").startsWith("-")) {
          index += /^-[a-zA-Z]$/u.test(segment[index] ?? "") ? 2 : 1;
        }
        if (word === "timeout") index++;
      } else break;
    }
    const words = segment.slice(index);
    if (words.length === 0) continue;
    const program = words[0] ?? "";
    commands.push({
      executable: program,
      words: [program.slice(program.lastIndexOf("/") + 1), ...words.slice(1)],
      assignments,
      repeats: watches || loopDepth > 0,
      bypassCommand: `${script.slice(0, start)}${source.replace(/^(\s*(?:(?:if|elif|then|else|do|!)\s+)*)/u, `$1${GH_DIRECT_ENV}=1 `)}${script.slice(offset)}`,
    });
  }
  return commands;
}

const GH_DIRECT_ENV = "T3_GH_DIRECT";

export interface AgentForgeCommand {
  readonly forge: SourceControlProviderKind;
  readonly command: ForgeCommand;
  /** Prefixed `T3_GH_DIRECT=1`, which asks T3 to let the command run as typed. */
  readonly bypass: boolean;
  readonly bypassCommand: string;
}

/** The forge CLI commands a shell input runs. A read that repeats is a poll. */
export function classifyAgentShellCommands(input: string): ReadonlyArray<AgentForgeCommand> {
  return agentShellCommands(input).flatMap((shellCommand) => {
    for (const definition of sourceControlDefinitions.definitions) {
      let command = definition.classifyCommand?.(shellCommand.words) ?? null;
      if (command === null) continue;
      // Environment-selected hosts/repos may differ from this thread's repository.
      if (
        definition.kind === "github" &&
        (shellCommand.assignments.get("GH_HOST") || shellCommand.assignments.get("GH_REPO"))
      ) {
        command = { kind: "other" };
      }
      return [
        {
          forge: definition.kind,
          command: command.kind === "read" && shellCommand.repeats ? { kind: "poll" } : command,
          bypass: shellCommand.assignments.get(GH_DIRECT_ENV) === "1",
          bypassCommand: shellCommand.bypassCommand,
        },
      ];
    }
    return [];
  });
}
