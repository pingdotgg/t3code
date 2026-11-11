const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

type Token =
  | { readonly kind: "word"; readonly value: string | null }
  | { readonly kind: "separator" }
  | { readonly kind: "pipe" }
  // A null target is stdout duplicated to a descriptor or a process, or a path only the shell knows.
  | { readonly kind: "redirect"; readonly stdout: boolean; readonly target: string | null };

function skipQuoted(command: string, start: number): number {
  const quote = command[start];
  let index = start + 1;
  while (index < command.length && command[index] !== quote) {
    index += quote === '"' && command[index] === "\\" ? 2 : 1;
  }
  return index + 1;
}

function skipBalanced(command: string, open: number): number {
  const close = command[open] === "(" ? ")" : "}";
  let depth = 0;
  let index = open;
  while (index < command.length) {
    const char = command[index]!;
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(command, index);
      continue;
    }
    if (char === "\\") index += 1;
    else if (char === command[open]) depth += 1;
    else if (char === close && --depth === 0) return index + 1;
    index += 1;
  }
  return index;
}

/** Reads one shell word, joining quoted parts. Null when it needs expansion we cannot do. */
function readWord(command: string, start: number): { value: string | null; end: number } {
  let index = start;
  while (command[index] === " " || command[index] === "\t") index += 1;
  let value = "";
  let expands = false;
  while (index < command.length && !WORD_END.has(command[index]!)) {
    const char = command[index]!;
    if (char === "'" || char === '"') {
      const end = skipQuoted(command, index);
      const inner = command.slice(index + 1, end - 1);
      if (char === '"' && /[$`]/.test(inner)) expands = true;
      // Inside double quotes a backslash escapes only these, so Windows paths keep theirs.
      value += char === '"' ? inner.replace(/\\([$`"\\\n])/g, "$1") : inner;
      index = end;
    } else if (char === "\\") {
      if (command[index + 1] !== "\n") value += command[index + 1] ?? "";
      index += 2;
    } else if (char === "$" && (command[index + 1] === "(" || command[index + 1] === "{")) {
      index = skipBalanced(command, index + 1);
      expands = true;
    } else if (char === "`") {
      index = skipQuoted(command, index);
      expands = true;
    } else {
      if ("$*?[{".includes(char) || (value === "" && char === "~")) expands = true;
      value += char;
      index += 1;
    }
  }
  return { value: value === "" || expands ? null : value, end: index };
}

/** Null for constructs this scanner does not model, such as subshells. */
function tokenize(command: string): ReadonlyArray<Token> | null {
  const tokens: Array<Token> = [];
  const heredocs: Array<{ readonly delimiter: string; readonly stripTabs: boolean }> = [];
  let index = 0;
  const redirect = (descriptor: number | "&", operatorEnd: number) => {
    const stdout = descriptor === 1 || descriptor === "&";
    if (command[operatorEnd] === "&" || command[operatorEnd] === "(") {
      // `>&2` and `>(...)` send output to a descriptor or a process, not a file.
      const end =
        command[operatorEnd] === "("
          ? skipBalanced(command, operatorEnd)
          : readWord(command, operatorEnd + 1).end;
      tokens.push({ kind: "redirect", stdout, target: null });
      return end;
    }
    const word = readWord(command, operatorEnd);
    tokens.push({ kind: "redirect", stdout, target: word.value });
    return Math.max(word.end, operatorEnd);
  };
  while (index < command.length) {
    const char = command[index]!;
    const next = command[index + 1];
    if (char === " " || char === "\t") {
      index += 1;
    } else if (char === "\\" && next === "\n") {
      index += 2;
    } else if (char === "\n" || char === ";") {
      tokens.push({ kind: "separator" });
      index += 1;
      if (char === "\n") {
        for (const heredoc of heredocs.splice(0)) {
          while (index < command.length) {
            const lineEnd = command.indexOf("\n", index);
            const end = lineEnd === -1 ? command.length : lineEnd;
            const line = command.slice(index, end);
            index = end + 1;
            if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
          }
        }
      }
    } else if (char === "#") {
      const lineEnd = command.indexOf("\n", index);
      index = lineEnd === -1 ? command.length : lineEnd;
    } else if (char === "&") {
      if (next === ">") {
        index = redirect("&", index + (command[index + 2] === ">" ? 3 : 2));
      } else {
        tokens.push({ kind: "separator" });
        index += next === "&" ? 2 : 1;
      }
    } else if (char === "|") {
      tokens.push(next === "|" ? { kind: "separator" } : { kind: "pipe" });
      index += next === "|" || next === "&" ? 2 : 1;
    } else if (char === "(" || char === ")") {
      return null;
    } else if (char === ">" || (/\d/.test(char) && /^\d+[<>]/.test(command.slice(index)))) {
      const digits = /^\d*/.exec(command.slice(index))![0];
      const operator = index + digits.length;
      const descriptor = digits === "" ? 1 : Number(digits);
      if (command[operator] === "<") {
        index = readWord(command, operator + 1).end;
      } else {
        const append = command[operator + 1] === ">" || command[operator + 1] === "|";
        index = redirect(descriptor, operator + (append ? 2 : 1));
      }
    } else if (char === "<") {
      if (next === "<" && command[index + 2] === "<") {
        index = readWord(command, index + 3).end;
      } else if (next === "<") {
        const stripTabs = command[index + 2] === "-";
        const start = index + (stripTabs ? 3 : 2);
        const word = readWord(command, start);
        const raw = command
          .slice(start, word.end)
          .trim()
          .replace(/^['"]|['"]$/g, "");
        heredocs.push({ delimiter: word.value ?? raw, stripTabs });
        index = word.end;
      } else if (next === "(") {
        index = skipBalanced(command, index + 1);
      } else {
        index = readWord(command, next === "&" ? index + 2 : index + 1).end;
      }
    } else {
      const word = readWord(command, index);
      tokens.push({ kind: "word", value: word.value });
      index = Math.max(word.end, index + 1);
    }
  }
  return tokens;
}

export interface ShellStdoutFile {
  /** As written in the command; relative paths resolve after `cwdChanges`. */
  readonly path: string;
  /** Directories the command `cd`s into, in order, before the command that writes the file. */
  readonly cwdChanges: ReadonlyArray<string>;
}

/**
 * The file the last command in a shell command line sends its stdout to: its last `>`, `>>`,
 * `1>`, `&>` or `| tee` target. Undefined when that command's stdout stays on the terminal, goes
 * to a device, or names a path only the shell could work out.
 */
export function shellStdoutFile(command: string): ShellStdoutFile | undefined {
  const tokens = tokenize(command);
  if (tokens === null) return undefined;
  const commands: Array<Array<Token>> = [[]];
  for (const token of tokens) {
    if (token.kind === "separator") commands.push([]);
    else commands.at(-1)!.push(token);
  }
  const filled = commands.filter((tokens) => tokens.length > 0);
  const last = filled.at(-1);
  if (last === undefined) return undefined;

  const cwdChanges: Array<string> = [];
  for (const earlier of filled.slice(0, -1)) {
    const words = earlier.filter((token) => token.kind === "word");
    if (words[0]?.value !== "cd") continue;
    const directory = words[1]?.value;
    if (words.length !== 2 || directory == null || directory === "-") return undefined;
    cwdChanges.push(directory);
  }

  let target: string | null | undefined;
  let stage: Array<string | null> = [];
  let teeWrote = false;
  for (const token of last) {
    if (token.kind === "pipe") {
      stage = [];
      teeWrote = false;
    } else if (token.kind === "redirect") {
      if (token.stdout) target = token.target;
    } else if (token.kind === "word") {
      stage.push(token.value);
      if (stage[0] === "tee" && stage.length > 1 && !teeWrote && !token.value?.startsWith("-")) {
        target = token.value;
        teeWrote = true;
      }
    }
  }
  if (target == null || target.startsWith("/dev/")) return undefined;
  return { path: target, cwdChanges };
}
