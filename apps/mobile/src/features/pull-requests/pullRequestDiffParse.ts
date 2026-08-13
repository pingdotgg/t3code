import { diffLines } from "diff";
import type { PullRequestDiffFileContentsInput } from "@t3tools/contracts";

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
  /** The host listed this file but withheld its hunks. Open it to fetch the full contents. */
  readonly withheld: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;
const GIT_HEADER_PREFIX = "diff --git ";

function stripGitAbPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/** Git C-quotes paths that contain spaces or special characters. */
function unquoteGitPath(token: string): string {
  if (!token.startsWith('"')) {
    return stripGitAbPrefix(token);
  }
  let out = "";
  for (let i = 1; i < token.length; i++) {
    const ch = token[i];
    if (ch === '"') break;
    if (ch === "\\" && i + 1 < token.length) {
      i += 1;
      const next = token[i]!;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      continue;
    }
    out += ch;
  }
  return stripGitAbPrefix(out);
}

function readGitHeaderToken(rest: string, start: number): { token: string; next: number } | null {
  let i = start;
  while (rest[i] === " ") i += 1;
  if (i >= rest.length) return null;
  if (rest[i] === '"') {
    let j = i + 1;
    while (j < rest.length) {
      if (rest[j] === "\\") {
        j += 2;
        continue;
      }
      if (rest[j] === '"') {
        return { token: rest.slice(i, j + 1), next: j + 1 };
      }
      j += 1;
    }
    return { token: rest.slice(i), next: rest.length };
  }
  let j = i;
  while (j < rest.length && rest[j] !== " ") j += 1;
  return { token: rest.slice(i, j), next: j };
}

function parseGitHeader(line: string): { oldPath: string; newPath: string } | null {
  if (!line.startsWith(GIT_HEADER_PREFIX)) return null;
  const rest = line.slice(GIT_HEADER_PREFIX.length);
  const first = readGitHeaderToken(rest, 0);
  if (first === null) return null;
  const second = readGitHeaderToken(rest, first.next);
  if (second === null) return null;
  return {
    oldPath: unquoteGitPath(first.token),
    newPath: unquoteGitPath(second.token),
  };
}

function parseDiffSidePath(raw: string, prefix: "--- " | "+++ "): string | null {
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  if (rest === "/dev/null") return "/dev/null";
  return unquoteGitPath(rest);
}

function isGitMetadataLine(raw: string): boolean {
  return (
    raw.startsWith("+++ ") ||
    raw.startsWith("--- ") ||
    raw.startsWith("index ") ||
    raw.startsWith("new file mode ") ||
    raw.startsWith("deleted file mode ") ||
    raw.startsWith("old mode ") ||
    raw.startsWith("new mode ") ||
    raw.startsWith("rename from ") ||
    raw.startsWith("rename to ") ||
    raw.startsWith("copy from ") ||
    raw.startsWith("copy to ") ||
    raw.startsWith("similarity index ") ||
    raw.startsWith("dissimilarity index ") ||
    raw.startsWith("Binary files ")
  );
}

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
      withheld: false,
    });
    current = null;
  };

  for (const raw of patch.split("\n")) {
    const gitHeader = parseGitHeader(raw);
    if (gitHeader) {
      flush();
      current = {
        oldPath: gitHeader.oldPath,
        newPath: gitHeader.newPath,
        additions: 0,
        deletions: 0,
        lines: [],
        oldLine: 0,
        newLine: 0,
      };
      continue;
    }
    if (current === null) continue;
    if (isGitMetadataLine(raw)) {
      const oldPath = parseDiffSidePath(raw, "--- ");
      if (oldPath !== null) current.oldPath = oldPath;
      const newPath = parseDiffSidePath(raw, "+++ ");
      if (newPath !== null) current.newPath = newPath;
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

export function diffFileHasHunks(file: ParsedDiffFile): boolean {
  return file.lines.some(
    (line) => line.kind === "add" || line.kind === "del" || line.kind === "hunk",
  );
}

export function isBinaryDiffFile(file: ParsedDiffFile): boolean {
  return file.lines.some((line) => line.text.startsWith("Binary files"));
}

/** A header-only file in a truncated slice is one GitHub/GitLab declined to inline. */
export function markWithheldDiffFiles(
  files: ReadonlyArray<ParsedDiffFile>,
  sliceTruncated: boolean,
): ReadonlyArray<ParsedDiffFile> {
  if (!sliceTruncated) return files;
  return files.map((file) =>
    diffFileHasHunks(file) || isBinaryDiffFile(file) ? file : { ...file, withheld: true },
  );
}

export function pullRequestDiffChangeType(
  file: ParsedDiffFile,
): PullRequestDiffFileContentsInput["changeType"] {
  if (file.oldPath === "/dev/null") return "new";
  if (file.newPath === "/dev/null") return "deleted";
  if (file.oldPath !== file.newPath) {
    return file.withheld || diffFileHasHunks(file) ? "rename-changed" : "rename-pure";
  }
  return "change";
}

export function pullRequestDiffContentsPaths(file: ParsedDiffFile): {
  readonly oldPath: string;
  readonly newPath: string;
} {
  const oldPath = file.oldPath === "/dev/null" ? file.newPath : file.oldPath;
  const newPath = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
  return { oldPath, newPath };
}

function splitDiffChunk(value: string): ReadonlyArray<string> {
  const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
  return trimmed.split("\n");
}

/** Build a numbered unified view from the host's full old/new file contents. */
export function parsedDiffFromContents(
  oldContents: string,
  newContents: string,
): Pick<ParsedDiffFile, "additions" | "deletions" | "lines"> {
  const lines: ParsedDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(oldContents, newContents)) {
    if (part.value.length === 0) continue;
    for (const text of splitDiffChunk(part.value)) {
      if (part.added === true) {
        additions += 1;
        lines.push({ kind: "add", text, oldLine: null, newLine });
        newLine += 1;
        continue;
      }
      if (part.removed === true) {
        deletions += 1;
        lines.push({ kind: "del", text, oldLine, newLine: null });
        oldLine += 1;
        continue;
      }
      lines.push({ kind: "context", text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { additions, deletions, lines };
}
