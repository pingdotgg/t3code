import type { VcsWorkingTreeFileStatus } from "@t3tools/contracts";

export type PorcelainStatusEntry = {
  readonly path: string;
  readonly status: VcsWorkingTreeFileStatus;
};

const OCTAL_DIGIT = /[0-7]/;
const GIT_PATH_UNQUOTE_DECODER = new TextDecoder("utf-8");
const GIT_PATH_UNQUOTE_ENCODER = new TextEncoder();

function pushUtf8Bytes(bytes: number[], text: string): void {
  const encoded = GIT_PATH_UNQUOTE_ENCODER.encode(text);
  for (const byte of encoded) bytes.push(byte);
}

/** Decode a Git C-quoted pathname such as `"my file.ts"` or `"caf\\303\\251.ts"`. */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  let i = 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') return GIT_PATH_UNQUOTE_DECODER.decode(Uint8Array.from(bytes));
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1] ?? "";
      if (OCTAL_DIGIT.test(next)) {
        let octal = next;
        let consumed = 1;
        const second = raw[i + 2] ?? "";
        if (OCTAL_DIGIT.test(second)) {
          octal += second;
          consumed++;
          const third = raw[i + 3] ?? "";
          if (OCTAL_DIGIT.test(third)) {
            octal += third;
            consumed++;
          }
        }
        bytes.push(Number.parseInt(octal, 8) & 0xff);
        i += 1 + consumed;
        continue;
      }
      pushUtf8Bytes(
        bytes,
        next === "n"
          ? "\n"
          : next === "t"
            ? "\t"
            : next === "r"
              ? "\r"
              : next === "a"
                ? "\u0007"
                : next === "b"
                  ? "\b"
                  : next === "f"
                    ? "\f"
                    : next === "v"
                      ? "\v"
                      : next,
      );
      i += 2;
      continue;
    }
    pushUtf8Bytes(bytes, ch ?? "");
    i++;
  }
  return raw;
}

function restAfterFields(line: string, fieldCount: number): string {
  let index = 0;
  let seen = 0;
  while (index < line.length && seen < fieldCount) {
    while (index < line.length && line[index] === " ") index++;
    if (index >= line.length) return "";
    while (index < line.length && line[index] !== " ") index++;
    seen++;
  }
  while (index < line.length && line[index] === " ") index++;
  return line.slice(index);
}

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = unquoteGitPath(line.slice(2).trim());
    return simple.length > 0 ? simple : null;
  }

  if (line.startsWith("2 ")) {
    const tabIndex = line.indexOf("\t");
    const head = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
    const dest = unquoteGitPath(restAfterFields(head, 9).trim());
    return dest.length > 0 ? dest : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split("\t");
    const decoded = unquoteGitPath(filePath?.trim() ?? "");
    return decoded.length > 0 ? decoded : null;
  }

  const dest = unquoteGitPath(restAfterFields(line, line.startsWith("u ") ? 11 : 8).trim());
  return dest.length > 0 ? dest : null;
}

export function workingTreeStatusFromPorcelainXy(
  xy: string,
  renamed: boolean,
): VcsWorkingTreeFileStatus {
  const index = xy[0] ?? ".";
  const worktree = xy[1] ?? ".";
  if (index === "U" || worktree === "U") return "modified";
  if (index === "D" || worktree === "D") return "deleted";
  if (renamed || index === "R" || worktree === "R" || index === "C" || worktree === "C") {
    return "renamed";
  }
  if (index === "A" || worktree === "A") return "added";
  if (index === "M" || worktree === "M" || index === "T" || worktree === "T") return "modified";
  return "modified";
}

/** Maps one porcelain-2 row to the single status the file explorer can show. */
export function parsePorcelainStatus(line: string): PorcelainStatusEntry | null {
  if (line.startsWith("? ")) {
    const path = unquoteGitPath(line.slice(2).trim());
    return path.length > 0 ? { path, status: "untracked" } : null;
  }
  if (line.startsWith("! ")) {
    return null;
  }
  const path = parsePorcelainPath(line);
  if (!path) return null;
  if (line.startsWith("u ")) {
    return { path, status: "modified" };
  }
  if (line.startsWith("1 ") || line.startsWith("2 ")) {
    return {
      path,
      status: workingTreeStatusFromPorcelainXy(line.slice(2, 4), line.startsWith("2 ")),
    };
  }
  return null;
}
