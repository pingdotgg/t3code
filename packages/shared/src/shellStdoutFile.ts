const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

function skipQuoted(command: string, start: number): number {
  const quote = command[start];
  let index = start + 1;
  while (index < command.length && command[index] !== quote) {
    index += quote === '"' && command[index] === "\\" ? 2 : 1;
  }
  return index + 1;
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
      value += command[index + 1] ?? "";
      index += 2;
    } else {
      if ("$`*?[{".includes(char) || (value === "" && char === "~")) expands = true;
      value += char;
      index += 1;
    }
  }
  return { value: value === "" || expands ? null : value, end: index };
}

/**
 * The file a shell command sends its stdout to: its last `>`, `>>`, `1>`, `&>` or `| tee`
 * target. Undefined when stdout stays on the terminal, goes to /dev/null, or names a path
 * only the shell could expand.
 */
export function shellStdoutFile(command: string): string | undefined {
  let target: string | null | undefined;
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    if (char === "\\") {
      index += 2;
    } else if (char === "'" || char === '"') {
      index = skipQuoted(command, index);
    } else if (char === ">") {
      const before = command[index - 1];
      const descriptor = before !== undefined && /\d/.test(before) ? before : "1";
      let next = index + 1;
      if (command[next] === ">") next += 1;
      // `>&2` duplicates a descriptor and `>(...)` substitutes a process; neither names a file.
      if (command[next] === "&" || command[next] === "(") {
        index = next + 1;
        continue;
      }
      const word = readWord(command, next);
      if (descriptor === "1") target = word.value;
      index = Math.max(word.end, next);
    } else if (char === "|" && command[index + 1] !== "|") {
      const tee = /^\|&?\s*tee((?:\s+-[a-z-]+)*)\s+/i.exec(command.slice(index));
      if (tee) {
        const word = readWord(command, index + tee[0].length);
        target = word.value;
        index = Math.max(word.end, index + tee[0].length);
      } else {
        index += 1;
      }
    } else {
      index += 1;
    }
  }
  return target === null || target === undefined || target === "/dev/null" ? undefined : target;
}
