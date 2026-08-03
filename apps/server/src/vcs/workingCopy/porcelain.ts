/**
 * fork: f4 — pure parsers for the source-control panel's status read.
 *
 * `git -c core.quotePath=false status --porcelain=v1 -uall -z` plus the two
 * `diff --numstat -z` reads. No Effect, no I/O: everything here is a function
 * of a string.
 */
import type { WorkingCopyChange, WorkingCopyFile } from "@t3tools/contracts";

/**
 * Porcelain v1 status letters. Anything unrecognised folds onto `modified`
 * rather than growing `WorkingCopyChange` — the union is a wire literal union
 * and must stay small and stable.
 */
function changeFromStatusLetter(letter: string): WorkingCopyChange {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    case "U":
      return "unmerged";
    default:
      return "modified";
  }
}

const OCTAL_ESCAPE = /^[0-7]{3}$/;

/**
 * Fallback for a path git decided to quote anyway. With
 * `-c core.quotePath=false` and `-z` this should never fire, but a
 * differently-configured git is not worth a corrupted pathspec.
 */
export function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  const body = value.slice(1, -1);
  const bytes: Array<number> = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char !== "\\") {
      for (const byte of new TextEncoder().encode(char ?? "")) {
        bytes.push(byte);
      }
      index += 1;
      continue;
    }
    const next = body.slice(index + 1, index + 4);
    if (OCTAL_ESCAPE.test(next)) {
      bytes.push(Number.parseInt(next, 8));
      index += 4;
      continue;
    }
    const escaped = body[index + 1];
    switch (escaped) {
      case "n":
        bytes.push(0x0a);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case "a":
        bytes.push(0x07);
        break;
      case "b":
        bytes.push(0x08);
        break;
      case "f":
        bytes.push(0x0c);
        break;
      case "v":
        bytes.push(0x0b);
        break;
      case undefined:
        break;
      default:
        for (const byte of new TextEncoder().encode(escaped)) {
          bytes.push(byte);
        }
        break;
    }
    index += 2;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function isUnmerged(x: string, y: string): boolean {
  return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

/**
 * Parse `status --porcelain=v1 -uall -z`.
 *
 * Rules that are load-bearing:
 * - `R`/`C` consume the **next** NUL field as `oldPath`.
 * - An unmerged path produces **one** `conflicted` row, never a staged row
 *   *and* an unstaged row. Double-bucketing them is the bug that broke staging
 *   mid-merge in 2code.
 * - `MM` deliberately produces **two** rows; the panel's `partial` chip is
 *   derived from a path appearing in both areas.
 * - `??` rows carry no counts (they would cost one `diff --no-index` each).
 */
export function parsePorcelainV1Z(stdout: string): ReadonlyArray<WorkingCopyFile> {
  const fields = stdout.split("\0");
  const files: Array<WorkingCopyFile> = [];
  let index = 0;

  while (index < fields.length) {
    const record = fields[index];
    index += 1;
    if (record === undefined || record.length < 4) {
      continue;
    }
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const path = unquoteGitPath(record.slice(3));
    if (path.length === 0) {
      continue;
    }

    let oldPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const source = fields[index];
      index += 1;
      if (source !== undefined && source.length > 0) {
        oldPath = unquoteGitPath(source);
      }
    }

    if (x === "!" && y === "!") {
      continue;
    }

    if (isUnmerged(x, y)) {
      files.push({ path, area: "conflicted", change: "unmerged" });
      continue;
    }

    if (x === "?" && y === "?") {
      files.push({ path, area: "unstaged", change: "untracked" });
      continue;
    }

    if (x !== " " && x !== "?") {
      files.push({
        path,
        area: "staged",
        change: changeFromStatusLetter(x),
        ...(oldPath !== undefined ? { oldPath } : {}),
      });
    }
    if (y !== " " && y !== "?") {
      files.push({ path, area: "unstaged", change: changeFromStatusLetter(y) });
    }
  }

  return files;
}

export interface WorkingCopyNumstatEntry {
  readonly path: string;
  readonly insertions?: number | undefined;
  readonly deletions?: number | undefined;
}

/**
 * Parse `diff --numstat -z`. Renames arrive as three fields
 * (`ins\tdel\t`, old, new); binary files report `-` for both counts, which is
 * reported as absent rather than zero.
 */
export function parseNumstatZ(stdout: string): ReadonlyArray<WorkingCopyNumstatEntry> {
  const fields = stdout.split("\0");
  const entries: Array<WorkingCopyNumstatEntry> = [];
  let index = 0;

  while (index < fields.length) {
    const record = fields[index];
    index += 1;
    if (record === undefined || record.length === 0) {
      continue;
    }
    const parts = record.split("\t");
    const rawInsertions = parts[0];
    const rawDeletions = parts[1];
    if (rawInsertions === undefined || rawDeletions === undefined) {
      continue;
    }
    let path = parts.slice(2).join("\t");
    if (path.length === 0) {
      // Rename/copy: the old and new paths are the next two NUL fields.
      index += 1;
      const next = fields[index];
      index += 1;
      if (next === undefined) {
        continue;
      }
      path = next;
    }
    if (path.length === 0) {
      continue;
    }
    const insertions = rawInsertions === "-" ? undefined : Number.parseInt(rawInsertions, 10);
    const deletions = rawDeletions === "-" ? undefined : Number.parseInt(rawDeletions, 10);
    entries.push({
      path: unquoteGitPath(path),
      ...(insertions !== undefined && Number.isFinite(insertions) ? { insertions } : {}),
      ...(deletions !== undefined && Number.isFinite(deletions) ? { deletions } : {}),
    });
  }

  return entries;
}

/**
 * Merge the two numstat reads onto the porcelain rows. Untracked and
 * conflicted rows are left without counts on purpose.
 */
export function applyNumstat(
  files: ReadonlyArray<WorkingCopyFile>,
  staged: ReadonlyArray<WorkingCopyNumstatEntry>,
  unstaged: ReadonlyArray<WorkingCopyNumstatEntry>,
): ReadonlyArray<WorkingCopyFile> {
  const byArea = {
    staged: new Map(staged.map((entry) => [entry.path, entry])),
    unstaged: new Map(unstaged.map((entry) => [entry.path, entry])),
  } as const;

  return files.map((file) => {
    if (file.area === "conflicted" || file.change === "untracked") {
      return file;
    }
    const entry = byArea[file.area].get(file.path);
    if (entry === undefined) {
      return file;
    }
    return {
      ...file,
      ...(entry.insertions !== undefined ? { insertions: entry.insertions } : {}),
      ...(entry.deletions !== undefined ? { deletions: entry.deletions } : {}),
    };
  });
}

export interface WorkingCopyAheadBehind {
  readonly ahead?: number | undefined;
  readonly behind?: number | undefined;
}

/**
 * `rev-list --left-right --count HEAD...@{upstream}` → `<ahead>\t<behind>`.
 * A `[gone]` or absent upstream makes the command fail; the caller passes
 * `null` and gets **no numbers**, which must not render as "in sync".
 */
export function parseAheadBehind(stdout: string | null): WorkingCopyAheadBehind {
  if (stdout === null) {
    return {};
  }
  const parts = stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(parts[0] ?? "", 10);
  const behind = Number.parseInt(parts[1] ?? "", 10);
  return {
    ...(Number.isFinite(ahead) ? { ahead } : {}),
    ...(Number.isFinite(behind) ? { behind } : {}),
  };
}
