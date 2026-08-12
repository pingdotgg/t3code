export type DiffLineKind = "context" | "add" | "del" | "hunk" | "meta";

export interface ParsedDiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface ParsedDiffFile {
  readonly key: string;
  readonly oldPath: string;
  readonly newPath: string;
  readonly displayPath: string;
  readonly additions: number;
  readonly deletions: number;
  readonly lines: ReadonlyArray<ParsedDiffLine>;
}

const GIT_HEADER = /^diff --git a\/(.+) b\/(.+)$/u;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * Split a unified patch into files and numbered lines. Binary / empty files still appear as
 * a header-only entry so the file list stays honest.
 */
export function parseUnifiedDiff(patch: string): ReadonlyArray<ParsedDiffFile> {
  const files: ParsedDiffFile[] = [];
  let current: {
    oldPath: string;
    newPath: string;
    additions: number;
    deletions: number;
    lines: ParsedDiffLine[];
    oldLine: number;
    newLine: number;
  } | null = null;

  const flush = () => {
    if (current === null) return;
    const displayPath =
      current.newPath === "/dev/null"
        ? current.oldPath
        : current.oldPath === "/dev/null"
          ? current.newPath
          : current.newPath;
    files.push({
      key: `${current.oldPath}\0${current.newPath}`,
      oldPath: current.oldPath,
      newPath: current.newPath,
      displayPath,
      additions: current.additions,
      deletions: current.deletions,
      lines: current.lines,
    });
    current = null;
  };

  for (const raw of patch.split("\n")) {
    const gitHeader = GIT_HEADER.exec(raw);
    if (gitHeader) {
      flush();
      current = {
        oldPath: gitHeader[1] ?? "",
        newPath: gitHeader[2] ?? "",
        additions: 0,
        deletions: 0,
        lines: [],
        oldLine: 0,
        newLine: 0,
      };
      continue;
    }
    if (current === null) continue;
    if (raw.startsWith("+++ ") || raw.startsWith("--- ") || raw.startsWith("index ")) {
      if (raw.startsWith("--- ") && raw.slice(4) !== "/dev/null") {
        current.oldPath = raw.slice(6).replace(/^\s/u, "") || current.oldPath;
        if (current.oldPath.startsWith("a/")) current.oldPath = current.oldPath.slice(2);
      }
      if (raw.startsWith("+++ ") && raw.slice(4) !== "/dev/null") {
        current.newPath = raw.slice(6).replace(/^\s/u, "") || current.newPath;
        if (current.newPath.startsWith("b/")) current.newPath = current.newPath.slice(2);
      }
      current.lines.push({ kind: "meta", text: raw, oldLine: null, newLine: null });
      continue;
    }
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      current.oldLine = Number(hunk[1]);
      current.newLine = Number(hunk[2]);
      current.lines.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith("+")) {
      current.additions += 1;
      current.lines.push({
        kind: "add",
        text: raw.slice(1),
        oldLine: null,
        newLine: current.newLine,
      });
      current.newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      current.deletions += 1;
      current.lines.push({
        kind: "del",
        text: raw.slice(1),
        oldLine: current.oldLine,
        newLine: null,
      });
      current.oldLine += 1;
      continue;
    }
    if (raw.startsWith("\\") || raw.length === 0) {
      current.lines.push({ kind: "meta", text: raw, oldLine: null, newLine: null });
      continue;
    }
    const text = raw.startsWith(" ") ? raw.slice(1) : raw;
    current.lines.push({
      kind: "context",
      text,
      oldLine: current.oldLine,
      newLine: current.newLine,
    });
    current.oldLine += 1;
    current.newLine += 1;
  }
  flush();
  return files;
}
