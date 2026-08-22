// Splits a multi-file git unified diff into per-file sections so each can render
// in its own <diff> with the file's language highlighting (OpenTUI's <diff> takes
// a single `filetype`, so one component per file is the only way to colour each
// file's code correctly). Mirrors the web DiffPanel's per-file rendering.

export interface DiffFile {
  /** Display path (the new path; the old path for pure deletions). */
  readonly path: string;
  /** OpenTUI syntax-highlight grammar for this file, or undefined (no language). */
  readonly filetype: string | undefined;
  /** The file's diff text, fed to <diff>. */
  readonly body: string;
}

// OpenTUI 0.4.1 bundles tree-sitter grammars only for these languages; anything
// else falls back to the generic diff (+/-) colouring with no code highlighting.
const FILETYPE_BY_EXT: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  md: "markdown",
  markdown: "markdown",
  zig: "zig",
};

/** Map a path to an OpenTUI highlight grammar (by extension), or undefined. */
export function filetypeForPath(path: string): string | undefined {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return FILETYPE_BY_EXT[base.slice(dot + 1).toLowerCase()];
}

/** Strip a leading `a/` or `b/` (git prefix) from a diff path. */
function stripGitPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

const GIT_ESCAPE_BYTES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

/** Decode Git's C-style quoted pathname, including UTF-8 octal byte escapes. */
function decodeGitPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const source = trimmed.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char !== "\\") {
      const codePoint = source.codePointAt(index);
      const literal = codePoint === undefined ? char : String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(literal));
      if (literal.length > 1) index += 1;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === undefined) {
      bytes.push(0x5c);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      const octal = source.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? escaped;
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    bytes.push(GIT_ESCAPE_BYTES[escaped] ?? encoder.encode(escaped)[0] ?? 0);
    index += 1;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** Parse the two possibly quoted paths from a `diff --git` header. */
function diffGitPaths(value: string): string[] {
  const paths: string[] = [];
  let index = 0;
  while (index < value.length && paths.length < 2) {
    while (/\s/.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    const start = index;
    if (value[index] === '"') {
      index += 1;
      while (index < value.length) {
        if (value[index] === "\\") {
          index += 2;
          continue;
        }
        if (value[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
    } else {
      while (index < value.length && !/\s/.test(value[index] ?? "")) index += 1;
    }
    paths.push(decodeGitPath(value.slice(start, index)));
  }
  return paths;
}

function pathForSection(lines: ReadonlyArray<string>): string {
  let newPath: string | null = null;
  let oldPath: string | null = null;
  for (const line of lines) {
    // Headers only appear before the first hunk; content lines rendered as
    // `++ …`/`-- …` additions/removals must not override the real path.
    if (line.startsWith("@@")) break;
    if (line.startsWith("+++ ")) newPath = decodeGitPath(line.slice(4));
    else if (line.startsWith("--- ")) oldPath = decodeGitPath(line.slice(4));
    else if (line.startsWith("diff --git ")) {
      // `diff --git a/x b/y` — fall back to the b-path when no +++ is present.
      const parts = diffGitPaths(line.slice("diff --git ".length));
      if (parts.length === 2 && newPath === null) newPath = parts[1] ?? null;
    }
  }
  // Prefer the new path; for deletions (+++ /dev/null) use the old path.
  const chosen =
    newPath && newPath !== "/dev/null"
      ? newPath
      : oldPath && oldPath !== "/dev/null"
        ? oldPath
        : newPath;
  return chosen ? stripGitPrefix(chosen) : "(unknown)";
}

/**
 * Split a unified diff into per-file sections. Files are delimited by `diff --git`
 * lines; a diff with none (a bare `--- / +++` patch) is returned as one section.
 * Returns an empty array for blank input.
 */
export function splitUnifiedDiff(diff: string): DiffFile[] {
  if (diff.trim().length === 0) return [];
  const lines = diff.split("\n");

  // Collect index ranges of each `diff --git` header.
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.startsWith("diff --git ")) starts.push(i);
  }

  if (starts.length === 0) {
    const path = pathForSection(lines);
    return [{ path, filetype: filetypeForPath(path), body: diff }];
  }

  const files: DiffFile[] = [];
  for (let s = 0; s < starts.length; s += 1) {
    const from = starts[s] ?? 0;
    const to = s + 1 < starts.length ? (starts[s + 1] ?? lines.length) : lines.length;
    const sectionLines = lines.slice(from, to);
    const path = pathForSection(sectionLines);
    files.push({ path, filetype: filetypeForPath(path), body: sectionLines.join("\n") });
  }
  return files;
}
