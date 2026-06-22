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

function pathForSection(lines: ReadonlyArray<string>): string {
  let newPath: string | null = null;
  let oldPath: string | null = null;
  for (const line of lines) {
    if (line.startsWith("+++ ")) newPath = line.slice(4).trim();
    else if (line.startsWith("--- ")) oldPath = line.slice(4).trim();
    else if (line.startsWith("diff --git ")) {
      // `diff --git a/x b/y` — fall back to the b-path when no +++ is present.
      const parts = line.slice("diff --git ".length).trim().split(/\s+/);
      if (parts.length === 2 && newPath === null) newPath = parts[1] ?? null;
    }
  }
  // Prefer the new path; for deletions (+++ /dev/null) use the old path.
  const chosen =
    newPath && newPath !== "/dev/null" ? newPath : oldPath && oldPath !== "/dev/null" ? oldPath : newPath;
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
